import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
}));
const errorHandling = vi.hoisted(() => ({
  handleApiError: vi.fn((error: unknown) => error),
}));

vi.mock("@/main-axios", () => ({
  agentApi: api,
  handleApiError: errorHandling.handleApiError,
}));

import {
  approveAgentDevice,
  getAgentAdminAccess,
  resolveAgentDeviceCode,
  revokeAgentDevice,
  updateAgentDevice,
} from "@/api/agent-admin-api";

describe("agent device admin API", () => {
  beforeEach(() => vi.clearAllMocks());

  it("返回项目和设备所有者且没有 Token 字段", async () => {
    api.get.mockResolvedValue({
      data: {
        projects: [{ id: "project-1", name: "生产" }],
        devices: [
          {
            id: "device-1",
            name: "工作站",
            fingerprint: "abcd",
            status: "active",
            accessMode: "selected",
            projectIds: ["project-1"],
            scopes: ["sessions:read"],
            owner: {
              userId: "admin",
              username: "admin",
              isCurrentUser: true,
            },
          },
        ],
      },
    });
    const result = await getAgentAdminAccess();
    expect(api.get).toHaveBeenCalledWith("/agent/admin/v1/devices");
    expect(result.devices[0]).toMatchObject({
      id: "device-1",
      owner: {
        userId: "admin",
        username: "admin",
        isCurrentUser: true,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/token/i);
  });

  it("解析设备码并批准设备", async () => {
    api.post
      .mockResolvedValueOnce({ data: { request: { requestId: "request-1" } } })
      .mockResolvedValueOnce({ data: { device: { id: "device-1" } } });
    await resolveAgentDeviceCode("ABCD-EFGH");
    const input = {
      scopes: ["sessions:read"] as const,
      accessMode: "selected" as const,
      projectIds: ["project-1"],
      maxConcurrentSessions: 1,
      expiresAt: null,
    };
    await approveAgentDevice("request/1", {
      ...input,
      scopes: [...input.scopes],
    });
    expect(api.post).toHaveBeenNthCalledWith(
      1,
      "/agent/admin/v1/device-requests/resolve",
      { code: "ABCD-EFGH" },
    );
    expect(api.post).toHaveBeenNthCalledWith(
      2,
      "/agent/admin/v1/device-requests/request%2F1/approve",
      { ...input, scopes: [...input.scopes] },
    );
  });

  it("保留设备审批接口返回的 MFA 和权限原因", async () => {
    const responseError = new Error("MFA required");
    api.post.mockRejectedValueOnce(responseError);

    await expect(resolveAgentDeviceCode("ABCD-EFGH")).rejects.toBe(
      responseError,
    );
    expect(errorHandling.handleApiError).toHaveBeenCalledWith(
      responseError,
      "resolve agent device code",
      { preserveAuthErrorMessage: true },
    );
  });

  it("撤销设备不需要 Token 或服务账号", async () => {
    api.delete.mockResolvedValue({ status: 204 });
    await revokeAgentDevice("device/one");
    expect(api.delete).toHaveBeenCalledWith(
      "/agent/admin/v1/devices/device%2Fone",
    );
  });

  it("通过 PATCH 更新已授权设备", async () => {
    api.patch.mockResolvedValue({
      data: { device: { id: "device/one", name: "工作站 2" } },
    });
    const result = await updateAgentDevice("device/one", {
      name: "工作站 2",
      accessMode: "selected",
      projectIds: ["project-1"],
    });

    expect(api.patch).toHaveBeenCalledWith(
      "/agent/admin/v1/devices/device%2Fone",
      {
        name: "工作站 2",
        accessMode: "selected",
        projectIds: ["project-1"],
      },
    );
    expect(result).toMatchObject({ id: "device/one", name: "工作站 2" });
  });
});
