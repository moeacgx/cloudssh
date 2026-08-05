import { WebSocketServer, WebSocket, type RawData } from "ws";
import crypto from "crypto";
import ssh2Pkg, {
  type Client as SSHClientType,
  type ClientChannel,
  type PseudoTtyOptions,
} from "ssh2";
const { Client, utils: ssh2Utils } = ssh2Pkg;
import { buildSSHAlgorithms } from "../../utils/ssh-algorithms.js";
import axios from "axios";
import {
  createCurrentHostResolutionRepository,
  createCurrentRbacAccessRepository,
  createCurrentRoleRepository,
  createCurrentSnippetRepository,
} from "../../database/repositories/factory.js";
import { sshLogger, authLogger } from "../../utils/logger.js";
import { logAudit } from "../../utils/audit-logger.js";
import { AuthManager } from "../../utils/auth-manager.js";
import { DataCrypto } from "../../utils/data-crypto.js";
import {
  createSocks5Connection,
  type SOCKS5Config,
} from "../../utils/socks5-helper.js";
import { SSHAuthManager } from "../auth-manager.js";
import type { ProxyNode } from "../../../types/index.js";
import { SSHHostKeyVerifier } from "../host-key-verifier.js";
import { createJumpHostChain } from "../jump-host-chain.js";
import {
  sessionManager,
  bindTerminalChannelLifecycle,
  decideTerminalChannelClose,
  inspectTerminalRecoveryRecord,
  isMessageAllowedForParticipant,
  runGuardedTerminalTask,
  type TerminalSession,
} from "./session-manager.js";
import {
  createCurrentSessionShareRepository,
  createCurrentSettingsRepository,
  createCurrentWebTerminalSessionRepository,
  getCurrentRepositorySqlite,
} from "../../database/repositories/factory.js";
import {
  detectTmux,
  installTmux,
  type TmuxInstallResult,
  attachOrCreateTmuxSession,
  killTmuxSession,
  probeTmuxSession,
  probeTmuxAttachedClients,
  waitForTmuxAttachedClient,
  waitForTmuxSession,
} from "../tmux/helper.js";
import {
  hideAgentManagedTmuxSessions,
  isAgentControlledTerminalSession,
  isAgentManagedTmuxSession,
} from "../tmux/agent-session-policy.js";
import type { WebTerminalSessionRecord } from "../../database/repositories/web-terminal-session-repository.js";
import {
  MemoryAgent,
  performPortKnocking,
  resolveAgentSocket,
} from "../terminal-auth-helpers.js";
import { isWindowsSftpPath, sftpPathToLocalPath } from "../transfer-paths.js";
import { preparePrivateKeyForSSH2 } from "../../utils/ssh-key-utils.js";
import { triggerLoginAlert } from "../../utils/alert-trigger.js";
import { isRetriableDnsError, resolveHostForSshConnect } from "../ssh-dns.js";
import { startOwnerSessionHeartbeat } from "./owner-session-heartbeat.js";
import {
  checkSharedParticipantAccess,
  startSharedParticipantAccessHeartbeat,
  type SharedParticipantAccessParticipant,
  type SharedParticipantAccessResult,
  type SharedParticipantAccessHeartbeat,
} from "./shared-participant-access.js";
import {
  shouldBlockTerminalInputForPin,
  shouldDeletePinnedRecoveryRecord,
  shouldDestroyUnconfirmedPinnedStartup,
  validateSessionPinMode,
  type SessionPinMode,
} from "./pinning-policy.js";
import { getSessionSharingPolicy } from "../session-sharing/policy.js";
import { filterSessionsByHostAccess } from "./session-access.js";
import { fixedSessionRecoveryCoordinator } from "./fixed-session-recovery-coordinator.js";
import { TerminalLifecycleUnavailableError } from "./session-lifecycle-coordinator.js";
import {
  createTerminalRecoveryTargetFingerprint,
  matchesTerminalRecoveryTarget,
} from "./recovery-target.js";
import {
  runTerminalStartupSequence,
  createTerminalStartupPayloadResolver,
  TerminalStartupValidationError,
  validateTerminalStartupPayload,
} from "./startup-sequence.js";
import { runTmuxInstallSingleflight } from "./tmux-install-coordinator.js";
import {
  resolveTerminalConnectionMaterial,
  type TerminalConnectionMaterialSource,
  type TerminalCredentialOverride,
} from "./connection-material.js";
import { getAgentSessionBroker } from "../../agent/runtime-registry.js";
import type {
  AgentPrincipal,
  AgentSessionRuntimeMode,
  OutputChunk,
} from "../../agent/types.js";

interface ConnectToHostData {
  cols: number;
  rows: number;
  hostConfig: {
    id: number;
    projectHostId?: number;
    instanceId?: string;
    ip: string;
    port: number;
    username: string;
    password?: string;
    key?: string;
    keyPassword?: string;
    keyType?: string;
    authType?: string;
    credentialId?: number;
    userId?: string;
    forceKeyboardInteractive?: boolean;
    jumpHosts?: Array<{ hostId: number }>;
    useSocks5?: boolean;
    socks5Host?: string;
    socks5Port?: number;
    socks5Username?: string;
    socks5Password?: string;
    socks5ProxyChain?: unknown;
    portKnockSequence?: Array<{
      port: number;
      protocol?: "tcp" | "udp";
      delay?: number;
    }>;
    terminalConfig?: {
      keepaliveInterval?: number;
      keepaliveCountMax?: number;
      environmentVariables?: unknown;
      startupSnippetId?: unknown;
      autoMosh?: unknown;
      moshCommand?: unknown;
      [key: string]: unknown;
    };
    enableSessionLogging?: boolean;
    /** When true, ignore key material and force password auth (fallback path). */
    passwordFallbackOnly?: boolean;
  };
  initialPath?: string;
  executeCommand?: string;
  startupInput?: string;
  startupMoshCommand?: string;
  /** Attach straight to this tmux session once the shell is ready
   * (tmux monitor opens its panes through a real PTY this way). */
  tmuxAttachSession?: string;
  /** 创建连接后立即转为受管 tmux 固定窗口。 */
  pinned?: boolean;
  /** 浏览器从 Agent 最近会话附着时使用；不会把凭据交给前端。 */
  agentSessionId?: string;
}

interface SetSessionPinnedData {
  pinned?: unknown;
  mode?: unknown;
}

function getTmuxInstallError(
  result: TmuxInstallResult,
): { code: string; message: string } | null {
  switch (result.status) {
    case "already_installed":
    case "installed":
      return null;
    case "unsupported_package_manager":
      return {
        code: "TMUX_INSTALL_UNSUPPORTED",
        message: "No supported package manager was found on the remote host",
      };
    case "insufficient_privileges":
      return {
        code: "TMUX_INSTALL_PERMISSION_DENIED",
        message: "Installing tmux requires root or passwordless sudo",
      };
    case "verification_failed":
      return {
        code: "TMUX_INSTALL_VERIFICATION_FAILED",
        message: "tmux installation finished but could not be verified",
      };
    case "install_failed":
      return {
        code: "TMUX_INSTALL_FAILED",
        message: "tmux installation failed or timed out",
      };
  }
}

interface ResizeData {
  cols: number;
  rows: number;
}

interface AttachSessionData {
  sessionId: string;
  hostId?: number;
  cols: number;
  rows: number;
  tabInstanceId?: string;
}

interface AgentBrowserSessionTarget {
  sessionId: string;
  projectId: string;
  projectHostId: number;
  hostId: number;
  hostName: string;
  serviceAccountId: string;
  runtimeMode: AgentSessionRuntimeMode;
  pinned: boolean;
  tmuxName: string | null;
  host: {
    ip: string;
    port: number;
    username: string;
  } | null;
}

type AgentBrowserAccessMode = "read-only" | "read-write";

interface AgentBrowserAttachmentContext {
  sessionId: string;
  projectId: string;
  projectHostId: number;
  hostId: number;
  runtimeMode: AgentSessionRuntimeMode;
  tmuxName: string | null;
  principal: AgentPrincipal;
  attachmentId: string;
  mode: AgentBrowserAccessMode;
  leaseId: string | null;
  localSessionId: string | null;
  attachGeneration: number;
}

function compareAgentOutputChunks(
  left: OutputChunk,
  right: OutputChunk,
): number {
  return left.generation - right.generation || left.sequence - right.sequence;
}

/**
 * 合并“订阅后到达的实时输出”和“随后读取的历史快照”。
 *
 * 附着流程先订阅再读快照，因此同一块输出可能从两条路径到达。开始实时转发前
 * 统一排序、按 generation/sequence 去重，避免附着边界丢字或重复显示。
 */
export class AgentOutputSequencer {
  private readonly pending = new Map<string, OutputChunk>();
  private lastDelivered: OutputChunk | null = null;
  private live = false;

  constructor(private readonly emit: (chunk: OutputChunk) => void) {}

  enqueue(chunk: OutputChunk): void {
    if (
      !Number.isSafeInteger(chunk.generation) ||
      chunk.generation < 1 ||
      !Number.isSafeInteger(chunk.sequence) ||
      chunk.sequence < 0 ||
      typeof chunk.data !== "string"
    ) {
      return;
    }
    if (
      this.lastDelivered &&
      compareAgentOutputChunks(chunk, this.lastDelivered) <= 0
    ) {
      return;
    }
    this.pending.set(`${chunk.generation}:${chunk.sequence}`, chunk);
    if (this.live) this.flush();
  }

  startLive(): void {
    this.live = true;
    this.flush();
  }

  private flush(): void {
    const ordered = [...this.pending.values()].sort(compareAgentOutputChunks);
    this.pending.clear();
    for (const chunk of ordered) {
      if (
        this.lastDelivered &&
        compareAgentOutputChunks(chunk, this.lastDelivered) <= 0
      ) {
        continue;
      }
      this.emit(chunk);
      this.lastDelivered = chunk;
    }
  }
}

/**
 * 将 Agent 会话 ID 解析为浏览器可附着的目标。
 *
 * 只返回主机连接所需的非敏感定位信息；密码、私钥仍由
 * handleConnectToHost -> resolveHostById 在服务端解密，绝不会进入 WebSocket。
 */
async function resolveAgentBrowserSession(
  sessionId: string,
  userId: string,
): Promise<AgentBrowserSessionTarget> {
  if (!/^[a-z0-9-]{16,120}$/i.test(sessionId)) {
    throw Object.assign(new Error("Agent 会话标识无效"), {
      code: "AGENT_SESSION_INVALID",
    });
  }

  const row = getCurrentRepositorySqlite()
    .prepare(
      `SELECT
         session.id AS sessionId,
         session.project_id AS projectId,
         session.project_host_id AS projectHostId,
         project_host.host_id AS hostId,
         COALESCE(project_host.alias, host.name, host.ip, '未命名主机') AS hostName,
         session.service_account_id AS serviceAccountId,
         session.state AS state,
         session.runtime_mode AS runtimeMode,
         session.pinned AS pinned,
         session.tmux_name AS tmuxName
       FROM persistent_sessions session
       INNER JOIN project_hosts project_host
         ON project_host.project_id = session.project_id
        AND project_host.id = session.project_host_id
       INNER JOIN ssh_data host ON host.id = project_host.host_id
       INNER JOIN service_accounts service_account
         ON service_account.project_id = session.project_id
        AND service_account.id = session.service_account_id
        AND service_account.is_active = 1
       WHERE session.id = ?
         AND session.service_account_id IS NOT NULL`,
    )
    .get(sessionId) as
    | {
        sessionId: string;
        projectId: string;
        projectHostId: number;
        hostId: number;
        hostName: string;
        serviceAccountId: string;
        state: string;
        runtimeMode: string;
        pinned: number;
        tmuxName: string | null;
      }
    | undefined;

  if (!row) {
    throw Object.assign(new Error("Agent 会话不存在或已结束"), {
      code: "AGENT_SESSION_NOT_FOUND",
    });
  }
  if (!["CREATING", "RUNNING", "RECOVERING"].includes(row.state)) {
    throw Object.assign(new Error("Agent 会话当前不可附着"), {
      code: "AGENT_SESSION_NOT_RUNNING",
    });
  }
  const runtimeMode: AgentSessionRuntimeMode =
    row.runtimeMode === "platform" ? "platform" : "tmux";
  if (
    runtimeMode === "tmux" &&
    (typeof row.tmuxName !== "string" ||
      !/^cloudssh-[a-z0-9-]{8,80}$/i.test(row.tmuxName))
  ) {
    throw Object.assign(new Error("Agent 会话的远端窗口标识无效"), {
      code: "AGENT_SESSION_INVALID",
    });
  }

  const { PermissionManager } =
    await import("../../utils/permission-manager.js");
  const access = await PermissionManager.getInstance().canAccessHost(
    userId,
    row.hostId,
    "connect",
    row.projectHostId,
  );
  if (!access.hasAccess) {
    throw Object.assign(new Error("当前账号无权访问此 Agent 会话"), {
      code: "AGENT_SESSION_ACCESS_DENIED",
    });
  }

  // 平台中转直接共享 Broker 已持有的 SSH PTY，不再解析或解密第二份凭据。
  if (runtimeMode === "platform") {
    return {
      sessionId: row.sessionId,
      projectId: row.projectId,
      projectHostId: row.projectHostId,
      hostId: row.hostId,
      hostName: row.hostName,
      serviceAccountId: row.serviceAccountId,
      runtimeMode,
      pinned: Boolean(row.pinned),
      tmuxName: null,
      host: null,
    };
  }

  // tmux 模式仍需建立独立的浏览器 SSH，并确认主机凭据/Host Key 可用。
  const { resolveHostById } = await import("../host-resolver.js");
  const resolved = await resolveHostById(row.hostId, userId, row.projectHostId);
  if (!resolved) {
    throw Object.assign(new Error("Agent 会话对应的主机配置不可用"), {
      code: "AGENT_SESSION_HOST_UNAVAILABLE",
    });
  }
  const resolvedRecord = resolved as unknown as {
    ip?: unknown;
    port?: unknown;
    username?: unknown;
  };
  const ip = resolvedRecord.ip;
  const port = resolvedRecord.port;
  const username = resolvedRecord.username;
  if (
    typeof ip !== "string" ||
    ip.trim() === "" ||
    typeof port !== "number" ||
    !Number.isSafeInteger(port) ||
    port <= 0 ||
    typeof username !== "string" ||
    username.trim() === ""
  ) {
    throw Object.assign(new Error("Agent 会话对应的主机配置不可用"), {
      code: "AGENT_SESSION_HOST_UNAVAILABLE",
    });
  }

  return {
    sessionId: row.sessionId,
    projectId: row.projectId,
    projectHostId: row.projectHostId,
    hostId: row.hostId,
    hostName: row.hostName,
    serviceAccountId: row.serviceAccountId,
    runtimeMode,
    pinned: Boolean(row.pinned),
    tmuxName: row.tmuxName,
    host: { ip, port, username },
  };
}

interface TOTPResponseData {
  code?: string;
}

interface WebSocketMessage {
  type: string;
  data?: ConnectToHostData | ResizeData | TOTPResponseData | string | unknown;
  code?: string;
  [key: string]: unknown;
}

const HOST_ACCESS_REVALIDATION_MS = 5_000;

function sendSessionPersistenceState(
  ws: WebSocket,
  session: import("./session-manager.js").TerminalSession,
): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({
      type: "session_persistence_state",
      data: {
        sessionId: session.id,
        agentSessionId: session.agentSessionId ?? null,
        sessionPinned: session.pinned,
        sessionManagedTmux: session.managedTmux,
        // Agent 的远端窗口标识只允许服务端通过 agentSessionId 解析，
        // 不回传给浏览器，避免客户端拿它尝试附着任意 tmux 窗口。
        tmuxSessionName: session.agentSessionId
          ? null
          : session.tmuxSessionName,
        lastDetachedAt: session.lastDetachedAt,
        retentionExpiresAt: session.retentionExpiresAt,
        recoverable: session.managedTmux,
      },
    }),
  );
}

async function rollbackNewPinnedTmux(
  sessionId: string,
  userId: string,
  conn: SSHClientType,
  tmuxSessionName: string,
): Promise<boolean> {
  try {
    await killTmuxSession(conn, tmuxSessionName);
    await createCurrentWebTerminalSessionRepository().deleteOwned(
      userId,
      sessionId,
    );
    sessionManager.rollbackKilledManagedPin(sessionId, userId);
    return true;
  } catch (error) {
    sshLogger.error(
      "Failed to roll back an incomplete pinned terminal",
      error,
      {
        operation: "session_pin_rollback_error",
        sessionId,
        userId,
        tmuxSessionName,
      },
    );
    return false;
  }
}

async function checkSharedParticipantCandidateAccess(
  session: TerminalSession,
  participant: SharedParticipantAccessParticipant,
): Promise<SharedParticipantAccessResult> {
  const { PermissionManager } =
    await import("../../utils/permission-manager.js");
  const permissionManager = PermissionManager.getInstance();
  return checkSharedParticipantAccess(session, participant, {
    findActiveShare: (shareId) =>
      createCurrentSessionShareRepository().findActiveById(shareId),
    canAccessHost: async (userId, hostId, projectHostId) => {
      const access = await permissionManager.canAccessHost(
        userId,
        hostId,
        "connect",
        projectHostId,
      );
      return access.hasAccess;
    },
    isSharingEnabled: async (hostId) =>
      (await getSessionSharingPolicy(hostId)).enabled,
  });
}

async function hasCurrentSharedParticipantAccess(
  sessionId: string,
  ws: WebSocket,
): Promise<boolean> {
  const session = sessionManager.getSession(sessionId);
  if (!session) return false;
  const participant = sessionManager.getParticipantForWs(session, ws);
  if (!participant || participant.isOwner || participant.accessRevoked) {
    return false;
  }

  const result = await checkSharedParticipantCandidateAccess(
    session,
    participant,
  );
  if (!result.allowed) return false;

  const currentSession = sessionManager.getSession(sessionId);
  const currentParticipant = currentSession
    ? sessionManager.getParticipantForWs(currentSession, ws)
    : null;
  if (
    currentSession !== session ||
    currentParticipant !== participant ||
    participant.accessRevoked
  ) {
    return false;
  }
  return sessionManager.updateSharedParticipantPermission(
    sessionId,
    ws,
    result.permissionLevel,
  );
}

function evictSharedParticipantAfterAccessRevocation(
  sessionId: string,
  ws: WebSocket,
): void {
  const evicted = sessionManager.evictSharedParticipant(
    sessionId,
    ws,
    "Session share access was revoked",
    "SESSION_SHARE_REVOKED",
  );
  if (!evicted && ws.readyState === WebSocket.OPEN) {
    ws.close(4003, "Session share access was revoked");
  }
}

const authManager = AuthManager.getInstance();

const userConnections = new Map<string, Set<WebSocket>>();

const wss = new WebSocketServer({
  port: 30002,
});

wss.on("error", (error) => {
  sshLogger.error("WebSocket server error", error, {
    operation: "wss_error",
  });
});

/**
 * Auth path for anonymous share-link guests (?shareToken=<linkToken>).
 * Never touches DataCrypto/user credentials - guests join an already-live
 * stream and never decrypt stored secrets.
 */
async function handleShareTokenConnection(
  ws: WebSocket,
  req: import("http").IncomingMessage,
  shareToken: string,
): Promise<void> {
  const shareRepo = createCurrentSessionShareRepository();
  const share = await shareRepo.findByLinkToken(shareToken);
  if (!share) {
    ws.close(1008, "Invalid or expired share link");
    return;
  }
  if (share.protocol !== "ssh") {
    ws.close(1008, "Unsupported share protocol");
    return;
  }

  const globallyEnabled = await createCurrentSettingsRepository().getBoolean(
    "session_sharing_globally_enabled",
    true,
  );
  if (!globallyEnabled) {
    ws.close(1008, "Session sharing is disabled");
    return;
  }

  const host = await createCurrentHostResolutionRepository().findHostById(
    share.hostId,
    share.ownerUserId,
  );
  if (!host || host.allowSessionSharing === false) {
    ws.close(1008, "Session sharing is disabled for this host");
    return;
  }

  const session = sessionManager.getSession(share.sessionId);
  if (!session || !session.isConnected) {
    ws.close(1008, "Session has ended");
    return;
  }

  const initialAccess = await checkSharedParticipantCandidateAccess(session, {
    userId: null,
    isOwner: false,
    joinedViaShareId: share.id,
  }).catch(() => ({ allowed: false }) as const);
  if (!initialAccess.allowed) {
    ws.close(1008, "Session share access is no longer available");
    return;
  }
  if (
    sessionManager.getSession(share.sessionId) !== session ||
    !session.isConnected
  ) {
    ws.close(1008, "Session has ended");
    return;
  }

  const joined = sessionManager.joinAsParticipant(share.sessionId, ws, {
    userId: null,
    permissionLevel: initialAccess.permissionLevel,
    guestLabel: "Guest",
    shareId: share.id,
  });
  if (!joined) {
    ws.close(1008, "Session is no longer active");
    return;
  }

  const currentSessionId: string = share.sessionId;
  const sharedAccessHeartbeat = startSharedParticipantAccessHeartbeat({
    verifyAccess: () => hasCurrentSharedParticipantAccess(currentSessionId, ws),
    onAccessRevoked: () =>
      evictSharedParticipantAfterAccessRevocation(currentSessionId, ws),
  });

  shareRepo.touchShareUsage(share.id).catch(() => {});
  shareRepo.recordParticipantJoin(share.id, null, "Guest").catch(() => {});

  const buffered = sessionManager.getBuffer(joined);
  if (buffered) {
    ws.send(JSON.stringify({ type: "data", data: buffered }));
  }
  ws.send(
    JSON.stringify({ type: "sessionAttached", sessionId: share.sessionId }),
  );
  ws.send(JSON.stringify({ type: "connected", message: "Joined session" }));

  let wsAlive = true;
  ws.on("pong", () => {
    wsAlive = true;
  });
  const wsPingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      if (!wsAlive) {
        ws.terminate();
        return;
      }
      wsAlive = false;
      ws.ping();
    } else {
      clearInterval(wsPingInterval);
    }
  }, 30000);

  ws.on("close", () => {
    clearInterval(wsPingInterval);
    sharedAccessHeartbeat.stop();
    sessionManager.removeParticipant(currentSessionId, ws);
    sshLogger.info("Guest left shared terminal session", {
      operation: "terminal_guest_disconnect",
      sessionId: currentSessionId,
      shareId: share.id,
    });
  });

  ws.on("message", (msg: RawData) => {
    let parsed: WebSocketMessage;
    try {
      parsed = JSON.parse(msg.toString()) as WebSocketMessage;
    } catch {
      return;
    }
    const { type, data } = parsed;

    const liveSession = sessionManager.getSession(currentSessionId);
    const participant = liveSession
      ? sessionManager.getParticipantForWs(liveSession, ws)
      : null;
    if (!participant || !isMessageAllowedForParticipant(participant, type)) {
      return;
    }

    switch (type) {
      case "input": {
        const inputData = data as string;
        if (sessionManager.isPinTransitionActive(currentSessionId)) {
          ws.send(
            JSON.stringify({
              type: "sessionInputBlocked",
              code: "SESSION_PIN_TRANSITION",
              message:
                "Input is temporarily disabled while the pinned window state changes",
            }),
          );
          break;
        }
        if (!sessionManager.canWriteToSession(currentSessionId, ws)) {
          break;
        }
        sessionManager.bufferInput(currentSessionId, inputData);
        const inputStream = liveSession?.sshStream;
        if (inputStream) {
          try {
            inputStream.write(Buffer.from(inputData, "utf8"));
          } catch {
            inputStream.write(Buffer.from(inputData, "latin1"));
          }
        }
        break;
      }
      case "ping":
        ws.send(JSON.stringify({ type: "pong" }));
        break;
      case "disconnect":
        sharedAccessHeartbeat.stop();
        sessionManager.removeParticipant(currentSessionId, ws);
        ws.close(1000, "Disconnected");
        break;
      default:
        break;
    }
  });
}

