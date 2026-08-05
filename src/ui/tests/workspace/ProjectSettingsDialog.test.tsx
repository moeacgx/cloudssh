import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const workspaceApi = vi.hoisted(() => ({
  getWorkspaceProjectMembers: vi.fn(),
  getWorkspaceProjectRoleGrants: vi.fn(),
  getWorkspaceTeamMembers: vi.fn(),
  removeWorkspaceProjectMember: vi.fn(),
  removeWorkspaceProjectRoleGrant: vi.fn(),
  setWorkspaceProjectMember: vi.fn(),
  setWorkspaceProjectRoleGrant: vi.fn(),
  updateWorkspaceProject: vi.fn(),
}));

const userApi = vi.hoisted(() => ({
  getUserList: vi.fn(),
}));

const i18n = vi.hoisted(() => ({
  t: (key: string) =>
    ({
      "workspace.settings.membersAndRoles": "成员与角色",
      "workspace.settings.general": "基本信息",
      "workspace.settings.title": "项目设置",
      "workspace.settings.selectMember": "选择成员",
      "workspace.settings.selectRole": "选择项目角色",
      "workspace.settings.selectRoleGroup": "选择角色组",
      "workspace.settings.selectRoleGroupProjectRole": "选择角色组的项目权限",
      "workspace.settings.authorizeRoleGroup": "授权",
      "workspace.settings.removeRoleGroupGrant": "撤销角色组访问",
      "workspace.settings.roleGroupProjectRole": "设置 {{name}} 的项目权限",
      "workspace.settings.add": "添加",
      "workspace.roles.projectAdmin": "项目管理员",
      "workspace.roles.operator": "操作者",
      "workspace.roles.viewer": "只读成员",
    })[key] ?? key,
}));

vi.mock("@/api/workspace-api", () => workspaceApi);
vi.mock("@/api/user-management-api", () => userApi);
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => i18n,
}));

import { ProjectSettingsDialog } from "@/workspace/ProjectSettingsDialog";

const project = {
  id: "project-1",
  name: "生产环境",
  slug: "production",
  description: "线上服务",
  kind: "team" as const,
  teamId: "team-1",
  role: "project_admin" as const,
  hostIds: [],
  memberCount: 1,
};

describe("ProjectSettingsDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceApi.getWorkspaceProjectMembers.mockResolvedValue([
      {
        userId: "owner-1",
        username: "alice",
        role: "project_admin",
        owner: true,
      },
    ]);
    workspaceApi.getWorkspaceTeamMembers.mockResolvedValue([
      {
        userId: "owner-1",
        username: "alice",
        role: "team_admin",
        owner: true,
      },
      {
        userId: "user-2",
        username: "bob",
        role: "operator",
        owner: false,
      },
    ]);
    workspaceApi.getWorkspaceProjectRoleGrants.mockResolvedValue([
      {
        roleId: 9,
        name: "operations",
        displayName: "运维组",
        description: "生产运维",
        isSystem: false,
        memberCount: 3,
        projectRole: null,
      },
      {
        roleId: 10,
        name: "developers",
        displayName: "开发组",
        description: null,
        isSystem: false,
        memberCount: 2,
        projectRole: "viewer",
      },
    ]);
    userApi.getUserList.mockRejectedValue(new Error("仅实例管理员可用"));
    workspaceApi.setWorkspaceProjectMember.mockResolvedValue({
      userId: "user-2",
      username: "bob",
      role: "viewer",
      owner: false,
    });
    workspaceApi.setWorkspaceProjectRoleGrant.mockImplementation(
      (_projectId: string, roleId: number, role: string) =>
        Promise.resolve({
          roleId,
          name: roleId === 9 ? "operations" : "developers",
          displayName: roleId === 9 ? "运维组" : "开发组",
          description: null,
          isSystem: false,
          memberCount: roleId === 9 ? 3 : 2,
          projectRole: role,
        }),
    );
    workspaceApi.removeWorkspaceProjectRoleGrant.mockResolvedValue(undefined);
  });

  it("opens member settings and assigns a project role", async () => {
    const onUpdated = vi.fn().mockResolvedValue(undefined);
    render(
      <ProjectSettingsDialog
        open
        onOpenChange={vi.fn()}
        project={project}
        onUpdated={onUpdated}
      />,
    );

    await screen.findByDisplayValue("生产环境");
    await userEvent.click(screen.getByText("成员与角色"));
    expect((await screen.findAllByText("项目管理员")).length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByText("操作者").length).toBeGreaterThan(0);
    expect(screen.getAllByText("只读成员").length).toBeGreaterThan(0);

    await userEvent.selectOptions(screen.getByLabelText("选择成员"), "user-2");
    await userEvent.selectOptions(
      screen.getByLabelText("选择项目角色"),
      "viewer",
    );
    await userEvent.click(screen.getByRole("button", { name: "添加" }));

    await waitFor(() =>
      expect(workspaceApi.setWorkspaceProjectMember).toHaveBeenCalledWith(
        "project-1",
        "user-2",
        "viewer",
      ),
    );
    expect(await screen.findByText("bob")).toBeTruthy();
    expect(onUpdated).toHaveBeenCalled();
  });

  it("authorizes a role group and changes its project permission", async () => {
    render(
      <ProjectSettingsDialog
        open
        onOpenChange={vi.fn()}
        project={project}
        onUpdated={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await screen.findByDisplayValue("生产环境");
    await userEvent.click(screen.getByText("成员与角色"));
    await userEvent.selectOptions(screen.getByLabelText("选择角色组"), "9");
    await userEvent.selectOptions(
      screen.getByLabelText("选择角色组的项目权限"),
      "project_admin",
    );
    await userEvent.click(screen.getByRole("button", { name: "授权" }));

    await waitFor(() =>
      expect(workspaceApi.setWorkspaceProjectRoleGrant).toHaveBeenCalledWith(
        "project-1",
        9,
        "project_admin",
      ),
    );
    const addedRoleSelect = screen
      .getAllByLabelText("设置 {{name}} 的项目权限")
      .find(
        (element) => (element as HTMLSelectElement).value === "project_admin",
      );
    expect(addedRoleSelect).toBeTruthy();
    await userEvent.selectOptions(addedRoleSelect!, "viewer");
    await waitFor(() =>
      expect(workspaceApi.setWorkspaceProjectRoleGrant).toHaveBeenCalledWith(
        "project-1",
        9,
        "viewer",
      ),
    );
  });

  it("revokes an existing role group grant", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <ProjectSettingsDialog
        open
        onOpenChange={vi.fn()}
        project={project}
        onUpdated={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await screen.findByDisplayValue("生产环境");
    await userEvent.click(screen.getByText("成员与角色"));
    await userEvent.click(screen.getByTitle("撤销角色组访问"));

    await waitFor(() =>
      expect(workspaceApi.removeWorkspaceProjectRoleGrant).toHaveBeenCalledWith(
        "project-1",
        10,
      ),
    );
    confirm.mockRestore();
  });

  it("does not load or show role groups for a personal project", async () => {
    render(
      <ProjectSettingsDialog
        open
        onOpenChange={vi.fn()}
        project={{
          ...project,
          kind: "personal",
          teamId: null,
          role: "instance_admin",
        }}
        onUpdated={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await screen.findByDisplayValue("生产环境");
    await userEvent.click(screen.getByText("成员与角色"));

    expect(screen.queryByLabelText("选择角色组")).toBeNull();
    expect(workspaceApi.getWorkspaceProjectRoleGrants).not.toHaveBeenCalled();
  });
});
