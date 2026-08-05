import { type Client, type ClientChannel } from "ssh2";
import { WebSocket } from "ws";
import fs from "fs";
import path from "path";
import { sshLogger } from "../../utils/logger.js";
import {
  getCurrentSettingValue,
  createCurrentOpenTabRepository,
  createCurrentSessionRecordingRepository,
  createCurrentWebTerminalSessionRepository,
} from "../../database/repositories/factory.js";
import { PermissionManager } from "../../utils/permission-manager.js";
import { killTmuxSession } from "../tmux/helper.js";
import { terminalSessionLifecycleCoordinator } from "./session-lifecycle-coordinator.js";

const MAX_BUFFER_BYTES = 512 * 1024;
const DATA_DIR = process.env.DATA_DIR ?? "./db/data";
const SESSION_LOGS_DIR = path.join(DATA_DIR, "session_logs");
const DEFAULT_TIMEOUT_MINUTES = 1440;
const HEALTH_CHECK_INTERVAL_MS = 60_000;
// 内存中的活动/断线保留 SSH 上限。达到上限时拒绝新建，不能静默
// 终止仍在管理员保留窗口内的旧任务；离线固定 tmux 记录另有独立上限。
const MAX_SESSIONS_PER_USER = 10;

export interface SessionParticipant {
  ws: WebSocket;
  userId: string | null; // null for anonymous link guests
  permissionLevel: "read-write" | "read-only";
  isOwner: boolean;
  guestLabel?: string;
  tabInstanceId?: string;
  joinedViaShareId?: string;
  accessRevoked?: boolean;
}

export interface TerminalSession {
  id: string;
  userId: string;
  hostId: number;
  hostName: string;
  projectHostId?: number;
  /** Agent 持续会话的来源标识；网页附着时只作审计/UI 标记。 */
  agentSessionId?: string;
  tabInstanceId?: string;
  attachedTabInstanceId?: string;

  sshConn: Client | null;
  sshStream: ClientChannel | null;
  jumpClient: Client | null;

  cols: number;
  rows: number;
  isConnected: boolean;
  createdAt: number;

  participants: Map<string, SessionParticipant>;
  writeLeaseParticipantId: string | null;
  lastDetachedAt: number | null;
  retentionExpiresAt: number | null;
  detachTimeout: NodeJS.Timeout | null;

  outputBuffer: string[];
  outputBufferBytes: number;
  hasShellInput: boolean;
  recordingPath: string | null;
  recordingHeader: string | null;
  recordingBytes: number;
  recordingId: number | null;
  recordingWriteChain: Promise<void>;
  recordingPersistChain: Promise<void>;
  tmuxSessionName: string | null;
  recoveryTargetFingerprint: string | null;
  pinned: boolean;
  managedTmux: boolean;
  pinTransitionActive: boolean;
  expirationInProgress: boolean;
  sessionLoggingEnabled: boolean;
  sessionStartedAt: number;
  lastPersistedBytes: number;
  terminatedByOwner: boolean;
  terminationReason: string | null;
  /** 当前 tmux 是否由 CloudSSH 在本次会话中创建，可安全升级为受管固定窗口。 */
  tmuxCreatedByCloudSsh: boolean;
}

export interface CreateTerminalSessionOptions {
  projectHostId?: number;
  sessionId?: string;
  pinned?: boolean;
  tmuxSessionName?: string | null;
  recoveryTargetFingerprint?: string | null;
  recovering?: boolean;
  agentSessionId?: string;
}

export interface TerminalSessionFilter {
  hostId?: number;
  hostIds?: readonly number[];
  projectHostId?: number;
  projectHostIds?: readonly number[];
  userId?: string;
  userIds?: readonly string[];
  pinned?: boolean;
}

export class TerminalSessionTransitionError extends Error {
  readonly code = "TERMINAL_SESSION_TRANSITION_IN_PROGRESS";

  constructor() {
    super("Pinned window operation is still in progress");
    this.name = "TerminalSessionTransitionError";
  }
}

export class TerminalSessionUnmanagedTmuxError extends Error {
  readonly code = "TERMINAL_SESSION_UNMANAGED_TMUX";

  constructor() {
    super("An existing tmux session cannot be converted into a pinned window");
    this.name = "TerminalSessionUnmanagedTmuxError";
  }
}

export function resolveTerminalSessionTimeoutMinutes(
  rawValue: string | null | undefined,
): number {
  const minutes = rawValue ? Number.parseInt(rawValue, 10) : Number.NaN;
  return Number.isSafeInteger(minutes) && minutes >= 1 && minutes <= 10080
    ? minutes
    : DEFAULT_TIMEOUT_MINUTES;
}

export interface TerminalChannelExitDetails {
  code: number | null;
  signal?: string;
  coreDumped?: boolean;
  description?: string;
}

export type TerminalChannelCloseDisposition =
  | { kind: "session-ended"; deleteRecoveryRecord: boolean }
  | { kind: "recoverable-disconnect"; deleteRecoveryRecord: false };

/**
 * SSH channel 的 close 事件本身不包含退出码。只有先观察到 exit，才可认定
 * 远端 Shell 主动结束；固定窗口还必须确认 tmux 已不存在后才能删除恢复记录。
 */
export function decideTerminalChannelClose(
  exit: TerminalChannelExitDetails | null,
  managedTmux: boolean,
  tmuxProbe: "found" | "missing" | "unknown" | null,
): TerminalChannelCloseDisposition {
  if (!exit) {
    return { kind: "recoverable-disconnect", deleteRecoveryRecord: false };
  }
  if (!managedTmux) {
    return { kind: "session-ended", deleteRecoveryRecord: false };
  }
  if (tmuxProbe === "missing") {
    return { kind: "session-ended", deleteRecoveryRecord: true };
  }
  return { kind: "recoverable-disconnect", deleteRecoveryRecord: false };
}

