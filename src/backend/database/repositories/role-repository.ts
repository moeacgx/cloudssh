import { and, eq, inArray } from "drizzle-orm";
import { roles, userRoles, users } from "../db/schema.js";
import type { DatabaseContext } from "./database-context.js";

export type RoleRecord = typeof roles.$inferSelect;
export type NewRoleRecord = typeof roles.$inferInsert;
export type RoleUpdate = Pick<
  Partial<NewRoleRecord>,
  "displayName" | "description" | "updatedAt"
>;

export type UserRoleWithRole = {
  id: number;
  roleId: number;
  roleName: string;
  roleDisplayName: string;
  description: string | null;
  isSystem: boolean;
  grantedAt: string;
};

export type UserRolePermissionRecord = {
  permissions: string | null;
};

export type UserRoleNameSwitchResult = {
  added: boolean;
  removed: boolean;
};

export interface RoleTerminalLifecycleTarget {
  hostIds: number[];
  projectHostIds: number[];
  userIds: string[];
}

export interface RoleRevocationOptions {
  rejectPinnedTerminalSessions?: boolean;
}

export class RoleHasPinnedTerminalSessionsError extends Error {
  readonly code = "ROLE_HAS_PINNED_TERMINAL_SESSIONS";

  constructor(readonly count: number) {
    super(
      "This role still grants access to pinned terminal windows; terminate them before revoking the role",
    );
    this.name = "RoleHasPinnedTerminalSessionsError";
  }
}

export class RoleRepository {
  constructor(
    private readonly context: DatabaseContext,
    private readonly onWrite?: () => void | Promise<void>,
  ) {}

  async listRoles(): Promise<RoleRecord[]> {
    return this.context.drizzle
      .select()
      .from(roles)
      .orderBy(roles.isSystem, roles.name);
  }

  async findRoleById(id: number): Promise<RoleRecord | null> {
    const rows = await this.context.drizzle
      .select()
      .from(roles)
      .where(eq(roles.id, id))
      .limit(1);

    return rows[0] ?? null;
  }

  async findRoleByName(name: string): Promise<RoleRecord | null> {
    const rows = await this.context.drizzle
      .select()
      .from(roles)
      .where(eq(roles.name, name))
      .limit(1);

    return rows[0] ?? null;
  }

  async createRole(role: NewRoleRecord): Promise<number> {
    const result = await this.context.drizzle.insert(roles).values(role);
    await this.afterWrite();
    return Number(result.lastInsertRowid);
  }

  async updateRole(id: number, update: RoleUpdate): Promise<boolean> {
    const rows = await this.context.drizzle
      .update(roles)
      .set(update)
      .where(eq(roles.id, id))
      .returning({ id: roles.id });

    await this.afterWrite();
    return rows.length > 0;
  }

  async deleteRole(
    id: number,
    options: RoleRevocationOptions = {},
  ): Promise<{ deletedUserIds: string[] }> {
    const sqlite = this.requireSqlite();
    const deletedUserIds = sqlite.transaction(() => {
      if (options.rejectPinnedTerminalSessions) {
        this.assertRoleHasNoPinnedTerminalSessions(id);
      }
      const members = sqlite
        .prepare("SELECT user_id AS userId FROM user_roles WHERE role_id = ?")
        .all(id) as Array<{ userId: string }>;
      sqlite.prepare("DELETE FROM user_roles WHERE role_id = ?").run(id);
      sqlite.prepare("DELETE FROM host_access WHERE role_id = ?").run(id);
      sqlite.prepare("DELETE FROM roles WHERE id = ?").run(id);
      return members.map((member) => member.userId);
    })();
    await this.afterWrite();

    return { deletedUserIds };
  }

