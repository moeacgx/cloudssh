import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dbHealthMonitor } from "@/lib/db-health-monitor";

const api = vi.hoisted(() => ({
  getSSHHosts: vi.fn(),
  getWorkspaceProjectServers: vi.fn(),
  getWorkspaceProjectFolders: vi.fn(),
}));
vi.mock("@/main-axios", () => ({ getSSHHosts: api.getSSHHosts }));
vi.mock("@/api/workspace-api", () => api);
import { useWorkspaceHosts } from "@/hooks/use-workspace-hosts";

const host = {
  id: 7,
  name: "原名",
  ip: "192.0.2.7",
  username: "root",
  port: 22,
  status: "unknown",
};
const association = {
  hostId: 7,
  projectHostId: 71,
  name: "项目主机",
  folder: "生产",
};

describe("项目主机加载", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbHealthMonitor.reset();
    api.getSSHHosts.mockResolvedValue([host]);
    api.getWorkspaceProjectServers.mockResolvedValue([association]);
    api.getWorkspaceProjectFolders.mockResolvedValue([
      { path: "空目录", color: "red" },
    ]);
  });

  it("主机配置无需等待在线状态，保留项目别名和空目录", async () => {
    api.getWorkspaceProjectServers.mockResolvedValue([
      { ...association, tags: ["项目标签"] },
    ]);
    api.getSSHHosts.mockImplementation((options) =>
      options?.includeStatus === false
        ? Promise.resolve([host])
        : new Promise(() => {}),
    );
    const { result } = renderHook(() => useWorkspaceHosts("project-1"));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.hosts[0].name).toBe("项目主机");
    expect(result.current.hosts[0].tags).toEqual(["项目标签"]);
    expect(result.current.projectHostIdsByHostId.get("7")).toBe(71);
    expect(
      result.current.hostTree?.children.map((child) => child.name),
    ).toEqual(["空目录", "生产"]);
  });

  it("首次失败不触发已加载标记，手工重试成功后才允许恢复标签", async () => {
    api.getWorkspaceProjectFolders.mockRejectedValueOnce(new Error("timeout"));
    const { result } = renderHook(() => useWorkspaceHosts("project-1"));
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.loaded).toBe(false);
    expect(result.current.hostTree).toBeNull();
    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.loaded).toBe(true);
    expect(result.current.error).toBe(false);
  });

  it("同项目刷新失败保留已加载树，恢复事件只补拉失败的数据", async () => {
    const { result } = renderHook(() => useWorkspaceHosts("project-1"));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => {
      dbHealthMonitor.reportDatabaseError({ code: "ERR_NETWORK" });
      dbHealthMonitor.reportDatabaseSuccess();
    });
    expect(api.getSSHHosts).toHaveBeenCalledTimes(1);
    api.getWorkspaceProjectFolders.mockRejectedValueOnce(new Error("timeout"));
    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.error).toBe(true);
    expect(result.current.hosts[0].name).toBe("项目主机");
    act(() => {
      dbHealthMonitor.reportDatabaseError({ code: "ERR_NETWORK" });
      dbHealthMonitor.reportDatabaseSuccess();
    });
    await waitFor(() => expect(result.current.error).toBe(false));
    expect(api.getSSHHosts).toHaveBeenCalledTimes(3);
  });

  it("项目切换立即隐藏旧树且忽略迟到响应", async () => {
    let resolveOld!: (hosts: (typeof association)[]) => void;
    api.getWorkspaceProjectServers.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const { result, rerender } = renderHook(({ id }) => useWorkspaceHosts(id), {
      initialProps: { id: "project-1" },
    });
    api.getWorkspaceProjectServers.mockResolvedValue([]);
    rerender({ id: "project-2" });
    expect(result.current.hostTree).toBeNull();
    expect(result.current.loaded).toBe(false);
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await act(async () => {
      resolveOld([association]);
    });
    expect(result.current.hosts).toEqual([]);
  });

  it("在途刷新合并，主机变更事件排队补查而不丢失", async () => {
    let resolveOld!: (hosts: (typeof association)[]) => void;
    api.getWorkspaceProjectServers.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const { result } = renderHook(() => useWorkspaceHosts("project-1"));
    act(() => {
      void result.current.reload();
      window.dispatchEvent(new Event("hosts:refresh"));
      window.dispatchEvent(new Event("ssh-hosts:changed"));
    });
    expect(api.getWorkspaceProjectServers).toHaveBeenCalledTimes(1);
    api.getWorkspaceProjectServers.mockResolvedValue([
      { ...association, name: "更新后的主机" },
    ]);
    await act(async () => {
      resolveOld([association]);
    });
    await waitFor(() =>
      expect(result.current.hosts[0]?.name).toBe("更新后的主机"),
    );
    expect(api.getWorkspaceProjectServers).toHaveBeenCalledTimes(2);
  });
});
