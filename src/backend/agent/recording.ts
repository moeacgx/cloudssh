import crypto from "crypto";
import { constants, createReadStream, promises as fs } from "fs";
import path from "path";
import { createInterface } from "readline";
import type Database from "better-sqlite3";
import { apiLogger } from "../utils/logger.js";
import { AgentApiError } from "./errors.js";
import { webUserIdFromPrincipal } from "./principal-identity.js";
import type { AgentPrincipal, AgentSessionRecord } from "./types.js";

const TEAM_RECORDING_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RECORDING_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_STORAGE_BYTES = 5 * 1024 * 1024 * 1024;
const STORAGE_KEY_PATTERN = /^agent\/recordings\/[a-f0-9]{64}\.jsonl$/;
const RECORDING_FILE_PATTERN = /^[a-f0-9]{64}\.jsonl$/;

export interface AgentSessionRecorder {
  start(session: AgentSessionRecord): Promise<void>;
  recordInput(
    session: AgentSessionRecord,
    principal: AgentPrincipal,
    data: string,
  ): Promise<void>;
  recordOutput(sessionId: string, data: string): Promise<void>;
  end(sessionId: string): Promise<void>;
  checkpointActive?(): Promise<number>;
  reconcileDangling?(): Promise<number>;
  cleanupExpired?(now?: number): Promise<number>;
}

export interface AgentRecordingOptions {
  maxRecordingBytes?: number;
  maxStorageBytes?: number;
}

interface RecordingRow {
  projectId: string;
  mode: "metadata" | "full";
  storageKey: string | null;
  sizeBytes: number;
  checksum: string | null;
  startedAt: string;
  endedAt: string | null;
  retainUntil: string | null;
}

interface FileMetadata {
  sizeBytes: number;
  checksum: string;
}

type LifecycleEvent = "session_started" | "session_ended";

class RecordingQuotaError extends Error {}

