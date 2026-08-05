import crypto from "crypto";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { AgentApiError, isAgentApiError } from "./errors.js";
import {
  findIdempotency,
  findSession,
  hasIdempotencyCapacity,
  type AgentStateStore,
} from "./store.js";
import type {
  AgentPersistentState,
  AgentPrincipal,
  AgentScope,
  AgentSessionState,
  AgentSessionDriver,
  AgentSessionRecord,
  AgentSessionRuntimeMode,
  CreateSessionInput,
  DriverOutputSink,
  OutputChunk,
} from "./types.js";
import type { AgentSessionRecorder } from "./recording.js";

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_ATTACHMENT_IDLE_MS = 90_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_READ_BYTES = 256 * 1024;
const ACTIVE_STATES = new Set(["CREATING", "RUNNING", "RECOVERING"]);

interface EphemeralWriteLeaseSnapshot {
  principalId: string;
  attachmentId: string;
  leaseId: string;
  expiresAt: number;
  nextPersistAt: number;
  runtimeId: string;
  recordingSession: AgentSessionRecord;
}

function assertIdempotencyCapacity(state: AgentPersistentState): void {
  if (!hasIdempotencyCapacity(state)) {
    throw new AgentApiError(
      429,
      "IDEMPOTENCY_CAPACITY_EXCEEDED",
      "防重记录已达到容量上限，请等待历史记录过期后重试",
    );
  }
}

interface RuntimeAttempt {
  id: string;
  sessionId: string;
  generation: number;
}

interface OutputSubscriber {
  onOutput: (chunk: OutputChunk) => void | Promise<void>;
  onEnd?: (event: {
    state: Extract<AgentSessionState, "CLOSED" | "FAILED">;
    failureReason: string | null;
  }) => void | Promise<void>;
  ended: boolean;
}

