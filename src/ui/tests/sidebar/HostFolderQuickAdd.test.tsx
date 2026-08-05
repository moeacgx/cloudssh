import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HostManager } from "../../sidebar/HostManager";
import { SidebarTree } from "../../sidebar/SidebarTree";

const api = vi.hoisted(() => ({
  getSSHHosts: vi.fn(async () => []),
  getCredentials: vi.fn(async () => []),
  getLinkedCredentialIds: vi.fn(async () => ({ credentialIds: [] })),
  deleteCredential: vi.fn(),
  deployCredentialToHost: vi.fn(),
  renameCredentialFolder: vi.fn(),
  bulkUpdateSSHHosts: vi.fn(),
  createSSHHost: vi.fn(),
  deleteSSHHost: vi.fn(),
  getHostPassword: vi.fn(),
  renameFolder: vi.fn(),
  updateFolderMetadata: vi.fn(),
  deleteAllHostsInFolder: vi.fn(),
  wakeOnLan: vi.fn(),
}));
const workspaceApi = vi.hoisted(() => ({
  getWorkspaceProjectServers: vi.fn(async () => [] as unknown[]),
}));
const workspace = vi.hoisted(() => ({
  activeProject: { id: "project-1", kind: "team" as const },
}));

vi.mock("@/main-axios", () => api);
vi.mock("@/api/workspace-api", () => workspaceApi);

vi.mock("../../sidebar/HostEditor", () => ({
  HostEditor: ({ initialFolder }: { initialFolder?: string }) => (
    <div data-testid="host-editor" data-initial-folder={initialFolder} />
  ),
}));

vi.mock("../../sidebar/HostCredentialList", () => ({
  HostCredentialList: ({ allHosts }: { allHosts: { name: string }[] }) => (
    <div data-testid="host-list" data-hosts={JSON.stringify(allHosts)} />
  ),
}));

vi.mock("../../sidebar/CredentialEditorView", () => ({
  CredentialEditorView: () => <div />,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/workspace/WorkspaceContext", () => ({
  useWorkspace: () => workspace,
}));

vi.mock("@/hooks/use-status-color-scheme", () => ({
  useStatusColorScheme: () => "default",
  getStatusClasses: () => ({}),
}));

vi.mock("@/lib/ServerStatusContext", () => ({
  useHostStatus: () => "offline",
  useServerStatus: () => ({
    getStatus: () => "offline",
    initialLoadComplete: true,
  }),
  useServerStatusMeta: () => ({ initialLoadComplete: true }),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 36,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 36,
      })),
    measure: vi.fn(),
    measureElement: vi.fn(),
  }),
}));

