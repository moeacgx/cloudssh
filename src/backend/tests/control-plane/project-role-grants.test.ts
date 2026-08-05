import http from "http";
import express, { type RequestHandler } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthenticatedRequest } from "../../../types/index.js";
import { ManagementRepository } from "../../control-plane/management-repository.js";
import { ProjectRepository } from "../../control-plane/project-repository.js";
import { createControlPlaneRouter } from "../../control-plane/routes.js";
import { ensureControlPlaneSchema } from "../../control-plane/schema-migration.js";
import type { DatabaseContext } from "../../database/repositories/database-context.js";
import type { AuditLogParams } from "../../utils/audit-logger.js";
import { TestSqliteDatabase } from "../database/repositories/test-support.js";

describe("项目全局角色组授权", () => {
  let adapter: TestSqliteDatabase;
  let context: DatabaseContext;
  let management: ManagementRepository;
  let projects: ProjectRepository;
  let server: http.Server;
  let baseUrl: string;
  let auditEntries: AuditLogParams[];
  let mutationReasons: string[];

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
        auth_type TEXT NOT NULL DEFAULT 'none'
      );
      CREATE TABLE host_health_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        host_id INTEGER NOT NULL,
        check_id TEXT NOT NULL,
        ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ok INTEGER NOT NULL
      );
      CREATE TABLE web_terminal_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        host_id INTEGER NOT NULL REFERENCES ssh_data(id) ON DELETE CASCADE,
        project_host_id INTEGER,
        tab_instance_id TEXT NOT NULL,
        tmux_name TEXT NOT NULL,
        columns INTEGER NOT NULL DEFAULT 80,
        rows INTEGER NOT NULL DEFAULT 24,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_attached_at TEXT,
        last_detached_at TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      INSERT INTO users (id, username, password_hash, is_admin) VALUES
        ('owner', 'owner-name', 'hash', 0),
        ('operator', 'operator-name', 'hash', 0),
        ('viewer', 'viewer-name', 'hash', 0),
        ('outsider', 'outsider-name', 'hash', 0),
        ('admin', 'admin-name', 'hash', 1);
    `);
    ensureControlPlaneSchema(context.sqlite!);
    context.sqlite!.exec(`
      INSERT INTO roles (
        id, name, display_name, description, is_system, permissions
      ) VALUES
        (10, 'operations', 'Operations', 'Operations group', 0,
         '["secret:operate"]'),
        (11, 'auditors', 'Auditors', 'Audit group', 0,
         '["secret:audit"]'),
        (12, 'system-admin', 'System Admin', 'System role', 1,
         '["secret:admin"]');
      INSERT INTO user_roles (user_id, role_id, granted_by) VALUES
        ('operator', 10, 'owner'),
        ('viewer', 11, 'owner');
      INSERT INTO teams (id, name, slug, owner_user_id)
        VALUES ('team-1', 'Platform', 'platform', 'owner');
      INSERT INTO projects (
        id, team_id, owner_user_id, kind, name, slug
      ) VALUES (
        'project-1', 'team-1', 'owner', 'team', 'Production', 'production'
      );
      INSERT INTO projects (
        id, team_id, owner_user_id, kind, name, slug
      ) VALUES (
        'personal-1', NULL, 'owner', 'personal', 'Personal', 'personal'
      );
      INSERT INTO project_members (project_id, user_id, role, added_by)
        VALUES ('personal-1', 'operator', 'project_admin', 'owner');
      INSERT INTO project_role_grants
        (project_id, role_id, project_role, added_by)
        VALUES ('personal-1', 10, 'project_admin', 'owner');
    `);

    management = new ManagementRepository(context);
    projects = new ProjectRepository(context);
    auditEntries = [];
    mutationReasons = [];

    const usernames = new Map([
      ["owner", "owner-name"],
      ["operator", "operator-name"],
      ["viewer", "viewer-name"],
      ["outsider", "outsider-name"],
      ["admin", "admin-name"],
    ]);
    const authenticate: RequestHandler = (req, _res, next) => {
      const userId = String(req.header("x-test-user") || "outsider");
      const authReq = req as AuthenticatedRequest;
      authReq.userId = userId;
      authReq.user = {
        id: userId,
        username: usernames.get(userId) ?? userId,
        isAdmin: userId === "admin",
      };
      next();
    };
    const app = express();
    app.use(express.json());
    app.use(
      "/control-plane",
      createControlPlaneRouter({
        authenticate,
        createRepository: () => projects,
        createManagementRepository: () => management,
        isInstanceAdmin: async (userId) => userId === "admin",
        afterMutation: async (reason) => {
          mutationReasons.push(reason);
        },
        audit: async (entry) => {
          auditEntries.push(entry);
        },
      }),
    );
    server = http.createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("测试服务器未绑定端口");
    }
    baseUrl = `http://127.0.0.1:${address.port}/control-plane`;
  });

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await adapter.close();
  });

  function request(
    path: string,
    userId: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const url = new URL(`${baseUrl}${path}`);
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    headers.set("x-test-user", userId);

    return new Promise((resolve, reject) => {
      const outgoing = http.request(
        url,
        {
          method: init.method ?? "GET",
          headers: Object.fromEntries(headers.entries()),
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.on("error", reject);
          incoming.on("end", () => {
            const status = incoming.statusCode ?? 500;
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(incoming.headers)) {
              if (Array.isArray(value)) {
                for (const item of value) responseHeaders.append(name, item);
              } else if (value !== undefined) {
                responseHeaders.set(name, value);
              }
            }
            const hasBody = status !== 204 && status !== 205 && status !== 304;
            resolve(
              new Response(hasBody ? Buffer.concat(chunks) : null, {
                status,
                headers: responseHeaders,
              }),
            );
          });
        },
      );
      outgoing.on("error", reject);
      if (typeof init.body === "string" || Buffer.isBuffer(init.body)) {
        outgoing.write(init.body);
      } else if (init.body != null) {
        outgoing.destroy(new TypeError("测试请求体必须是字符串或 Buffer"));
        return;
      }
      outgoing.end();
    });
  }

  it("只返回安全角色字段，项目可见用户可读取且未授权用户得到 404", async () => {
    const ownerResponse = await request(
      "/projects/project-1/role-grants",
      "owner",
    );
    expect(ownerResponse.status).toBe(200);
    expect(ownerResponse.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    const ownerBody = await ownerResponse.json();
    expect(ownerBody.roles).toEqual(
      expect.arrayContaining([
        {
          roleId: 10,
          name: "operations",
          displayName: "Operations",
          description: "Operations group",
          isSystem: false,
          memberCount: 1,
          projectRole: null,
        },
        expect.objectContaining({
          roleId: 12,
          name: "system-admin",
          isSystem: true,
        }),
      ]),
    );
    const serialized = JSON.stringify(ownerBody);
    expect(serialized).not.toContain("permissions");
    expect(serialized).not.toContain("secret:operate");
    expect(serialized).not.toContain("secret:admin");
    expect(serialized).not.toContain("password_hash");
    expect(serialized).not.toContain("owner-name");
    expect(serialized).not.toContain("operator-name");

    expect(
      (await request("/projects/project-1/role-grants", "outsider")).status,
    ).toBe(404);

    await request("/projects/project-1/role-grants/10", "owner", {
      method: "PUT",
      body: JSON.stringify({ role: "operator" }),
    });
    const visibleMemberResponse = await request(
      "/projects/project-1/role-grants",
      "operator",
    );
    expect(visibleMemberResponse.status).toBe(200);
    expect(
      (
        await request("/projects/project-1/role-grants/11", "operator", {
          method: "PUT",
          body: JSON.stringify({ role: "viewer" }),
        })
      ).status,
    ).toBe(403);
  });

  it("动态合并角色成员并按 project_admin、operator、viewer 取最高级", async () => {
    expect(
      await projects.findVisibleProject("project-1", "operator"),
    ).toBeNull();

    expect(
      (
        await request("/projects/project-1/role-grants/10", "owner", {
          method: "PUT",
          body: JSON.stringify({ role: "operator" }),
        })
      ).status,
    ).toBe(201);
    expect(
      await projects.findVisibleProject("project-1", "operator"),
    ).toMatchObject({ role: "operator" });

    context
      .sqlite!.prepare(
        "INSERT INTO user_roles (user_id, role_id, granted_by) VALUES (?, ?, ?)",
      )
      .run("outsider", 10, "owner");
    expect(
      await projects.findVisibleProject("project-1", "outsider"),
    ).toMatchObject({ role: "operator" });
    context
      .sqlite!.prepare(
        "DELETE FROM user_roles WHERE user_id = ? AND role_id = ?",
      )
      .run("outsider", 10);
    expect(
      await projects.findVisibleProject("project-1", "outsider"),
    ).toBeNull();

    expect(
      (
        await request("/projects/project-1/role-grants/11", "owner", {
          method: "PUT",
          body: JSON.stringify({ role: "viewer" }),
        })
      ).status,
    ).toBe(201);
    context
      .sqlite!.prepare(
        `INSERT INTO project_members (project_id, user_id, role, added_by)
         VALUES ('project-1', 'viewer', 'operator', 'owner')`,
      )
      .run();
    expect(
      await projects.findVisibleProject("project-1", "viewer"),
    ).toMatchObject({ role: "operator" });

    expect(
      (
        await request("/projects/project-1/role-grants/10", "owner", {
          method: "PUT",
          body: JSON.stringify({ role: "project_admin" }),
        })
      ).status,
    ).toBe(200);
    expect(
      await projects.findVisibleProject("project-1", "operator"),
    ).toMatchObject({ role: "project_admin" });
    expect(
      (await projects.listVisibleProjects("operator")).map((project) => [
        project.id,
        project.role,
      ]),
    ).toEqual([["project-1", "project_admin"]]);

    const overview = await projects.getProjectOverview("project-1", "operator");
    expect(overview?.counts.memberCount).toBe(3);
  });

  it("新增、更新和删除授权均受约束并写入审计", async () => {
    const created = await request(
      "/projects/project-1/role-grants/10",
      "owner",
      {
        method: "PUT",
        body: JSON.stringify({ role: "operator" }),
        headers: { "user-agent": "role-grant-test" },
      },
    );
    expect(created.status).toBe(201);
    expect((await created.json()).roleGrant).toMatchObject({
      roleId: 10,
      name: "operations",
      projectRole: "operator",
    });

    const updated = await request(
      "/projects/project-1/role-grants/10",
      "owner",
      {
        method: "PUT",
        body: JSON.stringify({ role: "viewer" }),
      },
    );
    expect(updated.status).toBe(200);
    expect((await updated.json()).roleGrant.projectRole).toBe("viewer");

    expect(
      (
        await request("/projects/project-1/role-grants/10", "owner", {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    expect(
      await projects.findVisibleProject("project-1", "operator"),
    ).toBeNull();

    expect(mutationReasons).toEqual([
      "project_role_grant_create",
      "project_role_grant_update",
      "project_role_grant_delete",
    ]);
    expect(auditEntries.map((entry) => entry.action)).toEqual([
      "project_role_grant_set_intent",
      "project_role_grant_create",
      "project_role_grant_set_intent",
      "project_role_grant_update",
      "project_role_grant_delete_intent",
      "project_role_grant_delete",
    ]);
    expect(auditEntries[0]).toMatchObject({
      userId: "owner",
      username: "owner-name",
      resourceType: "project_role_grant",
      resourceId: "project-1:10",
      success: true,
      userAgent: "role-grant-test",
    });
    expect(JSON.stringify(auditEntries)).not.toContain("permissions");
    expect(JSON.stringify(auditEntries)).not.toContain("secret:operate");

    expect(
      (
        await request("/projects/project-1/role-grants/10", "owner", {
          method: "PUT",
          body: JSON.stringify({ role: "team_admin" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("/projects/project-1/role-grants/999", "owner", {
          method: "PUT",
          body: JSON.stringify({ role: "viewer" }),
        })
      ).status,
    ).toBe(404);
    context
      .sqlite!.prepare(
        `INSERT INTO project_role_grants
           (project_id, role_id, project_role, added_by)
         VALUES ('project-1', 10, 'operator', 'owner')`,
      )
      .run();
    expect(() =>
      context
        .sqlite!.prepare(
          `INSERT INTO project_role_grants
             (project_id, role_id, project_role, added_by)
           VALUES ('project-1', 10, 'viewer', 'owner')`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      context
        .sqlite!.prepare(
          `INSERT INTO project_role_grants
             (project_id, role_id, project_role, added_by)
           VALUES ('project-1', 10, 'team_admin', 'owner')`,
        )
        .run(),
    ).toThrow();
  });

  it("直接成员、团队成员和角色组多来源同时存在时始终取最高权限", async () => {
    context.sqlite!.exec(`
      INSERT INTO project_members (project_id, user_id, role, added_by)
        VALUES ('project-1', 'viewer', 'viewer', 'owner');
      INSERT INTO team_members (team_id, user_id, role, added_by)
        VALUES ('team-1', 'viewer', 'operator', 'owner');
    `);
    expect(
      await projects.findVisibleProject("project-1", "viewer"),
    ).toMatchObject({ role: "operator" });

    expect(
      (
        await request("/projects/project-1/role-grants/11", "owner", {
          method: "PUT",
          body: JSON.stringify({ role: "project_admin" }),
        })
      ).status,
    ).toBe(201);
    expect(
      await projects.findVisibleProject("project-1", "viewer"),
    ).toMatchObject({ role: "project_admin" });

    context
      .sqlite!.prepare(
        "DELETE FROM project_role_grants WHERE project_id = ? AND role_id = ?",
      )
      .run("project-1", 11);
    expect(
      await projects.findVisibleProject("project-1", "viewer"),
    ).toMatchObject({ role: "operator" });

    context
      .sqlite!.prepare(
        "DELETE FROM team_members WHERE team_id = ? AND user_id = ?",
      )
      .run("team-1", "viewer");
    expect(
      await projects.findVisibleProject("project-1", "viewer"),
    ).toMatchObject({ role: "viewer" });
  });

  it("操作者和未授权用户不能删除角色组授权", async () => {
    expect(
      (
        await request("/projects/project-1/role-grants/10", "owner", {
          method: "PUT",
          body: JSON.stringify({ role: "operator" }),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await request("/projects/project-1/role-grants/10", "operator", {
          method: "DELETE",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/projects/project-1/role-grants/10", "outsider", {
          method: "DELETE",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request("/projects/project-1/role-grants/10", "owner", {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
  });

  it("角色组成员仍有固定窗口时拒绝撤销项目授权", async () => {
    context.sqlite!.exec(`
      INSERT INTO ssh_data
        (id, user_id, name, ip, port, username, auth_type)
      VALUES
        (21, 'owner', 'Production host', '10.0.0.21', 22, 'root', 'none');
      INSERT INTO project_hosts (project_id, host_id, added_by)
      VALUES ('project-1', 21, 'owner');
      INSERT INTO project_role_grants
        (project_id, role_id, project_role, added_by)
      VALUES ('project-1', 10, 'operator', 'owner');
    `);
    const projectHost = context
      .sqlite!.prepare(
        "SELECT id FROM project_hosts WHERE project_id = ? AND host_id = ?",
      )
      .get("project-1", 21) as { id: number };
    context
      .sqlite!.prepare(
        `INSERT INTO web_terminal_sessions
           (id, user_id, host_id, project_host_id, tab_instance_id, tmux_name)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "fixed-role-window",
        "operator",
        21,
        projectHost.id,
        "role-tab",
        "cloudssh-web-fixed-role-window",
      );

    const downgradeConflict = await request(
      "/projects/project-1/role-grants/10",
      "owner",
      {
        method: "PUT",
        body: JSON.stringify({ role: "viewer" }),
      },
    );
    expect(downgradeConflict.status).toBe(409);
    expect(await downgradeConflict.json()).toMatchObject({
      error:
        "Role grant still has users with pinned terminal windows; terminate them before reducing access",
    });
    expect(
      context
        .sqlite!.prepare(
          "SELECT project_role AS projectRole FROM project_role_grants WHERE project_id = ? AND role_id = ?",
        )
        .get("project-1", 10),
    ).toEqual({ projectRole: "operator" });

    const conflict = await request(
      "/projects/project-1/role-grants/10",
      "owner",
      { method: "DELETE" },
    );

    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error:
        "Role grant still has users with pinned terminal windows; terminate them before removing the grant",
    });
    expect(
      context
        .sqlite!.prepare(
          "SELECT 1 FROM project_role_grants WHERE project_id = ? AND role_id = ?",
        )
        .get("project-1", 10),
    ).toBeTruthy();
  });

  it("项目或团队成员仍有固定窗口时拒绝移除成员", async () => {
    context.sqlite!.exec(`
      INSERT INTO ssh_data
        (id, user_id, name, ip, port, username, auth_type)
      VALUES
        (22, 'owner', 'Shared host', '10.0.0.22', 22, 'root', 'none');
      INSERT INTO project_hosts (project_id, host_id, added_by)
      VALUES ('project-1', 22, 'owner');
      INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES ('project-1', 'viewer', 'operator', 'owner');
    `);
    const projectHost = context
      .sqlite!.prepare(
        "SELECT id FROM project_hosts WHERE project_id = ? AND host_id = ?",
      )
      .get("project-1", 22) as { id: number };
    const insertFixedWindow = context.sqlite!.prepare(
      `INSERT INTO web_terminal_sessions
         (id, user_id, host_id, project_host_id, tab_instance_id, tmux_name)
       VALUES (?, 'viewer', 22, ?, ?, ?)`,
    );
    insertFixedWindow.run(
      "fixed-project-member-window",
      projectHost.id,
      "project-member-tab",
      "cloudssh-web-fixed-project-member-window",
    );

    const projectDowngradeConflict = await request(
      "/projects/project-1/members/viewer",
      "owner",
      {
        method: "PUT",
        body: JSON.stringify({ role: "viewer" }),
      },
    );
    expect(projectDowngradeConflict.status).toBe(409);
    expect(await projectDowngradeConflict.json()).toMatchObject({
      error:
        "Project member still owns pinned terminal windows; terminate them before reducing access",
    });
    expect(
      context
        .sqlite!.prepare(
          "SELECT role FROM project_members WHERE project_id = ? AND user_id = ?",
        )
        .get("project-1", "viewer"),
    ).toEqual({ role: "operator" });

    const projectConflict = await request(
      "/projects/project-1/members/viewer",
      "owner",
      { method: "DELETE" },
    );

    expect(projectConflict.status).toBe(409);
    expect(await projectConflict.json()).toMatchObject({
      error:
        "Project member still owns pinned terminal windows; terminate them before removing access",
    });
    expect(
      context
        .sqlite!.prepare(
          "SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?",
        )
        .get("project-1", "viewer"),
    ).toBeTruthy();

    context
      .sqlite!.prepare("DELETE FROM web_terminal_sessions WHERE id = ?")
      .run("fixed-project-member-window");
    expect(
      (
        await request("/projects/project-1/members/viewer", "owner", {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    context
      .sqlite!.prepare(
        `INSERT INTO team_members (team_id, user_id, role, added_by)
         VALUES ('team-1', 'viewer', 'operator', 'owner')`,
      )
      .run();
    insertFixedWindow.run(
      "fixed-team-member-window",
      projectHost.id,
      "team-member-tab",
      "cloudssh-web-fixed-team-member-window",
    );

    const teamDowngradeConflict = await request(
      "/teams/team-1/members/viewer",
      "owner",
      {
        method: "PUT",
        body: JSON.stringify({ role: "viewer" }),
      },
    );
    expect(teamDowngradeConflict.status).toBe(409);
    expect(await teamDowngradeConflict.json()).toMatchObject({
      error: "Team member still owns pinned terminal windows in this team",
    });
    expect(
      context
        .sqlite!.prepare(
          "SELECT role FROM team_members WHERE team_id = ? AND user_id = ?",
        )
        .get("team-1", "viewer"),
    ).toEqual({ role: "operator" });

    const teamConflict = await request(
      "/teams/team-1/members/viewer",
      "owner",
      { method: "DELETE" },
    );

    expect(teamConflict.status).toBe(409);
    expect(await teamConflict.json()).toMatchObject({
      error: "Team member still owns pinned terminal windows in this team",
    });
    expect(
      context
        .sqlite!.prepare(
          "SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?",
        )
        .get("team-1", "viewer"),
    ).toBeTruthy();
  });

  it("个人空间忽略遗留授权并拒绝成员及角色组管理接口", async () => {
    expect(
      (await request("/projects/personal-1/members", "owner")).status,
    ).toBe(409);
    expect(
      (
        await request("/projects/personal-1/members/viewer", "owner", {
          method: "PUT",
          body: JSON.stringify({ role: "viewer" }),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request("/projects/personal-1/members/operator", "owner", {
          method: "DELETE",
        })
      ).status,
    ).toBe(409);
    expect(
      (await request("/projects/personal-1/role-grants", "owner")).status,
    ).toBe(409);
    expect(
      (
        await request("/projects/personal-1/role-grants/11", "owner", {
          method: "PUT",
          body: JSON.stringify({ role: "viewer" }),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request("/projects/personal-1/role-grants/10", "owner", {
          method: "DELETE",
        })
      ).status,
    ).toBe(409);

    expect(
      context
        .sqlite!.prepare(
          "SELECT role FROM project_members WHERE project_id = ? AND user_id = ?",
        )
        .get("personal-1", "operator"),
    ).toEqual({ role: "project_admin" });
    expect(
      context
        .sqlite!.prepare(
          "SELECT project_role AS projectRole FROM project_role_grants WHERE project_id = ? AND role_id = ?",
        )
        .get("personal-1", 10),
    ).toEqual({ projectRole: "project_admin" });
    expect(mutationReasons).toEqual([]);
    expect(auditEntries).toEqual([]);
  });

  it("删除全局角色会级联移除项目授权和角色成员可见性", async () => {
    expect(
      (
        await request("/projects/project-1/role-grants/11", "owner", {
          method: "PUT",
          body: JSON.stringify({ role: "viewer" }),
        })
      ).status,
    ).toBe(201);
    expect(
      await projects.findVisibleProject("project-1", "viewer"),
    ).toMatchObject({ role: "viewer" });

    context.sqlite!.prepare("DELETE FROM roles WHERE id = ?").run(11);

    expect(
      context
        .sqlite!.prepare(
          "SELECT COUNT(*) AS count FROM project_role_grants WHERE role_id = ?",
        )
        .get(11),
    ).toEqual({ count: 0 });
    expect(
      context
        .sqlite!.prepare(
          "SELECT COUNT(*) AS count FROM user_roles WHERE role_id = ?",
        )
        .get(11),
    ).toEqual({ count: 0 });
    expect(await projects.findVisibleProject("project-1", "viewer")).toBeNull();
  });
});
