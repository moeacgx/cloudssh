import { authApi, handleApiError } from "@/main-axios";
import type { HostNetworkInfo } from "@/types/index";

export type WorkspaceRole =
  | "instance_admin"
  | "team_admin"
  | "project_admin"
  | "operator"
  | "viewer";

export type WorkspaceProject = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  kind: "personal" | "team";
  teamId: string | null;
  role: WorkspaceRole;
  hostIds: number[];
  memberCount: number;
};

export type WorkspaceProjectServer = {
  projectHostId: number;
  hostId: number;
  name: string;
  sourceName: string | null;
  address: string;
  port: number;
  connectionType: string;
  folder: string | null;
  tags?: string[];
  /** 主机当前关联的项目数量，用于区分解除当前关联和彻底删除。 */
  linkedProjectCount?: number;
  /** 仅主机所有者可以从所有项目删除底层主机。 */
  canDeleteFromAllProjects?: boolean;
  networkInfo?: HostNetworkInfo | null;
};

export type WorkspaceProjectFolder = {
  path: string;
  color: string | null;
  icon: string | null;
  hostCount: number;
  createdAt?: string;
  updatedAt?: string;
};

export type ProjectMemberRole = "project_admin" | "operator" | "viewer";

export type WorkspaceProjectMember = {
  userId: string;
  username: string;
  role: ProjectMemberRole;
  owner: boolean;
  createdAt?: string;
};

export type WorkspaceProjectRoleGrant = {
  roleId: number;
  name: string;
  displayName: string;
  description: string | null;
  isSystem: boolean;
  memberCount: number;
  projectRole: ProjectMemberRole | null;
};

export type WorkspaceTeamMember = {
  userId: string;
  username: string;
  role: "team_admin" | ProjectMemberRole;
  owner: boolean;
  createdAt?: string;
};

export type WorkspaceTeam = {
  id: string;
  name: string;
  slug: string;
  role:
    | "instance_admin"
    | "team_admin"
    | "project_admin"
    | "operator"
    | "viewer";
};

export type AgentActivity = {
  id: string;
  actorName: string;
  actorFingerprint: string | null;
  action: string;
  hostName: string | null;
  /** 活动发生时所在项目主机，便于从最近活动快速打开对应入口。 */
  projectHostId: number | null;
  sessionId: string | null;
  createdAt: string;
  status: "running" | "completed" | "failed" | "waiting";
};

export type WorkspaceProjectSession = {
  id: string;
  title: string | null;
  state: "CREATING" | "RUNNING" | "RECOVERING" | "CLOSING" | string;
  pinned: boolean;
  projectHostId: number;
  serverName: string;
  actor: { type: "user" | "service_account"; id: string | null };
  lastAttachedAt: string | null;
  updatedAt: string;
};

export type WorkspaceProjectOverview = {
  sessions: WorkspaceProjectSession[];
  recentAgentActivity: AgentActivity[];
};

const LEGACY_PERSONAL_PROJECT_ID = "personal";

export function requireResolvedWorkspaceProjectId(projectId: string): string {
  const normalized = projectId.trim();
  if (!normalized || normalized === LEGACY_PERSONAL_PROJECT_ID) {
    throw new Error(
      "Workspace project ID has not been resolved by the control plane",
    );
  }
  return normalized;
}

function encodeWorkspaceProjectId(projectId: string): string {
  return encodeURIComponent(requireResolvedWorkspaceProjectId(projectId));
}

