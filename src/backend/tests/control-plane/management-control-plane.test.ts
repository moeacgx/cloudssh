import http from "http";
import express, { type RequestHandler } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedRequest } from "../../../types/index.js";
import { ManagementRepository } from "../../control-plane/management-repository.js";
import { ProjectRepository } from "../../control-plane/project-repository.js";
import { createControlPlaneRouter } from "../../control-plane/routes.js";
import { ensureControlPlaneSchema } from "../../control-plane/schema-migration.js";
import type { DatabaseContext } from "../../database/repositories/database-context.js";
import { TestSqliteDatabase } from "../database/repositories/test-support.js";
import { TerminalSessionLifecycleCoordinator } from "../../hosts/terminal/session-lifecycle-coordinator.js";

describe("云 SSH 控制面写接口", () => {
  let adapter: TestSqliteDatabase;
  let context: DatabaseContext;
  let management: ManagementRepository;
  let server: http.Server;
  let baseUrl: string;
  let notifyHostDeleted: ReturnType<typeof vi.fn>;
  let initializeProjectHostCredential: ReturnType<typeof vi.fn>;
  let audit: ReturnType<typeof vi.fn>;
  let findTerminalSessions: ReturnType<typeof vi.fn>;
  let terminalLifecycleCoordinator: TerminalSessionLifecycleCoordinator;

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
        credential_id INTEGER,
        sync_id TEXT
      );
      CREATE TABLE session_recordings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        host_id INTEGER NOT NULL REFERENCES ssh_data(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        ended_at TEXT,
        commands TEXT
      );
      CREATE TABLE sync_tombstones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        sync_id TEXT NOT NULL,
        deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
        ('member', 'member-name', 'hash', 0),
        ('viewer', 'viewer-name', 'hash', 0),
        ('outsider', 'outsider-name', 'hash', 0),
        ('admin', 'admin-name', 'hash', 1);
      INSERT INTO ssh_data
        (id, user_id, name, ip, port, username, auth_type, password, key)
      VALUES
        (7, 'owner', 'Owner host', '10.0.0.7', 22, 'root', 'password',
         'secret-password', 'secret-key'),
        (8, 'member', 'Member host', '10.0.0.8', 22, 'ubuntu', 'password',
         'member-secret', NULL);
    `);
    ensureControlPlaneSchema(context.sqlite!);
    management = new ManagementRepository(context);
    notifyHostDeleted = vi.fn().mockResolvedValue(undefined);
    initializeProjectHostCredential = vi.fn().mockResolvedValue(undefined);
    audit = vi.fn(async () => undefined);
    findTerminalSessions = vi.fn().mockReturnValue([]);
    terminalLifecycleCoordinator = new TerminalSessionLifecycleCoordinator();

    const app = express();
    app.use(express.json());
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
        createRepository: () => new ProjectRepository(context),
        createManagementRepository: () => management,
        isInstanceAdmin: async (userId) => userId === "admin",
        afterMutation: async () => {},
        notifyHostDeleted,
        initializeProjectHostCredential,
        audit,
        findTerminalSessions,
        terminalLifecycleCoordinator,
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

  async function request(path: string, userId: string, init: RequestInit = {}) {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-test-user": userId,
        ...init.headers,
      },
    });
  }

  async function createTeamAndProject() {
    const teamResponse = await request("/teams", "owner", {
      method: "POST",
      body: JSON.stringify({ name: "Platform", slug: "platform" }),
    });
    const teamId = (await teamResponse.json()).team.id as string;
    const projectResponse = await request(
      `/teams/${teamId}/projects`,
      "owner",
      {
        method: "POST",
        body: JSON.stringify({
          name: "Production",
          slug: "production",
          description: "Main project",
        }),
      },
    );
    const projectId = (await projectResponse.json()).project.id as string;
    return { teamId, projectId };
  }

  it("个人空间只补齐尚未归属任何项目的旧主机", async () => {
    const first = await request("/projects", "owner");
    expect(first.status).toBe(200);
    const firstProjects = (await first.json()).projects;
    expect(firstProjects).toHaveLength(1);
    expect(firstProjects[0]).toMatchObject({
      kind: "personal",
      serverCount: 1,
    });

    context
      .sqlite!.prepare(
        `INSERT INTO ssh_data
         (user_id, name, ip, port, username, auth_type)
       VALUES ('owner', 'Later host', '10.0.0.9', 22, 'root', 'none')`,
      )
      .run();

    context.sqlite!.exec(`
      INSERT INTO teams (id, owner_user_id, name, slug)
      VALUES ('team-existing', 'owner', 'Existing team', 'existing-team');
      INSERT INTO projects
        (id, team_id, owner_user_id, kind, name, slug)
      VALUES
        ('project-existing', 'team-existing', 'owner', 'team',
         'Existing project', 'existing-project');
      INSERT INTO ssh_data
        (id, user_id, name, ip, port, username, auth_type)
      VALUES
        (99, 'owner', 'Team only host', '10.0.0.99', 22, 'root', 'none');
      INSERT INTO project_hosts (project_id, host_id, added_by)
      VALUES ('project-existing', 99, 'owner');
    `);
    await request("/projects", "owner");
    await request("/bootstrap", "owner", { method: "POST" });

    const counts = context
      .sqlite!.prepare(
        `SELECT
         (SELECT COUNT(*) FROM projects
           WHERE owner_user_id = 'owner' AND kind = 'personal') AS projects,
         (SELECT COUNT(*) FROM project_hosts ph
           JOIN projects p ON p.id = ph.project_id
          WHERE p.owner_user_id = 'owner' AND p.kind = 'personal') AS hosts`,
      )
      .get() as { projects: number; hosts: number };
    expect(counts).toEqual({ projects: 1, hosts: 2 });

    const teamOnlyPlacement = context
      .sqlite!.prepare(
        `SELECT project_id AS projectId FROM project_hosts WHERE host_id = 99`,
      )
      .all() as Array<{ projectId: string }>;
    expect(teamOnlyPlacement).toEqual([{ projectId: "project-existing" }]);

    const serialized = JSON.stringify(
      await (
        await request(`/projects/${firstProjects[0].id}/servers`, "owner")
      ).json(),
    );
    expect(serialized).not.toContain("secret-password");
    expect(serialized).not.toContain("secret-key");
  });

  it("管理员只能从专用入口查看个人空间，删除时优先解除多项目关联", async () => {
    const ownerProjects = await (await request("/projects", "owner")).json();
    const personalProject = ownerProjects.projects.find(
      (project: { kind: string }) => project.kind === "personal",
    );
    const { projectId } = await createTeamAndProject();
    const associated = await request(
      `/projects/${projectId}/servers`,
      "owner",
      {
        method: "POST",
        body: JSON.stringify({ hostId: 7 }),
      },
    );
    expect(associated.status).toBe(201);

    const denied = await request(
      "/admin/users/owner/personal-project",
      "member",
    );
    expect(denied.status).toBe(403);

    const workspaceResponse = await request(
      "/admin/users/owner/personal-project",
      "admin",
    );
    expect(workspaceResponse.status).toBe(200);
    const workspace = await workspaceResponse.json();
    expect(workspace.project.id).toBe(personalProject.id);
    expect(workspace.hosts).toHaveLength(1);
    expect(workspace.folders).toEqual([]);

    context
      .sqlite!.prepare(
        `INSERT INTO project_folders (project_id, path, color, icon)
         VALUES (?, '仅管理员入口可见', '#22c55e', 'folder')`,
      )
      .run(personalProject.id);
    const workspaceWithFolder = await (
      await request("/admin/users/owner/personal-project", "admin")
    ).json();
    expect(workspaceWithFolder.folders).toEqual([
      expect.objectContaining({
        path: "仅管理员入口可见",
        color: "#22c55e",
        icon: "folder",
        hostCount: 0,
      }),
    ]);
    expect(
      (await request(`/projects/${personalProject.id}/folders`, "admin"))
        .status,
    ).toBe(404);

    const unlinked = await request(
      `/admin/users/owner/personal-project/hosts/${workspace.hosts[0].projectHostId}`,
      "admin",
      { method: "DELETE" },
    );
    expect(unlinked.status).toBe(200);
    expect((await unlinked.json()).mode).toBe("unlinked");
    expect(notifyHostDeleted).not.toHaveBeenCalled();
    expect(
      context.sqlite!.prepare("SELECT id FROM ssh_data WHERE id = 7").get(),
    ).toBeTruthy();
    expect(
      context
        .sqlite!.prepare(
          "SELECT project_id FROM project_hosts WHERE host_id = 7",
        )
        .all(),
    ).toEqual([{ project_id: projectId }]);

    await request("/projects", "member");
    const memberWorkspace = await (
      await request("/admin/users/member/personal-project", "admin")
    ).json();
    context
      .sqlite!.prepare("UPDATE ssh_data SET sync_id = ? WHERE id = 8")
      .run("sync-member-host");
    const removed = await request(
      `/admin/users/member/personal-project/hosts/${memberWorkspace.hosts[0].projectHostId}`,
      "admin",
      { method: "DELETE" },
    );
    expect((await removed.json()).mode).toBe("deleted");
    expect(notifyHostDeleted).toHaveBeenCalledWith(
      8,
      expect.anything(),
      "member",
    );
    expect(
      context.sqlite!.prepare("SELECT id FROM ssh_data WHERE id = 8").get(),
    ).toBeUndefined();
    expect(
      context
        .sqlite!.prepare(
          `SELECT user_id AS userId, entity_type AS entityType, sync_id AS syncId
           FROM sync_tombstones WHERE sync_id = ?`,
        )
        .get("sync-member-host"),
    ).toEqual({
      userId: "member",
      entityType: "hosts",
      syncId: "sync-member-host",
    });
  });

  it("管理员更新个人空间主机时保存项目级别名和文件夹", async () => {
    const workspace = await (
      await request("/admin/users/owner/personal-project", "admin")
    ).json();
    const response = await request(
      `/admin/users/owner/personal-project/hosts/${workspace.hosts[0].projectHostId}`,
      "admin",
      {
        method: "PUT",
        body: JSON.stringify({ alias: "生产入口", folder: "平台 / 生产" }),
      },
    );
    expect(response.status).toBe(200);
    expect(
      context
        .sqlite!.prepare("SELECT alias, folder FROM project_hosts WHERE id = ?")
        .get(workspace.hosts[0].projectHostId),
    ).toEqual({ alias: "生产入口", folder: "平台 / 生产" });
    expect(
      context
        .sqlite!.prepare(
          "SELECT path FROM project_folders WHERE project_id = ? AND path = ?",
        )
        .get(workspace.project.id, "平台 / 生产"),
    ).toEqual({ path: "平台 / 生产" });
  });

  it("个人空间删除保留其他用户主机并拒绝删除已有普通录像的主机", async () => {
    const ownerWorkspace = await (
      await request("/admin/users/owner/personal-project", "admin")
    ).json();
    const memberWorkspace = await (
      await request("/admin/users/member/personal-project", "admin")
    ).json();

    const crossLink = context
      .sqlite!.prepare(
        `INSERT INTO project_hosts (project_id, host_id, added_by)
         VALUES (?, 7, 'admin')`,
      )
      .run(memberWorkspace.project.id);
    const ownerUnlink = await request(
      `/admin/users/owner/personal-project/hosts/${ownerWorkspace.hosts[0].projectHostId}`,
      "admin",
      { method: "DELETE" },
    );
    expect((await ownerUnlink.json()).mode).toBe("unlinked");
    const foreignUnlink = await request(
      `/admin/users/member/personal-project/hosts/${Number(crossLink.lastInsertRowid)}`,
      "admin",
      { method: "DELETE" },
    );
    expect((await foreignUnlink.json()).mode).toBe("unlinked");
    expect(
      context.sqlite!.prepare("SELECT id FROM ssh_data WHERE id = 7").get(),
    ).toBeTruthy();

    context
      .sqlite!.prepare(
        `INSERT INTO session_recordings (host_id, user_id, commands)
       VALUES (8, 'member', '["whoami"]')`,
      )
      .run();
    const recordingConflict = await request(
      `/admin/users/member/personal-project/hosts/${memberWorkspace.hosts[0].projectHostId}`,
      "admin",
      { method: "DELETE" },
    );
    expect(recordingConflict.status).toBe(409);
    expect(
      context.sqlite!.prepare("SELECT id FROM ssh_data WHERE id = 8").get(),
    ).toBeTruthy();
    expect(
      context
        .sqlite!.prepare("SELECT id FROM session_recordings WHERE host_id = 8")
        .get(),
    ).toBeTruthy();
  });

  it("固定窗口存在时拒绝项目解绑和管理员删除个人空间主机", async () => {
    await request("/projects", "owner");
    const { projectId } = await createTeamAndProject();
    const associated = await request(
      `/projects/${projectId}/servers`,
      "owner",
      {
        method: "POST",
        body: JSON.stringify({ hostId: 7 }),
      },
    );
    const projectHostId = (await associated.json()).server
      .projectHostId as number;
    context
      .sqlite!.prepare(
        `INSERT INTO web_terminal_sessions
           (id, user_id, host_id, project_host_id, tab_instance_id, tmux_name)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "fixed-team-window",
        "owner",
        7,
        projectHostId,
        "team-tab",
        "cloudssh-web-fixed-team-window",
      );

    const projectRemoval = await request(
      `/projects/${projectId}/servers/${projectHostId}`,
      "owner",
      { method: "DELETE" },
    );
    expect(projectRemoval.status).toBe(409);
    expect(await projectRemoval.json()).toMatchObject({
      error: "Project host still has pinned terminal windows",
    });
    expect(
      context
        .sqlite!.prepare("SELECT id FROM project_hosts WHERE id = ?")
        .get(projectHostId),
    ).toBeTruthy();

    const personalWorkspace = await (
      await request("/admin/users/owner/personal-project", "admin")
    ).json();
    const personalProjectHostId = personalWorkspace.hosts[0]
      .projectHostId as number;

    const personalRemoval = await request(
      `/admin/users/owner/personal-project/hosts/${personalProjectHostId}`,
      "admin",
      { method: "DELETE" },
    );
    expect(personalRemoval.status).toBe(409);
    expect(await personalRemoval.json()).toMatchObject({
      error: "Personal workspace host still has pinned terminal windows",
    });
    expect(
      context
        .sqlite!.prepare("SELECT id FROM project_hosts WHERE id = ?")
        .get(personalProjectHostId),
    ).toBeTruthy();
  });

  it("内存活动会话存在时拒绝项目解绑和管理员删除个人空间主机", async () => {
    const { projectId } = await createTeamAndProject();
    const associated = await request(
      `/projects/${projectId}/servers`,
      "owner",
      {
        method: "POST",
        body: JSON.stringify({ hostId: 7 }),
      },
    );
    const projectHostId = (await associated.json()).server
      .projectHostId as number;
    findTerminalSessions.mockImplementation(
      (filter: { projectHostId?: number }) =>
        filter.projectHostId === projectHostId ? [{}] : [],
    );

    const projectRemoval = await request(
      `/projects/${projectId}/servers/${projectHostId}`,
      "owner",
      { method: "DELETE" },
    );
    expect(projectRemoval.status).toBe(409);
    expect(await projectRemoval.json()).toMatchObject({
      error: "Project host still has active terminal sessions",
    });

    findTerminalSessions.mockReset().mockReturnValue([]);
    expect(
      (
        await request(
          `/projects/${projectId}/servers/${projectHostId}`,
          "owner",
          { method: "DELETE" },
        )
      ).status,
    ).toBe(204);
    await request("/projects", "owner");
    const personalWorkspace = await (
      await request("/admin/users/owner/personal-project", "admin")
    ).json();
    const personalProjectHostId = personalWorkspace.hosts.find(
      (host: { hostId: number }) => host.hostId === 7,
    ).projectHostId as number;
    findTerminalSessions.mockImplementation((filter: { hostId?: number }) =>
      filter.hostId === 7 ? [{}] : [],
    );

    const personalRemoval = await request(
      `/admin/users/owner/personal-project/hosts/${personalProjectHostId}`,
      "admin",
      { method: "DELETE" },
    );
    expect(personalRemoval.status).toBe(409);
    expect(await personalRemoval.json()).toMatchObject({
      error: "Personal workspace host still has active terminal sessions",
    });
  });

  it("成员仍有内存固定窗口时拒绝撤销项目访问", async () => {
    const { projectId } = await createTeamAndProject();
    expect(
      (
        await request(`/projects/${projectId}/members/member`, "owner", {
          method: "PUT",
          body: JSON.stringify({ role: "operator" }),
        })
      ).status,
    ).toBe(200);
    const associated = await request(
      `/projects/${projectId}/servers`,
      "owner",
      {
        method: "POST",
        body: JSON.stringify({ hostId: 7 }),
      },
    );
    const projectHostId = (await associated.json()).server
      .projectHostId as number;
    findTerminalSessions.mockImplementation(
      (filter: {
        projectHostIds?: readonly number[];
        userId?: string;
        pinned?: boolean;
      }) =>
        filter.userId === "member" &&
        filter.pinned === true &&
        filter.projectHostIds?.includes(projectHostId)
          ? [{}]
          : [],
    );

    const removal = await request(
      `/projects/${projectId}/members/member`,
      "owner",
      { method: "DELETE" },
    );
    expect(removal.status).toBe(409);
    expect(await removal.json()).toMatchObject({
      error:
        "Project member still owns pinned terminal windows; terminate them before removing access",
    });
    expect(
      context
        .sqlite!.prepare(
          "SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?",
        )
        .get(projectId, "member"),
    ).toBeTruthy();
  });

  it("团队管理员可管理团队、成员和项目，未授权用户只得到 404", async () => {
    const { teamId, projectId } = await createTeamAndProject();

    const hidden = await request(
      `/teams/${teamId}/members/member`,
      "outsider",
      {
        method: "PUT",
        body: JSON.stringify({ role: "team_admin" }),
      },
    );
    expect(hidden.status).toBe(404);

    const addAdmin = await request(`/teams/${teamId}/members/member`, "owner", {
      method: "PUT",
      body: JSON.stringify({ role: "team_admin" }),
    });
    expect(addAdmin.status).toBe(200);

    // 项目级低角色不能覆盖团队管理员的高角色。
    context
      .sqlite!.prepare(
        `INSERT INTO project_members (project_id, user_id, role, added_by)
         VALUES (?, 'member', 'viewer', 'owner')`,
      )
      .run(projectId);

    const renamed = await request(`/teams/${teamId}`, "member", {
      method: "PATCH",
      body: JSON.stringify({ name: "Core Platform" }),
    });
    expect(renamed.status).toBe(200);

    const badRole = await request(`/teams/${teamId}/members/viewer`, "member", {
      method: "PUT",
      body: JSON.stringify({ role: "instance_admin" }),
    });
    expect(badRole.status).toBe(400);

    const project = await request(`/projects/${projectId}`, "member");
    expect(project.status).toBe(200);
    expect((await project.json()).project).toMatchObject({
      name: "Production",
      role: "project_admin",
    });

    const emptyTeam = await request("/teams", "owner", {
      method: "POST",
      body: JSON.stringify({ name: "Empty", slug: "empty" }),
    });
    const emptyTeamId = (await emptyTeam.json()).team.id;
    expect(
      (await request(`/teams/${emptyTeamId}`, "owner", { method: "DELETE" }))
        .status,
    ).toBe(204);

    expect(
      (await request(`/teams/${teamId}`, "owner", { method: "DELETE" })).status,
    ).toBe(409);
  });

  it("成员授权先持久审计，审计不可用时不修改权限", async () => {
    const { teamId, projectId } = await createTeamAndProject();
    audit.mockRejectedValueOnce(new Error("audit database is read-only"));

    const rejected = await request(`/teams/${teamId}/members/member`, "owner", {
      method: "PUT",
      body: JSON.stringify({ role: "operator" }),
    });
    expect(rejected.status).toBe(503);
    expect(
      context
        .sqlite!.prepare(
          "SELECT role FROM team_members WHERE team_id = ? AND user_id = ?",
        )
        .get(teamId, "member"),
    ).toBeUndefined();

    audit.mockClear();
    const teamMember = await request(
      `/teams/${teamId}/members/member`,
      "owner",
      {
        method: "PUT",
        body: JSON.stringify({ role: "operator" }),
      },
    );
    expect(teamMember.status).toBe(200);
    const projectMember = await request(
      `/projects/${projectId}/members/viewer`,
      "owner",
      {
        method: "PUT",
        body: JSON.stringify({ role: "viewer" }),
      },
    );
    expect(projectMember.status).toBe(200);
    expect(audit.mock.calls.map(([entry]) => entry.action)).toEqual([
      "team_member_set_intent",
      "team_member_set",
      "project_member_set_intent",
      "project_member_set",
    ]);
    expect(JSON.parse(audit.mock.calls[0][0].details)).toMatchObject({
      targetUserId: "member",
      previousRole: null,
      nextRole: "operator",
    });
  });

  it("项目管理员可管理项目成员和自己的主机关联，角色不足被拒绝", async () => {
    const { projectId } = await createTeamAndProject();
    expect(
      (
        await request(`/projects/${projectId}/members/member`, "owner", {
          method: "PUT",
          body: JSON.stringify({ role: "project_admin" }),
        })
      ).status,
    ).toBe(200);

    const foreignHost = await request(
      `/projects/${projectId}/servers`,
      "member",
      {
        method: "POST",
        body: JSON.stringify({ hostId: 7 }),
      },
    );
    expect(foreignHost.status).toBe(404);

    const linked = await request(`/projects/${projectId}/servers`, "member", {
      method: "POST",
      body: JSON.stringify({ hostId: 8, alias: "Worker" }),
    });
    expect(linked.status).toBe(201);
    const linkedBody = await linked.json();
    expect(linkedBody.server).toMatchObject({ hostId: 8, name: "Worker" });
    expect(JSON.stringify(linkedBody)).not.toContain("member-secret");
    expect(initializeProjectHostCredential).toHaveBeenCalledWith({
      projectId,
      projectHostId: linkedBody.server.projectHostId,
      hostId: 8,
      createdBy: "member",
    });

    expect(
      (
        await request(`/projects/${projectId}/members/viewer`, "member", {
          method: "PUT",
          body: JSON.stringify({ role: "viewer" }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(`/projects/${projectId}`, "viewer", {
          method: "PATCH",
          body: JSON.stringify({ name: "Forbidden" }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(`/projects/${projectId}`, "outsider", {
          method: "PATCH",
          body: JSON.stringify({ name: "Hidden" }),
        })
      ).status,
    ).toBe(404);

    expect(
      (
        await request(
          `/projects/${projectId}/servers/${linkedBody.server.projectHostId}`,
          "member",
          { method: "DELETE" },
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await request(`/projects/${projectId}/members/viewer`, "member", {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
  });

  it("项目凭据初始化失败时撤销主机关联且不泄露失败详情", async () => {
    const { projectId } = await createTeamAndProject();
    initializeProjectHostCredential.mockRejectedValueOnce(
      new Error("Host credentials are locked: secret-password"),
    );

    const response = await request(`/projects/${projectId}/servers`, "owner", {
      method: "POST",
      body: JSON.stringify({ hostId: 7 }),
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toEqual({
      error: "Host credentials could not be prepared for project access",
    });
    expect(JSON.stringify(body)).not.toContain("secret-password");

    const failedProjectHostId = initializeProjectHostCredential.mock.calls[0][0]
      .projectHostId as number;
    expect(() =>
      terminalLifecycleCoordinator.assertSessionCreationAllowed({
        projectHostIds: [failedProjectHostId],
      }),
    ).toThrow("Terminal host lifecycle is changing");

    const associationCount = context
      .sqlite!.prepare(
        "SELECT COUNT(*) AS count FROM project_hosts WHERE project_id = ? AND host_id = ?",
      )
      .get(projectId, 7) as { count: number };
    expect(associationCount.count).toBe(0);
  });

  it("同一主机在不同项目中使用独立文件夹且不会修改全局主机", async () => {
    context
      .sqlite!.prepare("UPDATE ssh_data SET folder = ? WHERE id = 7")
      .run("旧目录 / 生产");
    const first = await createTeamAndProject();
    const secondResponse = await request(
      `/teams/${first.teamId}/projects`,
      "owner",
      {
        method: "POST",
        body: JSON.stringify({ name: "Staging", slug: "staging" }),
      },
    );
    const secondProjectId = (await secondResponse.json()).project.id as string;

    const firstLinked = await request(
      `/projects/${first.projectId}/servers`,
      "owner",
      { method: "POST", body: JSON.stringify({ hostId: 7 }) },
    );
    const secondLinked = await request(
      `/projects/${secondProjectId}/servers`,
      "owner",
      { method: "POST", body: JSON.stringify({ hostId: 7 }) },
    );
    const firstProjectHostId = (await firstLinked.json()).server
      .projectHostId as number;
    const secondProjectHostId = (await secondLinked.json()).server
      .projectHostId as number;

    expect(
      management.getProjectHostMetadataUpdateTarget(
        first.projectId,
        "owner",
        false,
        firstProjectHostId,
        7,
      ),
    ).toMatchObject({
      projectId: first.projectId,
      projectHostId: firstProjectHostId,
      hostId: 7,
    });
    expect(() =>
      management.getProjectHostMetadataUpdateTarget(
        first.projectId,
        "outsider",
        false,
        firstProjectHostId,
        7,
      ),
    ).toThrow("Project not found");
    expect(() =>
      management.getProjectHostMetadataUpdateTarget(
        first.projectId,
        "owner",
        false,
        firstProjectHostId,
        8,
      ),
    ).toThrow("Project host not found");

    expect(
      (
        await request(`/projects/${first.projectId}/servers/folder`, "owner", {
          method: "PUT",
          body: JSON.stringify({
            projectHostIds: [firstProjectHostId],
            folder: "平台 / 生产",
          }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(`/projects/${secondProjectId}/servers/folder`, "owner", {
          method: "PUT",
          body: JSON.stringify({
            projectHostIds: [secondProjectHostId],
            folder: "测试",
          }),
        })
      ).status,
    ).toBe(200);

    const metadataUpdate = await request(
      `/projects/${first.projectId}/servers/${firstProjectHostId}`,
      "owner",
      {
        method: "PATCH",
        body: JSON.stringify({
          alias: "生产入口",
          folder: "平台 / Web",
        }),
      },
    );
    expect(metadataUpdate.status).toBe(200);
    expect((await metadataUpdate.json()).server).toMatchObject({
      projectHostId: firstProjectHostId,
      hostId: 7,
      name: "生产入口",
      sourceName: "Owner host",
      folder: "平台 / Web",
    });

    const firstServers = (
      await (
        await request(`/projects/${first.projectId}/servers`, "owner")
      ).json()
    ).servers;
    const secondServers = (
      await (
        await request(`/projects/${secondProjectId}/servers`, "owner")
      ).json()
    ).servers;
    expect(firstServers[0]).toMatchObject({
      name: "生产入口",
      sourceName: "Owner host",
      folder: "平台 / Web",
    });
    expect(secondServers[0].folder).toBe("测试");

    const renamed = await request(
      `/projects/${first.projectId}/folders/rename`,
      "owner",
      {
        method: "PUT",
        body: JSON.stringify({ oldPath: "平台", newPath: "核心平台" }),
      },
    );
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ updatedHosts: 1 });

    const folders = await request(
      `/projects/${first.projectId}/folders`,
      "owner",
    );
    expect((await folders.json()).folders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "核心平台 / 生产" }),
      ]),
    );

    const removed = await request(
      `/projects/${first.projectId}/folders`,
      "owner",
      {
        method: "DELETE",
        body: JSON.stringify({ path: "核心平台" }),
      },
    );
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ movedHostsToRoot: 1 });

    // 重复启动迁移必须保持用户主动移动到根目录后的状态。
    ensureControlPlaneSchema(context.sqlite!);

    const rows = context
      .sqlite!.prepare(
        `SELECT ph.project_id AS projectId, ph.folder,
                h.name AS globalName, h.folder AS globalFolder
           FROM project_hosts ph JOIN ssh_data h ON h.id = ph.host_id
          WHERE ph.id IN (?, ?) ORDER BY ph.project_id`,
      )
      .all(firstProjectHostId, secondProjectHostId) as Array<{
      projectId: string;
      folder: string | null;
      globalName: string | null;
      globalFolder: string | null;
    }>;
    expect(rows.find((row) => row.projectId === first.projectId)?.folder).toBe(
      null,
    );
    expect(rows.find((row) => row.projectId === secondProjectId)?.folder).toBe(
      "测试",
    );
    expect(rows.every((row) => row.globalFolder === "旧目录 / 生产")).toBe(
      true,
    );
    expect(rows.every((row) => row.globalName === "Owner host")).toBe(true);
  });

  it("从当前项目移除共享主机时保留主机及其他项目关联", async () => {
    const first = await createTeamAndProject();
    const secondResponse = await request(
      `/teams/${first.teamId}/projects`,
      "owner",
      {
        method: "POST",
        body: JSON.stringify({ name: "Staging", slug: "staging" }),
      },
    );
    const secondProjectId = (await secondResponse.json()).project.id as string;

    const firstLinked = await request(
      `/projects/${first.projectId}/servers`,
      "owner",
      { method: "POST", body: JSON.stringify({ hostId: 7 }) },
    );
    const secondLinked = await request(
      `/projects/${secondProjectId}/servers`,
      "owner",
      { method: "POST", body: JSON.stringify({ hostId: 7 }) },
    );
    const firstProjectHostId = (await firstLinked.json()).server
      .projectHostId as number;
    const secondProjectHostId = (await secondLinked.json()).server
      .projectHostId as number;

    const removed = await request(
      `/projects/${first.projectId}/servers/${firstProjectHostId}`,
      "owner",
      { method: "DELETE" },
    );
    expect(removed.status).toBe(204);

    const links = context
      .sqlite!.prepare(
        `SELECT id, project_id AS projectId
           FROM project_hosts
          WHERE host_id = 7
          ORDER BY id`,
      )
      .all() as Array<{ id: number; projectId: string }>;
    expect(links).toEqual([
      { id: secondProjectHostId, projectId: secondProjectId },
    ]);
    expect(
      context.sqlite!.prepare("SELECT id FROM ssh_data WHERE id = 7").get(),
    ).toEqual({ id: 7 });
    expect(notifyHostDeleted).not.toHaveBeenCalled();
  });

  it("实例管理员可跨团队管理，项目删除会拒绝仍有关联的资源", async () => {
    const { teamId, projectId } = await createTeamAndProject();
    const linked = await request(`/projects/${projectId}/servers`, "admin", {
      method: "POST",
      body: JSON.stringify({ hostId: 7 }),
    });
    expect(linked.status).toBe(201);
    const projectHostId = (await linked.json()).server.projectHostId;

    expect(
      (
        await request(`/projects/${projectId}`, "owner", {
          method: "DELETE",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(
          `/projects/${projectId}/servers/${projectHostId}`,
          "admin",
          {
            method: "DELETE",
          },
        )
      ).status,
    ).toBe(204);
    context
      .sqlite!.prepare(
        `INSERT INTO service_accounts
         (id, project_id, name, created_by, is_active)
       VALUES
         ('manual-account', ?, 'manual-account', 'admin', 1),
         ('device-account', ?, '__device__:device-1:project', 'admin', 0),
         ('token-account', ?, '__token__:legacy-token:project', 'admin', 0)`,
      )
      .run(projectId, projectId, projectId);
    expect(
      (
        await request(`/projects/${projectId}`, "admin", {
          method: "DELETE",
        })
      ).status,
    ).toBe(409);
    context
      .sqlite!.prepare(
        "DELETE FROM service_accounts WHERE id = 'manual-account'",
      )
      .run();
    expect(
      (
        await request(`/projects/${projectId}`, "admin", {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await request(`/teams/${teamId}`, "admin", {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
  });
});
