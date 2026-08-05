import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRepository } from "../database/repositories/host-repository.js";
import type { AgentPrincipal } from "./types.js";

const dependencies = vi.hoisted(() => ({
  listCredentials: vi.fn(),
  assignCredential: vi.fn(),
  removeManagedCredential: vi.fn(),
  initializeCredential: vi.fn(),
  isAdmin: vi.fn(),
  getProjectHostCreationTarget: vi.fn(),
}));

vi.mock("../control-plane/factory.js", () => ({
  createCurrentProjectCredentialRepository: async () => ({
    list: dependencies.listCredentials,
    assignToProjectHost: dependencies.assignCredential,
    removeManagedForProjectHost: dependencies.removeManagedCredential,
  }),
}));

vi.mock("../control-plane/management-repository.js", () => ({
  ManagementRepository: class {
    getProjectHostCreationTarget(...args: unknown[]) {
      return dependencies.getProjectHostCreationTarget(...args);
    }
  },
}));

vi.mock("../database/repositories/factory.js", () => ({
  createCurrentRepositoryContext: () => ({}),
}));

vi.mock("../utils/permission-manager.js", () => ({
  PermissionManager: {
    getInstance: () => ({ isAdmin: dependencies.isAdmin }),
  },
}));

vi.mock("../hosts/host-resolver.js", () => ({
  initializeProjectHostCredential: dependencies.initializeCredential,
}));

import {
  SqliteAgentProvisioningService,
  type AgentServerCreateInput,
} from "./provisioning.js";

function principal(overrides: Partial<AgentPrincipal> = {}): AgentPrincipal {
  return {
    principalId: "device:device-1",
    serviceAccountId: "service-1",
    projectId: "project-1",
    projectIds: ["project-1"],
    name: "测试设备",
    approvedByUserId: "owner-1",
    scopes: ["servers:create", "quick-connections:create"],
    serverIds: [],
    maxConcurrentSessions: 2,
    ...overrides,
  };
}

function serverInput(
  overrides: Partial<AgentServerCreateInput> = {},
): AgentServerCreateInput {
  return {
    projectId: "project-1",
    name: "db-01",
    address: "203.0.113.10",
    port: 22,
    username: "root",
    authType: "none",
    folder: null,
    credentialId: null,
    password: null,
    key: null,
    keyPassword: null,
    keyType: null,
    hostKeyFingerprint: null,
    tags: [],
    notes: null,
    ...overrides,
  };
}

function createFixture() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL
    );
    CREATE TABLE project_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      color TEXT,
      icon TEXT,
      UNIQUE(project_id, path)
    );
    CREATE TABLE ssh_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      sync_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      ip TEXT NOT NULL,
      port INTEGER NOT NULL,
      username TEXT NOT NULL,
      auth_type TEXT NOT NULL,
      tags TEXT,
      host_key_fingerprint TEXT,
      notes TEXT
    );
    CREATE TABLE project_hosts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      host_id INTEGER NOT NULL,
      folder TEXT,
      credential_id TEXT,
      UNIQUE(project_id, host_id)
    );
    CREATE TABLE agent_provisioning_idempotency (
      principal_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      resource_sync_id TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(principal_id, operation, idempotency_key)
    );
    CREATE TABLE agent_quick_connections (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      project_host_id INTEGER NOT NULL UNIQUE,
      host_id INTEGER NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE persistent_sessions (
      id TEXT PRIMARY KEY,
      project_host_id INTEGER NOT NULL,
      state TEXT NOT NULL
    );
    CREATE TABLE web_terminal_sessions (
      id TEXT PRIMARY KEY,
      host_id INTEGER NOT NULL
    );
    CREATE TABLE sync_tombstones (
      user_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      sync_id TEXT NOT NULL,
      UNIQUE(user_id, entity_type, sync_id)
    );
    INSERT INTO projects (id, name, kind) VALUES
      ('project-1', '生产', 'team'),
      ('project-2', '灾备', 'team');
  `);

  const decryptedHosts = new Map<number, Record<string, unknown>>();
  const hosts = {
    createEncryptedForUserWithProject: vi.fn(
      async (
        userId: string,
        host: Record<string, unknown>,
        metadata: {
          projectId: string;
          folder: string | null;
        },
      ) => {
        const result = sqlite
          .prepare(
            `INSERT INTO ssh_data
               (user_id, sync_id, name, ip, port, username, auth_type, tags,
                host_key_fingerprint, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            userId,
            host.syncId,
            host.name,
            host.ip,
            host.port,
            host.username,
            host.authType,
            host.tags,
            host.hostKeyFingerprint,
            host.notes,
          );
        const hostId = Number(result.lastInsertRowid);
        if (metadata.folder) {
          sqlite
            .prepare(
              `INSERT OR IGNORE INTO project_folders (project_id, path)
               VALUES (?, ?)`,
            )
            .run(metadata.projectId, metadata.folder);
        }
        const link = sqlite
          .prepare(
            `INSERT INTO project_hosts (project_id, host_id, folder)
             VALUES (?, ?, ?)`,
          )
          .run(metadata.projectId, hostId, metadata.folder);
        decryptedHosts.set(hostId, { ...host, id: hostId });
        return {
          host: { ...host, id: hostId },
          projectHostId: Number(link.lastInsertRowid),
        };
      },
    ),
    findDecryptedByIdAs: vi.fn(
      async (_userId: string, hostId: number) =>
        decryptedHosts.get(hostId) ?? null,
    ),
    deleteForUser: vi.fn(async (_userId: string, hostId: number) => {
      sqlite.prepare("DELETE FROM project_hosts WHERE host_id = ?").run(hostId);
      sqlite.prepare("DELETE FROM ssh_data WHERE id = ?").run(hostId);
      decryptedHosts.delete(hostId);
      return true;
    }),
  };
  const onWrite = vi.fn(async () => undefined);
  const onHostCreated = vi.fn(async () => undefined);
  const service = new SqliteAgentProvisioningService(
    sqlite,
    hosts as unknown as HostRepository,
    onWrite,
    onHostCreated,
  );
  return { sqlite, hosts, service, onWrite, onHostCreated };
}