  async findUserRole(
    userId: string,
    roleId: number,
  ): Promise<typeof userRoles.$inferSelect | null> {
    const rows = await this.context.drizzle
      .select()
      .from(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.roleId, roleId)))
      .limit(1);

    return rows[0] ?? null;
  }

  async assignRoleToUser(input: {
    userId: string;
    roleId: number;
    grantedBy: string;
  }): Promise<void> {
    await this.context.drizzle.insert(userRoles).values(input);
    await this.afterWrite();
  }

  async assignRoleNameToUser(input: {
    userId: string;
    roleName: string;
    grantedBy: string;
  }): Promise<boolean> {
    const role = await this.findRoleByName(input.roleName);
    if (!role) {
      return false;
    }

    await this.context.drizzle.insert(userRoles).values({
      userId: input.userId,
      roleId: role.id,
      grantedBy: input.grantedBy,
    });
    await this.afterWrite();
    return true;
  }

  async switchUserRoleName(input: {
    userId: string;
    addRoleName: string;
    removeRoleName: string;
    grantedBy: string;
  }): Promise<UserRoleNameSwitchResult> {
    const [addRole, removeRole] = await Promise.all([
      this.findRoleByName(input.addRoleName),
      this.findRoleByName(input.removeRoleName),
    ]);

    let added = false;
    let removed = false;

    if (addRole) {
      await this.context.drizzle
        .delete(userRoles)
        .where(
          and(
            eq(userRoles.userId, input.userId),
            eq(userRoles.roleId, addRole.id),
          ),
        );
      await this.context.drizzle.insert(userRoles).values({
        userId: input.userId,
        roleId: addRole.id,
        grantedBy: input.grantedBy,
      });
      added = true;
    }

    if (removeRole) {
      const rows = await this.context.drizzle
        .delete(userRoles)
        .where(
          and(
            eq(userRoles.userId, input.userId),
            eq(userRoles.roleId, removeRole.id),
          ),
        )
        .returning({ id: userRoles.id });
      removed = rows.length > 0;
    }

    if (added || removed) {
      await this.afterWrite();
    }

    return { added, removed };
  }

  async setUserAdminStatus(input: {
    userId: string;
    isAdmin: boolean;
    grantedBy: string;
  }): Promise<boolean> {
    const updated = this.context.drizzle.transaction((tx) => {
      const systemRoles = tx
        .select({ id: roles.id, name: roles.name })
        .from(roles)
        .where(inArray(roles.name, ["admin", "user"]))
        .all();
      const desiredRole = systemRoles.find(
        (role) => role.name === (input.isAdmin ? "admin" : "user"),
      );
      if (!desiredRole) {
        throw new Error("Required system role is missing");
      }

      const changedUsers = tx
        .update(users)
        .set({ isAdmin: input.isAdmin })
        .where(eq(users.id, input.userId))
        .returning({ id: users.id })
        .all();
      if (changedUsers.length === 0) return false;

      const systemRoleIds = systemRoles.map((role) => role.id);
      if (systemRoleIds.length > 0) {
        tx.delete(userRoles)
          .where(
            and(
              eq(userRoles.userId, input.userId),
              inArray(userRoles.roleId, systemRoleIds),
            ),
          )
          .run();
      }
      tx.insert(userRoles)
        .values({
          userId: input.userId,
          roleId: desiredRole.id,
          grantedBy: input.grantedBy,
        })
        .run();
      return true;
    });

    if (updated) await this.afterWrite();
    return updated;
  }

  async removeRoleFromUser(
    userId: string,
    roleId: number,
    options: RoleRevocationOptions = {},
  ): Promise<void> {
    const sqlite = this.requireSqlite();
    sqlite.transaction(() => {
      if (options.rejectPinnedTerminalSessions) {
        this.assertRoleHasNoPinnedTerminalSessions(roleId, userId);
      }
      sqlite
        .prepare("DELETE FROM user_roles WHERE user_id = ? AND role_id = ?")
        .run(userId, roleId);
    })();
    await this.afterWrite();
  }

  getTerminalLifecycleTarget(
    roleId: number,
    userId?: string,
  ): RoleTerminalLifecycleTarget {
    const sqlite = this.requireSqlite();
    const userIds = userId
      ? [userId]
      : (
          sqlite
            .prepare(
              "SELECT user_id AS userId FROM user_roles WHERE role_id = ?",
            )
            .all(roleId) as Array<{ userId: string }>
        ).map((row) => row.userId);
    const projectHostIds = (
      sqlite
        .prepare(
          `SELECT DISTINCT host.id
             FROM project_hosts host
             JOIN project_role_grants grant
               ON grant.project_id = host.project_id
            WHERE grant.role_id = ?`,
        )
        .all(roleId) as Array<{ id: number }>
    ).map((row) => row.id);
    const hostIds = (
      sqlite
        .prepare(
          `SELECT DISTINCT host_id AS id
             FROM host_access
            WHERE role_id = ?`,
        )
        .all(roleId) as Array<{ id: number }>
    ).map((row) => row.id);
    return { hostIds, projectHostIds, userIds };
  }

  async removeAllRolesFromUser(userId: string): Promise<number> {
    const rows = await this.context.drizzle
      .delete(userRoles)
      .where(eq(userRoles.userId, userId))
      .returning({ id: userRoles.id });

    if (rows.length > 0) {
      await this.afterWrite();
    }

    return rows.length;
  }

  async listUserRoleIds(userId: string): Promise<number[]> {
    const rows = await this.context.drizzle
      .select({ roleId: userRoles.roleId })
      .from(userRoles)
      .where(eq(userRoles.userId, userId));

    return rows.map((row) => row.roleId);
  }

  async listRoleUserIds(roleId: number): Promise<string[]> {
    const rows = await this.context.drizzle
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .where(eq(userRoles.roleId, roleId));

    return rows.map((row) => row.userId);
  }

  async listUserRolePermissions(
    userId: string,
  ): Promise<UserRolePermissionRecord[]> {
    return this.context.drizzle
      .select({ permissions: roles.permissions })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .where(eq(userRoles.userId, userId));
  }

  async userHasAnyRoleName(
    userId: string,
    roleNames: string[],
  ): Promise<boolean> {
    if (roleNames.length === 0) {
      return false;
    }

    const rows = await this.context.drizzle
      .select({ roleName: roles.name })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .where(and(eq(userRoles.userId, userId), inArray(roles.name, roleNames)))
      .limit(1);

    return rows.length > 0;
  }

  async listUserRoles(userId: string): Promise<UserRoleWithRole[]> {
    return this.context.drizzle
      .select({
        id: userRoles.id,
        roleId: roles.id,
        roleName: roles.name,
        roleDisplayName: roles.displayName,
        description: roles.description,
        isSystem: roles.isSystem,
        grantedAt: userRoles.grantedAt,
      })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .where(eq(userRoles.userId, userId));
  }

  private async afterWrite(): Promise<void> {
    await this.onWrite?.();
  }

  /**
   * 与角色撤销在同一 SQLite 事务内复核，避免检查后固定窗口落库的竞态。
   */
  private assertRoleHasNoPinnedTerminalSessions(
    roleId: number,
    userId?: string,
  ): void {
    const sqlite = this.requireSqlite();
    const userFilter = userId ? "AND terminal.user_id = ?" : "";
    const parameters = userId
      ? [roleId, roleId, roleId, roleId, userId]
      : [roleId, roleId, roleId, roleId];
    const fixed = sqlite
      .prepare(
        `SELECT COUNT(DISTINCT terminal.id) AS count
           FROM web_terminal_sessions terminal
          WHERE (
                  EXISTS (
                    SELECT 1
                      FROM project_hosts host
                      JOIN project_role_grants grant
                        ON grant.project_id = host.project_id
                      JOIN user_roles membership
                        ON membership.role_id = grant.role_id
                       AND membership.user_id = terminal.user_id
                     WHERE host.id = terminal.project_host_id
                       AND grant.role_id = ?
                       AND membership.role_id = ?
                  )
                  OR (
                    EXISTS (
                      SELECT 1
                        FROM host_access access
                        JOIN user_roles membership
                          ON membership.role_id = access.role_id
                         AND membership.user_id = terminal.user_id
                       WHERE access.host_id = terminal.host_id
                         AND access.role_id = ?
                         AND membership.role_id = ?
                    )
                  )
                )
                ${userFilter}`,
      )
      .get(...parameters) as { count: number };
    if (fixed.count > 0) {
      throw new RoleHasPinnedTerminalSessionsError(fixed.count);
    }
  }

  private requireSqlite() {
    if (!this.context.sqlite) throw new Error("SQLite context is required");
    return this.context.sqlite;
  }
}
