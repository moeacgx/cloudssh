import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mainAxios = vi.hoisted(() => ({
  getSSHHosts: vi.fn(async () => [] as Record<string, unknown>[]),
  getActiveSessions: vi.fn(async () => [] as Record<string, unknown>[]),
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
    mainAxios.getSSHHosts.mockResolvedValue([]);
    mainAxios.getActiveSessions.mockResolvedValue([]);
    workspaceApi.getWorkspaceProjectOverview.mockResolvedValue({
      sessions: [],
      recentAgentActivity: [],
    });
    workspaceApi.getWorkspaceProjectServers.mockResolvedValue([]);
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