export async function getWorkspaceProjectOverview(
  projectId: string,
): Promise<WorkspaceProjectOverview> {
  try {
    const response = await authApi.get(
      `/control-plane/projects/${encodeWorkspaceProjectId(projectId)}/overview`,
    );
    const sessions = Array.isArray(response.data?.sessions)
      ? response.data.sessions.map(
          (item: {
            id: string;
            title: string | null;
            state: string;
            pinned: boolean;
            projectHostId: number;
            serverName: string;
            actor?: { type?: string; id?: string | null };
            lastAttachedAt: string | null;
            updatedAt: string;
          }) => ({
            id: item.id,
            title: item.title ?? null,
            state: item.state,
            pinned: item.pinned === true,
            projectHostId: Number(item.projectHostId),
            serverName: item.serverName,
            actor: {
              // 未知类型按普通用户处理，避免异常响应把网页会话误标成 Agent。
              type:
                item.actor?.type === "service_account"
                  ? ("service_account" as const)
                  : ("user" as const),
              id: item.actor?.id ?? null,
            },
            lastAttachedAt: item.lastAttachedAt ?? null,
            updatedAt: item.updatedAt,
          }),
        )
      : [];
    const recentAgentActivity = (
      Array.isArray(response.data?.recentAgentActivity)
        ? response.data.recentAgentActivity
        : []
    )
      .slice(0, 20)
      .map(
        (item: {
          id: string;
          action: string;
          success: boolean;
          serviceAccountId: string;
          actorName: string | null;
          actorFingerprint: string | null;
          sessionId: string | null;
          projectHostId?: number | string | null;
          occurredAt: string;
        }) => ({
          id: item.id,
          actorName: item.actorName || item.serviceAccountId || "Agent",
          actorFingerprint: item.actorFingerprint,
          action: item.action,
          hostName: null,
          projectHostId:
            item.projectHostId == null ? null : Number(item.projectHostId),
          sessionId: item.sessionId,
          createdAt: item.occurredAt,
          status: item.success ? ("completed" as const) : ("failed" as const),
        }),
      );
    return { sessions, recentAgentActivity };
  } catch (error) {
    const status = (error as { response?: { status?: number } }).response
      ?.status;
    if (status === 404) return { sessions: [], recentAgentActivity: [] };
    throw handleApiError(error, "load workspace project overview");
  }
}

export async function getWorkspaceProjects(): Promise<WorkspaceProject[]> {
  try {
    const response = await authApi.get("/control-plane/projects");
    const projects = Array.isArray(response.data)
      ? response.data
      : response.data.projects;
    return Promise.all(
      projects.map(
        async (project: {
          id: string;
          name: string;
          kind: "personal" | "team";
          team: { id: string } | null;
          role: WorkspaceRole;
          slug: string;
          description: string | null;
          serverCount: number;
        }) => {
          const encodedProjectId = encodeWorkspaceProjectId(project.id);
          const [serversResult, overviewResult] = await Promise.allSettled([
            authApi.get(`/control-plane/projects/${encodedProjectId}/servers`),
            authApi.get(`/control-plane/projects/${encodedProjectId}/overview`),
          ]);
          const servers =
            serversResult.status === "fulfilled" &&
            Array.isArray(serversResult.value.data?.servers)
              ? serversResult.value.data.servers
              : [];
          const memberCount =
            overviewResult.status === "fulfilled"
              ? Number(overviewResult.value.data?.counts?.memberCount ?? 1)
              : 1;
          return {
            id: project.id,
            name: project.name,
            slug: project.slug,
            description: project.description,
            kind: project.kind,
            teamId: project.team?.id ?? null,
            role: project.role,
            hostIds: servers.map((server: { hostId: number }) => server.hostId),
            memberCount,
          } satisfies WorkspaceProject;
        },
      ),
    );
  } catch (error) {
    const status = (error as { response?: { status?: number } }).response
      ?.status;
    if (status === 404) return [];
    throw handleApiError(error, "load workspace projects");
  }
}

export async function updateWorkspaceProject(
  projectId: string,
  input: { name: string; slug: string; description: string | null },
): Promise<void> {
  try {
    await authApi.patch(
      `/control-plane/projects/${encodeWorkspaceProjectId(projectId)}`,
      input,
    );
  } catch (error) {
    throw handleApiError(error, "update workspace project");
  }
}

export async function getWorkspaceProjectServers(
  projectId: string,
): Promise<WorkspaceProjectServer[]> {
  try {
    const response = await authApi.get(
      `/control-plane/projects/${encodeWorkspaceProjectId(projectId)}/servers`,
    );
    return Array.isArray(response.data?.servers) ? response.data.servers : [];
  } catch (error) {
    throw handleApiError(error, "load workspace project servers");
  }
}

