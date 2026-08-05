import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthManager } from "../../../utils/auth-manager.js";

const calls = vi.hoisted(() => ({
  userUpdates: [] as Array<[string, Record<string, unknown>]>,
  preserveInputs: [] as Array<Record<string, unknown>>,
  wipeInputs: [] as Array<Record<string, unknown>>,
  preparedFor: [] as string[],
  invalidatedFor: [] as string[],
  pinnedSessions: [] as Array<{ id: string }>,
}));

vi.mock("../../../database/repositories/factory.js", () => ({
  createCurrentUserRepository: () => ({
    update: async (userId: string, update: Record<string, unknown>) => {
      calls.userUpdates.push([userId, update]);
      return { id: userId };
    },
  }),
  createCurrentSettingsRepository: () => ({}),
  createCurrentUserDataLifecycleRepository: () => ({
    resetPasswordPreservingData: async (input: Record<string, unknown>) => {
      calls.preserveInputs.push(input);
    },
    wipeEncryptedUserData: async (input: Record<string, unknown>) => {
      calls.wipeInputs.push(input);
    },
  }),
  createCurrentWebTerminalSessionRepository: () => ({
    listOwned: async () => calls.pinnedSessions,
  }),
}));

vi.mock("../../../utils/user-keys.js", () => ({
  UserKeyManager: {
    getInstance: () => ({
      prepareUserDEKRotation: (userId: string) => {
        calls.preparedFor.push(userId);
        return "wrapped-dek";
      },
      invalidate: (userId: string) => {
        calls.invalidatedFor.push(userId);
      },
    }),
  },
}));

import { resetUserPassword } from "../../../database/routes/user-password-reset-routes.js";

function fakeAuthManager(unlocked: boolean): AuthManager {
  return {
    isUserUnlocked: () => unlocked,
    logoutUser: vi.fn(async () => {}),
  } as unknown as AuthManager;
}

beforeEach(() => {
  calls.userUpdates = [];
  calls.preserveInputs = [];
  calls.wipeInputs = [];
  calls.preparedFor = [];
  calls.invalidatedFor = [];
  calls.pinnedSessions = [];
});

describe("resetUserPassword", () => {
  it("preserves data for users with a server-wrapped key", async () => {
    const outcome = await resetUserPassword(fakeAuthManager(true), {
      userId: "user-1",
      username: "alice",
      newPassword: "new-password",
      confirmDataWipe: false,
    });

    expect(outcome).toEqual({ status: "reset", dataWiped: false });
    expect(calls.preserveInputs).toHaveLength(1);
    expect(calls.preserveInputs[0]).toMatchObject({
      userId: "user-1",
      username: "alice",
    });
    expect(calls.preserveInputs[0]).toHaveProperty("passwordHash");
    expect(calls.userUpdates).toEqual([]);
    expect(calls.wipeInputs).toEqual([]);
    expect(calls.preparedFor).toEqual([]);
  });

  it("requires explicit consent before wiping an unmigrated user", async () => {
    const outcome = await resetUserPassword(fakeAuthManager(false), {
      userId: "user-1",
      username: "alice",
      newPassword: "new-password",
      confirmDataWipe: false,
    });

    expect(outcome).toEqual({ status: "wipe_confirmation_required" });
    expect(calls.userUpdates).toEqual([]);
    expect(calls.preserveInputs).toEqual([]);
    expect(calls.wipeInputs).toEqual([]);
  });

  it("wipes data and rotates the key when consent is given", async () => {
    const outcome = await resetUserPassword(fakeAuthManager(false), {
      userId: "user-1",
      username: "alice",
      newPassword: "new-password",
      confirmDataWipe: true,
    });

    expect(outcome).toEqual({ status: "reset", dataWiped: true });
    expect(calls.wipeInputs).toHaveLength(1);
    expect(calls.wipeInputs[0]).toMatchObject({
      userId: "user-1",
      wrappedDek: "wrapped-dek",
    });
    expect(calls.wipeInputs[0]).toHaveProperty("passwordHash");
    expect(calls.preparedFor).toEqual(["user-1"]);
    expect(calls.invalidatedFor).toEqual(["user-1"]);
  });

  it("refuses a confirmed data wipe while fixed windows still exist", async () => {
    calls.pinnedSessions = [{ id: "fixed-window" }];

    await expect(
      resetUserPassword(fakeAuthManager(false), {
        userId: "user-1",
        username: "alice",
        newPassword: "new-password",
        confirmDataWipe: true,
      }),
    ).rejects.toMatchObject({
      code: "USER_HAS_PINNED_TERMINALS",
      count: 1,
    });
    expect(calls.userUpdates).toEqual([]);
    expect(calls.preserveInputs).toEqual([]);
    expect(calls.wipeInputs).toEqual([]);
    expect(calls.preparedFor).toEqual([]);
  });
});
