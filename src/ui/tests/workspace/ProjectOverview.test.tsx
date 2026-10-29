import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mainAxios = vi.hoisted(() => ({
  getSSHHosts: vi.fn(async () => [] as Record<string, unknown>[]),
  getActiveSessions: vi.fn(async () => [] as Record<string, unknown>[]),
}));

const statusStore = vi.hoisted(() => ({
  getStatus: vi.fn(() => "online"),
}));
vi.mock("@/lib/ServerStatusContext", () => ({
  useServerStatus: () => statusStore,
}));

const workspaceApi = vi.hoisted(() => ({
  getWorkspaceProjectOverview: vi.fn(async () => ({
    sessions: [],
    recentAgentActivity: [],
  })),
  getWorkspaceProjectServers: vi.fn(
    async () => [] as Record<string, unknown>[],
  ),
}));

const workspace = vi.hoisted(() => ({
  refreshProjects: vi.fn(async () => {}),
  activeProject: {
    id: "project-1",
    name: "生产环境",
    slug: "production",
    description: null,
    kind: "team" as const,
    teamId: "team-1",
    role: "project_admin" as const,
    hostIds: [],
    memberCount: 2,
  },
}));

vi.mock("@/workspace/WorkspaceContext", () => ({
  useWorkspace: () => workspace,
}));
vi.mock("@/main-axios", () => mainAxios);
vi.mock("@/api/workspace-api", () => workspaceApi);
vi.mock("@/workspace/ProjectSettingsDialog", () => ({
  ProjectSettingsDialog: ({ open }: { open: boolean }) =>
    open ? <div role="dialog">project-settings-dialog</div> : null,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key === "workspace.projectSettings" ? "项目设置" : key,
    i18n: { language: "zh-CN" },
  }),
}));

import { ProjectOverview } from "@/workspace/ProjectOverview";