describe("文件夹快捷新增主机", () => {
  beforeEach(() => {
    workspace.activeProject = { id: "project-1", kind: "team" };
    api.getSSHHosts.mockResolvedValue([]);
    workspaceApi.getWorkspaceProjectServers.mockResolvedValue([]);
  });

  it("主机行固定展示地区和 ISP", () => {
    render(
      <SidebarTree
        children={[
          {
            id: "7",
            name: "洛杉矶入口",
            ip: "198.51.100.42",
            port: 22,
            username: "root",
            online: true,
            authType: "none",
            tags: [],
            enableSsh: true,
            enableRdp: false,
            enableVnc: false,
            enableTelnet: false,
            enableTerminal: true,
            enableFileManager: true,
            enableTunnel: false,
            enableDocker: false,
            networkInfo: {
              status: "ready",
              resolvedIp: "198.51.100.42",
              countryCode: "US",
              country: "United States",
              region: "California",
              city: "Los Angeles",
              isp: "NTT America, Inc.",
              asn: "AS2914",
              updatedAt: "2026-08-02T00:00:00.000Z",
            },
          } as never,
        ]}
        onOpenTab={vi.fn()}
        onEditHost={vi.fn()}
        selectionMode={false}
        onToggleSelectionMode={vi.fn()}
      />,
    );

    expect(
      screen.getByLabelText(
        "hosts.networkLocation: US United States · Los Angeles; hosts.networkIsp: NTT America, Inc.",
      ),
    ).toBeTruthy();
  });

  it("点击文件夹行的加号后打开主机表单并预填当前文件夹", async () => {
    render(
      <>
        <SidebarTree
          children={[
            {
              name: "生产环境",
              path: "业务系统/生产环境",
              children: [],
            },
          ]}
          onOpenTab={vi.fn()}
          onEditHost={vi.fn()}
          selectionMode={false}
          onToggleSelectionMode={vi.fn()}
          projectFolderActions={{
            canManage: true,
            removeHosts: vi.fn(async () => undefined),
            moveHosts: vi.fn(async () => undefined),
            saveFolder: vi.fn(async () => undefined),
            deleteFolder: vi.fn(async () => undefined),
          }}
        />
        <HostManager />
      </>,
    );

    const addHostButton = screen.getByLabelText("hosts.addHostToFolder");
    expect(addHostButton.getAttribute("role")).toBe("button");
    addHostButton.focus();
    await userEvent.keyboard("{Enter}");

    expect(
      screen.getByTestId("host-editor").getAttribute("data-initial-folder"),
    ).toBe("业务系统/生产环境");
  });

  it("主机编辑器只加载当前项目关联的主机", async () => {
    api.getSSHHosts.mockResolvedValue([
      { id: 1, name: "全局一", folder: "旧目录" },
      { id: 2, name: "全局二", folder: "其他目录" },
    ]);
    workspaceApi.getWorkspaceProjectServers.mockResolvedValue([
      {
        projectHostId: 21,
        hostId: 2,
        name: "项目别名",
        sourceName: "全局二",
        address: "192.0.2.2",
        port: 22,
        connectionType: "ssh",
        folder: "当前项目目录",
      },
    ]);

    render(<HostManager />);

    await waitFor(() => {
      const hosts = JSON.parse(
        screen.getByTestId("host-list").getAttribute("data-hosts") || "[]",
      );
      expect(hosts).toHaveLength(1);
      expect(hosts[0]).toMatchObject({
        id: "2",
        projectHostId: "21",
        name: "项目别名",
        folder: "当前项目目录",
        sourceName: "全局二",
        sourceFolder: "其他目录",
      });
    });
  });

  it("切换项目时关闭旧项目的主机表单", async () => {
    const view = render(<HostManager />);
    act(() => {
      window.dispatchEvent(new CustomEvent("host-manager:add-host"));
    });
    expect(screen.getByTestId("host-editor")).toBeTruthy();

    workspace.activeProject = { id: "project-2", kind: "team" };
    view.rerender(<HostManager />);

    await waitFor(() => {
      expect(screen.queryByTestId("host-editor")).toBeNull();
      expect(screen.getByTestId("host-list")).toBeTruthy();
    });
    expect(workspaceApi.getWorkspaceProjectServers).toHaveBeenCalledWith(
      "project-2",
    );
  });

  it("项目内移除主机只删除项目关联，不删除底层主机", async () => {
    const removeHosts = vi.fn(async () => undefined);
    render(
      <SidebarTree
        children={[
          {
            id: "7",
            name: "生产入口",
            ip: "192.0.2.7",
            port: 22,
            username: "root",
            authType: "none",
            isShared: true,
            linkedProjectCount: 2,
            canDeleteFromAllProjects: false,
            enableSsh: true,
            enableRdp: false,
            enableVnc: false,
            enableTelnet: false,
            enableTerminal: true,
            enableFileManager: true,
            enableTunnel: false,
            enableDocker: false,
          } as never,
        ]}
        onOpenTab={vi.fn()}
        onEditHost={vi.fn()}
        selectionMode={false}
        onToggleSelectionMode={vi.fn()}
        projectFolderActions={{
          canManage: true,
          removeHosts,
          moveHosts: vi.fn(async () => undefined),
          saveFolder: vi.fn(async () => undefined),
          deleteFolder: vi.fn(async () => undefined),
        }}
      />,
    );

    await userEvent.click(screen.getByTitle("More options"));
    expect(screen.queryByText("hosts.cloneHostAction")).toBeNull();
    await userEvent.click(await screen.findByText("hosts.removeFromProject"));
    await userEvent.click(screen.getByText("hosts.removeConfirmBtn"));

    await waitFor(() =>
      expect(removeHosts).toHaveBeenCalledWith(["7"], "current-project"),
    );
    expect(api.deleteSSHHost).not.toHaveBeenCalled();
  });

  it("个人空间删除主机会真正删除底层主机", async () => {
    const removeHosts = vi.fn(async (hostIds: string[]) => {
      await Promise.all(hostIds.map((id) => api.deleteSSHHost(Number(id))));
    });
    render(
      <SidebarTree
        children={[
          {
            id: "8",
            name: "误建到个人空间的主机",
            ip: "192.0.2.8",
            port: 22,
            username: "root",
            authType: "password",
            enableSsh: true,
            enableRdp: false,
            enableVnc: false,
            enableTelnet: false,
            enableTerminal: true,
            enableFileManager: true,
            enableTunnel: false,
            enableDocker: false,
          } as never,
        ]}
        onOpenTab={vi.fn()}
        onEditHost={vi.fn()}
        selectionMode={false}
        onToggleSelectionMode={vi.fn()}
        projectFolderActions={{
          canManage: true,
          removeHosts,
          moveHosts: vi.fn(async () => undefined),
          saveFolder: vi.fn(async () => undefined),
          deleteFolder: vi.fn(async () => undefined),
        }}
      />,
    );

    await userEvent.click(screen.getByTitle("More options"));
    await userEvent.click(await screen.findByText("common.delete"));
    await userEvent.click(screen.getByText("hosts.deleteConfirmBtn"));

    await waitFor(() =>
      expect(removeHosts).toHaveBeenCalledWith(["8"], "all-projects"),
    );
    expect(api.deleteSSHHost).toHaveBeenCalledWith(8);
  });

  it("项目批量操作明确提示可以选择移除或删除", () => {
    render(
      <SidebarTree
        children={[]}
        onOpenTab={vi.fn()}
        onEditHost={vi.fn()}
        selectionMode
        onToggleSelectionMode={vi.fn()}
        projectFolderActions={{
          canManage: true,
          removeHosts: vi.fn(async () => undefined),
          moveHosts: vi.fn(async () => undefined),
          saveFolder: vi.fn(async () => undefined),
          deleteFolder: vi.fn(async () => undefined),
        }}
      />,
    );

    expect(screen.getByText("hosts.removeOrDeleteSelected")).toBeTruthy();
  });

  it("自有主机关联多个项目时可以选择只移除当前项目", async () => {
    const removeHosts = vi.fn(async () => undefined);
    render(
      <SidebarTree
        children={[
          {
            id: "9",
            name: "共享生产主机",
            ip: "192.0.2.9",
            port: 22,
            username: "root",
            authType: "password",
            isShared: false,
            linkedProjectCount: 2,
            canDeleteFromAllProjects: true,
            enableSsh: true,
            enableRdp: false,
            enableVnc: false,
            enableTelnet: false,
            enableTerminal: true,
            enableFileManager: true,
            enableTunnel: false,
            enableDocker: false,
          } as never,
        ]}
        onOpenTab={vi.fn()}
        onEditHost={vi.fn()}
        selectionMode={false}
        onToggleSelectionMode={vi.fn()}
        projectFolderActions={{
          canManage: true,
          removeHosts,
          moveHosts: vi.fn(async () => undefined),
          saveFolder: vi.fn(async () => undefined),
          deleteFolder: vi.fn(async () => undefined),
        }}
      />,
    );

    await userEvent.click(screen.getByTitle("More options"));
    await userEvent.click(await screen.findByText("common.delete"));
    expect(screen.getByText("hosts.removeOrDeleteHostTitle")).toBeTruthy();

    await userEvent.click(screen.getByText("hosts.removeCurrentProjectOnly"));
    await waitFor(() =>
      expect(removeHosts).toHaveBeenCalledWith(["9"], "current-project"),
    );

    await userEvent.click(screen.getByTitle("More options"));
    await userEvent.click(await screen.findByText("common.delete"));
    await userEvent.click(screen.getByText("hosts.deleteFromAllProjects"));
    await waitFor(() =>
      expect(removeHosts).toHaveBeenCalledWith(["9"], "all-projects"),
    );
  });
});
