import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/workspace/WorkspaceContext", () => ({
  useWorkspace: () => ({ activeProject: { id: "project-1" } }),
}));
vi.mock("@/main-axios", () => ({
  getSSHHosts: vi.fn(async () => []),
  bulkImportSSHHosts: vi.fn(),
  importSSHConfigHosts: vi.fn(),
  exportAllSSHHosts: vi.fn(),
}));
vi.mock("@/sidebar/HostManager", () => ({ HostManager: () => null }));
vi.mock("@/sidebar/HostShareModal", () => ({ HostShareModal: () => null }));
vi.mock("@/components/proxmox/ProxmoxDiscoverDialog", () => ({
  ProxmoxDiscoverDialog: () => null,
}));
vi.mock("@/sidebar/SidebarTree", () => ({
  isFolder: (value: { children?: unknown[] }) => Array.isArray(value.children),
  SidebarTree: ({
    children,
    loading,
  }: {
    children: { name: string }[];
    loading: boolean;
  }) => (
    <div>
      {loading
        ? "正在加载"
        : children.length
          ? children.map((host) => host.name).join(",")
          : "暂无主机"}
    </div>
  ),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
import { HostsPanel } from "@/sidebar/HostsPanel";
import type { Host } from "@/types/ui-types";

describe("主机侧栏加载反馈", () => {
  beforeEach(() => localStorage.clear());
  it("首次失败展示重试而不显示暂无主机", async () => {
    const retry = vi.fn(async () => {});
    render(
      <HostsPanel
        onOpenTab={vi.fn()}
        onEditHost={vi.fn()}
        error
        onRetry={retry}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText("暂无主机")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain(
      "workspace.hostsLoadFailed",
    );
    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("刷新失败提示错误但保留已加载树", async () => {
    render(
      <HostsPanel
        onOpenTab={vi.fn()}
        onEditHost={vi.fn()}
        error
        onRetry={vi.fn(async () => {})}
        hostTree={{
          name: "root",
          children: [{ id: "7", name: "生产主机" } as Host],
        }}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("生产主机")).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});
