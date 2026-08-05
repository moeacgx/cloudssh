import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const updateApi = vi.hoisted(() => ({
  getUpdateStatus: vi.fn(),
  getUpdateHistory: vi.fn(),
  setCloudsshUpdateMode: vi.fn(),
  startCloudsshUpdate: vi.fn(),
  rollbackCloudsshUpdate: vi.fn(),
}));
const notifications = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));
const translations = vi.hoisted(() => ({
  t: (key: string) => key,
}));

vi.mock("@/api/update-api", () => updateApi);
vi.mock("react-i18next", () => ({
  useTranslation: () => translations,
}));
vi.mock("sonner", () => ({ toast: notifications }));

import { AdminUpdateSection } from "../../sidebar/AdminUpdateSection";

const idleStatus = {
  currentVersion: "2.6.0-cloudssh.16",
  latestVersion: "2.6.0-cloudssh.17",
  status: "update_available" as const,
  releaseUrl:
    "https://github.com/moeacgx/cloudssh/releases/tag/v2.6.0-cloudssh.17",
  releaseName: "CloudSSH 2.6.0-cloudssh.17",
  publishedAt: "2026-08-02T00:00:00.000Z",
  updater: {
    configured: false,
    enabled: false,
    reachable: false,
    version: null,
    canRollback: false,
    message: "未安装在线更新器；当前部署只能查看版本和发布记录",
    mode: "auto" as const,
    supportedModes: ["auto", "image", "binary"] as const,
    activeSource: "image" as const,
    restartRequired: false,
  },
  activeJob: null,
  checkedAt: "2026-08-02T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  updateApi.getUpdateStatus.mockResolvedValue(idleStatus);
  updateApi.getUpdateHistory.mockResolvedValue({ jobs: [] });
  updateApi.startCloudsshUpdate.mockResolvedValue({
    job: {
      id: "job-1",
      targetVersion: "2.6.0-cloudssh.17",
      phase: "checking",
      progress: 5,
      startedAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
    },
  });
  updateApi.setCloudsshUpdateMode.mockResolvedValue({
    mode: "binary",
    supportedModes: ["auto", "image", "binary"],
    activeSource: "image",
    restartRequired: true,
  });
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AdminUpdateSection", () => {
  it("renders safely when a legacy status omits updater metadata", async () => {
    updateApi.getUpdateStatus.mockResolvedValue({
      ...idleStatus,
      updater: undefined,
    });

    render(<AdminUpdateSection open onToggle={() => undefined} />);

    expect(await screen.findByText("admin.updaterNotInstalled")).toBeTruthy();
    expect(screen.getByText(/2\.6\.0-cloudssh\.16/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "admin.updateNow" }),
    ).toBeNull();
  });

  it("更新器未安装时只展示检查能力，不伪装成可一键更新", async () => {
    render(<AdminUpdateSection open onToggle={() => undefined} />);

    expect(await screen.findByText("admin.updaterNotInstalled")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "admin.updateNow" }),
    ).toBeNull();
    expect(updateApi.startCloudsshUpdate).not.toHaveBeenCalled();

    const checkButton = screen.getByRole("button", {
      name: "admin.checkUpdates",
    }) as HTMLButtonElement;
    await waitFor(() => expect(checkButton.disabled).toBe(false));
    fireEvent.click(checkButton);
    await waitFor(() =>
      expect(updateApi.getUpdateStatus).toHaveBeenCalledWith(true),
    );
  });

  it("确认后使用幂等键启动固定目标版本", async () => {
    updateApi.getUpdateStatus.mockResolvedValue({
      ...idleStatus,
      updater: {
        configured: true,
        enabled: true,
        reachable: true,
        version: "1.0.0",
        canRollback: false,
        message: null,
      },
    });
    render(<AdminUpdateSection open onToggle={() => undefined} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "admin.updateNow" }),
    );

    await waitFor(() =>
      expect(updateApi.startCloudsshUpdate).toHaveBeenCalledWith(
        "2.6.0-cloudssh.17",
        expect.stringMatching(/^cloudssh-update-/),
      ),
    );
    expect(window.confirm).toHaveBeenCalled();
    expect(notifications.success).toHaveBeenCalledWith("admin.updateStarted");
  });

  it("可以切换为容器内运行包更新模式", async () => {
    const initialModeStatus = {
      ...idleStatus,
      updater: {
        configured: true,
        enabled: true,
        reachable: true,
        version: "1.0.0",
        canRollback: false,
        message: null,
        mode: "auto",
        supportedModes: ["auto", "image", "binary"],
      },
    };
    updateApi.getUpdateStatus
      .mockResolvedValueOnce(initialModeStatus)
      .mockResolvedValue({
        ...initialModeStatus,
        updater: {
          ...initialModeStatus.updater,
          mode: "binary",
          restartRequired: true,
        },
      });

    render(<AdminUpdateSection open onToggle={() => undefined} />);
    fireEvent.click(await screen.findByRole("combobox"));
    fireEvent.click(await screen.findByText("admin.updateModeBinary"));

    await waitFor(() =>
      expect(updateApi.setCloudsshUpdateMode).toHaveBeenCalledWith("binary"),
    );
    expect(notifications.success).toHaveBeenCalledWith(
      "admin.updateModeChanged",
    );
    expect(
      await screen.findByText("admin.updateModeRestartRequired"),
    ).toBeTruthy();
  });

  it("其他失败原因不开放同版本重试", async () => {
    updateApi.getUpdateStatus.mockResolvedValue({
      ...idleStatus,
      currentVersion: "2.6.0-cloudssh.17",
      latestVersion: "2.6.0-cloudssh.17",
      status: "up_to_date",
      updater: {
        configured: true,
        enabled: true,
        reachable: true,
        version: "1.0.0",
        canRollback: true,
        message: null,
      },
      activeJob: {
        id: "job-health-check-failed",
        targetVersion: "2.6.0-cloudssh.17",
        phase: "failed",
        progress: 90,
        startedAt: "2026-08-02T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:01.000Z",
        errorCode: "health_check_failed",
      },
    });

    render(<AdminUpdateSection open onToggle={() => undefined} />);

    await screen.findByText("admin.updatePhaseFailed · 90%");
    expect(
      screen.queryByRole("button", { name: "admin.updateNow" }),
    ).toBeNull();
    expect(updateApi.startCloudsshUpdate).not.toHaveBeenCalled();
  });

  it("成功更新后仍可回退到上一个运行包", async () => {
    updateApi.getUpdateStatus.mockResolvedValue({
      ...idleStatus,
      status: "up_to_date",
      updater: {
        configured: true,
        enabled: true,
        reachable: true,
        version: "1.0.0",
        canRollback: true,
        message: null,
      },
    });
    updateApi.rollbackCloudsshUpdate.mockResolvedValue({
      job: {
        id: "rollback-1",
        targetVersion: "2.6.0-cloudssh.16",
        phase: "checking",
        progress: 5,
        startedAt: "2026-08-02T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:00.000Z",
      },
    });
    render(<AdminUpdateSection open onToggle={() => undefined} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "admin.rollbackLast" }),
    );

    await waitFor(() =>
      expect(updateApi.rollbackCloudsshUpdate).toHaveBeenCalledWith(
        expect.stringMatching(/^cloudssh-rollback-/),
      ),
    );
  });

  it("使用本地化阶段名称和百分比展示更新进度", async () => {
    updateApi.getUpdateStatus.mockResolvedValue({
      ...idleStatus,
      updater: {
        configured: true,
        enabled: true,
        reachable: true,
        version: "1.0.0",
        canRollback: false,
        message: null,
      },
      activeJob: {
        id: "job-running",
        targetVersion: "2.6.0-cloudssh.17",
        phase: "verifying",
        progress: 82,
        startedAt: "2026-08-02T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:01.000Z",
      },
    });

    render(<AdminUpdateSection open onToggle={() => undefined} />);

    expect(
      await screen.findByText("admin.updatePhaseVerifying · 82%"),
    ).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "82",
    );
  });

  it("服务重启期间轮询失败会安静重试，不重复弹出错误", async () => {
    let poll: (() => void) | undefined;
    vi.spyOn(window, "setInterval").mockImplementation((handler, delay) => {
      if (delay === 2000) poll = handler as () => void;
      return 1;
    });
    updateApi.getUpdateStatus.mockResolvedValue({
      ...idleStatus,
      updater: {
        configured: true,
        enabled: true,
        reachable: true,
        version: "1.0.0",
        canRollback: false,
        message: null,
      },
      activeJob: {
        id: "job-running",
        targetVersion: "2.6.0-cloudssh.17",
        phase: "restarting",
        progress: 65,
        startedAt: "2026-08-02T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:01.000Z",
      },
    });

    render(<AdminUpdateSection open onToggle={() => undefined} />);
    await screen.findByText("admin.updatePhaseRestarting · 65%");
    await act(async () => {
      await Promise.resolve();
    });
    expect(poll).toBeTypeOf("function");

    const runPoll = poll!;
    updateApi.getUpdateStatus.mockClear();
    updateApi.getUpdateStatus.mockRejectedValueOnce(
      new Error("service restarting"),
    );
    await act(async () => runPoll());
    await waitFor(() =>
      expect(updateApi.getUpdateStatus).toHaveBeenCalledTimes(1),
    );
    expect(notifications.error).not.toHaveBeenCalled();
  }, 10_000);

  it("区分更新器未安装与已配置但暂时不可用", async () => {
    updateApi.getUpdateStatus.mockResolvedValue({
      ...idleStatus,
      updater: {
        configured: true,
        enabled: false,
        reachable: false,
        version: null,
        canRollback: false,
        message: null,
      },
    });

    render(<AdminUpdateSection open onToggle={() => undefined} />);

    expect(await screen.findByText("admin.updaterUnavailable")).toBeTruthy();
    expect(screen.queryByText("admin.updaterNotInstalled")).toBeNull();
  });
});
