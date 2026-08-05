import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  act,
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
} from "@testing-library/react";
import type { ActiveSessionInfo } from "@/api/open-tabs-api";
import { upsertOpenTabRecord, type OpenTabRecord } from "@/api/open-tabs-api";
import type { Tab } from "@/types/ui-types";

const mainAxios = vi.hoisted(() => ({
  getActiveSessions: vi.fn(async () => [] as ActiveSessionInfo[]),
  deleteOpenTab: vi.fn(async () => {}),
}));

vi.mock("@/main-axios", () => mainAxios);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}));

import { ConnectionsPanel } from "../../sidebar/ConnectionsPanel";

function sharedSession(
  overrides: Partial<ActiveSessionInfo> = {},
): ActiveSessionInfo {
  return {
    sessionId: "sess-shared-1",
    hostId: 5,
    hostName: "prod-db",
    tabInstanceId: null,
    isConnected: true,
    createdAt: Date.now(),
    isOwnSession: false,
    sharedByUsername: "alice",
    permissionLevel: "read-only",
    shareId: "share-1",
    sessionPinned: false,
    lastDetachedAt: null,
    retentionExpiresAt: null,
    tmuxSessionName: null,
    recoverable: false,
    ...overrides,
  };
}

function backgroundTab(overrides: Partial<OpenTabRecord> = {}): OpenTabRecord {
  return {
    id: "tab-1",
    userId: "user-1",
    tabType: "terminal",
    hostId: 5,
    label: "prod-db",
    tabOrder: 0,
    backendSessionId: "session-1",
    sessionPinned: false,
    tmuxSessionName: null,
    lastDetachedAt: null,
    retentionExpiresAt: null,
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  mainAxios.getActiveSessions.mockReset();
  mainAxios.getActiveSessions.mockResolvedValue([]);
  mainAxios.deleteOpenTab.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("ConnectionsPanel - shared with me", () => {
  it("renders a shared-with-me row for sessions the current user does not own", async () => {
    mainAxios.getActiveSessions.mockResolvedValue([sharedSession()]);

    render(
      <ConnectionsPanel
        tabs={[]}
        activeTabId=""
        allHosts={[]}
        backgroundTabRecords={[]}
        onSwitchToTab={() => {}}
        onCloseTab={() => {}}
        onReopenTab={() => {}}
        onForgetBackground={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("connections.sectionSharedWithMe")).toBeTruthy();
    });
    expect(screen.getByText("prod-db")).toBeTruthy();
    expect(
      screen.getByText('connections.sharedBy:{"username":"alice"}'),
    ).toBeTruthy();
  });

  it("does not show own sessions in the shared-with-me section", async () => {
    mainAxios.getActiveSessions.mockResolvedValue([
      sharedSession({
        isOwnSession: true,
        sharedByUsername: null,
        shareId: null,
      }),
    ]);

    render(
      <ConnectionsPanel
        tabs={[]}
        activeTabId=""
        allHosts={[]}
        backgroundTabRecords={[]}
        onSwitchToTab={() => {}}
        onCloseTab={() => {}}
        onReopenTab={() => {}}
        onForgetBackground={() => {}}
      />,
    );

    await waitFor(() => {
      expect(mainAxios.getActiveSessions).toHaveBeenCalled();
    });
    expect(screen.queryByText("connections.sectionSharedWithMe")).toBeNull();
  });

  it("dispatches onJoinSharedSession with the session when Join is clicked", async () => {
    const session = sharedSession();
    mainAxios.getActiveSessions.mockResolvedValue([session]);
    const onJoinSharedSession = vi.fn();

    render(
      <ConnectionsPanel
        tabs={[]}
        activeTabId=""
        allHosts={[]}
        backgroundTabRecords={[]}
        onSwitchToTab={() => {}}
        onCloseTab={() => {}}
        onReopenTab={() => {}}
        onForgetBackground={() => {}}
        onJoinSharedSession={onJoinSharedSession}
      />,
    );

    const joinButton = await screen.findByText("connections.join");
    fireEvent.click(joinButton);

    expect(onJoinSharedSession).toHaveBeenCalledWith(session);
  });

  it("shows a read-write badge for read-write shared sessions", async () => {
    mainAxios.getActiveSessions.mockResolvedValue([
      sharedSession({ permissionLevel: "read-write" }),
    ]);

    render(
      <ConnectionsPanel
        tabs={[]}
        activeTabId=""
        allHosts={[]}
        backgroundTabRecords={[]}
        onSwitchToTab={() => {}}
        onCloseTab={() => {}}
        onReopenTab={() => {}}
        onForgetBackground={() => {}}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByText("sessionSharing.permissionLevel.readWrite"),
      ).toBeTruthy();
    });
  });
});

