import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import type Database from "better-sqlite3";
import { webUserIdFromPrincipal } from "./principal-identity.js";
import type {
  AgentJobRecord,
  AgentPersistentState,
  AgentSessionRecord,
  IdempotencyRecord,
} from "./types.js";

const EMPTY_STATE: AgentPersistentState = {
  version: 1,
  sessions: [],
  jobs: [],
  idempotency: [],
};

const DAY_MS = 24 * 60 * 60 * 1000;
const TERMINAL_SESSION_RETENTION_MS = 30 * DAY_MS;
const TERMINAL_OUTPUT_RETENTION_MS = DAY_MS;
const JOB_RETENTION_MS = 30 * DAY_MS;
const IDEMPOTENCY_RETENTION_MS = 7 * DAY_MS;
const MAX_TERMINAL_SESSIONS = 1_000;
const MAX_JOBS = 1_000;
const MAX_IDEMPOTENCY_RECORDS = 20_000;
const MAX_SESSION_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_RETAINED_JOB_OUTPUT_BYTES = 64 * 1024 * 1024;
const SESSION_CREATE_SEGMENT = ":session:create:";
const PERSISTENT_SESSION_RETENTION_MS = 90 * DAY_MS;

const TERMINAL_SESSION_STATES = new Set<AgentSessionRecord["state"]>([
  "CLOSED",
  "FAILED",
]);
const TERMINAL_JOB_STATES = new Set<AgentJobRecord["state"]>([
  "SUCCEEDED",
  "FAILED",
  "CANCELED",
  "TIMED_OUT",
]);

function timestamp(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function trimSessionOutput(session: AgentSessionRecord): void {
  let bytes = session.output.reduce(
    (total, chunk) => total + Buffer.byteLength(chunk.data),
    0,
  );
  while (bytes > MAX_SESSION_OUTPUT_BYTES && session.output.length > 1) {
    bytes -= Buffer.byteLength(session.output.shift()!.data);
  }
}

function recordReference(record: IdempotencyRecord): {
  sessionId?: string;
  jobId?: string;
} {
  if (!record.response || typeof record.response !== "object") return {};
  const response = record.response as { sessionId?: unknown; jobId?: unknown };
  return {
    sessionId:
      typeof response.sessionId === "string" ? response.sessionId : undefined,
    jobId: typeof response.jobId === "string" ? response.jobId : undefined,
  };
}

function sessionCreateRequestHash(session: AgentSessionRecord): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        serverId: session.serverId,
        cols: session.cols,
        rows: session.rows,
        pinned: session.pinned,
        runtimeMode: session.runtimeMode,
      }),
    )
    .digest("hex");
}

/**
 * 限制高频运行状态文件的长期体积。主库仍保留会话元数据；这里只淘汰
 * 已结束会话的终端输出、过期 Job 和超过防重窗口的通用幂等记录。
 */
