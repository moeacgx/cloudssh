import { beforeEach, describe, expect, it, vi } from "vitest";

const statsApi = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@/main-axios", () => ({
  statsApi,
  handleApiError: vi.fn(),
  getRemoteStatsApi: vi.fn(),
  isElectron: () => false,
}));

vi.mock("@/lib/hosts-request-cache", () => ({
  getCachedServerStatuses: (loader: () => unknown) => loader(),
}));

import {
  getMetricsHistory,
  managerGet,
  managerPost,
} from "@/api/host-metrics-api";
import {
  getAllServerStatuses,
  getServerMetricsById,
  getServerStatusById,
  startMetricsPolling,
  stopMetricsPolling,
} from "@/api/host-metrics-status-api";

describe("host metrics project context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statsApi.get.mockResolvedValue({ data: {}, status: 200 });
    statsApi.post.mockResolvedValue({ data: { success: true } });
  });

  it("sends projectHostId for status, metrics, and viewer lifecycle calls", async () => {
    await getServerStatusById(7, 11);
    await getServerMetricsById(7, 11);
    await startMetricsPolling(7, 11);
    await stopMetricsPolling(7, "viewer-1", 11, "totp-1");

    expect(statsApi.get).toHaveBeenNthCalledWith(1, "/status/7", {
      params: { projectHostId: 11 },
    });
    expect(statsApi.get).toHaveBeenNthCalledWith(
      2,
      "/metrics/7",
      expect.objectContaining({ params: { projectHostId: 11 } }),
    );
    expect(statsApi.post).toHaveBeenNthCalledWith(1, "/metrics/start/7", {
      projectHostId: 11,
    });
    expect(statsApi.post).toHaveBeenNthCalledWith(2, "/metrics/stop/7", {
      viewerSessionId: "viewer-1",
      projectHostId: 11,
      totpSessionId: "totp-1",
    });
  });
  it("keeps background status retries out of the global health toast path", async () => {
    vi.useFakeTimers();
    const timeoutError = Object.assign(new Error("status timeout"), {
      isAxiosError: true,
      code: "ETIMEDOUT",
    });
    statsApi.get.mockRejectedValue(timeoutError);

    const resultPromise = getAllServerStatuses();
    await vi.runAllTimersAsync();
    await expect(resultPromise).resolves.toEqual({});

    expect(statsApi.get).toHaveBeenCalledTimes(3);
    expect(
      statsApi.get.mock.calls.every(([, config]) => config.__silentRetry),
    ).toBe(true);
    vi.useRealTimers();
  });

  it("sends projectHostId for history and manager operations", async () => {
    await getMetricsHistory(7, { range: "24h" }, 11);
    await managerGet(7, "services", { limit: 20 }, 11);
    await managerPost(7, "services", { unit: "nginx" }, "action", 11);

    expect(statsApi.get).toHaveBeenNthCalledWith(1, "/metrics/history/7", {
      params: { range: "24h", projectHostId: 11 },
    });
    expect(statsApi.get).toHaveBeenNthCalledWith(
      2,
      "/host-metrics/managers/services/7",
      { params: { limit: 20, projectHostId: 11 } },
    );
    expect(statsApi.post).toHaveBeenCalledWith(
      "/host-metrics/managers/services/7/action",
      { unit: "nginx" },
      { params: { projectHostId: 11 } },
    );
  });
});
