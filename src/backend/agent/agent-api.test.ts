import type { Server } from "http";
import Database from "better-sqlite3";
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hashAgentToken,
  SqliteAgentCredentialStore,
  type AgentAuthenticatedRequest,
} from "./auth.js";
import { AgentSessionBroker } from "./broker.js";
import { AgentApiError } from "./errors.js";
import { AgentJobManager } from "./jobs.js";
import { createAgentApp } from "./routes.js";
import { MemoryAgentStateStore, type AgentStateStore } from "./store.js";
import type {
  AgentJobDriver,
  AgentPersistentState,
  AgentSessionDriver,
  AgentSessionRecord,
  AgentTokenRecord,
  DriverOutputSink,
  RunJobInput,
} from "./types.js";
import { AgentTokenAdminRepository } from "./token-admin.js";
import type { AgentSessionRecorder } from "./recording.js";
import type { AgentProvisioningService } from "./provisioning.js";
import type { AgentFileService, AgentFileUploadSource } from "./files.js";
import {
  MemoryAgentServerDirectory,
  SqliteAgentServerDirectory,
} from "./servers.js";

const RAW_TOKEN = "cssh_0123456789abcdef0123456789abcdef";

function fileUploadSize(data: Buffer | AgentFileUploadSource): number {
  return Buffer.isBuffer(data) ? data.length : data.size;
}

async function readFileUpload(
  data: Buffer | AgentFileUploadSource,
): Promise<Buffer> {
  if (Buffer.isBuffer(data)) return data;
  const chunks: Buffer[] = [];
  for await (const chunk of data.openStream()) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe("SQLite Agent Token store", () => {
  it("从 Token 项目授权构造跨项目鉴权主体", async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE service_accounts (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
        description TEXT, created_by TEXT, is_active INTEGER NOT NULL,
        created_at TEXT, updated_at TEXT
      );
      CREATE TABLE agent_access_tokens (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
        service_account_id TEXT NOT NULL, name TEXT NOT NULL,
        token_prefix TEXT NOT NULL, token_salt TEXT NOT NULL,
        token_hash TEXT NOT NULL, scopes TEXT NOT NULL,
        max_concurrent_sessions INTEGER NOT NULL, expires_at TEXT,
        last_used_at TEXT, is_active INTEGER NOT NULL, revoked_at TEXT,
        created_at TEXT, access_mode TEXT NOT NULL,
        created_by_user_id TEXT
      );
      CREATE TABLE project_hosts (
        id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, host_id INTEGER NOT NULL
      );
      CREATE TABLE agent_token_projects (
        id INTEGER PRIMARY KEY, project_id TEXT NOT NULL,
        token_id TEXT NOT NULL, service_account_id TEXT,
        granted_by TEXT, created_at TEXT
      );
      INSERT INTO service_accounts (
        id, project_id, name, is_active
      ) VALUES ('service-1', 'project-1', 'robot', 1);
      INSERT INTO project_hosts VALUES (9, 'project-1', 42);
      INSERT INTO agent_token_projects
        (id, project_id, token_id, service_account_id)
      VALUES (1, 'project-1', 'token-1', 'service-1');
    `);
    const hashed = await hashAgentToken(RAW_TOKEN);
    sqlite
      .prepare(
        `INSERT INTO agent_access_tokens (
           id, project_id, service_account_id, name, token_prefix,
           token_salt, token_hash, scopes, max_concurrent_sessions,
           expires_at, last_used_at, is_active, revoked_at, created_at,
           access_mode, created_by_user_id
         ) VALUES (
          'token-1', 'project-1', 'service-1', 'test', ?, ?, ?, ?,
          3, NULL, NULL, 1, NULL, CURRENT_TIMESTAMP, 'selected', NULL
         )`,
      )
      .run(
        RAW_TOKEN.slice(0, 13),
        hashed.salt,
        hashed.hash,
        JSON.stringify(["sessions:read", "sessions:write", "unknown"]),
      );

    const store = new SqliteAgentCredentialStore(sqlite);
    const records = await store.findActiveByPrefix(RAW_TOKEN.slice(0, 13));
    expect(records[0]).toMatchObject({
      projectId: "project-1",
      projectIds: ["project-1"],
      serviceAccountId: "service-1",
      name: "test",
      scopes: ["sessions:read", "sessions:write"],
      serverIds: ["9"],
      serverProjectIds: { "9": "project-1" },
      maxConcurrentSessions: 3,
    });
    await store.touch("token-1", "2026-07-30T00:00:00.000Z");
    expect(
      sqlite.prepare("SELECT last_used_at FROM agent_access_tokens").get(),
    ).toEqual({ last_used_at: "2026-07-30T00:00:00.000Z" });
    sqlite.close();
  });

  it("直接创建 Token，仅保存摘要并可立即撤销", async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE service_accounts (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
        description TEXT, created_by TEXT, is_active INTEGER NOT NULL,
        created_at TEXT, updated_at TEXT
      );
      CREATE TABLE project_hosts (
        id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, host_id INTEGER NOT NULL
      );
      CREATE TABLE agent_access_tokens (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
        service_account_id TEXT NOT NULL, name TEXT NOT NULL,
        token_prefix TEXT NOT NULL, token_hash TEXT NOT NULL,
        token_salt TEXT NOT NULL, scopes TEXT NOT NULL,
        max_concurrent_sessions INTEGER NOT NULL, is_active INTEGER NOT NULL,
        expires_at TEXT, last_used_at TEXT, created_at TEXT, revoked_at TEXT,
        access_mode TEXT NOT NULL DEFAULT 'selected', created_by_user_id TEXT
      );
      CREATE TABLE agent_token_projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT, token_id TEXT NOT NULL,
        project_id TEXT NOT NULL, service_account_id TEXT,
        granted_by TEXT, created_at TEXT
      );
      INSERT INTO project_hosts VALUES (9, 'project-1', 42);
    `);
    const repository = new AgentTokenAdminRepository(sqlite);
    const created = await repository.createToken({
      createdBy: "admin-1",
      name: "ci",
      scopes: ["sessions:create", "sessions:read"],
      accessMode: "selected",
      projectIds: ["project-1"],
      maxConcurrentSessions: 2,
      expiresAt: null,
    });
    expect(created?.token).toMatch(/^cssh_/);
    const persisted = sqlite
      .prepare("SELECT token_hash, token_salt FROM agent_access_tokens")
      .get() as { token_hash: string; token_salt: string };
    expect(JSON.stringify(persisted)).not.toContain(created!.token);
    expect(persisted.token_hash).not.toBe(created!.token);

    const credentialStore = new SqliteAgentCredentialStore(
      sqlite,
      undefined,
      async () => ["project-1"],
    );
    expect(
      await credentialStore.findActiveByPrefix(created!.tokenPrefix),
    ).toHaveLength(1);
    expect(
      await repository.revokeToken({
        tokenId: created!.id,
        userId: "admin-1",
        manageableProjectIds: ["project-1"],
        isInstanceAdmin: false,
      }),
    ).toBe(true);
    expect(
      await credentialStore.findActiveByPrefix(created!.tokenPrefix),
    ).toHaveLength(0);
    sqlite.close();
  });
});

class TestSessionDriver implements AgentSessionDriver {
  readonly writes: string[] = [];
  readonly sinks = new Map<string, DriverOutputSink>();
  readonly sinkHistory = new Map<string, DriverOutputSink[]>();
  readonly recoveries: string[] = [];
  readonly persistentCloses: string[] = [];

  private rememberSink(sessionId: string, sink: DriverOutputSink) {
    this.sinks.set(sessionId, sink);
    const history = this.sinkHistory.get(sessionId) ?? [];
    history.push(sink);
    this.sinkHistory.set(sessionId, history);
  }

  async create(session: AgentSessionRecord, sink: DriverOutputSink) {
    this.rememberSink(session.id, sink);
    await sink.onOutput("ready\n");
    return { runtimeId: `runtime:${session.id}` };
  }

  async recover(session: AgentSessionRecord, sink: DriverOutputSink) {
    this.rememberSink(session.id, sink);
    this.recoveries.push(session.id);
    return { runtimeId: `runtime:${session.id}:recovered` };
  }

  async write(_runtimeId: string, data: string) {
    this.writes.push(data);
  }

  async resize() {}

  async close() {}

  async closePersistent(session: AgentSessionRecord) {
    this.persistentCloses.push(session.id);
  }
}

class BlockingWriteSessionDriver extends TestSessionDriver {
  private markWriteStarted!: () => void;
  private releasePendingWrite!: () => void;
  readonly writeStarted = new Promise<void>((resolve) => {
    this.markWriteStarted = resolve;
  });
  private readonly pendingWrite = new Promise<void>((resolve) => {
    this.releasePendingWrite = resolve;
  });

  override async write(runtimeId: string, data: string) {
    this.markWriteStarted();
    await this.pendingWrite;
    await super.write(runtimeId, data);
  }

  releaseWrite() {
    this.releasePendingWrite();
  }
}

class RetryCloseSessionDriver extends TestSessionDriver {
  closeAttempts = 0;

  override async close() {
    this.closeAttempts += 1;
    if (this.closeAttempts === 1) throw new Error("temporary close failure");
  }
}

class CloseTrackingSessionDriver extends TestSessionDriver {
  readonly closedRuntimeIds: string[] = [];

  override async close(runtimeId: string) {
    this.closedRuntimeIds.push(runtimeId);
  }
}

class RuntimeMissingOnCloseSessionDriver extends TestSessionDriver {
  override async close(runtimeId: string) {
    const sessionId = runtimeId.replace(/^runtime:/, "");
    await this.sinks.get(sessionId)?.onExit(0);
    throw new AgentApiError(409, "SESSION_RUNTIME_MISSING", "会话运行时不存在");
  }
}

class CommitThenFailAtUpdateStore implements AgentStateStore {
  private readonly memory = new MemoryAgentStateStore();
  private updates = 0;