export function compactAgentPersistentState(
  state: AgentPersistentState,
  now = Date.now(),
): void {
  const outputCutoff = now - TERMINAL_OUTPUT_RETENTION_MS;
  const sessionCutoff = now - TERMINAL_SESSION_RETENTION_MS;
  const activeSessions: AgentSessionRecord[] = [];
  const terminalSessions: AgentSessionRecord[] = [];
  for (const session of state.sessions) {
    trimSessionOutput(session);
    if (!TERMINAL_SESSION_STATES.has(session.state)) {
      activeSessions.push(session);
      continue;
    }
    if (timestamp(session.updatedAt) < outputCutoff) session.output = [];
    if (timestamp(session.updatedAt) >= sessionCutoff) {
      terminalSessions.push(session);
    }
  }
  terminalSessions.sort(
    (left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt),
  );
  state.sessions = [
    ...activeSessions,
    ...terminalSessions.slice(0, MAX_TERMINAL_SESSIONS),
  ];

  const activeJobs: AgentJobRecord[] = [];
  const terminalJobs: AgentJobRecord[] = [];
  for (const job of state.jobs) {
    if (!TERMINAL_JOB_STATES.has(job.state)) {
      activeJobs.push(job);
      continue;
    }
    if (timestamp(job.finishedAt ?? job.createdAt) >= now - JOB_RETENTION_MS) {
      terminalJobs.push(job);
    }
  }
  terminalJobs.sort(
    (left, right) =>
      timestamp(right.finishedAt ?? right.createdAt) -
      timestamp(left.finishedAt ?? left.createdAt),
  );
  state.jobs = [...activeJobs, ...terminalJobs.slice(0, MAX_JOBS)];

  let retainedJobOutputBytes = 0;
  for (const job of [...state.jobs].sort(
    (left, right) =>
      timestamp(right.finishedAt ?? right.createdAt) -
      timestamp(left.finishedAt ?? left.createdAt),
  )) {
    const outputBytes =
      Buffer.byteLength(job.stdout) + Buffer.byteLength(job.stderr);
    if (retainedJobOutputBytes + outputBytes > MAX_RETAINED_JOB_OUTPUT_BYTES) {
      job.stdout = "";
      job.stderr = "";
      continue;
    }
    retainedJobOutputBytes += outputBytes;
  }

  const sessionIds = new Set(state.sessions.map((session) => session.id));
  const jobIds = new Set(state.jobs.map((job) => job.id));
  const protectedRecords: IdempotencyRecord[] = [];
  const recentRecords: IdempotencyRecord[] = [];
  for (const record of state.idempotency) {
    const reference = recordReference(record);
    if (
      (record.key.includes(SESSION_CREATE_SEGMENT) &&
        reference.sessionId &&
        sessionIds.has(reference.sessionId)) ||
      (record.key.includes(":job:create:") &&
        reference.jobId &&
        jobIds.has(reference.jobId))
    ) {
      protectedRecords.push(record);
    } else if (timestamp(record.createdAt) >= now - IDEMPOTENCY_RETENTION_MS) {
      recentRecords.push(record);
    }
  }
  recentRecords.sort(
    (left, right) => timestamp(right.createdAt) - timestamp(left.createdAt),
  );
  state.idempotency = [...protectedRecords, ...recentRecords];
}

export function hasIdempotencyCapacity(state: AgentPersistentState): boolean {
  return state.idempotency.length < MAX_IDEMPOTENCY_RECORDS;
}

export interface AgentStateStore {
  read(): Promise<AgentPersistentState>;
  update<T>(
    mutator: (state: AgentPersistentState) => T | Promise<T>,
  ): Promise<T>;
}

function cloneState(state: AgentPersistentState): AgentPersistentState {
  return structuredClone(state);
}

export class MemoryAgentStateStore implements AgentStateStore {
  private state = cloneState(EMPTY_STATE);
  private queue: Promise<unknown> = Promise.resolve();

  async read(): Promise<AgentPersistentState> {
    await this.queue;
    return cloneState(this.state);
  }

