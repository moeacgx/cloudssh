import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "@/types/ui-types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/electron", () => ({ isElectron: () => false }));

import { TabBar } from "../../shell/TabBar";

function terminalTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: "terminal-1",
    instanceId: "tab-1",
    type: "terminal",
    label: "prod-db",
    openedAt: Date.now(),
    persistentSessionId: "session-1",
    sessionPinned: false,
    ...overrides,
  };
}

function renderTabBar(
  tab: Tab,
  onPinSession = vi.fn(),
  pinningTabIds = new Set<string>(),
  onOpenShare?: (tabId: string) => void,
) {
  render(
    <TabBar
      tabs={[tab]}
      activeTabId={tab.id}
      splitMode="none"
      paneTabIds={[]}
      focusedPaneIndex={null}
      onSetActiveTab={() => {}}
      onCloseTab={() => {}}
      onRefreshTab={() => {}}
      onReorderTabs={() => {}}
      onSplitTab={() => {}}
      onAddToSplit={() => {}}
      onRemoveFromSplit={() => {}}
      onPinSession={onPinSession}
      onOpenShare={onOpenShare}
      pinningTabIds={pinningTabIds}
      isAppFullscreen={false}
      onToggleAppFullscreen={() => {}}
    />,
  );
  return onPinSession;
}

afterEach(cleanup);

describe("TabBar - 固定窗口", () => {
  it("会把可用终端的图钉操作交给上层", () => {
    const onToggleSessionPin = renderTabBar(terminalTab());

    fireEvent.click(screen.getByRole("button", { name: "terminal.pinWindow" }));

    expect(onToggleSessionPin).toHaveBeenCalledWith("terminal-1");
  });

  it("会禁用尚未就绪终端的固定操作", () => {
    const onToggleSessionPin = renderTabBar(
      terminalTab({ persistentSessionId: null }),
    );
    const button = screen.getByRole("button", {
      name: "terminal.pinWindow",
    });

    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(onToggleSessionPin).not.toHaveBeenCalled();
  });

  it("服务端正在切换固定状态时阻止重复点击", () => {
    const onToggleSessionPin = renderTabBar(
      terminalTab(),
      vi.fn(),
      new Set(["terminal-1"]),
    );

    fireEvent.click(screen.getByRole("button", { name: "terminal.pinWindow" }));

    expect(onToggleSessionPin).not.toHaveBeenCalled();
  });

  it("固定后图钉只显示状态，不能取消固定", () => {
    const onPinSession = renderTabBar(terminalTab({ sessionPinned: true }));
    const button = screen.getByRole("button", {
      name: "terminal.pinnedWindow",
    });

    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(onPinSession).not.toHaveBeenCalled();
  });

  it("Agent 会话不能重复固定，也不显示普通分享入口", () => {
    const onPinSession = vi.fn();
    const onOpenShare = vi.fn();
    renderTabBar(
      terminalTab({ agentSessionId: "agent-session-123456" }),
      onPinSession,
      new Set(),
      onOpenShare,
    );

    const pinButton = screen.getByRole("button", {
      name: "terminal.pinWindow",
    });
    expect(pinButton.hasAttribute("disabled")).toBe(true);
    expect(pinButton.getAttribute("title")).toBe(
      "terminal.agentSessionControlled",
    );
    expect(screen.queryByTitle("sessionSharing.shareButton")).toBeNull();
    expect(onPinSession).not.toHaveBeenCalled();
    expect(onOpenShare).not.toHaveBeenCalled();
  });
});
