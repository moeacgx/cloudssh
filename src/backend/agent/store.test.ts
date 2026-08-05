import { promises as fs } from "fs";
import crypto from "crypto";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSessionBroker } from "./broker.js";
import {
  compactAgentPersistentState,
  hasIdempotencyCapacity,
  JsonAgentStateStore,
  SqliteBackedAgentStateStore,
} from "./store.js";
import type {
  AgentPersistentState,
  AgentPrincipal,
  AgentSessionDriver,
  AgentSessionRecord,
  DriverOutputSink,
} from "./types.js";

class CountingSessionDriver implements AgentSessionDriver {
  creates = 0;

  async create(
    session: AgentSessionRecord,
    _sink: DriverOutputSink,
  ): Promise<{ runtimeId: string }> {
    this.creates += 1;
    return { runtimeId: `runtime:${session.id}` };
  }

  async recover(): Promise<{ runtimeId: string }> {
    return { runtimeId: "recovered" };
  }

  async write(): Promise<void> {}
  async resize(): Promise<void> {}
  async close(): Promise<void> {}
  async closePersistent(): Promise<void> {}
}

function createDatabase(): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE project_hosts (
      id INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL
    );
    CREATE TABLE agent_device_projects (
      device_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      service_account_id TEXT NOT NULL
    );
    CREATE TABLE agent_token_projects (
      token_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      service_account_id TEXT
    );
    CREATE TABLE persistent_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      project_host_id INTEGER NOT NULL,
      owner_user_id TEXT,
      service_account_id TEXT,
      state TEXT NOT NULL,
      runtime_id TEXT,
      runtime_mode TEXT NOT NULL DEFAULT 'tmux',
      tmux_name TEXT NOT NULL,
      columns INTEGER NOT NULL,
      rows INTEGER NOT NULL,
      pinned INTEGER NOT NULL,
      stream_generation INTEGER NOT NULL,
      last_sequence INTEGER NOT NULL,
      idempotency_key TEXT,
      last_attached_at TEXT,
      retain_until TEXT,
      failure_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT
    );
    CREATE UNIQUE INDEX uq_persistent_sessions_idempotency
      ON persistent_sessions(project_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE TABLE session_write_leases (
      session_id TEXT PRIMARY KEY,
      holder_type TEXT NOT NULL,
      holder_user_id TEXT,
      holder_service_account_id TEXT,
      lease_id TEXT NOT NULL,
      lease_token_hash TEXT NOT NULL,
      version INTEGER NOT NULL,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE project_session_recordings (
      session_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      ended_at TEXT,
      retain_until TEXT
    );
    INSERT INTO project_hosts (id, project_id) VALUES (11, 'project-1');
    INSERT INTO agent_device_projects
      (device_id, project_id, service_account_id)
      VALUES
        ('device-1', 'project-1', 'service-1'),
        ('device-2', 'project-1', 'service-2');
  `);
  return sqlite;
}

function principal(deviceId: string, serviceAccountId: string): AgentPrincipal {
  return {
    principalId: `device:${deviceId}`,
    serviceAccountId,
    projectId: "project-1",
    name: deviceId,
    scopes: ["sessions:create", "sessions:read"],
    serverIds: ["11"],
    maxConcurrentSessions: 2,
  };
}

describe("SQLite Agent 会话状态恢复", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => fs.rm(directory, { recursive: true, force: true })),
    );
  });

  it("网页接管租约按真实用户而不是 Agent 服务账号入库", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudssh-agent-user-lease-"),
    );
    temporaryDirectories.push(directory);
    const sqlite = createDatabase();
    const broker = new AgentSessionBroker(
      new SqliteBackedAgentStateStore(
        path.join(directory, "runtime-state.json"),
        sqlite,
      ),
      new CountingSessionDriver(),
    );
    const browser: AgentPrincipal = {
      ...principal("device-1", "service-1"),
      principalId: "web-user:user-123:browser-connection",
      name: "网页用户 user-123",
      scopes: ["sessions:create", "sessions:read", "sessions:write"],
    };

    try {
      const created = await broker.create(
        browser,
        { serverId: "11", cols: 120, rows: 30, pinned: false },
        "browser-user-lease",
      );
      await broker.attach(
        browser,
        created.id,
        "read-write",
        false,
        "browser-user-attach",
      );

      expect(
        sqlite
          .prepare(
            `SELECT holder_type AS holderType,
                    holder_user_id AS holderUserId,
                    holder_service_account_id AS holderServiceAccountId
               FROM session_write_leases
              WHERE session_id = ?`,
          )
          .get(created.id),
      ).toEqual({
        holderType: "user",
        holderUserId: "user-123",
        holderServiceAccountId: null,
      });
    } finally {
      sqlite.close();
    }
  });

  it("sidecar 丢失后仍按设备和项目恢复创建幂等键", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudssh-agent-store-"),
    );
    temporaryDirectories.push(directory);
    const statePath = path.join(directory, "runtime-state.json");
    const sqlite = createDatabase();
    const input = { serverId: "11", cols: 120, rows: 30, pinned: false };
    const firstDriver = new CountingSessionDriver();
    const firstBroker = new AgentSessionBroker(
      new SqliteBackedAgentStateStore(statePath, sqlite),
      firstDriver,
    );

    try {
      const created = await firstBroker.create(
        principal("device-1", "service-1"),
        input,
        "same-client-key",
      );
      expect(firstDriver.creates).toBe(1);
      expect(
        sqlite
          .prepare(
            "SELECT idempotency_key, runtime_mode FROM persistent_sessions",
          )
          .get(),
      ).toEqual({
        idempotency_key:
          "device:device-1:project:project-1:session:create:same-client-key",
        runtime_mode: "platform",
      });

      await fs.rm(statePath);
      const restartedDriver = new CountingSessionDriver();
      const restartedBroker = new AgentSessionBroker(
        new SqliteBackedAgentStateStore(statePath, sqlite),
        restartedDriver,
      );
      const duplicate = await restartedBroker.create(
        principal("device-1", "service-1"),
        input,
        "same-client-key",
      );

      expect(duplicate.id).toBe(created.id);
      expect(restartedDriver.creates).toBe(0);

      const secondDeviceSession = await restartedBroker.create(
        principal("device-2", "service-2"),
        input,
        "same-client-key",
      );
      expect(secondDeviceSession.id).not.toBe(created.id);
      expect(restartedDriver.creates).toBe(1);
    } finally {
      sqlite.close();
    }
  });

  it("升级时规范化旧 sidecar 与数据库幂等键", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudssh-agent-store-upgrade-"),
    );
    temporaryDirectories.push(directory);
    const statePath = path.join(directory, "runtime-state.json");
    const sqlite = createDatabase();
    const input = { serverId: "11", cols: 120, rows: 30, pinned: false };
    const firstBroker = new AgentSessionBroker(
      new SqliteBackedAgentStateStore(statePath, sqlite, undefined),
      new CountingSessionDriver(),
    );

    try {
      const created = await firstBroker.create(
        principal("device-1", "service-1"),
        input,
        "upgrade-key",
      );
      await new JsonAgentStateStore(statePath).update((state) => {
        const record = state.idempotency.find(
          (entry) =>
            (entry.response as { sessionId?: string }).sessionId === created.id,
        );
        if (!record) throw new Error("legacy idempotency record is missing");
        record.key = "service-1:session:create:upgrade-key";
      });
      sqlite
        .prepare(
          "UPDATE persistent_sessions SET idempotency_key = 'upgrade-key' WHERE id = ?",
        )
        .run(created.id);

      const upgradedStore = new SqliteBackedAgentStateStore(statePath, sqlite);
      await upgradedStore.update(() => undefined);
      const upgradedState = await upgradedStore.read();
      const createRecords = upgradedState.idempotency.filter(
        (entry) =>
          (entry.response as { sessionId?: string }).sessionId === created.id,
      );
      expect(createRecords.map((entry) => entry.key)).toEqual([
        "device:device-1:project:project-1:session:create:upgrade-key",
      ]);
      expect(
        sqlite
          .prepare(
            "SELECT idempotency_key FROM persistent_sessions WHERE id = ?",
          )
          .get(created.id),
      ).toEqual({
        idempotency_key:
          "device:device-1:project:project-1:session:create:upgrade-key",
      });

      await fs.rm(statePath);
      const restartedDriver = new CountingSessionDriver();
      const restartedBroker = new AgentSessionBroker(
        new SqliteBackedAgentStateStore(statePath, sqlite),
        restartedDriver,
      );
      const duplicate = await restartedBroker.create(
        principal("device-1", "service-1"),
        input,
        "upgrade-key",
      );
      expect(duplicate.id).toBe(created.id);
      expect(restartedDriver.creates).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it("读取旧 sidecar 时将缺失的运行模式按 tmux 恢复", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudssh-agent-store-legacy-mode-"),
    );
    temporaryDirectories.push(directory);
    const statePath = path.join(directory, "runtime-state.json");
    const now = "2026-07-31T12:00:00.000Z";
    const legacySession = {
      id: "legacy-session",
      projectId: "project-1",
      serverId: "11",
      serviceAccountId: "service-1",
      state: "RUNNING",
      cols: 120,
      rows: 30,
      pinned: false,
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
      runtimeId: "legacy-runtime",
      tmuxSessionName: "cloudssh-legacy-session",
    };
    const legacyRequestHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          serverId: legacySession.serverId,
          cols: legacySession.cols,
          rows: legacySession.rows,
          pinned: legacySession.pinned,
        }),
      )
      .digest("hex");
    await fs.writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        sessions: [legacySession],
        jobs: [],
        idempotency: [
          {
            key: "device:device-1:project:project-1:session:create:legacy",
            requestHash: legacyRequestHash,
            response: { sessionId: legacySession.id },
            createdAt: now,
          },
        ],
      }),
      { encoding: "utf8", mode: 0o600 },
    );

    const restored = await new JsonAgentStateStore(statePath).read();

    expect(restored.sessions[0]).toMatchObject({
      id: "legacy-session",
      runtimeMode: "tmux",
    });
    expect(restored.idempotency[0].requestHash).toBe(legacyRequestHash);
  });

  it("固定会话默认使用 tmux，显式平台模式完整写入 SQLite", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudssh-agent-store-runtime-mode-"),
    );
    temporaryDirectories.push(directory);
    const sqlite = createDatabase();
    const broker = new AgentSessionBroker(
      new SqliteBackedAgentStateStore(
        path.join(directory, "runtime-state.json"),
        sqlite,
      ),
      new CountingSessionDriver(),
    );

    try {
      const defaultPinned = await broker.create(
        principal("device-1", "service-1"),
        { serverId: "11", cols: 120, rows: 30, pinned: true },
        "default-pinned-mode",
      );
      const explicitPlatform = await broker.create(
        principal("device-2", "service-2"),
        {
          serverId: "11",
          cols: 120,
          rows: 30,
          pinned: true,
          runtimeMode: "platform",
        },
        "explicit-platform-mode",
      );

      expect(defaultPinned.runtimeMode).toBe("tmux");
      expect(explicitPlatform.runtimeMode).toBe("platform");
      expect(
        sqlite
          .prepare(
            `SELECT service_account_id AS serviceAccountId,
                    runtime_mode AS runtimeMode
               FROM persistent_sessions
              ORDER BY service_account_id`,
          )
          .all(),
      ).toEqual([
        { serviceAccountId: "service-1", runtimeMode: "tmux" },
        { serviceAccountId: "service-2", runtimeMode: "platform" },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("主库同步失败后由相同幂等请求接续未启动会话", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudssh-agent-store-resume-"),
    );
    temporaryDirectories.push(directory);
    const sqlite = createDatabase();
    const driver = new CountingSessionDriver();
    const broker = new AgentSessionBroker(
      new SqliteBackedAgentStateStore(
        path.join(directory, "runtime-state.json"),
        sqlite,
      ),
      driver,
    );
    const device = {
      ...principal("device-1", "service-1"),
      serverIds: ["12"],
    };
    const input = { serverId: "12", cols: 120, rows: 30, pinned: false };

    try {
      await expect(
        broker.create(device, input, "resume-creating-session"),
      ).rejects.toThrow("Host 12 is not associated with project project-1");
      expect(driver.creates).toBe(0);

      sqlite
        .prepare("INSERT INTO project_hosts (id, project_id) VALUES (12, ?)")
        .run("project-1");
      const recovered = await broker.create(
        device,
        input,
        "resume-creating-session",
      );

      expect(driver.creates).toBe(1);
      expect(recovered).toMatchObject({
        serverId: "12",
        state: "RUNNING",
      });
      expect(
        sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM persistent_sessions WHERE id = ?",
          )
          .get(recovered.id),
      ).toEqual({ count: 1 });
    } finally {
      sqlite.close();
    }
  });

  it("崩溃恢复时始终以 sidecar 会话状态为权威来源", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudssh-agent-store-revision-"),
    );
    temporaryDirectories.push(directory);
    const statePath = path.join(directory, "runtime-state.json");
    const sqlite = createDatabase();
    const broker = new AgentSessionBroker(
      new SqliteBackedAgentStateStore(statePath, sqlite),
      new CountingSessionDriver(),
    );

    try {
      const created = await broker.create(
        principal("device-1", "service-1"),
        { serverId: "11", cols: 120, rows: 30, pinned: false },
        "crash-window",
      );
      const sidecarUpdatedAt = "2099-01-02T00:00:00.000Z";
      await new JsonAgentStateStore(statePath).update((state) => {
        const session = state.sessions.find(
          (entry) => entry.id === created.id,
        )!;
        session.state = "CLOSED";
        session.closedAt = sidecarUpdatedAt;
        session.updatedAt = sidecarUpdatedAt;
        session.runtimeId = null;
      });
      sqlite
        .prepare(
          `UPDATE persistent_sessions
              SET state = 'RUNNING', updated_at = '2100-01-01T00:00:00.000Z'
            WHERE id = ?`,
        )
        .run(created.id);
      sqlite
        .prepare(
          `INSERT INTO session_write_leases (
             session_id, holder_type, holder_service_account_id, lease_id,
             lease_token_hash, version, acquired_at, expires_at, updated_at
           ) VALUES (?, 'service_account', 'service-1', 'stale-lease',
                     'stale-hash', 1, ?, ?, ?)`,
        )
        .run(
          created.id,
          "2099-01-01T00:00:00.000Z",
          "2099-01-02T00:00:00.000Z",
          "2099-01-01T00:00:00.000Z",
        );

      const restored = new SqliteBackedAgentStateStore(statePath, sqlite);
      const session = (await restored.read()).sessions.find(
        (entry) => entry.id === created.id,
      );

      expect(session).toMatchObject({
        state: "CLOSED",
        updatedAt: sidecarUpdatedAt,
        runtimeId: null,
      });
      expect(
        sqlite
          .prepare(
            "SELECT state, updated_at AS updatedAt FROM persistent_sessions WHERE id = ?",
          )
          .get(created.id),
      ).toEqual({ state: "CLOSED", updatedAt: sidecarUpdatedAt });
      expect(
        sqlite
          .prepare("SELECT COUNT(*) AS count FROM session_write_leases")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      sqlite.close();
    }
  });

  it("清理九十天前的个人元数据会话但保留完整录像会话", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudssh-agent-store-retention-"),
    );
    temporaryDirectories.push(directory);
    const sqlite = createDatabase();
    const state = new SqliteBackedAgentStateStore(
      path.join(directory, "runtime-state.json"),
      sqlite,
    );
    const oldTimestamp = "2026-01-01T00:00:00.000Z";
    const insertSession = sqlite.prepare(
      `INSERT INTO persistent_sessions (
         id, project_id, project_host_id, service_account_id, state,
         tmux_name, columns, rows, pinned, stream_generation, last_sequence,
         created_at, updated_at, closed_at
       ) VALUES (?, 'project-1', 11, 'service-1', 'CLOSED', ?, 120, 30, 0,
                 1, 0, ?, ?, ?)`,
    );

    try {
      insertSession.run(
        "metadata-session",
        "cloudssh-metadata-session",
        oldTimestamp,
        oldTimestamp,
        oldTimestamp,
      );
      insertSession.run(
        "full-session",
        "cloudssh-full-session",
        oldTimestamp,
        oldTimestamp,
        oldTimestamp,
      );
      const insertRecording = sqlite.prepare(
        `INSERT INTO project_session_recordings
           (session_id, mode, ended_at, retain_until)
         VALUES (?, ?, ?, ?)`,
      );
      insertRecording.run("metadata-session", "metadata", oldTimestamp, null);
      insertRecording.run(
        "full-session",
        "full",
        oldTimestamp,
        "2027-12-31T00:00:00.000Z",
      );

      await expect(
        state.cleanupPersistentHistory(Date.parse("2026-07-31T00:00:00.000Z")),
      ).resolves.toBe(1);
      expect(
        sqlite.prepare("SELECT id FROM persistent_sessions ORDER BY id").all(),
      ).toEqual([{ id: "full-session" }]);
    } finally {
      sqlite.close();
    }
  });
});

describe("Agent sidecar 状态压缩", () => {
  it("淘汰过期历史并保留活动会话的创建幂等记录", () => {
    const now = Date.parse("2026-07-31T12:00:00.000Z");
    const activeSession: AgentSessionRecord = {
      id: "active-session",
      projectId: "project-1",
      serverId: "11",
      serviceAccountId: "service-1",
      state: "RUNNING",
      cols: 120,
      rows: 30,
      pinned: true,
      runtimeMode: "tmux",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastDetachedAt: null,
      closedAt: null,
      failureReason: null,
      generation: 1,
      nextSequence: 3,
      output: [0, 1, 2].map((sequence) => ({
        generation: 1,
        sequence,
        data: "x".repeat(1024 * 1024),
        timestamp: "2026-07-31T11:00:00.000Z",
      })),
      attachments: [],
      writeLease: null,
      runtimeId: "runtime-1",
      tmuxSessionName: "cloudssh-active",
    };
    const oldSession: AgentSessionRecord = {
      ...structuredClone(activeSession),
      id: "old-session",
      state: "CLOSED",
      pinned: false,
      updatedAt: "2026-06-01T00:00:00.000Z",
      closedAt: "2026-06-01T00:00:00.000Z",
      runtimeId: null,
      output: [],
    };
    const state: AgentPersistentState = {
      version: 1,
      sessions: [activeSession, oldSession],
      jobs: [],
      idempotency: [
        {
          key: "device:1:project:project-1:session:create:active",
          requestHash: "active-hash",
          response: { sessionId: activeSession.id },
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          key: "device:1:session:active-session:write:expired",
          requestHash: "write-hash",
          response: { written: true },
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };

    compactAgentPersistentState(state, now);

    expect(state.sessions.map((session) => session.id)).toEqual([
      "active-session",
    ]);
    expect(state.sessions[0].output).toHaveLength(2);
    expect(state.idempotency.map((record) => record.key)).toEqual([
      "device:1:project:project-1:session:create:active",
    ]);
  });

  it("达到实体容量上限时不牺牲防重窗口内的幂等记录", () => {
    const now = Date.parse("2026-07-31T12:00:00.000Z");
    const createdAt = "2026-07-31T11:00:00.000Z";
    const state: AgentPersistentState = {
      version: 1,
      sessions: [],
      jobs: Array.from({ length: 1_001 }, (_, index) => ({
        id: `job-${index}`,
        projectId: "project-1",
        serverId: "11",
        serviceAccountId: "service-1",
        command: "true",
        state: "SUCCEEDED" as const,
        stdout: "",
        stderr: "",
        exitCode: 0,
        timeoutMs: 1_000,
        createdAt,
        startedAt: createdAt,
        finishedAt: new Date(now + index).toISOString(),
        failureReason: null,
      })),
      idempotency: Array.from({ length: 1_001 }, (_, index) => ({
        key: `device:1:project:project-1:job:create:key-${index}`,
        requestHash: `hash-${index}`,
        response: { jobId: `job-${index}` },
        createdAt,
      })),
    };

    compactAgentPersistentState(state, now);

    expect(state.jobs).toHaveLength(1_000);
    expect(state.jobs.some((job) => job.id === "job-0")).toBe(false);
    expect(state.idempotency).toHaveLength(1_001);
    expect(
      state.idempotency.some((record) => record.key.endsWith("key-0")),
    ).toBe(true);
    expect(hasIdempotencyCapacity(state)).toBe(true);
  });

  it("容量饱和时保留所有未过期记录并拒绝继续预留", () => {
    const now = Date.parse("2026-07-31T12:00:00.000Z");
    const state: AgentPersistentState = {
      version: 1,
      sessions: [],
      jobs: [],
      idempotency: Array.from({ length: 20_001 }, (_, index) => ({
        key: `write-${index}`,
        requestHash: `hash-${index}`,
        response: { status: "success" },
        createdAt: "2026-07-31T11:00:00.000Z",
      })),
    };

    compactAgentPersistentState(state, now);

    expect(state.idempotency).toHaveLength(20_001);
    expect(hasIdempotencyCapacity(state)).toBe(false);
  });
});
