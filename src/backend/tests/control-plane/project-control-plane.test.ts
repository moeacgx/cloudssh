import http from "http";
import express, { type RequestHandler } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureControlPlaneSchema } from "../../control-plane/schema-migration.js";
import { ProjectRepository } from "../../control-plane/project-repository.js";
import { createControlPlaneRouter } from "../../control-plane/routes.js";
import { TestSqliteDatabase } from "../database/repositories/test-support.js";
import type { DatabaseContext } from "../../database/repositories/database-context.js";
import type { AuthenticatedRequest } from "../../../types/index.js";

describe("云 SSH 项目控制面", () => {
  let adapter: TestSqliteDatabase;
  let context: DatabaseContext;
  let repository: ProjectRepository;

  beforeEach(async () => {
    adapter = new TestSqliteDatabase();
    context = await adapter.connect();
    context.sqlite!.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE ssh_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES users(id),
        connection_type TEXT NOT NULL DEFAULT 'ssh',
        name TEXT,
        ip TEXT NOT NULL,
        port INTEGER NOT NULL,
        username TEXT NOT NULL,
        folder TEXT,
        tags TEXT,
        enable_terminal INTEGER NOT NULL DEFAULT 1,
        enable_file_manager INTEGER NOT NULL DEFAULT 1,
        enable_session_logging INTEGER NOT NULL DEFAULT 1,
        auth_type TEXT NOT NULL DEFAULT 'password',
        password TEXT,
        key TEXT,
        credential_id INTEGER
      );
      CREATE TABLE host_health_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        host_id INTEGER NOT NULL,
        check_id TEXT NOT NULL,
        ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ok INTEGER NOT NULL,
        latency_ms INTEGER,
        detail TEXT
      );

      INSERT INTO users (id, username, password_hash, is_admin) VALUES
        ('owner', 'owner-name', 'hash', 0),
        ('member', 'member-name', 'hash', 0),
        ('team-viewer', 'team-viewer-name', 'hash', 0),
        ('outsider', 'outsider-name', 'hash', 0),
        ('admin', 'admin-name', 'hash', 1);

      INSERT INTO ssh_data (
        id, user_id, name, ip, port, username, password, key, credential_id
      ) VALUES (
        7, 'owner', 'Production', '10.0.0.7', 22, 'root',
        'never-return-password', 'never-return-private-key', 99
      );
      INSERT INTO host_health_history (user_id, host_id, check_id, ok)
        VALUES ('owner', 7, 'tcp', 1);
    `);

    ensureControlPlaneSchema(context.sqlite!);
    context.sqlite!.exec(`
      INSERT INTO teams (id, name, slug, owner_user_id)
        VALUES ('team-1', 'Platform', 'platform', 'owner');
      INSERT INTO team_members (team_id, user_id, role, added_by)
        VALUES ('team-1', 'team-viewer', 'viewer', 'owner');
      INSERT INTO projects (
        id, team_id, owner_user_id, kind, name, slug, description
      ) VALUES (
        'project-1', 'team-1', 'owner', 'team', 'Production',
        'production', 'Main project'
      );
      INSERT INTO projects (
        id, team_id, owner_user_id, kind, name, slug, description
      ) VALUES (
        'personal-1', NULL, 'owner', 'personal', 'Personal',
        'personal', NULL
      );
      INSERT INTO projects (
        id, team_id, owner_user_id, kind, name, slug, description
      ) VALUES (
        'project-2', NULL, 'admin', 'personal', 'Secondary',
        'secondary', NULL
      );
      INSERT INTO project_members (project_id, user_id, role, added_by)
        VALUES ('project-1', 'member', 'operator', 'owner');
      INSERT INTO project_members (project_id, user_id, role, added_by)
        VALUES ('personal-1', 'member', 'project_admin', 'owner');
      INSERT INTO roles (id, name, display_name, is_system)
        VALUES (50, 'legacy-personal-access', 'Legacy Personal Access', 0);
      INSERT INTO user_roles (user_id, role_id, granted_by)
        VALUES ('outsider', 50, 'owner');
      INSERT INTO project_role_grants
        (project_id, role_id, project_role, added_by)
        VALUES ('personal-1', 50, 'project_admin', 'owner');
      INSERT INTO project_hosts (id, project_id, host_id, alias, added_by)
        VALUES (11, 'project-1', 7, 'API server', 'owner');
      INSERT INTO project_hosts (id, project_id, host_id, alias, added_by)
        VALUES (12, 'project-2', 7, 'Other project server', 'admin');
      INSERT INTO service_accounts (
        id, project_id, name, description, created_by
      ) VALUES ('service-1', 'project-1', 'automation', 'CI', 'owner');
      INSERT INTO agent_devices (
        id, name, public_key, fingerprint, approved_by_user_id, owner_user_id
      ) VALUES (
        'device-1', 'Build workstation', 'public-key',
        '1234567890abcdef1234567890abcdef1234567890abcdef', 'owner', 'owner'
      );
      INSERT INTO agent_device_projects (
        device_id, project_id, service_account_id, granted_by
      ) VALUES ('device-1', 'project-1', 'service-1', 'owner');
      INSERT INTO agent_access_tokens (
        id, project_id, service_account_id, name, token_prefix, token_hash, token_salt,
        scopes, max_concurrent_sessions
      ) VALUES (
        'token-1', 'project-1', 'service-1', 'deploy', 'cssh_abcd',
        'stored-hash-only', 'stored-salt', '["session:write"]', 2
      );
      INSERT INTO agent_token_project_hosts (project_id, token_id, project_host_id)
        VALUES ('project-1', 'token-1', 11);
      INSERT INTO persistent_sessions (
        id, project_id, project_host_id, service_account_id, state,
        tmux_name, runtime_id, pinned
      ) VALUES (
        'session-1', 'project-1', 11, 'service-1', 'RUNNING',
        'cloudssh-project-1-session-1', 'runtime-1', 1
      );
      INSERT INTO agent_audit_events (
        id, project_id, service_account_id, token_id, device_id, session_id,
        project_host_id, request_id, action, success
      ) VALUES (
        'audit-1', 'project-1', 'service-1', 'token-1', 'device-1', 'session-1',
        11, 'request-1', 'session.write', 1
      );
    `);
    repository = new ProjectRepository(context);
  });

  afterEach(async () => {
    await adapter.close();
  });

  it("按所有者、项目成员、团队成员隔离项目且管理员看不到他人个人空间", async () => {
    expect(
      (await repository.listVisibleProjects("owner")).map((item) => item.id),
    ).toEqual(["personal-1", "project-1"]);
    expect(
      (await repository.listVisibleProjects("member")).map((item) => [
        item.id,
        item.role,
      ]),
    ).toEqual([["project-1", "operator"]]);
    expect(
      (await repository.listVisibleProjects("team-viewer")).map((item) => [
        item.id,
        item.role,
      ]),
    ).toEqual([["project-1", "viewer"]]);
    expect(await repository.listVisibleProjects("outsider")).toEqual([]);
    expect(
      await repository.findVisibleProject("personal-1", "member"),
    ).toBeNull();
    expect(
      await repository.findVisibleProject("personal-1", "outsider"),
    ).toBeNull();
    expect(
      (await repository.listVisibleProjects("admin", true)).map(
        (item) => item.id,
      ),
    ).toEqual(["project-2", "project-1"]);
    expect(
      await repository.findVisibleProject("personal-1", "admin", true),
    ).toBeNull();
    expect(
      await repository.findVisibleProject("project-1", "admin", true),
    ).toMatchObject({ id: "project-1", role: "instance_admin" });
  });

  it("项目服务器响应不包含 SSH 凭据字段", async () => {
    context
      .sqlite!.prepare(
        `UPDATE ssh_data
          SET network_info_status = 'ready',
              network_lookup_source = ip,
              network_resolved_ip = ip,
              network_country_code = 'US',
              network_country = 'United States',
              network_region = 'California',
              network_city = 'Los Angeles',
              network_isp = 'NTT America, Inc.',
              network_asn = 'AS2914',
              network_info_updated_at = '2026-08-02T00:00:00.000Z'
        WHERE id = 7`,
      )
      .run();
    const servers = await repository.listProjectServers("project-1", "member");
    expect(servers).toHaveLength(1);
    expect(servers?.[0]).toMatchObject({
      projectHostId: 11,
      hostId: 7,
      name: "API server",
      address: "10.0.0.7",
      port: 22,
      linkedProjectCount: 2,
      canDeleteFromAllProjects: false,
      health: { status: "healthy" },
      networkInfo: {
        status: "ready",
        countryCode: "US",
        country: "United States",
        region: "California",
        city: "Los Angeles",
        isp: "NTT America, Inc.",
        asn: "AS2914",
      },
    });
    const serialized = JSON.stringify(servers);
    expect(serialized).not.toContain("never-return-password");
    expect(serialized).not.toContain("never-return-private-key");
    expect(serialized).not.toContain("credentialId");
    expect(serialized).not.toContain('"username"');
    expect(serialized).not.toContain("ownerUserId");

    const ownerServers = await repository.listProjectServers(
      "project-1",
      "owner",
    );
    expect(ownerServers?.[0]).toMatchObject({
      linkedProjectCount: 2,
      canDeleteFromAllProjects: true,
    });
  });

  it("按项目主机关联和项目角色解析底层主机权限", async () => {
    await expect(repository.isHostOwnerControlled(7, "owner")).resolves.toBe(
      false,
    );

    context.sqlite!.exec(`
      INSERT INTO project_hosts (id, project_id, host_id, alias, added_by)
      VALUES (13, 'personal-1', 7, 'Personal server', 'owner');
    `);
    await expect(repository.isHostOwnerControlled(7, "owner")).resolves.toBe(
      true,
    );

    await expect(repository.findHostAccess(7, "member", 11)).resolves.toEqual({
      projectId: "project-1",
      projectHostId: 11,
      hostId: 7,
      role: "operator",
    });
    await expect(
      repository.findHostAccess(7, "team-viewer", 11),
    ).resolves.toMatchObject({
      projectId: "project-1",
      projectHostId: 11,
      role: "viewer",
    });
    await expect(
      repository.findHostAccess(7, "outsider", 11),
    ).resolves.toBeNull();
    await expect(
      repository.findHostAccess(7, "member", 12),
    ).resolves.toBeNull();

    await expect(
      repository.listAccessibleHostEntries("member"),
    ).resolves.toEqual([
      {
        projectId: "project-1",
        projectHostId: 11,
        hostId: 7,
        role: "operator",
      },
    ]);
  });

  it("返回可恢复会话和脱敏后的 Agent 活动概览", async () => {
    const overview = await repository.getProjectOverview(
      "project-1",
      "team-viewer",
    );
    expect(overview?.counts).toMatchObject({
      serverCount: 1,
      memberCount: 3,
      activeSessionCount: 1,
      resumableSessionCount: 1,
      agentEventCount24h: 1,
    });
    expect(overview?.sessions[0]).toMatchObject({
      id: "session-1",
      state: "RUNNING",
      serverName: "API server",
      actor: { type: "service_account", id: "service-1" },
    });
    expect(overview?.recentAgentActivity[0]).toMatchObject({
      action: "session.write",
      success: true,
      actorName: "Build workstation",
      actorFingerprint: "1234567890ab...567890abcdef",
    });
    expect(JSON.stringify(overview)).not.toContain("stored-hash-only");
    expect(JSON.stringify(overview)).not.toContain("stored-salt");
  });

  it("由 SQLite 约束阻止越权角色、重复关联和无归属会话", () => {
    expect(() =>
      context
        .sqlite!.prepare(
          "INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)",
        )
        .run("project-1", "outsider", "instance_admin"),
    ).toThrow();
    expect(() =>
      context
        .sqlite!.prepare(
          "INSERT INTO project_hosts (project_id, host_id) VALUES (?, ?)",
        )
        .run("project-1", 7),
    ).toThrow();
    expect(() =>
      context
        .sqlite!.prepare(
          `INSERT INTO persistent_sessions
           (id, project_id, project_host_id, state, tmux_name)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run("invalid-session", "project-1", 11, "RUNNING", "invalid"),
    ).toThrow();
    expect(() =>
      context
        .sqlite!.prepare(
          `INSERT INTO persistent_sessions
           (id, project_id, project_host_id, owner_user_id, state, tmux_name)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "cross-project-session",
          "project-1",
          12,
          "owner",
          "RUNNING",
          "cross-project",
        ),
    ).toThrow();
    expect(() =>
      context
        .sqlite!.prepare(
          `INSERT INTO agent_token_project_hosts
           (project_id, token_id, project_host_id) VALUES (?, ?, ?)`,
        )
        .run("project-1", "token-1", 12),
    ).toThrow();
  });

  it("REST API 仅向可见用户返回项目并隐藏不存在性", async () => {
    const app = express();
    const authenticate: RequestHandler = (req, _res, next) => {
      (req as AuthenticatedRequest).userId = String(
        req.header("x-test-user") || "outsider",
      );
      next();
    };
    app.use(
      "/control-plane",
      createControlPlaneRouter({
        authenticate,
        createRepository: () => repository,
        isInstanceAdmin: async (userId) => userId === "admin",
      }),
    );

    const server = http.createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("测试服务器未绑定端口");
    }

    try {
      const baseUrl = `http://127.0.0.1:${address.port}/control-plane`;
      const visibleResponse = await fetch(
        `${baseUrl}/projects/project-1/servers`,
        {
          headers: { "x-test-user": "member" },
        },
      );
      expect(visibleResponse.status).toBe(200);
      expect(visibleResponse.headers.get("cache-control")).toBe(
        "private, no-store",
      );
      expect(JSON.stringify(await visibleResponse.json())).not.toContain(
        "never-return-password",
      );

      const hiddenResponse = await fetch(`${baseUrl}/projects/project-1`, {
        headers: { "x-test-user": "outsider" },
      });
      expect(hiddenResponse.status).toBe(404);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