wss.on("connection", async (ws: WebSocket, req) => {
  let userId: string | undefined;
  let sessionId: string | undefined;
  let authenticationToken: string | null = null;

  ws.on("error", (error) => {
    sshLogger.error("WebSocket connection error", error, {
      operation: "ws_error",
      sessionId,
    });
  });

  const urlObj = new URL(req.url || "", "http://localhost");
  const shareToken = urlObj.searchParams.get("shareToken");

  if (shareToken) {
    await handleShareTokenConnection(ws, req, shareToken);
    return;
  }

  try {
    let token: string | undefined;

    const cookieHeader = req.headers.cookie;
    if (cookieHeader) {
      const match = cookieHeader.match(/(?:^|;\s*)jwt=([^;]+)/);
      if (match) token = decodeURIComponent(match[1]);
    }

    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith("Bearer ")) {
        token = authHeader.slice("Bearer ".length);
      }
    }

    if (!token) {
      const qp = urlObj.searchParams.get("token");
      if (qp) token = qp;
    }

    if (!token) {
      ws.close(1008, "Authentication required");
      return;
    }

    const payload = await authManager.verifyJWTToken(token);
    if (!payload?.userId || payload.pendingTOTP) {
      ws.close(1008, "Authentication required");
      return;
    }

    userId = payload.userId;
    sessionId = payload.sessionId;
    authenticationToken = token;
  } catch (error) {
    sshLogger.error(
      "WebSocket JWT verification failed during connection",
      error,
      {
        operation: "websocket_connection_auth_error",
        ip: req.socket.remoteAddress,
      },
    );
    ws.close(1008, "Authentication required");
    return;
  }

  const dataKey = DataCrypto.getUserDataKey(userId);
  if (!dataKey) {
    ws.send(
      JSON.stringify({
        type: "error",
        message: "Data locked - re-authenticate with password",
        code: "DATA_LOCKED",
      }),
    );
    ws.close(1008, "Data access required");
    return;
  }

  if (!userConnections.has(userId)) {
    userConnections.set(userId, new Set());
  }
  const userWs = userConnections.get(userId)!;
  userWs.add(ws);
  sshLogger.info("Terminal WebSocket connection established", {
    operation: "terminal_ws_connect",
    sessionId,
    userId,
  });

  let currentSessionId: string | null = null;
  let sshConn: SSHClientType | null = null;
  let sshStream: ClientChannel | null = null;
  let lastJumpClient: SSHClientType | null = null;
  let keyboardInteractiveFinish: ((responses: string[]) => void) | null = null;
  let totpPromptSent = false;
  let totpTimeout: NodeJS.Timeout | null = null;
  let isKeyboardInteractive = false;
  let keyboardInteractiveResponded = false;
  let isConnecting = false;
  let isConnected = false;
  let isCleaningUp = false;
  let isShellInitializing = false;
  let isDuplicateConnDiscarded = false;
  let isShellClosureInProgress = false;
  let fixedRecoveryLockId: string | null = null;
  let hostAccessValidationSessionId: string | null = null;
  let hostAccessValidationCheckedAt = 0;
  let hostAccessValidationAllowed = true;
  let hostAccessValidationPromise: {
    sessionId: string;
    promise: Promise<boolean>;
  } | null = null;
  let hostAccessRevocationNotified = false;
  let warpgateAuthPromptSent = false;
  let warpgateAuthTimeout: NodeJS.Timeout | null = null;
  let isAwaitingAuthCredentials = false;
  let sharedAccessHeartbeat: SharedParticipantAccessHeartbeat | null = null;
  let deferredPinnedStartup: {
    sessionId: string;
    runPostShellCommands: (isPinRequestActive: () => boolean) => Promise<void>;
  } | null = null;
  let startupPinSessionId: string | null = null;
  let sessionPinRequestGeneration = 0;
  let activeSessionPinRequestGeneration: number | null = null;
  let pendingSessionPinChoiceSessionId: string | null = null;
  // 仅由服务端 attachAgentSession 流程写入。用于 SSH 私钥口令重试时
  // 保留 Agent 目标，避免重连意外降级成普通 Shell。
  let agentAttachContext: AgentBrowserAttachmentContext | null = null;
  let agentAttachGeneration = 0;
  let pendingAgentAttachGeneration: number | null = null;
  let agentAttachmentHeartbeat: NodeJS.Timeout | null = null;
  let agentAttachmentHeartbeatPending = false;
  let agentOutputUnsubscribe: (() => void) | null = null;
  const browserAgentPrincipalId = `web-user:${userId}:${crypto.randomUUID()}`;

  function createBrowserAgentPrincipal(
    target: AgentBrowserSessionTarget,
  ): AgentPrincipal {
    const serverId = String(target.projectHostId);
    return {
      principalId: browserAgentPrincipalId,
      serviceAccountId: target.serviceAccountId,
      serviceAccountIds: [target.serviceAccountId],
      projectId: target.projectId,
      projectIds: [target.projectId],
      projectServiceAccountIds: {
        [target.projectId]: target.serviceAccountId,
      },
      name: `网页用户 ${userId}`,
      scopes: ["sessions:read", "sessions:write"],
      serverIds: [serverId],
      serverProjectIds: { [serverId]: target.projectId },
      serverServiceAccountIds: {
        [serverId]: target.serviceAccountId,
      },
      maxConcurrentSessions: 1,
    };
  }

  function sendAgentAccessState(context: AgentBrowserAttachmentContext): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: "agent_session_access",
        data: {
          mode: context.mode,
          canTakeover: true,
        },
      }),
    );
  }

  function isAgentAttachmentBoundToCurrentTerminal(
    context: AgentBrowserAttachmentContext,
  ): boolean {
    if (!currentSessionId || context.localSessionId !== currentSessionId) {
      return false;
    }
    const session = sessionManager.getSession(currentSessionId);
    return Boolean(
      session &&
      session.agentSessionId === context.sessionId &&
      session.hostId === context.hostId &&
      session.projectHostId === context.projectHostId,
    );
  }

  async function assertCurrentAgentBrowserAccess(
    context: AgentBrowserAttachmentContext,
  ): Promise<void> {
    const target = await resolveAgentBrowserSession(context.sessionId, userId);
    if (
      target.projectId !== context.projectId ||
      target.projectHostId !== context.projectHostId ||
      target.hostId !== context.hostId ||
      target.serviceAccountId !== context.principal.serviceAccountId ||
      target.runtimeMode !== context.runtimeMode ||
      target.tmuxName !== context.tmuxName
    ) {
      throw Object.assign(new Error("Agent 会话授权或目标已经变化"), {
        code: "AGENT_SESSION_ACCESS_CHANGED",
      });
    }
  }

  function bindAgentAttachmentToLocalTerminal(
    agentSessionId: string,
    localSessionId: string,
    hostId: number,
    projectHostId: number | undefined,
  ): void {
    const context = agentAttachContext;
    const session = sessionManager.getSession(localSessionId);
    if (
      !context ||
      context.sessionId !== agentSessionId ||
      context.hostId !== hostId ||
      context.projectHostId !== projectHostId ||
      context.attachGeneration !== pendingAgentAttachGeneration ||
      !session ||
      session.agentSessionId !== agentSessionId
    ) {
      throw Object.assign(new Error("Agent 会话与本地终端绑定失败"), {
        code: "AGENT_SESSION_BINDING_MISMATCH",
      });
    }
    agentAttachContext = { ...context, localSessionId };
    pendingAgentAttachGeneration = null;
  }

  async function detachBrowserAgentAttachment(
    context: AgentBrowserAttachmentContext,
  ): Promise<void> {
    const broker = getAgentSessionBroker();
    if (!broker) return;
    try {
      await broker.detach(
        context.principal,
        context.sessionId,
        context.attachmentId,
      );
    } catch (error) {
      sshLogger.debug("Browser Agent attachment was already released", {
        operation: "terminal_agent_attachment_release_skipped",
        userId,
        agentSessionId: context.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function stopAgentOutputSubscription(): void {
    const unsubscribe = agentOutputUnsubscribe;
    agentOutputUnsubscribe = null;
    if (unsubscribe) unsubscribe();
  }

  function forwardAgentPlatformOutput(
    context: AgentBrowserAttachmentContext,
    localSessionId: string,
    chunk: OutputChunk,
  ): void {
    if (
      ws.readyState !== WebSocket.OPEN ||
      agentAttachContext?.attachGeneration !== context.attachGeneration ||
      agentAttachContext.sessionId !== context.sessionId ||
      agentAttachContext.runtimeMode !== "platform" ||
      currentSessionId !== localSessionId
    ) {
      return;
    }
    sessionManager.bufferOutput(localSessionId, chunk.data);
    ws.send(JSON.stringify({ type: "data", data: chunk.data }));
  }

  function endAgentPlatformTerminal(
    context: AgentBrowserAttachmentContext,
    localSessionId: string,
    state: "CLOSED" | "FAILED",
  ): void {
    if (
      agentAttachContext?.attachGeneration !== context.attachGeneration ||
      agentAttachContext.sessionId !== context.sessionId ||
      currentSessionId !== localSessionId
    ) {
      return;
    }

    const closingContext = agentAttachContext;
    agentAttachContext = null;
    pendingAgentAttachGeneration = null;
    stopAgentAttachmentHeartbeat();
    stopAgentOutputSubscription();
    sessionManager.destroySession(localSessionId);
    currentSessionId = null;
    isConnecting = false;
    isConnected = false;
    void detachBrowserAgentAttachment(closingContext);

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "sessionExpired",
          sessionId: localSessionId,
          code:
            state === "FAILED" ? "AGENT_SESSION_FAILED" : "AGENT_SESSION_ENDED",
          message:
            state === "FAILED"
              ? "Agent session connection failed"
              : "Agent session has ended",
        }),
      );
      ws.close(1000, "Agent session ended");
    }
  }

  async function startAgentPlatformOutput(
    context: AgentBrowserAttachmentContext,
    localSessionId: string,
  ): Promise<void> {
    const broker = getAgentSessionBroker();
    if (!broker) {
      throw Object.assign(new Error("Agent Broker 暂不可用"), {
        code: "AGENT_BROKER_UNAVAILABLE",
      });
    }

    const sequencer = new AgentOutputSequencer((chunk) =>
      forwardAgentPlatformOutput(context, localSessionId, chunk),
    );
    const unsubscribe = await broker.subscribe(
      context.principal,
      context.sessionId,
      (chunk) => sequencer.enqueue(chunk),
      ({ state }) => endAgentPlatformTerminal(context, localSessionId, state),
    );
    if (
      agentAttachContext?.attachGeneration !== context.attachGeneration ||
      currentSessionId !== localSessionId
    ) {
      unsubscribe();
      throw Object.assign(new Error("Agent 会话附着已取消"), {
        code: "AGENT_SESSION_ATTACH_CANCELLED",
      });
    }
    stopAgentOutputSubscription();
    agentOutputUnsubscribe = unsubscribe;

    try {
      let cursor: string | undefined;
      let gapNotified = false;
      // Broker 最多保留 2 MiB，单页最多读取 256 KiB；16 页为历史缓冲
      // 留出余量，同时避免持续高输出让首次附着永远无法完成。
      for (let page = 0; page < 16; page += 1) {
        const output = await broker.read(
          context.principal,
          context.sessionId,
          cursor,
          256 * 1024,
          context.attachmentId,
        );
        if (
          agentAttachContext?.attachGeneration !== context.attachGeneration ||
          currentSessionId !== localSessionId
        ) {
          throw Object.assign(new Error("Agent 会话附着已取消"), {
            code: "AGENT_SESSION_ATTACH_CANCELLED",
          });
        }
        if (output.gap && !gapNotified && ws.readyState === WebSocket.OPEN) {
          gapNotified = true;
          ws.send(
            JSON.stringify({
              type: "data",
              data: "\r\n[CloudSSH: earlier output is no longer available]\r\n",
            }),
          );
        }
        for (const chunk of output.chunks) sequencer.enqueue(chunk);
        if (output.chunks.length === 0 || output.nextCursor === cursor) break;
        cursor = output.nextCursor;
      }
      sequencer.startLive();
    } catch (error) {
      if (agentOutputUnsubscribe === unsubscribe) {
        stopAgentOutputSubscription();
      } else {
        unsubscribe();
      }
      throw error;
    }
  }

  function createAgentPlatformTerminal(
    target: AgentBrowserSessionTarget,
    context: AgentBrowserAttachmentContext,
    cols: number,
    rows: number,
    tabInstanceId?: string,
  ): TerminalSession {
    const localSessionId = sessionManager.createSession(
      userId,
      target.hostId,
      target.hostName,
      cols,
      rows,
      // Agent 平台终端是临时观察壳，不能按浏览器标签复用另一条活动 SSH。
      undefined,
      false,
      {
        projectHostId: target.projectHostId,
        agentSessionId: target.sessionId,
      },
    );
    const localSession = sessionManager.getSession(localSessionId);
    if (!localSession) {
      throw Object.assign(new Error("Agent 平台终端创建失败"), {
        code: "AGENT_SESSION_BINDING_MISSING",
      });
    }
    localSession.isConnected = true;
    localSession.pinned = target.pinned;
    localSession.managedTmux = false;
    localSession.tmuxSessionName = null;
    const attached = sessionManager.attachWs(
      localSessionId,
      userId,
      ws,
      tabInstanceId,
    );
    if (!attached) {
      sessionManager.destroySession(localSessionId);
      throw Object.assign(new Error("Agent 平台终端附着失败"), {
        code: "AGENT_SESSION_BINDING_MISSING",
      });
    }
    try {
      resetHostAccessValidation(localSessionId);
      bindAgentAttachmentToLocalTerminal(
        target.sessionId,
        localSessionId,
        target.hostId,
        target.projectHostId,
      );
      currentSessionId = localSessionId;
      return attached;
    } catch (error) {
      // 创建、WebSocket 附着和 Agent 绑定必须表现为同一个事务，任何一步
      // 失败都不能遗留隐藏终端占用用户会话额度。
      sessionManager.destroySession(localSessionId);
      if (currentSessionId === localSessionId) currentSessionId = null;
      throw error;
    }
  }

  function releaseCurrentBrowserAgentAttachment(): void {
    const context = agentAttachContext;
    agentAttachContext = null;
    pendingAgentAttachGeneration = null;
    stopAgentAttachmentHeartbeat();
    stopAgentOutputSubscription();
    if (context) void detachBrowserAgentAttachment(context);
  }

  async function replaceBrowserAgentAttachmentWithReadOnly(
    previous: AgentBrowserAttachmentContext,
  ): Promise<AgentBrowserAttachmentContext> {
    const broker = getAgentSessionBroker();
    if (!broker) {
      throw Object.assign(new Error("Agent Broker 暂不可用"), {
        code: "AGENT_BROKER_UNAVAILABLE",
      });
    }
    const attached = await broker.attach(
      previous.principal,
      previous.sessionId,
      "read-only",
      false,
      crypto.randomUUID(),
    );
    const next: AgentBrowserAttachmentContext = {
      ...previous,
      attachmentId: attached.attachmentId,
      mode: "read-only",
      leaseId: null,
    };
    await detachBrowserAgentAttachment(previous);
    return next;
  }

  function stopAgentAttachmentHeartbeat(): void {
    if (agentAttachmentHeartbeat) {
      clearInterval(agentAttachmentHeartbeat);
      agentAttachmentHeartbeat = null;
    }
  }

  function startAgentAttachmentHeartbeat(): void {
    stopAgentAttachmentHeartbeat();
    agentAttachmentHeartbeat = setInterval(() => {
      if (agentAttachmentHeartbeatPending || !agentAttachContext) return;
      const observed = agentAttachContext;
      const broker = getAgentSessionBroker();
      if (!broker) return;
      agentAttachmentHeartbeatPending = true;
      void assertCurrentAgentBrowserAccess(observed)
        .then(() =>
          broker.keepaliveAttachment(
            observed.principal,
            observed.sessionId,
            observed.attachmentId,
            observed.leaseId,
          ),
        )
        .then((access) => {
          if (agentAttachContext !== observed) return;
          const mode = access.mode as AgentBrowserAccessMode;
          agentAttachContext = {
            ...observed,
            mode,
            leaseId: access.lease?.id ?? null,
          };
          if (mode !== observed.mode) {
            sendAgentAccessState(agentAttachContext);
          }
        })
        .catch(async (error) => {
          if (agentAttachContext !== observed) return;
          const code =
            typeof error === "object" && error !== null && "code" in error
              ? String((error as { code?: unknown }).code)
              : "AGENT_SESSION_ACCESS_REVALIDATION_FAILED";
          if (
            code !== "WRITE_LEASE_INVALID" &&
            code !== "ATTACHMENT_NOT_FOUND"
          ) {
            agentAttachContext = null;
            pendingAgentAttachGeneration = null;
            stopAgentAttachmentHeartbeat();
            stopAgentOutputSubscription();
            await detachBrowserAgentAttachment(observed);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "agent_session_access_error",
                  code,
                  message: "Agent 会话访问权限已失效，请重新进入会话",
                }),
              );
              ws.close(4003, "Agent session access revoked");
            }
            return;
          }
          try {
            const readOnlyContext =
              await replaceBrowserAgentAttachmentWithReadOnly(observed);
            if (agentAttachContext !== observed) {
              await detachBrowserAgentAttachment(readOnlyContext);
              return;
            }
            agentAttachContext = readOnlyContext;
            sendAgentAccessState(agentAttachContext);
          } catch (error) {
            sshLogger.warn("Failed to restore browser Agent read-only access", {
              operation: "terminal_agent_attachment_heartbeat_failed",
              userId,
              agentSessionId: observed.sessionId,
              code,
              error: error instanceof Error ? error.message : String(error),
            });
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "agent_session_access_error",
                  code: "AGENT_ATTACHMENT_EXPIRED",
                  message: "Agent 会话观察附件已失效，请重新进入会话",
                }),
              );
            }
          }
        })
        .finally(() => {
          agentAttachmentHeartbeatPending = false;
        });
    }, 15_000);
    agentAttachmentHeartbeat.unref();
  }

  function invalidateSessionPinRequest(sessionId?: string): void {
    sessionPinRequestGeneration += 1;
    if (
      sessionId === undefined ||
      deferredPinnedStartup?.sessionId === sessionId
    ) {
      deferredPinnedStartup = null;
    }
    if (sessionId === undefined || startupPinSessionId === sessionId) {
      startupPinSessionId = null;
    }
    if (
      sessionId === undefined ||
      pendingSessionPinChoiceSessionId === sessionId
    ) {
      pendingSessionPinChoiceSessionId = null;
    }
  }

  function assertSessionPinRequestActive(
    generation: number,
    session: TerminalSession,
  ): void {
    if (
      generation === sessionPinRequestGeneration &&
      currentSessionId === session.id &&
      sessionManager.getSession(session.id) === session
    ) {
      return;
    }

    const error = new Error("Pinned window request was cancelled") as Error & {
      code: string;
    };
    error.code = "SESSION_PIN_CANCELLED";
    throw error;
  }

  function sendTmuxInstallChoice(
    session: TerminalSession,
    startup: boolean,
  ): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    pendingSessionPinChoiceSessionId = session.id;
    ws.send(
      JSON.stringify({
        type: "session_pin_requires_tmux",
        data: {
          sessionId: session.id,
          startup,
          canInstall: true,
        },
      }),
    );
  }

  function sendSessionPinModeChoice(
    session: TerminalSession,
    startup: boolean,
  ): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    pendingSessionPinChoiceSessionId = session.id;
    ws.send(
      JSON.stringify({
        type: "session_pin_mode_required",
        data: {
          sessionId: session.id,
          startup,
        },
      }),
    );
  }

  function sendTerminalConnected(): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: "connected",
        message: "SSH connected",
      }),
    );
  }

  async function prepareTmuxForPin(
    session: TerminalSession,
    mode: SessionPinMode,
    startup: boolean,
  ): Promise<"ready" | "prompted"> {
    if (mode === "platform") return "ready";

    const detection = await detectTmux(session.sshConn!);
    if (detection.available) return "ready";

    if (mode !== "install_tmux") {
      sendTmuxInstallChoice(session, startup);
      return "prompted";
    }

    const result = await runTmuxInstallSingleflight(session.hostId, () =>
      installTmux(session.sshConn!),
    );
    const installError = getTmuxInstallError(result);
    void logAudit({
      userId,
      username: userId,
      action: "web_terminal_tmux_install",
      resourceType: "terminal_session",
      resourceId: session.id,
      resourceName: session.hostName,
      details: JSON.stringify({
        hostId: session.hostId,
        projectHostId: session.projectHostId ?? null,
        status: result.status,
        packageManager: result.packageManager,
        privilege: result.privilege,
      }),
      ipAddress: req.socket.remoteAddress ?? "",
      userAgent: req.headers["user-agent"] ?? "",
      success: installError === null,
    });
    if (installError) {
      const error = new Error(installError.message) as Error & {
        code: string;
      };
      error.code = installError.code;
      throw error;
    }

    const verified = await detectTmux(session.sshConn!);
    if (!verified.available) {
      const error = new Error(
        "tmux installation finished but could not be verified",
      ) as Error & { code: string };
      error.code = "TMUX_INSTALL_VERIFICATION_FAILED";
      throw error;
    }
    return "ready";
  }

  async function runDeferredPinnedStartup(
    sessionId: string,
    generation: number,
  ): Promise<void> {
    if (deferredPinnedStartup?.sessionId !== sessionId) return;
    const continuation = deferredPinnedStartup;
    deferredPinnedStartup = null;
    const session = sessionManager.getSession(sessionId);
    const isPinRequestActive = () =>
      session !== null &&
      generation === sessionPinRequestGeneration &&
      currentSessionId === sessionId &&
      sessionManager.getSession(sessionId) === session;
    if (!isPinRequestActive()) {
      const error = new Error(
        "Pinned window request was cancelled",
      ) as Error & {
        code: string;
      };
      error.code = "SESSION_PIN_CANCELLED";
      throw error;
    }
    await continuation.runPostShellCommands(isPinRequestActive);
    if (!isPinRequestActive()) {
      const error = new Error(
        "Pinned window request was cancelled",
      ) as Error & {
        code: string;
      };
      error.code = "SESSION_PIN_CANCELLED";
      throw error;
    }
  }

  function beginSharedParticipantAccessChecks(sessionId: string): void {
    sharedAccessHeartbeat?.stop();
    sharedAccessHeartbeat = startSharedParticipantAccessHeartbeat({
      verifyAccess: () => hasCurrentSharedParticipantAccess(sessionId, ws),
      onAccessRevoked: () =>
        evictSharedParticipantAfterAccessRevocation(sessionId, ws),
    });
  }

  const ownerHeartbeat = startOwnerSessionHeartbeat({
    ws,
    getCurrentOwnerSession: () => {
      const session = currentSessionId
        ? sessionManager.getSession(currentSessionId)
        : null;
      if (!session) return null;
      const participant = sessionManager.getParticipantForWs(session, ws);
      return participant?.isOwner ? session : null;
    },
    hasCurrentHostAccess,
    hasCurrentAuthenticationAccess: async () => {
      if (!authenticationToken) return false;
      const payload = await authManager.verifyJWTToken(authenticationToken);
      return payload?.userId === userId && payload.pendingTOTP !== true;
    },
    onAccessRevoked: rejectRevokedHostAccess,
    onAuthenticationExpired: () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(
        JSON.stringify({
          type: "sessionAuthenticationExpired",
          code: "SESSION_EXPIRED",
          message:
            "Login session expired; the background terminal is still running",
        }),
      );
      ws.close(1008, "Login session expired");
    },
    onPongTimeout: () => {
      sshLogger.warn("WebSocket pong timeout - terminating zombie connection", {
        operation: "ws_pong_timeout",
        userId,
        sessionId: currentSessionId,
      });
      ws.terminate();
    },
  });

  ws.on("close", () => {
    ownerHeartbeat.stop();
    sharedAccessHeartbeat?.stop();
    sharedAccessHeartbeat = null;
    stopAgentAttachmentHeartbeat();
    stopAgentOutputSubscription();
    const closingAgentAttachment = agentAttachContext;
    agentAttachContext = null;
    pendingAgentAttachGeneration = null;
    if (closingAgentAttachment) {
      void detachBrowserAgentAttachment(closingAgentAttachment);
    }
    const abandonedStartupSessionId = shouldDestroyUnconfirmedPinnedStartup(
      startupPinSessionId !== null,
      activeSessionPinRequestGeneration !== null,
    )
      ? startupPinSessionId
      : null;
    // 已经由用户确认的固定流程继续完成，才能真正抵抗刷新和临时断网；
    // 仅清理尚未选择固定方式的启动载荷。
    pendingSessionPinChoiceSessionId = null;
    if (activeSessionPinRequestGeneration === null) {
      deferredPinnedStartup = null;
      startupPinSessionId = null;
    }
    if (abandonedStartupSessionId) {
      sessionManager.destroySession(abandonedStartupSessionId);
      if (currentSessionId === abandonedStartupSessionId)
        currentSessionId = null;
    }
    sshLogger.info("Terminal WebSocket disconnected", {
      operation: "terminal_ws_disconnect",
      sessionId,
      userId,
    });
    const userWs = userConnections.get(userId);
    if (userWs) {
      userWs.delete(ws);
      if (userWs.size === 0) {
        userConnections.delete(userId);
      }
    }

    if (currentSessionId) {
      const session = sessionManager.getSession(currentSessionId);
      if (session?.isConnected) {
        const participant = sessionManager.getParticipantForWs(session, ws);
        if (participant && !participant.isOwner) {
          sessionManager.removeParticipant(currentSessionId, ws);
        } else {
          // Only detach if this WS is still the owner's attached socket, or
          // no owner is currently attached. If a refresh reconnected and
          // reattached a new WS before this close event fired, we must not
          // clobber that new attachment.
          const ownerStillAttached = Array.from(
            session.participants.values(),
          ).some((p) => p.isOwner && p.ws !== ws);
          if (!ownerStillAttached) {
            if (session.agentSessionId) {
              // Agent 的权威会话运行在远端 tmux 或 Agent Broker 中。浏览器这里只是
              // 临时观察壳；断网或刷新后立即回收，避免遗留隐藏会话耗尽用户上限。
              // tmux 模式只关闭浏览器 SSH，平台模式只移除 Broker 输出订阅；两者
              // 都不会终止 Agent 权威会话，重新进入时按 agentSessionId 再次附着。
              sessionManager.destroySession(currentSessionId);
              currentSessionId = null;
            } else {
              sessionManager.detachWs(currentSessionId);
            }
          }
        }
      } else {
        sessionManager.destroySession(currentSessionId);
        currentSessionId = null;
      }
    }
    // WebSocket 可能在 DNS、握手、交互认证或 shell 创建之前关闭；此时连接尚未
    // 归属 SessionManager，必须显式结束，不能只清空局部引用留下幽灵 SSH。
    if (!currentSessionId) {
      try {
        sshStream?.end();
      } catch {
        // 通道可能尚未创建或已经关闭。
      }
      try {
        sshConn?.end();
      } catch {
        // SSH Client 可能仍在握手或已经关闭。
      }
      try {
        lastJumpClient?.end();
      } catch {
        // 跳板连接可能尚未创建或已经关闭。
      }
    }
    cleanupAuthState();
  });

  function resetConnectionState() {
    isConnecting = false;
    isConnected = false;
    isKeyboardInteractive = false;
    keyboardInteractiveResponded = false;
    keyboardInteractiveFinish = null;
    totpPromptSent = false;
    warpgateAuthPromptSent = false;
  }

  function completeOwnedSessionAttachment(
    session: TerminalSession,
    attachData: AttachSessionData,
  ): void {
    sshLogger.success("Session attached successfully", {
      operation: "terminal_attach_success",
      sessionId: attachData.sessionId,
      sessionCreatedAt: session.createdAt,
      wasDetached: !!session.lastDetachedAt,
      detachedDuration: session.lastDetachedAt
        ? Date.now() - session.lastDetachedAt
        : 0,
    });
    currentSessionId = attachData.sessionId;
    resetHostAccessValidation(attachData.sessionId);
    sshStream = session.sshStream;
    sshConn = session.sshConn;
    isConnecting = false;
    isConnected = true;
    const buffered = sessionManager.getBuffer(session);
    if (buffered) {
      ws.send(JSON.stringify({ type: "data", data: buffered }));
    }
    if (attachData.cols !== session.cols || attachData.rows !== session.rows) {
      session.sshStream?.setWindow(
        attachData.rows,
        attachData.cols,
        attachData.rows,
        attachData.cols,
      );
      session.cols = attachData.cols;
      session.rows = attachData.rows;
    }

    ws.send(
      JSON.stringify({
        type: "sessionAttached",
        sessionId: attachData.sessionId,
      }),
    );
    sendSessionPersistenceState(ws, session);
    ws.send(
      JSON.stringify({
        type: "connected",
        message: "Session reattached",
      }),
    );
  }

  async function hasCurrentHostAccess(
    session: TerminalSession,
  ): Promise<boolean> {
    if (session.userId !== userId) return false;
    if (!Number.isSafeInteger(session.hostId) || session.hostId <= 0) {
      return true;
    }
    try {
      const { PermissionManager } =
        await import("../../utils/permission-manager.js");
      const access = await PermissionManager.getInstance().canAccessHost(
        userId,
        session.hostId,
        "connect",
        session.projectHostId,
      );
      return access.hasAccess;
    } catch (error) {
      sshLogger.error("Failed to revalidate terminal host access", error, {
        operation: "terminal_access_revalidation_error",
        sessionId: session.id,
        userId,
        hostId: session.hostId,
        projectHostId: session.projectHostId,
      });
      return false;
    }
  }

  function resetHostAccessValidation(sessionId: string | null): void {
    hostAccessValidationSessionId = sessionId;
    hostAccessValidationCheckedAt = 0;
    hostAccessValidationAllowed = true;
    hostAccessValidationPromise = null;
    hostAccessRevocationNotified = false;
  }

  async function revalidateCurrentHostAccess(
    session: TerminalSession,
  ): Promise<boolean> {
    const now = Date.now();
    if (
      hostAccessValidationSessionId === session.id &&
      now - hostAccessValidationCheckedAt < HOST_ACCESS_REVALIDATION_MS
    ) {
      return hostAccessValidationAllowed;
    }

    if (hostAccessValidationPromise?.sessionId === session.id) {
      return hostAccessValidationPromise.promise;
    }

    const promise = hasCurrentHostAccess(session)
      .then((allowed) => {
        if (currentSessionId === session.id) {
          hostAccessValidationSessionId = session.id;
          hostAccessValidationCheckedAt = Date.now();
          hostAccessValidationAllowed = allowed;
        }
        return allowed;
      })
      .finally(() => {
        if (hostAccessValidationPromise?.promise === promise) {
          hostAccessValidationPromise = null;
        }
      });
    hostAccessValidationPromise = { sessionId: session.id, promise };
    return promise;
  }

  function rejectRevokedHostAccess(session: TerminalSession): void {
    if (hostAccessRevocationNotified) return;
    hostAccessRevocationNotified = true;
    sshLogger.warn("Closing terminal after host access was revoked", {
      operation: "terminal_active_access_revoked",
      sessionId: session.id,
      userId,
      hostId: session.hostId,
      projectHostId: session.projectHostId,
    });
    sessionManager.evictSharedParticipants(
      session.id,
      "Host access was revoked",
      "HOST_ACCESS_REVOKED",
    );
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "sessionAccessRevoked",
          sessionId: session.id,
          code: "HOST_ACCESS_REVOKED",
          message: "Host access is no longer available",
        }),
      );
      ws.close(4003, "Host access revoked");
    }
  }

  ws.on("message", async (msg: RawData) => {
    const currentDataKey = DataCrypto.getUserDataKey(userId);
    if (!currentDataKey) {
      ws.send(
        JSON.stringify({
          type: "error",
          message: "Data access expired - please re-authenticate",
          code: "DATA_EXPIRED",
        }),
      );
      ws.close(1008, "Data access expired");
      return;
    }

    let parsed: WebSocketMessage;
    try {
      parsed = JSON.parse(msg.toString()) as WebSocketMessage;
    } catch (e) {
      sshLogger.error("Invalid JSON received", e, {
        operation: "websocket_message_invalid_json",
        userId,
        messageLength: msg.toString().length,
      });
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    const { type, data } = parsed;

    // 共享参与者只能发送 input/ping/disconnect；input 在对应分支还需通过
    // 会话级写入租约检查，其余认证、tmux 与 resize 操作仅 owner 可用。
    if (type !== "joinSharedSession") {
      const gateSession = currentSessionId
        ? sessionManager.getSession(currentSessionId)
        : null;
      const gateParticipant = gateSession
        ? sessionManager.getParticipantForWs(gateSession, ws)
        : null;
      if (gateSession && !gateParticipant) {
        return;
      }
      if (!isMessageAllowedForParticipant(gateParticipant, type)) {
        return;
      }
      if (
        gateSession &&
        gateParticipant?.isOwner &&
        type !== "disconnect" &&
        !(await revalidateCurrentHostAccess(gateSession))
      ) {
        rejectRevokedHostAccess(gateSession);
        return;
      }
    }

    switch (type) {
      case "connectToHost": {
        invalidateSessionPinRequest();
        const connectData = data as ConnectToHostData;
        // agentSessionId 只能由下方经过服务端校验的专用消息注入，不能
        // 由浏览器伪造 connectToHost + tmux 名称来附着任意远端窗口。
        const directTmuxName = connectData.tmuxAttachSession;
        const directHostId = Number(connectData.hostConfig?.id);
        if (
          directTmuxName !== undefined &&
          (typeof directTmuxName !== "string" ||
            directTmuxName.length === 0 ||
            directTmuxName.length > 160)
        ) {
          ws.send(
            JSON.stringify({
              type: "error",
              code: "INVALID_TMUX_SESSION",
              message: "tmux 会话标识无效",
            }),
          );
          break;
        }
        if (
          connectData.agentSessionId ||
          (directTmuxName &&
            isAgentManagedTmuxSession(directTmuxName, directHostId))
        ) {
          ws.send(
            JSON.stringify({
              type: "error",
              code: "AGENT_SESSION_ATTACH_REQUIRED",
              message: "请从 Agent 持续会话入口进入",
            }),
          );
          break;
        }
        if (agentAttachContext) {
          await detachBrowserAgentAttachment(agentAttachContext);
          agentAttachContext = null;
          stopAgentAttachmentHeartbeat();
        }
        if (connectData.hostConfig) {
          connectData.hostConfig.userId = userId;
        }
        handleConnectToHost(connectData).catch((error) => {
          const errMsg =
            error instanceof Error ? error.message : "Unknown error";
          if (
            errMsg.includes("Cannot parse privateKey") &&
            errMsg.includes("no passphrase")
          ) {
            isAwaitingAuthCredentials = true;
            ws.send(
              JSON.stringify({
                type: "passphrase_required",
                message:
                  "The SSH key is encrypted. Please enter the passphrase to unlock it.",
              }),
            );
            return;
          }
          sshLogger.error("Failed to connect to host", error, {
            operation: "ssh_connect",
            userId,
            hostId: connectData.hostConfig?.id,
            ip: connectData.hostConfig?.ip,
          });
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Failed to connect to host: " + errMsg,
            }),
          );
        });
        break;
      }

      case "attachSession": {
        invalidateSessionPinRequest(currentSessionId ?? undefined);
        const attachData = data as AttachSessionData;
        sshLogger.info("Attempting to attach session", {
          operation: "terminal_attach_session",
          sessionId: attachData.sessionId,
          tabInstanceId: attachData.tabInstanceId,
          userId,
          requestedCols: attachData.cols,
          requestedRows: attachData.rows,
        });
        const liveSession = sessionManager.getSession(attachData.sessionId);
        const accessRevoked = liveSession
          ? !(await hasCurrentHostAccess(liveSession))
          : false;

        if (accessRevoked) {
          sshLogger.warn("Rejected session attachment after access changed", {
            operation: "terminal_attach_access_revoked",
            sessionId: attachData.sessionId,
            userId,
            hostId: liveSession?.hostId,
            projectHostId: liveSession?.projectHostId,
          });
          ws.send(
            JSON.stringify({
              type: "sessionExpired",
              sessionId: attachData.sessionId,
              code: "HOST_ACCESS_REVOKED",
              message: "Host access is no longer available",
            }),
          );
          break;
        }

        // Agent 浏览器附件必须经过专用 attachAgentSession 流程建立
        // Broker 附件和写入租约。若允许普通 attachSession 复用本地 SSH，
        // 后续 input 分支会没有 agentAttachContext，从而绕过单写租约。
        if (isAgentControlledTerminalSession(liveSession)) {
          ws.send(
            JSON.stringify({
              type: "error",
              code: "AGENT_SESSION_ATTACH_REQUIRED",
              message: "请从 Agent 持续会话入口进入",
            }),
          );
          break;
        }

        const session = sessionManager.attachWs(
          attachData.sessionId,
          userId,
          ws,
          attachData.tabInstanceId,
        );
        if (session) {
          completeOwnedSessionAttachment(session, attachData);
        } else {
          const recoveryRecord =
            Number.isSafeInteger(attachData.hostId) &&
            attachData.hostId! > 0 &&
            attachData.tabInstanceId
              ? await createCurrentWebTerminalSessionRepository().findForRecovery(
                  {
                    id: attachData.sessionId,
                    userId,
                    hostId: attachData.hostId!,
                    tabInstanceId: attachData.tabInstanceId,
                  },
                )
              : null;
          if (recoveryRecord) {
            if (
              !fixedSessionRecoveryCoordinator.begin(recoveryRecord.id, userId)
            ) {
              const recoveryWaitResult =
                await fixedSessionRecoveryCoordinator.wait(
                  recoveryRecord.id,
                  userId,
                );
              if (ws.readyState !== WebSocket.OPEN) break;

              const recoveredLiveSession = sessionManager.getSession(
                recoveryRecord.id,
              );
              if (
                recoveredLiveSession &&
                (await hasCurrentHostAccess(recoveredLiveSession))
              ) {
                const attached = sessionManager.attachWs(
                  recoveryRecord.id,
                  userId,
                  ws,
                  attachData.tabInstanceId,
                );
                if (attached) {
                  completeOwnedSessionAttachment(attached, attachData);
                  break;
                }
              }
              if (recoveryWaitResult === "timed-out") {
                sshLogger.warn("Timed out waiting for fixed window recovery", {
                  operation: "terminal_fixed_recovery_wait_timeout",
                  sessionId: recoveryRecord.id,
                  userId,
                });
                ws.send(
                  JSON.stringify({
                    type: "sessionRecoveryDeferred",
                    sessionId: recoveryRecord.id,
                    code: "RECOVERY_WAIT_TIMEOUT",
                    message:
                      "Another connection is still restoring this fixed window. Try again shortly.",
                  }),
                );
                ws.close(1013, "Fixed window recovery is still in progress");
                break;
              }
            } else {
              fixedRecoveryLockId = recoveryRecord.id;
              try {
                const { resolveHostById } = await import("../host-resolver.js");
                const resolved = await resolveHostById(
                  recoveryRecord.hostId,
                  userId,
                  recoveryRecord.projectHostId ?? undefined,
                );
                if (resolved) {
                  const restored = resolved as unknown as {
                    ip: string;
                    port: number;
                    username: string;
                  };
                  if (
                    !matchesTerminalRecoveryTarget(
                      recoveryRecord.targetFingerprint,
                      restored,
                    )
                  ) {
                    ws.send(
                      JSON.stringify({
                        type: "sessionRecoveryDeferred",
                        sessionId: recoveryRecord.id,
                        code: recoveryRecord.targetFingerprint
                          ? "RECOVERY_TARGET_CHANGED"
                          : "RECOVERY_TARGET_UNVERIFIED",
                        message: recoveryRecord.targetFingerprint
                          ? "The host address, port, or SSH username changed. The fixed-window recovery record was kept."
                          : "The fixed window predates recovery-target verification. Its recovery record was kept.",
                      }),
                    );
                    fixedSessionRecoveryCoordinator.finish(
                      recoveryRecord.id,
                      userId,
                    );
                    fixedRecoveryLockId = null;
                    ws.close(1008, "Fixed window recovery target changed");
                    break;
                  }
                  await handleConnectToHost(
                    {
                      cols: attachData.cols,
                      rows: attachData.rows,
                      hostConfig: {
                        id: recoveryRecord.hostId,
                        projectHostId:
                          recoveryRecord.projectHostId ?? undefined,
                        instanceId: recoveryRecord.tabInstanceId,
                        ip: restored.ip,
                        port: restored.port,
                        username: restored.username,
                      },
                    },
                    recoveryRecord,
                  );
                  if (isConnecting || isConnected) break;
                }
              } catch (error) {
                sshLogger.error(
                  "Failed to restore fixed terminal session",
                  error,
                  {
                    operation: "terminal_fixed_recovery_error",
                    sessionId: recoveryRecord.id,
                    userId,
                  },
                );
              }
              fixedSessionRecoveryCoordinator.finish(recoveryRecord.id, userId);
              fixedRecoveryLockId = null;
            }

            const retainedRecoveryStatus = await inspectTerminalRecoveryRecord(
              () =>
                createCurrentWebTerminalSessionRepository().findForRecovery({
                  id: recoveryRecord.id,
                  userId,
                  hostId: recoveryRecord.hostId,
                  tabInstanceId: recoveryRecord.tabInstanceId,
                }),
              (error) => {
                sshLogger.error(
                  "Failed to verify fixed-window recovery state",
                  error,
                  {
                    operation: "terminal_fixed_recovery_status_error",
                    sessionId: recoveryRecord.id,
                    userId,
                  },
                );
              },
            );
            if (retainedRecoveryStatus !== "missing") {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: "sessionRecoveryDeferred",
                    sessionId: recoveryRecord.id,
                    code:
                      retainedRecoveryStatus === "retained"
                        ? "RECOVERY_RECORD_RETAINED"
                        : "RECOVERY_STATUS_UNAVAILABLE",
                    message:
                      retainedRecoveryStatus === "retained"
                        ? "The fixed window is still recoverable. Try attaching again shortly."
                        : "The fixed-window recovery state could not be verified. Its local state was kept.",
                  }),
                );
                ws.close(1013, "Fixed window recovery was deferred");
              }
              break;
            }
          }
          sshLogger.warn(
            "Session attachment failed - will create new connection",
            {
              operation: "terminal_attach_failed",
              sessionId: attachData.sessionId,
              tabInstanceId: attachData.tabInstanceId,
              userId,
              reason: "session_not_found_or_invalid",
            },
          );
          ws.send(
            JSON.stringify({
              type: "sessionExpired",
              sessionId: attachData.sessionId,
            }),
          );
        }
        break;
      }

      case "attachAgentSession": {
        invalidateSessionPinRequest(currentSessionId ?? undefined);
        const attachData = data as {
          agentSessionId?: unknown;
          cols?: unknown;
          rows?: unknown;
          tabInstanceId?: unknown;
        };
        const requestedId =
          typeof attachData.agentSessionId === "string"
            ? attachData.agentSessionId
            : "";
        if (
          pendingAgentAttachGeneration !== null ||
          isConnecting ||
          isConnected ||
          currentSessionId !== null
        ) {
          ws.send(
            JSON.stringify({
              type: "error",
              code: "DUPLICATE_AGENT_ATTACHMENT",
              message: "当前终端正在连接或已经连接，请使用新的终端标签进入会话",
            }),
          );
          break;
        }
        const attachGeneration = ++agentAttachGeneration;
        pendingAgentAttachGeneration = attachGeneration;
        let createdContext: AgentBrowserAttachmentContext | null = null;
        try {
          // 附着请求来自浏览器，不能让异常尺寸进入 ssh2 的伪终端参数。
          // 与 Agent API 保持相同的上限，同时对缺省/非法值使用安全默认值。
          const cols =
            typeof attachData.cols === "number" &&
            Number.isSafeInteger(attachData.cols) &&
            attachData.cols >= 20 &&
            attachData.cols <= 500
              ? attachData.cols
              : 120;
          const rows =
            typeof attachData.rows === "number" &&
            Number.isSafeInteger(attachData.rows) &&
            attachData.rows >= 5 &&
            attachData.rows <= 300
              ? attachData.rows
              : 30;
          const tabInstanceId =
            typeof attachData.tabInstanceId === "string" &&
            attachData.tabInstanceId.length <= 128
              ? attachData.tabInstanceId
              : undefined;
          const target = await resolveAgentBrowserSession(requestedId, userId);
          const broker = getAgentSessionBroker();
          if (!broker) {
            throw Object.assign(new Error("Agent Broker 暂不可用"), {
              code: "AGENT_BROKER_UNAVAILABLE",
            });
          }
          if (agentAttachContext) {
            stopAgentOutputSubscription();
            await detachBrowserAgentAttachment(agentAttachContext);
            agentAttachContext = null;
          }
          const principal = createBrowserAgentPrincipal(target);
          const attachment = await broker.attach(
            principal,
            target.sessionId,
            "read-only",
            false,
            crypto.randomUUID(),
          );
          const nextAgentAttachContext: AgentBrowserAttachmentContext = {
            sessionId: target.sessionId,
            projectId: target.projectId,
            projectHostId: target.projectHostId,
            hostId: target.hostId,
            runtimeMode: target.runtimeMode,
            tmuxName: target.tmuxName,
            principal,
            attachmentId: attachment.attachmentId,
            mode: "read-only",
            leaseId: null,
            localSessionId: null,
            attachGeneration,
          };
          createdContext = nextAgentAttachContext;
          if (ws.readyState !== WebSocket.OPEN) {
            await detachBrowserAgentAttachment(nextAgentAttachContext);
            pendingAgentAttachGeneration = null;
            break;
          }
          agentAttachContext = nextAgentAttachContext;
          sendAgentAccessState(agentAttachContext);
          if (target.runtimeMode === "platform") {
            const localSession = createAgentPlatformTerminal(
              target,
              nextAgentAttachContext,
              cols,
              rows,
              tabInstanceId,
            );
            isConnecting = false;
            isConnected = true;
            await startAgentPlatformOutput(
              nextAgentAttachContext,
              localSession.id,
            );
            startAgentAttachmentHeartbeat();
            ws.send(
              JSON.stringify({
                type: "sessionAttached",
                sessionId: localSession.id,
              }),
            );
            sendSessionPersistenceState(ws, localSession);
            ws.send(
              JSON.stringify({
                type: "connected",
                message: "Agent platform session attached",
              }),
            );
            ws.send(
              JSON.stringify({
                type: "agent_session_attached",
                agentSessionId: target.sessionId,
                runtimeMode: "platform",
              }),
            );
          } else {
            if (!target.host || !target.tmuxName) {
              throw Object.assign(new Error("Agent tmux 会话目标不可用"), {
                code: "AGENT_SESSION_HOST_UNAVAILABLE",
              });
            }
            await handleConnectToHost({
              cols,
              rows,
              agentSessionId: target.sessionId,
              tmuxAttachSession: target.tmuxName,
              hostConfig: {
                id: target.hostId,
                projectHostId: target.projectHostId,
                instanceId: tabInstanceId,
                ip: target.host.ip,
                port: target.host.port,
                username: target.host.username,
                userId,
              },
            });
            if (
              agentAttachContext !== nextAgentAttachContext ||
              (!isConnecting && !isConnected)
            ) {
              throw Object.assign(new Error("Agent SSH 连接未能启动"), {
                code: "AGENT_SESSION_CONNECT_NOT_STARTED",
              });
            }
            startAgentAttachmentHeartbeat();
          }
        } catch (error) {
          const failedContext =
            agentAttachContext?.attachGeneration === attachGeneration
              ? agentAttachContext
              : createdContext;
          if (failedContext) {
            agentAttachContext = null;
            stopAgentAttachmentHeartbeat();
            stopAgentOutputSubscription();
            if (failedContext.localSessionId) {
              sessionManager.destroySession(failedContext.localSessionId);
              if (currentSessionId === failedContext.localSessionId) {
                currentSessionId = null;
              }
              isConnecting = false;
              isConnected = false;
            }
            await detachBrowserAgentAttachment(failedContext);
          }
          if (pendingAgentAttachGeneration === attachGeneration) {
            pendingAgentAttachGeneration = null;
          }
          const code =
            typeof error === "object" && error !== null && "code" in error
              ? String((error as { code?: unknown }).code)
              : "AGENT_SESSION_ATTACH_FAILED";
          const message =
            error instanceof Error ? error.message : "Agent 会话附着失败";
          sshLogger.warn("Failed to attach browser to Agent session", {
            operation: "terminal_agent_session_attach_failed",
            userId,
            agentSessionId: requestedId,
            code,
            error: message,
          });
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "error", code, message }));
          }
        }
        break;
      }

      case "requestAgentWriteAccess": {
        const current = agentAttachContext;
        const broker = getAgentSessionBroker();
        if (
          !current ||
          !broker ||
          !isAgentAttachmentBoundToCurrentTerminal(current)
        ) {
          ws.send(
            JSON.stringify({
              type: "agent_session_access_error",
              code: "AGENT_SESSION_NOT_ATTACHED",
              message: "请先进入 Agent 会话",
            }),
          );
          break;
        }
        try {
          const attached = await broker.attach(
            current.principal,
            current.sessionId,
            "read-write",
            true,
            crypto.randomUUID(),
          );
          if (!attached.lease) {
            throw Object.assign(new Error("未能取得 Agent 会话写入权"), {
              code: "WRITE_LEASE_UNAVAILABLE",
            });
          }
          const nextAgentAttachContext: AgentBrowserAttachmentContext = {
            ...current,
            attachmentId: attached.attachmentId,
            mode: "read-write",
            leaseId: attached.lease.id,
          };
          if (
            ws.readyState !== WebSocket.OPEN ||
            agentAttachContext !== current
          ) {
            await detachBrowserAgentAttachment(nextAgentAttachContext);
            break;
          }
          agentAttachContext = nextAgentAttachContext;
          await detachBrowserAgentAttachment(current);
          sendAgentAccessState(agentAttachContext);
          void logAudit({
            userId,
            username: userId,
            action: "agent_session_write_takeover",
            resourceType: "terminal_session",
            resourceId: current.sessionId,
            details: JSON.stringify({ mode: "read-write" }),
            ipAddress: req.socket.remoteAddress ?? "",
            userAgent: req.headers["user-agent"] ?? "",
            success: true,
          });
        } catch (error) {
          const code =
            typeof error === "object" && error !== null && "code" in error
              ? String((error as { code?: unknown }).code)
              : "AGENT_WRITE_TAKEOVER_FAILED";
          const message =
            error instanceof Error ? error.message : "接管 Agent 输入失败";
          ws.send(
            JSON.stringify({
              type: "agent_session_access_error",
              code,
              message,
            }),
          );
        }
        break;
      }

      case "releaseAgentWriteAccess": {
        const current = agentAttachContext;
        if (
          !current ||
          !isAgentAttachmentBoundToCurrentTerminal(current) ||
          current.mode !== "read-write"
        ) {
          if (current) sendAgentAccessState(current);
          break;
        }
        try {
          const readOnlyContext =
            await replaceBrowserAgentAttachmentWithReadOnly(current);
          if (
            ws.readyState !== WebSocket.OPEN ||
            agentAttachContext !== current
          ) {
            await detachBrowserAgentAttachment(readOnlyContext);
            break;
          }
          agentAttachContext = readOnlyContext;
          sendAgentAccessState(agentAttachContext);
          void logAudit({
            userId,
            username: userId,
            action: "agent_session_write_release",
            resourceType: "terminal_session",
            resourceId: current.sessionId,
            details: JSON.stringify({ mode: "read-only" }),
            ipAddress: req.socket.remoteAddress ?? "",
            userAgent: req.headers["user-agent"] ?? "",
            success: true,
          });
        } catch (error) {
          ws.send(
            JSON.stringify({
              type: "agent_session_access_error",
              code: "AGENT_WRITE_RELEASE_FAILED",
              message:
                error instanceof Error
                  ? error.message
                  : "释放 Agent 输入权失败",
            }),
          );
        }
        break;
      }

      case "listSessions": {
        const sessions = (
          await filterSessionsByHostAccess(
            sessionManager.getUserSessions(userId),
            hasCurrentHostAccess,
          )
        ).filter(
          // Agent 会话只允许通过 attachAgentSession 解析和建立 Broker
          // 附件；不放进普通 tmux/会话选择器，减少误用和绕过面。
          (session) => !isAgentControlledTerminalSession(session),
        );
        ws.send(
          JSON.stringify({
            type: "sessionList",
            sessions: sessions.map((s) => ({
              id: s.id,
              hostId: s.hostId,
              hostName: s.hostName,
              createdAt: s.createdAt,
              lastDetachedAt: s.lastDetachedAt,
              tmuxSessionName: s.agentSessionId ? null : s.tmuxSessionName,
            })),
          }),
        );
        break;
      }

      case "resize": {
        const resizeData = data as ResizeData;
        if (
          !Number.isSafeInteger(resizeData?.cols) ||
          resizeData.cols < 20 ||
          resizeData.cols > 500 ||
          !Number.isSafeInteger(resizeData?.rows) ||
          resizeData.rows < 5 ||
          resizeData.rows > 300
        ) {
          break;
        }
        if (agentAttachContext) {
          const access = agentAttachContext;
          if (!isAgentAttachmentBoundToCurrentTerminal(access)) {
            break;
          }
          const broker = getAgentSessionBroker();
          if (!broker || access.mode !== "read-write" || !access.leaseId) {
            break;
          }
          try {
            await broker.resize(
              access.principal,
              access.sessionId,
              access.attachmentId,
              access.leaseId,
              resizeData.cols,
              resizeData.rows,
            );
            if (access.runtimeMode === "platform") {
              const localSession = currentSessionId
                ? sessionManager.getSession(currentSessionId)
                : null;
              if (localSession) {
                localSession.cols = resizeData.cols;
                localSession.rows = resizeData.rows;
                sessionManager.bufferResize(
                  localSession.id,
                  resizeData.cols,
                  resizeData.rows,
                );
              }
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: "resized",
                    cols: resizeData.cols,
                    rows: resizeData.rows,
                  }),
                );
              }
              break;
            }
          } catch (error) {
            const code =
              typeof error === "object" && error !== null && "code" in error
                ? String((error as { code?: unknown }).code)
                : "AGENT_RESIZE_FAILED";
            if (
              agentAttachContext === access &&
              (code === "WRITE_LEASE_INVALID" ||
                code === "ATTACHMENT_NOT_FOUND")
            ) {
              try {
                const readOnlyContext =
                  await replaceBrowserAgentAttachmentWithReadOnly(access);
                if (agentAttachContext !== access) {
                  await detachBrowserAgentAttachment(readOnlyContext);
                  break;
                }
                agentAttachContext = readOnlyContext;
                sendAgentAccessState(agentAttachContext);
              } catch {
                // 保持当前连接，仅停止写入。
              }
            }
            break;
          }
        } else if (
          currentSessionId &&
          isAgentControlledTerminalSession(
            sessionManager.getSession(currentSessionId),
          )
        ) {
          // 防御异常/旧连接状态：Agent 会话的尺寸也只能由持有写租约
          // 的 Broker 附件调整，不能从普通网页会话直接操作。
          break;
        }
        handleResize(resizeData);
        break;
      }

      case "disconnect": {
        invalidateSessionPinRequest(currentSessionId ?? undefined);
        const disconnectSession = currentSessionId
          ? sessionManager.getSession(currentSessionId)
          : null;
        const disconnectParticipant = disconnectSession
          ? sessionManager.getParticipantForWs(disconnectSession, ws)
          : null;
        if (disconnectParticipant && !disconnectParticipant.isOwner) {
          sharedAccessHeartbeat?.stop();
          sharedAccessHeartbeat = null;
          if (currentSessionId) {
            sessionManager.removeParticipant(currentSessionId, ws);
            currentSessionId = null;
          }
          sshStream = null;
          sshConn = null;
          isConnected = false;
          break;
        }
        if (currentSessionId) {
          const closingId = currentSessionId;
          const wasPinned = disconnectSession?.pinned === true;
          try {
            await sessionManager.terminateSession(closingId, userId);
            if (wasPinned) {
              void logAudit({
                userId,
                username: userId,
                action: "web_terminal_close",
                resourceType: "terminal_session",
                resourceId: closingId,
                resourceName: disconnectSession.hostName,
                details: JSON.stringify({
                  hostId: disconnectSession.hostId,
                  projectHostId: disconnectSession.projectHostId ?? null,
                }),
                ipAddress: req.socket.remoteAddress ?? "",
                userAgent: req.headers["user-agent"] ?? "",
                success: true,
              });
            }
            ws.send(
              JSON.stringify({
                type: "sessionClosed",
                sessionId: closingId,
              }),
            );
          } catch (error) {
            ws.send(
              JSON.stringify({
                type: "session_close_error",
                message:
                  error instanceof Error
                    ? error.message
                    : "Failed to close terminal",
              }),
            );
            break;
          }
          currentSessionId = null;
        }
        cleanupAuthState();
        sshConn = null;
        sshStream = null;
        break;
      }

      case "setSessionPinned": {
        const session = currentSessionId
          ? sessionManager.getSession(currentSessionId)
          : null;
        const pinData = data as SetSessionPinnedData | undefined;
        const requested = pinData?.pinned;
        const modeValidation = validateSessionPinMode(pinData?.mode);
        let newManagedTmuxName: string | null = null;
        let newPinPersisted = false;
        let newPlatformPinApplied = false;
        let pinTransitionStarted = false;
        if (!session || requested !== true) {
          ws.send(
            JSON.stringify({
              type: "session_pin_error",
              code: "PINNED_WINDOW_CLOSE_ONLY",
              message:
                "A pinned window can only be stopped by explicitly closing it",
            }),
          );
          break;
        }
        if (
          activeSessionPinRequestGeneration !== null ||
          sessionManager.isPinTransitionActive(session.id)
        ) {
          ws.send(
            JSON.stringify({
              type: "sessionInputBlocked",
              code: "SESSION_PIN_TRANSITION",
              message: "Pinned window operation is already in progress",
            }),
          );
          break;
        }
        if (modeValidation.ok === false) {
          ws.send(JSON.stringify(modeValidation.error));
          break;
        }
        const mode = modeValidation.mode;
        if (session.agentSessionId) {
          ws.send(
            JSON.stringify({
              type: "session_pin_error",
              code: "AGENT_SESSION_CONTROLLED",
              message:
                "Agent 持续会话由 Agent 管理，浏览器只能共享终端，不能重新固定窗口",
            }),
          );
          break;
        }
        const isStartupPinRequest = startupPinSessionId === session.id;
        const pinRequestGeneration = ++sessionPinRequestGeneration;
        activeSessionPinRequestGeneration = pinRequestGeneration;
        if (pendingSessionPinChoiceSessionId === session.id) {
          pendingSessionPinChoiceSessionId = null;
        }

        try {
          if (session.pinned) {
            ws.send(
              JSON.stringify({
                type: "sessionPinned",
                sessionId: session.id,
                pinned: true,
                tmuxSessionName: session.tmuxSessionName,
                sessionManagedTmux: session.managedTmux,
              }),
            );
            sendSessionPersistenceState(ws, session);
            break;
          }
          if (!session.sshConn || !session.sshStream) {
            throw new Error("SSH connection is not available");
          }
          if (
            mode !== "platform" &&
            !session.tmuxSessionName &&
            session.hasShellInput
          ) {
            ws.send(
              JSON.stringify({
                type: "session_pin_error",
                code: "SESSION_PIN_REQUIRES_FRESH_SHELL",
                message:
                  "Pin the window before entering commands; a running foreground process cannot be moved into tmux",
              }),
            );
            break;
          }

          sessionManager.beginPinTransition(session.id, userId);
          pinTransitionStarted = true;

          if (mode === "platform") {
            const updated = await sessionManager.pinPlatformSession(
              session.id,
              userId,
            );
            newPlatformPinApplied = true;
            assertSessionPinRequestActive(pinRequestGeneration, session);
            await runDeferredPinnedStartup(session.id, pinRequestGeneration);
            assertSessionPinRequestActive(pinRequestGeneration, session);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "sessionPinned",
                  sessionId: session.id,
                  pinned: true,
                  sessionManagedTmux: false,
                  tmuxSessionName: updated.tmuxSessionName,
                }),
              );
            }
            sendSessionPersistenceState(ws, updated);
            if (isStartupPinRequest) {
              sendTerminalConnected();
              startupPinSessionId = null;
            }
            void logAudit({
              userId,
              username: userId,
              action: "web_terminal_pin",
              resourceType: "terminal_session",
              resourceId: session.id,
              resourceName: session.hostName,
              details: JSON.stringify({
                hostId: session.hostId,
                projectHostId: session.projectHostId ?? null,
                mode: "platform",
              }),
              ipAddress: req.socket.remoteAddress ?? "",
              userAgent: req.headers["user-agent"] ?? "",
              success: true,
            });
            sessionManager.finishPinTransition(session.id);
            pinTransitionStarted = false;
            break;
          }

          const tmuxPreparation = await prepareTmuxForPin(
            session,
            mode,
            deferredPinnedStartup?.sessionId === session.id,
          );
          assertSessionPinRequestActive(pinRequestGeneration, session);
          if (tmuxPreparation === "prompted") {
            if (ws.readyState !== WebSocket.OPEN) {
              const interrupted = new Error(
                "Pinned window confirmation was interrupted",
              ) as Error & { code: string };
              interrupted.code = "SESSION_PIN_CANCELLED";
              throw interrupted;
            }
            sessionManager.finishPinTransition(session.id);
            pinTransitionStarted = false;
            break;
          }

          let tmuxName = session.tmuxSessionName;
          if (!tmuxName) {
            newManagedTmuxName = `cloudssh-web-${session.id}`;
            await sessionManager.pinSession(
              session.id,
              userId,
              newManagedTmuxName,
            );
            newPinPersisted = true;
            assertSessionPinRequestActive(pinRequestGeneration, session);
            attachOrCreateTmuxSession(
              session.sshStream,
              undefined,
              newManagedTmuxName,
            );
            const confirmed = await waitForTmuxSession(
              session.sshConn,
              newManagedTmuxName,
            );
            if (!confirmed) {
              throw new Error("Managed tmux session could not be created");
            }
            assertSessionPinRequestActive(pinRequestGeneration, session);
            const attached = await waitForTmuxAttachedClient(
              session.sshConn,
              newManagedTmuxName,
              0,
            );
            if (!attached) {
              throw new Error(
                "The SSH shell did not attach to the managed tmux session",
              );
            }
            assertSessionPinRequestActive(pinRequestGeneration, session);
            tmuxName = confirmed;
          }

          let updated = session;
          if (!newPinPersisted) {
            updated = await sessionManager.pinSession(
              session.id,
              userId,
              tmuxName,
            );
            newPinPersisted = true;
          }
          assertSessionPinRequestActive(pinRequestGeneration, session);
          await runDeferredPinnedStartup(session.id, pinRequestGeneration);
          assertSessionPinRequestActive(pinRequestGeneration, session);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "sessionPinned",
                sessionId: session.id,
                pinned: true,
                sessionManagedTmux: true,
                tmuxSessionName: tmuxName,
              }),
            );
          }
          sendSessionPersistenceState(ws, updated);
          if (isStartupPinRequest) {
            sendTerminalConnected();
            startupPinSessionId = null;
          }
          void logAudit({
            userId,
            username: userId,
            action: "web_terminal_pin",
            resourceType: "terminal_session",
            resourceId: session.id,
            resourceName: session.hostName,
            details: JSON.stringify({
              hostId: session.hostId,
              projectHostId: session.projectHostId ?? null,
              mode: "tmux",
            }),
            ipAddress: req.socket.remoteAddress ?? "",
            userAgent: req.headers["user-agent"] ?? "",
            success: true,
          });
          sessionManager.finishPinTransition(session.id);
          pinTransitionStarted = false;
        } catch (error) {
          let rollbackDeferred = false;
          if (newPlatformPinApplied) {
            sessionManager.rollbackPlatformPin(session.id, userId);
          }
          if (newPinPersisted && newManagedTmuxName) {
            const rolledBack = session.sshConn
              ? await rollbackNewPinnedTmux(
                  session.id,
                  userId,
                  session.sshConn,
                  newManagedTmuxName,
                )
              : false;
            if (!rolledBack) {
              rollbackDeferred = true;
              sshLogger.warn("Incomplete pinned terminal remains recoverable", {
                operation: "session_pin_rollback_deferred",
                sessionId: session.id,
                userId,
                tmuxSessionName: newManagedTmuxName,
              });
              const recoverableSession = sessionManager.getSession(session.id);
              if (
                recoverableSession?.pinned &&
                ws.readyState === WebSocket.OPEN
              ) {
                ws.send(
                  JSON.stringify({
                    type: "sessionPinned",
                    sessionId: session.id,
                    pinned: true,
                    tmuxSessionName: newManagedTmuxName,
                    recoveryPending: true,
                  }),
                );
                sendSessionPersistenceState(ws, recoverableSession);
              }
            }
          } else if (newPinPersisted) {
            try {
              await sessionManager.rollbackManagedPin(session.id, userId);
            } catch (rollbackError) {
              rollbackDeferred = true;
              sshLogger.warn(
                "Failed to roll back an adopted CloudSSH tmux session",
                {
                  operation: "session_pin_adopt_rollback_deferred",
                  sessionId: session.id,
                  userId,
                  error:
                    rollbackError instanceof Error
                      ? rollbackError.message
                      : String(rollbackError),
                },
              );
            }
          }
          if (pinTransitionStarted) {
            sessionManager.finishPinTransition(session.id);
          }
          if (sessionPinRequestGeneration === pinRequestGeneration) {
            deferredPinnedStartup = null;
            pendingSessionPinChoiceSessionId = null;
            if (startupPinSessionId === session.id) {
              startupPinSessionId = null;
            }
          }
          const errorCode =
            error instanceof Error &&
            "code" in error &&
            typeof error.code === "string"
              ? error.code
              : undefined;
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "session_pin_error",
                code: rollbackDeferred
                  ? "SESSION_PIN_RECOVERY_PENDING"
                  : errorCode,
                message:
                  error instanceof Error
                    ? error.message
                    : "Failed to pin terminal session",
              }),
            );
          }
          if (isStartupPinRequest) {
            sessionManager.destroySession(session.id);
            if (currentSessionId === session.id) currentSessionId = null;
            cleanupAuthState();
            sshConn = null;
            sshStream = null;
            if (ws.readyState === WebSocket.OPEN) {
              ws.close(1013, "Pinned window setup was not confirmed");
            }
          }
        } finally {
          if (activeSessionPinRequestGeneration === pinRequestGeneration) {
            activeSessionPinRequestGeneration = null;
          }
        }
        break;
      }

      case "cancelSessionPin": {
        const cancelledStartupSessionId = startupPinSessionId;
        const pinOperationActive = activeSessionPinRequestGeneration !== null;
        invalidateSessionPinRequest(currentSessionId ?? undefined);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "session_pin_cancelled" }));
        }
        if (
          cancelledStartupSessionId &&
          shouldDestroyUnconfirmedPinnedStartup(true, pinOperationActive)
        ) {
          sessionManager.destroySession(cancelledStartupSessionId);
          if (currentSessionId === cancelledStartupSessionId) {
            currentSessionId = null;
          }
          cleanupAuthState();
          sshConn = null;
          sshStream = null;
          if (ws.readyState === WebSocket.OPEN) {
            ws.close(1000, "Pinned startup cancelled");
          }
        }
        break;
      }

      case "get_cwd": {
        const activeConn =
          sessionManager.getSession(currentSessionId)?.sshConn ?? sshConn;
        if (!activeConn) {
          ws.send(JSON.stringify({ type: "cwd", path: "/" }));
          break;
        }
        activeConn.exec("pwd", (err, execStream) => {
          if (err) {
            ws.send(JSON.stringify({ type: "cwd", path: "/" }));
            return;
          }
          let stdout = "";
          execStream.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf-8");
          });
          execStream.stderr.on("data", () => {});
          execStream.on("close", () => {
            const cwd = stdout.trim() || "/";
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "cwd", path: cwd }));
            }
          });
        });
        break;
      }

      case "open_file_in_editor": {
        const { path: requestedPath } = data as { path: string };
        const activeConn =
          sessionManager.getSession(currentSessionId)?.sshConn ?? sshConn;
        if (!activeConn || !requestedPath) {
          ws.send(
            JSON.stringify({
              type: "open_file_in_editor",
              path: requestedPath || "/",
            }),
          );
          break;
        }
        const escapedPath = requestedPath.replace(/'/g, "'\\''");
        activeConn.exec(
          `realpath '${escapedPath}' 2>/dev/null || echo '${escapedPath}'`,
          (err, execStream) => {
            if (err) {
              ws.send(
                JSON.stringify({
                  type: "open_file_in_editor",
                  path: requestedPath,
                }),
              );
              return;
            }
            let stdout = "";
            execStream.on("data", (chunk: Buffer) => {
              stdout += chunk.toString("utf-8");
            });
            execStream.stderr.on("data", () => {});
            execStream.on("close", () => {
              const resolvedPath = stdout.trim() || requestedPath;
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: "open_file_in_editor",
                    path: resolvedPath,
                  }),
                );
              }
            });
          },
        );
        break;
      }

      case "input": {
        const inputData = data as string;
        if (agentAttachContext) {
          const access = agentAttachContext;
          if (!isAgentAttachmentBoundToCurrentTerminal(access)) {
            ws.send(
              JSON.stringify({
                type: "sessionInputBlocked",
                code: "AGENT_SESSION_BINDING_REQUIRED",
                message: "Agent 会话尚未完成安全绑定，请稍后重试",
              }),
            );
            break;
          }
          const broker = getAgentSessionBroker();
          if (
            typeof inputData !== "string" ||
            inputData.length === 0 ||
            Buffer.byteLength(inputData, "utf8") > 1024 * 1024
          ) {
            ws.send(
              JSON.stringify({
                type: "sessionInputBlocked",
                code: "INVALID_INPUT",
                message: "终端输入无效",
              }),
            );
            break;
          }
          if (!broker || access.mode !== "read-write" || !access.leaseId) {
            ws.send(
              JSON.stringify({
                type: "sessionInputBlocked",
                code: "AGENT_READ_ONLY",
                message: "当前以只读方式查看 Agent 会话，请先接管输入权",
              }),
            );
            break;
          }
          try {
            await broker.writeEphemeral(
              access.principal,
              access.sessionId,
              access.attachmentId,
              access.leaseId,
              inputData,
            );
            if (currentSessionId) {
              sessionManager.bufferInput(currentSessionId, inputData);
            }
          } catch (error) {
            const code =
              typeof error === "object" && error !== null && "code" in error
                ? String((error as { code?: unknown }).code)
                : "AGENT_WRITE_FAILED";
            if (
              agentAttachContext === access &&
              (code === "WRITE_LEASE_INVALID" ||
                code === "ATTACHMENT_NOT_FOUND")
            ) {
              try {
                const readOnlyContext =
                  await replaceBrowserAgentAttachmentWithReadOnly(access);
                if (agentAttachContext !== access) {
                  await detachBrowserAgentAttachment(readOnlyContext);
                  break;
                }
                agentAttachContext = readOnlyContext;
                sendAgentAccessState(agentAttachContext);
              } catch {
                // 下面的错误消息会要求用户重新进入会话。
              }
            }
            ws.send(
              JSON.stringify({
                type: "sessionInputBlocked",
                code,
                message:
                  error instanceof Error ? error.message : "Agent 会话输入失败",
              }),
            );
          }
          break;
        }
        if (
          currentSessionId &&
          isAgentControlledTerminalSession(
            sessionManager.getSession(currentSessionId),
          )
        ) {
          ws.send(
            JSON.stringify({
              type: "sessionInputBlocked",
              code: "AGENT_SESSION_ATTACH_REQUIRED",
              message: "请从 Agent 持续会话入口进入后再操作",
            }),
          );
          break;
        }
        if (
          currentSessionId &&
          shouldBlockTerminalInputForPin(
            sessionManager.isPinTransitionActive(currentSessionId),
            pendingSessionPinChoiceSessionId === currentSessionId,
          )
        ) {
          ws.send(
            JSON.stringify({
              type: "sessionInputBlocked",
              code: "SESSION_PIN_TRANSITION",
              message:
                "Input is temporarily disabled while the pinned window state changes",
            }),
          );
          break;
        }
        if (
          currentSessionId &&
          !sessionManager.canWriteToSession(currentSessionId, ws)
        ) {
          break;
        }
        if (currentSessionId) {
          sessionManager.bufferInput(currentSessionId, inputData);
        }
        const inputStream =
          sessionManager.getSession(currentSessionId)?.sshStream ?? sshStream;
        if (inputStream) {
          if (inputData === "\t") {
            inputStream.write(inputData);
          } else if (
            typeof inputData === "string" &&
            inputData.startsWith("\x1b")
          ) {
            inputStream.write(inputData);
          } else {
            try {
              inputStream.write(Buffer.from(inputData, "utf8"));
            } catch (error) {
              sshLogger.error("Error writing input to SSH stream", error, {
                operation: "ssh_input_encoding",
                userId,
                dataLength: inputData.length,
              });
              inputStream.write(Buffer.from(inputData, "latin1"));
            }
          }
        }
        break;
      }

      case "ping":
        ws.send(JSON.stringify({ type: "pong" }));
        break;

      case "tmux_attach": {
        const tmuxData = data as { sessionName?: unknown };
        const session = currentSessionId
          ? sessionManager.getSession(currentSessionId)
          : null;
        if (session?.agentSessionId) {
          ws.send(
            JSON.stringify({
              type: "session_pin_error",
              code: "AGENT_SESSION_CONTROLLED",
              message: "Agent 持续会话不能从浏览器切换 tmux 窗口",
            }),
          );
          break;
        }
        if (session?.sshStream) {
          const requestedTmuxName = tmuxData.sessionName;
          if (
            requestedTmuxName !== undefined &&
            requestedTmuxName !== "" &&
            (typeof requestedTmuxName !== "string" ||
              requestedTmuxName.length > 160)
          ) {
            ws.send(
              JSON.stringify({
                type: "error",
                code: "INVALID_TMUX_SESSION",
                message: "tmux 会话标识无效",
              }),
            );
            break;
          }
          const existingName =
            typeof requestedTmuxName === "string" && requestedTmuxName
              ? requestedTmuxName
              : undefined;
          if (
            existingName &&
            isAgentManagedTmuxSession(existingName, session.hostId)
          ) {
            ws.send(
              JSON.stringify({
                type: "error",
                code: "AGENT_SESSION_ATTACH_REQUIRED",
                message: "请从 Agent 持续会话入口进入",
              }),
            );
            break;
          }
          if (existingName) {
            attachOrCreateTmuxSession(session.sshStream, existingName);
            session.tmuxSessionName = existingName;
            session.tmuxCreatedByCloudSsh = false;
            sshLogger.info("User selected tmux session to attach", {
              operation: "tmux_user_attach",
              sessionName: existingName,
              hostId: session.hostId,
            });
            ws.send(
              JSON.stringify({
                type: "tmux_session_attached",
                sessionName: existingName,
              }),
            );
          } else {
            const newName = `termix-${session.hostId}-${Date.now().toString(36).slice(-4)}`;
            attachOrCreateTmuxSession(session.sshStream, undefined, newName);
            const sshConn = session.sshConn;
            if (sshConn) {
              (async () => {
                const confirmed = await waitForTmuxSession(sshConn, newName);
                session.tmuxSessionName = confirmed;
                session.tmuxCreatedByCloudSsh = true;
                sshLogger.info("User requested new tmux session", {
                  operation: "tmux_user_create",
                  sessionName: confirmed,
                  hostId: session.hostId,
                });
                ws.send(
                  JSON.stringify({
                    type: "tmux_session_created",
                    sessionName: confirmed,
                  }),
                );
              })();
            }
          }
        }
        break;
      }

      case "tmux_detach": {
        const session = currentSessionId
          ? sessionManager.getSession(currentSessionId)
          : null;
        if (session?.agentSessionId) {
          ws.send(
            JSON.stringify({
              type: "session_pin_error",
              code: "AGENT_SESSION_CONTROLLED",
              message: "Agent 持续会话不能从浏览器分离 tmux",
            }),
          );
          break;
        }
        if (session?.managedTmux) {
          ws.send(
            JSON.stringify({
              type: "session_pin_error",
              code: "MANAGED_TMUX_DETACH_FORBIDDEN",
              message:
                "A platform-managed tmux window cannot be detached manually",
            }),
          );
          break;
        }
        if (session?.sshConn && session.tmuxSessionName) {
          const tmuxName = session.tmuxSessionName;
          session.sshStream?.write("\x02d");
          session.tmuxSessionName = null;
          session.tmuxCreatedByCloudSsh = false;
          sshLogger.info("User detached from tmux session", {
            operation: "tmux_user_detach",
            sessionName: tmuxName,
            hostId: session.hostId,
          });
          ws.send(
            JSON.stringify({ type: "tmux_detached", sessionName: tmuxName }),
          );
        }
        break;
      }

      case "totp_response": {
        const totpData = data as TOTPResponseData;
        if (keyboardInteractiveFinish && totpData?.code) {
          if (totpTimeout) {
            clearTimeout(totpTimeout);
            totpTimeout = null;
          }
          const totpCode = totpData.code;
          keyboardInteractiveFinish([totpCode]);
          keyboardInteractiveFinish = null;
          totpPromptSent = false;
        } else {
          sshLogger.warn("TOTP response received but no callback available", {
            operation: "totp_response_error",
            userId,
            hasCallback: !!keyboardInteractiveFinish,
            hasCode: !!totpData?.code,
          });
          ws.send(
            JSON.stringify({
              type: "error",
              message: "TOTP authentication state lost. Please reconnect.",
            }),
          );
        }
        break;
      }

      case "password_response": {
        const passwordData = data as TOTPResponseData;
        if (keyboardInteractiveFinish && passwordData?.code) {
          if (totpTimeout) {
            clearTimeout(totpTimeout);
            totpTimeout = null;
          }
          const password = passwordData.code;
          keyboardInteractiveFinish([password]);
          keyboardInteractiveFinish = null;
        } else {
          sshLogger.warn(
            "Password response received but no callback available",
            {
              operation: "password_response_error",
              userId,
              hasCallback: !!keyboardInteractiveFinish,
              hasCode: !!passwordData?.code,
            },
          );
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Password authentication state lost. Please reconnect.",
            }),
          );
        }
        break;
      }

      case "warpgate_auth_continue": {
        if (keyboardInteractiveFinish) {
          if (warpgateAuthTimeout) {
            clearTimeout(warpgateAuthTimeout);
            warpgateAuthTimeout = null;
          }
          keyboardInteractiveFinish([""]);
          keyboardInteractiveFinish = null;
          warpgateAuthPromptSent = false;
        }
        break;
      }

      case "reconnect_with_credentials": {
        const credentialsData = data as {
          cols: number;
          rows: number;
          hostConfig: ConnectToHostData["hostConfig"];
          password?: string;
          sshKey?: string;
          keyPassword?: string;
        };

        // 私钥口令重试是 Agent 附着流程的一部分。主机定位必须重新从
        // 服务端按原 Agent session ID 解析，不能信任浏览器在重试消息中
        // 替换的 hostId/projectHostId，否则可把已验证的 Agent tmux 名称
        // 带到另一台主机上执行。
        const reconnectAgentContext = agentAttachContext;
        if (agentAttachContext) {
          try {
            const target = await resolveAgentBrowserSession(
              agentAttachContext.sessionId,
              userId,
            );
            if (
              target.projectId !== agentAttachContext.projectId ||
              target.projectHostId !== agentAttachContext.projectHostId ||
              target.hostId !== agentAttachContext.hostId ||
              target.serviceAccountId !==
                agentAttachContext.principal.serviceAccountId ||
              target.runtimeMode !== agentAttachContext.runtimeMode ||
              target.tmuxName !== agentAttachContext.tmuxName ||
              !target.host
            ) {
              throw Object.assign(new Error("Agent 会话授权或目标已经变化"), {
                code: "AGENT_SESSION_ACCESS_CHANGED",
              });
            }
            credentialsData.hostConfig = {
              ...credentialsData.hostConfig,
              id: target.hostId,
              projectHostId: target.projectHostId,
              ip: target.host.ip,
              port: target.host.port,
              username: target.host.username,
              userId,
            };
          } catch (error) {
            const code =
              typeof error === "object" && error !== null && "code" in error
                ? String((error as { code?: unknown }).code)
                : "AGENT_SESSION_ATTACH_FAILED";
            releaseCurrentBrowserAgentAttachment();
            ws.send(
              JSON.stringify({
                type: "error",
                code,
                message: "Agent 会话附着目标已失效，请从连接列表重新进入",
              }),
            );
            break;
          }
        }

        let credentialOverride: TerminalCredentialOverride | undefined;
        if (credentialsData.password) {
          credentialOverride = {
            kind: "password",
            password: credentialsData.password,
          };
        } else if (credentialsData.sshKey) {
          credentialOverride = {
            kind: "key",
            key: credentialsData.sshKey,
            keyPassword: credentialsData.keyPassword,
          };
        } else if (credentialsData.keyPassword) {
          credentialOverride = {
            kind: "passphrase",
            keyPassword: credentialsData.keyPassword,
          };
        }

        if (currentSessionId) {
          sessionManager.destroySession(currentSessionId);
          currentSessionId = null;
        }
        if (reconnectAgentContext) isAwaitingAuthCredentials = true;
        cleanupAuthState();
        if (reconnectAgentContext) {
          agentAttachContext ??= reconnectAgentContext;
          isAwaitingAuthCredentials = false;
        }
        sshConn = null;
        sshStream = null;

        const reconnectData: ConnectToHostData = {
          cols: credentialsData.cols,
          rows: credentialsData.rows,
          hostConfig: credentialsData.hostConfig,
        };
        if (agentAttachContext) {
          reconnectData.agentSessionId = agentAttachContext.sessionId;
          reconnectData.tmuxAttachSession = agentAttachContext.tmuxName;
        }

        handleConnectToHost(reconnectData, undefined, credentialOverride).catch(
          (error) => {
            const errMsg =
              error instanceof Error ? error.message : "Unknown error";
            if (
              errMsg.includes("Cannot parse privateKey") &&
              errMsg.includes("no passphrase")
            ) {
              isAwaitingAuthCredentials = true;
              ws.send(
                JSON.stringify({
                  type: "passphrase_required",
                  message:
                    "The SSH key is encrypted. Please enter the passphrase to unlock it.",
                }),
              );
              return;
            }
            sshLogger.error("Failed to reconnect with credentials", error, {
              operation: "ssh_reconnect_with_credentials",
              userId,
              hostId: credentialsData.hostConfig?.id,
              ip: credentialsData.hostConfig?.ip,
            });
            ws.send(
              JSON.stringify({
                type: "error",
                message:
                  "Failed to connect with provided credentials: " + errMsg,
              }),
            );
          },
        );
        break;
      }

      case "opkssh_start_auth": {
        const opksshData = data as { hostId: number };
        try {
          const { startOPKSSHAuth } = await import("../opkssh-auth.js");
          const { getRequestOrigin } =
            await import("../../utils/request-origin.js");
          const host =
            await createCurrentHostResolutionRepository().findHostById(
              opksshData.hostId,
              userId,
            );
          if (!host) {
            sshLogger.error(
              `Host ${opksshData.hostId} not found for OPKSSH auth`,
              {
                operation: "opkssh_start_auth_host_not_found",
                userId,
                hostId: opksshData.hostId,
              },
            );
            ws.send(
              JSON.stringify({
                type: "opkssh_error",
                requestId: "",
                error: "Host not found",
              }),
            );
            break;
          }
          const hostname = host.name || host.ip;
          const requestOrigin = getRequestOrigin(req);
          await startOPKSSHAuth(
            userId,
            opksshData.hostId,
            hostname,
            ws,
            requestOrigin,
          );
        } catch (error) {
          sshLogger.error("Failed to start OPKSSH auth", error, {
            operation: "opkssh_start_auth_error",
            userId,
            hostId: opksshData.hostId,
          });
          ws.send(
            JSON.stringify({
              type: "opkssh_error",
              requestId: "",
              error: "Failed to start OPKSSH authentication",
            }),
          );
        }
        break;
      }

      case "opkssh_cancel": {
        const cancelData = data as { requestId: string };
        try {
          const { cancelAuthSession } = await import("../opkssh-auth.js");
          cancelAuthSession(cancelData.requestId);
          resetConnectionState();
        } catch (error) {
          sshLogger.error("Failed to cancel OPKSSH auth", error, {
            operation: "opkssh_cancel_error",
            userId,
          });
        }
        break;
      }

      case "opkssh_browser_opened": {
        break;
      }

      case "opkssh_auth_completed": {
        const completedData = data as {
          hostId: number;
          cols?: number;
          rows?: number;
          hostConfig?: ConnectToHostData["hostConfig"];
        };

        resetConnectionState();

        const authenticatedHostId = Number(completedData.hostId);
        if (
          !Number.isSafeInteger(authenticatedHostId) ||
          authenticatedHostId <= 0
        ) {
          ws.send(
            JSON.stringify({
              type: "error",
              code: "INVALID_AUTHENTICATED_HOST",
              message: "Invalid authenticated host",
            }),
          );
          break;
        }

        const reconnectConfig: ConnectToHostData = {
          cols: completedData.cols || 80,
          rows: completedData.rows || 24,
          hostConfig: {
            ...(completedData.hostConfig || {
              ip: "",
              port: 22,
              username: "",
            }),
            // 完成事件只能回到刚完成认证的主机，浏览器缓存不能替换目标。
            id: authenticatedHostId,
            userId,
          } as ConnectToHostData["hostConfig"],
        };

        handleConnectToHost(reconnectConfig).catch((error) => {
          sshLogger.error("Failed to reconnect after OPKSSH auth", error, {
            operation: "opkssh_reconnect_error",
            userId,
            hostId: completedData.hostId,
          });
          ws.send(
            JSON.stringify({
              type: "error",
              message:
                "Failed to connect after authentication: " +
                (error instanceof Error ? error.message : "Unknown error"),
            }),
          );
        });
        break;
      }

      case "vault_start_auth": {
        const vaultData = data as { hostId: number };
        try {
          const { loadVaultProfileForHost, startVaultAuth } =
            await import("../vault-oidc-auth.js");
          const { getRequestOrigin } =
            await import("../../utils/request-origin.js");
          const profile = await loadVaultProfileForHost(
            vaultData.hostId,
            userId,
          );
          if (!profile) {
            ws.send(
              JSON.stringify({
                type: "vault_error",
                hostId: vaultData.hostId,
                error: "No Vault signer profile configured for this host",
              }),
            );
            break;
          }
          const requestOrigin = getRequestOrigin(req);
          await startVaultAuth(
            userId,
            vaultData.hostId,
            profile,
            ws,
            requestOrigin,
          );
        } catch (error) {
          sshLogger.error("Failed to start Vault auth", error, {
            operation: "vault_start_auth_error",
            userId,
            hostId: vaultData.hostId,
          });
          ws.send(
            JSON.stringify({
              type: "vault_error",
              hostId: vaultData.hostId,
              error:
                error instanceof Error
                  ? error.message
                  : "Failed to start Vault authentication",
            }),
          );
        }
        break;
      }

      case "vault_cancel": {
        const cancelData = data as { hostId: number };
        try {
          const { cancelVaultAuthByHost } =
            await import("../vault-oidc-auth.js");
          cancelVaultAuthByHost(userId, cancelData.hostId);
          resetConnectionState();
        } catch (error) {
          sshLogger.error("Failed to cancel Vault auth", error, {
            operation: "vault_cancel_error",
            userId,
          });
        }
        break;
      }

      case "vault_auth_completed": {
        const completedData = data as {
          hostId: number;
          cols?: number;
          rows?: number;
          hostConfig?: ConnectToHostData["hostConfig"];
        };

        resetConnectionState();

        const authenticatedHostId = Number(completedData.hostId);
        if (
          !Number.isSafeInteger(authenticatedHostId) ||
          authenticatedHostId <= 0
        ) {
          ws.send(
            JSON.stringify({
              type: "error",
              code: "INVALID_AUTHENTICATED_HOST",
              message: "Invalid authenticated host",
            }),
          );
          break;
        }

        const reconnectConfig: ConnectToHostData = {
          cols: completedData.cols || 80,
          rows: completedData.rows || 24,
          hostConfig: {
            ...(completedData.hostConfig || {
              ip: "",
              port: 22,
              username: "",
            }),
            // Vault 证书同样绑定完成认证的主机，不能采用旧标签的 ID。
            id: authenticatedHostId,
            userId,
          } as ConnectToHostData["hostConfig"],
        };

        handleConnectToHost(reconnectConfig).catch((error) => {
          sshLogger.error("Failed to reconnect after Vault auth", error, {
            operation: "vault_reconnect_error",
            userId,
            hostId: completedData.hostId,
          });
          ws.send(
            JSON.stringify({
              type: "error",
              message:
                "Failed to connect after authentication: " +
                (error instanceof Error ? error.message : "Unknown error"),
            }),
          );
        });
        break;
      }

      case "joinSharedSession": {
        const joinData = data as { shareId: string; tabInstanceId?: string };
        try {
          const shareRepo = createCurrentSessionShareRepository();
          const share = await shareRepo.findActiveById(joinData.shareId);
          if (
            !share ||
            share.shareType !== "user" ||
            share.targetUserId !== userId ||
            share.protocol !== "ssh"
          ) {
            ws.send(
              JSON.stringify({
                type: "error",
                message: "Share not found or not accessible",
              }),
            );
            break;
          }

          const sharedSession = sessionManager.getSession(share.sessionId);
          if (!sharedSession || !sharedSession.isConnected) {
            ws.send(
              JSON.stringify({
                type: "error",
                message: "Shared session is no longer active",
              }),
            );
            break;
          }

          const initialAccess = await checkSharedParticipantCandidateAccess(
            sharedSession,
            {
              userId,
              isOwner: false,
              joinedViaShareId: share.id,
            },
          ).catch(() => ({ allowed: false }) as const);
          if (!initialAccess.allowed) {
            ws.send(
              JSON.stringify({
                type: "error",
                message: "Share not found or not accessible",
              }),
            );
            break;
          }
          if (
            sessionManager.getSession(share.sessionId) !== sharedSession ||
            !sharedSession.isConnected
          ) {
            ws.send(
              JSON.stringify({
                type: "error",
                message: "Shared session is no longer active",
              }),
            );
            break;
          }

          const joinedSession = sessionManager.joinAsParticipant(
            share.sessionId,
            ws,
            {
              userId,
              permissionLevel: initialAccess.permissionLevel,
              tabInstanceId: joinData.tabInstanceId,
              shareId: share.id,
            },
          );
          if (!joinedSession) {
            ws.send(
              JSON.stringify({
                type: "error",
                message: "Shared session is no longer active",
              }),
            );
            break;
          }

          currentSessionId = share.sessionId;
          beginSharedParticipantAccessChecks(currentSessionId);
          sshStream = joinedSession.sshStream;
          sshConn = joinedSession.sshConn;
          isConnecting = false;
          isConnected = true;

          shareRepo.touchShareUsage(share.id).catch(() => {});
          shareRepo
            .recordParticipantJoin(share.id, userId, null)
            .catch(() => {});

          const buffered = sessionManager.getBuffer(joinedSession);
          if (buffered) {
            ws.send(JSON.stringify({ type: "data", data: buffered }));
          }
          ws.send(
            JSON.stringify({
              type: "sessionAttached",
              sessionId: share.sessionId,
            }),
          );
          ws.send(
            JSON.stringify({ type: "connected", message: "Joined session" }),
          );
        } catch (error) {
          sshLogger.error("Failed to join shared session", error, {
            operation: "terminal_join_shared_session_error",
            userId,
            shareId: joinData.shareId,
          });
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Failed to join shared session",
            }),
          );
        }
        break;
      }

      default:
        sshLogger.warn("Unknown message type received", {
          operation: "websocket_message_unknown_type",
          userId,
          messageType: type,
        });
    }
  });

  async function handleConnectToHost(
    data: ConnectToHostData,
    recoveryRecord?: WebTerminalSessionRecord,
    credentialOverride?: TerminalCredentialOverride,
  ) {
    let startupInput: string | undefined;
    let startupMoshCommand: string | undefined;
    try {
      ({ startupInput, startupMoshCommand } =
        validateTerminalStartupPayload(data));
    } catch (error) {
      if (error instanceof TerminalStartupValidationError) {
        ws.send(
          JSON.stringify({
            type: "error",
            code: error.code,
            message: error.message,
          }),
        );
        return;
      }
      throw error;
    }

    const { hostConfig, initialPath, executeCommand, tmuxAttachSession } = data;
    // 所有连接和重连路径都使用当前 WebSocket 的认证用户，不能信任客户端
    // 缓存或手工构造的 userId。
    hostConfig.userId = userId;
    const {
      id,
      ip: rawIp,
      port: clientPort,
      username: clientUsername,
      password,
      key,
      keyPassword,
      keyType,
      authType,
    } = hostConfig;
    const clientIp = rawIp?.replace(/^\[|\]$/g, "").trim() || rawIp;
    let ip = clientIp;
    let port = clientPort;
    let username = clientUsername;
    sshLogger.info("Resolving SSH host configuration", {
      operation: "terminal_host_resolve",
      sessionId,
      userId,
      hostId: id,
    });

    const sendLog = (
      stage: string,
      level: string,
      message: string,
      details?: Record<string, unknown>,
    ) => {
      ws.send(
        JSON.stringify({
          type: "connection_log",
          data: { stage, level, message, details },
        }),
      );
    };

    if (isConnecting || isConnected) {
      sshLogger.warn("Connection already in progress or established", {
        operation: "ssh_connect",
        hostId: id,
        isConnecting,
        isConnected,
      });
      ws.send(
        JSON.stringify({
          type: "error",
          message: "Connection already in progress",
          code: "DUPLICATE_CONNECTION",
        }),
      );
      return;
    }

    isConnecting = true;
    sshConn = new Client();

    const connectionTimeout = setTimeout(() => {
      if (sshConn && isConnecting && !isConnected) {
        sshLogger.error("SSH connection timeout", undefined, {
          operation: "ssh_connect",
          hostId: id,
          ip,
          port,
          username,
        });
        ws.send(
          JSON.stringify({ type: "error", message: "SSH connection timeout" }),
        );
        if (currentSessionId) {
          sessionManager.destroySession(currentSessionId);
          currentSessionId = null;
        }
        cleanupAuthState(connectionTimeout);
      }
    }, 120000);

    let resolvedHostData:
      | (Record<string, unknown> & TerminalConnectionMaterialSource)
      | null = null;
    const numericHostId = Number(id);
    const isSavedHost =
      Number.isSafeInteger(numericHostId) && numericHostId > 0;

    if (isSavedHost) {
      try {
        const { resolveHostById } = await import("../host-resolver.js");
        resolvedHostData = (await resolveHostById(
          numericHostId,
          userId,
          hostConfig.projectHostId,
        )) as unknown as typeof resolvedHostData;
      } catch (error) {
        sshLogger.warn(`Failed to resolve server-side host data for ${id}`, {
          operation: "ssh_host_data",
          hostId: id,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }

      // 已保存主机不能在解析失败后退回浏览器配置，否则旧凭据甚至伪造的
      // 目标地址都可能被继续使用。
      if (!resolvedHostData) {
        ws.send(
          JSON.stringify({
            type: "error",
            code: "HOST_RESOLUTION_FAILED",
            message:
              "The saved host is unavailable or its credentials are locked",
          }),
        );
        cleanupAuthState(connectionTimeout);
        return;
      }
    }

    let connectionMaterial;
    try {
      connectionMaterial = resolveTerminalConnectionMaterial({
        connectionMode: isSavedHost ? "saved-host" : "quick-connect",
        clientHost: {
          ...(hostConfig as unknown as TerminalConnectionMaterialSource),
          ip: clientIp,
          port: clientPort,
          username: clientUsername,
          password,
          key,
          keyPassword,
          keyType,
          authType,
        },
        authoritativeHost: resolvedHostData,
        credentialOverride,
      });
    } catch (error) {
      ws.send(
        JSON.stringify({
          type: "error",
          code: "INVALID_CREDENTIAL_OVERRIDE",
          message:
            error instanceof Error
              ? error.message
              : "Invalid SSH credential override",
        }),
      );
      cleanupAuthState(connectionTimeout);
      return;
    }

    ip = connectionMaterial.target.ip;
    port = connectionMaterial.target.port;
    username = connectionMaterial.auth.username;
    let resolvedCredentials = connectionMaterial.auth;
    const authMethodNotAvailable = false;

    // 后续跳板机、代理、端口敲门和认证流程只读取这份权威运行配置。
    hostConfig.ip = ip;
    hostConfig.port = port;
    hostConfig.username = username;
    hostConfig.forceKeyboardInteractive =
      connectionMaterial.auth.forceKeyboardInteractive;
    hostConfig.jumpHosts = connectionMaterial.runtime.jumpHosts;
    hostConfig.useSocks5 = connectionMaterial.runtime.useSocks5;
    hostConfig.socks5Host = connectionMaterial.runtime.socks5Host;
    hostConfig.socks5Port = connectionMaterial.runtime.socks5Port;
    hostConfig.socks5Username = connectionMaterial.runtime.socks5Username;
    hostConfig.socks5Password = connectionMaterial.runtime.socks5Password;
    hostConfig.socks5ProxyChain = connectionMaterial.runtime.socks5ProxyChain;
    hostConfig.portKnockSequence = connectionMaterial.runtime
      .portKnockSequence as ConnectToHostData["hostConfig"]["portKnockSequence"];
    hostConfig.terminalConfig = connectionMaterial.runtime
      .terminalConfig as ConnectToHostData["hostConfig"]["terminalConfig"];
    hostConfig.enableSessionLogging =
      connectionMaterial.runtime.enableSessionLogging;

    if (isSavedHost) {
      sendLog(
        "auth",
        "info",
        credentialOverride
          ? "Using one-time credentials with server-side host data"
          : "Credentials resolved from server-side host data",
      );
    }
    if (hostConfig.jumpHosts?.length) {
      sendLog(
        "jump",
        "info",
        `Loaded ${hostConfig.jumpHosts.length} jump host(s) from server-side host data`,
      );
    }
    if (hostConfig.portKnockSequence?.length) {
      sendLog(
        "port_knock",
        "info",
        `Loaded ${hostConfig.portKnockSequence.length} port knock(s) from server-side host data`,
      );
    }

    if (!username || typeof username !== "string" || username.trim() === "") {
      sshLogger.error("Invalid username provided", undefined, {
        operation: "ssh_connect",
        hostId: id,
        ip,
      });
      ws.send(
        JSON.stringify({ type: "error", message: "Invalid username provided" }),
      );
      cleanupAuthState(connectionTimeout);
      return;
    }

    if (!ip || typeof ip !== "string" || ip.trim() === "") {
      sshLogger.error("Invalid IP provided", undefined, {
        operation: "ssh_connect",
        hostId: id,
        username,
      });
      ws.send(
        JSON.stringify({ type: "error", message: "Invalid IP provided" }),
      );
      cleanupAuthState(connectionTimeout);
      return;
    }

    if (!port || typeof port !== "number" || port <= 0) {
      sshLogger.error("Invalid port provided", undefined, {
        operation: "ssh_connect",
        hostId: id,
        ip,
        username,
        port,
      });
      ws.send(
        JSON.stringify({ type: "error", message: "Invalid port provided" }),
      );
      cleanupAuthState(connectionTimeout);
      return;
    }

    sendLog("dns", "info", `Starting address resolution of ${ip}`);
    sendLog("tcp", "info", `Connecting to ${ip} port ${port}`);

    if (hostConfig.passwordFallbackOnly && resolvedCredentials.password) {
      resolvedCredentials = {
        ...resolvedCredentials,
        key: undefined,
        keyPassword: undefined,
        keyType: undefined,
        certPublicKey: undefined,
        authType: "password",
      };
    }

    const connectsViaJumpHosts = !!(
      hostConfig.jumpHosts &&
      hostConfig.jumpHosts.length > 0 &&
      hostConfig.userId
    );

    let connectHost = ip;
    if (connectsViaJumpHosts) {
      // The target is only reachable through the jump host's network (e.g. a
      // VPN-only address), so DNS must be resolved there, not on this host.
      sendLog(
        "dns",
        "info",
        `Skipping local address resolution of ${ip} (resolved by jump host)`,
      );
    } else {
      sendLog("dns", "info", `Starting address resolution of ${ip}`);
      try {
        const resolution = await resolveHostForSshConnect(ip);
        connectHost = resolution.host;
        if (resolution.resolvedAddress && resolution.resolvedAddress !== ip) {
          sendLog(
            "dns",
            "success",
            `Resolved ${ip} to ${resolution.resolvedAddress}`,
            { attempts: resolution.attempts },
          );
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        sshLogger.error("SSH hostname resolution failed", error, {
          operation: "terminal_dns_resolve",
          hostId: id,
          ip,
          port,
          transient: isRetriableDnsError(error),
        });
        sendLog("dns", "error", `DNS resolution failed for ${ip}: ${message}`);
        ws.send(
          JSON.stringify({
            type: "error",
            message: isRetriableDnsError(error)
              ? "SSH error: DNS lookup temporarily failed. Check the Docker/container DNS configuration or try again."
              : "SSH error: Could not resolve hostname from the Termix server container.",
          }),
        );
        cleanupAuthState(connectionTimeout);
        return;
      }
    }
    sendLog("tcp", "info", `Connecting to ${ip} port ${port}`);

    const handleSshReadyWorkflowError = (error: unknown): void => {
      sshLogger.error("Unhandled SSH ready workflow failure", error, {
        operation: "terminal_ssh_ready_workflow_error",
        sessionId: currentSessionId ?? recoveryRecord?.id ?? sessionId,
        userId,
        hostId: id,
      });

      const failedSessionId = currentSessionId ?? recoveryRecord?.id ?? null;
      if (failedSessionId) {
        sessionManager.finishPinTransition(failedSessionId);
        sessionManager.destroySession(failedSessionId);
        if (currentSessionId === failedSessionId) currentSessionId = null;
      }
      try {
        sshConn?.end();
      } catch {
        // SSH 连接可能已经关闭。
      }

      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify(
              recoveryRecord
                ? {
                    type: "sessionRecoveryDeferred",
                    sessionId: recoveryRecord.id,
                    code: "RECOVERY_SETUP_FAILED",
                    message:
                      "The fixed window could not be restored safely. Its recovery record was kept.",
                  }
                : {
                    type: "error",
                    code: "SSH_READY_WORKFLOW_FAILED",
                    message: "SSH terminal initialization failed",
                  },
            ),
          );
          if (recoveryRecord) {
            ws.close(1013, "Fixed window recovery failed");
          }
        }
      } finally {
        cleanupAuthState(connectionTimeout);
      }
    };

    sshConn.on("ready", () => {
      runGuardedTerminalTask(async () => {
        clearTimeout(connectionTimeout);
        sshLogger.success("SSH connection established", {
          operation: "terminal_ssh_connected",
          sessionId,
          userId,
          hostId: id,
          ip,
        });

        logAudit({
          userId,
          username: userId,
          action: "ssh_connect",
          resourceType: "host",
          resourceId: String(id),
          resourceName: `${username}@${ip}:${port}`,
          success: true,
        });
        if (totpPromptSent) {
          authLogger.success("TOTP verification successful for SSH session", {
            operation: "terminal_totp_success",
            sessionId,
            userId,
            hostId: id,
          });
        }
        sendLog("handshake", "success", "SSH handshake completed");
        sendLog("auth", "success", `Authentication successful for ${username}`);
        sendLog("connected", "success", "Connection established");

        const hostDisplayName = `${username}@${ip}:${port}`;
        const tabInstanceId = hostConfig.instanceId;
        const sessionLoggingEnabled =
          resolvedHostData?.enableSessionLogging ??
          hostConfig.enableSessionLogging ??
          true;
        try {
          currentSessionId = sessionManager.createSession(
            userId,
            id,
            hostDisplayName,
            data.cols,
            data.rows,
            tabInstanceId,
            sessionLoggingEnabled,
            {
              projectHostId: hostConfig.projectHostId,
              sessionId: recoveryRecord?.id,
              pinned: Boolean(recoveryRecord),
              tmuxSessionName:
                recoveryRecord?.tmuxName ?? tmuxAttachSession ?? null,
              agentSessionId: data.agentSessionId,
              recoveryTargetFingerprint:
                recoveryRecord?.targetFingerprint ??
                createTerminalRecoveryTargetFingerprint({ ip, port, username }),
              recovering: Boolean(recoveryRecord),
            },
          );
        } catch (error) {
          ws.send(
            JSON.stringify({
              type: "error",
              code:
                error instanceof TerminalLifecycleUnavailableError
                  ? error.code
                  : "TERMINAL_SESSION_LIMIT_REACHED",
              message:
                error instanceof Error
                  ? error.message
                  : "Terminal session limit reached",
            }),
          );
          try {
            sshConn?.end();
          } catch {
            // SSH 连接可能已由远端关闭。
          }
          cleanupAuthState(connectionTimeout);
          return;
        }

        // If createSession returned an existing live session (duplicate tabInstanceId),
        // close the newly-established SSH connection and attach this WS to the live session instead.
        const existingSession = sessionManager.getSession(currentSessionId);
        if (
          existingSession &&
          existingSession.sshStream &&
          !existingSession.sshStream.destroyed &&
          existingSession.sshConn !== sshConn
        ) {
          const reusedSessionId = currentSessionId;
          const canReuse = await hasCurrentHostAccess(existingSession);
          const attached = canReuse
            ? sessionManager.attachWs(
                reusedSessionId,
                userId,
                ws,
                tabInstanceId,
              )
            : null;
          sshLogger.info(
            "Reusing existing live session after duplicate connectToHost, closing new SSH conn",
            {
              operation: "terminal_reuse_existing_session",
              sessionId: reusedSessionId,
              tabInstanceId,
              userId,
            },
          );
          // Null out currentSessionId before ending the duplicate connection so
          // the sshConn "close" handler does not destroy the reused session.
          // Set isDuplicateConnDiscarded so the close handler exits without
          // sending a "disconnected" message to the new WS.
          currentSessionId = null;
          isDuplicateConnDiscarded = true;
          clearTimeout(connectionTimeout);
          try {
            sshConn?.end();
          } catch {
            /* ignore */
          }
          sshConn = null;
          sshStream = null;

          if (!attached) {
            ws.send(
              JSON.stringify({
                type: "sessionExpired",
                sessionId: reusedSessionId,
                code: canReuse
                  ? "SESSION_ATTACH_CONFLICT"
                  : "HOST_ACCESS_REVOKED",
                message: canReuse
                  ? "Session could not be reattached"
                  : "Host access is no longer available",
              }),
            );
            cleanupAuthState(connectionTimeout);
            return;
          }

          // Point this WS handler's closure at the live session so the input
          // handler can forward keystrokes via currentSessionId.
          currentSessionId = reusedSessionId;
          sshStream = existingSession.sshStream;
          sshConn = existingSession.sshConn;
          isConnecting = false;
          isConnected = true;

          const buffered = sessionManager.getBuffer(existingSession);
          if (buffered) {
            ws.send(JSON.stringify({ type: "data", data: buffered }));
          }
          ws.send(
            JSON.stringify({
              type: "sessionCreated",
              sessionId: reusedSessionId,
            }),
          );
          ws.send(
            JSON.stringify({
              type: "sessionAttached",
              sessionId: reusedSessionId,
            }),
          );
          sendSessionPersistenceState(ws, existingSession);
          ws.send(
            JSON.stringify({
              type: "connected",
              message: "Session reattached",
            }),
          );
          return;
        }

        sshLogger.info("Terminal session created after SSH ready", {
          operation: "terminal_session_created",
          sessionId: currentSessionId,
          userId,
          hostId: id,
          tabInstanceId,
          ip,
          port,
        });

        const conn = sshConn;

        if (!conn || isCleaningUp || !sshConn) {
          sshLogger.warn(
            "SSH connection was cleaned up before shell could be created",
            {
              operation: "ssh_shell",
              hostId: id,
              ip,
              port,
              username,
              isCleaningUp,
              connNull: !conn,
              sshConnNull: !sshConn,
            },
          );
          ws.send(
            JSON.stringify({
              type: "error",
              message:
                "SSH connection was closed before terminal could be created",
            }),
          );
          if (currentSessionId) {
            sessionManager.destroySession(currentSessionId);
            currentSessionId = null;
          }
          cleanupAuthState(connectionTimeout);
          return;
        }

        if (recoveryRecord) {
          const recoveryProbe = await probeTmuxSession(
            conn,
            recoveryRecord.tmuxName,
            2_000,
          );
          if (shouldDeletePinnedRecoveryRecord(recoveryProbe)) {
            await createCurrentWebTerminalSessionRepository().deleteOwned(
              userId,
              recoveryRecord.id,
            );
            const staleSession = sessionManager.getSession(recoveryRecord.id);
            if (staleSession) {
              staleSession.pinned = false;
              staleSession.managedTmux = false;
            }
            ws.send(
              JSON.stringify({
                type: "sessionRecoveryFailed",
                sessionId: recoveryRecord.id,
                code: "TMUX_SESSION_NOT_FOUND",
                message: "The remote managed tmux session no longer exists",
              }),
            );
            ws.send(
              JSON.stringify({
                type: "sessionExpired",
                sessionId: recoveryRecord.id,
              }),
            );
            sessionManager.destroySession(recoveryRecord.id);
            currentSessionId = null;
            try {
              conn.end();
            } catch {
              // 连接可能已经由远端关闭。
            }
            cleanupAuthState(connectionTimeout);
            return;
          }
          if (recoveryProbe === "unknown") {
            ws.send(
              JSON.stringify({
                type: "sessionRecoveryDeferred",
                sessionId: recoveryRecord.id,
                code: "TMUX_SESSION_PROBE_UNAVAILABLE",
                message:
                  "The remote fixed window could not be verified. Its recovery record was kept.",
              }),
            );
            sessionManager.destroySession(recoveryRecord.id);
            currentSessionId = null;
            cleanupAuthState(connectionTimeout);
            ws.close(1013, "Fixed window verification unavailable");
            return;
          }
        }

        isShellInitializing = true;
        isConnecting = false;
        isConnected = true;

        if (!sshConn) {
          sshLogger.error(
            "SSH connection became null right before shell creation",
            {
              operation: "ssh_shell",
              hostId: id,
            },
          );
          ws.send(
            JSON.stringify({
              type: "error",
              message: "SSH connection lost during setup",
            }),
          );
          isShellInitializing = false;
          if (currentSessionId) {
            sessionManager.destroySession(currentSessionId);
            currentSessionId = null;
          }
          cleanupAuthState(connectionTimeout);
          return;
        }

        sshLogger.info("Creating shell", {
          operation: "ssh_shell_start",
          hostId: id,
          ip,
          port,
          username,
        });

        let shellCallbackReceived = false;
        const shellTimeout = setTimeout(() => {
          if (!shellCallbackReceived && isShellInitializing) {
            sshLogger.error(
              "Shell creation timeout - no response from server",
              {
                operation: "ssh_shell_timeout",
                hostId: id,
                ip,
                port,
                username,
              },
            );
            isShellInitializing = false;
            ws.send(
              JSON.stringify({
                type: "error",
                message:
                  "Shell creation timeout. The server may not support interactive shells or the connection was interrupted.",
              }),
            );
            if (currentSessionId) {
              sessionManager.destroySession(currentSessionId);
              currentSessionId = null;
            }
            cleanupAuthState(connectionTimeout);
          }
        }, 15000);

        conn.shell(
          {
            rows: data.rows,
            cols: data.cols,
            term: "xterm-256color",
          } as PseudoTtyOptions,
          (err, stream) => {
            runGuardedTerminalTask(async () => {
              shellCallbackReceived = true;
              clearTimeout(shellTimeout);
              isShellInitializing = false;

              if (err) {
                sshLogger.error("Shell error", err, {
                  operation: "ssh_shell",
                  hostId: id,
                  ip,
                  port,
                  username,
                });
                ws.send(
                  JSON.stringify({
                    type: "error",
                    message: "Shell error: " + err.message,
                  }),
                );
                if (currentSessionId) {
                  sessionManager.destroySession(currentSessionId);
                  currentSessionId = null;
                }
                cleanupAuthState(connectionTimeout);
                return;
              }

              sshStream = stream;
              sshLogger.success("Terminal shell channel opened", {
                operation: "terminal_shell_opened",
                sessionId,
                userId,
                hostId: id,
                termType: "xterm-256color",
              });

              if (currentSessionId) {
                sessionManager.setSSHState(
                  currentSessionId,
                  sshConn!,
                  stream,
                  lastJumpClient,
                );
                if (!recoveryRecord) {
                  sessionManager.attachWs(
                    currentSessionId,
                    userId,
                    ws,
                    tabInstanceId,
                  );
                }
                resetHostAccessValidation(currentSessionId);

                ws.send(
                  JSON.stringify({
                    type: "sessionCreated",
                    sessionId: currentSessionId,
                  }),
                );
                const readySession =
                  sessionManager.getSession(currentSessionId);
                if (readySession) sendSessionPersistenceState(ws, readySession);

                sshLogger.info("Session ready for persistence", {
                  operation: "session_ready",
                  sessionId: currentSessionId,
                  userId,
                  hostId: id,
                });
              }

              const boundSessionId = currentSessionId;

              stream.on("data", (data: Buffer) => {
                try {
                  const utf8String = data.toString("utf-8");

                  if (!utf8String) return;

                  const session = sessionManager.getSession(boundSessionId);
                  if (session) {
                    sessionManager.bufferOutput(boundSessionId!, utf8String);
                    sessionManager.broadcast(boundSessionId!, {
                      type: "data",
                      data: utf8String,
                    });
                  }
                } catch (error) {
                  sshLogger.error("Error encoding terminal data", error, {
                    operation: "terminal_data_encoding",
                    hostId: id,
                    dataLength: data.length,
                  });
                  const fallback = data.toString("latin1");
                  const session = sessionManager.getSession(boundSessionId);
                  if (session) {
                    sessionManager.bufferOutput(boundSessionId!, fallback);
                    sessionManager.broadcast(boundSessionId!, {
                      type: "data",
                      data: fallback,
                    });
                  }
                }
              });

              bindTerminalChannelLifecycle(stream, (channelExit) => {
                isShellClosureInProgress = true;
                runGuardedTerminalTask(
                  async () => {
                    const session = sessionManager.getSession(boundSessionId);
                    if (!session || !boundSessionId) {
                      if (currentSessionId === boundSessionId) {
                        currentSessionId = null;
                      }
                      cleanupAuthState(connectionTimeout);
                      return;
                    }
                    session.expirationInProgress = true;

                    let tmuxProbe: "found" | "missing" | "unknown" | null =
                      null;
                    if (
                      channelExit &&
                      session.managedTmux &&
                      session.sshConn &&
                      session.tmuxSessionName
                    ) {
                      tmuxProbe = await probeTmuxSession(
                        session.sshConn,
                        session.tmuxSessionName,
                        2_000,
                      );
                    }

                    const disposition = decideTerminalChannelClose(
                      channelExit,
                      session.managedTmux,
                      tmuxProbe,
                    );
                    if (disposition.deleteRecoveryRecord) {
                      await createCurrentWebTerminalSessionRepository().deleteOwned(
                        session.userId,
                        session.id,
                      );
                      session.pinned = false;
                      session.managedTmux = false;
                    }

                    if (disposition.kind === "session-ended") {
                      sessionManager.broadcast(boundSessionId, {
                        type: "session_ended",
                        code: channelExit?.code ?? null,
                        signal: channelExit?.signal,
                      });
                    } else {
                      sessionManager.broadcast(boundSessionId, {
                        type: "disconnected",
                        message: "Connection lost",
                        graceful: false,
                      });
                    }

                    sessionManager.destroySession(boundSessionId);
                    if (currentSessionId === boundSessionId) {
                      currentSessionId = null;
                    }
                    cleanupAuthState(connectionTimeout);
                  },
                  (error) => {
                    sshLogger.error(
                      "Failed to finalize SSH shell channel closure",
                      error,
                      {
                        operation: "terminal_shell_close_error",
                        sessionId: boundSessionId,
                        userId,
                        hostId: id,
                      },
                    );
                    if (boundSessionId) {
                      const session = sessionManager.getSession(boundSessionId);
                      if (session) {
                        sessionManager.broadcast(boundSessionId, {
                          type: "disconnected",
                          message: "Connection lost",
                          graceful: false,
                        });
                        sessionManager.destroySession(boundSessionId);
                      }
                      if (currentSessionId === boundSessionId) {
                        currentSessionId = null;
                      }
                    }
                    cleanupAuthState(connectionTimeout);
                  },
                );
              });

              stream.on("error", (err: Error) => {
                sshLogger.error("SSH stream error", err, {
                  operation: "ssh_stream",
                  hostId: id,
                  ip,
                  port,
                  username,
                });
                const session = sessionManager.getSession(boundSessionId);
                if (session) {
                  sessionManager.broadcast(boundSessionId!, {
                    type: "error",
                    message: "SSH stream error: " + err.message,
                  });
                }
              });

              const autoTmux = hostConfig.terminalConfig?.autoTmux === true;

              const resolvePinnedStartupPayload =
                createTerminalStartupPayloadResolver(
                  hostConfig.terminalConfig,
                  async (snippetId) => {
                    const owned =
                      await createCurrentSnippetRepository().findOwnedById(
                        userId,
                        snippetId,
                      );
                    if (owned) return owned.content;

                    const roleIds =
                      await createCurrentRoleRepository().listUserRoleIds(
                        userId,
                      );
                    const shared =
                      await createCurrentRbacAccessRepository().findAccessibleSharedSnippet(
                        snippetId,
                        userId,
                        roleIds,
                      );
                    return shared?.content ?? null;
                  },
                );

              const getStartupPayload = () =>
                data.pinned
                  ? resolvePinnedStartupPayload()
                  : Promise.resolve({ startupInput, startupMoshCommand });

              let initialPathCommand: string | undefined;
              if (initialPath?.trim()) {
                if (isWindowsSftpPath(initialPath)) {
                  const winPath = sftpPathToLocalPath(initialPath);
                  const escaped = winPath.replace(/"/g, '""');
                  initialPathCommand = `cd "${escaped}"\r`;
                } else {
                  initialPathCommand = `cd "${initialPath.replace(/"/g, '\\"')}"\r`;
                }
              }

              // 固定窗口确认完成前不发送任何启动内容；确认后按统一顺序写入。
              const runPostShellCommands = async (
                delay: number,
                isPinRequestActive: () => boolean = () => true,
              ): Promise<void> => {
                const resolvedStartup = await getStartupPayload();
                if (!isPinRequestActive()) return;
                return runTerminalStartupSequence({
                  startupInput: resolvedStartup.startupInput,
                  initialPathCommand,
                  executeCommand,
                  startupMoshCommand: resolvedStartup.startupMoshCommand,
                  initialDelayMs: delay,
                  isActive: () =>
                    Boolean(
                      isPinRequestActive() &&
                      boundSessionId &&
                      sessionManager.getSession(boundSessionId) &&
                      !stream.destroyed,
                    ),
                  write: (input) => {
                    if (!boundSessionId) return;
                    sessionManager.bufferInput(boundSessionId, input);
                    stream.write(input);
                  },
                });
              };

              const runPostShellCommandsDetached = (delay = 0): void => {
                void runPostShellCommands(delay).catch(() => {
                  sshLogger.warn(
                    "Terminal startup sequence could not be written",
                    {
                      operation: "terminal_startup_write_failed",
                      sessionId: boundSessionId,
                      hostId: id,
                    },
                  );
                });
              };

              if (recoveryRecord && conn) {
                // 仅确认窗口存在还不够：必须看到本次 SSH 客户端数量增加，
                // 才能证明交互 Shell 真正进入了受管 tmux。否则不能把连接标记为固定。
                const previousAttachedClients = await probeTmuxAttachedClients(
                  conn,
                  recoveryRecord.tmuxName,
                  2_000,
                );
                if (previousAttachedClients === null) {
                  ws.send(
                    JSON.stringify({
                      type: "sessionRecoveryDeferred",
                      sessionId: recoveryRecord.id,
                      code: "TMUX_SESSION_ATTACH_PROBE_UNAVAILABLE",
                      message:
                        "The remote fixed window could not be verified before attach. Its recovery record was kept.",
                    }),
                  );
                  sessionManager.finishPinTransition(boundSessionId);
                  sessionManager.destroySession(recoveryRecord.id);
                  currentSessionId = null;
                  try {
                    conn.end();
                  } catch {
                    // 连接可能已经由远端关闭。
                  }
                  cleanupAuthState(connectionTimeout);
                  ws.close(
                    1013,
                    "Fixed window attach verification unavailable",
                  );
                  return;
                }
                attachOrCreateTmuxSession(stream, recoveryRecord.tmuxName);
                const attached = await waitForTmuxAttachedClient(
                  conn,
                  recoveryRecord.tmuxName,
                  previousAttachedClients,
                  5_000,
                );
                if (!attached) {
                  ws.send(
                    JSON.stringify({
                      type: "sessionRecoveryDeferred",
                      sessionId: recoveryRecord.id,
                      code: "TMUX_SESSION_ATTACH_NOT_CONFIRMED",
                      message:
                        "The SSH shell did not attach to the managed tmux window. Its recovery record was kept.",
                    }),
                  );
                  sessionManager.finishPinTransition(boundSessionId);
                  sessionManager.destroySession(recoveryRecord.id);
                  currentSessionId = null;
                  try {
                    conn.end();
                  } catch {
                    // 连接可能已经由远端关闭。
                  }
                  cleanupAuthState(connectionTimeout);
                  ws.close(1013, "Fixed window attach was not confirmed");
                  return;
                }
                const recovered = sessionManager.getSession(boundSessionId);
                if (recovered) {
                  recovered.tmuxSessionName = recoveryRecord.tmuxName;
                  recovered.pinned = true;
                  recovered.managedTmux = true;
                  recovered.tmuxCreatedByCloudSsh = true;
                }
                const recoveredAttachment =
                  sessionManager.finishRecoveryAndAttachWs(
                    boundSessionId!,
                    userId,
                    ws,
                    recoveryRecord.tabInstanceId,
                  );
                if (!recoveredAttachment) {
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(
                      JSON.stringify({
                        type: "sessionRecoveryDeferred",
                        sessionId: recoveryRecord.id,
                        code: "RECOVERY_ATTACHMENT_FAILED",
                        message:
                          "The fixed window was restored, but this browser could not attach. Its recovery record was kept.",
                      }),
                    );
                  }
                  sessionManager.finishPinTransition(boundSessionId!);
                  sessionManager.destroySession(recoveryRecord.id);
                  currentSessionId = null;
                  cleanupAuthState(connectionTimeout);
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.close(1013, "Fixed window browser attachment failed");
                  }
                  return;
                }
                ws.send(
                  JSON.stringify({
                    type: "sessionPinned",
                    sessionId: recoveryRecord.id,
                    pinned: true,
                    recovered: true,
                    tmuxSessionName: recoveryRecord.tmuxName,
                  }),
                );
                completeOwnedSessionAttachment(recoveredAttachment, {
                  sessionId: recoveryRecord.id,
                  hostId: recoveryRecord.hostId,
                  cols: data.cols,
                  rows: data.rows,
                  tabInstanceId: recoveryRecord.tabInstanceId,
                });
                ws.send(
                  JSON.stringify({
                    type: "tmux_session_attached",
                    sessionName: recoveryRecord.tmuxName,
                  }),
                );
              } else if (data.pinned && conn) {
                if (!boundSessionId) {
                  throw new Error("Managed terminal session is unavailable");
                }
                const startupSession =
                  sessionManager.getSession(boundSessionId);
                if (!startupSession) {
                  throw new Error("Managed terminal session is unavailable");
                }

                // 连接时固定与手动固定使用同一个两阶段选择流程。先等待用户
                // 选择平台保活或远端 tmux，再执行路径、脚本和 Mosh 等启动输入。
                startupPinSessionId = boundSessionId;
                deferredPinnedStartup = {
                  sessionId: boundSessionId,
                  runPostShellCommands: (isPinRequestActive) =>
                    runPostShellCommands(0, isPinRequestActive),
                };
                sendSessionPinModeChoice(startupSession, true);
              } else if (tmuxAttachSession && conn) {
                // Agent 会话必须确认远端窗口仍然存在，避免把附着失败降级成
                // 一个看似成功的普通 Shell；tmux monitor 的旧路径仍跳过探测。
                if (data.agentSessionId) {
                  const agentTmuxState = await probeTmuxSession(
                    conn,
                    tmuxAttachSession,
                    2_000,
                  );
                  if (agentTmuxState !== "found") {
                    if (ws.readyState === WebSocket.OPEN) {
                      ws.send(
                        JSON.stringify({
                          type: "error",
                          code: "AGENT_SESSION_REMOTE_NOT_FOUND",
                          message: "Agent 远端会话暂时不可用，请稍后重试",
                        }),
                      );
                      ws.send(
                        JSON.stringify({
                          type: "sessionExpired",
                          sessionId: boundSessionId,
                          code: "AGENT_SESSION_REMOTE_NOT_FOUND",
                        }),
                      );
                    }
                    if (boundSessionId) {
                      sessionManager.destroySession(boundSessionId);
                      currentSessionId = null;
                    }
                    try {
                      stream.end();
                      conn.end();
                    } catch {
                      // 连接可能已经在探测期间关闭。
                    }
                    cleanupAuthState(connectionTimeout);
                    return;
                  }
                }
                // Direct attach (tmux monitor / Agent): reuse the same path as
                // the manual tmux attach websocket message.
                attachOrCreateTmuxSession(stream, tmuxAttachSession);
                {
                  const session = sessionManager.getSession(boundSessionId);
                  if (session) session.tmuxSessionName = tmuxAttachSession;
                }
                if (data.agentSessionId) {
                  if (!boundSessionId) {
                    throw Object.assign(
                      new Error("Agent 会话没有可绑定的本地终端"),
                      { code: "AGENT_SESSION_BINDING_MISSING" },
                    );
                  }
                  bindAgentAttachmentToLocalTerminal(
                    data.agentSessionId,
                    boundSessionId,
                    id,
                    hostConfig.projectHostId,
                  );
                }
                sshLogger.info("Attached to requested tmux session", {
                  operation: "tmux_direct_attach",
                  sessionName: tmuxAttachSession,
                  hostId: id,
                });
                ws.send(
                  JSON.stringify({
                    type: "tmux_session_attached",
                    sessionName: data.agentSessionId ? null : tmuxAttachSession,
                    agentSessionId: data.agentSessionId ?? null,
                  }),
                );
              } else if (autoTmux && conn) {
                (async () => {
                  try {
                    const detection = await detectTmux(conn);
                    if (!detection.available) {
                      sshLogger.warn("tmux not found on remote host", {
                        operation: "tmux_detection",
                        hostId: id,
                      });
                      ws.send(
                        JSON.stringify({
                          type: "tmux_unavailable",
                          message:
                            "tmux is not installed on the remote host. Falling back to standard shell.",
                        }),
                      );
                      runPostShellCommandsDetached();
                    } else {
                      // Agent 窗口只能从经过项目权限校验的专用入口打开；普通
                      // auto-tmux 选择器既不能展示内部名称，也不能附着它们。
                      const selectableSessions = hideAgentManagedTmuxSessions(
                        detection.sessions,
                        id,
                      );
                      if (selectableSessions.length === 0) {
                        const newName = `termix-${id}-${Date.now().toString(36).slice(-4)}`;
                        attachOrCreateTmuxSession(stream, undefined, newName);
                        const confirmed = await waitForTmuxSession(
                          conn,
                          newName,
                        );
                        const session =
                          sessionManager.getSession(boundSessionId);
                        if (session) {
                          session.tmuxSessionName = confirmed;
                          session.tmuxCreatedByCloudSsh = true;
                        }
                        sshLogger.info("Created new tmux session", {
                          operation: "tmux_new_session",
                          sessionName: confirmed,
                          hostId: id,
                        });
                        ws.send(
                          JSON.stringify({
                            type: "tmux_session_created",
                            sessionName: confirmed,
                          }),
                        );
                        runPostShellCommandsDetached();
                      } else {
                        sshLogger.info(
                          "Multiple tmux sessions found, sending list to frontend",
                          {
                            operation: "tmux_sessions_available",
                            sessions: selectableSessions,
                            hostId: id,
                          },
                        );
                        ws.send(
                          JSON.stringify({
                            type: "tmux_sessions_available",
                            sessions: selectableSessions,
                          }),
                        );
                        // Commands deferred until user picks a session
                      }
                    }
                  } catch (error) {
                    sshLogger.error("tmux detection failed", error, {
                      operation: "tmux_detection_error",
                      hostId: id,
                    });
                    // Fallback: run commands in plain shell
                    runPostShellCommandsDetached();
                  }
                })();
              } else {
                // No tmux -- run commands directly as before
                runPostShellCommandsDetached();
              }

              if (!recoveryRecord && !data.pinned) {
                sendTerminalConnected();
              }

              if (recoveryRecord && fixedRecoveryLockId === recoveryRecord.id) {
                const recoveredSession = sessionManager.getSession(
                  recoveryRecord.id,
                );
                void logAudit({
                  userId,
                  username: userId,
                  action: "web_terminal_recover",
                  resourceType: "terminal_session",
                  resourceId: recoveryRecord.id,
                  resourceName: recoveredSession?.hostName,
                  details: JSON.stringify({
                    hostId: recoveryRecord.hostId,
                    projectHostId: recoveryRecord.projectHostId ?? null,
                  }),
                  ipAddress: req.socket.remoteAddress ?? "",
                  userAgent: req.headers["user-agent"] ?? "",
                  success: true,
                });
                fixedSessionRecoveryCoordinator.finish(
                  recoveryRecord.id,
                  userId,
                );
                fixedRecoveryLockId = null;
              }

              if (id && hostConfig.userId) {
                triggerLoginAlert(
                  id,
                  hostConfig.userId,
                  username,
                  req.socket.remoteAddress ?? "unknown",
                ).catch(() => {});
              }

              if (id && hostConfig.userId) {
                (async () => {
                  try {
                    const host =
                      await createCurrentHostResolutionRepository().findHostById(
                        id,
                        hostConfig.userId!,
                      );

                    const hostName =
                      host?.userId === hostConfig.userId && host.name
                        ? host.name
                        : `${username}@${ip}:${port}`;

                    await axios.post(
                      "http://localhost:30006/activity/log",
                      {
                        type: "terminal",
                        hostId: id,
                        hostName,
                      },
                      {
                        headers: {
                          Authorization: `Bearer ${await authManager.generateJWTToken(hostConfig.userId!)}`,
                        },
                      },
                    );
                  } catch (error) {
                    sshLogger.warn("Failed to log terminal activity", {
                      operation: "activity_log_error",
                      userId: hostConfig.userId,
                      hostId: id,
                      error:
                        error instanceof Error
                          ? error.message
                          : "Unknown error",
                    });
                  }
                })();
              }
            }, handleSshReadyWorkflowError);
          },
        );
      }, handleSshReadyWorkflowError);
    });

    sshConn.on("error", (err: Error) => {
      clearTimeout(connectionTimeout);

      sendLog("error", "error", `Connection error: ${err.message}`);

      sshLogger.error("SSH connection error", err, {
        operation: "ssh_connect",
        hostId: id,
        ip,
        port,
        username,
        authType: resolvedCredentials.authType,
        warpgateAuthPromptSent,
        isKeyboardInteractive,
        hasKeyboardInteractiveFinish: !!keyboardInteractiveFinish,
        keyboardInteractiveResponded,
      });

      if (isShellClosureInProgress) {
        return;
      }

      if (
        resolvedCredentials.authType === "opkssh" &&
        err.message.includes("All configured authentication methods failed")
      ) {
        sshLogger.warn("OPKSSH authentication failed - invalidating token", {
          operation: "opkssh_auth_failed",
          hostId: id,
          userId,
          error: err.message,
        });

        (async () => {
          try {
            const { invalidateOPKSSHToken } = await import("../opkssh-auth.js");
            await invalidateOPKSSHToken(userId, id, "SSH auth failed");
          } catch (invalidateError) {
            sshLogger.error("Failed to invalidate OPKSSH token", {
              operation: "opkssh_token_invalidation_error",
              userId,
              hostId: id,
              error: invalidateError,
            });
          }
        })();

        if (currentSessionId) {
          sessionManager.destroySession(currentSessionId);
          currentSessionId = null;
        }
        cleanupAuthState(connectionTimeout);

        sendLog(
          "auth",
          "error",
          "OPKSSH certificate authentication failed. Please authenticate again.",
        );

        ws.send(
          JSON.stringify({
            type: "opkssh_auth_required",
            hostId: id,
            message:
              "OPKSSH authentication failed or expired. Please authenticate again.",
          }),
        );
        return;
      }

      if (
        resolvedCredentials.authType === "vault" &&
        err.message.includes("All configured authentication methods failed")
      ) {
        sshLogger.warn("Vault certificate authentication failed", {
          operation: "vault_auth_failed",
          hostId: id,
          userId,
          error: err.message,
        });

        (async () => {
          try {
            const profileId = (
              resolvedHostData?.vaultProfile as { id?: number } | undefined
            )?.id;
            if (profileId) {
              const { deleteVaultCert } =
                await import("../vault-signer-auth.js");
              await deleteVaultCert(userId, profileId);
            }
          } catch (invalidateError) {
            sshLogger.error("Failed to invalidate Vault certificate", {
              operation: "vault_cert_invalidation_error",
              userId,
              hostId: id,
              error: invalidateError,
            });
          }
        })();

        if (currentSessionId) {
          sessionManager.destroySession(currentSessionId);
          currentSessionId = null;
        }
        cleanupAuthState(connectionTimeout);

        sendLog(
          "auth",
          "error",
          "Vault certificate authentication failed. Please authenticate again.",
        );

        ws.send(
          JSON.stringify({
            type: "vault_auth_required",
            hostId: id,
            message:
              "Vault authentication failed or expired. Please authenticate again.",
          }),
        );
        return;
      }

      if (
        err.message.includes("Cannot parse privateKey") &&
        err.message.includes("no passphrase")
      ) {
        sendLog(
          "auth",
          "error",
          "SSH key is encrypted but no passphrase was provided",
        );
        isAwaitingAuthCredentials = true;
        if (currentSessionId) {
          sessionManager.destroySession(currentSessionId);
          currentSessionId = null;
        }
        cleanupAuthState(connectionTimeout);
        ws.send(
          JSON.stringify({
            type: "passphrase_required",
            message:
              "The SSH key is encrypted. Please enter the passphrase to unlock it.",
          }),
        );
        return;
      }

      if (
        resolvedCredentials.authType === "tailscale" &&
        (authMethodNotAvailable ||
          err.message.includes("All configured authentication methods failed"))
      ) {
        sendLog(
          "auth",
          "error",
          `Tailscale SSH authentication failed for user "${username}". Ensure Tailscale is running on the server, SSH is advertised (tailscale set --ssh), and your ACL policy grants the "${username}" user to your identity (check tailscale.com/s/ssh for the check/action ACL syntax). If your Tailscale identity maps to a different Unix user, update the username on this host.`,
        );
        if (currentSessionId) {
          sessionManager.destroySession(currentSessionId);
          currentSessionId = null;
        }
        cleanupAuthState(connectionTimeout);
        ws.send(
          JSON.stringify({
            type: "error",
            message: `Tailscale SSH authentication failed for user "${username}". Ensure Tailscale is running on the server, SSH is advertised (tailscale set --ssh), and your ACL policy grants the "${username}" user to your identity. If your Tailscale identity maps to a different Unix user, update the username on this host.`,
          }),
        );
        return;
      }

      if (
        authMethodNotAvailable &&
        resolvedCredentials.authType === "none" &&
        !isKeyboardInteractive
      ) {
        sendLog(
          "auth",
          "error",
          "Server does not support keyboard-interactive authentication",
        );
        isAwaitingAuthCredentials = true;
        if (currentSessionId) {
          sessionManager.destroySession(currentSessionId);
          currentSessionId = null;
        }
        cleanupAuthState(connectionTimeout);
        ws.send(
          JSON.stringify({
            type: "auth_method_not_available",
            message:
              "The server does not support keyboard-interactive authentication. Please provide credentials.",
          }),
        );
        return;
      }

      if (
        resolvedCredentials.authType === "none" &&
        err.message.includes("All configured authentication methods failed") &&
        !isKeyboardInteractive &&
        !keyboardInteractiveResponded
      ) {
        isAwaitingAuthCredentials = true;
        if (currentSessionId) {
          sessionManager.destroySession(currentSessionId);
          currentSessionId = null;
        }
        cleanupAuthState(connectionTimeout);
        ws.send(
          JSON.stringify({
            type: "auth_method_not_available",
            message:
              "The server does not support keyboard-interactive authentication. Please provide credentials.",
          }),
        );
        return;
      }

      if (
        isKeyboardInteractive &&
        keyboardInteractiveFinish &&
        err.message.includes("All configured authentication methods failed")
      ) {
        sshLogger.warn(
          "Authentication error during keyboard-interactive - SKIPPING cleanup, waiting for user response",
          {
            operation: "ssh_error_during_keyboard_interactive_skip_cleanup",
            hostId: id,
            error: err.message,
          },
        );
        resetConnectionState();
        return;
      }

      sshLogger.error("Proceeding with cleanup after error", {
        operation: "ssh_error_cleanup",
        hostId: id,
        error: err.message,
      });

      if (
        err.message.includes("authentication") ||
        err.message.includes("Authentication")
      ) {
        authLogger.error("SSH authentication failed", err, {
          operation: "terminal_ssh_auth_failed",
          sessionId,
          userId,
          hostId: id,
          authType: resolvedCredentials.authType,
        });
        sendLog("auth", "error", `Authentication failed: ${err.message}`);
      } else {
        sendLog("error", "error", `Connection failed: ${err.message}`);
      }

      let errorMessage = "SSH error: " + err.message;
      if (err.message.includes("No matching key exchange algorithm")) {
        errorMessage =
          "SSH error: No compatible key exchange algorithm found. This may be due to an older SSH server or network device.";
      } else if (err.message.includes("No matching cipher")) {
        errorMessage =
          "SSH error: No compatible cipher found. This may be due to an older SSH server or network device.";
      } else if (err.message.includes("No matching MAC")) {
        errorMessage =
          "SSH error: No compatible MAC algorithm found. This may be due to an older SSH server or network device.";
      } else if (
        err.message.includes("ENOTFOUND") ||
        err.message.includes("ENOENT")
      ) {
        errorMessage =
          "SSH error: Could not resolve hostname or connect to server.";
      } else if (err.message.includes("ECONNREFUSED")) {
        errorMessage =
          "SSH error: Connection refused. The server may not be running or the port may be incorrect.";
      } else if (err.message.includes("ENETUNREACH")) {
        const isIPv6 = ip && ip.includes(":");
        errorMessage = isIPv6
          ? "SSH error: Network unreachable. IPv6 may not be available in this environment. If running in Docker, enable IPv6 in the Docker daemon and network configuration."
          : "SSH error: Network unreachable. Check your network configuration and routing.";
      } else if (err.message.includes("ETIMEDOUT")) {
        errorMessage =
          "SSH error: Connection timed out. Check your network connection and server availability.";
      } else if (
        err.message.includes("ECONNRESET") ||
        err.message.includes("EPIPE")
      ) {
        errorMessage =
          "SSH error: Connection was reset. This may be due to network issues or server timeout.";
      } else if (
        err.message.includes("authentication failed") ||
        err.message.includes("Permission denied")
      ) {
        errorMessage =
          "SSH error: Authentication failed. Please check your username and password/key.";
      }

      ws.send(JSON.stringify({ type: "error", message: errorMessage }));
      if (currentSessionId) {
        sessionManager.destroySession(currentSessionId);
        currentSessionId = null;
      }
      cleanupAuthState(connectionTimeout);
    });

    sshConn.on("close", () => {
      clearTimeout(connectionTimeout);
      sshLogger.info("SSH connection closed", {
        operation: "terminal_ssh_disconnected",
        sessionId,
        userId,
        hostId: id,
      });

      if (isDuplicateConnDiscarded) {
        cleanupAuthState(connectionTimeout);
        return;
      }

      if (isShellClosureInProgress) {
        return;
      }

      if (isAwaitingAuthCredentials) {
        if (currentSessionId) {
          sessionManager.destroySession(currentSessionId);
          currentSessionId = null;
        }
        cleanupAuthState(connectionTimeout);
        return;
      }

      if (isShellInitializing || (isConnected && !sshStream)) {
        sshLogger.warn("SSH connection closed during shell initialization", {
          operation: "ssh_close_during_init",
          hostId: id,
          ip,
          port,
          username,
          isShellInitializing,
          hasStream: !!sshStream,
        });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "error",
              message:
                "Connection closed during shell initialization. The server may have rejected the shell request.",
            }),
          );
        }
      } else {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "disconnected",
              message: "Connection closed",
            }),
          );
        }
      }
      if (currentSessionId) {
        sessionManager.destroySession(currentSessionId);
        currentSessionId = null;
      }
      cleanupAuthState(connectionTimeout);
    });

    const sshAuthManager = new SSHAuthManager({
      userId,
      ws,
      hostId: id || 0,
      isKeyboardInteractive,
      keyboardInteractiveResponded,
      keyboardInteractiveFinish,
      totpPromptSent,
      warpgateAuthPromptSent,
      totpTimeout,
      warpgateAuthTimeout,
      totpAttempts: 0,
    });

    sshConn.on(
      "keyboard-interactive",
      (
        name: string,
        instructions: string,
        instructionsLang: string,
        prompts: Array<{ prompt: string; echo: boolean }>,
        finish: (responses: string[]) => void,
      ) => {
        if (connectionTimeout) {
          clearTimeout(connectionTimeout);
        }

        sshAuthManager.handleKeyboardInteractive(
          name,
          instructions,
          instructionsLang,
          prompts,
          finish,
          resolvedCredentials as unknown as Parameters<
            typeof sshAuthManager.handleKeyboardInteractive
          >[5],
          hostConfig,
        );

        isKeyboardInteractive = sshAuthManager.context.isKeyboardInteractive;
        keyboardInteractiveResponded =
          sshAuthManager.context.keyboardInteractiveResponded;
        keyboardInteractiveFinish =
          sshAuthManager.context.keyboardInteractiveFinish;
        totpPromptSent = sshAuthManager.context.totpPromptSent;
        warpgateAuthPromptSent = sshAuthManager.context.warpgateAuthPromptSent;
        totpTimeout = sshAuthManager.context.totpTimeout;
        warpgateAuthTimeout = sshAuthManager.context.warpgateAuthTimeout;
      },
    );

    const hostKeepaliveInterval = hostConfig.terminalConfig?.keepaliveInterval;
    const hostKeepaliveCountMax = hostConfig.terminalConfig?.keepaliveCountMax;

    // Pre-fetch the stored host key before connect so the verifier callback
    // runs synchronously during SSH key exchange, avoiding LoginGraceTime
    // expiry on slow connections (especially through jump host tunnels).
    const preloadedHostData = await SSHHostKeyVerifier.preloadHostData(id);

    const connectConfig: Record<string, unknown> = {
      host: connectHost,
      port,
      username,
      tryKeyboard: resolvedCredentials.authType !== "tailscale",
      keepaliveInterval:
        typeof hostKeepaliveInterval === "number"
          ? Math.max(5000, hostKeepaliveInterval * 1000)
          : 30000,
      keepaliveCountMax:
        typeof hostKeepaliveCountMax === "number"
          ? Math.max(1, hostKeepaliveCountMax)
          : 5,
      readyTimeout: 120000,
      tcpKeepAlive: true,
      tcpKeepAliveInitialDelay: 30000,
      timeout: 120000,
      hostVerifier: await SSHHostKeyVerifier.createHostVerifier(
        id,
        ip,
        port,
        ws,
        userId,
        false,
        preloadedHostData,
      ),
      env: {
        TERM: "xterm-256color",
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        LC_CTYPE: "en_US.UTF-8",
        LC_MESSAGES: "en_US.UTF-8",
        LC_MONETARY: "en_US.UTF-8",
        LC_NUMERIC: "en_US.UTF-8",
        LC_TIME: "en_US.UTF-8",
        LC_COLLATE: "en_US.UTF-8",
        COLORTERM: "truecolor",
      },
      algorithms: buildSSHAlgorithms(
        hostConfig.terminalConfig?.allowLegacyAlgorithms !== false,
      ),
    };

    if (
      resolvedCredentials.authType === "none" ||
      resolvedCredentials.authType === "tailscale"
    ) {
      // Tailscale SSH and "none": no static credentials needed
    } else if (resolvedCredentials.authType === "password") {
      if (!resolvedCredentials.password) {
        sshLogger.error(
          "Password authentication requested but no password provided",
        );
        ws.send(
          JSON.stringify({
            type: "error",
            message:
              "Password authentication requested but no password provided",
          }),
        );
        return;
      }

      if (!hostConfig.forceKeyboardInteractive) {
        connectConfig.password = resolvedCredentials.password;
      }
      sendLog("auth", "info", "Using password authentication");
    } else if (
      resolvedCredentials.authType === "key" &&
      resolvedCredentials.key
    ) {
      sendLog("auth", "info", "Using SSH key authentication");
      try {
        connectConfig.privateKey = preparePrivateKeyForSSH2(
          resolvedCredentials.key,
          resolvedCredentials.keyPassword,
        );

        if (resolvedCredentials.keyPassword) {
          connectConfig.passphrase = resolvedCredentials.keyPassword;
        }

        if (resolvedCredentials.password) {
          connectConfig.password = resolvedCredentials.password;
        }

        // Apply CA-signed certificate if one is stored in the credential
        if (
          resolvedCredentials.certPublicKey &&
          resolvedCredentials.certPublicKey.trim()
        ) {
          try {
            const { setupCACertAuth } = await import("../opkssh-cert-auth.js");
            await setupCACertAuth(
              connectConfig,
              sshConn,
              connectConfig.privateKey as Buffer,
              resolvedCredentials.certPublicKey,
              username,
              resolvedCredentials.keyPassword,
            );
            sendLog("auth", "info", "CA certificate authentication configured");
            sshLogger.info("CA cert auth configured", {
              operation: "ca_cert_auth_configured",
              userId,
              hostId: id,
            });
          } catch (certError) {
            sendLog(
              "auth",
              "warning",
              "CA certificate setup failed – falling back to key-only auth",
            );
            sshLogger.warn("CA cert auth setup failed", {
              operation: "ca_cert_auth_setup_failed",
              userId,
              hostId: id,
              error:
                certError instanceof Error
                  ? certError.message
                  : String(certError),
            });
          }
        }
      } catch (keyError) {
        const message =
          keyError instanceof Error
            ? keyError.message
            : "Invalid private key format";
        sshLogger.error("SSH key format error: " + message);
        ws.send(
          JSON.stringify({
            type: "error",
            message: `SSH key format error: ${message}`,
          }),
        );
        return;
      }
    } else if (resolvedCredentials.authType === "key") {
      sendLog(
        "auth",
        "error",
        "SSH key authentication requested but no key provided",
      );
      sshLogger.error("SSH key authentication requested but no key provided");
      ws.send(
        JSON.stringify({
          type: "error",
          message: "SSH key authentication requested but no key provided",
        }),
      );
      return;
    } else if (resolvedCredentials.authType === "opkssh") {
      sendLog("auth", "info", "Using OPKSSH certificate authentication");
      try {
        const { getOPKSSHToken } = await import("../opkssh-auth.js");
        const token = await getOPKSSHToken(userId, id);

        if (!token) {
          sendLog(
            "auth",
            "info",
            "No valid OPKSSH token found, requesting authentication",
          );
          ws.send(
            JSON.stringify({
              type: "opkssh_auth_required",
              hostId: id,
            }),
          );
          return;
        }

        sendLog("auth", "info", "Using cached OPKSSH certificate");

        const { setupOPKSSHCertAuth } = await import("../opkssh-cert-auth.js");
        await setupOPKSSHCertAuth(connectConfig, sshConn, token, username);
      } catch (opksshError) {
        sshLogger.error("OPKSSH authentication error", opksshError, {
          operation: "opkssh_auth_error",
          userId,
          hostId: id,
        });
        ws.send(
          JSON.stringify({
            type: "error",
            message:
              "OPKSSH authentication failed: " +
              (opksshError instanceof Error
                ? opksshError.message
                : "Unknown error"),
          }),
        );
        return;
      }
    } else if (resolvedCredentials.authType === "vault") {
      sendLog("auth", "info", "Using Vault SSH signer authentication");
      try {
        const vaultProfile = resolvedHostData?.vaultProfile as
          | { id: number }
          | undefined;
        if (!vaultProfile?.id) {
          throw new Error("Host has no Vault signer profile configured");
        }

        const { getVaultCert } = await import("../vault-signer-auth.js");
        const cert = await getVaultCert(userId, vaultProfile.id);

        if (!cert) {
          sendLog(
            "auth",
            "info",
            "No valid Vault certificate found, requesting authentication",
          );
          ws.send(
            JSON.stringify({
              type: "vault_auth_required",
              hostId: id,
            }),
          );
          return;
        }

        sendLog("auth", "info", "Using cached Vault-signed certificate");

        const { setupOPKSSHCertAuth } = await import("../opkssh-cert-auth.js");
        await setupOPKSSHCertAuth(
          connectConfig,
          sshConn,
          { privateKey: cert.privateKey, sshCert: cert.sshCert },
          username,
        );
      } catch (vaultError) {
        sshLogger.error("Vault SSH signer authentication error", vaultError, {
          operation: "vault_auth_error",
          userId,
          hostId: id,
        });
        ws.send(
          JSON.stringify({
            type: "error",
            message:
              "Vault SSH signer authentication failed: " +
              (vaultError instanceof Error
                ? vaultError.message
                : "Unknown error"),
          }),
        );
        return;
      }
    } else if (resolvedCredentials.authType === "agent") {
      sendLog("auth", "info", "Using SSH agent authentication");
      const result = await resolveAgentSocket(
        hostConfig.terminalConfig as Record<string, unknown> | undefined,
      );
      if ("error" in result) {
        ws.send(JSON.stringify({ type: "error", message: result.error }));
        return;
      }
      const { createAgent } = ssh2Pkg;
      connectConfig.agent = createAgent(result.socketPath);
      sendLog(
        "auth",
        "info",
        `SSH agent configured (socket: ${result.socketPath})`,
      );
    } else {
      sendLog("auth", "info", "Using keyboard-interactive authentication");
      sshLogger.error("No valid authentication method provided");
      ws.send(
        JSON.stringify({
          type: "error",
          message: "No valid authentication method provided",
        }),
      );
      return;
    }

    if (hostConfig.terminalConfig?.agentForwarding) {
      if (connectConfig.privateKey) {
        try {
          const parsed = ssh2Utils.parseKey(
            connectConfig.privateKey as Buffer,
            connectConfig.passphrase as string | undefined,
          );
          if (parsed && !(parsed instanceof Error)) {
            connectConfig.agent = new MemoryAgent(parsed);
            connectConfig.agentForward = true;
            sendLog("auth", "info", "SSH agent forwarding enabled");
          }
        } catch {
          sshLogger.warn("Failed to set up agent forwarding", {
            operation: "agent_forward_setup",
            hostId: id,
          });
        }
      } else if (
        resolvedCredentials.authType === "agent" &&
        connectConfig.agent
      ) {
        connectConfig.agentForward = true;
        sendLog(
          "auth",
          "info",
          "SSH agent forwarding enabled (external agent)",
        );
      }
    }

    if (
      hostConfig.portKnockSequence &&
      hostConfig.portKnockSequence.length > 0
    ) {
      try {
        sshLogger.info(
          `Port knocking ${hostConfig.ip} (${hostConfig.portKnockSequence.length} ports)`,
          { operation: "port_knock", hostId: hostConfig.id },
        );
        await performPortKnocking(hostConfig.ip, hostConfig.portKnockSequence);
      } catch {
        sshLogger.warn("Port knocking failed, attempting connection anyway", {
          operation: "port_knock",
          hostId: hostConfig.id,
        });
      }
    }

    const proxyConfig: SOCKS5Config | null =
      hostConfig.useSocks5 &&
      (hostConfig.socks5Host ||
        (hostConfig.socks5ProxyChain &&
          (hostConfig.socks5ProxyChain as ProxyNode[]).length > 0))
        ? {
            useSocks5: hostConfig.useSocks5,
            socks5Host: hostConfig.socks5Host,
            socks5Port: hostConfig.socks5Port,
            socks5Username: hostConfig.socks5Username,
            socks5Password: hostConfig.socks5Password,
            socks5ProxyChain: hostConfig.socks5ProxyChain as ProxyNode[],
          }
        : null;

    const hasJumpHosts =
      hostConfig.jumpHosts &&
      hostConfig.jumpHosts.length > 0 &&
      hostConfig.userId;

    // Cloudflare Tunnel: connect via WebSocket proxy
    const cfConfig = hostConfig.terminalConfig as
      | Record<string, unknown>
      | undefined;
    if (cfConfig?.cfAccessClientId && cfConfig?.cfAccessClientSecret) {
      try {
        const WebSocket = (await import("ws")).default;
        const cfHostname = (cfConfig.cfTunnelHostname as string) || ip;
        const wsUrl = `wss://${cfHostname}/cdn-cgi/access/ssh-connect`;
        const cfWs = new WebSocket(wsUrl, {
          headers: {
            "CF-Access-Client-Id": cfConfig.cfAccessClientId as string,
            "CF-Access-Client-Secret": cfConfig.cfAccessClientSecret as string,
          },
        });

        await new Promise<void>((resolve, reject) => {
          cfWs.on("open", () => resolve());
          cfWs.on("error", (err) => reject(err));
          setTimeout(
            () => reject(new Error("Cloudflare tunnel timeout")),
            30000,
          );
        });

        const { Duplex } = await import("stream");
        const duplexStream = new Duplex({
          read() {},
          write(chunk, _encoding, callback) {
            cfWs.send(chunk, callback);
          },
        });
        cfWs.on("message", (data) => duplexStream.push(data));
        cfWs.on("close", () => duplexStream.push(null));

        connectConfig.sock =
          duplexStream as unknown as typeof connectConfig.sock;
        sendLog("handshake", "info", "Connected via Cloudflare Tunnel");
      } catch (cfError) {
        sshLogger.error("Cloudflare tunnel connection failed", cfError, {
          operation: "cf_tunnel_connect",
          hostId: id,
        });
        ws.send(
          JSON.stringify({
            type: "error",
            message:
              "Cloudflare tunnel connection failed: " +
              (cfError instanceof Error ? cfError.message : "Unknown error"),
          }),
        );
        cleanupAuthState(connectionTimeout);
        return;
      }
    }

    if (hasJumpHosts) {
      try {
        const jumpClient = await createJumpHostChain(
          hostConfig.jumpHosts!,
          hostConfig.userId!,
          proxyConfig,
        );

        if (!jumpClient) {
          sshLogger.error("Failed to establish jump host chain");
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Failed to connect through jump hosts",
            }),
          );
          if (currentSessionId) {
            sessionManager.destroySession(currentSessionId);
            currentSessionId = null;
          }
          cleanupAuthState(connectionTimeout);
          return;
        }
        lastJumpClient = jumpClient;

        jumpClient.forwardOut("127.0.0.1", 0, ip, port, (err, stream) => {
          if (err) {
            sshLogger.error("Failed to forward through jump host", err, {
              operation: "ssh_jump_forward",
              hostId: id,
              ip,
              port,
            });
            ws.send(
              JSON.stringify({
                type: "error",
                message: "Failed to forward through jump host: " + err.message,
              }),
            );
            jumpClient.end();
            if (currentSessionId) {
              sessionManager.destroySession(currentSessionId);
              currentSessionId = null;
            }
            cleanupAuthState(connectionTimeout);
            return;
          }

          connectConfig.sock = stream;
          sendLog(
            "handshake",
            "info",
            "Starting SSH session through jump host" +
              (proxyConfig ? " (via proxy)" : ""),
          );
          sendLog("auth", "info", `Authenticating as ${username}`);
          sshLogger.info("Initiating SSH connection", {
            operation: "terminal_ssh_connect_attempt",
            sessionId,
            userId,
            hostId: id,
            ip,
            port,
            username,
            authType: resolvedCredentials.authType,
            viaProxy: !!proxyConfig,
          });
          sshConn.connect(connectConfig);
        });
      } catch (error) {
        sshLogger.error("Jump host error", error, {
          operation: "ssh_jump_host",
          hostId: id,
        });
        ws.send(
          JSON.stringify({
            type: "error",
            message: "Failed to connect through jump hosts",
          }),
        );
        if (currentSessionId) {
          sessionManager.destroySession(currentSessionId);
          currentSessionId = null;
        }
        cleanupAuthState(connectionTimeout);
        return;
      }
    } else if (proxyConfig) {
      try {
        const proxySocket = await createSocks5Connection(ip, port, proxyConfig);
        if (proxySocket) {
          connectConfig.sock = proxySocket;
        }
      } catch (proxyError) {
        sshLogger.error("Proxy connection failed", proxyError, {
          operation: "proxy_connect",
          hostId: id,
          proxyHost: hostConfig.socks5Host,
          proxyPort: hostConfig.socks5Port || 1080,
        });
        ws.send(
          JSON.stringify({
            type: "error",
            message:
              "Proxy connection failed: " +
              (proxyError instanceof Error
                ? proxyError.message
                : "Unknown error"),
          }),
        );
        if (currentSessionId) {
          sessionManager.destroySession(currentSessionId);
          currentSessionId = null;
        }
        cleanupAuthState(connectionTimeout);
        return;
      }
      sendLog("handshake", "info", "Starting SSH session (via proxy)");
      sendLog("auth", "info", `Authenticating as ${username}`);
      sshLogger.info("Initiating SSH connection", {
        operation: "terminal_ssh_connect_attempt",
        sessionId,
        userId,
        hostId: id,
        ip,
        port,
        username,
        authType: resolvedCredentials.authType,
        viaProxy: true,
      });
      sshConn.connect(connectConfig);
    } else {
      sendLog("handshake", "info", "Starting SSH session");
      sendLog("auth", "info", `Authenticating as ${username}`);

      sshLogger.info("Initiating SSH connection", {
        operation: "terminal_ssh_connect_attempt",
        sessionId,
        userId,
        hostId: id,
        ip,
        port,
        username,
        authType: resolvedCredentials.authType,
      });
      sshConn.connect(connectConfig);
    }
  }

  function handleResize(data: ResizeData) {
    const resizeStream =
      sessionManager.getSession(currentSessionId)?.sshStream ?? sshStream;
    if (resizeStream && resizeStream.setWindow) {
      resizeStream.setWindow(data.rows, data.cols, data.rows, data.cols);
      const session = sessionManager.getSession(currentSessionId);
      if (session) {
        session.cols = data.cols;
        session.rows = data.rows;
        sessionManager.bufferResize(session.id, data.cols, data.rows);
      }
      ws.send(
        JSON.stringify({ type: "resized", cols: data.cols, rows: data.rows }),
      );
    }
  }

  function cleanupAuthState(timeoutId?: NodeJS.Timeout) {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    if (totpTimeout) {
      clearTimeout(totpTimeout);
      totpTimeout = null;
    }

    if (warpgateAuthTimeout) {
      clearTimeout(warpgateAuthTimeout);
      warpgateAuthTimeout = null;
    }

    if (fixedRecoveryLockId) {
      fixedSessionRecoveryCoordinator.finish(fixedRecoveryLockId, userId);
      fixedRecoveryLockId = null;
    }

    if (agentAttachContext && !isAwaitingAuthCredentials) {
      releaseCurrentBrowserAgentAttachment();
    }

    sshStream = null;
    sshConn = null;
    lastJumpClient = null;

    resetConnectionState();
    isCleaningUp = false;
    isAwaitingAuthCredentials = false;
  }

  // Note: PTY-level keepalive (writing \x00 to the stream) was removed.
  // It was causing ^@ characters to appear in terminals with echoctl enabled.
  // SSH-level keepalive is configured via connectConfig (keepaliveInterval,
  // keepaliveCountMax, tcpKeepAlive), which handles connection health monitoring
  // without producing visible output on the terminal.
  //
  // See: https://github.com/Termix-SSH/Support/issues/232
  // See: https://github.com/Termix-SSH/Support/issues/309
});