function positiveByteLimit(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function actorServiceAccountId(
  session: AgentSessionRecord,
  principal: AgentPrincipal,
): string {
  return (
    principal.serverServiceAccountIds?.[session.serverId] ??
    principal.projectServiceAccountIds?.[session.projectId] ??
    principal.serviceAccountId
  );
}

export class SqliteAgentSessionRecorder implements AgentSessionRecorder {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly knownEvents = new Map<string, Set<LifecycleEvent>>();
  private storageQueue: Promise<unknown> = Promise.resolve();
  private storageUsageBytes: number | null = null;
  private readonly maxRecordingBytes: number;
  private readonly maxStorageBytes: number;

  constructor(
    private readonly sqlite: Database.Database,
    private readonly dataDirectory: string,
    private readonly onWrite?: () => void | Promise<void>,
    options: AgentRecordingOptions = {},
  ) {
    this.maxRecordingBytes =
      options.maxRecordingBytes ??
      positiveByteLimit(
        process.env.AGENT_RECORDING_MAX_BYTES,
        DEFAULT_MAX_RECORDING_BYTES,
      );
    this.maxStorageBytes =
      options.maxStorageBytes ??
      positiveByteLimit(
        process.env.AGENT_RECORDING_STORAGE_MAX_BYTES,
        DEFAULT_MAX_STORAGE_BYTES,
      );
  }

  async start(session: AgentSessionRecord): Promise<void> {
    await this.enqueue(session.id, async () => {
      let row = this.row(session.id);
      if (row && row.projectId !== session.projectId) {
        throw new Error("Agent recording belongs to another project");
      }

      if (!row) {
        const project = this.sqlite
          .prepare("SELECT kind FROM projects WHERE id = ?")
          .get(session.projectId) as { kind: "personal" | "team" } | undefined;
        if (!project) throw new Error("Agent recording project is missing");

        const mode = project.kind === "team" ? "full" : "metadata";
        const storageKey =
          mode === "full" ? this.storageKeyFor(session.id) : null;
        const result = this.sqlite
          .prepare(
            `INSERT OR IGNORE INTO project_session_recordings (
               id, session_id, project_id, mode, storage_key, size_bytes,
               started_at, retain_until
             ) VALUES (?, ?, ?, ?, ?, 0, ?, NULL)`,
          )
          .run(
            crypto.randomUUID(),
            session.id,
            session.projectId,
            mode,
            storageKey,
            session.createdAt,
          );
        row = this.row(session.id);
        if (!row) throw new Error("Agent recording could not be created");
        if (row.projectId !== session.projectId) {
          throw new Error("Agent recording belongs to another project");
        }
        if (result.changes > 0) await this.onWrite?.();
      }

      if (row.mode !== "full" || row.endedAt) return;
      if (!row.storageKey) {
        throw new Error("Full agent recording has no storage key");
      }
      try {
        await this.ensureEvent(session.id, row.storageKey, "session_started", {
          timestamp: row.startedAt,
          direction: "system",
          event: "session_started",
          serviceAccountId: session.serviceAccountId,
          projectHostId: session.serverId,
        });
      } catch (error) {
        await this.finalizeAfterFailure(session.id, row, error);
        throw error;
      }
    });
  }

  async recordInput(
    session: AgentSessionRecord,
    principal: AgentPrincipal,
    data: string,
  ): Promise<void> {
    const actorUserId = webUserIdFromPrincipal(principal.principalId);
    await this.appendActive(
      session.id,
      {
        timestamp: new Date().toISOString(),
        direction: "input",
        data,
        serviceAccountId: actorServiceAccountId(session, principal),
        agentName: principal.name,
        actorType: actorUserId ? "user" : "service_account",
        userId: actorUserId ?? undefined,
      },
      true,
    );
  }

  async recordOutput(sessionId: string, data: string): Promise<void> {
    await this.appendActive(
      sessionId,
      {
        timestamp: new Date().toISOString(),
        direction: "output",
        data,
      },
      false,
    );
  }

  async end(sessionId: string): Promise<void> {
    await this.enqueue(sessionId, async () => {
      const row = this.row(sessionId);
      if (!row) return;

      const endedAt = row.endedAt ?? new Date().toISOString();
      let sizeBytes = 0;
      let checksum: string | null = null;
      let retainUntil: string | null = null;
      let recordingError: unknown;

      if (row.mode === "full") {
        if (!row.storageKey) {
          recordingError = new Error("Full agent recording has no storage key");
        } else {
          try {
            await this.ensureEvent(
              sessionId,
              row.storageKey,
              "session_started",
              {
                timestamp: row.startedAt,
                direction: "system",
                event: "session_started",
              },
            );
            await this.ensureEvent(sessionId, row.storageKey, "session_ended", {
              timestamp: endedAt,
              direction: "system",
              event: "session_ended",
            });
          } catch (error) {
            recordingError = error;
          }
          const metadata = await this.safeFileMetadata(row.storageKey);
          sizeBytes = metadata?.sizeBytes ?? row.sizeBytes;
          checksum = metadata?.checksum ?? null;
        }
        retainUntil = this.retentionDeadline(endedAt);
      }

      try {
        await this.persistEnd(
          sessionId,
          row,
          endedAt,
          sizeBytes,
          checksum,
          retainUntil,
        );
      } catch (error) {
        recordingError ??= error;
      }
      if (recordingError) {
        this.logRecordingFailure(sessionId, recordingError);
      }
    });
  }

  async checkpointActive(): Promise<number> {
    const active = this.sqlite
      .prepare(
        `SELECT session_id AS sessionId
           FROM project_session_recordings
          WHERE mode = 'full'
            AND ended_at IS NULL`,
      )
      .all() as Array<{ sessionId: string }>;
    let checkpointed = 0;

    for (const candidate of active) {
      const changed = await this.enqueue(candidate.sessionId, async () => {
        const row = this.row(candidate.sessionId);
        if (row?.mode !== "full" || row.endedAt !== null) return false;
        if (!row.storageKey) {
          throw new Error("Full agent recording has no storage key");
        }
        const metadata = await this.fileMetadata(row.storageKey);
        if (
          row.sizeBytes === metadata.sizeBytes &&
          row.checksum === metadata.checksum
        ) {
          return false;
        }
        this.sqlite
          .prepare(
            `UPDATE project_session_recordings
                SET size_bytes = ?, checksum = ?
              WHERE session_id = ? AND ended_at IS NULL`,
          )
          .run(metadata.sizeBytes, metadata.checksum, candidate.sessionId);
        await this.onWrite?.();
        return true;
      });
      if (changed) checkpointed += 1;
    }
    return checkpointed;
  }

  async reconcileDangling(): Promise<number> {
    const hasPersistentSessions = this.sqlite
      .prepare(
        `SELECT 1
           FROM sqlite_master
          WHERE type = 'table' AND name = 'persistent_sessions'`,
      )
      .get();
    if (!hasPersistentSessions) return 0;

    const dangling = this.sqlite
      .prepare(
        `SELECT recording.session_id AS sessionId
           FROM project_session_recordings recording
           LEFT JOIN persistent_sessions session
             ON session.id = recording.session_id
          WHERE recording.ended_at IS NULL
            AND (session.id IS NULL OR session.state IN ('CLOSING', 'CLOSED', 'FAILED'))`,
      )
      .all() as Array<{ sessionId: string }>;
    for (const recording of dangling) {
      await this.end(recording.sessionId);
    }
    return dangling.filter(({ sessionId }) =>
      Boolean(this.row(sessionId)?.endedAt),
    ).length;
  }

  async cleanupExpired(now = Date.now()): Promise<number> {
    const cutoff = new Date(now).toISOString();
    const expired = this.sqlite
      .prepare(
        `SELECT session_id AS sessionId
           FROM project_session_recordings
          WHERE ended_at IS NOT NULL
            AND retain_until IS NOT NULL
            AND retain_until <= ?`,
      )
      .all(cutoff) as Array<{ sessionId: string }>;
    let removed = 0;

    for (const candidate of expired) {
      const deleted = await this.enqueue(candidate.sessionId, async () => {
        const row = this.row(candidate.sessionId);
        if (!row?.endedAt || !row.retainUntil || row.retainUntil > cutoff) {
          return false;
        }
        if (row.storageKey) {
          await this.unlinkRecording(row.storageKey);
        }
        const result = this.sqlite
          .prepare(
            `DELETE FROM project_session_recordings
              WHERE session_id = ?
                AND ended_at IS NOT NULL
                AND retain_until IS NOT NULL
                AND retain_until <= ?`,
          )
          .run(candidate.sessionId, cutoff);
        if (result.changes > 0) {
          this.knownEvents.delete(candidate.sessionId);
        }
        return result.changes > 0;
      });
      if (deleted) removed += 1;
    }

    if (removed > 0) await this.onWrite?.();
    return removed;
  }

  private async appendActive(
    sessionId: string,
    event: Record<string, unknown>,
    required: boolean,
  ): Promise<void> {
    await this.enqueue(sessionId, async () => {
      const row = this.row(sessionId);
      if (row?.mode !== "full") return;
      if (row.endedAt !== null) {
        if (required) throw this.recordingUnavailable();
        return;
      }
      try {
        if (!row.storageKey) {
          throw new Error("Full agent recording has no storage key");
        }
        await this.ensureEvent(sessionId, row.storageKey, "session_started", {
          timestamp: row.startedAt,
          direction: "system",
          event: "session_started",
        });
        await this.appendEvent(row.storageKey, event);
      } catch (error) {
        await this.finalizeAfterFailure(sessionId, row, error);
        if (required) throw this.recordingUnavailable();
      }
    });
  }

  private enqueue<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(sessionId, tail);
    return result.finally(() => {
      if (this.queues.get(sessionId) === tail) {
        this.queues.delete(sessionId);
      }
    });
  }

  private row(sessionId: string): RecordingRow | null {
    return (
      (this.sqlite
        .prepare(
          `SELECT project_id AS projectId, mode,
                  storage_key AS storageKey, size_bytes AS sizeBytes,
                  checksum, started_at AS startedAt, ended_at AS endedAt,
                  retain_until AS retainUntil
             FROM project_session_recordings
            WHERE session_id = ?`,
        )
        .get(sessionId) as RecordingRow | undefined) ?? null
    );
  }

  private async finalizeAfterFailure(
    sessionId: string,
    row: RecordingRow,
    error: unknown,
  ): Promise<void> {
    const endedAt = new Date().toISOString();
    const metadata = row.storageKey
      ? await this.safeFileMetadata(row.storageKey)
      : null;
    try {
      await this.persistEnd(
        sessionId,
        row,
        endedAt,
        metadata?.sizeBytes ?? row.sizeBytes,
        metadata?.checksum ?? null,
        row.mode === "full" ? this.retentionDeadline(endedAt) : null,
      );
    } catch (persistError) {
      this.logRecordingFailure(sessionId, persistError);
    }
    this.logRecordingFailure(sessionId, error);
  }

  private async persistEnd(
    sessionId: string,
    row: RecordingRow,
    endedAt: string,
    sizeBytes: number,
    checksum: string | null,
    retainUntil: string | null,
  ): Promise<void> {
    const changed =
      row.endedAt !== endedAt ||
      row.sizeBytes !== sizeBytes ||
      row.checksum !== checksum ||
      row.retainUntil !== retainUntil;
    if (!changed) return;

    this.sqlite
      .prepare(
        `UPDATE project_session_recordings
            SET ended_at = ?, size_bytes = ?, checksum = ?, retain_until = ?
          WHERE session_id = ?`,
      )
      .run(endedAt, sizeBytes, checksum, retainUntil, sessionId);
    await this.onWrite?.();
  }

  private retentionDeadline(endedAt: string): string {
    const endedTime = Date.parse(endedAt);
    const retentionStart = Number.isFinite(endedTime) ? endedTime : Date.now();
    return new Date(retentionStart + TEAM_RECORDING_RETENTION_MS).toISOString();
  }

  private recordingUnavailable(): AgentApiError {
    return new AgentApiError(
      503,
      "SESSION_RECORDING_UNAVAILABLE",
      "团队会话录像不可用，已拒绝终端输入",
    );
  }

  private logRecordingFailure(sessionId: string, error: unknown): void {
    apiLogger.error("CloudSSH Agent recording write failed", {
      operation: "agent_recording_write_failed",
      sessionId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }

  private storageKeyFor(sessionId: string): string {
    const digest = crypto.createHash("sha256").update(sessionId).digest("hex");
    return `agent/recordings/${digest}.jsonl`;
  }

  private absolutePath(storageKey: string): string {
    if (!STORAGE_KEY_PATTERN.test(storageKey)) {
      throw new Error("Invalid agent recording storage key");
    }
    return path.resolve(this.dataDirectory, ...storageKey.split("/"));
  }

  private async ensureRecordingDirectory(): Promise<void> {
    const root = path.resolve(this.dataDirectory);
    await fs.mkdir(root, { recursive: true });
    const realRoot = await fs.realpath(root);
    const agentDirectory = path.join(root, "agent");
    const recordingDirectory = path.join(agentDirectory, "recordings");

    // 按层创建并校验，避免递归创建先跟随恶意目录符号链接。
    await this.ensurePlainDirectory(agentDirectory);
    await this.ensurePlainDirectory(recordingDirectory);

    const realRecordingDirectory = await fs.realpath(recordingDirectory);
    if (
      path.relative(realRoot, realRecordingDirectory) !==
      path.join("agent", "recordings")
    ) {
      throw new Error("Agent recording directory escaped data directory");
    }
  }

  private async ensurePlainDirectory(directory: string): Promise<void> {
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await fs.mkdir(directory, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
          throw mkdirError;
        }
      }
      stat = await fs.lstat(directory);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Agent recording directory must be a real directory");
    }
    await fs.chmod(directory, 0o700).catch(() => undefined);
  }

  private async assertPlainFileIfPresent(
    absolutePath: string,
  ): Promise<boolean> {
    try {
      const stat = await fs.lstat(absolutePath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error("Agent recording must be a regular file");
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async appendEvent(
    storageKey: string,
    event: Record<string, unknown>,
  ): Promise<void> {
    const absolutePath = this.absolutePath(storageKey);
    const line = `${JSON.stringify(event)}\n`;
    const eventBytes = Buffer.byteLength(line);
    await this.withStorageLock(async () => {
      await this.ensureRecordingDirectory();
      await this.assertPlainFileIfPresent(absolutePath);

      // Docker/Linux 下使用 O_NOFOLLOW，封住校验与打开之间的符号链接竞态。
      const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
      const handle = await fs.open(
        absolutePath,
        constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollow,
        0o600,
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) {
          throw new Error("Agent recording must be a regular file");
        }
        const storageUsage = await this.currentStorageUsage();
        if (stat.size + eventBytes > this.maxRecordingBytes) {
          throw new RecordingQuotaError("Agent recording size limit reached");
        }
        if (storageUsage + eventBytes > this.maxStorageBytes) {
          throw new RecordingQuotaError(
            "Agent recording storage quota reached",
          );
        }
        await handle.writeFile(line, "utf8");
        this.storageUsageBytes = storageUsage + eventBytes;
      } catch (error) {
        if (!(error instanceof RecordingQuotaError)) {
          this.storageUsageBytes = null;
        }
        throw error;
      } finally {
        await handle.close();
      }
      await fs.chmod(absolutePath, 0o600).catch(() => undefined);
    });
  }

  private withStorageLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.storageQueue.then(operation);
    this.storageQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async currentStorageUsage(): Promise<number> {
    if (this.storageUsageBytes !== null) return this.storageUsageBytes;
    const recordingDirectory = path.join(
      path.resolve(this.dataDirectory),
      "agent",
      "recordings",
    );
    let total = 0;
    for (const entry of await fs.readdir(recordingDirectory, {
      withFileTypes: true,
    })) {
      if (!RECORDING_FILE_PATTERN.test(entry.name)) continue;
      const candidate = path.join(recordingDirectory, entry.name);
      const stat = await fs.lstat(candidate);
      if (!stat.isSymbolicLink() && stat.isFile()) total += stat.size;
    }
    this.storageUsageBytes = total;
    return total;
  }

  private async ensureEvent(
    sessionId: string,
    storageKey: string,
    eventName: LifecycleEvent,
    event: Record<string, unknown>,
  ): Promise<void> {
    const known = this.knownEvents.get(sessionId);
    if (known?.has(eventName)) return;
    if (!(await this.containsEvent(storageKey, eventName))) {
      await this.appendEvent(storageKey, event);
    }
    const updated = known ?? new Set<LifecycleEvent>();
    updated.add(eventName);
    this.knownEvents.set(sessionId, updated);
  }

  private async containsEvent(
    storageKey: string,
    eventName: string,
  ): Promise<boolean> {
    const absolutePath = this.absolutePath(storageKey);
    await this.ensureRecordingDirectory();
    if (!(await this.assertPlainFileIfPresent(absolutePath))) return false;

    const input = createReadStream(absolutePath);
    const lines = createInterface({
      input,
      crlfDelay: Infinity,
    });
    try {
      for await (const line of lines) {
        try {
          const value = JSON.parse(line) as {
            direction?: unknown;
            event?: unknown;
          };
          if (value.direction === "system" && value.event === eventName) {
            return true;
          }
        } catch {
          // 损坏的历史行不应阻止补齐生命周期事件。
        }
      }
      return false;
    } finally {
      lines.close();
      input.destroy();
    }
  }

  private async fileMetadata(storageKey: string): Promise<FileMetadata> {
    const absolutePath = this.absolutePath(storageKey);
    await this.ensureRecordingDirectory();
    if (!(await this.assertPlainFileIfPresent(absolutePath))) {
      throw new Error("Agent recording file is missing");
    }

    const hash = crypto.createHash("sha256");
    let sizeBytes = 0;
    for await (const chunk of createReadStream(absolutePath)) {
      hash.update(chunk);
      sizeBytes += chunk.length;
    }
    return { sizeBytes, checksum: hash.digest("hex") };
  }

  private async safeFileMetadata(
    storageKey: string,
  ): Promise<FileMetadata | null> {
    try {
      return await this.fileMetadata(storageKey);
    } catch {
      return null;
    }
  }

  private async unlinkRecording(storageKey: string): Promise<void> {
    const absolutePath = this.absolutePath(storageKey);
    await this.withStorageLock(async () => {
      await this.ensureRecordingDirectory();
      if (!(await this.assertPlainFileIfPresent(absolutePath))) return;
      const size = (await fs.lstat(absolutePath)).size;
      try {
        await fs.unlink(absolutePath);
        if (this.storageUsageBytes !== null) {
          this.storageUsageBytes = Math.max(0, this.storageUsageBytes - size);
        }
      } catch (error) {
        this.storageUsageBytes = null;
        throw error;
      }
    });
  }
}
