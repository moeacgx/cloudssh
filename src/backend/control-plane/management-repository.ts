import type { Database as BetterSqliteDatabase } from "better-sqlite3";
import type { DatabaseContext } from "../database/repositories/database-context.js";

export type TeamRole = "team_admin" | "project_admin" | "operator" | "viewer";
export type ManagedProjectRole = "project_admin" | "operator" | "viewer";

export interface ProjectRoleGrantSummary {
  roleId: number;
  name: string;
  displayName: string;
  description: string | null;
  isSystem: boolean;
  memberCount: number;
  projectRole: ManagedProjectRole | null;
}

export interface ProjectFolderValues {
  path: string;
  color?: string | null;
  icon?: string | null;
}

function parseTags(value: string | null | undefined): string[] {
  return value
    ? value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
    : [];
}

export class ControlPlaneManagementError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}

interface TeamAccessRow {
  id: string;
  name: string;
  slug: string;
  ownerUserId: string;
  memberRole: TeamRole | null;
  createdAt: string;
  updatedAt: string;
}

interface ProjectAccessRow {
  id: string;
  teamId: string | null;
  ownerUserId: string;
  kind: "personal" | "team";
  projectRole: ManagedProjectRole | null;
  teamRole: TeamRole | null;
  grantedRole: ManagedProjectRole | null;
}

function teamRoleFor(
  row: TeamAccessRow,
  userId: string,
  isInstanceAdmin: boolean,
): "instance_admin" | TeamRole | null {
  if (isInstanceAdmin) return "instance_admin";
  if (row.ownerUserId === userId) return "team_admin";
  return row.memberRole;
}

function projectRoleFor(
  row: ProjectAccessRow,
  userId: string,
  isInstanceAdmin: boolean,
): "instance_admin" | ManagedProjectRole | null {
  if (row.kind === "personal") {
    return row.ownerUserId === userId ? "project_admin" : null;
  }
  if (isInstanceAdmin) return "instance_admin";
  if (row.ownerUserId === userId) return "project_admin";
  if (
    row.projectRole === "project_admin" ||
    row.grantedRole === "project_admin" ||
    row.teamRole === "team_admin" ||
    row.teamRole === "project_admin"
  ) {
    return "project_admin";
  }
  if (
    row.projectRole === "operator" ||
    row.grantedRole === "operator" ||
    row.teamRole === "operator"
  ) {
    return "operator";
  }
  if (
    row.projectRole === "viewer" ||
    row.grantedRole === "viewer" ||
    row.teamRole === "viewer"
  )
    return "viewer";
  return null;
}

export class ManagementRepository {
  constructor(private readonly context: DatabaseContext) {}

  private get sqlite(): BetterSqliteDatabase {
    if (!this.context.sqlite) throw new Error("SQLite context is required");
    return this.context.sqlite;
  }