describe("ProjectOverview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspace.activeProject.id = "project-1";
    statusStore.getStatus.mockReturnValue("online");
    mainAxios.getSSHHosts.mockResolvedValue([]);
    mainAxios.getActiveSessions.mockResolvedValue([]);
    workspaceApi.getWorkspaceProjectOverview.mockResolvedValue({
      sessions: [],
      recentAgentActivity: [],
    });
    workspaceApi.getWorkspaceProjectServers.mockResolvedValue([]);
  });

  afterEach(() => vi.useRealTimers());

  const host = {
    id: 7,
    name: "目标主机",
    ip: "192.0.2.7",
    port: 22,
    username: "root",
    status: "unknown",
    pin: true,
  };
  const projectServer = {
    projectHostId: 71,
    hostId: 7,
    name: "目标主机",
    folder: "",
  };

  it("状态请求未完成时仍显示主机，并从共享状态更新在线数量", async () => {
    mainAxios.getSSHHosts.mockImplementation(
      (options?: { includeStatus?: boolean }) =>
        options?.includeStatus === false
          ? Promise.resolve([host])
          : new Promise(() => {}),
    );
    workspaceApi.getWorkspaceProjectServers.mockResolvedValue([projectServer]);
    const view = render(<ProjectOverview onOpenTab={vi.fn()} />);
    await screen.findByText("目标主机");
    const metric = screen.getByText("workspace.metrics.online").parentElement
      ?.parentElement;
    expect(metric?.textContent).toContain("1");
    statusStore.getStatus.mockReturnValue("offline");
    view.rerender(<ProjectOverview onOpenTab={vi.fn()} />);
    expect(metric?.textContent).toContain("0");
  });

  it("初次失败展示错误和重试，不能把失败显示为空项目", async () => {
    mainAxios.getSSHHosts.mockRejectedValueOnce(new Error("network timeout"));
    render(<ProjectOverview onOpenTab={vi.fn()} />);
    expect(screen.queryByText("workspace.noServers")).toBeNull();
    await screen.findByRole("alert");
    mainAxios.getSSHHosts.mockResolvedValue([host]);
    workspaceApi.getWorkspaceProjectServers.mockResolvedValue([projectServer]);
    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    await screen.findByText("目标主机");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("切换项目立即隐藏旧主机", async () => {
    mainAxios.getSSHHosts.mockResolvedValue([host]);
    workspaceApi.getWorkspaceProjectServers.mockResolvedValue([projectServer]);
    const view = render(<ProjectOverview onOpenTab={vi.fn()} />);
    await screen.findByText("目标主机");
    workspace.activeProject.id = "project-2";
    workspaceApi.getWorkspaceProjectServers.mockImplementation(
      () => new Promise(() => {}),
    );
    view.rerender(<ProjectOverview onOpenTab={vi.fn()} />);
    expect(screen.queryByText("目标主机")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("common.loading");
  });

  it("会话服务缓慢时主机独立加载，首次加载的指标不伪装为零", async () => {
    mainAxios.getSSHHosts.mockResolvedValue([host]);
    workspaceApi.getWorkspaceProjectServers.mockResolvedValue([projectServer]);
    mainAxios.getActiveSessions.mockImplementation(() => new Promise(() => {}));
    render(<ProjectOverview onOpenTab={vi.fn()} />);
    await screen.findByText("目标主机");
    const metric = screen.getByText("workspace.metrics.persistentSessions")
      .parentElement?.parentElement;
    expect(metric?.textContent).toContain("—");
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("旧项目迟到响应不能覆盖新项目内容", async () => {
    mainAxios.getSSHHosts.mockResolvedValue([host]);
    let resolveOld!: (value: Record<string, unknown>[]) => void;
    workspaceApi.getWorkspaceProjectServers.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const view = render(<ProjectOverview onOpenTab={vi.fn()} />);
    workspace.activeProject.id = "project-2";
    workspaceApi.getWorkspaceProjectServers.mockResolvedValue([]);
    view.rerender(<ProjectOverview onOpenTab={vi.fn()} />);
    await screen.findByText("workspace.noServers");
    await act(async () => {
      resolveOld([projectServer]);
    });
    expect(screen.queryByText("目标主机")).toBeNull();
    expect(screen.getByText("workspace.noServers")).toBeTruthy();
  });

  it("地区信息轮询等待在途刷新，失败保留已加载主机", async () => {
    vi.useFakeTimers();
    mainAxios.getSSHHosts.mockResolvedValue([host]);
    workspaceApi.getWorkspaceProjectServers.mockResolvedValue([
      { ...projectServer, networkInfo: { status: "pending" } },
    ]);
    render(<ProjectOverview onOpenTab={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("目标主机")).toBeTruthy();
    let rejectRefresh!: (error: Error) => void;
    workspaceApi.getWorkspaceProjectServers.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectRefresh = reject;
        }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(workspaceApi.getWorkspaceProjectServers).toHaveBeenCalledTimes(2);
    await act(async () => {
      rejectRefresh(new Error("timeout"));
    });
    expect(screen.getByText("目标主机")).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("点击项目设置会打开设置窗口", async () => {
    render(<ProjectOverview onOpenTab={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "项目设置" }));

    await waitFor(() =>
      expect(screen.getByRole("dialog").textContent).toContain(
        "project-settings-dialog",
      ),
    );
  });

  it("uses project aliases and excludes sessions from other projects", async () => {
    mainAxios.getSSHHosts.mockResolvedValue([
      {
        id: 7,
        name: "原始名称",
        folder: "全局目录",
        ip: "192.0.2.7",
        port: 22,
        username: "root",
        status: "online",
        pin: true,
      },
      {
        id: 8,
        name: "其他项目主机",
        folder: "其他",
        ip: "192.0.2.8",
        port: 22,
        username: "root",
        status: "online",
        pin: true,
      },
    ]);
    workspaceApi.getWorkspaceProjectServers.mockResolvedValue([
      {
        projectHostId: 71,
        hostId: 7,
        name: "项目别名",
        folder: "项目目录",
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
      },
    ]);
    mainAxios.getActiveSessions.mockResolvedValue([
      {
        sessionId: "agent-current",
        agentSessionId: "agent-current",
        sessionSource: "agent",
        hostId: 7,
        projectHostId: 71,
      },
      // 网页进入 Agent 会话后产生的本地观察附件不能重复计数。
      {
        sessionId: "browser-observer",
        agentSessionId: "agent-current",
        sessionSource: "agent",
        hostId: 7,
        projectHostId: 71,
      },
      // 同一主机也可能被另一个项目关联；项目主机关联 ID 不匹配时必须排除。
      { sessionId: "other-project", hostId: 7, projectHostId: 81 },
      { sessionId: "other", hostId: 8, projectHostId: 82 },
    ]);

    render(<ProjectOverview onOpenTab={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("项目别名")).toBeTruthy());
    expect(screen.getByText("#7")).toBeTruthy();
    expect(screen.queryByText("#71")).toBeNull();
    expect(screen.queryByText("原始名称")).toBeNull();
    expect(screen.queryByText("其他项目主机")).toBeNull();
    expect(
      screen.getByLabelText(
        "hosts.networkLocation: US United States · Los Angeles; hosts.networkIsp: NTT America, Inc.",
      ),
    ).toBeTruthy();
    const sessionLabel = screen.getByText(
      "workspace.metrics.persistentSessions",
    );
    expect(sessionLabel.parentElement?.parentElement?.textContent).toContain(
      "1",
    );
    expect(workspaceApi.getWorkspaceProjectServers).toHaveBeenCalledWith(
      "project-1",
    );
  });

  it("保留新版网页持续会话的重连入口", async () => {
    mainAxios.getSSHHosts.mockResolvedValue([host]);
    workspaceApi.getWorkspaceProjectServers.mockResolvedValue([projectServer]);
    const session = {
      sessionId: "web-pinned",
      hostId: 7,
      projectHostId: 71,
      isOwnSession: true,
      sessionSource: "web",
      sessionPinned: true,
      sessionManagedTmux: false,
    };
    mainAxios.getActiveSessions.mockResolvedValue([session]);
    const reconnect = vi.fn();
    render(
      <ProjectOverview
        onOpenTab={vi.fn()}
        onOpenPersistentSession={reconnect}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "connections.reconnect" }),
    );
    expect(reconnect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "7", projectHostId: "71" }),
      session,
    );
    expect(
      screen.getByText("connections.platformKeepaliveSession"),
    ).toBeTruthy();
  });

  it("只把服务账号持续会话展示为 Agent 会话", async () => {
    mainAxios.getSSHHosts.mockResolvedValue([
      {
        id: 7,
        name: "目标主机",
        folder: "",
        ip: "192.0.2.7",
        port: 22,
        username: "root",
        status: "online",
        pin: true,
      },
    ]);
    workspaceApi.getWorkspaceProjectServers.mockResolvedValue([
      { projectHostId: 71, hostId: 7, name: "目标主机", folder: "" },
    ]);
    workspaceApi.getWorkspaceProjectOverview.mockResolvedValue({
      sessions: [
        {
          id: "agent-session",
          title: "Agent 长任务",
          state: "RUNNING",
          pinned: true,
          projectHostId: 71,
          serverName: "目标主机",
          actor: { type: "service_account", id: "agent-1" },
          lastAttachedAt: null,
          updatedAt: "2026-08-02T00:00:00.000Z",
        },
        {
          id: "web-session",
          title: "网页固定窗口",
          state: "RUNNING",
          pinned: true,
          projectHostId: 71,
          serverName: "目标主机",
          actor: { type: "user", id: "user-1" },
          lastAttachedAt: null,
          updatedAt: "2026-08-02T00:00:00.000Z",
        },
      ],
      recentAgentActivity: [],
    });

    render(<ProjectOverview onOpenTab={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("Agent 长任务")).toBeTruthy());
    expect(screen.getAllByText("#7")).toHaveLength(2);
    expect(screen.queryByText("#71")).toBeNull();
    expect(screen.queryByText("网页固定窗口")).toBeNull();
    expect(screen.getAllByText("Agent").length).toBeGreaterThan(0);
  });

  it("最近活动可以进入仍在运行的 Agent 会话或新建普通 SSH", async () => {
    const onOpenTab = vi.fn();
    const onOpenAgentSession = vi.fn();
    mainAxios.getSSHHosts.mockResolvedValue([
      {
        id: 7,
        name: "目标主机",
        folder: "",
        ip: "192.0.2.7",
        port: 22,
        username: "root",
        status: "online",
        pin: true,
      },
    ]);
    workspaceApi.getWorkspaceProjectServers.mockResolvedValue([
      { projectHostId: 71, hostId: 7, name: "目标主机", folder: "" },
    ]);
    workspaceApi.getWorkspaceProjectOverview.mockResolvedValue({
      sessions: [
        {
          id: "agent-session",
          title: "Agent 长任务",
          state: "RUNNING",
          pinned: true,
          projectHostId: 71,
          serverName: "目标主机",
          actor: { type: "service_account", id: "agent-1" },
          lastAttachedAt: null,
          updatedAt: "2026-08-02T00:00:00.000Z",
        },
      ],
      recentAgentActivity: [
        {
          id: "activity-1",
          actorName: "deploy-agent",
          actorFingerprint: null,
          action: "POST /agent/v1/sessions/agent-session/read",
          hostName: null,
          projectHostId: 71,
          sessionId: "agent-session",
          createdAt: "2026-08-02T00:00:00.000Z",
          status: "completed",
        },
      ],
    });

    render(
      <ProjectOverview
        onOpenTab={onOpenTab}
        onOpenAgentSession={onOpenAgentSession}
      />,
    );

    await waitFor(() => expect(screen.getByText("deploy-agent")).toBeTruthy());
    expect(screen.getByText("workspace.agentActivityReadOutput")).toBeTruthy();
    const enterButtons = screen.getAllByRole("button", {
      name: "workspace.enterAgentSession",
    });
    fireEvent.click(enterButtons[0]);
    expect(onOpenAgentSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "7", projectHostId: "71" }),
      "agent-session",
      "Agent 长任务",
    );
    fireEvent.click(enterButtons.at(-1)!);
    expect(onOpenAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: "7" }),
      "agent-session",
      "Agent 长任务",
    );

    const newTerminalButtons = screen.getAllByRole("button", {
      name: "workspace.newSshTerminal",
    });
    fireEvent.click(newTerminalButtons[0]);
    expect(onOpenTab).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "7", projectHostId: "71" }),
      "terminal",
    );
    fireEvent.click(newTerminalButtons.at(-1)!);
    expect(onOpenTab).toHaveBeenCalledWith(
      expect.objectContaining({ id: "7" }),
      "terminal",
    );
  });
});