describe("ConnectionsPanel - persistent SSH sessions", () => {
  it("显示 Agent 会话并分别提供进入原会话和新建 SSH 入口", async () => {
    const agentSession = sharedSession({
      sessionId: "agent-session-123456",
      hostName: "agent-host",
      projectId: "project-1",
      projectHostId: 51,
      isOwnSession: true,
      sessionSource: "agent",
      agentSessionId: "agent-session-123456",
      agentActorName: "deploy-agent",
      sessionManagedTmux: true,
      runtimeMode: "tmux",
    });
    mainAxios.getActiveSessions.mockResolvedValue([agentSession]);
    const onOpenAgentSession = vi.fn();
    const onOpenAgentNewTerminal = vi.fn();

    render(
      <ConnectionsPanel
        tabs={[]}
        activeTabId=""
        activeProjectId="project-1"
        allHosts={[{ id: "5", name: "agent-host" }]}
        backgroundTabRecords={[]}
        onSwitchToTab={() => {}}
        onCloseTab={() => {}}
        onReopenTab={() => {}}
        onForgetBackground={() => {}}
        onOpenAgentSession={onOpenAgentSession}
        onOpenAgentNewTerminal={onOpenAgentNewTerminal}
      />,
    );

    expect(await screen.findByText("connections.sectionAgent")).toBeTruthy();
    expect(screen.getByText("Agent")).toBeTruthy();
    expect(screen.getByText("tmux")).toBeTruthy();
    fireEvent.click(screen.getByText("agent-host"));
    expect(onOpenAgentSession).toHaveBeenCalledWith(agentSession);
    fireEvent.click(
      screen.getByRole("button", { name: "connections.newSshTerminal" }),
    );
    expect(onOpenAgentNewTerminal).toHaveBeenCalledWith(agentSession);
  });

  it("终止按钮不会进入 Agent 会话，并传递权威会话记录", async () => {
    const session = sharedSession({
      sessionId: "agent-session-close",
      hostName: "close-host",
      projectId: "project-1",
      isOwnSession: true,
      sessionSource: "agent",
      agentSessionId: "agent-session-close",
      agentActorName: "deploy-agent",
      runtimeMode: "platform",
    });
    mainAxios.getActiveSessions.mockResolvedValue([session]);
    const onOpenAgentSession = vi.fn();
    const onTerminateAgentSession = vi.fn();

    render(
      <ConnectionsPanel
        tabs={[]}
        activeTabId=""
        activeProjectId="project-1"
        allHosts={[]}
        backgroundTabRecords={[]}
        onSwitchToTab={() => {}}
        onCloseTab={() => {}}
        onReopenTab={() => {}}
        onForgetBackground={() => {}}
        onOpenAgentSession={onOpenAgentSession}
        onTerminateAgentSession={onTerminateAgentSession}
      />,
    );

    const terminateButton = await screen.findByRole("button", {
      name: "connections.terminateAgentSession",
    });
    expect(terminateButton.closest('[class*="md:opacity-0"]')).toBeNull();
    fireEvent.click(terminateButton);

    expect(onTerminateAgentSession).toHaveBeenCalledTimes(1);
    expect(onTerminateAgentSession).toHaveBeenCalledWith(session);
    expect(onOpenAgentSession).not.toHaveBeenCalled();
  });

  it("非运行状态仍可终止，忙碌时禁用且终止成功后立即移除", async () => {
    const session = sharedSession({
      sessionId: "agent-session-busy",
      hostName: "busy-host",
      projectId: "project-1",
      isOwnSession: true,
      isConnected: false,
      sessionSource: "agent",
      agentSessionId: "agent-session-busy",
      runtimeMode: "tmux",
    });
    mainAxios.getActiveSessions.mockResolvedValue([session]);
    const onTerminateAgentSession = vi.fn();
    const commonProps = {
      tabs: [] as Tab[],
      activeTabId: "",
      activeProjectId: "project-1",
      allHosts: [],
      backgroundTabRecords: [] as OpenTabRecord[],
      onSwitchToTab: () => {},
      onCloseTab: () => {},
      onReopenTab: () => {},
      onForgetBackground: () => {},
      onTerminateAgentSession,
    };

    const { rerender } = render(<ConnectionsPanel {...commonProps} />);
    const terminateButton = await screen.findByRole("button", {
      name: "connections.terminateAgentSession",
    });
    expect((terminateButton as HTMLButtonElement).disabled).toBe(false);

    rerender(
      <ConnectionsPanel
        {...commonProps}
        terminatingAgentSessionIds={new Set(["agent-session-busy"])}
      />,
    );
    const busyButton = screen.getByRole("button", {
      name: "connections.agentSessionTerminating",
    });
    expect((busyButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(busyButton);
    fireEvent.click(busyButton);
    expect(onTerminateAgentSession).not.toHaveBeenCalled();

    rerender(
      <ConnectionsPanel
        {...commonProps}
        terminatedAgentSessionIds={new Set(["agent-session-busy"])}
      />,
    );
    expect(screen.queryByText("busy-host")).toBeNull();
  });

  it("标记无需 tmux 的平台中转 Agent 会话", async () => {
    mainAxios.getActiveSessions.mockResolvedValue([
      sharedSession({
        sessionId: "agent-platform",
        hostName: "platform-host",
        projectId: "project-1",
        projectHostId: 51,
        isOwnSession: true,
        sessionSource: "agent",
        agentSessionId: "agent-platform",
        runtimeMode: "platform",
        sessionManagedTmux: false,
        recoverable: false,
      }),
    ]);

    render(
      <ConnectionsPanel
        tabs={[]}
        activeTabId=""
        activeProjectId="project-1"
        allHosts={[{ id: "5", name: "platform-host" }]}
        backgroundTabRecords={[]}
        onSwitchToTab={() => {}}
        onCloseTab={() => {}}
        onReopenTab={() => {}}
        onForgetBackground={() => {}}
      />,
    );

    expect(await screen.findByText("platform-host")).toBeTruthy();
    expect(screen.getByText("connections.platformRuntimeMode")).toBeTruthy();
  });

  it("只显示当前项目的 Agent 持续会话", async () => {
    mainAxios.getActiveSessions.mockResolvedValue([
      sharedSession({
        sessionId: "agent-current",
        projectId: "project-1",
        projectHostId: 51,
        hostName: "当前项目主机",
        isOwnSession: true,
        sessionSource: "agent",
        agentSessionId: "agent-current",
      }),
      sharedSession({
        sessionId: "agent-other",
        projectId: "project-2",
        projectHostId: 61,
        hostName: "其他项目主机",
        isOwnSession: true,
        sessionSource: "agent",
        agentSessionId: "agent-other",
      }),
    ]);

    render(
      <ConnectionsPanel
        tabs={[]}
        activeTabId=""
        activeProjectId="project-1"
        allHosts={[{ id: "5", name: "当前项目主机" }]}
        backgroundTabRecords={[]}
        onSwitchToTab={() => {}}
        onCloseTab={() => {}}
        onReopenTab={() => {}}
        onForgetBackground={() => {}}
      />,
    );

    expect(await screen.findByText("当前项目主机")).toBeTruthy();
    expect(screen.queryByText("其他项目主机")).toBeNull();
  });

  it.each([
    [
      "tmux 可恢复",
      true,
      "cloudssh-session-1",
      "connections.tmuxPinnedSession",
    ],
    ["平台保活", false, null, "connections.platformKeepaliveSession"],
    ["旧未知模式", undefined, null, "connections.pinnedSession"],
  ] as const)(
    "固定会话为%s时显示对应文案",
    async (_, sessionManagedTmux, tmuxSessionName, expectedLabel) => {
      mainAxios.getActiveSessions.mockResolvedValue([
        sharedSession({
          sessionId: "session-1",
          tabInstanceId: "tab-1",
          isConnected: false,
          isOwnSession: true,
          sharedByUsername: null,
          permissionLevel: null,
          shareId: null,
          sessionPinned: true,
          sessionManagedTmux,
          tmuxSessionName,
          recoverable: sessionManagedTmux === true,
        }),
      ]);

      render(
        <ConnectionsPanel
          tabs={[]}
          activeTabId=""
          allHosts={[{ id: "5", name: "prod-db" }]}
          backgroundTabRecords={[backgroundTab()]}
          onSwitchToTab={() => {}}
          onCloseTab={() => {}}
          onReopenTab={() => {}}
          onForgetBackground={() => {}}
        />,
      );

      expect(await screen.findByText(expectedLabel)).toBeTruthy();
    },
  );

  it("轮询仅更新固定模式时同步刷新文案", async () => {
    vi.useFakeTimers();
    try {
      const platformSession = sharedSession({
        sessionId: "session-1",
        tabInstanceId: "tab-1",
        isConnected: false,
        isOwnSession: true,
        sharedByUsername: null,
        permissionLevel: null,
        shareId: null,
        sessionPinned: true,
        sessionManagedTmux: false,
      });
      const tmuxSession = {
        ...platformSession,
        sessionManagedTmux: true,
      };
      mainAxios.getActiveSessions
        .mockResolvedValueOnce([platformSession])
        .mockResolvedValue([tmuxSession]);

      render(
        <ConnectionsPanel
          tabs={[]}
          activeTabId=""
          allHosts={[{ id: "5", name: "prod-db" }]}
          backgroundTabRecords={[backgroundTab()]}
          onSwitchToTab={() => {}}
          onCloseTab={() => {}}
          onReopenTab={() => {}}
          onForgetBackground={() => {}}
        />,
      );

      await vi.waitFor(() => {
        expect(
          screen.getByText("connections.platformKeepaliveSession"),
        ).toBeTruthy();
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      await vi.waitFor(() => {
        expect(screen.getByText("connections.tmuxPinnedSession")).toBeTruthy();
      });
      expect(
        screen.queryByText("connections.platformKeepaliveSession"),
      ).toBeNull();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it("uses the explicit terminate action for an open pinned tab", async () => {
    const onCloseTab = vi.fn();
    const onTerminatePinnedTab = vi.fn();
    const tab: Tab = {
      id: "live-tab",
      instanceId: "tab-live",
      type: "terminal",
      label: "prod-db",
      openedAt: Date.now(),
      sessionPinned: true,
      sessionManagedTmux: false,
    };

    render(
      <ConnectionsPanel
        tabs={[tab]}
        activeTabId="live-tab"
        allHosts={[]}
        backgroundTabRecords={[]}
        onSwitchToTab={() => {}}
        onCloseTab={onCloseTab}
        onTerminatePinnedTab={onTerminatePinnedTab}
        onReopenTab={() => {}}
        onForgetBackground={() => {}}
      />,
    );

    expect(
      await screen.findByText("connections.platformKeepaliveSession"),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "terminal.closePinnedWindow" }),
    );

    expect(onTerminatePinnedTab).toHaveBeenCalledWith("live-tab");
    expect(onCloseTab).not.toHaveBeenCalled();
  });

  it("closes an Agent attachment without offering pinned termination", async () => {
    const onCloseTab = vi.fn();
    const onTerminatePinnedTab = vi.fn();
    const tab: Tab = {
      id: "agent-tab",
      instanceId: "agent-tab-instance",
      type: "terminal",
      label: "agent-host",
      openedAt: Date.now(),
      sessionPinned: true,
      sessionManagedTmux: false,
      agentSessionId: "agent-session-1",
    };

    render(
      <ConnectionsPanel
        tabs={[tab]}
        activeTabId="agent-tab"
        allHosts={[]}
        backgroundTabRecords={[]}
        onSwitchToTab={() => {}}
        onCloseTab={onCloseTab}
        onTerminatePinnedTab={onTerminatePinnedTab}
        onReopenTab={() => {}}
        onForgetBackground={() => {}}
      />,
    );

    expect(await screen.findByText("Agent")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "connections.closeTab" }),
    );

    expect(onCloseTab).toHaveBeenCalledWith("agent-tab");
    expect(onTerminatePinnedTab).not.toHaveBeenCalled();
  });
  it("reopens a detached pinned window from the background list and exposes explicit termination", async () => {
    const pinnedSession = sharedSession({
      sessionId: "session-1",
      tabInstanceId: "tab-1",
      isConnected: false,
      isOwnSession: true,
      sharedByUsername: null,
      permissionLevel: null,
      shareId: null,
      sessionPinned: true,
      sessionManagedTmux: true,
      tmuxSessionName: "cloudssh-session-1",
      recoverable: true,
    });
    const record = backgroundTab();
    const backgroundRecords = upsertOpenTabRecord([], record);
    mainAxios.getActiveSessions.mockResolvedValue([pinnedSession]);
    const onReopenTab = vi.fn();
    const onTerminatePinnedRecord = vi.fn();

    render(
      <ConnectionsPanel
        tabs={[]}
        activeTabId=""
        allHosts={[{ id: "5", name: "prod-db" }]}
        backgroundTabRecords={backgroundRecords}
        onSwitchToTab={() => {}}
        onCloseTab={() => {}}
        onTerminatePinnedRecord={onTerminatePinnedRecord}
        onReopenTab={onReopenTab}
        onForgetBackground={() => {}}
      />,
    );

    expect(
      await screen.findByText("connections.tmuxPinnedSession"),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "terminal.closePinnedWindow" }),
    );
    expect(onTerminatePinnedRecord).toHaveBeenCalledWith(record);

    fireEvent.click(screen.getByText("prod-db"));
    expect(onReopenTab).toHaveBeenCalledWith(
      expect.objectContaining({ id: "tab-1" }),
      "session-1",
      true,
    );
  });

  it("未恢复的固定窗口会提示先恢复，而不是直接请求终止", async () => {
    const record = backgroundTab({
      sessionPinned: true,
      tmuxSessionName: "cloudssh-session-1",
    });
    const onPinnedRestoreRequired = vi.fn();
    const onTerminatePinnedRecord = vi.fn();

    render(
      <ConnectionsPanel
        tabs={[]}
        activeTabId=""
        allHosts={[{ id: "5", name: "prod-db" }]}
        backgroundTabRecords={[record]}
        onSwitchToTab={() => {}}
        onCloseTab={() => {}}
        onTerminatePinnedRecord={onTerminatePinnedRecord}
        onPinnedRestoreRequired={onPinnedRestoreRequired}
        onReopenTab={() => {}}
        onForgetBackground={() => {}}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "terminal.restorePinnedBeforeClose",
      }),
    );

    expect(onPinnedRestoreRequired).toHaveBeenCalledWith(record);
    expect(onTerminatePinnedRecord).not.toHaveBeenCalled();
  });

  it("已结束的平台保活记录允许直接清理", async () => {
    const record = backgroundTab({
      sessionPinned: true,
      tmuxSessionName: null,
    });
    const onPinnedRestoreRequired = vi.fn();
    const onTerminatePinnedRecord = vi.fn();

    render(
      <ConnectionsPanel
        tabs={[]}
        activeTabId=""
        allHosts={[{ id: "5", name: "prod-db" }]}
        backgroundTabRecords={[record]}
        onSwitchToTab={() => {}}
        onCloseTab={() => {}}
        onTerminatePinnedRecord={onTerminatePinnedRecord}
        onPinnedRestoreRequired={onPinnedRestoreRequired}
        onReopenTab={() => {}}
        onForgetBackground={() => {}}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "terminal.closePinnedWindow" }),
    );

    expect(onTerminatePinnedRecord).toHaveBeenCalledWith(record);
    expect(onPinnedRestoreRequired).not.toHaveBeenCalled();
  });

  it("shows the server-provided expiry for an ordinary session", async () => {
    const now = new Date("2026-07-31T12:00:00.000Z");
    vi.setSystemTime(now);
    mainAxios.getActiveSessions.mockResolvedValue([
      sharedSession({
        sessionId: "session-1",
        tabInstanceId: "tab-1",
        isOwnSession: true,
        sharedByUsername: null,
        permissionLevel: null,
        shareId: null,
        lastDetachedAt: now.getTime() - 30 * 60_000,
        retentionExpiresAt: now.getTime() + 30 * 60_000,
      }),
    ]);

    render(
      <ConnectionsPanel
        tabs={[]}
        activeTabId=""
        allHosts={[{ id: "5", name: "prod-db" }]}
        backgroundTabRecords={[backgroundTab()]}
        onSwitchToTab={() => {}}
        onCloseTab={() => {}}
        onReopenTab={() => {}}
        onForgetBackground={() => {}}
      />,
    );

    expect(
      await screen.findByText('connections.expiresIn:{"duration":"30m 0s"}'),
    ).toBeTruthy();
    vi.useRealTimers();
  });
});
