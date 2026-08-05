import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  pinnedSessions: [{ id: "fixed-window" }] as Array<{ id: string }>,
  activeSessions: [] as Array<{ id: string }>,
  destructiveCalls: [] as string[],
}));

vi.mock("../../../hosts/terminal/session-manager.js", () => ({
  sessionManager: {
    findSessions: () => state.activeSessions,
  },
}));

vi.mock("../../../hosts/terminal/session-lifecycle-coordinator.js", () => ({
  terminalSessionLifecycleCoordinator: {
    runDestructiveOperation: async (
      _scope: unknown,
      operation: () => unknown,
    ) => operation(),
    retire: vi.fn(),
  },
}));

vi.mock("../../../utils/logger.js", () => ({
  authLogger: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("../../../database/repositories/factory.js", () => ({
  createCurrentWebTerminalSessionRepository: () => ({
    listOwned: async () => state.pinnedSessions,
  }),
  createCurrentUserDataLifecycleRepository: () => ({
    deleteUserAndRelatedData: async () => {
      state.destructiveCalls.push("user-lifecycle");
      return true;
    },
  }),
}));

const {
  assertUserHasNoActiveTerminalSessions,
  assertUserHasNoPinnedTerminalSessions,
  deleteUserAndRelatedData,
  UserHasActiveTerminalsError,
  UserHasPinnedTerminalsError,
} = await import("../../../database/routes/delete-user-data.js");

beforeEach(() => {
  state.pinnedSessions = [{ id: "fixed-window" }];
  state.activeSessions = [];
  state.destructiveCalls = [];
});

describe("用户固定窗口删除保护", () => {
  it("返回固定窗口数量和稳定错误码", async () => {
    const operation = assertUserHasNoPinnedTerminalSessions("user-1");

    await expect(operation).rejects.toMatchObject({
      name: "UserHasPinnedTerminalsError",
      code: "USER_HAS_PINNED_TERMINALS",
      count: 1,
    });
    await expect(operation).rejects.toBeInstanceOf(UserHasPinnedTerminalsError);
  });

  it("在执行任何用户数据删除前拒绝操作", async () => {
    await expect(deleteUserAndRelatedData("user-1")).rejects.toBeInstanceOf(
      UserHasPinnedTerminalsError,
    );
    expect(state.destructiveCalls).toEqual([]);
  });

  it("普通活动或断线保留会话也会阻止删除", async () => {
    state.pinnedSessions = [];
    state.activeSessions = [{ id: "retained-window" }];

    expect(() => assertUserHasNoActiveTerminalSessions("user-1")).toThrow(
      UserHasActiveTerminalsError,
    );
    await expect(deleteUserAndRelatedData("user-1")).rejects.toMatchObject({
      code: "USER_HAS_ACTIVE_TERMINALS",
      count: 1,
    });
    expect(state.destructiveCalls).toEqual([]);
  });
});
