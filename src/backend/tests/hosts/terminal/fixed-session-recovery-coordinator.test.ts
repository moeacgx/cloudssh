import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FIXED_SESSION_RECOVERY_WAIT_TIMEOUT_MS,
  FixedSessionRecoveryCoordinator,
} from "../../../hosts/terminal/fixed-session-recovery-coordinator.js";

describe("固定窗口恢复协调器", () => {
  it("同一窗口只允许一个恢复者，等待者在恢复完成后继续", async () => {
    const coordinator = new FixedSessionRecoveryCoordinator();
    expect(coordinator.begin("session-1", "user-1")).toBe(true);
    expect(coordinator.begin("session-1", "user-1")).toBe(false);

    const resumed = vi.fn();
    const waiting = coordinator.wait("session-1", "user-1").then((result) => {
      resumed();
      return result;
    });
    await Promise.resolve();
    expect(resumed).not.toHaveBeenCalled();

    coordinator.finish("session-1", "user-1");
    await expect(waiting).resolves.toBe("completed");
    expect(resumed).toHaveBeenCalledOnce();
    expect(coordinator.begin("session-1", "user-1")).toBe(true);
  });

  it("其他用户不能等待或释放不属于自己的恢复锁", async () => {
    const coordinator = new FixedSessionRecoveryCoordinator();
    expect(coordinator.begin("session-1", "user-1")).toBe(true);

    await expect(coordinator.wait("session-1", "user-2")).resolves.toBe(
      "not-waiting",
    );
    coordinator.finish("session-1", "user-2");
    expect(coordinator.begin("session-1", "user-1")).toBe(false);

    coordinator.finish("session-1", "user-1");
    expect(coordinator.begin("session-1", "user-1")).toBe(true);
  });

  it("等待超过默认期限后返回可判定的超时结果且不释放恢复锁", async () => {
    vi.useFakeTimers();
    try {
      const coordinator = new FixedSessionRecoveryCoordinator();
      expect(coordinator.begin("session-1", "user-1")).toBe(true);

      const waiting = coordinator.wait("session-1", "user-1");
      const settled = vi.fn();
      void waiting.then(settled);

      await vi.advanceTimersByTimeAsync(
        DEFAULT_FIXED_SESSION_RECOVERY_WAIT_TIMEOUT_MS - 1,
      );
      expect(settled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await expect(waiting).resolves.toBe("timed-out");
      expect(settled).toHaveBeenCalledWith("timed-out");

      expect(coordinator.begin("session-1", "user-1")).toBe(false);
      coordinator.finish("session-1", "user-1");
      expect(coordinator.begin("session-1", "user-1")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("恢复完成后清除等待计时器", async () => {
    vi.useFakeTimers();
    try {
      const coordinator = new FixedSessionRecoveryCoordinator();
      expect(coordinator.begin("session-1", "user-1")).toBe(true);

      const waiting = coordinator.wait("session-1", "user-1", 1_000);
      expect(vi.getTimerCount()).toBe(1);

      coordinator.finish("session-1", "user-1");
      await expect(waiting).resolves.toBe("completed");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    "拒绝无效等待期限 %s",
    async (timeoutMs) => {
      const coordinator = new FixedSessionRecoveryCoordinator();
      expect(coordinator.begin("session-1", "user-1")).toBe(true);

      await expect(
        coordinator.wait("session-1", "user-1", timeoutMs),
      ).rejects.toThrow(RangeError);
    },
  );
});