  bootstrapPersonalProject(userId: string) {
    return this.sqlite.transaction(() => {
      const user = this.sqlite
        .prepare("SELECT username FROM users WHERE id = ?")
        .get(userId) as { username: string } | undefined;
      if (!user) {
        throw new ControlPlaneManagementError(404, "User not found");
      }

      let project = this.sqlite
        .prepare(
          `SELECT id, name, slug, description, created_at AS createdAt,
                  updated_at AS updatedAt
             FROM projects
            WHERE owner_user_id = ? AND kind = 'personal'
            ORDER BY created_at ASC LIMIT 1`,
        )
        .get(userId) as
        | {
            id: string;
            name: string;
            slug: string;
            description: string | null;
            createdAt: string;
            updatedAt: string;
          }
        | undefined;

      let changed = false;
      let projectCreated = false;
      if (!project) {
        const id = crypto.randomUUID();
        const created = this.sqlite
          .prepare(
            `INSERT OR IGNORE INTO projects
               (id, team_id, owner_user_id, kind, name, slug, description)
             VALUES (?, NULL, ?, 'personal', ?, 'personal', NULL)`,
          )
          .run(id, userId, `${user.username} 的个人空间`);
        changed = created.changes > 0;
        projectCreated = changed;
        project = this.sqlite
          .prepare(
            `SELECT id, name, slug, description, created_at AS createdAt,
                    updated_at AS updatedAt
               FROM projects
              WHERE owner_user_id = ? AND kind = 'personal'
              ORDER BY created_at ASC LIMIT 1`,
          )
          .get(userId) as typeof project;
      }

      if (!project) throw new Error("Failed to bootstrap personal project");

      // 兼容未携带项目上下文的旧客户端，但不把已经属于团队项目的主机
      // 再次塞进个人空间。
      const associated = this.sqlite
        .prepare(
          `INSERT OR IGNORE INTO project_hosts
             (project_id, host_id, folder, added_by)
           SELECT ?, host.id, host.folder, ?
             FROM ssh_data host
            WHERE host.user_id = ?
              AND NOT EXISTS (
                SELECT 1 FROM project_hosts existing
                 WHERE existing.host_id = host.id
              )`,
        )
        .run(project.id, userId, userId);

      // 项目树拥有独立元数据。首次建个人项目时连同旧空文件夹一起复制；
      // 后续只补齐新关联主机实际使用到的文件夹，避免重新引入已删除文件夹。
      const hasLegacyFolders = Boolean(
        this.sqlite
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ssh_folders'",
          )
          .get(),
      );
      if (projectCreated && hasLegacyFolders) {
        this.sqlite
          .prepare(
            `INSERT OR IGNORE INTO project_folders
               (project_id, path, color, icon)
             SELECT ?, name, color, icon FROM ssh_folders WHERE user_id = ?`,
          )
          .run(project.id, userId);
      }
      if (hasLegacyFolders) {
        this.sqlite
          .prepare(
            `INSERT OR IGNORE INTO project_folders
               (project_id, path, color, icon)
             SELECT DISTINCT ph.project_id, ph.folder, sf.color, sf.icon
               FROM project_hosts ph
               JOIN ssh_data h ON h.id = ph.host_id
               LEFT JOIN ssh_folders sf
                 ON sf.user_id = h.user_id AND sf.name = ph.folder
              WHERE ph.project_id = ?
                AND ph.folder IS NOT NULL AND trim(ph.folder) <> ''`,
          )
          .run(project.id);
      } else {
        this.sqlite
          .prepare(
            `INSERT OR IGNORE INTO project_folders (project_id, path)
             SELECT DISTINCT project_id, folder FROM project_hosts
              WHERE project_id = ?
                AND folder IS NOT NULL AND trim(folder) <> ''`,
          )
          .run(project.id);
      }

      return {
        project: { ...project, kind: "personal" as const, teamId: null },
        changed: changed || associated.changes > 0,
      };
    })();
  }

  getAdminPersonalWorkspace(targetUserId: string, isInstanceAdmin: boolean) {
    if (!isInstanceAdmin) {
      throw new ControlPlaneManagementError(
        403,
        "Instance administrator required",
      );
    }
    const bootstrap = this.bootstrapPersonalProject(targetUserId);
    const hosts = this.sqlite
      .prepare(
        `SELECT ph.id AS projectHostId, ph.host_id AS hostId,
                ph.folder, ph.alias
           FROM project_hosts ph
          WHERE ph.project_id = ?
          ORDER BY ph.folder, ph.alias, ph.id`,
      )
      .all(bootstrap.project.id) as Array<{
      projectHostId: number;
      hostId: number;
      folder: string | null;
      alias: string | null;
    }>;
    const folders = this.sqlite
      .prepare(
        `SELECT pf.path, pf.color, pf.icon,
                pf.created_at AS createdAt, pf.updated_at AS updatedAt,
                (SELECT COUNT(*) FROM project_hosts ph
                  WHERE ph.project_id = pf.project_id
                    AND ph.folder = pf.path) AS hostCount
           FROM project_folders pf
          WHERE pf.project_id = ?
          ORDER BY pf.path, pf.id`,
      )
      .all(bootstrap.project.id) as Array<{
      path: string;
      color: string | null;
      icon: string | null;
      createdAt: string;
      updatedAt: string;
      hostCount: number;
    }>;
    return {
      changed: bootstrap.changed,
      project: bootstrap.project,
      hosts,
      folders,
    };
  }

  getAdminPersonalHostLifecycleTarget(
    targetUserId: string,
    isInstanceAdmin: boolean,
    projectHostId: number,
  ) {
    if (!isInstanceAdmin) {
      throw new ControlPlaneManagementError(
        403,
        "Instance administrator required",
      );
    }
    const target = this.sqlite
      .prepare(
        `SELECT ph.id AS projectHostId, ph.host_id AS hostId,
                ph.project_id AS projectId
           FROM project_hosts ph
           JOIN projects project ON project.id = ph.project_id
          WHERE ph.id = ? AND project.kind = 'personal'
            AND project.owner_user_id = ?`,
      )
      .get(projectHostId, targetUserId) as
      | { projectHostId: number; hostId: number; projectId: string }
      | undefined;
    if (!target) {
      throw new ControlPlaneManagementError(
        404,
        "Personal workspace host not found",
      );
    }
    return target;
  }

  removeAdminPersonalHost(
    targetUserId: string,
    isInstanceAdmin: boolean,
    projectHostId: number,
  ) {
    if (!isInstanceAdmin) {
      throw new ControlPlaneManagementError(
        403,
        "Instance administrator required",
      );
    }
    return this.sqlite.transaction(() => {
      const link = this.sqlite
        .prepare(
          `SELECT ph.id AS projectHostId, ph.host_id AS hostId,
                  ph.project_id AS projectId, host.user_id AS ownerUserId,
                  host.sync_id AS syncId
             FROM project_hosts ph
             JOIN projects project ON project.id = ph.project_id
             JOIN ssh_data host ON host.id = ph.host_id
            WHERE ph.id = ? AND project.kind = 'personal'
              AND project.owner_user_id = ?`,
        )
        .get(projectHostId, targetUserId) as
        | {
            projectHostId: number;
            hostId: number;
            projectId: string;
            ownerUserId: string;
            syncId: string | null;
          }
        | undefined;
      if (!link) {
        throw new ControlPlaneManagementError(
          404,
          "Personal workspace host not found",
        );
      }
      const fixedTerminals = this.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM web_terminal_sessions WHERE host_id = ?",
        )
        .get(link.hostId) as { count: number };
      if (fixedTerminals.count > 0) {
        throw new ControlPlaneManagementError(
          409,
          "Personal workspace host still has pinned terminal windows",
        );
      }
      const sessions = this.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM persistent_sessions WHERE project_host_id = ?",
        )
        .get(projectHostId) as { count: number };
      if (sessions.count > 0) {
        throw new ControlPlaneManagementError(
          409,
          "Personal workspace host still has session history",
        );
      }
      const associations = this.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM project_hosts WHERE host_id = ?",
        )
        .get(link.hostId) as { count: number };
      if (associations.count > 1 || link.ownerUserId !== targetUserId) {
        this.sqlite
          .prepare("DELETE FROM project_hosts WHERE id = ?")
          .run(projectHostId);
        return { ...link, mode: "unlinked" as const };
      }
      const recordings = this.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM session_recordings WHERE host_id = ?",
        )
        .get(link.hostId) as { count: number };
      if (recordings.count > 0) {
        throw new ControlPlaneManagementError(
          409,
          "Personal workspace host still has recording history",
        );
      }
      if (link.syncId) {
        this.sqlite
          .prepare(
            `INSERT INTO sync_tombstones (user_id, entity_type, sync_id)
             VALUES (?, 'hosts', ?)`,
          )
          .run(targetUserId, link.syncId);
      }
      this.sqlite.prepare("DELETE FROM ssh_data WHERE id = ?").run(link.hostId);
      return { ...link, mode: "deleted" as const };
    })();
  }

  updateAdminPersonalHostMetadata(
    targetUserId: string,
    isInstanceAdmin: boolean,
    projectHostId: number,
    values: { alias: string | null; folder: string | null },
  ) {
    if (!isInstanceAdmin) {
      throw new ControlPlaneManagementError(
        403,
        "Instance administrator required",
      );
    }
    return this.sqlite.transaction(() => {
      const link = this.sqlite
        .prepare(
          `SELECT ph.id, ph.project_id AS projectId, host.name AS sourceName
             FROM project_hosts ph
             JOIN projects project ON project.id = ph.project_id
             JOIN ssh_data host ON host.id = ph.host_id
            WHERE ph.id = ? AND project.kind = 'personal'
              AND project.owner_user_id = ?`,
        )
        .get(projectHostId, targetUserId) as
        | { id: number; projectId: string; sourceName: string | null }
        | undefined;
      if (!link) {
        throw new ControlPlaneManagementError(
          404,
          "Personal workspace host not found",
        );
      }
      const alias = values.alias?.trim() || null;
      const folder = values.folder?.trim() || null;
      if (folder) {
        this.sqlite
          .prepare(
            `INSERT OR IGNORE INTO project_folders (project_id, path)
             VALUES (?, ?)`,
          )
          .run(link.projectId, folder);
      }
      this.sqlite
        .prepare(
          `UPDATE project_hosts SET alias = ?, folder = ?
            WHERE id = ? AND project_id = ?`,
        )
        .run(alias, folder, link.id, link.projectId);
      return {
        projectHostId: link.id,
        projectId: link.projectId,
        alias,
        folder,
      };
    })();
  }

  listVisibleTeams(userId: string, isInstanceAdmin = false) {
    const rows = this.sqlite
      .prepare(
        `SELECT t.id, t.name, t.slug, t.owner_user_id AS ownerUserId,
                tm.role AS memberRole, t.created_at AS createdAt,
                t.updated_at AS updatedAt
           FROM teams t
           LEFT JOIN team_members tm
             ON tm.team_id = t.id AND tm.user_id = ?
          WHERE ? = 1 OR t.owner_user_id = ? OR tm.user_id = ?
          ORDER BY t.name, t.id`,
      )
      .all(userId, isInstanceAdmin ? 1 : 0, userId, userId) as TeamAccessRow[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      ownerUserId: row.ownerUserId,
      role: teamRoleFor(row, userId, isInstanceAdmin),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  private teamAccess(teamId: string, userId: string, isInstanceAdmin: boolean) {
    const row = this.sqlite
      .prepare(
        `SELECT t.id, t.name, t.slug, t.owner_user_id AS ownerUserId,
                tm.role AS memberRole, t.created_at AS createdAt,
                t.updated_at AS updatedAt
           FROM teams t
           LEFT JOIN team_members tm
             ON tm.team_id = t.id AND tm.user_id = ?
          WHERE t.id = ?`,
      )
      .get(userId, teamId) as TeamAccessRow | undefined;
    if (!row) throw new ControlPlaneManagementError(404, "Team not found");
    const role = teamRoleFor(row, userId, isInstanceAdmin);
    if (!role) throw new ControlPlaneManagementError(404, "Team not found");
    return { row, role };
  }

  private requireTeamAdmin(
    teamId: string,
    userId: string,
    isInstanceAdmin: boolean,
  ) {
    const access = this.teamAccess(teamId, userId, isInstanceAdmin);
    if (access.role !== "instance_admin" && access.role !== "team_admin") {
      throw new ControlPlaneManagementError(403, "Team administrator required");
    }
    return access.row;
  }

  createTeam(userId: string, name: string, slug: string) {
    const id = crypto.randomUUID();
    try {
      this.sqlite
        .prepare(
          "INSERT INTO teams (id, name, slug, owner_user_id) VALUES (?, ?, ?, ?)",
        )
        .run(id, name, slug, userId);
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        throw new ControlPlaneManagementError(409, "Team slug already exists");
      }
      throw error;
    }
    return this.listVisibleTeams(userId).find((team) => team.id === id)!;
  }

  updateTeam(
    teamId: string,
    userId: string,
    isInstanceAdmin: boolean,
    values: { name?: string; slug?: string },
  ) {
    this.requireTeamAdmin(teamId, userId, isInstanceAdmin);
    try {
      this.sqlite
        .prepare(
          `UPDATE teams
              SET name = COALESCE(?, name), slug = COALESCE(?, slug),
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
        )
        .run(values.name ?? null, values.slug ?? null, teamId);
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        throw new ControlPlaneManagementError(409, "Team slug already exists");
      }
      throw error;
    }
    const access = this.teamAccess(teamId, userId, isInstanceAdmin);
    return {
      id: access.row.id,
      name: access.row.name,
      slug: access.row.slug,
      ownerUserId: access.row.ownerUserId,
      role: access.role,
      createdAt: access.row.createdAt,
      updatedAt: access.row.updatedAt,
    };
  }

  deleteTeam(teamId: string, userId: string, isInstanceAdmin: boolean) {
    this.requireTeamAdmin(teamId, userId, isInstanceAdmin);
    const resources = this.sqlite
      .prepare("SELECT COUNT(*) AS count FROM projects WHERE team_id = ?")
      .get(teamId) as { count: number };
    if (resources.count > 0) {
      throw new ControlPlaneManagementError(
        409,
        "Team still contains projects",
      );
    }
    this.sqlite.prepare("DELETE FROM teams WHERE id = ?").run(teamId);
  }

  listTeamMembers(teamId: string, userId: string, isInstanceAdmin: boolean) {
    const { row } = this.teamAccess(teamId, userId, isInstanceAdmin);
    const members = this.sqlite
      .prepare(
        `SELECT tm.user_id AS userId, u.username, tm.role,
                tm.created_at AS createdAt
           FROM team_members tm
           JOIN users u ON u.id = tm.user_id
          WHERE tm.team_id = ? ORDER BY u.username, u.id`,
      )
      .all(teamId) as Array<{
      userId: string;
      username: string;
      role: TeamRole;
      createdAt: string;
    }>;
    return [
      {
        userId: row.ownerUserId,
        username: (
          this.sqlite
            .prepare("SELECT username FROM users WHERE id = ?")
            .get(row.ownerUserId) as { username: string }
        ).username,
        role: "team_admin" as const,
        owner: true,
      },
      ...members.map((member) => ({ ...member, owner: false })),
    ];
  }

  setTeamMember(
    teamId: string,
    actorUserId: string,
    isInstanceAdmin: boolean,
    memberUserId: string,
    role: TeamRole,
  ) {
    return this.sqlite.transaction(() => {
      const team = this.requireTeamAdmin(teamId, actorUserId, isInstanceAdmin);
      if (memberUserId === team.ownerUserId) {
        throw new ControlPlaneManagementError(409, "Team owner role is fixed");
      }
      const user = this.sqlite
        .prepare("SELECT id, username FROM users WHERE id = ?")
        .get(memberUserId) as { id: string; username: string } | undefined;
      if (!user) throw new ControlPlaneManagementError(404, "User not found");

      const previous = this.sqlite
        .prepare(
          "SELECT role FROM team_members WHERE team_id = ? AND user_id = ?",
        )
        .get(teamId, memberUserId) as { role: TeamRole } | undefined;
      if (role === "viewer" && previous && previous.role !== "viewer") {
        const fixedTerminals = this.sqlite
          .prepare(
            `SELECT COUNT(*) AS count
               FROM web_terminal_sessions terminal
               JOIN project_hosts host
                 ON host.id = terminal.project_host_id
               JOIN projects project ON project.id = host.project_id
              WHERE project.team_id = ? AND terminal.user_id = ?`,
          )
          .get(teamId, memberUserId) as { count: number };
        if (fixedTerminals.count > 0) {
          throw new ControlPlaneManagementError(
            409,
            "Team member still owns pinned terminal windows in this team",
          );
        }
      }

      this.sqlite
        .prepare(
          `INSERT INTO team_members (team_id, user_id, role, added_by)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(team_id, user_id) DO UPDATE SET role = excluded.role`,
        )
        .run(teamId, memberUserId, role, actorUserId);
      return { userId: user.id, username: user.username, role, owner: false };
    })();
  }

  removeTeamMember(
    teamId: string,
    actorUserId: string,
    isInstanceAdmin: boolean,
    memberUserId: string,
  ) {
    return this.sqlite.transaction(() => {
      const team = this.requireTeamAdmin(teamId, actorUserId, isInstanceAdmin);
      if (memberUserId === team.ownerUserId) {
        throw new ControlPlaneManagementError(
          409,
          "Team owner cannot be removed",
        );
      }
      const member = this.sqlite
        .prepare("SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?")
        .get(teamId, memberUserId);
      if (!member) {
        throw new ControlPlaneManagementError(404, "Team member not found");
      }
      const fixedTerminals = this.sqlite
        .prepare(
          `SELECT COUNT(*) AS count
             FROM web_terminal_sessions terminal
             JOIN project_hosts host
               ON host.id = terminal.project_host_id
             JOIN projects project ON project.id = host.project_id
            WHERE project.team_id = ? AND terminal.user_id = ?`,
        )
        .get(teamId, memberUserId) as { count: number };
      if (fixedTerminals.count > 0) {
        throw new ControlPlaneManagementError(
          409,
          "Team member still owns pinned terminal windows in this team",
        );
      }
      const result = this.sqlite
        .prepare("DELETE FROM team_members WHERE team_id = ? AND user_id = ?")
        .run(teamId, memberUserId);
      if (result.changes === 0) {
        throw new ControlPlaneManagementError(404, "Team member not found");
      }
    })();
  }

  listTeamProjectHostIdsForLifecycle(
    teamId: string,
    actorUserId: string,
    isInstanceAdmin: boolean,
  ): number[] {
    this.requireTeamAdmin(teamId, actorUserId, isInstanceAdmin);
    return (
      this.sqlite
        .prepare(
          `SELECT host.id
             FROM project_hosts host
             JOIN projects project ON project.id = host.project_id
            WHERE project.team_id = ?`,
        )
        .all(teamId) as Array<{ id: number }>
    ).map((row) => row.id);
  }

  private projectAccess(
    projectId: string,
    userId: string,
    isInstanceAdmin: boolean,
  ) {
    const row = this.sqlite
      .prepare(
        `SELECT p.id, p.team_id AS teamId, p.owner_user_id AS ownerUserId,
                p.kind, pm.role AS projectRole, tm.role AS teamRole,
                (
                  SELECT grant.project_role
                    FROM project_role_grants grant
                    JOIN user_roles membership
                      ON membership.role_id = grant.role_id
                   WHERE grant.project_id = p.id
                     AND membership.user_id = ?
                   ORDER BY CASE grant.project_role
                     WHEN 'project_admin' THEN 3
                     WHEN 'operator' THEN 2
                     ELSE 1
                   END DESC
                   LIMIT 1
                ) AS grantedRole
           FROM projects p
           LEFT JOIN project_members pm
             ON pm.project_id = p.id AND pm.user_id = ?
           LEFT JOIN team_members tm
             ON tm.team_id = p.team_id AND tm.user_id = ?
          WHERE p.id = ?`,
      )
      .get(userId, userId, userId, projectId) as ProjectAccessRow | undefined;
    if (!row) throw new ControlPlaneManagementError(404, "Project not found");
    const role = projectRoleFor(row, userId, isInstanceAdmin);
    if (!role) throw new ControlPlaneManagementError(404, "Project not found");
    return { row, role };
  }

  private requireProjectAdmin(
    projectId: string,
    userId: string,
    isInstanceAdmin: boolean,
  ) {
    const access = this.projectAccess(projectId, userId, isInstanceAdmin);
    if (access.role !== "instance_admin" && access.role !== "project_admin") {
      throw new ControlPlaneManagementError(
        403,
        "Project administrator required",
      );
    }
    return access.row;
  }

  private requireTeamProject(project: ProjectAccessRow): ProjectAccessRow {
    if (project.kind !== "team") {
      throw new ControlPlaneManagementError(
        409,
        "Personal projects do not support shared access",
      );
    }
    return project;
  }

  private projectRoleGrantOptions(
    projectId: string,
  ): ProjectRoleGrantSummary[] {
    const rows = this.sqlite
      .prepare(
        `SELECT role.id AS roleId, role.name,
                role.display_name AS displayName, role.description,
                role.is_system AS isSystem,
                (SELECT COUNT(*) FROM user_roles membership
                  WHERE membership.role_id = role.id) AS memberCount,
                grant.project_role AS projectRole
           FROM roles role
           LEFT JOIN project_role_grants grant
             ON grant.role_id = role.id AND grant.project_id = ?
          ORDER BY role.is_system DESC, role.name, role.id`,
      )
      .all(projectId) as Array<
      Omit<ProjectRoleGrantSummary, "isSystem" | "memberCount"> & {
        isSystem: number | boolean;
        memberCount: number;
      }
    >;
    return rows.map((row) => ({
      ...row,
      isSystem: Boolean(row.isSystem),
      memberCount: Number(row.memberCount),
    }));
  }

  createTeamProject(
    teamId: string,
    userId: string,
    isInstanceAdmin: boolean,
    values: { name: string; slug: string; description: string | null },
  ) {
    this.requireTeamAdmin(teamId, userId, isInstanceAdmin);
    const id = crypto.randomUUID();
    try {
      this.sqlite
        .prepare(
          `INSERT INTO projects
             (id, team_id, owner_user_id, kind, name, slug, description)
           VALUES (?, ?, ?, 'team', ?, ?, ?)`,
        )
        .run(id, teamId, userId, values.name, values.slug, values.description);
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        throw new ControlPlaneManagementError(
          409,
          "Project slug already exists in team",
        );
      }
      throw error;
    }
    return {
      id,
      teamId,
      ownerUserId: userId,
      kind: "team" as const,
      ...values,
    };
  }

  updateProject(
    projectId: string,
    userId: string,
    isInstanceAdmin: boolean,
    values: { name?: string; slug?: string; description?: string | null },
  ) {
    this.requireProjectAdmin(projectId, userId, isInstanceAdmin);
    try {
      this.sqlite
        .prepare(
          `UPDATE projects
              SET name = COALESCE(?, name), slug = COALESCE(?, slug),
                  description = CASE WHEN ? = 1 THEN ? ELSE description END,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
        )
        .run(
          values.name ?? null,
          values.slug ?? null,
          Object.hasOwn(values, "description") ? 1 : 0,
          values.description ?? null,
          projectId,
        );
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        throw new ControlPlaneManagementError(
          409,
          "Project slug already exists",
        );
      }
      throw error;
    }
  }

  deleteTeamProject(
    projectId: string,
    userId: string,
    isInstanceAdmin: boolean,
  ) {
    const project = this.requireProjectAdmin(
      projectId,
      userId,
      isInstanceAdmin,
    );
    if (project.kind !== "team" || !project.teamId) {
      throw new ControlPlaneManagementError(
        409,
        "Personal project cannot be deleted",
      );
    }
    this.requireTeamAdmin(project.teamId, userId, isInstanceAdmin);
    const row = this.sqlite
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM project_hosts WHERE project_id = ?) +
           (SELECT COUNT(*) FROM service_accounts
             WHERE project_id = ?
               AND name NOT GLOB '__device__:*'
               AND name NOT GLOB '__token__:*') +
           (SELECT COUNT(*) FROM project_credentials WHERE project_id = ?) AS count`,
      )
      .get(projectId, projectId, projectId) as { count: number };
    if (row.count > 0) {
      throw new ControlPlaneManagementError(
        409,
        "Project still contains managed resources",
      );
    }
    this.sqlite.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
  }

  listProjectMembers(
    projectId: string,
    userId: string,
    isInstanceAdmin: boolean,
  ) {
    const { row } = this.projectAccess(projectId, userId, isInstanceAdmin);
    this.requireTeamProject(row);
    const members = this.sqlite
      .prepare(
        `SELECT pm.user_id AS userId, u.username, pm.role,
                pm.created_at AS createdAt
           FROM project_members pm
           JOIN users u ON u.id = pm.user_id
          WHERE pm.project_id = ? ORDER BY u.username, u.id`,
      )
      .all(projectId) as Array<{
      userId: string;
      username: string;
      role: ManagedProjectRole;
      createdAt: string;
    }>;
    const owner = this.sqlite
      .prepare("SELECT username FROM users WHERE id = ?")
      .get(row.ownerUserId) as { username: string };
    return [
      {
        userId: row.ownerUserId,
        username: owner.username,
        role: "project_admin" as const,
        owner: true,
      },
      ...members.map((member) => ({ ...member, owner: false })),
    ];
  }

  setProjectMember(
    projectId: string,
    actorUserId: string,
    isInstanceAdmin: boolean,
    memberUserId: string,
    role: ManagedProjectRole,
  ) {
    return this.sqlite.transaction(() => {
      const project = this.requireTeamProject(
        this.requireProjectAdmin(projectId, actorUserId, isInstanceAdmin),
      );
      if (memberUserId === project.ownerUserId) {
        throw new ControlPlaneManagementError(
          409,
          "Project owner role is fixed",
        );
      }
      const user = this.sqlite
        .prepare("SELECT id, username FROM users WHERE id = ?")
        .get(memberUserId) as { id: string; username: string } | undefined;
      if (!user) throw new ControlPlaneManagementError(404, "User not found");

      const previous = this.sqlite
        .prepare(
          "SELECT role FROM project_members WHERE project_id = ? AND user_id = ?",
        )
        .get(projectId, memberUserId) as
        | { role: ManagedProjectRole }
        | undefined;
      if (role === "viewer" && previous && previous.role !== "viewer") {
        const fixedTerminals = this.sqlite
          .prepare(
            `SELECT COUNT(*) AS count
               FROM web_terminal_sessions terminal
               JOIN project_hosts host
                 ON host.id = terminal.project_host_id
              WHERE host.project_id = ? AND terminal.user_id = ?`,
          )
          .get(projectId, memberUserId) as { count: number };
        if (fixedTerminals.count > 0) {
          throw new ControlPlaneManagementError(
            409,
            "Project member still owns pinned terminal windows; terminate them before reducing access",
          );
        }
      }

      this.sqlite
        .prepare(
          `INSERT INTO project_members (project_id, user_id, role, added_by)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role`,
        )
        .run(projectId, memberUserId, role, actorUserId);
      return { userId: user.id, username: user.username, role, owner: false };
    })();
  }

  removeProjectMember(
    projectId: string,
    actorUserId: string,
    isInstanceAdmin: boolean,
    memberUserId: string,
  ) {
    return this.sqlite.transaction(() => {
      const project = this.requireTeamProject(
        this.requireProjectAdmin(projectId, actorUserId, isInstanceAdmin),
      );
      if (memberUserId === project.ownerUserId) {
        throw new ControlPlaneManagementError(
          409,
          "Project owner cannot be removed",
        );
      }
      const member = this.sqlite
        .prepare(
          "SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?",
        )
        .get(projectId, memberUserId);
      if (!member) {
        throw new ControlPlaneManagementError(404, "Project member not found");
      }
      const fixedTerminals = this.sqlite
        .prepare(
          `SELECT COUNT(*) AS count
             FROM web_terminal_sessions terminal
             JOIN project_hosts host
               ON host.id = terminal.project_host_id
            WHERE host.project_id = ? AND terminal.user_id = ?`,
        )
        .get(projectId, memberUserId) as { count: number };
      if (fixedTerminals.count > 0) {
        throw new ControlPlaneManagementError(
          409,
          "Project member still owns pinned terminal windows; terminate them before removing access",
        );
      }
      const result = this.sqlite
        .prepare(
          "DELETE FROM project_members WHERE project_id = ? AND user_id = ?",
        )
        .run(projectId, memberUserId);
      if (result.changes === 0) {
        throw new ControlPlaneManagementError(404, "Project member not found");
      }
    })();
  }

  listProjectHostIdsForLifecycle(
    projectId: string,
    actorUserId: string,
    isInstanceAdmin: boolean,
  ): number[] {
    this.requireTeamProject(
      this.requireProjectAdmin(projectId, actorUserId, isInstanceAdmin),
    );
    return (
      this.sqlite
        .prepare("SELECT id FROM project_hosts WHERE project_id = ?")
        .all(projectId) as Array<{ id: number }>
    ).map((row) => row.id);
  }

  listProjectRoleGrants(
    projectId: string,
    userId: string,
    isInstanceAdmin: boolean,
  ): ProjectRoleGrantSummary[] {
    const { row } = this.projectAccess(projectId, userId, isInstanceAdmin);
    this.requireTeamProject(row);
    return this.projectRoleGrantOptions(projectId);
  }

  setProjectRoleGrant(
    projectId: string,
    actorUserId: string,
    isInstanceAdmin: boolean,
    roleId: number,
    projectRole: ManagedProjectRole,
  ): { grant: ProjectRoleGrantSummary; created: boolean } {
    return this.sqlite.transaction(() => {
      this.requireTeamProject(
        this.requireProjectAdmin(projectId, actorUserId, isInstanceAdmin),
      );
      const role = this.sqlite
        .prepare("SELECT id FROM roles WHERE id = ?")
        .get(roleId);
      if (!role) throw new ControlPlaneManagementError(404, "Role not found");
      const existing = this.sqlite
        .prepare(
          `SELECT project_role AS projectRole
             FROM project_role_grants
            WHERE project_id = ? AND role_id = ?`,
        )
        .get(projectId, roleId) as
        | { projectRole: ManagedProjectRole }
        | undefined;

      if (
        projectRole === "viewer" &&
        existing &&
        existing.projectRole !== "viewer"
      ) {
        const fixedTerminals = this.sqlite
          .prepare(
            `SELECT COUNT(*) AS count
               FROM web_terminal_sessions terminal
               JOIN project_hosts host
                 ON host.id = terminal.project_host_id
               JOIN user_roles membership
                 ON membership.user_id = terminal.user_id
              WHERE host.project_id = ? AND membership.role_id = ?`,
          )
          .get(projectId, roleId) as { count: number };
        if (fixedTerminals.count > 0) {
          throw new ControlPlaneManagementError(
            409,
            "Role grant still has users with pinned terminal windows; terminate them before reducing access",
          );
        }
      }

      this.sqlite
        .prepare(
          `INSERT INTO project_role_grants
             (project_id, role_id, project_role, added_by)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(project_id, role_id) DO UPDATE SET
             project_role = excluded.project_role,
             updated_at = CURRENT_TIMESTAMP`,
        )
        .run(projectId, roleId, projectRole, actorUserId);
      const grant = this.projectRoleGrantOptions(projectId).find(
        (item) => item.roleId === roleId,
      );
      if (!grant) throw new Error("Failed to load project role grant");
      return { grant, created: !existing };
    })();
  }

  removeProjectRoleGrant(
    projectId: string,
    actorUserId: string,
    isInstanceAdmin: boolean,
    roleId: number,
  ): void {
    return this.sqlite.transaction(() => {
      this.requireTeamProject(
        this.requireProjectAdmin(projectId, actorUserId, isInstanceAdmin),
      );
      const grant = this.sqlite
        .prepare(
          "SELECT 1 FROM project_role_grants WHERE project_id = ? AND role_id = ?",
        )
        .get(projectId, roleId);
      if (!grant) {
        throw new ControlPlaneManagementError(
          404,
          "Project role grant not found",
        );
      }
      const fixedTerminals = this.sqlite
        .prepare(
          `SELECT COUNT(*) AS count
             FROM web_terminal_sessions terminal
             JOIN project_hosts host
               ON host.id = terminal.project_host_id
             JOIN user_roles membership
               ON membership.user_id = terminal.user_id
            WHERE host.project_id = ? AND membership.role_id = ?`,
        )
        .get(projectId, roleId) as { count: number };
      if (fixedTerminals.count > 0) {
        throw new ControlPlaneManagementError(
          409,
          "Role grant still has users with pinned terminal windows; terminate them before removing the grant",
        );
      }
      const result = this.sqlite
        .prepare(
          "DELETE FROM project_role_grants WHERE project_id = ? AND role_id = ?",
        )
        .run(projectId, roleId);
      if (result.changes === 0) {
        throw new ControlPlaneManagementError(
          404,
          "Project role grant not found",
        );
      }
    })();
  }

  listProjectRoleUserIdsForLifecycle(
    projectId: string,
    actorUserId: string,
    isInstanceAdmin: boolean,
    roleId: number,
  ): string[] {
    this.requireTeamProject(
      this.requireProjectAdmin(projectId, actorUserId, isInstanceAdmin),
    );
    const grant = this.sqlite
      .prepare(
        "SELECT 1 FROM project_role_grants WHERE project_id = ? AND role_id = ?",
      )
      .get(projectId, roleId);
    if (!grant) {
      throw new ControlPlaneManagementError(
        404,
        "Project role grant not found",
      );
    }
    return (
      this.sqlite
        .prepare("SELECT user_id AS userId FROM user_roles WHERE role_id = ?")
        .all(roleId) as Array<{ userId: string }>
    ).map((row) => row.userId);
  }

  associateHost(
    projectId: string,
    userId: string,
    isInstanceAdmin: boolean,
    hostId: number,
    alias: string | null,
  ) {
    this.requireProjectAdmin(projectId, userId, isInstanceAdmin);
    const host = this.sqlite
      .prepare(
        `SELECT id, name, ip, port, connection_type AS connectionType
           FROM ssh_data WHERE id = ? AND (? = 1 OR user_id = ?)`,
      )
      .get(hostId, isInstanceAdmin ? 1 : 0, userId) as
      | {
          id: number;
          name: string | null;
          ip: string;
          port: number;
          connectionType: string;
        }
      | undefined;
    if (!host) throw new ControlPlaneManagementError(404, "Host not found");
    try {
      const result = this.sqlite
        .prepare(
          `INSERT INTO project_hosts
             (project_id, host_id, alias, folder, added_by)
           VALUES (?, ?, ?, NULL, ?)`,
        )
        .run(projectId, hostId, alias, userId);
      return {
        projectHostId: Number(result.lastInsertRowid),
        hostId: host.id,
        name: alias || host.name || `Server ${host.id}`,
        address: host.ip,
        port: host.port,
        connectionType: host.connectionType,
        folder: null,
      };
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        throw new ControlPlaneManagementError(
          409,
          "Host is already associated with project",
        );
      }
      throw error;
    }
  }

  getProjectHostCreationTarget(
    projectId: string,
    userId: string,
    isInstanceAdmin: boolean,
  ) {
    const project = this.requireProjectAdmin(
      projectId,
      userId,
      isInstanceAdmin,
    );
    return {
      projectId: project.id,
      kind: project.kind,
      ownerUserId: project.ownerUserId,
    };
  }

  listProjectFolders(
    projectId: string,
    userId: string,
    isInstanceAdmin: boolean,
  ) {
    this.projectAccess(projectId, userId, isInstanceAdmin);
    return this.sqlite
      .prepare(
        `SELECT pf.path, pf.color, pf.icon,
                pf.created_at AS createdAt, pf.updated_at AS updatedAt,
                (SELECT COUNT(*) FROM project_hosts ph
                  WHERE ph.project_id = pf.project_id
                    AND ph.folder = pf.path) AS hostCount
           FROM project_folders pf
          WHERE pf.project_id = ?
          ORDER BY pf.path, pf.id`,
      )
      .all(projectId) as Array<{
      path: string;
      color: string | null;
      icon: string | null;
      createdAt: string;
      updatedAt: string;
      hostCount: number;
    }>;
  }

  saveProjectFolder(
    projectId: string,
    userId: string,
    isInstanceAdmin: boolean,
    values: ProjectFolderValues,
  ) {
    this.requireProjectAdmin(projectId, userId, isInstanceAdmin);
    this.sqlite
      .prepare(
        `INSERT INTO project_folders (project_id, path, color, icon)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id, path) DO UPDATE SET
           color = excluded.color,
           icon = excluded.icon,
           updated_at = CURRENT_TIMESTAMP`,
      )
      .run(projectId, values.path, values.color ?? null, values.icon ?? null);
    return this.sqlite
      .prepare(
        `SELECT path, color, icon, created_at AS createdAt,
                updated_at AS updatedAt
           FROM project_folders WHERE project_id = ? AND path = ?`,
      )
      .get(projectId, values.path);
  }

  renameProjectFolder(
    projectId: string,
    userId: string,
    isInstanceAdmin: boolean,
    oldPath: string,
    newPath: string,
  ) {
    this.requireProjectAdmin(projectId, userId, isInstanceAdmin);
    if (oldPath === newPath) return { updatedFolders: 0, updatedHosts: 0 };
    const oldPrefix = `${oldPath} / `;
    if (newPath.startsWith(oldPrefix)) {
      throw new ControlPlaneManagementError(
        409,
        "Folder cannot be moved inside itself",
      );
    }

    return this.sqlite.transaction(() => {
      const allFolders = this.sqlite
        .prepare(
          `SELECT id, path, color, icon, created_at AS createdAt
             FROM project_folders WHERE project_id = ?`,
        )
        .all(projectId) as Array<{
        id: number;
        path: string;
        color: string | null;
        icon: string | null;
        createdAt: string;
      }>;
      const affectedFolders = allFolders.filter(
        (folder) =>
          folder.path === oldPath || folder.path.startsWith(oldPrefix),
      );
      const projectHosts = this.sqlite
        .prepare(
          `SELECT id, folder FROM project_hosts
            WHERE project_id = ? AND folder IS NOT NULL`,
        )
        .all(projectId) as Array<{ id: number; folder: string }>;
      const affectedHosts = projectHosts.filter(
        (host) => host.folder === oldPath || host.folder.startsWith(oldPrefix),
      );
      if (affectedFolders.length === 0 && affectedHosts.length === 0) {
        throw new ControlPlaneManagementError(404, "Project folder not found");
      }

      const renamedPath = (path: string) =>
        path === oldPath
          ? newPath
          : `${newPath} / ${path.slice(oldPrefix.length)}`;
      const unaffectedPaths = new Set([
        ...allFolders
          .filter((folder) => !affectedFolders.includes(folder))
          .map((folder) => folder.path),
        ...projectHosts
          .filter((host) => !affectedHosts.includes(host))
          .map((host) => host.folder),
      ]);
      if (
        affectedFolders.some((folder) =>
          unaffectedPaths.has(renamedPath(folder.path)),
        )
      ) {
        throw new ControlPlaneManagementError(
          409,
          "Destination folder already exists",
        );
      }

      const deleteFolder = this.sqlite.prepare(
        "DELETE FROM project_folders WHERE id = ?",
      );
      const insertFolder = this.sqlite.prepare(
        `INSERT INTO project_folders
           (project_id, path, color, icon, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      );
      for (const folder of affectedFolders) deleteFolder.run(folder.id);
      for (const folder of affectedFolders) {
        insertFolder.run(
          projectId,
          renamedPath(folder.path),
          folder.color,
          folder.icon,
          folder.createdAt,
        );
      }

      const updateHost = this.sqlite.prepare(
        "UPDATE project_hosts SET folder = ? WHERE id = ? AND project_id = ?",
      );
      for (const host of affectedHosts) {
        updateHost.run(renamedPath(host.folder), host.id, projectId);
      }
      return {
        updatedFolders: affectedFolders.length,
        updatedHosts: affectedHosts.length,
      };
    })();
  }

  deleteProjectFolder(
    projectId: string,
    userId: string,
    isInstanceAdmin: boolean,
    path: string,
  ) {
    this.requireProjectAdmin(projectId, userId, isInstanceAdmin);
    const prefix = `${path} / `;
    return this.sqlite.transaction(() => {
      const folders = (
        this.sqlite
          .prepare("SELECT id, path FROM project_folders WHERE project_id = ?")
          .all(projectId) as Array<{ id: number; path: string }>
      ).filter(
        (folder) => folder.path === path || folder.path.startsWith(prefix),
      );
      const hosts = (
        this.sqlite
          .prepare(
            `SELECT id, folder FROM project_hosts
              WHERE project_id = ? AND folder IS NOT NULL`,
          )
          .all(projectId) as Array<{ id: number; folder: string }>
      ).filter(
        (host) => host.folder === path || host.folder.startsWith(prefix),
      );
      if (folders.length === 0 && hosts.length === 0) {
        throw new ControlPlaneManagementError(404, "Project folder not found");
      }
      const clearHost = this.sqlite.prepare(
        "UPDATE project_hosts SET folder = NULL WHERE id = ? AND project_id = ?",
      );
      for (const host of hosts) clearHost.run(host.id, projectId);
      const deleteFolder = this.sqlite.prepare(
        "DELETE FROM project_folders WHERE id = ? AND project_id = ?",
      );
      for (const folder of folders) deleteFolder.run(folder.id, projectId);
      return { deletedFolders: folders.length, movedHostsToRoot: hosts.length };
    })();
  }

  moveProjectHosts(
    projectId: string,
    userId: string,
    isInstanceAdmin: boolean,
    projectHostIds: number[],
    folder: string | null,
  ) {
    this.requireProjectAdmin(projectId, userId, isInstanceAdmin);
    const uniqueIds = [...new Set(projectHostIds)];
    const placeholders = uniqueIds.map(() => "?").join(", ");
    return this.sqlite.transaction(() => {
      const rows = this.sqlite
        .prepare(
          `SELECT id FROM project_hosts
            WHERE project_id = ? AND id IN (${placeholders})`,
        )
        .all(projectId, ...uniqueIds) as Array<{ id: number }>;
      if (rows.length !== uniqueIds.length) {
        throw new ControlPlaneManagementError(404, "Project host not found");
      }
      if (folder) {
        this.sqlite
          .prepare(
            `INSERT OR IGNORE INTO project_folders (project_id, path)
             VALUES (?, ?)`,
          )
          .run(projectId, folder);
      }
      const updateHost = this.sqlite.prepare(
        "UPDATE project_hosts SET folder = ? WHERE id = ? AND project_id = ?",
      );
      for (const id of uniqueIds) updateHost.run(folder, id, projectId);
      return { updated: uniqueIds.length, folder };
    })();
  }

  getProjectHostMetadataUpdateTarget(
    projectId: string,
    userId: string,
    isInstanceAdmin: boolean,
    projectHostId: number,
    hostId: number,
  ) {
    this.requireProjectAdmin(projectId, userId, isInstanceAdmin);
    const target = this.sqlite
      .prepare(
        `SELECT id AS projectHostId, project_id AS projectId,
                host_id AS hostId
           FROM project_hosts
          WHERE id = ? AND project_id = ? AND host_id = ?`,
      )
      .get(projectHostId, projectId, hostId) as
      | { projectHostId: number; projectId: string; hostId: number }
      | undefined;
    if (!target) {
      throw new ControlPlaneManagementError(404, "Project host not found");
    }
    return target;
  }

  updateProjectHostMetadata(
    projectId: string,
    userId: string,
    isInstanceAdmin: boolean,
    projectHostId: number,
    values: {
      alias: string | null;
      folder: string | null;
      tags?: string | null;
    },
  ) {
    this.requireProjectAdmin(projectId, userId, isInstanceAdmin);
    return this.sqlite.transaction(() => {
      const linked = this.sqlite
        .prepare(
          `SELECT ph.id, ph.tags, h.id AS hostId, h.name AS sourceName,
                  h.ip AS address, h.port, h.connection_type AS connectionType
             FROM project_hosts ph
             JOIN ssh_data h ON h.id = ph.host_id
            WHERE ph.id = ? AND ph.project_id = ?`,
        )
        .get(projectHostId, projectId) as
        | {
            id: number;
            hostId: number;
            sourceName: string | null;
            address: string;
            port: number;
            tags: string | null;
            connectionType: string;
          }
        | undefined;
      if (!linked) {
        throw new ControlPlaneManagementError(404, "Project host not found");
      }

      const alias = values.alias?.trim() || null;
      const folder = values.folder?.trim() || null;
      if (folder) {
        this.sqlite
          .prepare(
            `INSERT OR IGNORE INTO project_folders (project_id, path)
             VALUES (?, ?)`,
          )
          .run(projectId, folder);
      }
      const metadataUpdate: Record<string, string | null> = {
        alias,
        folder,
      };
      if (values.tags !== undefined) metadataUpdate.tags = values.tags;
      this.sqlite
        .prepare(
          `UPDATE project_hosts SET
             alias = @alias,
             folder = @folder,
             tags = COALESCE(@tags, tags)
            WHERE id = @projectHostId AND project_id = @projectId`,
        )
        .run({
          ...metadataUpdate,
          tags: values.tags ?? null,
          projectHostId,
          projectId,
        });
      return {
        projectHostId,
        hostId: linked.hostId,
        name: alias || linked.sourceName || `Server ${linked.hostId}`,
        sourceName: alias ? linked.sourceName : null,
        address: linked.address,
        port: linked.port,
        connectionType: linked.connectionType,
        tags: parseTags(values.tags !== undefined ? values.tags : linked.tags),
        folder,
      };
    })();
  }

  getProjectHostLifecycleTarget(
    projectId: string,
    userId: string,
    isInstanceAdmin: boolean,
    projectHostId: number,
  ) {
    this.requireProjectAdmin(projectId, userId, isInstanceAdmin);
    const target = this.sqlite
      .prepare(
        `SELECT id AS projectHostId, host_id AS hostId,
                project_id AS projectId
           FROM project_hosts
          WHERE id = ? AND project_id = ?`,
      )
      .get(projectHostId, projectId) as
      | { projectHostId: number; hostId: number; projectId: string }
      | undefined;
    if (!target) {
      throw new ControlPlaneManagementError(404, "Project host not found");
    }
    return target;
  }

  removeHost(
    projectId: string,
    userId: string,
    isInstanceAdmin: boolean,
    projectHostId: number,
  ) {
    return this.sqlite.transaction(() => {
      this.requireProjectAdmin(projectId, userId, isInstanceAdmin);
      const linked = this.sqlite
        .prepare("SELECT id FROM project_hosts WHERE id = ? AND project_id = ?")
        .get(projectHostId, projectId);
      if (!linked) {
        throw new ControlPlaneManagementError(404, "Project host not found");
      }
      const sessions = this.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM persistent_sessions WHERE project_host_id = ?",
        )
        .get(projectHostId) as { count: number };
      if (sessions.count > 0) {
        throw new ControlPlaneManagementError(
          409,
          "Project host still has session history",
        );
      }
      const fixedTerminals = this.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM web_terminal_sessions WHERE project_host_id = ?",
        )
        .get(projectHostId) as { count: number };
      if (fixedTerminals.count > 0) {
        throw new ControlPlaneManagementError(
          409,
          "Project host still has pinned terminal windows",
        );
      }
      this.sqlite
        .prepare("DELETE FROM project_hosts WHERE id = ?")
        .run(projectHostId);
    })();
  }
}