function requestHash(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function normalizeCreateSessionInput(
  input: CreateSessionInput,
): CreateSessionInput & { runtimeMode: AgentSessionRuntimeMode } {
  return {
    ...input,
    runtimeMode: input.runtimeMode ?? (input.pinned ? "tmux" : "platform"),
  };
}

function createSessionRequestShape(
  input: Pick<CreateSessionInput, "serverId" | "cols" | "rows" | "pinned">,
  runtimeMode?: AgentSessionRuntimeMode,
) {
  return {
    serverId: input.serverId,
    cols: input.cols,
    rows: input.rows,
    pinned: input.pinned,
    ...(runtimeMode ? { runtimeMode } : {}),
  };
}

function omittedRuntimeModeMatchesLegacyRequest(
  input: CreateSessionInput,
  existingHash: string,
): boolean {
  if (input.runtimeMode !== undefined) return false;
  // .21 及更早版本的创建哈希没有 runtimeMode。只按本次原始请求匹配
  // 旧哈希，不能依赖会被 resize 修改的会话尺寸，也不能把新版显式
  // tmux 请求误当成旧请求。
  return existingHash === requestHash(createSessionRequestShape(input));
}

function isLeaseExpired(
  expiresAt: string | null | undefined,
  now: number,
): boolean {
  if (!expiresAt) return true;
  const timestamp = Date.parse(expiresAt);
  return !Number.isFinite(timestamp) || timestamp <= now;
}

function assertScope(principal: AgentPrincipal, scope: AgentScope): void {
  if (!principal.scopes.includes(scope)) {
    throw new AgentApiError(403, "SCOPE_DENIED", `缺少权限：${scope}`);
  }
}

function assertServerAccess(
  principal: AgentPrincipal,
  serverId: string,
): { projectId: string; serviceAccountId: string } {
  if (
    !principal.serverIds.includes("*") &&
    !principal.serverIds.includes(serverId)
  ) {
    throw new AgentApiError(403, "SERVER_DENIED", "当前设备无权访问该服务器");
  }
  return {
    projectId: principal.serverProjectIds?.[serverId] ?? principal.projectId,
    serviceAccountId:
      principal.serverServiceAccountIds?.[serverId] ??
      principal.serviceAccountId,
  };
}

function canAccessProject(
  principal: AgentPrincipal,
  projectId: string,
): boolean {
  return (principal.projectIds ?? [principal.projectId]).includes(projectId);
}

function publicSession(session: AgentSessionRecord) {
  const { output: _output, runtimeId: _runtimeId, ...result } = session;
  return result;
}

type PublicAgentSession = ReturnType<typeof publicSession>;

export class AgentSessionBroker {
  private readonly runtimeAttempts = new Map<string, RuntimeAttempt>();
  private readonly recoveryAttempted = new Set<string>();
  private readonly sessionControlTails = new Map<string, Promise<void>>();
  private readonly ephemeralWriteLeases = new Map<
    string,
    EphemeralWriteLeaseSnapshot
  >();
  private readonly sessionStarts = new Map<
    string,
    Promise<PublicAgentSession>
  >();
  private readonly outputSubscribers = new Map<string, Set<OutputSubscriber>>();

  constructor(
    private readonly store: AgentStateStore,
    private readonly driver: AgentSessionDriver,
    private readonly leaseMs = DEFAULT_LEASE_MS,
    private readonly recorder?: AgentSessionRecorder,
    private readonly attachmentIdleMs = DEFAULT_ATTACHMENT_IDLE_MS,
  ) {}

  async create(
    principal: AgentPrincipal,
    input: CreateSessionInput,
    idempotencyKey: string,
  ) {
    assertScope(principal, "sessions:create");
    const normalizedInput = normalizeCreateSessionInput(input);
    const access = assertServerAccess(principal, normalizedInput.serverId);
    if (!idempotencyKey) {
      throw new AgentApiError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "必须提供 Idempotency-Key",
      );
    }

    const scopedKey = `${principal.principalId}:project:${access.projectId}:session:create:${idempotencyKey}`;
    const hash = requestHash(
      createSessionRequestShape(normalizedInput, normalizedInput.runtimeMode),
    );
    const reservation = await this.store.update((state) => {
      const existing = findIdempotency(state, scopedKey);
      if (existing) {
        const sessionId = (existing.response as { sessionId: string })
          .sessionId;
        const session = findSession(state, sessionId);
        if (
          existing.requestHash !== hash &&
          !omittedRuntimeModeMatchesLegacyRequest(input, existing.requestHash)
        ) {
          throw new AgentApiError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "同一个幂等键不能用于不同请求",
          );
        }
        if (!session) {
          throw new AgentApiError(
            410,
            "IDEMPOTENCY_OUTCOME_EXPIRED",
            "原会话已从运行历史中淘汰，不能使用相同幂等键重新创建",
          );
        }
        return { session: structuredClone(session), created: false };
      }
      assertIdempotencyCapacity(state);

      const deviceServiceAccountIds = new Set(
        principal.serviceAccountIds ?? [principal.serviceAccountId],
      );
      const activeCount = state.sessions.filter(
        (session) =>
          deviceServiceAccountIds.has(session.serviceAccountId) &&
          ACTIVE_STATES.has(session.state),
      ).length;
      if (activeCount >= principal.maxConcurrentSessions) {
        throw new AgentApiError(
          429,
          "SESSION_LIMIT_REACHED",
          "当前设备的并发会话已达到上限",
        );
      }

      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const session: AgentSessionRecord = {
        id,
        projectId: access.projectId,
        serverId: normalizedInput.serverId,
        serviceAccountId: access.serviceAccountId,
        state: "CREATING",
        cols: normalizedInput.cols,
        rows: normalizedInput.rows,
        pinned: normalizedInput.pinned,
        runtimeMode: normalizedInput.runtimeMode,
        createdAt: now,
        updatedAt: now,
        lastDetachedAt: now,
        closedAt: null,
        failureReason: null,
        generation: 1,
        nextSequence: 0,
        output: [],
        attachments: [],
        writeLease: null,
        runtimeId: null,
        tmuxSessionName: `cloudssh-${id}`,
      };
      state.sessions.push(session);
      state.idempotency.push({
        key: scopedKey,
        requestHash: hash,
        response: { sessionId: id },
        createdAt: now,
      });
      return { session: structuredClone(session), created: true };
    });

    if (
      !reservation.created &&
      (reservation.session.state !== "CREATING" ||
        reservation.session.runtimeId)
    ) {
      return publicSession(reservation.session);
    }

    return this.ensureSessionStarted(reservation.session);
  }

  private ensureSessionStarted(
    session: AgentSessionRecord,
  ): Promise<PublicAgentSession> {
    const current = this.sessionStarts.get(session.id);
    if (current) return current;

    const start = this.startReservedSession(session).finally(() => {
      if (this.sessionStarts.get(session.id) === start) {
        this.sessionStarts.delete(session.id);
      }
    });
    this.sessionStarts.set(session.id, start);
    return start;
  }

  private async startReservedSession(
    session: AgentSessionRecord,
  ): Promise<PublicAgentSession> {
    const attempt = this.beginRuntimeAttempt(session.id, session.generation);
    let runtimeId: string | null = null;
    try {
      await this.recorder?.start(session);
      if (!this.isCurrentAttempt(attempt)) {
        throw new AgentApiError(
          409,
          "SESSION_RUNTIME_STALE",
          "会话运行时已被更新",
        );
      }
      const handle = await this.driver.create(
        session,
        this.createSink(attempt),
      );
      runtimeId = handle.runtimeId;
      const running = await this.store.update((state) => {
        const current = findSession(state, session.id)!;
        if (
          !this.isCurrentAttempt(attempt) ||
          current.generation !== attempt.generation ||
          current.state !== "CREATING"
        ) {
          return null;
        }
        current.runtimeId = handle.runtimeId;
        current.state = "RUNNING";
        current.updatedAt = new Date().toISOString();
        return publicSession(structuredClone(current));
      });
      if (!running) {
        await this.closeAbandonedRuntime(handle.runtimeId);
        throw new AgentApiError(
          409,
          "SESSION_RUNTIME_STALE",
          "会话运行时已被更新",
        );
      }
      return running;
    } catch (error) {
      if (this.clearRuntimeAttempt(attempt)) {
        if (runtimeId) await this.closeAbandonedRuntime(runtimeId);
        await this.markFailed(session.id, error, attempt.generation);
      }
      throw error;
    }
  }

  async list(principal: AgentPrincipal) {
    assertScope(principal, "sessions:read");
    const state = await this.store.read();
    return state.sessions
      .filter((session) => canAccessProject(principal, session.projectId))
      .filter(
        (session) =>
          principal.serverIds.includes("*") ||
          principal.serverIds.includes(session.serverId),
      )
      .map(publicSession);
  }

  async status(principal: AgentPrincipal, sessionId: string) {
    assertScope(principal, "sessions:read");
    const session = await this.requireSession(principal, sessionId);
    return publicSession(session);
  }

  async subscribe(
    principal: AgentPrincipal,
    sessionId: string,
    listener: (chunk: OutputChunk) => void | Promise<void>,
    onEnd?: OutputSubscriber["onEnd"],
  ): Promise<() => void> {
    assertScope(principal, "sessions:read");
    await this.requireSession(principal, sessionId);
    const listeners = this.outputSubscribers.get(sessionId) ?? new Set();
    const subscriber: OutputSubscriber = {
      onOutput: listener,
      onEnd,
      ended: false,
    };
    listeners.add(subscriber);
    this.outputSubscribers.set(sessionId, listeners);
    const unsubscribe = () => {
      const current = this.outputSubscribers.get(sessionId);
      if (!current) return;
      current.delete(subscriber);
      if (current.size === 0) this.outputSubscribers.delete(sessionId);
    };

    // 授权检查与监听器登记之间会话可能已经结束。登记后再读取一次，
    // 与 endOutputSubscriptions 的 ended 门闩配合，保证不漏报也不重复。
    try {
      const current = await this.requireSession(principal, sessionId);
      if (current.state === "CLOSED" || current.state === "FAILED") {
        unsubscribe();
        this.notifySubscriberEnd(subscriber, {
          state: current.state,
          failureReason: current.failureReason,
        });
      }
    } catch (error) {
      unsubscribe();
      throw error;
    }
    return unsubscribe;
  }

  async attach(
    principal: AgentPrincipal,
    sessionId: string,
    mode: "read-only" | "read-write",
    takeover = false,
    idempotencyKey = "",
  ) {
    assertScope(principal, "sessions:read");
    if (mode === "read-write") assertScope(principal, "sessions:write");
    if (!idempotencyKey) {
      throw new AgentApiError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "必须提供 Idempotency-Key",
      );
    }

    const scopedKey = `${principal.principalId}:session:${sessionId}:attach:${idempotencyKey}`;
    const hash = requestHash({ mode, takeover });

    const attachToSession = async () => {
      await this.requireSession(principal, sessionId);
      return this.store.update((state) => {
        const session = findSession(state, sessionId)!;
        const existing = findIdempotency(state, scopedKey);
        if (existing) {
          if (existing.requestHash !== hash) {
            throw new AgentApiError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "同一个幂等键不能用于不同请求",
            );
          }
          const attachmentId = (existing.response as { attachmentId?: string })
            .attachmentId;
          const attachment = session.attachments.find(
            (candidate) =>
              candidate.id === attachmentId &&
              candidate.principalId === principal.principalId,
          );
          const now = Date.now();
          if (
            !attachment ||
            attachment.mode !== mode ||
            Date.parse(attachment.lastSeenAt) + this.attachmentIdleMs <= now
          ) {
            throw new AgentApiError(
              409,
              "ATTACHMENT_OUTCOME_EXPIRED",
              "上次附着结果已经失效，请使用新的幂等键重新附着",
            );
          }

          const timestamp = new Date(now).toISOString();
          let lease = null;
          if (mode === "read-write") {
            const expectedHolder = `${principal.principalId}:${attachment.id}`;
            if (
              !session.writeLease ||
              session.writeLease.holderId !== expectedHolder
            ) {
              throw new AgentApiError(
                409,
                "ATTACHMENT_OUTCOME_EXPIRED",
                "上次附着的写入权已经失效，请使用新的幂等键重新附着",
              );
            }
            session.writeLease.expiresAt = new Date(
              now + this.leaseMs,
            ).toISOString();
            lease = structuredClone(session.writeLease);
          }
          attachment.lastSeenAt = timestamp;
          session.lastDetachedAt = null;
          session.updatedAt = timestamp;
          return {
            session: publicSession(structuredClone(session)),
            attachmentId: attachment.id,
            mode: attachment.mode,
            lease,
          };
        }

        assertIdempotencyCapacity(state);

        if (!ACTIVE_STATES.has(session.state)) {
          throw new AgentApiError(
            409,
            "SESSION_NOT_RUNNING",
            "会话当前不可附着",
          );
        }
        const now = Date.now();
        this.pruneExpiredAttachments(session, now);
        const attachmentId = crypto.randomUUID();
        let lease = session.writeLease;
        if (mode === "read-write") {
          const leaseExpired = !lease || isLeaseExpired(lease.expiresAt, now);
          if (!leaseExpired && !takeover) {
            throw new AgentApiError(
              409,
              "WRITE_LEASE_HELD",
              "会话写入权已被占用",
            );
          }
          if (!leaseExpired && takeover && lease) {
            const previousWriter = session.attachments.find(
              (attachment) =>
                `${attachment.principalId}:${attachment.id}` ===
                lease!.holderId,
            );
            if (previousWriter) previousWriter.mode = "read-only";
          }
          const timestamp = new Date(now).toISOString();
          lease = {
            id: crypto.randomUUID(),
            holderId: `${principal.principalId}:${attachmentId}`,
            acquiredAt: timestamp,
            expiresAt: new Date(now + this.leaseMs).toISOString(),
          };
          session.writeLease = lease;
        }
        const timestamp = new Date(now).toISOString();
        session.attachments.push({
          id: attachmentId,
          principalId: principal.principalId,
          mode,
          attachedAt: timestamp,
          lastSeenAt: timestamp,
        });
        session.lastDetachedAt = null;
        session.updatedAt = timestamp;
        state.idempotency.push({
          key: scopedKey,
          requestHash: hash,
          response: { attachmentId },
          createdAt: timestamp,
        });
        return {
          session: publicSession(structuredClone(session)),
          attachmentId,
          mode,
          lease: mode === "read-write" ? structuredClone(lease) : null,
        };
      });
    };
    this.ephemeralWriteLeases.delete(sessionId);
    const result = await (mode === "read-write"
      ? this.withSessionControl(sessionId, attachToSession)
      : attachToSession());
    // 附着可能清理过期附件或转移写入权。任何成功附着后都丢弃旧的
    // 进程内快照，下一次网页输入会从刚提交的权威状态重新建立缓存。
    this.ephemeralWriteLeases.delete(sessionId);
    return result;
  }

  async read(
    principal: AgentPrincipal,
    sessionId: string,
    cursorValue?: string,
    requestedLimit = MAX_READ_BYTES,
    attachmentId?: string,
  ) {
    assertScope(principal, "sessions:read");
    const session = await this.requireSession(principal, sessionId);
    if (attachmentId) {
      await this.touchAttachment(principal, sessionId, attachmentId);
    }
    const cursor = cursorValue
      ? decodeCursor(cursorValue, sessionId)
      : { sessionId, generation: 1, sequence: 0 };
    const limit = Math.min(Math.max(requestedLimit, 1), MAX_READ_BYTES);
    const chunks = [] as typeof session.output;
    let bytes = 0;
    for (const chunk of session.output) {
      const isAfter =
        chunk.generation > cursor.generation ||
        (chunk.generation === cursor.generation &&
          chunk.sequence >= cursor.sequence);
      if (!isAfter) continue;
      const chunkBytes = Buffer.byteLength(chunk.data);
      if (chunks.length > 0 && bytes + chunkBytes > limit) break;
      chunks.push(chunk);
      bytes += chunkBytes;
    }
    const last = chunks.at(-1);
    const nextCursor = encodeCursor({
      sessionId,
      generation: last?.generation ?? cursor.generation,
      sequence: last ? last.sequence + 1 : cursor.sequence,
    });
    const firstAvailable = session.output[0];
    const gap = Boolean(
      firstAvailable &&
      (cursor.generation < firstAvailable.generation ||
        (cursor.generation === firstAvailable.generation &&
          cursor.sequence < firstAvailable.sequence)),
    );
    return { chunks, nextCursor, gap, state: session.state };
  }

  async write(
    principal: AgentPrincipal,
    sessionId: string,
    attachmentId: string,
    leaseId: string,
    data: string,
    idempotencyKey: string,
  ) {
    assertScope(principal, "sessions:write");
    if (!idempotencyKey) {
      throw new AgentApiError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "必须提供 Idempotency-Key",
      );
    }
    this.ephemeralWriteLeases.delete(sessionId);
    const result = await this.withSessionControl(sessionId, async () => {
      const session = await this.requireSession(principal, sessionId);
      if (!session.runtimeId || session.state !== "RUNNING") {
        throw new AgentApiError(409, "SESSION_NOT_RUNNING", "会话当前不可写入");
      }

      const scopedKey = `${principal.principalId}:session:${sessionId}:write:${idempotencyKey}`;
      const hash = requestHash({ attachmentId, leaseId, data });
      const reservation = await this.store.update((state) => {
        const existing = findIdempotency(state, scopedKey);
        if (existing) {
          if (existing.requestHash !== hash) {
            throw new AgentApiError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "幂等键请求内容冲突",
            );
          }
          const outcome = existing.response as { status?: string };
          if (outcome.status !== "success") {
            throw new AgentApiError(
              409,
              "WRITE_OUTCOME_UNKNOWN",
              "上次写入结果无法确认，请读取终端输出后使用新的幂等键",
            );
          }
          return {
            duplicate: true,
            runtimeId: currentRuntimeId(state, sessionId),
          };
        }
        assertIdempotencyCapacity(state);
        const current = findSession(state, sessionId)!;
        const expectedHolder = `${principal.principalId}:${attachmentId}`;
        const attachment = current.attachments.find(
          (candidate) =>
            candidate.id === attachmentId &&
            candidate.principalId === principal.principalId,
        );
        if (
          !attachment ||
          attachment.mode !== "read-write" ||
          !current.writeLease ||
          current.writeLease.id !== leaseId ||
          current.writeLease.holderId !== expectedHolder ||
          isLeaseExpired(current.writeLease.expiresAt, Date.now())
        ) {
          throw new AgentApiError(
            409,
            "WRITE_LEASE_INVALID",
            "写入租约无效或已过期",
          );
        }
        const now = new Date().toISOString();
        current.writeLease.expiresAt = new Date(
          Date.now() + this.leaseMs,
        ).toISOString();
        attachment.lastSeenAt = now;
        current.lastDetachedAt = null;
        current.updatedAt = now;
        state.idempotency.push({
          key: scopedKey,
          requestHash: hash,
          response: { status: "pending" },
          createdAt: now,
        });
        return { duplicate: false, runtimeId: current.runtimeId! };
      });
      if (!reservation.duplicate) {
        try {
          await this.recorder?.recordInput(session, principal, data);
          await this.driver.write(reservation.runtimeId, data);
          await this.store.update((state) => {
            const record = findIdempotency(state, scopedKey)!;
            record.response = { status: "success" };
          });
        } catch (error) {
          await this.store.update((state) => {
            const record = findIdempotency(state, scopedKey)!;
            record.response = { status: "unknown" };
          });
          throw error;
        }
      }
      return { accepted: true, duplicate: reservation.duplicate };
    });
    this.ephemeralWriteLeases.delete(sessionId);
    return result;
  }

  /**
   * 为同进程内受信任的交互入口写入终端。
   *
   * Web 终端已经由平台 JWT、项目权限和主机权限完成认证，因此不需要把
   * 每一个按键都写成一条幂等记录；但仍必须经过与 Agent API 完全相同的
   * 单写租约校验，并继续进入输入录像。
   */
  async writeEphemeral(
    principal: AgentPrincipal,
    sessionId: string,
    attachmentId: string,
    leaseId: string,
    data: string,
  ) {
    assertScope(principal, "sessions:write");
    return this.withSessionControl(sessionId, async () => {
      const lease = await this.requireEphemeralWriteLease(
        principal,
        sessionId,
        attachmentId,
        leaseId,
      );
      await this.recorder?.recordInput(lease.recordingSession, principal, data);
      await this.driver.write(lease.runtimeId, data);
      return { accepted: true };
    });
  }

  /**
   * 刷新临时浏览器附件；写附件会同时续期租约。
   *
   * 返回当前模式，调用方可在其他设备接管后立刻把界面降为只读。
   */
  async keepaliveAttachment(
    principal: AgentPrincipal,
    sessionId: string,
    attachmentId: string,
    leaseId?: string | null,
  ) {
    assertScope(principal, "sessions:read");
    this.ephemeralWriteLeases.delete(sessionId);
    const result = await this.withSessionControl(sessionId, async () => {
      await this.requireSession(principal, sessionId);
      return this.store.update((state) => {
        const session = findSession(state, sessionId);
        const attachment = session?.attachments.find(
          (candidate) =>
            candidate.id === attachmentId &&
            candidate.principalId === principal.principalId,
        );
        if (!session || !attachment) {
          throw new AgentApiError(
            404,
            "ATTACHMENT_NOT_FOUND",
            "附件不存在或不属于当前设备",
          );
        }

        const now = Date.now();
        let lease = null;
        if (attachment.mode === "read-write") {
          assertScope(principal, "sessions:write");
          const expectedHolder = `${principal.principalId}:${attachmentId}`;
          if (
            !leaseId ||
            !session.writeLease ||
            session.writeLease.id !== leaseId ||
            session.writeLease.holderId !== expectedHolder ||
            isLeaseExpired(session.writeLease.expiresAt, now)
          ) {
            throw new AgentApiError(
              409,
              "WRITE_LEASE_INVALID",
              "写入租约无效或已过期",
            );
          }
          session.writeLease.expiresAt = new Date(
            now + this.leaseMs,
          ).toISOString();
          lease = structuredClone(session.writeLease);
        }

        const timestamp = new Date(now).toISOString();
        attachment.lastSeenAt = timestamp;
        session.lastDetachedAt = null;
        session.updatedAt = timestamp;
        return {
          mode: attachment.mode,
          lease,
        };
      });
    });
    this.ephemeralWriteLeases.delete(sessionId);
    return result;
  }

  async resize(
    principal: AgentPrincipal,
    sessionId: string,
    attachmentId: string,
    leaseId: string,
    cols: number,
    rows: number,
  ) {
    assertScope(principal, "sessions:write");
    this.ephemeralWriteLeases.delete(sessionId);
    const result = await this.withSessionControl(sessionId, async () => {
      const session = await this.requireSession(principal, sessionId);
      if (!session.runtimeId || session.state !== "RUNNING") {
        throw new AgentApiError(
          409,
          "SESSION_NOT_RUNNING",
          "会话当前不可调整尺寸",
        );
      }
      await this.requireValidLease(principal, sessionId, attachmentId, leaseId);
      await this.driver.resize(session.runtimeId, cols, rows);
      return this.store.update((state) => {
        const current = findSession(state, sessionId)!;
        current.cols = cols;
        current.rows = rows;
        current.updatedAt = new Date().toISOString();
        return publicSession(structuredClone(current));
      });
    });
    this.ephemeralWriteLeases.delete(sessionId);
    return result;
  }

  async detach(
    principal: AgentPrincipal,
    sessionId: string,
    attachmentId: string,
  ) {
    assertScope(principal, "sessions:read");
    this.ephemeralWriteLeases.delete(sessionId);
    const result = await this.withSessionControl(sessionId, async () => {
      await this.requireSession(principal, sessionId);
      return this.store.update((state) => {
        const session = findSession(state, sessionId)!;
        const attachmentIndex = session.attachments.findIndex(
          (attachment) =>
            attachment.id === attachmentId &&
            attachment.principalId === principal.principalId,
        );
        if (attachmentIndex === -1) {
          throw new AgentApiError(
            404,
            "ATTACHMENT_NOT_FOUND",
            "附件不存在或不属于当前设备",
          );
        }
        const expectedHolder = `${principal.principalId}:${attachmentId}`;
        if (session.writeLease?.holderId === expectedHolder)
          session.writeLease = null;
        session.attachments.splice(attachmentIndex, 1);
        const timestamp = new Date().toISOString();
        session.lastDetachedAt =
          session.attachments.length === 0 ? timestamp : null;
        session.updatedAt = timestamp;
        return { detached: true };
      });
    });
    this.ephemeralWriteLeases.delete(sessionId);
    return result;
  }

  async close(principal: AgentPrincipal, sessionId: string) {
    assertScope(principal, "sessions:close");
    this.ephemeralWriteLeases.delete(sessionId);
    return this.withSessionControl(sessionId, async () => {
      const session = await this.requireSession(principal, sessionId);
      if (session.state === "CLOSED") {
        // Sidecar 写入可能已经成功，但主库同步或录像收尾仍可能失败。
        // 幂等重试必须再次触发同步并完成录像，而不是提前返回。
        const closed = await this.store.update((state) => {
          const current = findSession(state, sessionId)!;
          return publicSession(structuredClone(current));
        });
        this.endOutputSubscriptions(sessionId, "CLOSED", null);
        await this.recorder?.end(sessionId);
        return closed;
      }
      await this.store.update((state) => {
        const current = findSession(state, sessionId)!;
        current.state = "CLOSING";
        current.updatedAt = new Date().toISOString();
      });
      try {
        if (session.runtimeId) {
          try {
            await this.driver.close(session.runtimeId);
          } catch (error) {
            if (
              !isAgentApiError(error) ||
              error.code !== "SESSION_RUNTIME_MISSING"
            ) {
              throw error;
            }
            // SSH 可能在点击终止的同时自然退出。平台运行时已经结束；
            // tmux 仍可能留在远端，因此必须按持久名称再次确认终止。
            if (session.runtimeMode === "tmux") {
              await this.driver.closePersistent(session);
            }
          }
        } else if (session.runtimeMode === "tmux") {
          await this.driver.closePersistent(session);
        }
      } catch (error) {
        await this.store.update((state) => {
          const current = findSession(state, sessionId)!;
          current.state = "CLOSING";
          current.failureReason =
            error instanceof Error ? error.message : "会话关闭失败";
          current.updatedAt = new Date().toISOString();
        });
        throw error;
      }
      this.clearSessionRuntimeAttempt(sessionId);
      const closed = await this.store.update((state) => {
        const current = findSession(state, sessionId)!;
        current.state = "CLOSED";
        current.closedAt = new Date().toISOString();
        current.updatedAt = current.closedAt;
        current.runtimeId = null;
        current.writeLease = null;
        current.attachments = [];
        current.failureReason = null;
        return publicSession(structuredClone(current));
      });
      this.endOutputSubscriptions(sessionId, "CLOSED", null);
      await this.recorder?.end(sessionId);
      return closed;
    });
  }

  async recoverActiveSessions(): Promise<void> {
    const state = await this.store.read();
    for (const stale of state.sessions.filter(
      (session) => session.state === "CLOSING",
    )) {
      this.ephemeralWriteLeases.delete(stale.id);
      try {
        if (stale.runtimeMode === "tmux") {
          // 旧 runtimeId 属于已退出进程，按持久 tmux 名称重新定位并终止。
          await this.driver.closePersistent(stale);
        }
      } catch (error) {
        await this.store.update((draft) => {
          const session = findSession(draft, stale.id);
          if (!session || session.state !== "CLOSING") return;
          session.failureReason =
            error instanceof Error ? error.message : "会话关闭恢复失败";
          session.updatedAt = new Date().toISOString();
        });
        continue;
      }

      this.clearSessionRuntimeAttempt(stale.id);
      await this.store.update((draft) => {
        const session = findSession(draft, stale.id);
        if (!session || session.state !== "CLOSING") return;
        session.state = "CLOSED";
        session.closedAt = new Date().toISOString();
        session.updatedAt = session.closedAt;
        session.runtimeId = null;
        session.writeLease = null;
        session.attachments = [];
        session.failureReason = null;
      });
      this.endOutputSubscriptions(stale.id, "CLOSED", null);
      await this.recorder?.end(stale.id);
    }

    for (const stale of state.sessions.filter((session) =>
      ACTIVE_STATES.has(session.state),
    )) {
      this.ephemeralWriteLeases.delete(stale.id);
      if (this.runtimeAttempts.has(stale.id)) continue;
      if (stale.runtimeMode === "platform") {
        await this.markFailed(
          stale.id,
          new Error("平台中转会话无法在 CloudSSH 服务重启后恢复"),
          stale.generation,
        );
        continue;
      }
      const firstAttemptInProcess = !this.recoveryAttempted.has(stale.id);
      const attempt = this.beginRuntimeAttempt(stale.id, stale.generation);
      this.recoveryAttempted.add(stale.id);
      const reservation = await this.store.update((draft) => {
        const session = findSession(draft, stale.id);
        if (!session || !ACTIVE_STATES.has(session.state)) return null;
        const startsNewGeneration =
          firstAttemptInProcess || session.state !== "RECOVERING";
        session.state = "RECOVERING";
        if (startsNewGeneration) {
          session.generation += 1;
          session.nextSequence = 0;
        }
        attempt.generation = session.generation;
        session.runtimeId = null;
        session.writeLease = null;
        session.attachments = [];
        session.lastDetachedAt = new Date().toISOString();
        session.updatedAt = new Date().toISOString();
        return { session: structuredClone(session), startsNewGeneration };
      });
      if (!reservation) {
        this.clearRuntimeAttempt(attempt);
        continue;
      }
      try {
        await this.recorder?.start(reservation.session);
        if (reservation.startsNewGeneration) {
          await this.appendOutput(
            stale.id,
            "\r\n[cloudssh: output resumed after broker restart]\r\n",
            attempt,
          );
        }
        if (!this.isCurrentAttempt(attempt)) continue;
        const handle = await this.driver.recover(
          reservation.session,
          this.createSink(attempt),
        );
        const activated = await this.store.update((draft) => {
          const session = findSession(draft, stale.id)!;
          if (
            !this.isCurrentAttempt(attempt) ||
            session.generation !== attempt.generation ||
            session.state !== "RECOVERING"
          ) {
            return false;
          }
          session.state = "RUNNING";
          session.runtimeId = handle.runtimeId;
          session.updatedAt = new Date().toISOString();
          session.failureReason = null;
          return true;
        });
        if (!activated) {
          this.clearRuntimeAttempt(attempt);
          await this.closeAbandonedRuntime(handle.runtimeId);
        }
      } catch (error) {
        if (this.clearRuntimeAttempt(attempt)) {
          await this.store.update((draft) => {
            const session = findSession(draft, stale.id);
            if (!session || session.generation !== attempt.generation) return;
            session.state = "RECOVERING";
            session.failureReason =
              error instanceof Error ? error.message : "会话恢复失败";
            session.updatedAt = new Date().toISOString();
          });
        }
      }
    }
  }

  async cleanupExpiredSessions(
    retentionMs = 24 * 60 * 60 * 1000,
  ): Promise<number> {
    const now = Date.now();
    const beforePrune = await this.store.read();
    for (const session of beforePrune.sessions) {
      if (!ACTIVE_STATES.has(session.state)) continue;
      this.ephemeralWriteLeases.delete(session.id);
      await this.withSessionControl(session.id, () =>
        this.store.update((draft) => {
          const current = findSession(draft, session.id);
          if (current && ACTIVE_STATES.has(current.state)) {
            this.pruneExpiredAttachments(current, now);
          }
        }),
      );
    }
    const state = await this.store.read();
    const expired = state.sessions.filter(
      (session) =>
        !session.pinned &&
        (ACTIVE_STATES.has(session.state) || session.state === "CLOSING") &&
        Boolean(session.lastDetachedAt) &&
        Date.parse(session.lastDetachedAt!) + retentionMs <= now,
    );
    let closedCount = 0;
    for (const session of expired) {
      try {
        await this.withSessionControl(session.id, async () => {
          const current = findSession(await this.store.read(), session.id);
          if (
            !current ||
            current.pinned ||
            (!ACTIVE_STATES.has(current.state) &&
              current.state !== "CLOSING") ||
            !current.lastDetachedAt ||
            Date.parse(current.lastDetachedAt) + retentionMs > Date.now()
          ) {
            return;
          }
          await this.store.update((draft) => {
            const closing = findSession(draft, session.id)!;
            closing.state = "CLOSING";
            closing.updatedAt = new Date().toISOString();
          });
          if (current.runtimeId) await this.driver.close(current.runtimeId);
          this.clearSessionRuntimeAttempt(session.id);
          await this.store.update((draft) => {
            const closed = findSession(draft, session.id)!;
            closed.state = "CLOSED";
            closed.closedAt = new Date().toISOString();
            closed.updatedAt = closed.closedAt;
            closed.runtimeId = null;
            closed.writeLease = null;
            closed.attachments = [];
            closed.failureReason = null;
          });
          this.endOutputSubscriptions(session.id, "CLOSED", null);
          await this.recorder?.end(session.id);
          closedCount += 1;
        });
      } catch (error) {
        await this.store
          .update((draft) => {
            const current = findSession(draft, session.id);
            if (!current || current.state === "CLOSED") return;
            current.state = "CLOSING";
            current.failureReason =
              error instanceof Error ? error.message : "会话关闭失败";
            current.updatedAt = new Date().toISOString();
          })
          .catch(() => undefined);
      }
    }
    return closedCount;
  }

  private createSink(attempt: RuntimeAttempt): DriverOutputSink {
    return {
      onOutput: (data) => this.appendOutput(attempt.sessionId, data, attempt),
      onExit: async (exitCode, reason) => {
        if (!this.clearRuntimeAttempt(attempt)) return;
        this.ephemeralWriteLeases.delete(attempt.sessionId);
        const ended = await this.store.update((state) => {
          const session = findSession(state, attempt.sessionId);
          if (
            !session ||
            session.generation !== attempt.generation ||
            session.state === "CLOSED" ||
            session.state === "CLOSING"
          ) {
            return null;
          }
          session.state = exitCode === 0 ? "CLOSED" : "FAILED";
          session.closedAt = new Date().toISOString();
          session.updatedAt = session.closedAt;
          session.failureReason =
            reason ?? (exitCode === 0 ? null : `exit ${exitCode}`);
          session.runtimeId = null;
          session.writeLease = null;
          session.attachments = [];
          return {
            state: session.state,
            failureReason: session.failureReason,
          } as const;
        });
        if (ended) {
          this.endOutputSubscriptions(
            attempt.sessionId,
            ended.state,
            ended.failureReason,
          );
        }
        const current = findSession(await this.store.read(), attempt.sessionId);
        if (
          current?.generation === attempt.generation &&
          (current.state === "CLOSED" || current.state === "FAILED")
        ) {
          await this.recorder?.end(attempt.sessionId);
        }
      },
    };
  }

  private async appendOutput(
    sessionId: string,
    data: string,
    attempt: RuntimeAttempt,
  ): Promise<void> {
    if (!this.isCurrentAttempt(attempt)) return;
    const beforeWrite = findSession(await this.store.read(), sessionId);
    if (beforeWrite?.generation !== attempt.generation) return;
    await this.recorder?.recordOutput(sessionId, data);
    if (!this.isCurrentAttempt(attempt)) return;
    const chunk = await this.store.update((state) => {
      const session = findSession(state, sessionId);
      if (!session || session.generation !== attempt.generation) return null;
      const chunk: OutputChunk = {
        generation: session.generation,
        sequence: session.nextSequence++,
        data,
        timestamp: new Date().toISOString(),
      };
      session.output.push(chunk);
      let size = session.output.reduce(
        (total, chunk) => total + Buffer.byteLength(chunk.data),
        0,
      );
      while (size > MAX_OUTPUT_BYTES && session.output.length > 1) {
        size -= Buffer.byteLength(session.output.shift()!.data);
      }
      session.updatedAt = new Date().toISOString();
      return structuredClone(chunk);
    });
    if (!chunk) return;
    for (const subscriber of this.outputSubscribers.get(sessionId) ?? []) {
      if (subscriber.ended) continue;
      try {
        void Promise.resolve(subscriber.onOutput(structuredClone(chunk))).catch(
          () => undefined,
        );
      } catch {
        // 单个浏览器监听器异常不能阻塞 SSH 输出流。
      }
    }
  }

  private beginRuntimeAttempt(
    sessionId: string,
    generation: number,
  ): RuntimeAttempt {
    this.ephemeralWriteLeases.delete(sessionId);
    if (this.runtimeAttempts.has(sessionId)) {
      throw new Error(`Session ${sessionId} already has a local runtime`);
    }
    const attempt: RuntimeAttempt = {
      id: crypto.randomUUID(),
      sessionId,
      generation,
    };
    this.runtimeAttempts.set(sessionId, attempt);
    return attempt;
  }

  private isCurrentAttempt(attempt: RuntimeAttempt): boolean {
    return this.runtimeAttempts.get(attempt.sessionId)?.id === attempt.id;
  }

  private clearRuntimeAttempt(attempt: RuntimeAttempt): boolean {
    if (!this.isCurrentAttempt(attempt)) return false;
    this.runtimeAttempts.delete(attempt.sessionId);
    return true;
  }

  private clearSessionRuntimeAttempt(sessionId: string): void {
    this.runtimeAttempts.delete(sessionId);
    this.ephemeralWriteLeases.delete(sessionId);
  }

  private async withSessionControl<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.sessionControlTails.get(sessionId);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.sessionControlTails.set(sessionId, gate);
    if (previous) await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.sessionControlTails.get(sessionId) === gate) {
        this.sessionControlTails.delete(sessionId);
      }
    }
  }

  private async closeAbandonedRuntime(runtimeId: string): Promise<void> {
    try {
      await this.driver.close(runtimeId);
    } catch {
      // 运行时可能已在返回句柄前退出；此时驱动回调已经完成清理。
    }
  }

  private async requireSession(
    principal: AgentPrincipal,
    sessionId: string,
  ): Promise<AgentSessionRecord> {
    const session = (await this.store.read()).sessions.find(
      (candidate) => candidate.id === sessionId,
    );
    if (!session || !canAccessProject(principal, session.projectId)) {
      throw new AgentApiError(404, "SESSION_NOT_FOUND", "会话不存在");
    }
    assertServerAccess(principal, session.serverId);
    return session;
  }

  /**
   * 校验并续期网页终端的高频写入租约。
   *
   * 首次输入会从持久状态建立快照，之后以进程内快照作为当前 Broker 的
   * 权威短租约，并按租约时长的三分之一批量回写。所有会改变附件、租约
   * 或运行时代次的路径都会先清除此快照，因此旧写者无法借缓存绕过接管。
   */
  private async requireEphemeralWriteLease(
    principal: AgentPrincipal,
    sessionId: string,
    attachmentId: string,
    leaseId: string,
  ): Promise<EphemeralWriteLeaseSnapshot> {
    const now = Date.now();
    const cached = this.ephemeralWriteLeases.get(sessionId);
    const cacheMatches = Boolean(
      cached &&
      cached.principalId === principal.principalId &&
      cached.attachmentId === attachmentId &&
      cached.leaseId === leaseId,
    );

    if (cacheMatches && cached && cached.expiresAt > now) {
      // 活跃输入本身就是租约心跳；持久层只需按固定窗口批量同步。
      cached.expiresAt = now + this.leaseMs;
      if (now < cached.nextPersistAt) return cached;
      return this.persistEphemeralWriteLease(
        principal,
        sessionId,
        attachmentId,
        leaseId,
        now,
        true,
      );
    }

    this.ephemeralWriteLeases.delete(sessionId);
    return this.persistEphemeralWriteLease(
      principal,
      sessionId,
      attachmentId,
      leaseId,
      now,
      false,
    );
  }

  private async persistEphemeralWriteLease(
    principal: AgentPrincipal,
    sessionId: string,
    attachmentId: string,
    leaseId: string,
    now: number,
    allowPersistedExpiry: boolean,
  ): Promise<EphemeralWriteLeaseSnapshot> {
    const snapshot = await this.store.update((state) => {
      const session = findSession(state, sessionId);
      if (!session || !canAccessProject(principal, session.projectId)) {
        throw new AgentApiError(404, "SESSION_NOT_FOUND", "会话不存在");
      }
      assertServerAccess(principal, session.serverId);
      if (!session.runtimeId || session.state !== "RUNNING") {
        throw new AgentApiError(409, "SESSION_NOT_RUNNING", "会话当前不可写入");
      }

      const expectedHolder = `${principal.principalId}:${attachmentId}`;
      const attachment = session.attachments.find(
        (candidate) =>
          candidate.id === attachmentId &&
          candidate.principalId === principal.principalId,
      );
      const persistedExpiry = session.writeLease
        ? Date.parse(session.writeLease.expiresAt)
        : Number.NaN;
      if (
        !attachment ||
        attachment.mode !== "read-write" ||
        !session.writeLease ||
        session.writeLease.id !== leaseId ||
        session.writeLease.holderId !== expectedHolder ||
        (!allowPersistedExpiry &&
          (!Number.isFinite(persistedExpiry) || persistedExpiry <= now))
      ) {
        throw new AgentApiError(
          409,
          "WRITE_LEASE_INVALID",
          "写入租约无效或已过期",
        );
      }

      const timestamp = new Date(now).toISOString();
      const expiresAt = now + this.leaseMs;
      session.writeLease.expiresAt = new Date(expiresAt).toISOString();
      attachment.lastSeenAt = timestamp;
      session.lastDetachedAt = null;
      session.updatedAt = timestamp;
      const recordingSession = structuredClone(session);
      // 录像只读取会话元数据，不能让每个活跃缓存额外复制最多 2 MiB 输出。
      recordingSession.output = [];
      recordingSession.attachments = [];
      return {
        runtimeId: session.runtimeId,
        expiresAt,
        recordingSession,
      };
    });

    const persistInterval = Math.max(1, Math.floor(this.leaseMs / 3));
    const cached: EphemeralWriteLeaseSnapshot = {
      principalId: principal.principalId,
      attachmentId,
      leaseId,
      expiresAt: snapshot.expiresAt,
      nextPersistAt: now + persistInterval,
      runtimeId: snapshot.runtimeId,
      recordingSession: snapshot.recordingSession,
    };
    this.ephemeralWriteLeases.set(sessionId, cached);
    return cached;
  }

  private async requireValidLease(
    principal: AgentPrincipal,
    sessionId: string,
    attachmentId: string,
    leaseId: string,
  ): Promise<void> {
    await this.store.update((state) => {
      const session = findSession(state, sessionId);
      const expectedHolder = `${principal.principalId}:${attachmentId}`;
      const attachment = session?.attachments.find(
        (candidate) =>
          candidate.id === attachmentId &&
          candidate.principalId === principal.principalId,
      );
      const expiresAt = session?.writeLease
        ? Date.parse(session.writeLease.expiresAt)
        : Number.NaN;
      if (
        !attachment ||
        attachment.mode !== "read-write" ||
        !session?.writeLease ||
        session.writeLease.id !== leaseId ||
        session.writeLease.holderId !== expectedHolder ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= Date.now()
      ) {
        throw new AgentApiError(
          409,
          "WRITE_LEASE_INVALID",
          "写入租约无效或已过期",
        );
      }
      const timestamp = new Date().toISOString();
      session.writeLease.expiresAt = new Date(
        Date.now() + this.leaseMs,
      ).toISOString();
      attachment.lastSeenAt = timestamp;
      session.lastDetachedAt = null;
      session.updatedAt = timestamp;
    });
  }

  private async touchAttachment(
    principal: AgentPrincipal,
    sessionId: string,
    attachmentId: string,
  ): Promise<void> {
    await this.store.update((state) => {
      const session = findSession(state, sessionId)!;
      const attachment = session.attachments.find(
        (candidate) =>
          candidate.id === attachmentId &&
          candidate.principalId === principal.principalId,
      );
      if (!attachment) {
        throw new AgentApiError(
          404,
          "ATTACHMENT_NOT_FOUND",
          "附件不存在或不属于当前设备",
        );
      }
      const timestamp = new Date().toISOString();
      attachment.lastSeenAt = timestamp;
      session.lastDetachedAt = null;
      session.updatedAt = timestamp;
    });
  }

  private pruneExpiredAttachments(
    session: AgentSessionRecord,
    now: number,
  ): void {
    const previousCount = session.attachments.length;
    session.attachments = session.attachments.filter(
      (attachment) =>
        Date.parse(attachment.lastSeenAt) + this.attachmentIdleMs > now,
    );
    if (session.attachments.length === previousCount) return;

    if (
      session.writeLease &&
      !session.attachments.some(
        (attachment) =>
          `${attachment.principalId}:${attachment.id}` ===
          session.writeLease!.holderId,
      )
    ) {
      session.writeLease = null;
    }
    const timestamp = new Date(now).toISOString();
    session.lastDetachedAt =
      session.attachments.length === 0 ? timestamp : null;
    session.updatedAt = timestamp;
  }

  private async markFailed(
    sessionId: string,
    error: unknown,
    generation?: number,
  ): Promise<void> {
    this.ephemeralWriteLeases.delete(sessionId);
    const failed = await this.store.update((state) => {
      const session = findSession(state, sessionId);
      if (!session || (generation && session.generation !== generation)) {
        return null;
      }
      session.state = "FAILED";
      session.failureReason =
        error instanceof Error ? error.message : "未知错误";
      session.runtimeId = null;
      session.writeLease = null;
      session.attachments = [];
      session.updatedAt = new Date().toISOString();
      return { failureReason: session.failureReason };
    });
    if (failed) {
      this.endOutputSubscriptions(sessionId, "FAILED", failed.failureReason);
      await this.recorder?.end(sessionId);
    }
  }

  private endOutputSubscriptions(
    sessionId: string,
    state: "CLOSED" | "FAILED",
    failureReason: string | null,
  ): void {
    const subscribers = this.outputSubscribers.get(sessionId);
    this.outputSubscribers.delete(sessionId);
    if (!subscribers) return;
    for (const subscriber of subscribers) {
      this.notifySubscriberEnd(subscriber, { state, failureReason });
    }
  }

  private notifySubscriberEnd(
    subscriber: OutputSubscriber,
    event: {
      state: "CLOSED" | "FAILED";
      failureReason: string | null;
    },
  ): void {
    if (subscriber.ended) return;
    subscriber.ended = true;
    if (!subscriber.onEnd) return;
    try {
      void Promise.resolve(subscriber.onEnd(event)).catch(() => undefined);
    } catch {
      // 单个浏览器结束回调异常不能阻塞会话状态收尾。
    }
  }
}

function currentRuntimeId(
  state: Awaited<ReturnType<AgentStateStore["read"]>>,
  sessionId: string,
): string {
  const runtimeId = findSession(state, sessionId)?.runtimeId;
  if (!runtimeId) {
    throw new AgentApiError(409, "SESSION_NOT_RUNNING", "会话当前不可写入");
  }
  return runtimeId;
}