export async function getWorkspaceProjectFolders(
  projectId: string,
): Promise<WorkspaceProjectFolder[]> {
  try {
    const response = await authApi.get(
      `/control-plane/projects/${encodeWorkspaceProjectId(projectId)}/folders`,
    );
    return Array.isArray(response.data?.folders) ? response.data.folders : [];
  } catch (error) {
    throw handleApiError(error, "load workspace project folders");
  }
}

export async function getAdminUserPersonalProjectFolders(
  targetUserId: string,
): Promise<WorkspaceProjectFolder[]> {
  try {
    const workspace = await authApi.get(
      `/control-plane/admin/users/${encodeURIComponent(targetUserId)}/personal-project`,
    );
    return Array.isArray(workspace.data?.folders) ? workspace.data.folders : [];
  } catch (error) {
    throw handleApiError(error, "load managed user's personal project folders");
  }
}

export async function saveWorkspaceProjectFolder(
  projectId: string,
  input: { path: string; color: string | null; icon: string | null },
): Promise<void> {
  try {
    await authApi.put(
      `/control-plane/projects/${encodeWorkspaceProjectId(projectId)}/folders/metadata`,
      input,
    );
  } catch (error) {
    throw handleApiError(error, "save workspace project folder");
  }
}

export async function renameWorkspaceProjectFolder(
  projectId: string,
  oldPath: string,
  newPath: string,
): Promise<void> {
  try {
    await authApi.put(
      `/control-plane/projects/${encodeWorkspaceProjectId(projectId)}/folders/rename`,
      { oldPath, newPath },
    );
  } catch (error) {
    throw handleApiError(error, "rename workspace project folder");
  }
}

export async function deleteWorkspaceProjectFolder(
  projectId: string,
  path: string,
): Promise<void> {
  try {
    await authApi.delete(
      `/control-plane/projects/${encodeWorkspaceProjectId(projectId)}/folders`,
      { data: { path } },
    );
  } catch (error) {
    throw handleApiError(error, "delete workspace project folder");
  }
}

export async function moveWorkspaceProjectHosts(
  projectId: string,
  projectHostIds: number[],
  folder: string | null,
): Promise<void> {
  try {
    await authApi.put(
      `/control-plane/projects/${encodeWorkspaceProjectId(projectId)}/servers/folder`,
      { projectHostIds, folder },
    );
  } catch (error) {
    throw handleApiError(error, "move workspace project hosts");
  }
}

export async function updateWorkspaceProjectHost(
  projectId: string,
  projectHostId: number,
  input: { alias: string | null; folder: string | null },
): Promise<WorkspaceProjectServer> {
  try {
    const response = await authApi.patch(
      `/control-plane/projects/${encodeWorkspaceProjectId(projectId)}/servers/${projectHostId}`,
      input,
    );
    return response.data.server;
  } catch (error) {
    throw handleApiError(error, "update workspace project host");
  }
}

export async function associateWorkspaceProjectHost(
  projectId: string,
  hostId: number,
): Promise<WorkspaceProjectServer> {
  try {
    const response = await authApi.post(
      `/control-plane/projects/${encodeWorkspaceProjectId(projectId)}/servers`,
      { hostId, alias: null },
    );
    return response.data.server;
  } catch (error) {
    throw handleApiError(error, "associate workspace project host");
  }
}

export async function removeWorkspaceProjectHost(
  projectId: string,
  projectHostId: number,
): Promise<void> {
  try {
    await authApi.delete(
      `/control-plane/projects/${encodeWorkspaceProjectId(projectId)}/servers/${projectHostId}`,
    );
  } catch (error) {
    throw handleApiError(error, "remove workspace project host");
  }
}

export async function getWorkspaceProjectMembers(
  projectId: string,
): Promise<WorkspaceProjectMember[]> {
  try {
    const response = await authApi.get(
      `/control-plane/projects/${encodeWorkspaceProjectId(projectId)}/members`,
    );
    return Array.isArray(response.data?.members) ? response.data.members : [];
  } catch (error) {
    throw handleApiError(error, "load workspace project members");
  }
}

