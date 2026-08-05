import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  post: vi.fn(),
}));
const errorHandling = vi.hoisted(() => ({
  handleApiError: vi.fn((error: unknown) => error),
}));

vi.mock("@/main-axios", () => ({
  authApi: api,
  handleApiError: errorHandling.handleApiError,
}));

import {
  getUpdateHistory,
  getUpdateStatus,
  rollbackCloudsshUpdate,
  setCloudsshUpdateMode,
  startCloudsshUpdate,
} from "@/api/update-api";

describe("CloudSSH 在线更新 API", () => {
  beforeEach(() => vi.clearAllMocks());

  it("normalizes legacy status responses without updater metadata", async () => {
    api.get.mockResolvedValueOnce({
      data: {
        currentVersion: "2.6.0-cloudssh.28",
        latestVersion: "2.6.0-cloudssh.29",
        status: "update_available",
      },
    });

    await expect(getUpdateStatus()).resolves.toMatchObject({
      currentVersion: "2.6.0-cloudssh.28",
      updater: {
        configured: false,
        enabled: false,
        reachable: false,
        version: null,
        canRollback: false,
        message: null,
        mode: "auto",
        supportedModes: ["auto", "image", "binary"],
        activeSource: "image",
        restartRequired: false,
      },
      activeJob: null,
    });
  });

  it("normalizes partial updater metadata and malformed history", async () => {
    api.get
      .mockResolvedValueOnce({
        data: {
          updater: { configured: true, version: 42 },
          activeJob: { id: "job-1", phase: "unexpected", progress: 180 },
        },
      })
      .mockResolvedValueOnce({
        data: {
          jobs: [
            null,
            { id: "job-2", phase: "succeeded", progress: -5 },
            { phase: "failed" },
          ],
        },
      });

    const status = await getUpdateStatus();
    expect(status.updater).toEqual({
      configured: true,
      enabled: false,
      reachable: false,
      version: null,
      canRollback: false,
      message: null,
      mode: "auto",
      supportedModes: ["auto", "image", "binary"],
      activeSource: "image",
      restartRequired: false,
    });
    expect(status.activeJob).toMatchObject({
      id: "job-1",
      phase: "failed",
      progress: 100,
    });

    await expect(getUpdateHistory()).resolves.toMatchObject({
      jobs: [{ id: "job-2", phase: "succeeded", progress: 0 }],
    });
  });

  it("persists the selected in-container update mode", async () => {
    api.put.mockResolvedValueOnce({
      data: {
        mode: "binary",
        supportedModes: ["auto", "image", "binary"],
        activeSource: "image",
        restartRequired: true,
      },
    });

    await expect(setCloudsshUpdateMode("binary")).resolves.toEqual({
      mode: "binary",
      supportedModes: ["auto", "image", "binary"],
      activeSource: "image",
      restartRequired: true,
    });
    expect(api.put).toHaveBeenCalledWith("/admin/updates/mode", {
      mode: "binary",
    });
  });

  it.each([
    [
      "更新",
      () => startCloudsshUpdate("2.6.0-cloudssh.17", "update:12345678"),
      "start CloudSSH update",
    ],
    [
      "回退",
      () => rollbackCloudsshUpdate("rollback:12345678"),
      "rollback CloudSSH update",
    ],
  ])("%s失败时保留服务端 MFA 二次验证原因", async (_label, run, operation) => {
    const responseError = new Error("MFA required");
    api.post.mockRejectedValueOnce(responseError);

    await expect(run()).rejects.toBe(responseError);
    expect(errorHandling.handleApiError).toHaveBeenCalledWith(
      responseError,
      operation,
      { preserveAuthErrorMessage: true },
    );
  });
});
