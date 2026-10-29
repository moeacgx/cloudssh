import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { SSHHost } from "@/types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      values ? `${key}: ${values.host}` : key,
  }),
}));

vi.mock("@/features/terminal/Terminal.tsx", () => ({
  Terminal: ({ hostConfig }: { hostConfig: SSHHost }) => (
    <div data-testid="terminal-host">{JSON.stringify(hostConfig)}</div>
  ),
}));

vi.mock(
  "@/features/terminal/command-history/CommandHistoryContext.tsx",
  () => ({
    CommandHistoryProvider: ({ children }: { children: React.ReactNode }) =>
      children,
  }),
);

vi.mock("@/features/file-manager/components/WindowManager.tsx", () => ({
  useWindowManager: () => ({
    closeWindow: vi.fn(),
    maximizeWindow: vi.fn(),
    focusWindow: vi.fn(),
    windows: [
      { id: "terminal", isMaximized: false, isMinimized: false, zIndex: 1 },
    ],
  }),
}));

import { TerminalWindow } from "@/features/file-manager/components/TerminalWindow";

afterEach(cleanup);

describe("终端浮窗主机标识", () => {
  it.each([23, 48])("为同名主机显示实体 ID %s，并保留连接配置", (id) => {
    const host = {
      id,
      name: "同名主机",
      ip: "192.0.2.1",
      projectHostId: 999,
    } as SSHHost;
    render(<TerminalWindow windowId="terminal" hostConfig={host} />);

    expect(screen.getByText(`#${id}`)).toHaveClass("shrink-0");
    expect(screen.queryByText("#999")).not.toBeInTheDocument();
    expect(screen.getByTestId("terminal-host").textContent).toBe(
      JSON.stringify(host),
    );
    expect(
      screen.getByText("terminal.terminalTitle: 同名主机"),
    ).toBeInTheDocument();
  });

  it("快速连接临时 ID 不作为实体主机 ID 展示", () => {
    const host = {
      id: "quick-connect-temporary",
      name: "临时主机",
    } as unknown as SSHHost;
    render(<TerminalWindow windowId="terminal" hostConfig={host} />);

    expect(screen.queryByText(/^#/)).not.toBeInTheDocument();
    expect(screen.getByTestId("terminal-host").textContent).toBe(
      JSON.stringify(host),
    );
  });
});
