import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  agentAuditEvents,
  agentAccessTokens,
  agentDevices,
  hosts,
  persistentSessions,
  projectHosts,
  projectMembers,
  projects,
  teamMembers,
  teams,
  users,
} from "../database/db/schema.js";
import type { DatabaseContext } from "../database/repositories/database-context.js";
import { hostNetworkInfoFromRecord } from "../hosts/network-info.js";

function parseTags(value: string | null | undefined): string[] {
  return value
    ? value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
    : [];
}

export type ProjectRole =
  | "instance_admin"
  | "project_admin"
  | "operator"
  | "viewer";

export interface ProjectHostAccess {
  projectId: string;
  projectHostId: number;
  hostId: number;
  role: ProjectRole;
}

const PROJECT_ROLE_RANK: Record<ProjectRole, number> = {
  instance_admin: 4,
  project_admin: 3,
  operator: 2,
  viewer: 1,
};

export function projectRoleHostPermission(
  role: ProjectRole,
): "connect" | "view" | "manage" {
  if (role === "viewer") return "view";
  if (role === "operator") return "connect";
  return "manage";
}

interface ProjectAccessRow {
  ownerUserId: string;
  kind: string;
  projectRole: string | null;
  teamRole: string | null;
  grantedRole: string | null;
}

function resolveRole(
  row: ProjectAccessRow,
  userId: string,
  isInstanceAdmin: boolean,
): ProjectRole | null {
  if (row.kind === "personal") {
    return row.ownerUserId === userId ? "project_admin" : null;
  }
  if (row.kind !== "team") return null;
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

export class ProjectRepository {
  constructor(private readonly context: DatabaseContext) {}

  async listVisibleProjects(userId: string, isInstanceAdmin = false) {
    const rows = await this.context.drizzle
      .selectDistinct({
        id: projects.id,
        name: projects.name,
        slug: projects.slug,
        description: projects.description,
        kind: projects.kind,
        teamId: projects.teamId,
        teamName: teams.name,
        ownerUserId: projects.ownerUserId,
        projectRole: projectMembers.role,
        teamRole: teamMembers.role,
        grantedRole: sql<string | null>`(
          SELECT grant.project_role
            FROM project_role_grants grant
            JOIN user_roles membership ON membership.role_id = grant.role_id
           WHERE grant.project_id = ${projects.id}
             AND membership.user_id = ${userId}
           ORDER BY CASE grant.project_role
             WHEN 'project_admin' THEN 3
             WHEN 'operator' THEN 2
             ELSE 1
           END DESC
           LIMIT 1
        )`,
        updatedAt: projects.updatedAt,
        serverCount: sql<number>`(
          SELECT COUNT(*) FROM project_hosts visible_hosts
          WHERE visible_hosts.project_id = ${projects.id}
        )`,
        resumableSessionCount: sql<number>`(
          SELECT COUNT(*) FROM persistent_sessions visible_sessions
          WHERE visible_sessions.project_id = ${projects.id}
            AND visible_sessions.state IN ('RUNNING', 'RECOVERING')
        )`,
      })
      .from(projects)
      .leftJoin(teams, eq(projects.teamId, teams.id))
      .leftJoin(
        projectMembers,
        and(
          eq(projectMembers.projectId, projects.id),
          eq(projectMembers.userId, userId),
        ),
      )
      .leftJoin(
        teamMembers,
        and(
          eq(teamMembers.teamId, projects.teamId),
          eq(teamMembers.userId, userId),
        ),
      )
      .where(
        isInstanceAdmin
          ? or(eq(projects.kind, "team"), eq(projects.ownerUserId, userId))
          : or(
              eq(projects.ownerUserId, userId),
              and(
                eq(projects.kind, "team"),
                or(
                  eq(projectMembers.userId, userId),
                  eq(teamMembers.userId, userId),
                  sql`EXISTS (
                    SELECT 1
                      FROM project_role_grants visible_grant
                      JOIN user_roles visible_membership
                        ON visible_membership.role_id = visible_grant.role_id
                     WHERE visible_grant.project_id = ${projects.id}
                       AND visible_membership.user_id = ${userId}
                  )`,
                ),
              ),
            ),
      )
      .orderBy(projects.kind, projects.name);

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      kind: row.kind,
      team: row.teamId ? { id: row.teamId, name: row.teamName } : null,
      role: resolveRole(row, userId, isInstanceAdmin),
      serverCount: Number(row.serverCount),
      resumableSessionCount: Number(row.resumableSessionCount),
      updatedAt: row.updatedAt,
    }));
  }

  async findVisibleProject(
    projectId: string,
    userId: string,
    isInstanceAdmin = false,
  ) {
    const rows = await this.context.drizzle
      .select({
        id: projects.id,
        name: projects.name,
        slug: projects.slug,
        description: projects.description,
        kind: projects.kind,
        teamId: projects.teamId,
        teamName: teams.name,
        ownerUserId: projects.ownerUserId,
        ownerUsername: users.username,
        projectRole: projectMembers.role,
        teamRole: teamMembers.role,
        grantedRole: sql<string | null>`(
          SELECT grant.project_role
            FROM project_role_grants grant
            JOIN user_roles membership ON membership.role_id = grant.role_id
           WHERE grant.project_id = ${projects.id}
             AND membership.user_id = ${userId}
           ORDER BY CASE grant.project_role
             WHEN 'project_admin' THEN 3
             WHEN 'operator' THEN 2
             ELSE 1
           END DESC
           LIMIT 1
        )`,
        createdAt: projects.createdAt,
        updatedAt: projects.updatedAt,
      })
      .from(projects)
      .innerJoin(users, eq(projects.ownerUserId, users.id))
      .leftJoin(teams, eq(projects.teamId, teams.id))
      .leftJoin(
        projectMembers,
        and(
          eq(projectMembers.projectId, projects.id),
          eq(projectMembers.userId, userId),
        ),
      )
      .leftJoin(
        teamMembers,
        and(
          eq(teamMembers.teamId, projects.teamId),
          eq(teamMembers.userId, userId),
        ),
      )
      .where(
        and(
          eq(projects.id, projectId),
          isInstanceAdmin
            ? or(eq(projects.kind, "team"), eq(projects.ownerUserId, userId))
            : or(
                eq(projects.ownerUserId, userId),
                and(
                  eq(projects.kind, "team"),
                  or(
                    eq(projectMembers.userId, userId),
                    eq(teamMembers.userId, userId),
                    sql`EXISTS (
                      SELECT 1
                        FROM project_role_grants visible_grant
                        JOIN user_roles visible_membership
                          ON visible_membership.role_id = visible_grant.role_id
                       WHERE visible_grant.project_id = ${projects.id}
                         AND visible_membership.user_id = ${userId}
                    )`,
                  ),
                ),
              ),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      kind: row.kind,
      team: row.teamId ? { id: row.teamId, name: row.teamName } : null,
      owner: { id: row.ownerUserId, username: row.ownerUsername },
      role: resolveRole(row, userId, isInstanceAdmin),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async listProjectServers(
    projectId: string,
    userId: string,
    isInstanceAdmin = false,
  ) {
    if (!(await this.findVisibleProject(projectId, userId, isInstanceAdmin))) {
      return null;
    }

    const rows = await this.context.drizzle
      .select({
        projectHostId: projectHosts.id,
        hostId: hosts.id,
        alias: projectHosts.alias,
        name: hosts.name,
        address: hosts.ip,
        port: hosts.port,
        connectionType: hosts.connectionType,
        folder: projectHosts.folder,
        projectTags: projectHosts.tags,
        hostTags: hosts.tags,
        enableTerminal: hosts.enableTerminal,
        enableFileManager: hosts.enableFileManager,
        enableSessionLogging: hosts.enableSessionLogging,
        networkInfoStatus: hosts.networkInfoStatus,
        networkLookupSource: hosts.networkLookupSource,
        networkResolvedIp: hosts.networkResolvedIp,
        networkCountryCode: hosts.networkCountryCode,
        networkCountry: hosts.networkCountry,
        networkRegion: hosts.networkRegion,
        networkCity: hosts.networkCity,
        networkIsp: hosts.networkIsp,
        networkAsn: hosts.networkAsn,
        networkInfoUpdatedAt: hosts.networkInfoUpdatedAt,
        // 仅返回删除范围判断所需的最小元数据，不暴露底层所有者 ID。
        linkedProjectCount: sql<number>`(
          SELECT COUNT(*)
          FROM project_hosts linked_project
          WHERE linked_project.host_id = ${hosts.id}
        )`,
        canDeleteFromAllProjects: sql<number>`CASE
          WHEN ${hosts.userId} = ${userId} THEN 1
          ELSE 0
        END`,
        health: sql<number | null>`(
          SELECT ok FROM host_health_history latest_health
          WHERE latest_health.host_id = ${hosts.id}
          ORDER BY latest_health.ts DESC, latest_health.id DESC
          LIMIT 1
        )`,
        healthCheckedAt: sql<string | null>`(
          SELECT ts FROM host_health_history latest_health
          WHERE latest_health.host_id = ${hosts.id}
          ORDER BY latest_health.ts DESC, latest_health.id DESC
          LIMIT 1
        )`,
      })
      .from(projectHosts)
      .innerJoin(hosts, eq(projectHosts.hostId, hosts.id))
      .where(eq(projectHosts.projectId, projectId))
      .orderBy(projectHosts.alias, hosts.name, hosts.id);

    return rows.map((row) => ({
      projectHostId: row.projectHostId,
      hostId: row.hostId,
      name: row.alias || row.name || `Server ${row.hostId}`,
      sourceName: row.alias ? row.name : null,
      address: row.address,
      port: row.port,
      connectionType: row.connectionType,
      folder: row.folder,
      tags: parseTags(row.projectTags ?? row.hostTags),
      networkInfo: hostNetworkInfoFromRecord(row),
      linkedProjectCount: Number(row.linkedProjectCount ?? 1),
      canDeleteFromAllProjects: row.canDeleteFromAllProjects === 1,
      capabilities: {
        terminal: row.enableTerminal,
        fileManager: row.enableFileManager,
        sessionRecording: row.enableSessionLogging,
      },
      health:
        row.health === null
          ? { status: "unknown" as const, checkedAt: null }
          : {
              status: row.health
                ? ("healthy" as const)
                : ("unhealthy" as const),
              checkedAt: row.healthCheckedAt,
            },
    }));
  }

  async findHostAccess(
    hostId: number,
    userId: string,
    projectHostId?: number,
  ): Promise<ProjectHostAccess | null> {
    const links = await this.context.drizzle
      .select({
        projectId: projectHosts.projectId,
        projectHostId: projectHosts.id,
        hostId: projectHosts.hostId,
      })
      .from(projectHosts)
      .where(
        projectHostId === undefined
          ? eq(projectHosts.hostId, hostId)
          : and(
              eq(projectHosts.hostId, hostId),
              eq(projectHosts.id, projectHostId),
            ),
      );

    const access = (
      await Promise.all(
        links.map(async (link) => {
          const project = await this.findVisibleProject(
            link.projectId,
            userId,
            false,
          );
          if (!project?.role) return null;
          return { ...link, role: project.role } satisfies ProjectHostAccess;
        }),
      )
    ).filter((entry): entry is ProjectHostAccess => entry !== null);

    return (
      access.sort(
        (left, right) =>
          PROJECT_ROLE_RANK[right.role] - PROJECT_ROLE_RANK[left.role] ||
          left.projectHostId - right.projectHostId,
      )[0] ?? null
    );
  }

  async isHostOwnerControlled(
    hostId: number,
    userId: string,
  ): Promise<boolean> {
    const links = await this.context.drizzle
      .select({
        kind: projects.kind,
        ownerUserId: projects.ownerUserId,
      })
      .from(projectHosts)
      .innerJoin(projects, eq(projects.id, projectHosts.projectId))
      .where(eq(projectHosts.hostId, hostId));

    if (links.length === 0) return true;
    return links.some(
      (link) => link.kind === "personal" && link.ownerUserId === userId,
    );
  }

  async listAccessibleHostEntries(
    userId: string,
  ): Promise<ProjectHostAccess[]> {
    const visibleProjects = await this.listVisibleProjects(userId, false);
    const roleByProjectId = new Map(
      visibleProjects.flatMap((project) =>
        project.role ? [[project.id, project.role] as const] : [],
      ),
    );
    const projectIds = [...roleByProjectId.keys()];
    if (projectIds.length === 0) return [];

    const links = await this.context.drizzle
      .select({
        projectId: projectHosts.projectId,
        projectHostId: projectHosts.id,
        hostId: projectHosts.hostId,
      })
      .from(projectHosts)
      .where(inArray(projectHosts.projectId, projectIds));

    const strongestByHost = new Map<number, ProjectHostAccess>();
    for (const link of links) {
      const role = roleByProjectId.get(link.projectId);
      if (!role) continue;
      const candidate = { ...link, role };
      const current = strongestByHost.get(link.hostId);
      if (
        !current ||
        PROJECT_ROLE_RANK[candidate.role] > PROJECT_ROLE_RANK[current.role] ||
        (PROJECT_ROLE_RANK[candidate.role] ===
          PROJECT_ROLE_RANK[current.role] &&
          candidate.projectHostId < current.projectHostId)
      ) {
        strongestByHost.set(link.hostId, candidate);
      }
    }
    return [...strongestByHost.values()];
  }

  async getProjectOverview(
    projectId: string,
    userId: string,
    isInstanceAdmin = false,
  ) {
    const project = await this.findVisibleProject(
      projectId,
      userId,
      isInstanceAdmin,
    );
    if (!project) return null;

    const activeStates = ["CREATING", "RUNNING", "RECOVERING", "CLOSING"];
    const [counts] = await this.context.drizzle
      .select({
        serverCount: sql<number>`(
          SELECT COUNT(*) FROM project_hosts overview_hosts
          WHERE overview_hosts.project_id = ${projectId}
        )`,
        memberCount: sql<number>`(
          SELECT COUNT(DISTINCT visible_member_id) FROM (
            SELECT owner_user_id AS visible_member_id FROM projects WHERE id = ${projectId}
            UNION
            SELECT user_id FROM project_members WHERE project_id = ${projectId}
            UNION
            SELECT team_members.user_id FROM team_members
              INNER JOIN projects overview_project ON overview_project.team_id = team_members.team_id
              WHERE overview_project.id = ${projectId}
            UNION
            SELECT membership.user_id FROM user_roles membership
              INNER JOIN project_role_grants overview_grant
                ON overview_grant.role_id = membership.role_id
              WHERE overview_grant.project_id = ${projectId}
          )
        )`,
        activeSessionCount: sql<number>`(
          SELECT COUNT(*) FROM persistent_sessions overview_sessions
          WHERE overview_sessions.project_id = ${projectId}
            AND overview_sessions.state IN ('CREATING', 'RUNNING', 'RECOVERING', 'CLOSING')
        )`,
        resumableSessionCount: sql<number>`(
          SELECT COUNT(*) FROM persistent_sessions overview_sessions
          WHERE overview_sessions.project_id = ${projectId}
            AND overview_sessions.state IN ('RUNNING', 'RECOVERING')
        )`,
        agentEventCount24h: sql<number>`(
          SELECT COUNT(*) FROM agent_audit_events overview_events
          WHERE overview_events.project_id = ${projectId}
            AND overview_events.occurred_at >= datetime('now', '-24 hours')
        )`,
      })
      .from(projects)
      .where(eq(projects.id, projectId));

    const sessions = await this.context.drizzle
      .select({
        id: persistentSessions.id,
        title: persistentSessions.title,
        state: persistentSessions.state,
        pinned: persistentSessions.pinned,
        projectHostId: persistentSessions.projectHostId,
        hostName: hosts.name,
        alias: projectHosts.alias,
        ownerUserId: persistentSessions.ownerUserId,
        serviceAccountId: persistentSessions.serviceAccountId,
        lastAttachedAt: persistentSessions.lastAttachedAt,
        updatedAt: persistentSessions.updatedAt,
      })
      .from(persistentSessions)
      .innerJoin(
        projectHosts,
        eq(persistentSessions.projectHostId, projectHosts.id),
      )
      .innerJoin(hosts, eq(projectHosts.hostId, hosts.id))
      .where(
        and(
          eq(persistentSessions.projectId, projectId),
          inArray(persistentSessions.state, activeStates),
        ),
      )
      .orderBy(desc(persistentSessions.updatedAt))
      .limit(10);

    const recentAgentActivity = await this.context.drizzle
      .select({
        id: agentAuditEvents.id,
        action: agentAuditEvents.action,
        success: agentAuditEvents.success,
        errorCode: agentAuditEvents.errorCode,
        serviceAccountId: agentAuditEvents.serviceAccountId,
        deviceId: agentAuditEvents.deviceId,
        deviceName: agentDevices.name,
        deviceFingerprint: agentDevices.fingerprint,
        tokenName: agentAccessTokens.name,
        sessionId: agentAuditEvents.sessionId,
        projectHostId: agentAuditEvents.projectHostId,
        occurredAt: agentAuditEvents.occurredAt,
      })
      .from(agentAuditEvents)
      .leftJoin(
        agentAccessTokens,
        eq(agentAuditEvents.tokenId, agentAccessTokens.id),
      )
      .leftJoin(agentDevices, eq(agentAuditEvents.deviceId, agentDevices.id))
      .where(eq(agentAuditEvents.projectId, projectId))
      .orderBy(desc(agentAuditEvents.occurredAt))
      .limit(10);

    return {
      project,
      counts: {
        serverCount: Number(counts?.serverCount ?? 0),
        memberCount: Number(counts?.memberCount ?? 0),
        activeSessionCount: Number(counts?.activeSessionCount ?? 0),
        resumableSessionCount: Number(counts?.resumableSessionCount ?? 0),
        agentEventCount24h: Number(counts?.agentEventCount24h ?? 0),
      },
      sessions: sessions.map((session) => ({
        id: session.id,
        title: session.title,
        state: session.state,
        pinned: session.pinned,
        projectHostId: session.projectHostId,
        serverName: session.alias || session.hostName,
        actor:
          session.ownerUserId !== null
            ? { type: "user" as const, id: session.ownerUserId }
            : {
                type: "service_account" as const,
                id: session.serviceAccountId,
              },
        lastAttachedAt: session.lastAttachedAt,
        updatedAt: session.updatedAt,
      })),
      recentAgentActivity: recentAgentActivity.map(
        ({ deviceName, deviceFingerprint, tokenName, ...activity }) => ({
          ...activity,
          actorName:
            deviceName ?? tokenName ?? activity.serviceAccountId ?? "Agent",
          actorFingerprint:
            deviceFingerprint && deviceFingerprint.length > 24
              ? `${deviceFingerprint.slice(0, 12)}...${deviceFingerprint.slice(-12)}`
              : deviceFingerprint,
        }),
      ),
    };
  }
}
