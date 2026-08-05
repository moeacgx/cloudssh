import { describe, expect, it, vi } from "vitest";
import {
  checkSharedParticipantAccess,
  startSharedParticipantAccessHeartbeat,
  type ActiveSessionShare,
} from "../../../hosts/terminal/shared-participant-access.js";

const session = {
  id: "session-1",
  userId: "owner-1",
  hostId: 7,
  projectHostId: 17,
};

function activeShare(
  overrides: Partial<ActiveSessionShare> = {},
): ActiveSessionShare {
  return {
    id: "share-1",
    hostId: 7,
    ownerUserId: "owner-1",
    protocol: "ssh",
    sessionId: "session-1",
    shareType: "link",
    targetUserId: null,
    permissionLevel: "read-write",
    ...overrides,
  };
}

describe("共享参与者访问复查", () => {
  it("匿名分享持续有效且所有者仍有主机权限时允许访问", async () => {
    const canAccessHost = vi.fn().mockResolvedValue(true);
    const result = await checkSharedParticipantAccess(
      session,
      {
        userId: null,
        isOwner: false,
        joinedViaShareId: "share-1",
      },
      {
        findActiveShare: vi.fn().mockResolvedValue(activeShare()),
        canAccessHost,
        isSharingEnabled: vi.fn().mockResolvedValue(true),
      },
    );

    expect(result).toEqual({
      allowed: true,
      permissionLevel: "read-write",
    });
    expect(canAccessHost).toHaveBeenCalledOnce();
    expect(canAccessHost).toHaveBeenCalledWith("owner-1", 7, 17);
  });

  it("分享已撤销或所有者权限已撤销时拒绝访问", async () => {
    const missingShare = await checkSharedParticipantAccess(
      session,
      {
        userId: null,
        isOwner: false,
        joinedViaShareId: "share-1",
      },
      {
        findActiveShare: vi.fn().mockResolvedValue(null),
        canAccessHost: vi.fn().mockResolvedValue(true),
        isSharingEnabled: vi.fn().mockResolvedValue(true),
      },
    );
    expect(missingShare).toEqual({ allowed: false });

    const ownerRevoked = await checkSharedParticipantAccess(
      session,
      {
        userId: null,
        isOwner: false,
        joinedViaShareId: "share-1",
      },
      {
        findActiveShare: vi.fn().mockResolvedValue(activeShare()),
        canAccessHost: vi.fn().mockResolvedValue(false),
        isSharingEnabled: vi.fn().mockResolvedValue(true),
      },
    );
    expect(ownerRevoked).toEqual({ allowed: false });
  });

  it("指定用户分享同时复查目标用户权限并同步只读级别", async () => {
    const canAccessHost = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    const result = await checkSharedParticipantAccess(
      session,
      {
        userId: "member-1",
        isOwner: false,
        joinedViaShareId: "share-1",
      },
      {
        findActiveShare: vi.fn().mockResolvedValue(
          activeShare({
            shareType: "user",
            targetUserId: "member-1",
            permissionLevel: "read-only",
          }),
        ),
        canAccessHost,
        isSharingEnabled: vi.fn().mockResolvedValue(true),
      },
    );

    expect(result).toEqual({
      allowed: true,
      permissionLevel: "read-only",
    });
    expect(canAccessHost).toHaveBeenNthCalledWith(1, "owner-1", 7, 17);
    expect(canAccessHost).toHaveBeenNthCalledWith(2, "member-1", 7, 17);
  });

  it("指定用户自身主机权限撤销时拒绝继续共享", async () => {
    const result = await checkSharedParticipantAccess(
      session,
      {
        userId: "member-1",
        isOwner: false,
        joinedViaShareId: "share-1",
      },
      {
        findActiveShare: vi.fn().mockResolvedValue(
          activeShare({
            shareType: "user",
            targetUserId: "member-1",
          }),
        ),
        canAccessHost: vi
          .fn()
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(false),
        isSharingEnabled: vi.fn().mockResolvedValue(true),
      },
    );

    expect(result).toEqual({ allowed: false });
  });

  it("关闭全局或主机分享开关后拒绝继续访问", async () => {
    const result = await checkSharedParticipantAccess(
      session,
      {
        userId: null,
        isOwner: false,
        joinedViaShareId: "share-1",
      },
      {
        findActiveShare: vi.fn().mockResolvedValue(activeShare()),
        canAccessHost: vi.fn().mockResolvedValue(true),
        isSharingEnabled: vi.fn().mockResolvedValue(false),
      },
    );

    expect(result).toEqual({ allowed: false });
  });
});

describe("共享参与者周期检查", () => {
  it("权限失效后只触发一次清退并停止后续检查", async () => {
    vi.useFakeTimers();
    try {
      const verifyAccess = vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      const onAccessRevoked = vi.fn();
      const heartbeat = startSharedParticipantAccessHeartbeat({
        verifyAccess,
        onAccessRevoked,
        intervalMs: 1_000,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(onAccessRevoked).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onAccessRevoked).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(verifyAccess).toHaveBeenCalledTimes(2);
      heartbeat.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("复查异常时失败关闭", async () => {
    vi.useFakeTimers();
    try {
      const onAccessRevoked = vi.fn();
      const heartbeat = startSharedParticipantAccessHeartbeat({
        verifyAccess: vi.fn().mockRejectedValue(new Error("database down")),
        onAccessRevoked,
        intervalMs: 1_000,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(onAccessRevoked).toHaveBeenCalledOnce();
      heartbeat.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
