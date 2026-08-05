import crypto from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteAgentSessionRecorder } from "./recording.js";
import type { AgentPrincipal, AgentSessionRecord } from "./types.js";

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

interface StoredRecording {
  mode: "metadata" | "full";
  storageKey: string | null;
  sizeBytes: number;
  checksum: string | null;
  startedAt: string;
  endedAt: string | null;
  retainUntil: string | null;
}

function createDatabase(): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL
    );
    CREATE TABLE persistent_sessions (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL
    );
    CREATE TABLE project_session_recordings (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      storage_key TEXT,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      checksum TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      retain_until TEXT
    );
    INSERT INTO projects VALUES
      ('team-project', 'team'),
      ('personal-project', 'personal');
  `);
  return sqlite;
}

function session(id: string, projectId = "team-project"): AgentSessionRecord {
  const createdAt = "2026-07-01T00:00:00.000Z";
  return {
    id,
    projectId,
    serverId: "11",
    serviceAccountId: "service-account-1",
    state: "RUNNING",
    cols: 120,
    rows: 40,
    pinned: false,
    createdAt,
    updatedAt: createdAt,
    lastDetachedAt: null,
    closedAt: null,
    failureReason: null,
    generation: 1,
    nextSequence: 0,
    output: [],
    writeLease: null,
    runtimeId: "runtime-1",
    tmuxSessionName: `cloudssh_${id}`,
  };
}

const principal: AgentPrincipal = {
  principalId: "token:token-1",
  serviceAccountId: "service-account-1",
  projectId: "team-project",
  name: "自动运维设备",
  scopes: ["sessions:create", "sessions:read", "sessions:write"],
  serverIds: ["11"],
  maxConcurrentSessions: 2,
};

function storageKey(seed: string): string {
  const digest = crypto.createHash("sha256").update(seed).digest("hex");
  return `agent/recordings/${digest}.jsonl`;
}

function storedRecording(
  sqlite: Database.Database,
  sessionId: string,
): StoredRecording | null {
  return (
    (sqlite
      .prepare(
        `SELECT mode, storage_key AS storageKey, size_bytes AS sizeBytes,
                checksum, started_at AS startedAt, ended_at AS endedAt,
                retain_until AS retainUntil
           FROM project_session_recordings
          WHERE session_id = ?`,
      )
      .get(sessionId) as StoredRecording | undefined) ?? null
  );
}

function recordingPath(dataDirectory: string, key: string): string {
  return path.join(dataDirectory, ...key.split("/"));
}

async function events(
  filePath: string,
): Promise<Array<Record<string, unknown>>> {
  const content = await fs.readFile(filePath, "utf8");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("Agent 会话录像", () => {
  let sqlite: Database.Database;
  let dataDirectory: string;
  let onWrite: ReturnType<typeof vi.fn>;
  let recorder: SqliteAgentSessionRecorder;

  beforeEach(async () => {
    sqlite = createDatabase();
    dataDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudssh-recording-"),
    );
    onWrite = vi.fn(async () => undefined);
    recorder = new SqliteAgentSessionRecorder(sqlite, dataDirectory, onWrite);
  });

  afterEach(async () => {
    sqlite.close();
    await fs.rm(dataDirectory, { recursive: true, force: true });
  });

  it("为团队项目保存完整且可校验的录像", async () => {
    const current = session("team-complete");
    await recorder.start(current);
    await recorder.recordInput(current, principal, "uptime\n");
    await recorder.recordOutput(current.id, "up 12 days\n");
    await recorder.end(current.id);

    const row = storedRecording(sqlite, current.id);
    expect(row).not.toBeNull();
    expect(row?.mode).toBe("full");
    expect(row?.endedAt).not.toBeNull();
    expect(Date.parse(row!.retainUntil!) - Date.parse(row!.endedAt!)).toBe(
      RETENTION_MS,
    );

    const filePath = recordingPath(dataDirectory, row!.storageKey!);
    const content = await fs.readFile(filePath);
    expect(row?.sizeBytes).toBe(content.length);
    expect(row?.checksum).toBe(
      crypto.createHash("sha256").update(content).digest("hex"),
    );
    expect(await events(filePath)).toMatchObject([
      { direction: "system", event: "session_started" },
      { direction: "input", data: "uptime\n" },
      { direction: "output", data: "up 12 days\n" },
      { direction: "system", event: "session_ended" },
    ]);
  });

  it("停机检查点刷新活动录像摘要但不结束持续会话", async () => {
    const current = session("shutdown-checkpoint");
    await recorder.start(current);
    await recorder.recordOutput(current.id, "before shutdown\n");

    expect(storedRecording(sqlite, current.id)).toMatchObject({
      sizeBytes: 0,
      checksum: null,
      endedAt: null,
      retainUntil: null,
    });
    expect(await recorder.checkpointActive()).toBe(1);

    const firstCheckpoint = storedRecording(sqlite, current.id)!;
    const filePath = recordingPath(dataDirectory, firstCheckpoint.storageKey!);
    const firstContent = await fs.readFile(filePath);
    expect(firstCheckpoint).toMatchObject({
      sizeBytes: firstContent.length,
      checksum: crypto.createHash("sha256").update(firstContent).digest("hex"),
      endedAt: null,
      retainUntil: null,
    });
    expect(await events(filePath)).not.toContainEqual(
      expect.objectContaining({ event: "session_ended" }),
    );

    await recorder.recordOutput(current.id, "after restart\n");
    expect(await recorder.checkpointActive()).toBe(1);
    const secondCheckpoint = storedRecording(sqlite, current.id)!;
    const secondContent = await fs.readFile(filePath);
    expect(secondCheckpoint.sizeBytes).toBe(secondContent.length);
    expect(secondCheckpoint.checksum).toBe(
      crypto.createHash("sha256").update(secondContent).digest("hex"),
    );
    expect(secondCheckpoint.endedAt).toBeNull();
  });

  it("活动录像文件缺失时拒绝写入可恢复检查点", async () => {
    const current = session("checkpoint-missing-file");
    await recorder.start(current);
    const row = storedRecording(sqlite, current.id)!;
    await fs.rm(recordingPath(dataDirectory, row.storageKey!));

    await expect(recorder.checkpointActive()).rejects.toThrow(
      "Agent recording file is missing",
    );
  });

  it("跨项目设备接管时记录当前设备在目标主机上的账号", async () => {
    const current = session("cross-device-actor");
    const takeoverPrincipal: AgentPrincipal = {
      ...principal,
      principalId: "device:device-2",
      serviceAccountId: "fallback-service-account",
      projectServiceAccountIds: {
        "team-project": "project-service-account",
      },
      serverServiceAccountIds: { "11": "host-service-account" },
    };
    await recorder.start(current);
    await recorder.recordInput(current, takeoverPrincipal, "hostname\n");
    await recorder.end(current.id);

    const row = storedRecording(sqlite, current.id)!;
    const input = (
      await events(recordingPath(dataDirectory, row.storageKey!))
    ).find((event) => event.direction === "input");
    expect(input).toMatchObject({
      serviceAccountId: "host-service-account",
      agentName: takeoverPrincipal.name,
    });
  });

  it("网页接管输入在录像中标记真实用户身份", async () => {
    const current = session("browser-user-actor");
    const browserPrincipal: AgentPrincipal = {
      ...principal,
      principalId: "web-user:user-123:browser-connection",
      name: "网页用户 user-123",
    };
    await recorder.start(current);
    await recorder.recordInput(current, browserPrincipal, "whoami\n");
    await recorder.end(current.id);

    const row = storedRecording(sqlite, current.id)!;
    const input = (
      await events(recordingPath(dataDirectory, row.storageKey!))
    ).find((event) => event.direction === "input");
    expect(input).toMatchObject({
      actorType: "user",
      userId: "user-123",
      agentName: browserPrincipal.name,
    });
  });

  it("达到单录像配额后冻结录像并拒绝未录像的后续输入", async () => {
    const current = session("recording-size-limit");
    const limited = new SqliteAgentSessionRecorder(
      sqlite,
      dataDirectory,
      onWrite,
      { maxRecordingBytes: 1024, maxStorageBytes: 4096 },
    );
    await limited.start(current);

    await expect(
      limited.recordOutput(current.id, "x".repeat(2048)),
    ).resolves.toBeUndefined();
    const row = storedRecording(sqlite, current.id)!;
    const content = await fs.readFile(
      recordingPath(dataDirectory, row.storageKey!),
    );
    expect(row).toMatchObject({
      endedAt: expect.any(String),
      sizeBytes: content.length,
      checksum: crypto.createHash("sha256").update(content).digest("hex"),
    });
    await expect(
      limited.recordInput(current, principal, "must not run\n"),
    ).rejects.toMatchObject({ code: "SESSION_RECORDING_UNAVAILABLE" });
  });

  it("总目录配额由并发会话共享且重启后按磁盘用量恢复", async () => {
    const first = session("storage-quota-first");
    await recorder.start(first);
    await recorder.recordOutput(first.id, "first recording\n");
    const firstRow = storedRecording(sqlite, first.id)!;
    const firstSize = (
      await fs.stat(recordingPath(dataDirectory, firstRow.storageKey!))
    ).size;
    const limited = new SqliteAgentSessionRecorder(
      sqlite,
      dataDirectory,
      onWrite,
      { maxRecordingBytes: 4096, maxStorageBytes: firstSize + 1024 },
    );
    const second = session("storage-quota-second");
    await limited.start(second);

    await limited.recordOutput(second.id, "x".repeat(2048));

    expect(storedRecording(sqlite, first.id)?.endedAt).toBeNull();
    const secondRow = storedRecording(sqlite, second.id)!;
    const secondContent = await fs.readFile(
      recordingPath(dataDirectory, secondRow.storageKey!),
    );
    expect(secondRow).toMatchObject({
      endedAt: expect.any(String),
      sizeBytes: secondContent.length,
      checksum: crypto.createHash("sha256").update(secondContent).digest("hex"),
    });
  });

  it("录像文件写入失败时结束记录且输出回调不抛出", async () => {
    const current = session("recording-io-failure");
    await recorder.start(current);
    const row = storedRecording(sqlite, current.id)!;
    const filePath = recordingPath(dataDirectory, row.storageKey!);
    await fs.rm(filePath);
    await fs.mkdir(filePath);

    await expect(
      recorder.recordOutput(current.id, "remote output\n"),
    ).resolves.toBeUndefined();
    expect(storedRecording(sqlite, current.id)).toMatchObject({
      endedAt: expect.any(String),
      checksum: null,
    });
    await expect(
      recorder.recordInput(current, principal, "must not run\n"),
    ).rejects.toMatchObject({ code: "SESSION_RECORDING_UNAVAILABLE" });
  });

  it("个人项目仅保留元数据且不创建录像文件", async () => {
    const current = session("personal-metadata", "personal-project");
    await recorder.start(current);
    await recorder.recordInput(current, principal, "private input\n");
    await recorder.recordOutput(current.id, "private output\n");
    await recorder.end(current.id);

    expect(storedRecording(sqlite, current.id)).toEqual({
      mode: "metadata",
      storageKey: null,
      sizeBytes: 0,
      checksum: null,
      startedAt: current.createdAt,
      endedAt: expect.any(String),
      retainUntil: null,
    });
    await expect(
      fs.access(path.join(dataDirectory, "agent")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("并发结束只写一个结束事件且结束后不再接受内容", async () => {
    const current = session("idempotent-end");
    await recorder.start(current);
    await recorder.recordOutput(current.id, "before end\n");
    await Promise.all(
      Array.from({ length: 20 }, () => recorder.end(current.id)),
    );

    const rowBefore = storedRecording(sqlite, current.id)!;
    const filePath = recordingPath(dataDirectory, rowBefore.storageKey!);
    const contentBefore = await fs.readFile(filePath, "utf8");
    expect(
      (await events(filePath)).filter(
        (event) => event.event === "session_ended",
      ),
    ).toHaveLength(1);

    await expect(
      recorder.recordInput(current, principal, "after end input\n"),
    ).rejects.toMatchObject({ code: "SESSION_RECORDING_UNAVAILABLE" });
    await recorder.recordOutput(current.id, "after end output\n");
    await recorder.end(current.id);

    expect(await fs.readFile(filePath, "utf8")).toBe(contentBefore);
    expect(storedRecording(sqlite, current.id)).toEqual(rowBefore);
    expect(onWrite).toHaveBeenCalledTimes(2);
  });

  it("并发追加保持每行 JSON 完整且不丢失", { timeout: 15_000 }, async () => {
    const current = session("concurrent-append");
    await recorder.start(current);

    await Promise.all([
      ...Array.from({ length: 50 }, (_, index) =>
        recorder.recordInput(current, principal, `input-${index}\n`),
      ),
      ...Array.from({ length: 50 }, (_, index) =>
        recorder.recordOutput(current.id, `output-${index}\n`),
      ),
    ]);
    await recorder.end(current.id);

    const row = storedRecording(sqlite, current.id)!;
    const savedEvents = await events(
      recordingPath(dataDirectory, row.storageKey!),
    );
    expect(savedEvents).toHaveLength(102);
    expect(
      savedEvents.filter((event) => event.direction === "input"),
    ).toHaveLength(50);
    expect(
      savedEvents.filter((event) => event.direction === "output"),
    ).toHaveLength(50);
  });

  it("新 Recorder 实例恢复已有录像且不会重复开始事件", async () => {
    const current = session("recorder-restart");
    await recorder.start(current);
    await recorder.recordOutput(current.id, "first process\n");

    const recovered = new SqliteAgentSessionRecorder(sqlite, dataDirectory);
    await recovered.start(current);
    await recovered.recordOutput(current.id, "second process\n");
    await recovered.end(current.id);

    const row = storedRecording(sqlite, current.id)!;
    const savedEvents = await events(
      recordingPath(dataDirectory, row.storageKey!),
    );
    expect(
      savedEvents.filter((event) => event.event === "session_started"),
    ).toHaveLength(1);
    expect(
      savedEvents.filter((event) => event.direction === "output"),
    ).toMatchObject([
      { data: "first process\n" },
      { data: "second process\n" },
    ]);
  });

  it("数据库已有记录但文件缺失时按数据库模式和路径补齐", async () => {
    const current = session("database-recovery", "personal-project");
    const key = storageKey("database-selected-path");
    sqlite
      .prepare(
        `INSERT INTO project_session_recordings (
           id, session_id, project_id, mode, storage_key, size_bytes, started_at
         ) VALUES (?, ?, ?, 'full', ?, 0, ?)`,
      )
      .run(
        "recording-1",
        current.id,
        current.projectId,
        key,
        current.createdAt,
      );

    await recorder.recordOutput(current.id, "broker resumed\n");
    await recorder.start(current);

    const row = storedRecording(sqlite, current.id)!;
    expect(row.mode).toBe("full");
    expect(row.storageKey).toBe(key);
    expect(await events(recordingPath(dataDirectory, key))).toMatchObject([
      { event: "session_started" },
      { direction: "output", data: "broker resumed\n" },
    ]);
  });

  it("完整录像缺少存储键时明确拒绝继续运行", async () => {
    const current = session("missing-storage-key");
    sqlite
      .prepare(
        `INSERT INTO project_session_recordings (
           id, session_id, project_id, mode, storage_key, size_bytes, started_at
         ) VALUES (?, ?, ?, 'full', NULL, 0, ?)`,
      )
      .run(
        "recording-missing-key",
        current.id,
        current.projectId,
        current.createdAt,
      );

    await expect(recorder.start(current)).rejects.toThrow(
      "Full agent recording has no storage key",
    );
    await expect(
      recorder.recordOutput(current.id, "must fail\n"),
    ).resolves.toBeUndefined();
    expect(storedRecording(sqlite, current.id)?.endedAt).not.toBeNull();
  });

  it("活动录像永不清理，结束后从结束时间起保留 90 天", async () => {
    const current = session("retention-window");
    await recorder.start(current);
    await recorder.recordOutput(current.id, "still running\n");
    expect(storedRecording(sqlite, current.id)?.retainUntil).toBeNull();
    expect(
      await recorder.cleanupExpired(Date.parse("9999-01-01T00:00:00Z")),
    ).toBe(0);

    await recorder.end(current.id);
    const ended = storedRecording(sqlite, current.id)!;
    const retainUntil = Date.parse(ended.retainUntil!);
    const filePath = recordingPath(dataDirectory, ended.storageKey!);
    expect(retainUntil - Date.parse(ended.endedAt!)).toBe(RETENTION_MS);
    expect(await recorder.cleanupExpired(retainUntil - 1)).toBe(0);
    expect(await recorder.cleanupExpired(retainUntil)).toBe(1);
    expect(await recorder.cleanupExpired(retainUntil)).toBe(0);
    expect(storedRecording(sqlite, current.id)).toBeNull();
    await expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("对账会结束已关闭或失败会话遗留的活动录像", async () => {
    const current = session("dangling-recording");
    sqlite
      .prepare(
        "INSERT INTO persistent_sessions (id, state) VALUES (?, 'FAILED')",
      )
      .run(current.id);
    await recorder.start(current);
    await recorder.recordOutput(current.id, "last output\n");
    expect(storedRecording(sqlite, current.id)?.endedAt).toBeNull();

    expect(await recorder.reconcileDangling()).toBe(1);
    expect(storedRecording(sqlite, current.id)?.endedAt).not.toBeNull();
    expect(await recorder.reconcileDangling()).toBe(0);
  });

  it.each([
    "../outside.jsonl",
    "/tmp/outside.jsonl",
    "C:\\outside.jsonl",
    `agent/recordingsx/${"a".repeat(64)}.jsonl`,
    `agent/recordings/${"A".repeat(64)}.jsonl`,
  ])("拒绝非法录像存储键 %s", async (key) => {
    const current = session(`invalid-${crypto.randomUUID()}`);
    sqlite
      .prepare(
        `INSERT INTO project_session_recordings (
           id, session_id, project_id, mode, storage_key, size_bytes, started_at
         ) VALUES (?, ?, ?, 'full', ?, 0, ?)`,
      )
      .run(
        crypto.randomUUID(),
        current.id,
        current.projectId,
        key,
        current.createdAt,
      );

    await expect(recorder.start(current)).rejects.toThrow(
      "Invalid agent recording storage key",
    );
  });

  it("拒绝复用其他项目的录像记录", async () => {
    const current = session("project-collision");
    sqlite
      .prepare(
        `INSERT INTO project_session_recordings (
           id, session_id, project_id, mode, storage_key, size_bytes, started_at
         ) VALUES (?, ?, 'personal-project', 'metadata', NULL, 0, ?)`,
      )
      .run("recording-project-collision", current.id, current.createdAt);

    await expect(recorder.start(current)).rejects.toThrow(
      "Agent recording belongs to another project",
    );
  });

  it.skipIf(process.platform === "win32")(
    "拒绝录像目录中的符号链接",
    async () => {
      const outside = await fs.mkdtemp(
        path.join(os.tmpdir(), "cloudssh-recording-outside-"),
      );
      try {
        await fs.symlink(outside, path.join(dataDirectory, "agent"), "dir");
        await expect(
          recorder.start(session("symlink-directory")),
        ).rejects.toThrow("Agent recording directory must be a real directory");
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    },
  );
});