/** 将 exit 状态保存到随后的 close，避免误把 close 的空参数当成退出码。 */
export function bindTerminalChannelLifecycle(
  stream: Pick<ClientChannel, "on">,
  onClose: (exit: TerminalChannelExitDetails | null) => void,
): void {
  let exit: TerminalChannelExitDetails | null = null;
  stream.on("exit", (code: number | null, signal?: string) => {
    exit = { code, signal };
  });
  stream.on("close", () => onClose(exit));
}

/** EventEmitter 不会等待异步监听器；统一封装以避免拒绝升级为进程级异常。 */
export function runGuardedTerminalTask(
  task: () => Promise<void>,
  onError: (error: unknown) => void,
): void {
  void Promise.resolve()
    .then(task)
    .catch((error) => {
      try {
        onError(error);
      } catch {
        // 错误处理本身不得再制造未处理 Promise。
      }
    });
}

export type TerminalRecoveryRecordStatus = "retained" | "missing" | "unknown";

/** 查询失败时按“可能仍保留”处理，调用方不得误报 sessionExpired。 */
export async function inspectTerminalRecoveryRecord(
  lookup: () => Promise<unknown | null>,
  onError?: (error: unknown) => void,
): Promise<TerminalRecoveryRecordStatus> {
  try {
    return (await lookup()) ? "retained" : "missing";
  } catch (error) {
    try {
      onError?.(error);
    } catch {
      // 状态查询失败仍必须稳定返回 unknown。
    }
    return "unknown";
  }
}

/** Message types a non-owner participant may legally send. */
const NON_OWNER_ALLOWED_MESSAGE_TYPES = new Set([
  "input",
  "ping",
  "disconnect",
]);

/**
 * WebSocket 消息的基础权限门禁。共享参与者即使拥有 read-write，输入仍需
 * 额外通过会话级写入租约检查；这里保持为纯函数以独立测试只读隔离。
 */
export function isMessageAllowedForParticipant(
  participant: Pick<
    SessionParticipant,
    "isOwner" | "permissionLevel" | "accessRevoked"
  > | null,
  messageType: string,
): boolean {
  if (!participant || participant.isOwner) return true;
  if (participant.accessRevoked) return false;
  if (!NON_OWNER_ALLOWED_MESSAGE_TYPES.has(messageType)) return false;
  if (messageType === "input" && participant.permissionLevel === "read-only") {
    return false;
  }
  return true;
}

class TerminalSessionManager {
  private static instance: TerminalSessionManager;
  private sessions = new Map<string, TerminalSession>();
  private terminationOperations = new Map<string, Promise<boolean>>();
  private pinReservationsByUser = new Map<string, number>();
  private healthCheckTimer: NodeJS.Timeout | null = null;

  private constructor() {
    this.healthCheckTimer = setInterval(
      () => this.healthCheck(),
      HEALTH_CHECK_INTERVAL_MS,
    );
  }

  static getInstance(): TerminalSessionManager {
    if (!TerminalSessionManager.instance) {
      TerminalSessionManager.instance = new TerminalSessionManager();
    }
    return TerminalSessionManager.instance;
  }

  createSession(
    userId: string,
    hostId: number,
    hostName: string,
    cols: number,
    rows: number,
    tabInstanceId?: string,
    sessionLoggingEnabled = true,
    options: CreateTerminalSessionOptions = {},
  ): string {
    terminalSessionLifecycleCoordinator.assertSessionCreationAllowed({
      hostIds: [hostId],
      projectHostIds:
        options.projectHostId === undefined ? [] : [options.projectHostId],
      userIds: [userId],
    });

    if (options.sessionId) {
      const existingById = this.sessions.get(options.sessionId);
      if (existingById) {
        if (existingById.userId !== userId) {
          throw new Error("Terminal session is not available");
        }
        return existingById.id;
      }
    }

    const userSessions = this.getUserSessions(userId);
    if (tabInstanceId) {
      const tabSessions = userSessions.filter(
        (s) => s.tabInstanceId === tabInstanceId,
      );
      for (const existing of tabSessions) {
        const isLiveSession =
          existing.isConnected &&
          existing.sshStream != null &&
          !existing.sshStream.destroyed;
        if (isLiveSession) {
          // Don't destroy a live session (even if detached) — the caller should attach instead
          sshLogger.warn(
            "Tab instance has live session, skipping duplicate create",
            {
              operation: "session_tab_duplicate_skip",
              existingSessionId: existing.id,
              tabInstanceId,
              hasAttachedWs: this.getOwnerParticipant(existing) !== null,
            },
          );
          return existing.id;
        }
        sshLogger.warn("Tab instance already has session, destroying old", {
          operation: "session_tab_duplicate_cleanup",
          existingSessionId: existing.id,
          tabInstanceId,
        });
        this.destroySession(existing.id);
      }
    }

    const currentSessions = this.getUserSessions(userId);
    if (currentSessions.length >= MAX_SESSIONS_PER_USER) {
      throw new Error(
        `Terminal session limit reached (${MAX_SESSIONS_PER_USER}); close an existing session before starting another`,
      );
    }

    const id = options.sessionId ?? crypto.randomUUID();
    const now = Date.now();
    let recordingPath: string | null = null;
    let recordingHeader: string | null = null;
    if (sessionLoggingEnabled) {
      const userLogDir = path.join(SESSION_LOGS_DIR, userId);
      const recordingFileName = options.sessionId
        ? `${id}-${now}.cast`
        : `${id}.cast`;
      recordingPath = path.join(userLogDir, recordingFileName);
      recordingHeader = `${JSON.stringify({
        version: 2,
        width: cols,
        height: rows,
        timestamp: Math.floor(now / 1000),
        env: { TERM: "xterm-256color", SHELL: "/bin/sh" },
      })}\n`;
    }
    const session: TerminalSession = {
      id,
      userId,
      hostId,
      hostName,
      projectHostId: options.projectHostId,
      agentSessionId: options.agentSessionId,
      tabInstanceId,
      sshConn: null,
      sshStream: null,
      jumpClient: null,
      cols,
      rows,
      isConnected: false,
      createdAt: now,
      participants: new Map(),
      writeLeaseParticipantId: null,
      lastDetachedAt: null,
      retentionExpiresAt: null,
      detachTimeout: null,
      outputBuffer: [],
      outputBufferBytes: 0,
      hasShellInput: false,
      recordingPath,
      recordingHeader,
      recordingBytes: 0,
      recordingId: null,
      recordingWriteChain: Promise.resolve(),
      recordingPersistChain: Promise.resolve(),
      tmuxSessionName: options.tmuxSessionName ?? null,
      recoveryTargetFingerprint: options.recoveryTargetFingerprint ?? null,
      pinned: options.pinned === true,
      managedTmux: options.pinned === true,
      pinTransitionActive: options.recovering === true,
      expirationInProgress: false,
      sessionLoggingEnabled,
      sessionStartedAt: now,
      lastPersistedBytes: 0,
      terminatedByOwner: false,
      terminationReason: null,
      tmuxCreatedByCloudSsh: options.pinned === true,
    };
    this.sessions.set(id, session);

    sshLogger.info("Terminal session created", {
      operation: "session_created",
      sessionId: id,
      userId,
      hostId,
    });

    return id;
  }

