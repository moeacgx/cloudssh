import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "zh-CN" },
    t: (key: string) => key,
  }),
}));

vi.mock("@/workspace/WorkspaceContext", () => ({
  useWorkspace: () => ({
    activeProject: { id: "project-1", name: "生产项目" },
  }),
}));

vi.mock("@/sidebar/PanelAgentPanel", () => ({
  PanelAgentPanel: ({
    embedded,
    compact,
    conversationAction,
  }: {
    embedded?: boolean;
    compact?: boolean;
    conversationAction?: { type: string } | null;
  }) => (
    <div data-testid="panel-agent-panel">
      {embedded ? "embedded agent panel" : "standalone agent panel"}
      {compact ? " compact" : ""}
      {conversationAction?.type ? ` action:${conversationAction.type}` : ""}
      <input aria-label="mock Agent draft" />
    </div>
  ),
}));

import { WorkspaceUtilityRail } from "@/workspace/WorkspaceUtilityRail";

function renderRail() {
  return render(
    <WorkspaceUtilityRail
      activeTabId=""
      terminalTabs={[]}
      onOpenFiles={vi.fn()}
      onOpenMetrics={vi.fn()}
      onLayoutChange={vi.fn()}
    />,
  );
}

describe("WorkspaceUtilityRail", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  it("opens the panel Agent as a compact movable mobile quick-reply window", async () => {
    renderRail();

    const floatButton = screen.getByRole("button", {
      name: "workspace.utility.agentFloat",
    });
    expect(floatButton.className).toContain("bg-background/45");
    expect(floatButton.className).toContain("backdrop-blur-2xl");

    fireEvent.pointerDown(floatButton, {
      clientX: 360,
      clientY: 420,
      button: 0,
    });
    fireEvent.pointerMove(window, { clientX: 20, clientY: 300 });
    fireEvent.pointerUp(window);
    expect(floatButton.className).toContain("rounded-r-full");

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    fireEvent.click(floatButton);

    const dialog = screen.getByRole("dialog", {
      name: "workspace.utility.agentChat",
    });
    expect(dialog.className).toContain("fixed");
    expect(dialog.className).toContain("bg-white/30");
    expect(dialog.className).toContain("backdrop-blur-2xl");
    expect(Number.parseInt(dialog.style.height, 10)).toBeLessThanOrEqual(560);
    expect(Number.parseInt(dialog.style.height, 10)).toBeGreaterThanOrEqual(
      360,
    );
    expect(screen.getByTestId("panel-agent-panel").textContent).toContain(
      "embedded agent panel compact",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "panelAgent.settings" }),
    );
    expect(screen.getByTestId("panel-agent-panel").textContent).toContain(
      "action:settings",
    );
    const draft = screen.getByLabelText("mock Agent draft");
    fireEvent.change(draft, { target: { value: "keep this context" } });

    fireEvent.click(
      screen.getByRole("button", {
        name: "workspace.utility.agentFloatMinimize",
      }),
    );

    expect(
      screen.queryByRole("dialog", { name: "workspace.utility.agentChat" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "workspace.utility.agentFloat" }),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "workspace.utility.agentFloat" }),
    );
    expect(screen.getByLabelText("mock Agent draft")).toHaveProperty(
      "value",
      "keep this context",
    );
  });

  it("collapses the mobile Agent when tapping outside the floating panel", async () => {
    renderRail();

    fireEvent.click(
      screen.getByRole("button", { name: "workspace.utility.agentFloat" }),
    );
    const draft = screen.getByLabelText("mock Agent draft");
    fireEvent.change(draft, { target: { value: "preserve draft" } });

    fireEvent.pointerDown(screen.getByTestId("mobile-agent-outside-dismiss"));

    expect(
      screen.queryByRole("dialog", { name: "workspace.utility.agentChat" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "workspace.utility.agentFloat" }),
    );
    expect(screen.getByLabelText("mock Agent draft")).toHaveProperty(
      "value",
      "preserve draft",
    );
  });

  it("hides the mobile Agent to a tucked edge handle", () => {
    renderRail();

    fireEvent.click(
      screen.getByRole("button", { name: "workspace.utility.agentFloat" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "workspace.utility.agentFloatHide" }),
    );

    expect(
      screen.queryByRole("dialog", { name: "workspace.utility.agentChat" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "workspace.utility.agentFloat" }),
    ).toBeNull();

    const restoreHandle = screen.getByRole("button", {
      name: "workspace.utility.agentFloatRestore",
    });
    expect(restoreHandle.className).toContain("w-2");
    expect(restoreHandle.className).toContain("bg-accent-brand/45");

    fireEvent.click(restoreHandle);
    expect(
      screen.getByRole("button", { name: "workspace.utility.agentFloat" }),
    ).toBeTruthy();
  });
});
