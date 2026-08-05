import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/main-axios", () => ({
  authApi: api,
  handleApiError: (error: unknown) => error,
}));

import {
  associateWorkspaceProjectHost,
  createWorkspaceProject,
  createWorkspaceTeam,
  deleteWorkspaceProjectFolder,
  getWorkspaceProjects,
  getAdminUserPersonalProjectFolders,
  getWorkspaceProjectFolders,
  getWorkspaceProjectMembers,
  getWorkspaceProjectRoleGrants,
  getWorkspaceProjectServers,
  getWorkspaceTeams,
  moveWorkspaceProjectHosts,
  removeWorkspaceProjectHost,
  removeWorkspaceProjectMember,
  removeWorkspaceProjectRoleGrant,
  renameWorkspaceProjectFolder,
  saveWorkspaceProjectFolder,
  setWorkspaceProjectMember,
  setWorkspaceProjectRoleGrant,
  updateWorkspaceProject,
  updateWorkspaceProjectHost,
} from "@/api/workspace-api";

describe("workspace management API", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads visible teams", async () => {
    const teams = [
      { id: "team-1", name: "运维团队", slug: "ops", role: "team_admin" },
    ];
    api.get.mockResolvedValue({ data: { teams } });

    await expect(getWorkspaceTeams()).resolves.toEqual(teams);
    expect(api.get).toHaveBeenCalledWith("/control-plane/teams");
  });

  it("creates a team and returns the created record", async () => {
    const team = {
      id: "team-2",
      name: "平台团队",
      slug: "platform",
      role: "team_admin",
    };
    api.post.mockResolvedValue({ data: { team } });

    await expect(
      createWorkspaceTeam({ name: "平台团队", slug: "platform" }),
    ).resolves.toEqual(team);
    expect(api.post).toHaveBeenCalledWith("/control-plane/teams", {
      name: "平台团队",
      slug: "platform",
    });
  });

  it("encodes the team id when creating a project", async () => {
    const project = { id: "project-1", name: "生产环境" };
    api.post.mockResolvedValue({ data: { project } });

    await expect(
      createWorkspaceProject("team/one", {
        name: "生产环境",
        slug: "production",
      }),
    ).resolves.toEqual(project);
    expect(api.post).toHaveBeenCalledWith(
      "/control-plane/teams/team%2Fone/projects",
      { name: "生产环境", slug: "production" },
    );
  });

  it("updates project settings without exposing credentials", async () => {
    api.patch.mockResolvedValue({ data: { updated: true } });

    await updateWorkspaceProject("project/one", {
      name: "生产环境",
      slug: "production",
      description: "线上服务",
    });

    expect(api.patch).toHaveBeenCalledWith(
      "/control-plane/projects/project%2Fone",
      {
        name: "生产环境",
        slug: "production",
        description: "线上服务",
      },
    );
  });

  it("lists, assigns, and removes project member roles", async () => {
    const member = {
      userId: "user/2",
      username: "bob",
      role: "operator",
      owner: false,
    };
    api.get.mockResolvedValue({ data: { members: [member] } });
    api.put.mockResolvedValue({ data: { member } });
    api.delete.mockResolvedValue({ data: undefined });

    await expect(getWorkspaceProjectMembers("project/one")).resolves.toEqual([
      member,
    ]);
    await expect(
      setWorkspaceProjectMember("project/one", "user/2", "operator"),
    ).resolves.toEqual(member);
    await removeWorkspaceProjectMember("project/one", "user/2");

    expect(api.get).toHaveBeenCalledWith(
      "/control-plane/projects/project%2Fone/members",
    );
    expect(api.put).toHaveBeenCalledWith(
      "/control-plane/projects/project%2Fone/members/user%2F2",
      { role: "operator" },
    );
    expect(api.delete).toHaveBeenCalledWith(
      "/control-plane/projects/project%2Fone/members/user%2F2",
    );
  });

  it("loads project-scoped servers and folders", async () => {
    const servers = [
      {
        projectHostId: 41,
        hostId: 7,
        name: "数据库",
        folder: "生产 / 数据库",
      },
    ];
    const folders = [
      { path: "生产 / 数据库", color: "#22c55e", icon: "database" },
    ];
    api.get
      .mockResolvedValueOnce({ data: { servers } })
      .mockResolvedValueOnce({ data: { folders } });

    await expect(getWorkspaceProjectServers("project/one")).resolves.toEqual(
      servers,
    );
    await expect(getWorkspaceProjectFolders("project/one")).resolves.toEqual(
      folders,
    );
    expect(api.get).toHaveBeenNthCalledWith(
      1,
      "/control-plane/projects/project%2Fone/servers",
    );
    expect(api.get).toHaveBeenNthCalledWith(
      2,
      "/control-plane/projects/project%2Fone/folders",
    );
  });

  it("keeps the project identity when noncritical statistics fail", async () => {
    api.get
      .mockResolvedValueOnce({
        data: {
          projects: [
            {
              id: "personal-project-id",
              name: "个人空间",
              kind: "personal",
              team: null,
              role: "instance_admin",
              slug: "personal",
              description: null,
              serverCount: 0,
            },
          ],
        },
      })
      .mockRejectedValueOnce(new Error("servers timeout"))
      .mockRejectedValueOnce(new Error("overview timeout"));

    await expect(getWorkspaceProjects()).resolves.toEqual([
      expect.objectContaining({
        id: "personal-project-id",
        hostIds: [],
        memberCount: 1,
      }),
    ]);
  });

  it.each(["personal", "", "   "])(
    "rejects unresolved project id %j before making a request",
    async (projectId) => {
      await expect(getWorkspaceProjectServers(projectId)).rejects.toThrow(
        "Workspace project ID has not been resolved by the control plane",
      );
      await expect(getWorkspaceProjectFolders(projectId)).rejects.toThrow(
        "Workspace project ID has not been resolved by the control plane",
      );

      expect(api.get).not.toHaveBeenCalled();
    },
  );

  it("loads a managed user's personal project folders with encoded ids", async () => {
    const folders = [{ path: "用户目录", color: null, icon: null }];
    api.get.mockResolvedValueOnce({
      data: { project: { id: "personal/project" }, folders },
    });

    await expect(
      getAdminUserPersonalProjectFolders("user/with slash"),
    ).resolves.toEqual(folders);

    expect(api.get).toHaveBeenCalledWith(
      "/control-plane/admin/users/user%2Fwith%20slash/personal-project",
    );
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it("manages folders through project associations instead of global hosts", async () => {
    api.put.mockResolvedValue({ data: {} });
    api.delete.mockResolvedValue({ data: {} });

    await saveWorkspaceProjectFolder("project/one", {
      path: "生产",
      color: "#22c55e",
      icon: "folder",
    });
    await renameWorkspaceProjectFolder("project/one", "生产", "线上");
    await moveWorkspaceProjectHosts("project/one", [41, 42], "线上");
    await updateWorkspaceProjectHost("project/one", 41, {
      alias: "生产入口",
      folder: "线上 / Web",
    });
    api.post.mockResolvedValueOnce({
      data: { server: { projectHostId: 41, hostId: 7 } },
    });
    await associateWorkspaceProjectHost("project/one", 7);
    await removeWorkspaceProjectHost("project/one", 41);
    await deleteWorkspaceProjectFolder("project/one", "线上");

    expect(api.put).toHaveBeenNthCalledWith(
      1,
      "/control-plane/projects/project%2Fone/folders/metadata",
      { path: "生产", color: "#22c55e", icon: "folder" },
    );
    expect(api.put).toHaveBeenNthCalledWith(
      2,
      "/control-plane/projects/project%2Fone/folders/rename",
      { oldPath: "生产", newPath: "线上" },
    );
    expect(api.put).toHaveBeenNthCalledWith(
      3,
      "/control-plane/projects/project%2Fone/servers/folder",
      { projectHostIds: [41, 42], folder: "线上" },
    );
    expect(api.patch).toHaveBeenCalledWith(
      "/control-plane/projects/project%2Fone/servers/41",
      { alias: "生产入口", folder: "线上 / Web" },
    );
    expect(api.post).toHaveBeenCalledWith(
      "/control-plane/projects/project%2Fone/servers",
      { hostId: 7, alias: null },
    );
    expect(api.delete).toHaveBeenCalledWith(
      "/control-plane/projects/project%2Fone/servers/41",
    );
    expect(api.delete).toHaveBeenCalledWith(
      "/control-plane/projects/project%2Fone/folders",
      { data: { path: "线上" } },
    );
  });

  it("lists, assigns, and removes project role group access", async () => {
    const roleGrant = {
      roleId: 9,
      name: "operations",
      displayName: "运维组",
      description: null,
      isSystem: false,
      memberCount: 3,
      projectRole: "operator",
    };
    api.get.mockResolvedValue({ data: { roles: [roleGrant] } });
    api.put.mockResolvedValue({ data: { roleGrant } });
    api.delete.mockResolvedValue({ data: undefined });

    await expect(getWorkspaceProjectRoleGrants("project/one")).resolves.toEqual(
      [roleGrant],
    );
    await expect(
      setWorkspaceProjectRoleGrant("project/one", 9, "operator"),
    ).resolves.toEqual(roleGrant);
    await removeWorkspaceProjectRoleGrant("project/one", 9);

    expect(api.get).toHaveBeenCalledWith(
      "/control-plane/projects/project%2Fone/role-grants",
    );
    expect(api.put).toHaveBeenCalledWith(
      "/control-plane/projects/project%2Fone/role-grants/9",
      { role: "operator" },
    );
    expect(api.delete).toHaveBeenCalledWith(
      "/control-plane/projects/project%2Fone/role-grants/9",
    );
  });
});
