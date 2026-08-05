import { describe, it, expect, vi, beforeEach } from "vitest";

const createMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../../database/repositories/factory.js", () => ({
  createCurrentAuditLogRepository: vi.fn(() => ({
    create: createMock,
  })),
}));

import {
  getAuditActorContext,
  getRequestMeta,
  logAudit,
  logAuditOrThrow,
} from "../../utils/audit-logger.js";

describe("logAudit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createMock.mockResolvedValue(undefined);
  });

  it("inserts an audit log entry with all required fields", async () => {
    const params = {
      userId: "user-1",
      username: "alice",
      action: "create_host",
      resourceType: "host",
      resourceId: "42",
      resourceName: "my-server",
      ipAddress: "1.2.3.4",
      userAgent: "Mozilla/5.0",
      success: true,
    };

    await logAudit(params);

    expect(createMock).toHaveBeenCalledOnce();
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        username: "alice",
        action: "create_host",
        resourceType: "host",
        resourceId: "42",
        resourceName: "my-server",
        success: true,
      }),
    );
  });

  it("does not throw when insert fails", async () => {
    createMock.mockRejectedValue(new Error("db error"));

    await expect(
      logAudit({
        userId: "u",
        username: "u",
        action: "x",
        resourceType: "y",
        success: false,
      }),
    ).resolves.toBeUndefined();
  });

  it("allows critical callers to receive audit failures", async () => {
    createMock.mockRejectedValue(new Error("db error"));

    await expect(
      logAuditOrThrow({
        userId: "u",
        username: "u",
        action: "approve_agent_device",
        resourceType: "agent_device",
        success: true,
      }),
    ).rejects.toThrow("db error");
  });
});

describe("getRequestMeta", () => {
  it("使用 Express 校验后的客户端地址，不直接信任转发头", () => {
    const req = {
      headers: {
        "x-forwarded-for": "10.0.0.1, 10.0.0.2",
        "user-agent": "TestAgent/1.0",
      },
      ip: "10.0.0.2",
    };
    const meta = getRequestMeta(req as never);
    expect(meta.ipAddress).toBe("10.0.0.2");
    expect(meta.userAgent).toBe("TestAgent/1.0");
  });

  it("falls back to req.ip when no forwarded header", () => {
    const req = {
      headers: { "user-agent": "Bot/2" },
      ip: "192.168.1.1",
    };
    const meta = getRequestMeta(req as never);
    expect(meta.ipAddress).toBe("192.168.1.1");
  });
});

describe("getAuditActorContext", () => {
  it("管理员代操作时保留真实操作者和数据所有者", () => {
    const context = getAuditActorContext(
      { actingAdminUserId: "admin-1" } as never,
      "target-1",
    );

    expect(context).toEqual({
      actorUserId: "admin-1",
      dataOwnerDetails: JSON.stringify({ dataOwnerUserId: "target-1" }),
    });
  });

  it("普通请求仍归因给数据所有者", () => {
    expect(getAuditActorContext({} as never, "user-1")).toEqual({
      actorUserId: "user-1",
    });
  });
});