describe("Agent 主机创建与快速连接", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.isAdmin.mockResolvedValue(true);
    dependencies.getProjectHostCreationTarget.mockReturnValue({
      id: "project-1",
    });
    dependencies.listCredentials.mockResolvedValue([]);
    dependencies.assignCredential.mockImplementation(
      async (
        _projectId: string,
        projectHostId: number,
        credentialId: string,
      ) => {
        fixture?.sqlite
          .prepare("UPDATE project_hosts SET credential_id = ? WHERE id = ?")
          .run(credentialId, projectHostId);
        return true;
      },
    );
    dependencies.removeManagedCredential.mockResolvedValue(true);
    dependencies.initializeCredential.mockResolvedValue(undefined);
  });

  let fixture: ReturnType<typeof createFixture> | undefined;

  it("同时校验设备权限和授权项目", async () => {
    fixture = createFixture();
    await expect(
      Promise.resolve().then(() =>
        fixture!.service.createServer(
          principal({ scopes: ["sessions:read"] }),
          serverInput(),
          "scope-denied",
        ),
      ),
    ).rejects.toMatchObject({ status: 403, code: "SCOPE_DENIED" });
    await expect(
      Promise.resolve().then(() =>
        fixture!.service.createServer(
          principal(),
          serverInput({ projectId: "project-2" }),
          "project-denied",
        ),
      ),
    ).rejects.toMatchObject({ status: 403, code: "PROJECT_DENIED" });
    fixture.sqlite.close();
  });

  it("主机与快速连接使用彼此独立的设备权限", async () => {
    fixture = createFixture();
    await expect(
      Promise.resolve().then(() =>
        fixture!.service.createQuickConnection(
          principal({ scopes: ["servers:create"] }),
          serverInput({ hostKeyFingerprint: "ab".repeat(32) }),
          "quick-scope-denied",
        ),
      ),
    ).rejects.toMatchObject({ status: 403, code: "SCOPE_DENIED" });
    await expect(
      Promise.resolve().then(() =>
        fixture!.service.createServer(
          principal({ scopes: ["quick-connections:create"] }),
          serverInput(),
          "server-scope-denied",
        ),
      ),
    ).rejects.toMatchObject({ status: 403, code: "SCOPE_DENIED" });
    expect(
      fixture.sqlite.prepare("SELECT COUNT(*) AS count FROM ssh_data").get(),
    ).toEqual({ count: 0 });
    fixture.sqlite.close();
  });

  it("审批用户失去项目管理权或身份缺失后拒绝创建", async () => {
    fixture = createFixture();
    dependencies.getProjectHostCreationTarget.mockImplementationOnce(() => {
      throw new Error("Project administrator required");
    });
    await expect(
      Promise.resolve().then(() =>
        fixture!.service.createServer(
          principal(),
          serverInput(),
          "approver-permission-revoked",
        ),
      ),
    ).rejects.toMatchObject({ status: 403, code: "PROJECT_WRITE_DENIED" });
    await expect(
      Promise.resolve().then(() =>
        fixture!.service.createServer(
          principal({ approvedByUserId: undefined }),
          serverInput(),
          "approver-missing",
        ),
      ),
    ).rejects.toMatchObject({ status: 403, code: "DEVICE_OWNER_UNAVAILABLE" });
    expect(
      fixture.sqlite.prepare("SELECT COUNT(*) AS count FROM ssh_data").get(),
    ).toEqual({ count: 0 });
    fixture.sqlite.close();
  });

  it("可在指定项目分类创建主机，并触发地区信息补查", async () => {
    fixture = createFixture();
    const created = await fixture.service.createServer(
      principal(),
      serverInput({ folder: "生产 / 数据库", tags: ["mysql", "primary"] }),
      "folder-create",
    );
    expect(created).toMatchObject({
      projectId: "project-1",
      folder: "生产 / 数据库",
      temporary: false,
    });
    expect(
      fixture.sqlite
        .prepare("SELECT project_id, path FROM project_folders")
        .get(),
    ).toEqual({ project_id: "project-1", path: "生产 / 数据库" });
    expect(fixture.onHostCreated).toHaveBeenCalledWith(
      created.hostId,
      "203.0.113.10",
    );
    fixture.sqlite.close();
  });

  it("接受 UUID 项目凭据，但不向 Agent 返回或保存凭据秘密", async () => {
    fixture = createFixture();
    const credentialId = "d4479e2a-0434-48e8-98df-57bd477a958f";
    dependencies.listCredentials.mockResolvedValue([
      {
        id: credentialId,
        name: "生产密钥",
        username: "deploy",
        authType: "key",
        keyType: "ed25519",
      },
    ]);
    const created = await fixture.service.createServer(
      principal(),
      serverInput({
        username: "",
        authType: "credential",
        credentialId,
      }),
      "uuid-credential",
    );
    expect(created.credentialId).toBe(credentialId);
    expect(dependencies.assignCredential).toHaveBeenCalledWith(
      "project-1",
      Number(created.serverId),
      credentialId,
    );
    const serialized = JSON.stringify(
      fixture.sqlite
        .prepare(
          `SELECT request_hash, response_json
             FROM agent_provisioning_idempotency`,
        )
        .get(),
    );
    expect(serialized).not.toMatch(/private|password|secret|deploy/i);
    fixture.sqlite.close();
  });

  it("敏感正文只参与不可逆请求摘要，且幂等冲突不会重复创建", async () => {
    fixture = createFixture();
    const password = "Never-Log-This-Password!";
    const input = serverInput({
      authType: "password",
      password,
    });
    const first = await fixture.service.createServer(
      principal(),
      input,
      "stable-create",
    );
    const retried = await fixture.service.createServer(
      principal(),
      input,
      "stable-create",
    );
    expect(retried).toEqual(first);
    // 幂等数据库不能充当密码猜测校验器；同一操作键只认首次提交，
    // 即使重试方误传了另一个秘密，也不会暴露是否与原密码相同。
    expect(
      await fixture.service.createServer(
        principal(),
        { ...input, password: "Different-Secret" },
        "stable-create",
      ),
    ).toEqual(first);
    expect(
      fixture.sqlite.prepare("SELECT COUNT(*) AS count FROM ssh_data").get(),
    ).toEqual({ count: 1 });
    const idempotency = fixture.sqlite
      .prepare(
        `SELECT request_hash AS requestHash, response_json AS responseJson
           FROM agent_provisioning_idempotency`,
      )
      .get() as { requestHash: string; responseJson: string };
    expect(idempotency.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(idempotency.responseJson).not.toContain(password);
    await expect(
      fixture.service.createServer(
        principal(),
        { ...input, name: "different" },
        "stable-create",
      ),
    ).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    fixture.sqlite.close();
  });

  it("项目凭据镜像完成后进程中断，重试仍能恢复同一主机", async () => {
    fixture = createFixture();
    const input = serverInput({
      authType: "password",
      password: "recover-after-managed-credential",
    });
    const first = await fixture.service.createServer(
      principal(),
      input,
      "recover-managed-credential",
    );
    fixture.sqlite
      .prepare("UPDATE project_hosts SET credential_id = ? WHERE id = ?")
      .run("cloudssh-mirror:recovered", Number(first.serverId));
    fixture.sqlite
      .prepare(
        `DELETE FROM agent_provisioning_idempotency
          WHERE idempotency_key = ?`,
      )
      .run("recover-managed-credential");

    const restarted = new SqliteAgentProvisioningService(
      fixture.sqlite,
      fixture.hosts as unknown as HostRepository,
      fixture.onWrite,
      fixture.onHostCreated,
    );
    await expect(
      restarted.createServer(principal(), input, "recover-managed-credential"),
    ).resolves.toEqual(first);
    expect(
      fixture.sqlite.prepare("SELECT COUNT(*) AS count FROM ssh_data").get(),
    ).toEqual({ count: 1 });
    fixture.sqlite.close();
  });

  it("快速连接有会话或固定窗口时延迟清理，共享后只解绑临时入口", async () => {
    fixture = createFixture();
    const created = await fixture.service.createQuickConnection(
      principal(),
      serverInput({ hostKeyFingerprint: "ab".repeat(32) }),
      "quick-shared",
    );
    fixture.sqlite
      .prepare(
        "UPDATE agent_quick_connections SET expires_at = '2026-01-01T00:00:00.000Z'",
      )
      .run();
    fixture.sqlite
      .prepare(
        "INSERT INTO persistent_sessions (id, project_host_id, state) VALUES ('closed', ?, 'CLOSED')",
      )
      .run(Number(created.serverId));
    expect(
      await fixture.service.cleanupExpiredQuickConnections(
        new Date("2026-08-02T00:00:00.000Z"),
      ),
    ).toBe(0);
    fixture.sqlite.prepare("DELETE FROM persistent_sessions").run();
    fixture.sqlite
      .prepare(
        "INSERT INTO web_terminal_sessions (id, host_id) VALUES ('pinned', ?)",
      )
      .run(created.hostId);
    expect(
      await fixture.service.cleanupExpiredQuickConnections(
        new Date("2026-08-02T00:00:00.000Z"),
      ),
    ).toBe(0);
    fixture.sqlite.prepare("DELETE FROM web_terminal_sessions").run();
    fixture.sqlite
      .prepare(
        `INSERT INTO project_hosts (project_id, host_id, folder)
         VALUES ('project-2', ?, '共享')`,
      )
      .run(created.hostId);

    expect(
      await fixture.service.cleanupExpiredQuickConnections(
        new Date("2026-08-02T00:00:00.000Z"),
      ),
    ).toBe(1);
    expect(
      fixture.sqlite
        .prepare("SELECT COUNT(*) AS count FROM ssh_data WHERE id = ?")
        .get(created.hostId),
    ).toEqual({ count: 1 });
    expect(
      fixture.sqlite
        .prepare("SELECT project_id FROM project_hosts WHERE host_id = ?")
        .all(created.hostId),
    ).toEqual([{ project_id: "project-2" }]);
    expect(
      fixture.sqlite
        .prepare("SELECT COUNT(*) AS count FROM agent_quick_connections")
        .get(),
    ).toEqual({ count: 0 });
    fixture.sqlite.close();
  });

  it("定期清除过期幂等记录，不影响仍未清理的快速连接", async () => {
    fixture = createFixture();
    await fixture.service.createServer(
      principal(),
      serverInput(),
      "old-server-idempotency",
    );
    const quick = await fixture.service.createQuickConnection(
      principal(),
      serverInput({
        name: "quick",
        address: "203.0.113.11",
        hostKeyFingerprint: "cd".repeat(32),
      }),
      "active-quick-idempotency",
    );
    fixture.sqlite
      .prepare(
        "UPDATE agent_quick_connections SET expires_at = '2099-01-01T00:00:00.000Z'",
      )
      .run();
    fixture.sqlite
      .prepare(
        `UPDATE agent_provisioning_idempotency
            SET created_at = '2020-01-01 00:00:00'`,
      )
      .run();

    await fixture.service.cleanupExpiredQuickConnections(
      new Date("2026-08-02T00:00:00.000Z"),
    );
    const rows = fixture.sqlite
      .prepare(
        `SELECT operation, idempotency_key AS idempotencyKey
           FROM agent_provisioning_idempotency ORDER BY operation`,
      )
      .all();
    expect(rows).toEqual([
      {
        operation: "quick-connection",
        idempotencyKey: "active-quick-idempotency",
      },
    ]);
    expect(
      fixture.sqlite
        .prepare("SELECT host_id FROM agent_quick_connections")
        .get(),
    ).toEqual({ host_id: quick.hostId });
    fixture.sqlite.close();
  });
});