export async function getWorkspaceTeamMembers(
  teamId: string,
): Promise<WorkspaceTeamMember[]> {
  try {
    const response = await authApi.get(
      `/control-plane/teams/${encodeURIComponent(teamId)}/members`,
    );
    return Array.isArray(response.data?.members) ? response.data.members : [];
  } catch (error) {
    throw handleApiError(error, "load workspace team members");
  }
}

export async function setWorkspaceProjectMember(
  projectId: string,
  userId: string,
  role: ProjectMemberRole,
): Promise<WorkspaceProjectMember> {
  try {
    const response = await authApi.put(
      `/control-plane/projects/${encodeWorkspaceProjectId(projectId)}/members/${encodeURIComponent(userId)}`,
      { role },
    );
    return response.data.member;
  } catch (error) {
    throw handleApiError(error, "set workspace project member");
  }
}

export async function removeWorkspaceProjectMember(
  projectId: string,
  userId: string,
): Promise<void> {
  try {
    await authApi.delete(
      `/control-plane/projects/${encodeWorkspaceProjectId(projectId)}/members/${encodeURIComponent(userId)}`,
    );
  } catch (error) {
    throw handleApiError(error, "remove workspace project member");
  }
}

export async function getWorkspaceProjectRoleGrants(
  projectId: string,
): Promise<WorkspaceProjectRoleGrant[]> {
  try {
    const response = await authApi.get(
      `/control-plane/projects/${encodeWorkspaceProjectId(projectId)}/role-grants`,
    );
    return Array.isArray(response.data?.roles) ? response.data.roles : [];
  } catch (error) {
    throw handleApiError(error, "load workspace project role grants");
  }
}

export async function setWorkspaceProjectRoleGrant(
  projectId: string,
  roleId: number,
  role: ProjectMemberRole,
): Promise<WorkspaceProjectRoleGrant> {
  try {
    const response = await authApi.put(
      `/control-plane/projects/${encodeWorkspaceProjectId(projectId)}/role-grants/${roleId}`,
      { role },
    );
    return response.data.roleGrant;
  } catch (error) {
    throw handleApiError(error, "set workspace project role grant");
  }
}

export async function removeWorkspaceProjectRoleGrant(
  projectId: string,
  roleId: number,
): Promise<void> {
  try {
    await authApi.delete(
      `/control-plane/projects/${encodeWorkspaceProjectId(projectId)}/role-grants/${roleId}`,
    );
  } catch (error) {
    throw handleApiError(error, "remove workspace project role grant");
  }
}

export async function getWorkspaceTeams(): Promise<WorkspaceTeam[]> {
  try {
    const response = await authApi.get("/control-plane/teams");
    return Array.isArray(response.data?.teams) ? response.data.teams : [];
  } catch (error) {
    throw handleApiError(error, "load workspace teams");
  }
}

export async function createWorkspaceTeam(input: {
  name: string;
  slug: string;
}): Promise<WorkspaceTeam> {
  try {
    const response = await authApi.post("/control-plane/teams", input);
    return response.data.team;
  } catch (error) {
    throw handleApiError(error, "create workspace team");
  }
}

export async function createWorkspaceProject(
  teamId: string,
  input: { name: string; slug: string; description?: string },
): Promise<{ id: string; name: string }> {
  try {
    const response = await authApi.post(
      `/control-plane/teams/${encodeURIComponent(teamId)}/projects`,
      input,
    );
    return response.data.project;
  } catch (error) {
    throw handleApiError(error, "create workspace project");
  }
}

export async function getProjectAgentActivity(
  projectId: string,
  limit = 20,
): Promise<AgentActivity[]> {
  try {
    const overview = await getWorkspaceProjectOverview(projectId);
    return overview.recentAgentActivity.slice(0, limit);
  } catch (error) {
    const status = (error as { response?: { status?: number } }).response
      ?.status;
    if (status === 404) return [];
    throw handleApiError(error, "load agent activity");
  }
}