  constructor(private readonly failAt: number) {}

  read(): Promise<AgentPersistentState> {
    return this.memory.read();
  }

  async update<T>(
    mutator: (state: AgentPersistentState) => T | Promise<T>,
  ): Promise<T> {
    this.updates += 1;
    const result = await this.memory.update(mutator);
    if (this.updates === this.failAt) {
      throw new Error("durable mirror failed after commit");
    }
    return result;
  }
}

class CountingAgentStateStore implements AgentStateStore {
  private readonly memory = new MemoryAgentStateStore();
  reads = 0;
  updates = 0;

  async read(): Promise<AgentPersistentState> {
    this.reads += 1;
    return this.memory.read();
  }

  async update<T>(
    mutator: (state: AgentPersistentState) => T | Promise<T>,
  ): Promise<T> {
    this.updates += 1;
    return this.memory.update(mutator);
  }
}

class TestJobDriver implements AgentJobDriver {
  async run(input: RunJobInput) {
    return { stdout: `${input.command}\n`, stderr: "", exitCode: 0 };
  }
}

describe("SQLite Agent server directory", () => {
  it("拒绝没有服务器发现用途权限的设备列出资产", async () => {
    const directory = new MemoryAgentServerDirectory([
      { hostId: 1, serverId: "11", name: "Server", connectionType: "ssh" },
    ]);

    await expect(
      directory.list({
        principalId: "device:close-only",
        serviceAccountId: "service-1",
        projectId: "project-1",
        name: "close-only",
        scopes: ["sessions:close"],
        serverIds: ["11"],
        maxConcurrentSessions: 1,
      }),
    ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  });

  it("返回授权项目内全部服务器且不读取 SSH 凭据", async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE ssh_data (
        id INTEGER PRIMARY KEY,
        name TEXT,
        connection_type TEXT NOT NULL,
        ip TEXT NOT NULL,
        username TEXT NOT NULL,
        password TEXT,
        key TEXT
      );
      CREATE TABLE project_hosts (
        id INTEGER PRIMARY KEY,
        project_id TEXT NOT NULL,
        host_id INTEGER NOT NULL,
        alias TEXT
      );
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO projects VALUES
        ('project-1', 'Production'), ('project-2', 'Hidden');
      INSERT INTO ssh_data VALUES
        (1, 'Primary', 'ssh', '10.0.0.1', 'root', 'secret-one', 'key-one'),
        (2, 'Secondary', 'telnet', '10.0.0.2', 'admin', 'secret-two', 'key-two'),
        (3, 'Other project', 'ssh', '10.0.0.3', 'root', 'secret-three', 'key-three');
      INSERT INTO project_hosts VALUES
        (11, 'project-1', 1, 'Production API'),
        (12, 'project-1', 2, NULL),
        (13, 'project-2', 3, 'Hidden');
    `);
    try {
      const directory = new SqliteAgentServerDirectory(sqlite);
      const servers = await directory.list({
        principalId: "token:token-1",
        serviceAccountId: "service-1",
        projectId: "project-1",
        name: "robot",
        scopes: ["sessions:read"],
        serverIds: ["11", "12"],
        maxConcurrentSessions: 1,
      });
      expect(servers).toEqual([
        {
          hostId: 1,
          serverId: "11",
          name: "Production API",
          connectionType: "ssh",
          projectId: "project-1",
          projectName: "Production",
        },
        {
          hostId: 2,
          serverId: "12",
          name: "Secondary",
          connectionType: "telnet",
          projectId: "project-1",
          projectName: "Production",
        },
      ]);
      expect(JSON.stringify(servers)).not.toMatch(
        /10\.0\.0\.|root|secret|key-one/i,
      );
    } finally {
      sqlite.close();
    }
  });

  it("返回主机地址、端口、项目分类和标签但不返回认证材料", async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE ssh_data (
        id INTEGER PRIMARY KEY,
        name TEXT,
        connection_type TEXT NOT NULL,
        ip TEXT NOT NULL,
        port INTEGER NOT NULL,
        tags TEXT,
        username TEXT NOT NULL,
        password TEXT,
        key TEXT
      );
      CREATE TABLE project_hosts (
        id INTEGER PRIMARY KEY,
        project_id TEXT NOT NULL,
        host_id INTEGER NOT NULL,
        alias TEXT,
        folder TEXT
      );
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO projects VALUES ('project-1', 'Production');
      INSERT INTO ssh_data VALUES
        (1, 'Primary', 'ssh', '203.0.113.10', 2222,
         'linux, production', 'deploy', 'never-return-password',
         'never-return-key');
      INSERT INTO project_hosts VALUES
        (11, 'project-1', 1, 'Production API', '生产 / API');
    `);
    try {
      const servers = await new SqliteAgentServerDirectory(sqlite).list({
        principalId: "device:device-1",
        serviceAccountId: "service-1",
        projectId: "project-1",
        name: "robot",
        scopes: ["files:read"],
        serverIds: ["11"],
        maxConcurrentSessions: 1,
      });
      expect(servers).toEqual([
        {
          hostId: 1,
          serverId: "11",
          name: "Production API",
          connectionType: "ssh",
          projectId: "project-1",
          projectName: "Production",
          address: "203.0.113.10",
          port: 2222,
          folder: "生产 / API",
          tags: ["linux", "production"],
        },
      ]);
      expect(JSON.stringify(servers)).not.toMatch(
        /deploy|never-return-password|never-return-key/i,
      );
    } finally {
      sqlite.close();
    }
  });

  it("同一主机分享至多个项目时返回相同 hostId 和不同 serverId", async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE ssh_data (
        id INTEGER PRIMARY KEY,
        name TEXT,
        connection_type TEXT NOT NULL,
        ip TEXT NOT NULL
      );
      CREATE TABLE project_hosts (
        id INTEGER PRIMARY KEY,
        project_id TEXT NOT NULL,
        host_id INTEGER NOT NULL,
        alias TEXT
      );
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO projects VALUES
        ('project-1', 'Personal'), ('project-2', 'Team');
      INSERT INTO ssh_data VALUES
        (42, 'Shared host', 'ssh', '203.0.113.42');
      INSERT INTO project_hosts VALUES
        (101, 'project-1', 42, NULL),
        (202, 'project-2', 42, 'Team alias');
    `);
    try {
      const servers = await new SqliteAgentServerDirectory(sqlite).list({
        principalId: "device:device-1",
        serviceAccountId: "service-1",
        projectId: "project-1",
        name: "robot",
        scopes: ["sessions:read"],
        serverIds: ["101", "202"],
        maxConcurrentSessions: 1,
      });

      expect(servers).toEqual([
        {
          hostId: 42,
          serverId: "101",
          name: "Shared host",
          connectionType: "ssh",
          projectId: "project-1",
          projectName: "Personal",
        },
        {
          hostId: 42,
          serverId: "202",
          name: "Team alias",
          connectionType: "ssh",
          projectId: "project-2",
          projectName: "Team",
        },
      ]);
      expect(new Set(servers.map((server) => server.hostId))).toEqual(
        new Set([42]),
      );
      expect(new Set(servers.map((server) => server.serverId))).toEqual(
        new Set(["101", "202"]),
      );
    } finally {
      sqlite.close();
    }
  });
});

async function tokenRecord(
  overrides: Partial<AgentTokenRecord> = {},
): Promise<AgentTokenRecord> {
  const hashed = await hashAgentToken(RAW_TOKEN);
  return {
    id: "token-1",
    principalId: "token:token-1",
    serviceAccountId: "service-1",
    projectId: "project-1",
    name: "test-agent",
    scopes: [
      "sessions:create",
      "sessions:read",
      "sessions:write",
      "sessions:close",
      "jobs:execute",
    ],
    serverIds: ["server-1"],
    maxConcurrentSessions: 2,
    tokenPrefix: RAW_TOKEN.slice(0, 13),
    tokenSalt: hashed.salt,
    tokenHash: hashed.hash,
    expiresAt: null,
    active: true,
    lastUsedAt: null,
    ...overrides,
  };
}

describe("跨项目 Agent 操作", () => {
  it("仅兼容旧哈希的无 runtimeMode tmux 重试，且不受 resize 影响", async () => {
    const state = new MemoryAgentStateStore();
    const broker = new AgentSessionBroker(state, new TestSessionDriver());
    const principal = await tokenRecord();
    const migrated = await broker.create(
      principal,
      {
        serverId: "server-1",
        cols: 120,
        rows: 30,
        pinned: false,
        runtimeMode: "tmux",
      },
      "legacy-runtime-request",
    );

    // 新版显式 tmux 请求不能被省略 runtimeMode 的新版默认 platform 请求复用。
    await expect(
      broker.create(
        principal,
        { serverId: "server-1", cols: 120, rows: 30, pinned: false },
        "legacy-runtime-request",
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const legacyRequestHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          serverId: "server-1",
          cols: 120,
          rows: 30,
          pinned: false,
        }),
      )
      .digest("hex");
    await state.update((draft) => {
      const session = draft.sessions.find((item) => item.id === migrated.id)!;
      // 模拟 .21 会话随后被 resize；旧创建哈希仍保留初始尺寸。
      session.cols = 180;
      session.rows = 45;
      const record = draft.idempotency.find(
        (item) =>
          (item.response as { sessionId?: string }).sessionId === migrated.id,
      )!;
      record.requestHash = legacyRequestHash;
    });

    await expect(
      broker.create(
        principal,
        { serverId: "server-1", cols: 120, rows: 30, pinned: false },
        "legacy-runtime-request",
      ),
    ).resolves.toMatchObject({
      id: migrated.id,
      runtimeMode: "tmux",
      cols: 180,
      rows: 45,
    });
    await expect(
      broker.create(
        principal,
        {
          serverId: "server-1",
          cols: 120,
          rows: 30,
          pinned: false,
          runtimeMode: "platform",
        },
        "legacy-runtime-request",
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("Broker 重启后收敛 CLOSING：platform 直接关闭，tmux 定位后终止", async () => {
    const state = new MemoryAgentStateStore();
    const principal = await tokenRecord({ maxConcurrentSessions: 4 });
    const firstBroker = new AgentSessionBroker(state, new TestSessionDriver());
    const platform = await firstBroker.create(
      principal,
      {
        serverId: "server-1",
        cols: 120,
        rows: 30,
        pinned: false,
        runtimeMode: "platform",
      },
      "closing-platform",
    );
    const tmux = await firstBroker.create(
      principal,
      {
        serverId: "server-1",
        cols: 120,
        rows: 30,
        pinned: true,
        runtimeMode: "tmux",
      },
      "closing-tmux",
    );
    await state.update((draft) => {
      for (const session of draft.sessions) {
        session.state = "CLOSING";
        session.failureReason = "process interrupted";
      }
    });

    const restartedDriver = new TestSessionDriver();
    const restartedBroker = new AgentSessionBroker(state, restartedDriver);
    await restartedBroker.recoverActiveSessions();

    const recovered = await state.read();
    const closedSessions = recovered.sessions.map((session) => ({
      id: session.id,
      state: session.state,
      runtimeId: session.runtimeId,
      failureReason: session.failureReason,
    }));
    expect(closedSessions).toHaveLength(2);
    expect(closedSessions).toEqual(
      expect.arrayContaining([
        {
          id: platform.id,
          state: "CLOSED",
          runtimeId: null,
          failureReason: null,
        },
        {
          id: tmux.id,
          state: "CLOSED",
          runtimeId: null,
          failureReason: null,
        },
      ]),
    );
    expect(restartedDriver.persistentCloses).toEqual([tmux.id]);
    expect(restartedDriver.recoveries).toEqual([]);
  });

  it("运行时状态提交失败时关闭刚创建的 SSH 运行时", async () => {
    const store = new CommitThenFailAtUpdateStore(3);
    const driver = new CloseTrackingSessionDriver();
    const broker = new AgentSessionBroker(store, driver);
    const principal = await tokenRecord();

    await expect(
      broker.create(
        principal,
        { serverId: "server-1", cols: 120, rows: 30, pinned: false },
        "runtime-state-commit-failure",
      ),
    ).rejects.toThrow("durable mirror failed after commit");

    const [session] = (await store.read()).sessions;
    expect(driver.closedRuntimeIds).toEqual([`runtime:${session.id}`]);
    expect(session).toMatchObject({
      state: "FAILED",
      runtimeId: null,
    });
  });

  it("按 serverId 写入真实项目和对应内部身份", async () => {
    const state = new MemoryAgentStateStore();
    const principal = await tokenRecord({
      projectIds: ["project-1", "project-2"],
      serverIds: ["server-1", "server-2"],
      serverProjectIds: {
        "server-1": "project-1",
        "server-2": "project-2",
      },
      serverServiceAccountIds: {
        "server-1": "service-1",
        "server-2": "service-2",
      },
    });
    const jobs = new AgentJobManager(state, new TestJobDriver());
    const created = await jobs.create(
      principal,
      { serverId: "server-2", command: "hostname", timeoutMs: 30_000 },
      "cross-project",
    );

    expect(created).toMatchObject({
      projectId: "project-2",
      serviceAccountId: "service-2",
      serverId: "server-2",
    });
    expect((await jobs.list(principal)).map((job) => job.id)).toContain(
      created.id,
    );
  });

  it("跨项目会话共享同一个 Token 并发上限", async () => {
    const state = new MemoryAgentStateStore();
    const principal = await tokenRecord({
      serviceAccountIds: ["service-1", "service-2"],
      projectIds: ["project-1", "project-2"],
      serverIds: ["server-1", "server-2"],
      serverProjectIds: {
        "server-1": "project-1",
        "server-2": "project-2",
      },
      serverServiceAccountIds: {
        "server-1": "service-1",
        "server-2": "service-2",
      },
      maxConcurrentSessions: 1,
    });
    const broker = new AgentSessionBroker(
      state,
      new TestSessionDriver(),
      60_000,
    );
    await broker.create(
      principal,
      { serverId: "server-2", cols: 120, rows: 30, pinned: false },
      "cross-project-first",
    );

    await expect(
      broker.create(
        principal,
        { serverId: "server-1", cols: 120, rows: 30, pinned: false },
        "cross-project-second",
      ),
    ).rejects.toMatchObject({ code: "SESSION_LIMIT_REACHED" });
  });

  it("项目顺序或授权变化后仍复用同一设备的幂等键和写入租约", async () => {
    const state = new MemoryAgentStateStore();
    const driver = new TestSessionDriver();
    const broker = new AgentSessionBroker(state, driver, 60_000);
    const jobs = new AgentJobManager(state, new TestJobDriver());
    const before = await tokenRecord({
      principalId: "device:approved-device",
      serviceAccountId: "service-1",
      serviceAccountIds: ["service-1", "service-2"],
      projectId: "project-1",
      projectIds: ["project-1", "project-2"],
      serverIds: ["server-1", "server-2"],
      serverProjectIds: {
        "server-1": "project-1",
        "server-2": "project-2",
      },
      serverServiceAccountIds: {
        "server-1": "service-1",
        "server-2": "service-2",
      },
    });
    const after = {
      ...before,
      serviceAccountId: "service-2",
      serviceAccountIds: ["service-2"],
      projectId: "project-2",
      projectIds: ["project-2"],
      serverIds: ["server-2"],
      serverProjectIds: { "server-2": "project-2" },
      serverServiceAccountIds: { "server-2": "service-2" },
    };

    const created = await broker.create(
      before,
      { serverId: "server-2", cols: 120, rows: 30, pinned: false },
      "stable-session",
    );
    const duplicate = await broker.create(
      after,
      { serverId: "server-2", cols: 120, rows: 30, pinned: false },
      "stable-session",
    );
    expect(duplicate.id).toBe(created.id);

    const attached = await broker.attach(
      before,
      created.id,
      "read-write",
      false,
      "stable-attach",
    );
    await broker.write(
      after,
      created.id,
      attached.attachmentId,
      attached.lease!.id,
      "hostname\n",
      "stable-write",
    );
    expect(driver.writes).toEqual(["hostname\n"]);

    const firstJob = await jobs.create(
      before,
      { serverId: "server-2", command: "hostname", timeoutMs: 30_000 },
      "stable-job",
    );
    const duplicateJob = await jobs.create(
      after,
      { serverId: "server-2", command: "hostname", timeoutMs: 30_000 },
      "stable-job",
    );
    expect(duplicateJob.id).toBe(firstJob.id);
  });
});

describe("Agent 会话附件生命周期", () => {
  it("只读附件在线时不会启动无人附着清理计时", async () => {
    const state = new MemoryAgentStateStore();
    const broker = new AgentSessionBroker(
      state,
      new TestSessionDriver(),
      60_000,
      undefined,
      60_000,
    );
    const principal = await tokenRecord();
    const created = await broker.create(
      principal,
      { serverId: "server-1", cols: 120, rows: 30, pinned: false },
      "read-only-retention",
    );
    const attached = await broker.attach(
      principal,
      created.id,
      "read-only",
      false,
      "read-only-attach",
    );

    expect(await broker.cleanupExpiredSessions(0)).toBe(0);
    expect(await broker.status(principal, created.id)).toMatchObject({
      state: "RUNNING",
      lastDetachedAt: null,
      attachments: [
        {
          id: attached.attachmentId,
          principalId: principal.principalId,
          mode: "read-only",
        },
      ],
    });

    await broker.detach(principal, created.id, attached.attachmentId);
    expect(await broker.cleanupExpiredSessions(0)).toBe(1);
    expect(await broker.status(principal, created.id)).toMatchObject({
      state: "CLOSED",
      attachments: [],
    });
  });

  it("无人会话关闭失败时保留运行时并在下一轮重试", async () => {
    const state = new MemoryAgentStateStore();
    const driver = new RetryCloseSessionDriver();
    const broker = new AgentSessionBroker(state, driver);
    const principal = await tokenRecord();
    const created = await broker.create(
      principal,
      { serverId: "server-1", cols: 120, rows: 30, pinned: false },
      "retry-expired-close",
    );

    expect(await broker.cleanupExpiredSessions(0)).toBe(0);
    expect(await broker.status(principal, created.id)).toMatchObject({
      state: "CLOSING",
      failureReason: "temporary close failure",
    });
    expect(
      (await state.read()).sessions.find((session) => session.id === created.id)
        ?.runtimeId,
    ).toBe(`runtime:${created.id}`);

    expect(await broker.cleanupExpiredSessions(0)).toBe(1);
    expect(driver.closeAttempts).toBe(2);
    expect(await broker.status(principal, created.id)).toMatchObject({
      state: "CLOSED",
      failureReason: null,
    });
  });

  it("只有附件所属设备可以断开，最后一个附件离开后才记录时间", async () => {
    const state = new MemoryAgentStateStore();
    const broker = new AgentSessionBroker(state, new TestSessionDriver());
    const owner = await tokenRecord({ principalId: "device:owner" });
    const other = await tokenRecord({ principalId: "device:other" });
    const created = await broker.create(
      owner,
      { serverId: "server-1", cols: 120, rows: 30, pinned: false },
      "attachment-owner",
    );
    const first = await broker.attach(
      owner,
      created.id,
      "read-only",
      false,
      "owner-attach",
    );
    const second = await broker.attach(
      other,
      created.id,
      "read-only",
      false,
      "other-attach",
    );

    await expect(
      broker.detach(other, created.id, first.attachmentId),
    ).rejects.toMatchObject({ code: "ATTACHMENT_NOT_FOUND" });
    await broker.detach(owner, created.id, first.attachmentId);
    expect(await broker.status(owner, created.id)).toMatchObject({
      lastDetachedAt: null,
      attachments: [{ id: second.attachmentId }],
    });
    await broker.detach(other, created.id, second.attachmentId);
    const detached = await broker.status(owner, created.id);
    expect(detached.attachments).toEqual([]);
    expect(detached.lastDetachedAt).not.toBeNull();
  });

  it("写入权接管会把原写入附件降级为只读", async () => {
    const state = new MemoryAgentStateStore();
    const broker = new AgentSessionBroker(state, new TestSessionDriver());
    const firstDevice = await tokenRecord({ principalId: "device:first" });
    const secondDevice = await tokenRecord({ principalId: "device:second" });
    const created = await broker.create(
      firstDevice,
      { serverId: "server-1", cols: 120, rows: 30, pinned: false },
      "attachment-takeover",
    );
    const first = await broker.attach(
      firstDevice,
      created.id,
      "read-write",
      false,
      "first-writer-attach",
    );
    const second = await broker.attach(
      secondDevice,
      created.id,
      "read-write",
      true,
      "second-writer-takeover",
    );

    const status = await broker.status(firstDevice, created.id);
    expect(status.attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.attachmentId, mode: "read-only" }),
        expect.objectContaining({
          id: second.attachmentId,
          mode: "read-write",
        }),
      ]),
    );
    await expect(
      broker.write(
        firstDevice,
        created.id,
        first.attachmentId,
        first.lease!.id,
        "whoami\n",
        "stale-lease",
      ),
    ).rejects.toMatchObject({ code: "WRITE_LEASE_INVALID" });
  });

  it("写入权接管等待旧租约的在途写入完成", async () => {
    const state = new MemoryAgentStateStore();
    const driver = new BlockingWriteSessionDriver();
    const broker = new AgentSessionBroker(state, driver, 60_000);
    const firstDevice = await tokenRecord({ principalId: "device:first" });
    const secondDevice = await tokenRecord({ principalId: "device:second" });
    const created = await broker.create(
      firstDevice,
      { serverId: "server-1", cols: 120, rows: 30, pinned: false },
      "serialized-takeover",
    );
    const first = await broker.attach(
      firstDevice,
      created.id,
      "read-write",
      false,
      "serialized-first-attach",
    );
    const pendingWrite = broker.write(
      firstDevice,
      created.id,
      first.attachmentId,
      first.lease!.id,
      "first-command\n",
      "serialized-first-write",
    );
    await driver.writeStarted;

    let takeoverFinished = false;
    const pendingTakeover = broker
      .attach(
        secondDevice,
        created.id,
        "read-write",
        true,
        "serialized-second-attach",
      )
      .then((result) => {
        takeoverFinished = true;
        return result;
      });
    await Promise.resolve();
    expect(takeoverFinished).toBe(false);

    driver.releaseWrite();
    await pendingWrite;
    const second = await pendingTakeover;
    expect(driver.writes).toEqual(["first-command\n"]);
    await expect(
      broker.write(
        firstDevice,
        created.id,
        first.attachmentId,
        first.lease!.id,
        "stale-command\n",
        "serialized-stale-write",
      ),
    ).rejects.toMatchObject({ code: "WRITE_LEASE_INVALID" });
    expect(second.lease?.id).toBeTruthy();
  });

  it("网页观察附件默认只读，接管后才可通过临时写入口输入", async () => {
    const state = new MemoryAgentStateStore();
    const driver = new TestSessionDriver();
    const recorder: AgentSessionRecorder = {
      start: vi.fn(async () => undefined),
      recordInput: vi.fn(async () => undefined),
      recordOutput: vi.fn(async () => undefined),
      end: vi.fn(async () => undefined),
    };
    const broker = new AgentSessionBroker(
      state,
      driver,
      60_000,
      recorder,
      60_000,
    );
    const agent = await tokenRecord({ principalId: "device:agent" });
    const browser = await tokenRecord({ principalId: "web-user:operator" });
    const created = await broker.create(
      agent,
      { serverId: "server-1", cols: 120, rows: 30, pinned: false },
      "browser-observer-session",
    );
    const agentWriter = await broker.attach(
      agent,
      created.id,
      "read-write",
      false,
      "agent-writer",
    );
    const observer = await broker.attach(
      browser,
      created.id,
      "read-only",
      false,
      "browser-observer",
    );

    await expect(
      broker.writeEphemeral(
        browser,
        created.id,
        observer.attachmentId,
        agentWriter.lease!.id,
        "blocked\n",
      ),
    ).rejects.toMatchObject({ code: "WRITE_LEASE_INVALID" });
    expect(driver.writes).toEqual([]);

    const takeover = await broker.attach(
      browser,
      created.id,
      "read-write",
      true,
      "browser-takeover",
    );
    await broker.writeEphemeral(
      browser,
      created.id,
      takeover.attachmentId,
      takeover.lease!.id,
      "hostname\n",
    );

    expect(driver.writes).toEqual(["hostname\n"]);
    expect(recorder.recordInput).toHaveBeenCalledWith(
      expect.objectContaining({ id: created.id }),
      browser,
      "hostname\n",
    );
    // 高频按键不进入 HTTP 幂等记录，避免终端输入耗尽防重容量。
    expect((await state.read()).idempotency).toHaveLength(4);
  });

  it("连续网页按键批量持久化租约且输入会持续续租", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T00:00:00.000Z"));
    try {
      const state = new CountingAgentStateStore();
      const driver = new TestSessionDriver();
      const broker = new AgentSessionBroker(
        state,
        driver,
        90,
        undefined,
        1_000,
      );
      const browser = await tokenRecord({ principalId: "web-user:operator" });
      const created = await broker.create(
        browser,
        { serverId: "server-1", cols: 120, rows: 30, pinned: false },
        "ephemeral-batch-session",
      );
      const attached = await broker.attach(
        browser,
        created.id,
        "read-write",
        false,
        "ephemeral-batch-writer",
      );
      const updatesBeforeInput = state.updates;

      for (let index = 0; index < 10; index += 1) {
        await broker.writeEphemeral(
          browser,
          created.id,
          attached.attachmentId,
          attached.lease!.id,
          String(index),
        );
        vi.advanceTimersByTime(20);
      }

      expect(driver.writes).toHaveLength(10);
      expect(state.updates - updatesBeforeInput).toBeLessThan(10);

      vi.advanceTimersByTime(91);
      await expect(
        broker.writeEphemeral(
          browser,
          created.id,
          attached.attachmentId,
          attached.lease!.id,
          "expired",
        ),
      ).rejects.toMatchObject({ code: "WRITE_LEASE_INVALID" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("接管写入权会立即废止旧网页的进程内租约快照", async () => {
    const state = new MemoryAgentStateStore();
    const driver = new TestSessionDriver();
    const broker = new AgentSessionBroker(state, driver, 60_000);
    const first = await tokenRecord({ principalId: "web-user:first" });
    const second = await tokenRecord({ principalId: "web-user:second" });
    const created = await broker.create(
      first,
      { serverId: "server-1", cols: 120, rows: 30, pinned: false },
      "ephemeral-takeover-session",
    );
    const firstWriter = await broker.attach(
      first,
      created.id,
      "read-write",
      false,
      "ephemeral-first-writer",
    );
    await broker.writeEphemeral(
      first,
      created.id,
      firstWriter.attachmentId,
      firstWriter.lease!.id,
      "before-takeover",
    );

    await broker.attach(
      second,
      created.id,
      "read-write",
      true,
      "ephemeral-second-writer",
    );
    await expect(
      broker.writeEphemeral(
        first,
        created.id,
        firstWriter.attachmentId,
        firstWriter.lease!.id,
        "stale-input",
      ),
    ).rejects.toMatchObject({ code: "WRITE_LEASE_INVALID" });
    expect(driver.writes).toEqual(["before-takeover"]);
  });

  it("写租约心跳可续期，其他设备接管后原网页立即降为只读", async () => {
    const state = new MemoryAgentStateStore();
    const broker = new AgentSessionBroker(
      state,
      new TestSessionDriver(),
      60_000,
      undefined,
      60_000,
    );
    const browser = await tokenRecord({ principalId: "web-user:operator" });
    const agent = await tokenRecord({ principalId: "device:agent" });
    const created = await broker.create(
      agent,
      { serverId: "server-1", cols: 120, rows: 30, pinned: false },
      "browser-heartbeat-session",
    );
    const browserWriter = await broker.attach(
      browser,
      created.id,
      "read-write",
      false,
      "browser-writer",
    );
    const active = await broker.keepaliveAttachment(
      browser,
      created.id,
      browserWriter.attachmentId,
      browserWriter.lease!.id,
    );
    expect(active).toMatchObject({
      mode: "read-write",
      lease: { id: browserWriter.lease!.id },
    });

    await broker.attach(agent, created.id, "read-write", true, "agent-retake");
    const demoted = await broker.keepaliveAttachment(
      browser,
      created.id,
      browserWriter.attachmentId,
      browserWriter.lease!.id,
    );
    expect(demoted).toEqual({ mode: "read-only", lease: null });
  });
});

describe("Agent 会话录像生命周期", () => {
  it("调整终端尺寸不会结束录像，显式关闭才结束", async () => {
    const state = new MemoryAgentStateStore();
    const recorder: AgentSessionRecorder = {
      start: vi.fn(async () => undefined),
      recordInput: vi.fn(async () => undefined),
      recordOutput: vi.fn(async () => undefined),
      end: vi.fn(async () => undefined),
    };
    const broker = new AgentSessionBroker(
      state,
      new TestSessionDriver(),
      60_000,
      recorder,
    );
    const principal = await tokenRecord();
    const created = await broker.create(
      principal,
      { serverId: "server-1", cols: 120, rows: 30, pinned: false },
      "recording-lifecycle",
    );
    const attached = await broker.attach(
      principal,
      created.id,
      "read-write",
      false,
      "recording-attach",
    );

    await broker.resize(
      principal,
      created.id,
      attached.attachmentId,
      attached.lease!.id,
      160,
      40,
    );
    expect(recorder.end).not.toHaveBeenCalled();

    await broker.close(principal, created.id);
    expect(recorder.end).toHaveBeenCalledOnce();
    expect(recorder.end).toHaveBeenCalledWith(created.id);
  });

  it("关闭状态已落 sidecar 后重试仍同步主库并结束录像", async () => {
    const state = new MemoryAgentStateStore();
    const update = vi.spyOn(state, "update");
    const recorder: AgentSessionRecorder = {
      start: vi.fn(async () => undefined),
      recordInput: vi.fn(async () => undefined),
      recordOutput: vi.fn(async () => undefined),
      end: vi.fn(async () => undefined),
    };
    const broker = new AgentSessionBroker(
      state,
      new TestSessionDriver(),
      60_000,
      recorder,
    );
    const principal = await tokenRecord();
    const created = await broker.create(
      principal,
      { serverId: "server-1", cols: 120, rows: 30, pinned: false },
      "recording-close-retry",
    );

    await broker.close(principal, created.id);
    update.mockClear();
    vi.mocked(recorder.end).mockClear();

    const retried = await broker.close(principal, created.id);

    expect(retried.state).toBe("CLOSED");
    expect(update).toHaveBeenCalledOnce();
    expect(recorder.end).toHaveBeenCalledOnce();
    expect(recorder.end).toHaveBeenCalledWith(created.id);
  });

  it.each([
    ["platform" as const, false],
    ["tmux" as const, true],
  ])(
    "关闭时运行时恰好自然退出会把 %s 会话收敛为 CLOSED",
    async (runtimeMode, expectsPersistentClose) => {
      const state = new MemoryAgentStateStore();
      const driver = new RuntimeMissingOnCloseSessionDriver();
      const broker = new AgentSessionBroker(state, driver);
      const principal = await tokenRecord();
      const created = await broker.create(
        principal,
        {
          serverId: "server-1",
          cols: 120,
          rows: 30,
          pinned: runtimeMode === "tmux",
          runtimeMode,
        },
        `runtime-missing-close-${runtimeMode}`,
      );

      await expect(broker.close(principal, created.id)).resolves.toMatchObject({
        id: created.id,
        state: "CLOSED",
      });
      expect(driver.persistentCloses).toEqual(
        expectsPersistentClose ? [created.id] : [],
      );
      expect(await broker.status(principal, created.id)).toMatchObject({
        state: "CLOSED",
        failureReason: null,
      });
    },
  );

  it("周期维护不会重复恢复本进程仍在运行的会话", async () => {
    const state = new MemoryAgentStateStore();
    const driver = new TestSessionDriver();
    const broker = new AgentSessionBroker(state, driver);
    const principal = await tokenRecord();
    const created = await broker.create(
      principal,
      { serverId: "server-1", cols: 120, rows: 30, pinned: false },
      "no-duplicate-recovery",
    );

    await broker.recoverActiveSessions();
    await broker.recoverActiveSessions();

    expect(driver.recoveries).toEqual([]);
    expect(await broker.status(principal, created.id)).toMatchObject({
      state: "RUNNING",
      generation: 1,
    });
  });

  it("订阅只推送持久化后的新输出并支持解除订阅", async () => {
    const state = new MemoryAgentStateStore();
    const driver = new TestSessionDriver();
    const broker = new AgentSessionBroker(state, driver);
    const principal = await tokenRecord();
    const created = await broker.create(
      principal,
      { serverId: "server-1", cols: 120, rows: 30, pinned: false },
      "output-subscription",
    );
    const received: Array<{
      generation: number;
      sequence: number;
      data: string;
    }> = [];
    const unsubscribe = await broker.subscribe(principal, created.id, (chunk) =>
      received.push(chunk),
    );

    await driver.sinks.get(created.id)!.onOutput("live-output\n");
    expect(received).toMatchObject([
      { generation: 1, sequence: 1, data: "live-output\n" },
    ]);
    expect(
      (await state.read()).sessions[0].output.map((chunk) => chunk.data),
    ).toEqual(["ready\n", "live-output\n"]);

    unsubscribe();
    await driver.sinks.get(created.id)!.onOutput("after-unsubscribe\n");
    expect(received).toHaveLength(1);

    const ended: Array<{ state: string; failureReason: string | null }> = [];
    await broker.subscribe(
      principal,
      created.id,
      () => undefined,
      (event) => ended.push(event),
    );
    await driver.sinks.get(created.id)!.onExit(1, "remote shell exited");
    expect(ended).toEqual([
      { state: "FAILED", failureReason: "remote shell exited" },
    ]);

    const lateEnded: Array<{ state: string; failureReason: string | null }> =
      [];
    await broker.subscribe(
      principal,
      created.id,
      () => undefined,
      (event) => lateEnded.push(event),
    );
    expect(lateEnded).toEqual([
      { state: "FAILED", failureReason: "remote shell exited" },
    ]);

    await expect(
      broker.subscribe(
        { ...principal, scopes: ["sessions:create"] },
        created.id,
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  });

  it("Broker 重启后旧运行时代次不能关闭或污染新运行时", async () => {
    const state = new MemoryAgentStateStore();
    const driver = new TestSessionDriver();
    const firstBroker = new AgentSessionBroker(state, driver);
    const principal = await tokenRecord();
    const created = await firstBroker.create(
      principal,
      {
        serverId: "server-1",
        cols: 120,
        rows: 30,
        pinned: false,
        runtimeMode: "tmux",
      },
      "runtime-generation",
    );
    const oldSink = driver.sinkHistory.get(created.id)![0];

    const restartedBroker = new AgentSessionBroker(state, driver);
    await restartedBroker.recoverActiveSessions();
    await oldSink.onOutput("stale output\n");
    await oldSink.onExit(255, "stale runtime closed");
    await restartedBroker.recoverActiveSessions();

    expect(driver.recoveries).toEqual([created.id]);
    const current = await restartedBroker.status(principal, created.id);
    expect(current).toMatchObject({ state: "RUNNING", generation: 2 });
    const read = await restartedBroker.read(
      principal,
      created.id,
      undefined,
      256 * 1024,
    );
    expect(read.chunks.map((chunk) => chunk.data)).not.toContain(
      "stale output\n",
    );
  });

  it("恢复过程中关闭会话会回收尚未激活的驱动句柄", async () => {
    const state = new MemoryAgentStateStore();
    const principal = await tokenRecord();
    const firstBroker = new AgentSessionBroker(state, new TestSessionDriver());
    const created = await firstBroker.create(
      principal,
      {
        serverId: "server-1",
        cols: 120,
        rows: 30,
        pinned: false,
        runtimeMode: "tmux",
      },
      "close-during-recovery",
    );
    let signalStarted!: () => void;
    let releaseRecovery!: () => void;
    const started = new Promise<void>((resolve) => (signalStarted = resolve));
    const blocked = new Promise<void>((resolve) => (releaseRecovery = resolve));
    const close = vi.fn(async () => undefined);
    const driver: AgentSessionDriver = {
      create: async () => ({ runtimeId: "unused" }),
      recover: async () => {
        signalStarted();
        await blocked;
        return { runtimeId: "abandoned-runtime" };
      },
      write: async () => undefined,
      resize: async () => undefined,
      close,
      closePersistent: async () => undefined,
    };
    const restartedBroker = new AgentSessionBroker(state, driver);

    const recovery = restartedBroker.recoverActiveSessions();
    await started;
    await restartedBroker.close(principal, created.id);
    releaseRecovery();
    await recovery;

    expect(close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith("abandoned-runtime");
    expect(await restartedBroker.status(principal, created.id)).toMatchObject({
      state: "CLOSED",
      generation: 2,
    });
  });

  it("恢复连接失败后的重试复用同一输出代次", async () => {
    const state = new MemoryAgentStateStore();
    const principal = await tokenRecord();
    const firstBroker = new AgentSessionBroker(state, new TestSessionDriver());
    const created = await firstBroker.create(
      principal,
      {
        serverId: "server-1",
        cols: 120,
        rows: 30,
        pinned: false,
        runtimeMode: "tmux",
      },
      "recovery-retry-generation",
    );
    let attempts = 0;
    const driver: AgentSessionDriver = {
      create: async () => ({ runtimeId: "unused" }),
      recover: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary connection failure");
        return { runtimeId: "recovered-after-retry" };
      },
      write: async () => undefined,
      resize: async () => undefined,
      close: async () => undefined,
      closePersistent: async () => undefined,
    };
    const restartedBroker = new AgentSessionBroker(state, driver);

    await restartedBroker.recoverActiveSessions();
    expect(await restartedBroker.status(principal, created.id)).toMatchObject({
      state: "RECOVERING",
      generation: 2,
    });
    await restartedBroker.recoverActiveSessions();

    expect(attempts).toBe(2);
    expect(await restartedBroker.status(principal, created.id)).toMatchObject({
      state: "RUNNING",
      generation: 2,
    });
  });

  it("Broker 重启后将平台中转会话明确标记为不可恢复", async () => {
    const state = new MemoryAgentStateStore();
    const principal = await tokenRecord();
    const firstBroker = new AgentSessionBroker(state, new TestSessionDriver());
    const created = await firstBroker.create(
      principal,
      { serverId: "server-1", cols: 120, rows: 30, pinned: false },
      "platform-restart-failure",
    );
    const restartedDriver = new TestSessionDriver();
    const restartedBroker = new AgentSessionBroker(state, restartedDriver);

    await restartedBroker.recoverActiveSessions();

    expect(restartedDriver.recoveries).toEqual([]);
    expect(await restartedBroker.status(principal, created.id)).toMatchObject({
      state: "FAILED",
      runtimeMode: "platform",
      generation: 1,
      failureReason: "平台中转会话无法在 CloudSSH 服务重启后恢复",
    });
  });
});

describe("Agent API", () => {
  let server: Server;
  let baseUrl: string;
  let driver: TestSessionDriver;
  let credential: AgentTokenRecord;
  let committedAuditPaths: string[];
  let provisioning: AgentProvisioningService;
  let files: AgentFileService;
  let nonUploadOctetBody: unknown;

  beforeEach(async () => {
    const state = new MemoryAgentStateStore();
    driver = new TestSessionDriver();
    credential = await tokenRecord();
    committedAuditPaths = [];
    nonUploadOctetBody = undefined;
    provisioning = {
      listProjects: vi.fn(async () => [
        { id: "project-1", name: "Production", kind: "team" as const },
      ]),
      listFolders: vi.fn(async () => [
        { path: "生产 / 数据库", color: null, icon: null },
      ]),
      listCredentials: vi.fn(async () => [
        {
          id: "d4479e2a-0434-48e8-98df-57bd477a958f",
          name: "生产密钥",
          username: "deploy",
          authType: "key" as const,
          keyType: "ed25519",
        },
      ]),
      createServer: vi.fn(async (_principal, input) => ({
        serverId: "21",
        hostId: 2,
        projectId: input.projectId,
        name: input.name,
        address: input.address,
        port: input.port,
        folder: input.folder,
        credentialId: input.credentialId,
        temporary: false,
        expiresAt: null,
      })),
      createQuickConnection: vi.fn(async (_principal, input) => ({
        serverId: "22",
        hostId: 3,
        projectId: input.projectId,
        name: input.name,
        address: input.address,
        port: input.port,
        folder: null,
        credentialId: input.credentialId,
        temporary: true,
        expiresAt: "2026-08-02T00:30:00.000Z",
      })),
      cleanupExpiredQuickConnections: vi.fn(async () => 0),
    };
    files = {
      list: vi.fn(async (_principal, _serverId, remotePath) => ({
        path: remotePath,
        files: [
          {
            name: "hosts",
            path: `${remotePath}/hosts`,
            type: "file" as const,
            size: 20,
            modifiedAt: null,
            permissions: 0o100644,
          },
        ],
      })),
      read: vi.fn(async (_principal, _serverId, remotePath) => ({
        path: remotePath,
        content: "127.0.0.1 localhost\n",
        encoding: "utf8" as const,
        size: 20,
        truncated: false,
      })),
      upload: vi.fn(
        async (
          _principal,
          serverId,
          remotePath,
          data,
          _idempotencyKey,
          _signal,
          onCommitted,
        ) => {
          const received = await readFileUpload(data);
          onCommitted?.();
          return { serverId, path: remotePath, size: received.length };
        },
      ),
      download: vi.fn(
        async (_principal, serverId, remotePath, openDestination) => {
          const file = { serverId, path: remotePath, size: 3 };
          const destination = openDestination(file);
          destination.write(Buffer.from([9]));
          destination.end(Buffer.from([8, 7]));
          return file;
        },
      ),
      mkdir: vi.fn(
        async (
          _principal,
          serverId,
          remotePath,
          _recursive,
          _idempotencyKey,
          _signal,
          onCommitted,
        ) => {
          onCommitted?.();
          return { serverId, path: remotePath };
        },
      ),
      rename: vi.fn(
        async (
          _principal,
          serverId,
          sourcePath,
          destinationPath,
          _idempotencyKey,
          _signal,
          onCommitted,
        ) => {
          onCommitted?.();
          return { serverId, sourcePath, destinationPath };
        },
      ),
      delete: vi.fn(
        async (
          _principal,
          serverId,
          remotePath,
          _recursive,
          _idempotencyKey,
          _signal,
          onCommitted,
        ) => {
          onCommitted?.();
          return { serverId, path: remotePath };
        },
      ),
    };
    const app = createAgentApp({
      preAuthenticateUpload: (req, res, next) => {
        if (req.header("x-test-device") !== "approved-device") {
          res.status(401).json({
            error: "缺少有效的设备签名",
            code: "DEVICE_SIGNATURE_REQUIRED",
          });
          return;
        }
        next();
      },
      authenticate: (req, res, next) => {
        if (
          req.originalUrl.startsWith("/agent/v1/sessions") &&
          req.header("content-type") === "application/octet-stream"
        ) {
          nonUploadOctetBody = req.body;
        }
        if (req.header("authorization")?.startsWith("Bearer ")) {
          res.status(401).json({
            error: "Agent Token 登录已停用",
            code: "TOKEN_AUTH_REMOVED",
          });
          return;
        }
        if (req.header("x-test-device") !== "approved-device") {
          res.status(401).json({
            error: "缺少有效的设备签名",
            code: "DEVICE_SIGNATURE_REQUIRED",
          });
          return;
        }
        const authenticated = req as AgentAuthenticatedRequest;
        authenticated.agentDeviceId = "approved-device";
        authenticated.agentPrincipal = credential;
        next();
      },
      servers: new MemoryAgentServerDirectory([
        {
          hostId: 1,
          serverId: "server-1",
          name: "Production",
          connectionType: "ssh",
        },
        {
          hostId: 2,
          serverId: "server-denied",
          name: "Denied",
          connectionType: "ssh",
        },
      ]),
      sessions: new AgentSessionBroker(state, driver, 60_000),
      jobs: new AgentJobManager(state, new TestJobDriver()),
      provisioning,
      files,
      audit: {
        async record(
          req: AgentAuthenticatedRequest,
          _statusCode: number,
          _responseCompleted = true,
          stage: "intent" | "result" = "result",
        ) {
          if (stage === "result" && req.agentOperationCommitted) {
            committedAuditPaths.push(req.path);
          }
        },
      },
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("listen failed");
    baseUrl = `http://127.0.0.1:${address.port}/agent/v1`;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  const request = (path: string, init: RequestInit = {}) =>
    fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "x-test-device": "approved-device",
        "x-cloudssh-device-id": "approved-device",
        "content-type": "application/json",
        ...init.headers,
      },
    });

  it("生产环境仅对健康检查豁免 HTTPS", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const forwardedHeaders = {
      "x-forwarded-for": "203.0.113.10",
      "x-forwarded-proto": "http",
    };

    const health = await fetch(`${baseUrl}/health`, {
      headers: forwardedHeaders,
    });
    expect(health.status).toBe(200);

    const rejected = await request("/servers", {
      headers: forwardedHeaders,
    });
    expect(rejected.status).toBe(426);
    expect((await rejected.json()).code).toBe("HTTPS_REQUIRED");

    const accepted = await request("/servers", {
      headers: {
        "x-forwarded-for": "203.0.113.10",
        "x-forwarded-proto": "https",
      },
    });
    expect(accepted.status).toBe(200);
  });

  it("允许已配置的网页开发来源预检 Agent API", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const response = await fetch(`${baseUrl}/sessions`, {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "POST",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5173",
    );
    expect(response.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );
  });

  it("拒绝缺失设备认证及已停用的 Agent Token", async () => {
    const missing = await fetch(`${baseUrl}/sessions`);
    expect(missing.status).toBe(401);
    expect((await missing.json()).code).toBe("DEVICE_SIGNATURE_REQUIRED");

    const legacyToken = await fetch(`${baseUrl}/sessions`, {
      headers: { authorization: "Bearer cssh_invalid_invalid_invalid" },
    });
    expect(legacyToken.status).toBe(401);
    expect((await legacyToken.json()).code).toBe("TOKEN_AUTH_REMOVED");
  });

  it("只列出授权项目中的服务器且不返回连接凭据", async () => {
    const response = await request("/servers");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.servers).toEqual([
      {
        hostId: 1,
        serverId: "server-1",
        name: "Production",
        connectionType: "ssh",
      },
    ]);
    expect(JSON.stringify(body)).not.toMatch(
      /password|privateKey|credentialId|username|address/i,
    );
  });

  it("通过文件 API 传输二进制并把防重键交给所有写操作", async () => {
    const listed = await (
      await request("/files/list?serverId=server-1&path=%2Fetc")
    ).json();
    expect(listed).toMatchObject({
      path: "/etc",
      files: [{ name: "hosts", path: "/etc/hosts" }],
    });

    const read = await (
      await request("/files/read?serverId=server-1&path=%2Fetc%2Fhosts")
    ).json();
    expect(read).toMatchObject({
      path: "/etc/hosts",
      content: "127.0.0.1 localhost\n",
    });

    const downloaded = await request(
      "/files/download?serverId=server-1&path=%2Ftmp%2Foutput.bin",
    );
    expect(downloaded.headers.get("content-type")).toContain(
      "application/octet-stream",
    );
    expect(downloaded.headers.get("content-length")).toBeNull();
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(
      Buffer.from([9, 8, 7]),
    );

    const uploadData = Buffer.from([0, 1, 2, 255]);
    const uploaded = await request(
      "/files/upload?serverId=server-1&path=%2Ftmp%2Finput.bin",
      {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "idempotency-key": "upload-route-1",
        },
        body: uploadData,
      },
    );
    expect(uploaded.status).toBe(201);
    expect(await uploaded.json()).toEqual({
      file: { serverId: "server-1", path: "/tmp/input.bin", size: 4 },
    });
    expect(files.upload).toHaveBeenCalledWith(
      credential,
      "server-1",
      "/tmp/input.bin",
      expect.objectContaining({
        size: uploadData.length,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        openStream: expect.any(Function),
      }),
      "upload-route-1",
      expect.any(AbortSignal),
      expect.any(Function),
      expect.any(Function),
    );
    const stagedUpload = vi.mocked(files.upload).mock.calls[0]![3];
    expect(Buffer.isBuffer(stagedUpload)).toBe(false);
    await vi.waitFor(async () => {
      await expect(readFileUpload(stagedUpload)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    const writes = [
      [
        "/files/mkdir",
        "mkdir-route-1",
        { serverId: "server-1", path: "/tmp/new", recursive: true },
      ],
      [
        "/files/rename",
        "rename-route-1",
        {
          serverId: "server-1",
          sourcePath: "/tmp/new",
          destinationPath: "/tmp/current",
        },
      ],
      [
        "/files/delete",
        "delete-route-1",
        { serverId: "server-1", path: "/tmp/current", recursive: true },
      ],
    ] as const;
    for (const [path, key, body] of writes) {
      const response = await request(path, {
        method: "POST",
        headers: { "idempotency-key": key },
        body: JSON.stringify(body),
      });
      expect(response.status).toBeLessThan(300);
    }
    expect(files.mkdir).toHaveBeenCalledWith(
      credential,
      "server-1",
      "/tmp/new",
      true,
      "mkdir-route-1",
      expect.any(AbortSignal),
      expect.any(Function),
      expect.any(Function),
    );
    expect(files.rename).toHaveBeenCalledWith(
      credential,
      "server-1",
      "/tmp/new",
      "/tmp/current",
      "rename-route-1",
      expect.any(AbortSignal),
      expect.any(Function),
      expect.any(Function),
    );
    expect(files.delete).toHaveBeenCalledWith(
      credential,
      "server-1",
      "/tmp/current",
      true,
      "delete-route-1",
      expect.any(AbortSignal),
      expect.any(Function),
      expect.any(Function),
    );
    expect(committedAuditPaths).toEqual(
      expect.arrayContaining([
        "/files/upload",
        "/files/mkdir",
        "/files/rename",
        "/files/delete",
      ]),
    );
  });

  it("SFTP 上传失败后清理本地流式暂存文件", async () => {
    let stagedUpload: Buffer | AgentFileUploadSource | undefined;
    files.upload = vi.fn(async (_principal, _serverId, _remotePath, data) => {
      stagedUpload = data;
      throw Object.assign(new Error("SFTP upload failed"), {
        status: 502,
        code: "SFTP_UPLOAD_FAILED",
      });
    });

    const response = await request(
      "/files/upload?serverId=server-1&path=%2Ftmp%2Ffailed.bin",
      {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "idempotency-key": "failed-stream-upload",
        },
        body: Buffer.from("temporary upload"),
      },
    );

    expect(response.status).toBe(502);
    expect((await response.json()).code).toBe("SFTP_UPLOAD_FAILED");
    expect(stagedUpload).toBeDefined();
    await vi.waitFor(async () => {
      await expect(readFileUpload(stagedUpload!)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("非上传端点不会在鉴权前缓冲二进制正文", async () => {
    const response = await request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.from("{}"),
    });

    expect(response.status).toBe(400);
    expect(nonUploadOctetBody).toBeUndefined();
  });

  it("客户端断开时把取消信号传递给活动文件操作", async () => {
    let started!: () => void;
    const operationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let receivedSignal: AbortSignal | undefined;
    files.read = vi.fn(async (_principal, _serverId, remotePath, signal) => {
      receivedSignal = signal;
      started();
      await new Promise<never>((_resolve, reject) => {
        if (!signal) return;
        const onAbort = () =>
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("request aborted"),
          );
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
      return {
        path: remotePath,
        content: "",
        encoding: "utf8" as const,
        size: 0,
        truncated: false,
      };
    });
    const controller = new AbortController();
    const pending = request(
      "/files/read?serverId=server-1&path=%2Ftmp%2Fwait.log",
      { signal: controller.signal },
    );
    await operationStarted;

    controller.abort();

    await expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(receivedSignal?.aborted).toBe(true));
  });

  it("文件上传同时受全局和单设备并发上限保护并在完成后释放名额", async () => {
    let started = 0;
    let markBothStarted!: () => void;
    let releaseUploads!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      markBothStarted = resolve;
    });
    const pendingUploads = new Promise<void>((resolve) => {
      releaseUploads = resolve;
    });
    files.upload = vi.fn(async (_principal, serverId, remotePath, data) => {
      started += 1;
      if (started === 2) markBothStarted();
      await pendingUploads;
      return { serverId, path: remotePath, size: fileUploadSize(data) };
    });

    const upload = (name: string, deviceId: string) =>
      request(`/files/upload?serverId=server-1&path=%2Ftmp%2F${name}`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "idempotency-key": `upload-${name}`,
          "x-cloudssh-device-id": deviceId,
        },
        body: Buffer.from(name),
      });

    const first = upload("first.bin", "device-a");
    await vi.waitFor(() => expect(started).toBe(1));
    const sameDevice = await upload("same-device.bin", "device-a");
    expect(sameDevice.status).toBe(429);
    expect(await sameDevice.json()).toMatchObject({
      code: "FILE_UPLOAD_CONCURRENCY_EXCEEDED",
    });

    const second = upload("second.bin", "device-b");
    try {
      await bothStarted;
      const rejected = await upload("third.bin", "device-c");
      expect(rejected.status).toBe(429);
      expect(await rejected.json()).toMatchObject({
        code: "FILE_UPLOAD_CONCURRENCY_EXCEEDED",
      });
    } finally {
      releaseUploads();
    }

    expect((await first).status).toBe(201);
    expect((await second).status).toBe(201);
    expect(files.upload).toHaveBeenCalledTimes(2);

    const afterRelease = await upload("after-release.bin", "device-a");
    expect(afterRelease.status).toBe(201);
    expect(files.upload).toHaveBeenCalledTimes(3);
  });

  it("上传客户端断开后等待 SFTP 清理完成才释放并发名额", async () => {
    let started = 0;
    let markBothStarted!: () => void;
    let releaseCleanup!: () => void;
    let markCleanupFinished!: () => void;
    let releaseSecond!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      markBothStarted = resolve;
    });
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const cleanupFinished = new Promise<void>((resolve) => {
      markCleanupFinished = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    files.upload = vi.fn(
      async (_principal, serverId, remotePath, data, _key, signal) => {
        if (remotePath.endsWith("after-cleanup.bin")) {
          return { serverId, path: remotePath, size: fileUploadSize(data) };
        }
        started += 1;
        if (started === 2) markBothStarted();
        if (remotePath.endsWith("disconnect.bin")) {
          await new Promise<void>((resolve) => {
            if (signal?.aborted) resolve();
            else
              signal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
          });
          await cleanupGate;
          markCleanupFinished();
          throw signal?.reason instanceof Error
            ? signal.reason
            : new Error("客户端已断开");
        }
        await secondGate;
        return { serverId, path: remotePath, size: fileUploadSize(data) };
      },
    );
    const upload = (name: string, deviceId: string, signal?: AbortSignal) =>
      request(`/files/upload?serverId=server-1&path=%2Ftmp%2F${name}`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "idempotency-key": `cleanup-${name}`,
          "x-cloudssh-device-id": deviceId,
        },
        body: Buffer.from(name),
        signal,
      });

    const controller = new AbortController();
    const disconnected = upload(
      "disconnect.bin",
      "device-a",
      controller.signal,
    ).catch((error: unknown) => error);
    const held = upload("held.bin", "device-b");
    await bothStarted;
    controller.abort();

    const whileCleaning = await upload("while-cleaning.bin", "device-c");
    expect(whileCleaning.status).toBe(429);

    releaseCleanup();
    await cleanupFinished;
    await vi.waitFor(async () => {
      const afterCleanup = await upload("after-cleanup.bin", "device-c");
      expect(afterCleanup.status).toBe(201);
    });

    releaseSecond();
    expect((await held).status).toBe(201);
    expect(await disconnected).toBeInstanceOf(Error);
  });

  it("列出项目、分类和凭据元数据，并在指定分类创建主机", async () => {
    expect(await (await request("/projects")).json()).toEqual({
      projects: [{ id: "project-1", name: "Production", kind: "team" }],
    });
    expect(await (await request("/projects/project-1/folders")).json()).toEqual(
      {
        folders: [{ path: "生产 / 数据库", color: null, icon: null }],
      },
    );
    const credentials = await (
      await request("/projects/project-1/credentials")
    ).json();
    expect(credentials).toEqual({
      credentials: [
        {
          id: "d4479e2a-0434-48e8-98df-57bd477a958f",
          name: "生产密钥",
          username: "deploy",
          authType: "key",
          keyType: "ed25519",
        },
      ],
    });
    expect(JSON.stringify(credentials)).not.toMatch(
      /password|privateKey|keyPassword|secret/i,
    );

    const password = "route-password-must-not-return";
    const response = await request("/servers", {
      method: "POST",
      headers: { "idempotency-key": "create-host-route" },
      body: JSON.stringify({
        projectId: "project-1",
        name: "db-01",
        address: "203.0.113.10",
        port: 22,
        username: "root",
        authType: "password",
        password,
        folder: "生产 / 数据库",
        tags: ["mysql"],
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.server).toMatchObject({
      serverId: "21",
      projectId: "project-1",
      folder: "生产 / 数据库",
    });
    expect(JSON.stringify(body)).not.toContain(password);
    expect(provisioning.createServer).toHaveBeenCalledWith(
      expect.objectContaining({ principalId: "token:token-1" }),
      expect.objectContaining({
        projectId: "project-1",
        folder: "生产 / 数据库",
        password,
      }),
      "create-host-route",
    );
    expect(committedAuditPaths).toContain("/servers");
  });

  it("拒绝无法由平台后台使用的网页 SSH Agent 认证类型", async () => {
    const response = await request("/servers", {
      method: "POST",
      headers: { "idempotency-key": "agent-auth-rejected" },
      body: JSON.stringify({
        projectId: "project-1",
        address: "203.0.113.10",
        username: "root",
        authType: "agent",
      }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("INVALID_INPUT");
    expect(provisioning.createServer).not.toHaveBeenCalled();
  });

  it("覆盖创建、租约、幂等写入、游标读取与关闭", async () => {
    const createBody = JSON.stringify({
      serverId: "server-1",
      cols: 100,
      rows: 32,
    });
    const created = await request("/sessions", {
      method: "POST",
      headers: { "idempotency-key": "create-1" },
      body: createBody,
    });
    expect(created.status).toBe(201);
    const session = (await created.json()).session as {
      id: string;
      state: string;
      runtimeMode: string;
    };
    expect(session.state).toBe("RUNNING");
    expect(session.runtimeMode).toBe("platform");

    const duplicate = await request("/sessions", {
      method: "POST",
      headers: { "idempotency-key": "create-1" },
      body: JSON.stringify({
        serverId: "server-1",
        cols: 100,
        rows: 32,
        runtimeMode: "platform",
      }),
    });
    expect(((await duplicate.json()).session as { id: string }).id).toBe(
      session.id,
    );

    const conflictingMode = await request("/sessions", {
      method: "POST",
      headers: { "idempotency-key": "create-1" },
      body: JSON.stringify({
        serverId: "server-1",
        cols: 100,
        rows: 32,
        runtimeMode: "tmux",
      }),
    });
    expect(conflictingMode.status).toBe(409);
    expect((await conflictingMode.json()).code).toBe("IDEMPOTENCY_CONFLICT");

    const missingAttachKey = await request(`/sessions/${session.id}/attach`, {
      method: "POST",
      body: JSON.stringify({ mode: "read-write" }),
    });
    expect(missingAttachKey.status).toBe(400);
    expect((await missingAttachKey.json()).code).toBe(
      "IDEMPOTENCY_KEY_REQUIRED",
    );

    const attached = await request(`/sessions/${session.id}/attach`, {
      method: "POST",
      headers: { "idempotency-key": "attach-1" },
      body: JSON.stringify({ mode: "read-write" }),
    });
    const attachment = (await attached.json()) as {
      attachmentId: string;
      lease: { id: string };
      session: { attachments: Array<{ id: string }> };
    };
    expect(attachment.lease.id).toBeTruthy();

    const retriedAttach = await request(`/sessions/${session.id}/attach`, {
      method: "POST",
      headers: { "idempotency-key": "attach-1" },
      body: JSON.stringify({ mode: "read-write" }),
    });
    const retriedAttachment = (await retriedAttach.json()) as typeof attachment;
    expect(retriedAttachment.attachmentId).toBe(attachment.attachmentId);
    expect(retriedAttachment.lease.id).toBe(attachment.lease.id);
    expect(retriedAttachment.session.attachments).toHaveLength(1);

    const attachConflict = await request(`/sessions/${session.id}/attach`, {
      method: "POST",
      headers: { "idempotency-key": "attach-1" },
      body: JSON.stringify({ mode: "read-only" }),
    });
    expect(attachConflict.status).toBe(409);
    expect((await attachConflict.json()).code).toBe("IDEMPOTENCY_CONFLICT");

    const writeBody = JSON.stringify({
      attachmentId: attachment.attachmentId,
      leaseId: attachment.lease.id,
      data: "whoami\n",
    });
    const firstWrite = await request(`/sessions/${session.id}/write`, {
      method: "POST",
      headers: { "idempotency-key": "write-1" },
      body: writeBody,
    });
    expect(firstWrite.status).toBe(200);
    await request(`/sessions/${session.id}/write`, {
      method: "POST",
      headers: { "idempotency-key": "write-1" },
      body: writeBody,
    });
    expect(driver.writes).toEqual(["whoami\n"]);

    await driver.sinks.get(session.id)!.onOutput("test-user\n");
    const firstRead = await request(`/sessions/${session.id}/read`);
    const output = (await firstRead.json()) as {
      chunks: Array<{ data: string }>;
      nextCursor: string;
    };
    expect(output.chunks.map((chunk) => chunk.data).join("")).toContain(
      "test-user",
    );

    const secondRead = await request(
      `/sessions/${session.id}/read?cursor=${encodeURIComponent(output.nextCursor)}`,
    );
    expect(((await secondRead.json()) as { chunks: unknown[] }).chunks).toEqual(
      [],
    );

    const closed = await request(`/sessions/${session.id}/close`, {
      method: "POST",
    });
    expect(((await closed.json()).session as { state: string }).state).toBe(
      "CLOSED",
    );
  });

  it("固定会话默认使用 tmux，显式平台模式优先于固定标记", async () => {
    const defaultPinned = await request("/sessions", {
      method: "POST",
      headers: { "idempotency-key": "default-pinned-runtime" },
      body: JSON.stringify({ serverId: "server-1", pinned: true }),
    });
    expect(defaultPinned.status).toBe(201);
    expect((await defaultPinned.json()).session).toMatchObject({
      pinned: true,
      runtimeMode: "tmux",
    });

    const explicitPlatform = await request("/sessions", {
      method: "POST",
      headers: { "idempotency-key": "explicit-platform-runtime" },
      body: JSON.stringify({
        serverId: "server-1",
        pinned: true,
        runtimeMode: "platform",
      }),
    });
    expect(explicitPlatform.status).toBe(201);
    expect((await explicitPlatform.json()).session).toMatchObject({
      pinned: true,
      runtimeMode: "platform",
    });
  });

  it("拒绝未知的会话运行模式", async () => {
    const response = await request("/sessions", {
      method: "POST",
      headers: { "idempotency-key": "invalid-runtime-mode" },
      body: JSON.stringify({
        serverId: "server-1",
        runtimeMode: "screen",
      }),
    });

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("INVALID_INPUT");
  });

  it("阻止第二个写者在未申请接管时获得租约", async () => {
    const created = await request("/sessions", {
      method: "POST",
      headers: { "idempotency-key": "lease-create" },
      body: JSON.stringify({ serverId: "server-1" }),
    });
    const id = ((await created.json()).session as { id: string }).id;
    await request(`/sessions/${id}/attach`, {
      method: "POST",
      headers: { "idempotency-key": "lease-first" },
      body: JSON.stringify({ mode: "read-write" }),
    });
    const conflict = await request(`/sessions/${id}/attach`, {
      method: "POST",
      headers: { "idempotency-key": "lease-second" },
      body: JSON.stringify({ mode: "read-write" }),
    });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).code).toBe("WRITE_LEASE_HELD");
  });

  it("同时执行 Token scope 与项目服务器授权", async () => {
    credential.serverIds = [];
    const deniedServer = await request("/sessions", {
      method: "POST",
      headers: { "idempotency-key": "denied-server" },
      body: JSON.stringify({ serverId: "server-1" }),
    });
    expect(deniedServer.status).toBe(403);
    expect((await deniedServer.json()).code).toBe("SERVER_DENIED");

    credential.serverIds = ["server-1"];
    credential.scopes = ["sessions:read"];
    const deniedScope = await request("/sessions", {
      method: "POST",
      headers: { "idempotency-key": "denied-scope" },
      body: JSON.stringify({ serverId: "server-1" }),
    });
    expect(deniedScope.status).toBe(403);
    expect((await deniedScope.json()).code).toBe("SCOPE_DENIED");
  });

  it("执行结构化 Job 并可读取退出码和输出", async () => {
    const response = await request("/jobs", {
      method: "POST",
      headers: { "idempotency-key": "job-1" },
      body: JSON.stringify({ serverId: "server-1", command: "uname -a" }),
    });
    expect(response.status).toBe(202);
    const id = ((await response.json()).job as { id: string }).id;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const status = await request(`/jobs/${id}`);
    const job = (await status.json()).job as {
      state: string;
      stdout: string;
      exitCode: number;
    };
    expect(job).toMatchObject({
      state: "SUCCEEDED",
      stdout: "uname -a\n",
      exitCode: 0,
    });
  });

  it("所有成功副作用都在结果审计前标记为已提交", async () => {
    const createdResponse = await request("/sessions", {
      method: "POST",
      headers: { "idempotency-key": "audit-session-create" },
      body: JSON.stringify({ serverId: "server-1" }),
    });
    expect(createdResponse.status).toBe(201);
    const sessionId = ((await createdResponse.json()).session as { id: string })
      .id;

    const attachResponse = await request(`/sessions/${sessionId}/attach`, {
      method: "POST",
      headers: { "idempotency-key": "audit-session-attach" },
      body: JSON.stringify({ mode: "read-write" }),
    });
    expect(attachResponse.status).toBe(200);
    const attachment = (await attachResponse.json()) as {
      attachmentId: string;
      lease: { id: string };
    };
    const leaseBody = {
      attachmentId: attachment.attachmentId,
      leaseId: attachment.lease.id,
    };

    expect(
      (
        await request(`/sessions/${sessionId}/resize`, {
          method: "POST",
          body: JSON.stringify({ ...leaseBody, cols: 140, rows: 36 }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(`/sessions/${sessionId}/write`, {
          method: "POST",
          headers: { "idempotency-key": "audit-session-write" },
          body: JSON.stringify({ ...leaseBody, data: "pwd\n" }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(`/sessions/${sessionId}/detach`, {
          method: "POST",
          body: JSON.stringify({ attachmentId: attachment.attachmentId }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(`/sessions/${sessionId}/close`, {
          method: "POST",
        })
      ).status,
    ).toBe(200);

    const jobResponse = await request("/jobs", {
      method: "POST",
      headers: { "idempotency-key": "audit-job-create" },
      body: JSON.stringify({ serverId: "server-1", command: "hostname" }),
    });
    expect(jobResponse.status).toBe(202);
    const jobId = ((await jobResponse.json()).job as { id: string }).id;
    expect(
      (
        await request(`/jobs/${jobId}/cancel`, {
          method: "POST",
        })
      ).status,
    ).toBe(200);

    const expectedPaths = [
      "/sessions",
      `/sessions/${sessionId}/attach`,
      `/sessions/${sessionId}/resize`,
      `/sessions/${sessionId}/write`,
      `/sessions/${sessionId}/detach`,
      `/sessions/${sessionId}/close`,
      "/jobs",
      `/jobs/${jobId}/cancel`,
    ];
    await vi.waitFor(() =>
      expect(committedAuditPaths).toEqual(
        expect.arrayContaining(expectedPaths),
      ),
    );
  });
});
