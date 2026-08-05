import { afterEach, describe, expect, it } from "vitest";
import { TestSqliteDatabase } from "./test-support.js";
import {
  RoleHasPinnedTerminalSessionsError,
  RoleRepository,
} from "../../../database/repositories/role-repository.js";

describe("RoleRepository", () => {
  let adapter: TestSqliteDatabase | null = null;

  afterEach(async () => {
    if (adapter) {
      await adapter.close();
      adapter = null;
    }
  });

  async function createRepository(
    onWrite?: () => void | Promise<void>,
  ): Promise<RoleRepository> {
    adapter = new TestSqliteDatabase();
    const context = await adapter.connect();
    context.sqlite?.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0,
        is_oidc INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE roles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        description TEXT,
        is_system INTEGER NOT NULL DEFAULT 0,
        permissions TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE user_roles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        role_id INTEGER NOT NULL,
        granted_by TEXT,
        granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE host_access (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        host_id INTEGER NOT NULL,
        user_id TEXT,
        role_id INTEGER,
        granted_by TEXT NOT NULL,
        permission_level TEXT NOT NULL DEFAULT 'view',
        expires_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE projects (
        id TEXT PRIMARY KEY
      );

      CREATE TABLE project_hosts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        host_id INTEGER NOT NULL
      );

      CREATE TABLE project_role_grants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        role_id INTEGER NOT NULL,
        project_role TEXT NOT NULL
      );

      CREATE TABLE web_terminal_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        host_id INTEGER NOT NULL,
        project_host_id INTEGER,
        tab_instance_id TEXT NOT NULL,
        tmux_name TEXT NOT NULL
      );

      INSERT INTO users (id, username, password_hash, is_admin, is_oidc)
      VALUES ('admin', 'admin', 'hash', 1, 0), ('user-1', 'user', 'hash', 0, 0);
    `);

    return new RoleRepository(context, onWrite);
  }

  it("creates, lists, updates, and finds roles", async () => {
    const repo = await createRepository();

    const roleId = await repo.createRole({
      name: "ops",
      displayName: "Operations",
      description: "Ops access",
      isSystem: false,
      permissions: null,
    });

    expect((await repo.findRoleByName("ops"))?.id).toBe(roleId);
    expect((await repo.findRoleById(roleId))?.displayName).toBe("Operations");

    await repo.updateRole(roleId, {
      displayName: "Ops",
      description: null,
      updatedAt: "2026-06-26T00:00:00.000Z",
    });

    const roles = await repo.listRoles();
    expect(roles.map((role) => role.name)).toEqual(["ops"]);
    expect(roles[0].displayName).toBe("Ops");
    expect(roles[0].description).toBeNull();
  });

  it("assigns, lists, and removes user roles", async () => {
    const repo = await createRepository();
    const roleId = await repo.createRole({
      name: "ops",
      displayName: "Operations",
      isSystem: false,
      permissions: JSON.stringify(["hosts.read", "hosts.*"]),
    });

    await repo.assignRoleToUser({
      userId: "user-1",
      roleId,
      grantedBy: "admin",
    });

    expect(await repo.findUserRole("user-1", roleId)).not.toBeNull();
    expect(await repo.listUserRoleIds("user-1")).toEqual([roleId]);
    expect(await repo.listRoleUserIds(roleId)).toEqual(["user-1"]);
    expect((await repo.listUserRoles("user-1"))[0]).toMatchObject({
      roleId,
      roleName: "ops",
      roleDisplayName: "Operations",
      isSystem: false,
    });
    expect(await repo.listUserRolePermissions("user-1")).toEqual([
      { permissions: JSON.stringify(["hosts.read", "hosts.*"]) },
    ]);
    expect(await repo.userHasAnyRoleName("user-1", ["admin", "ops"])).toBe(
      true,
    );
    expect(await repo.userHasAnyRoleName("user-1", ["admin"])).toBe(false);
    expect(await repo.userHasAnyRoleName("user-1", [])).toBe(false);

    await repo.removeRoleFromUser("user-1", roleId);
    expect(await repo.findUserRole("user-1", roleId)).toBeNull();
  });

  it("assigns roles by name", async () => {
    const repo = await createRepository();
    const roleId = await repo.createRole({
      name: "user",
      displayName: "User",
      isSystem: true,
      permissions: null,
    });

    expect(
      await repo.assignRoleNameToUser({
        userId: "user-1",
        roleName: "missing",
        grantedBy: "admin",
      }),
    ).toBe(false);
    expect(await repo.listUserRoleIds("user-1")).toEqual([]);

    expect(
      await repo.assignRoleNameToUser({
        userId: "user-1",
        roleName: "user",
        grantedBy: "admin",
      }),
    ).toBe(true);
    expect(await repo.listUserRoleIds("user-1")).toEqual([roleId]);
  });

  it("switches user roles by role name", async () => {
    const repo = await createRepository();
    const userRoleId = await repo.createRole({
      name: "user",
      displayName: "User",
      isSystem: true,
      permissions: null,
    });
    const adminRoleId = await repo.createRole({
      name: "admin",
      displayName: "Admin",
      isSystem: true,
      permissions: null,
    });
    await repo.assignRoleToUser({
      userId: "user-1",
      roleId: userRoleId,
      grantedBy: "admin",
    });

    await expect(
      repo.switchUserRoleName({
        userId: "user-1",
        addRoleName: "admin",
        removeRoleName: "user",
        grantedBy: "admin",
      }),
    ).resolves.toEqual({ added: true, removed: true });
    expect(await repo.listUserRoleIds("user-1")).toEqual([adminRoleId]);

    await expect(
      repo.switchUserRoleName({
        userId: "user-1",
        addRoleName: "missing",
        removeRoleName: "admin",
        grantedBy: "admin",
      }),
    ).resolves.toEqual({ added: false, removed: true });
    expect(await repo.listUserRoleIds("user-1")).toEqual([]);
  });

  it("原子同步管理员标记和系统角色", async () => {
    const repo = await createRepository();
    const userRoleId = await repo.createRole({
      name: "user",
      displayName: "User",
      isSystem: true,
      permissions: null,
    });
    const adminRoleId = await repo.createRole({
      name: "admin",
      displayName: "Admin",
      isSystem: true,
      permissions: null,
    });
    await repo.assignRoleToUser({
      userId: "user-1",
      roleId: userRoleId,
      grantedBy: "admin",
    });

    await expect(
      repo.setUserAdminStatus({
        userId: "user-1",
        isAdmin: true,
        grantedBy: "admin",
      }),
    ).resolves.toBe(true);
    const context = await adapter!.connect();
    expect(
      context
        .sqlite!.prepare("SELECT is_admin FROM users WHERE id = ?")
        .get("user-1"),
    ).toEqual({ is_admin: 1 });
    expect(await repo.listUserRoleIds("user-1")).toEqual([adminRoleId]);

    await repo.setUserAdminStatus({
      userId: "user-1",
      isAdmin: false,
      grantedBy: "admin",
    });
    expect(
      context
        .sqlite!.prepare("SELECT is_admin FROM users WHERE id = ?")
        .get("user-1"),
    ).toEqual({ is_admin: 0 });
    expect(await repo.listUserRoleIds("user-1")).toEqual([userRoleId]);
  });

  it("缺失目标系统角色时不会部分更新管理员标记", async () => {
    const repo = await createRepository();
    const userRoleId = await repo.createRole({
      name: "user",
      displayName: "User",
      isSystem: true,
      permissions: null,
    });
    await repo.assignRoleToUser({
      userId: "user-1",
      roleId: userRoleId,
      grantedBy: "admin",
    });

    await expect(
      repo.setUserAdminStatus({
        userId: "user-1",
        isAdmin: true,
        grantedBy: "admin",
      }),
    ).rejects.toThrow("Required system role is missing");
    const context = await adapter!.connect();
    expect(
      context
        .sqlite!.prepare("SELECT is_admin FROM users WHERE id = ?")
        .get("user-1"),
    ).toEqual({ is_admin: 0 });
    expect(await repo.listUserRoleIds("user-1")).toEqual([userRoleId]);
  });

  it("deletes role assignments and returns affected users", async () => {
    const repo = await createRepository();
    const roleId = await repo.createRole({
      name: "ops",
      displayName: "Operations",
      isSystem: false,
      permissions: null,
    });
    await repo.assignRoleToUser({
      userId: "user-1",
      roleId,
      grantedBy: "admin",
    });

    const result = await repo.deleteRole(roleId);

    expect(result.deletedUserIds).toEqual(["user-1"]);
    expect(await repo.findRoleById(roleId)).toBeNull();
    expect(await repo.listUserRoleIds("user-1")).toEqual([]);
  });

  it("固定窗口存在时原子拒绝移除用户角色", async () => {
    const repo = await createRepository();
    const roleId = await repo.createRole({
      name: "ops",
      displayName: "Operations",
      isSystem: false,
      permissions: null,
    });
    await repo.assignRoleToUser({
      userId: "user-1",
      roleId,
      grantedBy: "admin",
    });
    const sqlite = (await adapter!.connect()).sqlite!;
    sqlite.prepare("INSERT INTO projects (id) VALUES ('project-1')").run();
    sqlite
      .prepare(
        "INSERT INTO project_hosts (id, project_id, host_id) VALUES (31, 'project-1', 71)",
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO project_role_grants
           (project_id, role_id, project_role) VALUES ('project-1', ?, 'operator')`,
      )
      .run(roleId);
    sqlite
      .prepare(
        `INSERT INTO web_terminal_sessions
           (id, user_id, host_id, project_host_id, tab_instance_id, tmux_name)
         VALUES ('fixed-1', 'user-1', 71, 31, 'tab-1', 'fixed-tmux-1')`,
      )
      .run();

    expect(repo.getTerminalLifecycleTarget(roleId, "user-1")).toEqual({
      hostIds: [],
      projectHostIds: [31],
      userIds: ["user-1"],
    });
    await expect(
      repo.removeRoleFromUser("user-1", roleId, {
        rejectPinnedTerminalSessions: true,
      }),
    ).rejects.toBeInstanceOf(RoleHasPinnedTerminalSessionsError);
    expect(await repo.findUserRole("user-1", roleId)).not.toBeNull();
  });

  it("固定窗口存在时原子拒绝删除全局角色及其项目授权", async () => {
    const repo = await createRepository();
    const roleId = await repo.createRole({
      name: "ops",
      displayName: "Operations",
      isSystem: false,
      permissions: null,
    });
    await repo.assignRoleToUser({
      userId: "user-1",
      roleId,
      grantedBy: "admin",
    });
    const sqlite = (await adapter!.connect()).sqlite!;
    sqlite.exec(`
      INSERT INTO projects (id) VALUES ('project-1');
      INSERT INTO project_hosts (id, project_id, host_id)
      VALUES (31, 'project-1', 71);
    `);
    sqlite
      .prepare(
        `INSERT INTO project_role_grants
           (project_id, role_id, project_role) VALUES ('project-1', ?, 'operator')`,
      )
      .run(roleId);
    sqlite.exec(`
      INSERT INTO web_terminal_sessions
        (id, user_id, host_id, project_host_id, tab_instance_id, tmux_name)
      VALUES ('fixed-1', 'user-1', 71, 31, 'tab-1', 'fixed-tmux-1');
    `);

    await expect(
      repo.deleteRole(roleId, { rejectPinnedTerminalSessions: true }),
    ).rejects.toBeInstanceOf(RoleHasPinnedTerminalSessionsError);
    expect(await repo.findRoleById(roleId)).not.toBeNull();
    expect(await repo.findUserRole("user-1", roleId)).not.toBeNull();
    expect(
      sqlite
        .prepare(
          "SELECT 1 FROM project_role_grants WHERE project_id = ? AND role_id = ?",
        )
        .get("project-1", roleId),
    ).toBeTruthy();
  });

  it("旧版角色主机共享下的固定窗口同样阻止撤销角色", async () => {
    const repo = await createRepository();
    const roleId = await repo.createRole({
      name: "legacy-ops",
      displayName: "Legacy operations",
      isSystem: false,
      permissions: null,
    });
    await repo.assignRoleToUser({
      userId: "user-1",
      roleId,
      grantedBy: "admin",
    });
    const sqlite = (await adapter!.connect()).sqlite!;
    sqlite
      .prepare(
        `INSERT INTO host_access
           (host_id, role_id, granted_by, permission_level)
         VALUES (71, ?, 'admin', 'connect')`,
      )
      .run(roleId);
    sqlite.exec(`
      INSERT INTO projects (id) VALUES ('legacy-project');
      INSERT INTO project_hosts (id, project_id, host_id)
      VALUES (32, 'legacy-project', 71);
      INSERT INTO web_terminal_sessions
        (id, user_id, host_id, project_host_id, tab_instance_id, tmux_name)
      VALUES ('legacy-fixed', 'user-1', 71, 32, 'legacy-tab', 'legacy-tmux');
    `);

    expect(repo.getTerminalLifecycleTarget(roleId, "user-1")).toEqual({
      hostIds: [71],
      projectHostIds: [],
      userIds: ["user-1"],
    });
    await expect(
      repo.removeRoleFromUser("user-1", roleId, {
        rejectPinnedTerminalSessions: true,
      }),
    ).rejects.toBeInstanceOf(RoleHasPinnedTerminalSessionsError);
  });

  it("removes all roles for a user only when assignments exist", async () => {
    let writeCount = 0;
    const repo = await createRepository(() => {
      writeCount += 1;
    });
    const opsRoleId = await repo.createRole({
      name: "ops",
      displayName: "Operations",
      isSystem: false,
      permissions: null,
    });
    const auditRoleId = await repo.createRole({
      name: "audit",
      displayName: "Audit",
      isSystem: false,
      permissions: null,
    });
    await repo.assignRoleToUser({
      userId: "user-1",
      roleId: opsRoleId,
      grantedBy: "admin",
    });
    await repo.assignRoleToUser({
      userId: "user-1",
      roleId: auditRoleId,
      grantedBy: "admin",
    });

    expect(await repo.removeAllRolesFromUser("missing-user")).toBe(0);
    expect(writeCount).toBe(4);

    expect(await repo.removeAllRolesFromUser("user-1")).toBe(2);
    expect(await repo.listUserRoleIds("user-1")).toEqual([]);
    expect(writeCount).toBe(5);
  });

  it("runs the write hook after writes", async () => {
    let writeCount = 0;
    const repo = await createRepository(() => {
      writeCount += 1;
    });

    const roleId = await repo.createRole({
      name: "ops",
      displayName: "Operations",
      isSystem: false,
      permissions: null,
    });
    await repo.assignRoleToUser({
      userId: "user-1",
      roleId,
      grantedBy: "admin",
    });
    await repo.updateRole(roleId, { displayName: "Ops" });
    await repo.removeRoleFromUser("user-1", roleId);
    await repo.deleteRole(roleId);

    expect(writeCount).toBe(5);
  });
});