  update<T>(
    mutator: (state: AgentPersistentState) => T | Promise<T>,
  ): Promise<T> {
    const operation = this.queue.then(async () => {
      const draft = cloneState(this.state);
      compactAgentPersistentState(draft);
      const result = await mutator(draft);
      compactAgentPersistentState(draft);
      this.state = draft;
      return result;
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}

export class JsonAgentStateStore implements AgentStateStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async read(): Promise<AgentPersistentState> {
    await this.queue;
    return this.load();
  }

  update<T>(
    mutator: (state: AgentPersistentState) => T | Promise<T>,
  ): Promise<T> {
    const operation = this.queue.then(async () => {
      const state = await this.load();
      compactAgentPersistentState(state);
      const result = await mutator(state);
      compactAgentPersistentState(state);
      await this.save(state);
      return result;
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async load(): Promise<AgentPersistentState> {
    try {
      const parsed = JSON.parse(
        await fs.readFile(this.filePath, "utf8"),
      ) as AgentPersistentState;
      if (parsed.version !== 1) throw new Error("unsupported state version");
      for (const session of parsed.sessions) {
        session.attachments ??= [];
        if (
          session.runtimeMode !== "platform" &&
          session.runtimeMode !== "tmux"
        ) {
          session.runtimeMode = "tmux";
        }
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return cloneState(EMPTY_STATE);
      }
      throw error;
    }
  }

  private async save(state: AgentPersistentState): Promise<void> {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    let renamed = false;
    try {
      const handle = await fs.open(temporaryPath, "w", 0o600);
      try {
        await handle.writeFile(JSON.stringify(state, null, 2), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporaryPath, this.filePath);
      renamed = true;
      const directoryHandle = await fs.open(directory, "r").catch(() => null);
      try {
        await directoryHandle?.sync().catch(() => undefined);
      } finally {
        await directoryHandle?.close();
      }
    } finally {
      if (!renamed) await fs.rm(temporaryPath, { force: true });
    }
  }
}

interface PersistentSessionRow {
  id: string;
  projectId: string;
  serverId: string;
  serviceAccountId: string;
  state: AgentSessionRecord["state"];
  runtimeId: string | null;
  runtimeMode: AgentSessionRecord["runtimeMode"];
  tmuxSessionName: string;
  cols: number;
  rows: number;
  pinned: number;
  generation: number;
  nextSequence: number;
  lastAttachedAt: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  idempotencyKey: string | null;
  principalId: string | null;
}

function isProjectScopedSessionCreateKey(
  key: string,
  projectId: string,
): boolean {
  return key.includes(`:project:${projectId}${SESSION_CREATE_SEGMENT}`);
}

function restoredSessionCreateKey(row: PersistentSessionRow): string {
  if (
    row.idempotencyKey &&
    isProjectScopedSessionCreateKey(row.idempotencyKey, row.projectId)
  ) {
    return row.idempotencyKey;
  }
  const legacyPrefix = `${row.serviceAccountId}${SESSION_CREATE_SEGMENT}`;
  const clientKey = row.idempotencyKey?.startsWith(legacyPrefix)
    ? row.idempotencyKey.slice(legacyPrefix.length)
    : row.idempotencyKey;
  if (row.principalId && clientKey) {
    return `${row.principalId}:project:${row.projectId}:session:create:${clientKey}`;
  }
  return `${row.serviceAccountId}:session:create:${row.idempotencyKey}`;
}

function sessionCreateIdempotencyRecords(
  state: AgentPersistentState,
  sessionId: string,
): IdempotencyRecord[] {
  return state.idempotency.filter((record) => {
    const response = record.response as { sessionId?: string } | null;
    return (
      record.key.includes(SESSION_CREATE_SEGMENT) &&
      response?.sessionId === sessionId
    );
  });
}

function sessionCreateIdempotency(
  state: AgentPersistentState,
  session: AgentSessionRecord,
): IdempotencyRecord | undefined {
  const records = sessionCreateIdempotencyRecords(state, session.id);
  return (
    records.find((record) =>
      isProjectScopedSessionCreateKey(record.key, session.projectId),
    ) ?? records[0]
  );
}

/**
 * SQLite 保存控制面可查询的会话和租约；流输出、Job 与幂等结果保存到
 * 权限受限的 sidecar 文件。这样不需要把高频终端输出写入主数据库。
 */
export class SqliteBackedAgentStateStore implements AgentStateStore {
  private readonly sidecar: JsonAgentStateStore;
  private initialized: Promise<void> | null = null;

  constructor(
    filePath: string,
    private readonly sqlite: Database.Database,
    private readonly onWrite?: () => void | Promise<void>,
  ) {
    this.sidecar = new JsonAgentStateStore(filePath);
  }

  async read(): Promise<AgentPersistentState> {
    await this.ensureInitialized();
    return this.sidecar.read();
  }

  async update<T>(
    mutator: (state: AgentPersistentState) => T | Promise<T>,
  ): Promise<T> {
    await this.ensureInitialized();
    const result = await this.sidecar.update(mutator);
    const state = await this.sidecar.read();
    this.syncSessions(state);
    await this.onWrite?.();
    return result;
  }

  async cleanupPersistentHistory(now = Date.now()): Promise<number> {
    await this.ensureInitialized();
    const cutoff = new Date(
      now - PERSISTENT_SESSION_RETENTION_MS,
    ).toISOString();
    const result = this.sqlite
      .prepare(
        `DELETE FROM persistent_sessions
          WHERE service_account_id IS NOT NULL
            AND state IN ('CLOSED', 'FAILED')
            AND updated_at < ?
            AND NOT EXISTS (
              SELECT 1 FROM project_session_recordings recording
               WHERE recording.session_id = persistent_sessions.id
                 AND (
                   recording.ended_at IS NULL
                   OR recording.mode = 'full'
                 )
            )`,
      )
      .run(cutoff);
    if (result.changes > 0) await this.onWrite?.();
    return result.changes;
  }

  private ensureInitialized(): Promise<void> {
    if (!this.initialized) this.initialized = this.hydrateFromSqlite();
    return this.initialized;
  }

  private async hydrateFromSqlite(): Promise<void> {
    // 附件和 Agent 写租约只在当前 Broker 进程内有效，重启后一律失效。
    this.sqlite
      .prepare(
        `DELETE FROM session_write_leases
          WHERE session_id IN (
            SELECT id FROM persistent_sessions
             WHERE service_account_id IS NOT NULL
          )`,
      )
      .run();
    const sidecarCutoff = new Date(
      Date.now() - TERMINAL_SESSION_RETENTION_MS,
    ).toISOString();
    const rows = this.sqlite
      .prepare(
        `SELECT
           session.id,
           session.project_id AS projectId,
           CAST(project_host.id AS TEXT) AS serverId,
           session.service_account_id AS serviceAccountId,
           session.state,
           session.runtime_id AS runtimeId,
           session.runtime_mode AS runtimeMode,
           session.tmux_name AS tmuxSessionName,
           session.columns AS cols,
           session.rows,
           session.pinned,
           session.stream_generation AS generation,
           session.last_sequence AS nextSequence,
           session.last_attached_at AS lastAttachedAt,
           session.failure_reason AS failureReason,
           session.created_at AS createdAt,
           session.updated_at AS updatedAt,
           session.closed_at AS closedAt,
           session.idempotency_key AS idempotencyKey,
           COALESCE(
             (SELECT 'device:' || grant_row.device_id
                FROM agent_device_projects grant_row
               WHERE grant_row.project_id = session.project_id
                 AND grant_row.service_account_id = session.service_account_id
               LIMIT 1),
             (SELECT 'token:' || token_project.token_id
                FROM agent_token_projects token_project
               WHERE token_project.project_id = session.project_id
                 AND token_project.service_account_id = session.service_account_id
               LIMIT 1)
           ) AS principalId
         FROM persistent_sessions session
         JOIN project_hosts project_host
           ON project_host.id = session.project_host_id
         WHERE session.service_account_id IS NOT NULL
           AND (
             session.state NOT IN ('CLOSED', 'FAILED')
             OR session.updated_at >= ?
           )`,
      )
      .all(sidecarCutoff) as PersistentSessionRow[];
    await this.sidecar.update((state) => {
      for (const row of rows) {
        const previous = findSession(state, row.id);
        const session: AgentSessionRecord = {
          id: row.id,
          projectId: row.projectId,
          serverId: row.serverId,
          serviceAccountId: row.serviceAccountId,
          state: row.state,
          cols: row.cols,
          rows: row.rows,
          pinned: row.pinned === 1,
          runtimeMode: row.runtimeMode,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          lastDetachedAt: row.lastAttachedAt,
          closedAt: row.closedAt,
          failureReason: row.failureReason,
          generation: row.generation,
          nextSequence: row.nextSequence,
          output: previous?.output ?? [],
          // 附件标识仅在当前进程有效，重启后必须重新附着并申请租约。
          attachments: [],
          writeLease: null,
          runtimeId: row.runtimeId,
          tmuxSessionName: row.tmuxSessionName,
        };
        if (!previous) {
          state.sessions.push(session);
        } else {
          // sidecar 是 Agent 会话状态的权威来源，主库仅提供控制面镜像。
          previous.attachments = [];
          previous.writeLease = null;
          previous.runtimeMode ??= row.runtimeMode;
        }

        if (row.idempotencyKey) {
          const previousRecords = sessionCreateIdempotencyRecords(
            state,
            row.id,
          );
          const existingCanonical = previousRecords.find((record) =>
            isProjectScopedSessionCreateKey(record.key, row.projectId),
          );
          const key = existingCanonical?.key ?? restoredSessionCreateKey(row);
          const sourceRecord =
            existingCanonical ?? previousRecords.at(0) ?? null;
          state.idempotency = state.idempotency.filter(
            (record) => !previousRecords.includes(record),
          );
          const hashSession = {
            ...session,
            runtimeMode: previous?.runtimeMode ?? row.runtimeMode,
          };
          // 旧版创建哈希缺少 runtimeMode。sidecar 中存在原始记录时必须
          // 原样保留，否则 resize 后再按当前尺寸重算会破坏幂等重试。
          const restoredRequestHash =
            sourceRecord?.requestHash ?? sessionCreateRequestHash(hashSession);
          state.idempotency.push({
            key,
            requestHash: restoredRequestHash,
            response: { sessionId: row.id },
            createdAt: sourceRecord?.createdAt ?? row.createdAt,
          });
        }
      }
    });
    const mergedState = await this.sidecar.read();
    this.syncSessions(mergedState);
    await this.onWrite?.();
  }

  private syncSessions(state: AgentPersistentState): void {
    const findProjectHost = this.sqlite.prepare(
      `SELECT id FROM project_hosts
       WHERE project_id = ? AND CAST(id AS TEXT) = ?`,
    );
    const upsertSession = this.sqlite.prepare(
      `INSERT INTO persistent_sessions (
         id, project_id, project_host_id, owner_user_id, service_account_id,
         state, runtime_id, runtime_mode, tmux_name, columns, rows, pinned,
         stream_generation, last_sequence, idempotency_key, last_attached_at,
         retain_until, failure_reason, created_at, updated_at, closed_at
       ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         state = excluded.state,
         runtime_id = excluded.runtime_id,
         runtime_mode = excluded.runtime_mode,
         columns = excluded.columns,
         rows = excluded.rows,
         pinned = excluded.pinned,
         stream_generation = excluded.stream_generation,
         last_sequence = excluded.last_sequence,
         idempotency_key = excluded.idempotency_key,
         last_attached_at = excluded.last_attached_at,
         retain_until = excluded.retain_until,
         failure_reason = excluded.failure_reason,
         updated_at = excluded.updated_at,
         closed_at = excluded.closed_at`,
    );
    const upsertLease = this.sqlite.prepare(
      `INSERT INTO session_write_leases (
         session_id, holder_type, holder_user_id, holder_service_account_id,
         lease_id, lease_token_hash, version, acquired_at, expires_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         holder_type = excluded.holder_type,
         holder_user_id = excluded.holder_user_id,
         holder_service_account_id = excluded.holder_service_account_id,
         lease_id = excluded.lease_id,
         lease_token_hash = excluded.lease_token_hash,
         version = session_write_leases.version + 1,
         acquired_at = excluded.acquired_at,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
    );
    const deleteLease = this.sqlite.prepare(
      "DELETE FROM session_write_leases WHERE session_id = ?",
    );

    this.sqlite.transaction(() => {
      for (const session of state.sessions) {
        const projectHost = findProjectHost.get(
          session.projectId,
          session.serverId,
        ) as { id: number } | undefined;
        if (!projectHost) {
          throw new Error(
            `Host ${session.serverId} is not associated with project ${session.projectId}`,
          );
        }
        const idempotency = sessionCreateIdempotency(state, session);
        const retainFrom = session.lastDetachedAt ?? session.createdAt;
        const retainUntil = session.pinned
          ? null
          : new Date(
              Date.parse(retainFrom) + 24 * 60 * 60 * 1000,
            ).toISOString();
        upsertSession.run(
          session.id,
          session.projectId,
          projectHost.id,
          session.serviceAccountId,
          session.state,
          session.runtimeId,
          session.runtimeMode,
          session.tmuxSessionName,
          session.cols,
          session.rows,
          session.pinned ? 1 : 0,
          session.generation,
          session.nextSequence,
          idempotency?.key ?? null,
          session.lastDetachedAt,
          retainUntil,
          session.failureReason,
          session.createdAt,
          session.updatedAt,
          session.closedAt,
        );

        if (session.writeLease) {
          const holderUserId = webUserIdFromPrincipal(
            session.writeLease.holderId,
          );
          const leaseHash = crypto
            .createHash("sha256")
            .update(session.writeLease.id)
            .digest("hex");
          upsertLease.run(
            session.id,
            holderUserId ? "user" : "service_account",
            holderUserId,
            holderUserId ? null : session.serviceAccountId,
            session.writeLease.id,
            leaseHash,
            session.writeLease.acquiredAt,
            session.writeLease.expiresAt,
            session.updatedAt,
          );
        } else {
          deleteLease.run(session.id);
        }
      }
    })();
  }
}

export function findSession(
  state: AgentPersistentState,
  sessionId: string,
): AgentSessionRecord | undefined {
  return state.sessions.find((session) => session.id === sessionId);
}

export function findJob(
  state: AgentPersistentState,
  jobId: string,
): AgentJobRecord | undefined {
  return state.jobs.find((job) => job.id === jobId);
}

export function findIdempotency(
  state: AgentPersistentState,
  key: string,
): IdempotencyRecord | undefined {
  return state.idempotency.find((record) => record.key === key);
}