  beginPinTransition(sessionId: string, userId: string): TerminalSession {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId || !session.isConnected) {
      throw new Error("Terminal session is not available");
    }
    if (session.expirationInProgress) {
      throw new Error("Terminal session is closing");
    }
    if (session.pinTransitionActive) {
      throw new Error("Pinned window operation is already in progress");
    }
    session.pinTransitionActive = true;
    return session;
  }

  isPinTransitionActive(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.pinTransitionActive === true;
  }

  finishPinTransition(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session?.pinTransitionActive) return;
    session.pinTransitionActive = false;
  }

  finishRecoveryAndAttachWs(
    sessionId: string,
    userId: string,
    ws: WebSocket,
    tabInstanceId?: string,
  ): TerminalSession | null {
    const session = this.sessions.get(sessionId);
    if (
      !session ||
      session.userId !== userId ||
      !session.pinTransitionActive ||
      !session.pinned
    ) {
      return null;
    }
    session.pinTransitionActive = false;
    return this.attachWs(sessionId, userId, ws, tabInstanceId);
  }

  async pinSession(
    sessionId: string,
    userId: string,
    tmuxSessionName: string,
  ): Promise<TerminalSession> {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId || !session.isConnected) {
      throw new Error("Terminal session is not available");
    }
    if (!session.tabInstanceId) {
      throw new Error("Terminal tab identity is required for persistence");
    }
    if (!tmuxSessionName) {
      throw new Error("Managed tmux session was not created");
    }
    if (
      session.tmuxSessionName &&
      !session.managedTmux &&
      !session.tmuxCreatedByCloudSsh
    ) {
      throw new TerminalSessionUnmanagedTmuxError();
    }
    if (!session.recoveryTargetFingerprint) {
      throw new Error("Terminal recovery target is unavailable");
    }

    return terminalSessionLifecycleCoordinator.runSessionMutation(
      {
        hostIds: [session.hostId],
        projectHostIds:
          session.projectHostId === undefined ? [] : [session.projectHostId],
        userIds: [userId],
      },
      async () => {
        const current = this.sessions.get(sessionId);
        if (current !== session || !session.isConnected) {
          throw new Error("Terminal session is not available");
        }
        const access = await PermissionManager.getInstance().canAccessHost(
          userId,
          session.hostId,
          "connect",
          session.projectHostId,
        );
        if (!access.hasAccess) {
          throw new Error("Terminal host access is no longer available");
        }
        if (
          session.projectHostId === undefined &&
          access.projectHostId !== undefined &&
          !access.isOwner &&
          !access.isAdminBypass
        ) {
          throw new Error(
            "Terminal project host context is required for persistence",
          );
        }
        return this.persistPinnedSession(session, userId, tmuxSessionName);
      },
    );
  }

  /**
   * 仅由 CloudSSH 进程维持 SSH 的固定窗口。它不创建远端 tmux，也不写入
   * 恢复表，因此平台重启或 SSH 断线后不会被误报为可恢复会话。
   */
  async pinPlatformSession(
    sessionId: string,
    userId: string,
  ): Promise<TerminalSession> {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId || !session.isConnected) {
      throw new Error("Terminal session is not available");
    }
    return terminalSessionLifecycleCoordinator.runSessionMutation(
      {
        hostIds: [session.hostId],
        projectHostIds:
          session.projectHostId === undefined ? [] : [session.projectHostId],
        userIds: [userId],
      },
      async () => {
        const current = this.sessions.get(sessionId);
        if (current !== session || !session.isConnected) {
          throw new Error("Terminal session is not available");
        }
        const access = await PermissionManager.getInstance().canAccessHost(
          userId,
          session.hostId,
          "connect",
          session.projectHostId,
        );
        if (!access.hasAccess) {
          throw new Error("Terminal host access is no longer available");
        }
        if (session.detachTimeout) {
          clearTimeout(session.detachTimeout);
          session.detachTimeout = null;
        }
        session.pinned = true;
        session.managedTmux = false;
        session.retentionExpiresAt = null;
        return session;
      },
    );
  }

  /**
   * 平台保活固定尚未向客户端确认时若后续步骤失败，恢复为普通保留窗口。
   * 若浏览器已断开，则重新挂上普通窗口的断开保留计时器。
   */
  rollbackPlatformPin(sessionId: string, userId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (
      !session ||
      session.userId !== userId ||
      !session.pinned ||
      session.managedTmux
    ) {
      return false;
    }

    session.pinned = false;
    if (this.hasOpenParticipant(session)) {
      session.lastDetachedAt = null;
      session.retentionExpiresAt = null;
    } else {
      this.startDetachedRetention(session);
    }
    return true;
  }

  private async persistPinnedSession(
    session: TerminalSession,
    userId: string,
    tmuxSessionName: string,
  ): Promise<TerminalSession> {
    const repository = createCurrentWebTerminalSessionRepository();
    const existing = await repository.findOwned(userId, session.id);
    let reservedSlot = false;
    if (!existing) {
      const fixedSessions = await repository.listOwned(userId);
      const reservations = this.pinReservationsByUser.get(userId) ?? 0;
      if (fixedSessions.length + reservations >= MAX_SESSIONS_PER_USER) {
        throw new Error(
          `Pinned terminal limit reached (${MAX_SESSIONS_PER_USER})`,
        );
      }
      this.pinReservationsByUser.set(userId, reservations + 1);
      reservedSlot = true;
    }

    const now = new Date().toISOString();
    try {
      await repository.upsert(
        {
          id: session.id,
          userId: session.userId,
          hostId: session.hostId,
          projectHostId: session.projectHostId ?? null,
          tabInstanceId: session.tabInstanceId,
          tmuxName: tmuxSessionName,
          targetFingerprint: session.recoveryTargetFingerprint,
          columns: session.cols,
          rows: session.rows,
          createdAt: new Date(session.createdAt).toISOString(),
          lastAttachedAt: now,
          lastDetachedAt: null,
        },
        now,
      );
    } finally {
      if (reservedSlot) {
        const reservations = this.pinReservationsByUser.get(userId) ?? 1;
        if (reservations <= 1) this.pinReservationsByUser.delete(userId);
        else this.pinReservationsByUser.set(userId, reservations - 1);
      }
    }

    session.tmuxSessionName = tmuxSessionName;
    session.tmuxCreatedByCloudSsh = true;
    session.pinned = true;
    session.managedTmux = true;
    if (session.detachTimeout) {
      clearTimeout(session.detachTimeout);
      session.detachTimeout = null;
    }
    session.retentionExpiresAt = null;
    return session;
  }

  /**
   * 已存在的 CloudSSH 临时 tmux 在升级固定失败时，只撤销恢复记录和固定状态，
   * 不结束用户仍在使用的远端窗口。
   */
  async rollbackManagedPin(
    sessionId: string,
    userId: string,
  ): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId || !session.managedTmux) {
      return false;
    }

    await createCurrentWebTerminalSessionRepository().deleteOwned(
      userId,
      sessionId,
    );
    session.pinned = false;
    session.managedTmux = false;
    if (this.hasOpenParticipant(session)) {
      session.lastDetachedAt = null;
      session.retentionExpiresAt = null;
    } else {
      this.startDetachedRetention(session);
    }
    return true;
  }

  /**
   * 新建受管 tmux 已确认终止后的固定回滚。清除远端窗口标识，并在浏览器
   * 已断开时恢复普通会话的保留计时器，避免留下永久占用额度的隐藏 SSH。
   */
  rollbackKilledManagedPin(sessionId: string, userId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId || !session.managedTmux) {
      return false;
    }

    session.pinned = false;
    session.managedTmux = false;
    session.tmuxSessionName = null;
    session.tmuxCreatedByCloudSsh = false;
    if (this.hasOpenParticipant(session)) {
      session.lastDetachedAt = null;
      session.retentionExpiresAt = null;
    } else {
      this.startDetachedRetention(session);
    }
    return true;
  }

  async terminateSession(sessionId: string, userId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId) return false;
    if (session.pinTransitionActive) {
      throw new TerminalSessionTransitionError();
    }

    const existingOperation = this.terminationOperations.get(sessionId);
    if (existingOperation) return existingOperation;

    const operation = Promise.resolve().then(() =>
      this.performTerminateSession(sessionId, userId),
    );
    this.terminationOperations.set(sessionId, operation);
    try {
      return await operation;
    } finally {
      if (this.terminationOperations.get(sessionId) === operation) {
        this.terminationOperations.delete(sessionId);
      }
    }
  }

  private async performTerminateSession(
    sessionId: string,
    userId: string,
  ): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId) return false;
    if (session.pinTransitionActive) {
      throw new TerminalSessionTransitionError();
    }

    if (session.managedTmux && session.sshConn && session.tmuxSessionName) {
      const terminated = await killTmuxSession(
        session.sshConn,
        session.tmuxSessionName,
      );
      if (!terminated) {
        throw new Error("Remote managed tmux session could not be terminated");
      }
    }
    if (session.managedTmux) {
      await createCurrentWebTerminalSessionRepository().deleteOwned(
        userId,
        sessionId,
      );
    }

    session.pinned = false;
    session.managedTmux = false;
    session.tmuxCreatedByCloudSsh = false;
    this.destroySession(sessionId);
    return true;
  }

  async terminatePinnedSession(
    sessionId: string,
    userId: string,
  ): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId || !session.pinned) return false;
    if (session.managedTmux && (!session.sshConn || !session.tmuxSessionName)) {
      throw new Error(
        "Pinned terminal is not connected; restore it before closing",
      );
    }

    return this.terminateSession(sessionId, userId);
  }

  getSession(sessionId: string | null): TerminalSession | null {
    if (!sessionId) return null;
    return this.sessions.get(sessionId) ?? null;
  }

  setSSHState(
    sessionId: string,
    conn: Client,
    stream: ClientChannel,
    jumpClient?: Client | null,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.sshConn = conn;
    session.sshStream = stream;
    session.jumpClient = jumpClient ?? null;
    session.isConnected = true;
  }

  /** Finds the owner's participant entry, if currently attached. */
  private getOwnerParticipant(
    session: TerminalSession,
  ): SessionParticipant | null {
    for (const participant of session.participants.values()) {
      if (participant.isOwner) return participant;
    }
    return null;
  }

  private getOwnerEntry(
    session: TerminalSession,
  ): [string, SessionParticipant] | null {
    for (const entry of session.participants.entries()) {
      if (entry[1].isOwner) return entry;
    }
    return null;
  }

  private hasOpenParticipant(session: TerminalSession): boolean {
    return Array.from(session.participants.values()).some(
      (participant) =>
        !participant.accessRevoked &&
        participant.ws.readyState === WebSocket.OPEN,
    );
  }

  private clearDetachedExpiration(session: TerminalSession): void {
    if (session.detachTimeout) {
      clearTimeout(session.detachTimeout);
      session.detachTimeout = null;
    }
    session.lastDetachedAt = null;
    session.retentionExpiresAt = null;
  }

  /**
   * 重新选出唯一写入者。在线 owner 始终优先；owner 离线时按加入顺序
   * 将租约交给首个仍在线且保有读写权限的共享参与者。
   */
  private reconcileWriteLease(session: TerminalSession): void {
    const isOpen = (participant: SessionParticipant) =>
      !participant.accessRevoked &&
      participant.ws.readyState === WebSocket.OPEN;

    for (const [participantId, participant] of session.participants) {
      if (participant.isOwner && isOpen(participant)) {
        session.writeLeaseParticipantId = participantId;
        return;
      }
    }

    const currentLease = session.writeLeaseParticipantId
      ? session.participants.get(session.writeLeaseParticipantId)
      : null;
    if (
      currentLease &&
      !currentLease.isOwner &&
      currentLease.permissionLevel === "read-write" &&
      isOpen(currentLease)
    ) {
      return;
    }

    session.writeLeaseParticipantId = null;
    for (const [participantId, participant] of session.participants) {
      if (
        !participant.isOwner &&
        participant.permissionLevel === "read-write" &&
        isOpen(participant)
      ) {
        session.writeLeaseParticipantId = participantId;
        return;
      }
    }
  }

  canWriteToSession(sessionId: string, ws: WebSocket): boolean {
    const session = this.sessions.get(sessionId);
    if (
      !session ||
      session.pinTransitionActive ||
      session.expirationInProgress
    ) {
      return false;
    }

    this.reconcileWriteLease(session);
    for (const [participantId, participant] of session.participants) {
      if (participant.ws !== ws) continue;
      if (
        participant.accessRevoked ||
        participant.ws.readyState !== WebSocket.OPEN
      ) {
        return false;
      }
      return (
        session.writeLeaseParticipantId === participantId &&
        (participant.isOwner || participant.permissionLevel === "read-write")
      );
    }
    return false;
  }

  updateSharedParticipantPermission(
    sessionId: string,
    ws: WebSocket,
    permissionLevel: "read-write" | "read-only",
  ): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const participant = this.getParticipantForWs(session, ws);
    if (!participant || participant.isOwner || participant.accessRevoked) {
      return false;
    }
    participant.permissionLevel = permissionLevel;
    this.reconcileWriteLease(session);
    return true;
  }

  attachWs(
    sessionId: string,
    userId: string,
    ws: WebSocket,
    tabInstanceId?: string,
  ): TerminalSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      sshLogger.warn("Session not found for attachment", {
        operation: "session_attach_not_found",
        sessionId,
        userId,
      });
      return null;
    }
    if (ws.readyState !== WebSocket.OPEN) {
      sshLogger.warn("WebSocket is not open for session attachment", {
        operation: "session_attach_socket_closed",
        sessionId,
        userId,
      });
      return null;
    }
    if (session.pinTransitionActive) {
      sshLogger.warn("Session pin or recovery transition is in progress", {
        operation: "session_attach_pin_transition",
        sessionId,
        userId,
      });
      return null;
    }
    if (session.userId !== userId) {
      sshLogger.warn("Session userId mismatch", {
        operation: "session_attach_user_mismatch",
        sessionId,
        expectedUserId: session.userId,
        providedUserId: userId,
      });
      return null;
    }
    if (!session.isConnected) {
      sshLogger.warn("Session not connected", {
        operation: "session_attach_not_connected",
        sessionId,
        userId,
        createdAt: session.createdAt,
        elapsed: Date.now() - session.createdAt,
      });
      return null;
    }
    if (session.expirationInProgress) {
      sshLogger.warn("Session expiration is already in progress", {
        operation: "session_attach_expiring",
        sessionId,
        userId,
      });
      return null;
    }

    const ownerParticipant = this.getOwnerParticipant(session);
    const isDetached =
      !ownerParticipant || ownerParticipant.ws.readyState !== WebSocket.OPEN;
    const isOriginalTab =
      (session.attachedTabInstanceId ?? session.tabInstanceId) ===
      tabInstanceId;

    if (
      !isDetached &&
      !isOriginalTab &&
      session.tabInstanceId &&
      tabInstanceId
    ) {
      sshLogger.warn("Session actively attached to different tab instance", {
        operation: "session_attach_instance_conflict",
        sessionId,
        sessionInstanceId: session.tabInstanceId,
        providedInstanceId: tabInstanceId,
      });
      try {
        ws.send(
          JSON.stringify({
            type: "sessionExpired",
            sessionId,
            message: "Session belongs to a different tab instance",
          }),
        );
      } catch {
        /* ignore */
      }
      return null;
    }

    if (
      session.tabInstanceId &&
      tabInstanceId &&
      session.tabInstanceId !== tabInstanceId
    ) {
      sshLogger.info(
        "Session attached to different tab instance (split-screen)",
        {
          operation: "session_attach_split_screen",
          originalInstanceId: session.tabInstanceId,
          newInstanceId: tabInstanceId,
          sessionId,
        },
      );
    }

    const ownerEntry = this.getOwnerEntry(session);
    if (ownerEntry && ownerEntry[1].ws !== ws) {
      try {
        ownerEntry[1].ws.send(
          JSON.stringify({
            type: "sessionTakenOver",
            sessionId,
            message: "Session was attached from another tab",
          }),
        );
        ownerEntry[1].ws.close(4009, "Session taken over");
      } catch {
        /* ignore */
      }
      session.participants.delete(ownerEntry[0]);
    }

    this.clearDetachedExpiration(session);

    const participantId = crypto.randomUUID();
    session.participants.set(participantId, {
      ws,
      userId,
      permissionLevel: "read-write",
      isOwner: true,
      tabInstanceId,
    });
    this.reconcileWriteLease(session);
    session.attachedTabInstanceId = tabInstanceId;
    this.touchOpenTab(session);

    if (session.managedTmux) {
      session.retentionExpiresAt = null;
      void createCurrentWebTerminalSessionRepository()
        .markAttached(userId, session.id, session.cols, session.rows)
        .catch((error) => {
          sshLogger.warn("Failed to persist pinned session attachment", {
            operation: "session_pin_attach_persist_error",
            sessionId: session.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }

    sshLogger.info("WebSocket attached to session", {
      operation: "session_attach",
      sessionId,
      userId,
      tabInstanceId,
    });

    return session;
  }

  /**
   * Adds a non-owner participant (in-app share join or anonymous link guest).
   * Purely additive - never evicts the owner or any other participant.
   */
  joinAsParticipant(
    sessionId: string,
    ws: WebSocket,
    opts: {
      userId: string | null;
      permissionLevel: "read-write" | "read-only";
      guestLabel?: string;
      tabInstanceId?: string;
      shareId?: string;
    },
  ): TerminalSession | null {
    const session = this.sessions.get(sessionId);
    if (
      !session ||
      !session.isConnected ||
      session.expirationInProgress ||
      ws.readyState !== WebSocket.OPEN
    ) {
      return null;
    }

    const participantId = crypto.randomUUID();
    session.participants.set(participantId, {
      ws,
      userId: opts.userId,
      permissionLevel: opts.permissionLevel,
      isOwner: false,
      guestLabel: opts.guestLabel,
      tabInstanceId: opts.tabInstanceId,
      joinedViaShareId: opts.shareId,
    });
    this.clearDetachedExpiration(session);
    this.reconcileWriteLease(session);

    sshLogger.info("Participant joined shared session", {
      operation: "session_join_participant",
      sessionId,
      userId: opts.userId,
      permissionLevel: opts.permissionLevel,
      shareId: opts.shareId,
    });

    return session;
  }

  /** Fans out a message to every OPEN participant socket; skips closed ones and send failures. */
  broadcast(sessionId: string, message: object): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const payload = JSON.stringify(message);
    for (const participant of session.participants.values()) {
      if (participant.accessRevoked) continue;
      if (participant.ws.readyState !== WebSocket.OPEN) continue;
      try {
        participant.ws.send(payload);
      } catch {
        /* ignore individual send failures, keep broadcasting to the rest */
      }
    }
  }

  /** Finds the participant entry (owner or not) for a given socket. */
  getParticipantForWs(
    session: TerminalSession,
    ws: WebSocket,
  ): SessionParticipant | null {
    for (const participant of session.participants.values()) {
      if (participant.ws === ws) return participant;
    }
    return null;
  }

  /**
   * 移除共享参与者。访客离开不会主动结束会话；仅当其是最后一个在线参与者时，
   * 才从此刻开始普通会话的断线保留计时。
   */
  removeParticipant(sessionId: string, ws: WebSocket): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const [id, participant] of session.participants.entries()) {
      if (participant.ws === ws && !participant.isOwner) {
        session.participants.delete(id);
        this.reconcileWriteLease(session);
        if (!this.hasOpenParticipant(session)) {
          this.startDetachedRetention(session);
        }
        sshLogger.info("Participant left shared session", {
          operation: "session_leave_participant",
          sessionId,
          userId: participant.userId,
        });
        return;
      }
    }
  }

  evictSharedParticipant(
    sessionId: string,
    ws: WebSocket,
    reason: string,
    code = "SESSION_SHARE_REVOKED",
  ): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    for (const [participantId, participant] of session.participants) {
      if (participant.ws !== ws) continue;
      if (participant.isOwner || participant.accessRevoked) return false;
      this.revokeSharedParticipant(
        session,
        participantId,
        participant,
        reason,
        code,
      );
      return true;
    }
    return false;
  }

  evictSharedParticipants(
    sessionId: string,
    reason: string,
    code = "SESSION_SHARE_REVOKED",
  ): number {
    const session = this.sessions.get(sessionId);
    if (!session) return 0;
    let evicted = 0;
    for (const [participantId, participant] of session.participants) {
      if (participant.isOwner || participant.accessRevoked) continue;
      this.revokeSharedParticipant(
        session,
        participantId,
        participant,
        reason,
        code,
      );
      evicted += 1;
    }
    return evicted;
  }

  evictSharedParticipantsForShare(
    sessionId: string,
    shareId: string,
    reason: string,
    code = "SESSION_SHARE_REVOKED",
  ): number {
    const session = this.sessions.get(sessionId);
    if (!session) return 0;
    let evicted = 0;
    for (const [participantId, participant] of session.participants) {
      if (
        participant.isOwner ||
        participant.accessRevoked ||
        participant.joinedViaShareId !== shareId
      ) {
        continue;
      }
      this.revokeSharedParticipant(
        session,
        participantId,
        participant,
        reason,
        code,
      );
      evicted += 1;
    }
    return evicted;
  }

  private revokeSharedParticipant(
    session: TerminalSession,
    participantId: string,
    participant: SessionParticipant,
    reason: string,
    code: string,
  ): void {
    // 先在服务端撤销写入能力，再发消息并关闭连接，避免关闭握手期间继续输入。
    participant.accessRevoked = true;
    participant.permissionLevel = "read-only";
    if (session.writeLeaseParticipantId === participantId) {
      session.writeLeaseParticipantId = null;
    }
    this.reconcileWriteLease(session);
    if (participant.ws.readyState !== WebSocket.OPEN) return;
    try {
      participant.ws.send(
        JSON.stringify({
          type: "sessionTerminatedByOwner",
          reason,
          code,
        }),
      );
      participant.ws.close(4003, reason);
    } catch {
      try {
        participant.ws.terminate();
      } catch {
        // 连接可能已经关闭。
      }
    }
  }

  /** Broadcasts termination to all guests, then destroys the session. */
  ownerEndSession(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.broadcast(sessionId, { type: "sessionTerminatedByOwner", reason });
    session.terminatedByOwner = true;
    session.terminationReason = reason;

    sshLogger.info("Owner ended shared session", {
      operation: "session_owner_end",
      sessionId,
      reason,
    });

    this.destroySession(sessionId);
  }

  detachWs(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const ownerEntry = this.getOwnerEntry(session);
    if (ownerEntry) {
      session.participants.delete(ownerEntry[0]);
    }
    this.reconcileWriteLease(session);

    // Persist log immediately when the user detaches so it appears right away,
    // regardless of whether the session is later reattached or times out.
    this.maybePersistLog(session);

    if (this.hasOpenParticipant(session)) {
      this.clearDetachedExpiration(session);
      sshLogger.info(
        "Owner detached while a shared participant remains online",
        {
          operation: "session_owner_detach_shared_active",
          sessionId,
          userId: session.userId,
        },
      );
      return;
    }

    this.startDetachedRetention(session);
  }

  private startDetachedRetention(session: TerminalSession): void {
    session.lastDetachedAt = Date.now();

    if (session.pinned) {
      if (session.managedTmux) {
        void createCurrentWebTerminalSessionRepository()
          .markDetached(session.userId, session.id)
          .catch((error) => {
            sshLogger.warn("Failed to persist pinned session detachment", {
              operation: "session_pin_detach_persist_error",
              sessionId: session.id,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }
      sshLogger.info("Pinned terminal detached without retention timeout", {
        operation: session.managedTmux
          ? "session_pin_detach"
          : "session_platform_keepalive_detach",
        sessionId: session.id,
        userId: session.userId,
        managedTmux: session.managedTmux,
      });
      return;
    }

    const timeoutMs = this.getTimeoutMs();
    this.touchOpenTab(session);
    this.scheduleDetachedExpiration(session, timeoutMs);

    sshLogger.info("WebSocket detached from session", {
      operation: "session_detach",
      sessionId: session.id,
      userId: session.userId,
      timeoutMinutes: timeoutMs / 60_000,
    });
  }

  destroySession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.detachTimeout) {
      clearTimeout(session.detachTimeout);
      session.detachTimeout = null;
    }

    this.maybePersistLog(session, true);
    if (session.recordingPath && session.recordingBytes === 0) {
      fs.promises.unlink(session.recordingPath).catch(() => {});
    }

    for (const participant of session.participants.values()) {
      if (participant.isOwner) continue;
      if (participant.ws.readyState !== WebSocket.OPEN) continue;
      try {
        participant.ws.send(
          JSON.stringify({
            type: "sessionExpired",
            sessionId,
            message: "Session has ended",
          }),
        );
      } catch {
        /* ignore */
      }
    }
    session.participants.clear();

    if (session.sshStream) {
      try {
        session.sshStream.end();
      } catch {
        /* ignore */
      }
      session.sshStream = null;
    }

    if (session.sshConn) {
      try {
        session.sshConn.end();
      } catch {
        /* ignore */
      }
      session.sshConn = null;
    }

    if (session.jumpClient) {
      try {
        session.jumpClient.end();
      } catch {
        /* ignore */
      }
      session.jumpClient = null;
    }

    session.isConnected = false;
    session.outputBuffer = [];
    session.outputBufferBytes = 0;

    this.sessions.delete(sessionId);

    sshLogger.info("Terminal session destroyed", {
      operation: "session_destroyed",
      sessionId,
      userId: session.userId,
      hostId: session.hostId,
    });
  }

  private maybePersistLog(session: TerminalSession, force = false): void {
    if (!session.sessionLoggingEnabled) return;
    if (session.recordingBytes === 0) return;
    if (!force && session.recordingBytes === session.lastPersistedBytes) return;
    session.lastPersistedBytes = session.recordingBytes;
    session.recordingPersistChain = session.recordingPersistChain
      .then(() => this.persistSessionLog(session))
      .catch((err) => {
        sshLogger.warn("Failed to persist session log", {
          operation: "session_log_persist_error",
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  private async persistSessionLog(session: TerminalSession): Promise<void> {
    if (!session.recordingPath) return;
    await session.recordingWriteChain;
    const endedAt = Date.now();
    const duration = Math.floor((endedAt - session.sessionStartedAt) / 1000);

    try {
      const repo = createCurrentSessionRecordingRepository();
      if (session.recordingId == null) {
        const created = await repo.create({
          hostId: session.hostId,
          userId: session.userId,
          startedAt: new Date(session.sessionStartedAt).toISOString(),
          endedAt: new Date(endedAt).toISOString(),
          duration,
          recordingPath: session.recordingPath,
          protocol: "ssh",
          format: "asciicast",
          terminatedByOwner: session.terminatedByOwner || undefined,
          terminationReason: session.terminationReason ?? undefined,
        });
        session.recordingId = created.id;
      } else {
        await repo.updateEnded(session.recordingId, {
          endedAt: new Date(endedAt).toISOString(),
          duration,
          terminatedByOwner: session.terminatedByOwner || undefined,
          terminationReason: session.terminationReason ?? undefined,
        });
      }
    } catch (err) {
      sshLogger.warn("Failed to insert session recording row", {
        operation: "session_recording_insert_error",
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    sshLogger.info("Session log persisted", {
      operation: "session_log_persisted",
      sessionId: session.id,
      userId: session.userId,
      hostId: session.hostId,
      duration,
      bytes: session.recordingBytes,
    });
  }

  getUserSessions(userId: string): TerminalSession[] {
    const result: TerminalSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.userId === userId) {
        result.push(session);
      }
    }
    return result;
  }

  findSessions(filter: TerminalSessionFilter = {}): TerminalSession[] {
    const hostIds = filter.hostIds ? new Set(filter.hostIds) : null;
    const projectHostIds = filter.projectHostIds
      ? new Set(filter.projectHostIds)
      : null;
    const userIds = filter.userIds ? new Set(filter.userIds) : null;

    return [...this.sessions.values()].filter((session) => {
      if (filter.hostId !== undefined && session.hostId !== filter.hostId) {
        return false;
      }
      if (hostIds && !hostIds.has(session.hostId)) return false;
      if (
        filter.projectHostId !== undefined &&
        session.projectHostId !== filter.projectHostId
      ) {
        return false;
      }
      if (
        projectHostIds &&
        (session.projectHostId === undefined ||
          !projectHostIds.has(session.projectHostId))
      ) {
        return false;
      }
      if (filter.userId !== undefined && session.userId !== filter.userId) {
        return false;
      }
      if (userIds && !userIds.has(session.userId)) return false;
      if (filter.pinned !== undefined && session.pinned !== filter.pinned) {
        return false;
      }
      return true;
    });
  }

  bufferOutput(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.outputBuffer.push(data);
    session.outputBufferBytes += data.length;

    while (
      session.outputBufferBytes > MAX_BUFFER_BYTES &&
      session.outputBuffer.length > 0
    ) {
      const removed = session.outputBuffer.shift();
      if (removed) session.outputBufferBytes -= removed.length;
    }

    this.recordSessionEvent(session, "o", data);
  }

  bufferInput(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (data.length > 0) session.hasShellInput = true;
    this.recordSessionEvent(session, "i", data);
  }

  bufferResize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.recordSessionEvent(session, "r", `${cols}x${rows}`);
  }

  private recordSessionEvent(
    session: TerminalSession,
    type: "i" | "o" | "r",
    data: string,
  ): void {
    if (!session.sessionLoggingEnabled || !session.recordingPath || !data)
      return;
    const elapsed = (Date.now() - session.sessionStartedAt) / 1000;
    const line = `${JSON.stringify([elapsed, type, data])}\n`;
    const firstEvent = session.recordingBytes === 0;
    session.recordingBytes += Buffer.byteLength(line);
    session.recordingWriteChain = session.recordingWriteChain.then(async () => {
      if (firstEvent) {
        await fs.promises.mkdir(path.dirname(session.recordingPath!), {
          recursive: true,
        });
        await fs.promises.writeFile(
          session.recordingPath!,
          `${session.recordingHeader}${line}`,
          "utf8",
        );
        return;
      }
      await fs.promises.appendFile(session.recordingPath!, line, "utf8");
    });
  }

  flushBuffer(session: TerminalSession): string | null {
    if (session.outputBuffer.length === 0) return null;
    const data = session.outputBuffer.join("");
    session.outputBuffer = [];
    session.outputBufferBytes = 0;
    return data;
  }

  getBuffer(session: TerminalSession): string | null {
    if (session.outputBuffer.length === 0) return null;
    return session.outputBuffer.join("");
  }

  private getTimeoutMs(): number {
    try {
      const value = getCurrentSettingValue("ssh_disconnect_retention_minutes");
      return resolveTerminalSessionTimeoutMinutes(value) * 60_000;
    } catch {
      // DB not available, use default
    }
    return DEFAULT_TIMEOUT_MINUTES * 60_000;
  }

  getRetentionTimeoutMs(): number {
    return this.getTimeoutMs();
  }

  /** 让已经断开的普通窗口立即采用管理员最新保存的保留时间。 */
  refreshDetachedSessionRetention(): number {
    const timeoutMs = this.getTimeoutMs();
    let refreshed = 0;
    for (const session of this.sessions.values()) {
      if (
        session.pinned ||
        session.lastDetachedAt === null ||
        this.hasOpenParticipant(session)
      ) {
        continue;
      }
      this.scheduleDetachedExpiration(session, timeoutMs);
      refreshed += 1;
    }
    return refreshed;
  }

  private scheduleDetachedExpiration(
    session: TerminalSession,
    timeoutMs: number,
  ): void {
    if (session.detachTimeout) clearTimeout(session.detachTimeout);
    session.detachTimeout = null;
    const detachedAt = session.lastDetachedAt;
    if (session.pinned || detachedAt === null) {
      session.retentionExpiresAt = null;
      return;
    }

    session.retentionExpiresAt = detachedAt + timeoutMs;
    const remainingMs = session.retentionExpiresAt - Date.now();
    if (remainingMs <= 0) {
      void this.expireDetachedSession(session.id);
      return;
    }

    session.detachTimeout = setTimeout(() => {
      session.detachTimeout = null;
      sshLogger.info("Session idle timeout expired", {
        operation: "session_idle_timeout",
        sessionId: session.id,
        userId: session.userId,
      });
      void this.expireDetachedSession(session.id);
    }, remainingMs);
  }

  private touchOpenTab(session: TerminalSession): void {
    if (!session.tabInstanceId) return;
    void createCurrentOpenTabRepository()
      .updateForUser(session.userId, session.tabInstanceId, {
        backendSessionId: session.id,
      })
      .catch((error) => {
        sshLogger.warn("Failed to refresh terminal tab retention", {
          operation: "session_open_tab_touch_error",
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private async expireDetachedSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.pinned || this.hasOpenParticipant(session)) return;

    session.expirationInProgress = true;

    try {
      if (session.managedTmux && session.sshConn && session.tmuxSessionName) {
        try {
          await killTmuxSession(session.sshConn, session.tmuxSessionName);
        } catch (error) {
          sshLogger.warn("Failed to terminate expired managed tmux session", {
            operation: "session_idle_tmux_kill_error",
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (this.sessions.get(sessionId) === session) {
        this.destroySession(sessionId);
      }
    } finally {
      if (this.sessions.get(sessionId) === session) {
        session.expirationInProgress = false;
      }
    }
  }

  private healthCheck(): void {
    const toDestroy: string[] = [];
    const now = Date.now();
    const GRACE_PERIOD_MS = 10_000;

    for (const [id, session] of this.sessions) {
      if (!session.isConnected) continue;

      const hasOpenParticipant = Array.from(session.participants.values()).some(
        (p) => p.ws.readyState === WebSocket.OPEN,
      );
      if (hasOpenParticipant) {
        continue;
      }

      if (session.sshStream?.destroyed) {
        const detachedDuration = session.lastDetachedAt
          ? now - session.lastDetachedAt
          : 0;

        if (detachedDuration > GRACE_PERIOD_MS) {
          sshLogger.info(
            "SSH stream destroyed during detach window, cleaning up",
            {
              operation: "session_health_check_stream_destroyed",
              sessionId: id,
              userId: session.userId,
              detachedFor: detachedDuration,
            },
          );
          toDestroy.push(id);
        }
      }

      if (!session.sshConn) {
        toDestroy.push(id);
      }
    }

    for (const id of toDestroy) {
      this.destroySession(id);
    }
  }

  destroyAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.destroySession(id);
    }
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }
}

export const sessionManager = TerminalSessionManager.getInstance();
