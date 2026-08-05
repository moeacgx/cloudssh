import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Host } from "@/types/ui-types";

const mainAxios = vi.hoisted(() => ({
  getHostAccess: vi.fn(),
  shareHost: vi.fn(),
  shareFolder: vi.fn(),
  updateHostAccess: vi.fn(),
  revokeHostAccess: vi.fn(),
  getUserList: vi.fn(),
  getRoles: vi.fn(),
}));
const workspaceApi = vi.hoisted(() => ({
  associateWorkspaceProjectHost: vi.fn(),
}));
const notifications = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));
const workspace = vi.hoisted(() => ({
  activeProject: {
    id: "source",
    name: "当前项目",
    role: "project_admin",
    hostIds: [42],
  },
  projects: [
    {
      id: "source",
      name: "当前项目",
      role: "project_admin",
      hostIds: [42],
    },
    {
      id: "target-a",
      name: "目标项目 A",
      role: "project_admin",
      hostIds: [],
    },
    {
      id: "target-b",
      name: "目标项目 B",
      role: "team_admin",
      hostIds: [],
    },
    {
      id: "already-linked",
      name: "已关联项目",
      role: "project_admin",
      hostIds: [42],
    },
    {
      id: "read-only",
      name: "只读项目",
      role: "viewer",
      hostIds: [],
    },
  ],
}));

vi.mock("@/main-axios", () => mainAxios);
vi.mock("@/api/workspace-api", () => workspaceApi);
vi.mock("@/workspace/WorkspaceContext", () => ({
  useWorkspace: () => workspace,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}:${options.count}`,
  }),
}));
vi.mock("sonner", () => ({ toast: notifications }));

import { HostShareModal } from "../../sidebar/HostShareModal";

const host = {
  id: 42,
  name: "生产服务器",
} as Host;

beforeEach(() => {
  vi.clearAllMocks();
  mainAxios.getHostAccess.mockResolvedValue({ accessList: [] });
  mainAxios.getUserList.mockResolvedValue({ users: [] });
  mainAxios.getRoles.mockResolvedValue({ roles: [] });
  workspaceApi.associateWorkspaceProjectHost.mockResolvedValue({});
});

afterEach(cleanup);

describe("HostShareModal 项目共享", () => {
  it("只列出可管理且尚未关联主机的其他项目", async () => {
    render(<HostShareModal open onClose={vi.fn()} host={host} folder={null} />);

    fireEvent.click(
      screen.getByRole("button", { name: "hosts.sharing.projectsTab" }),
    );

    await waitFor(() => expect(mainAxios.getRoles).toHaveBeenCalled());

    expect(screen.getByText("目标项目 A")).toBeTruthy();
    expect(screen.getByText("目标项目 B")).toBeTruthy();
    expect(screen.queryByText("当前项目")).toBeNull();
    expect(screen.queryByText("已关联项目")).toBeNull();
    expect(screen.queryByText("只读项目")).toBeNull();
  });

  it("可一次关联多个项目，并通过统一事件刷新资产", async () => {
    const dispatch = vi.spyOn(window, "dispatchEvent");
    render(<HostShareModal open onClose={vi.fn()} host={host} folder={null} />);
    fireEvent.click(
      screen.getByRole("button", { name: "hosts.sharing.projectsTab" }),
    );
    fireEvent.click(screen.getByText("目标项目 A"));
    fireEvent.click(screen.getByText("目标项目 B"));
    fireEvent.click(
      screen.getByRole("button", {
        name: "hosts.sharing.shareWithCount:2",
      }),
    );

    await waitFor(() =>
      expect(workspaceApi.associateWorkspaceProjectHost).toHaveBeenCalledTimes(
        2,
      ),
    );
    expect(workspaceApi.associateWorkspaceProjectHost).toHaveBeenCalledWith(
      "target-a",
      42,
    );
    expect(workspaceApi.associateWorkspaceProjectHost).toHaveBeenCalledWith(
      "target-b",
      42,
    );
    expect(notifications.success).toHaveBeenCalledWith(
      "hosts.sharing.projectShareSuccess:2",
    );
    expect(
      dispatch.mock.calls.some(
        ([event]) => event.type === "termix:hosts-changed",
      ),
    ).toBe(true);
    dispatch.mockRestore();
  });

  it("部分项目失败时分别报告成功数和失败数", async () => {
    workspaceApi.associateWorkspaceProjectHost
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("forbidden"));
    render(<HostShareModal open onClose={vi.fn()} host={host} folder={null} />);
    fireEvent.click(
      screen.getByRole("button", { name: "hosts.sharing.projectsTab" }),
    );
    fireEvent.click(screen.getByText("目标项目 A"));
    fireEvent.click(screen.getByText("目标项目 B"));
    fireEvent.click(
      screen.getByRole("button", {
        name: "hosts.sharing.shareWithCount:2",
      }),
    );

    await waitFor(() =>
      expect(notifications.success).toHaveBeenCalledWith(
        "hosts.sharing.projectShareSuccess:1",
      ),
    );
    expect(notifications.error).toHaveBeenCalledWith(
      "hosts.sharing.projectSharePartial:1",
    );
  });

  it("全部项目失败时不触发资产刷新", async () => {
    workspaceApi.associateWorkspaceProjectHost.mockRejectedValue(
      new Error("forbidden"),
    );
    const dispatch = vi.spyOn(window, "dispatchEvent");
    render(<HostShareModal open onClose={vi.fn()} host={host} folder={null} />);
    fireEvent.click(
      screen.getByRole("button", { name: "hosts.sharing.projectsTab" }),
    );
    fireEvent.click(screen.getByText("目标项目 A"));
    fireEvent.click(
      screen.getByRole("button", {
        name: "hosts.sharing.shareWithCount:1",
      }),
    );

    await waitFor(() =>
      expect(notifications.error).toHaveBeenCalledWith(
        "hosts.sharing.projectShareFailed",
      ),
    );
    expect(
      dispatch.mock.calls.some(
        ([event]) => event.type === "termix:hosts-changed",
      ),
    ).toBe(false);
    dispatch.mockRestore();
  });

  it("文件夹共享不提供跨项目入口", async () => {
    render(
      <HostShareModal open onClose={vi.fn()} host={null} folder="生产环境" />,
    );
    expect(
      screen.queryByRole("button", { name: "hosts.sharing.projectsTab" }),
    ).toBeNull();
    await waitFor(() => expect(mainAxios.getRoles).toHaveBeenCalled());
  });
});
