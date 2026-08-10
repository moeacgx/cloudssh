import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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
  PanelAgentPanel: ({ embedded }: { embedded?: boolean }) => (
    <div data-testid="panel-agent-panel">
      {embedded ? "embedded agent panel" : "standalone agent panel"}
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
  it("opens the panel Agent as a minimizable mobile floating window", () => {
    renderRail();

    const floatButton = screen.getByRole("button", {
      name: "workspace.utility.agentFloat",
    });
    expect(floatButton.className).toContain("fixed");
    expect(floatButton.className).toContain("right-0");

    fireEvent.click(floatButton);

    const dialog = screen.getByRole("dialog", {
      name: "workspace.utility.agentChat",
    });
    expect(dialog.className).toContain("fixed");
    expect(screen.getByTestId("panel-agent-panel").textContent).toContain(
      "embedded agent panel",
    );

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
  });
});
