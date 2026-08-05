import { authLogger } from "../../utils/logger.js";
import { sessionManager } from "../../hosts/terminal/session-manager.js";
import { terminalSessionLifecycleCoordinator } from "../../hosts/terminal/session-lifecycle-coordinator.js";
import {
  createCurrentUserDataLifecycleRepository,
  createCurrentWebTerminalSessionRepository,
} from "../repositories/factory.js";
export {
  UserMergeHasOwnedDataError,
  UserOwnsSharedResourcesError,
} from "../repositories/user-data-lifecycle-repository.js";

export const USER_HAS_PINNED_TERMINALS_CODE =
  "USER_HAS_PINNED_TERMINALS" as const;
export const USER_HAS_ACTIVE_TERMINALS_CODE =
  "USER_HAS_ACTIVE_TERMINALS" as const;

export class UserHasPinnedTerminalsError extends Error {
  readonly code = USER_HAS_PINNED_TERMINALS_CODE;

  constructor(readonly count: number) {
    super(
      "User still has pinned terminal windows. Close them before deleting or merging the account.",
    );
    this.name = "UserHasPinnedTerminalsError";
  }
}

export class UserHasActiveTerminalsError extends Error {
  readonly code = USER_HAS_ACTIVE_TERMINALS_CODE;

  constructor(readonly count: number) {
    super(
      "User still has active or disconnect-retained terminal sessions. Close them before deleting, merging, or wiping the account.",
    );
    this.name = "UserHasActiveTerminalsError";
  }
}

type PinnedTerminalLookup = Pick<
  ReturnType<typeof createCurrentWebTerminalSessionRepository>,
  "listOwned"
>;

export async function assertUserHasNoPinnedTerminalSessions(
  userId: string,
  repository: PinnedTerminalLookup = createCurrentWebTerminalSessionRepository(),
): Promise<void> {
  const pinnedSessions = await repository.listOwned(userId);
  if (pinnedSessions.length > 0) {
    throw new UserHasPinnedTerminalsError(pinnedSessions.length);
  }
}

export function assertUserHasNoActiveTerminalSessions(
  userId: string,
  findSessions: typeof sessionManager.findSessions = (filter) =>
    sessionManager.findSessions(filter),
): void {
  const activeSessions = findSessions({ userId });
  if (activeSessions.length > 0) {
    throw new UserHasActiveTerminalsError(activeSessions.length);
  }
}

export async function assertUserHasNoTerminalSessions(
  userId: string,
  repository: PinnedTerminalLookup = createCurrentWebTerminalSessionRepository(),
  findSessions: typeof sessionManager.findSessions = (filter) =>
    sessionManager.findSessions(filter),
): Promise<void> {
  assertUserHasNoActiveTerminalSessions(userId, findSessions);
  await assertUserHasNoPinnedTerminalSessions(userId, repository);
}

export async function runUserTerminalDestructiveOperation<T>(
  userId: string,
  operation: () => T | Promise<T>,
  retireUser = false,
): Promise<T> {
  return terminalSessionLifecycleCoordinator.runDestructiveOperation(
    { userIds: [userId] },
    async () => {
      await assertUserHasNoTerminalSessions(userId);
      const result = await operation();
      if (retireUser) {
        terminalSessionLifecycleCoordinator.retire({ userIds: [userId] });
      }
      return result;
    },
  );
}

export async function deleteUserAndRelatedData(userId: string): Promise<void> {
  return runUserTerminalDestructiveOperation(
    userId,
    async () => {
      await deleteUserAndRelatedDataAfterTerminalCheck(userId);
    },
    true,
  );
}

async function deleteUserAndRelatedDataAfterTerminalCheck(
  userId: string,
): Promise<void> {
  try {
    const deleted =
      await createCurrentUserDataLifecycleRepository().deleteUserAndRelatedData(
        userId,
      );
    if (!deleted) throw new Error("User not found");
    const { UserKeyManager } = await import("../../utils/user-keys.js");
    UserKeyManager.getInstance().invalidate(userId);

    authLogger.success("User and all related data deleted successfully", {
      operation: "delete_user_and_related_data_complete",
      userId,
    });
  } catch (error) {
    authLogger.error("Failed to delete user and related data", error, {
      operation: "delete_user_and_related_data_failed",
      userId,
    });
    throw error;
  }
}

export async function mergeOidcUserIntoPasswordUser(
  sourceUserId: string,
  targetUserId: string,
): Promise<void> {
  return runUserTerminalDestructiveOperation(
    sourceUserId,
    async () => {
      try {
        await createCurrentUserDataLifecycleRepository().mergeOidcUserIntoPasswordUser(
          sourceUserId,
          targetUserId,
        );
        const { UserKeyManager } = await import("../../utils/user-keys.js");
        UserKeyManager.getInstance().invalidate(sourceUserId);
      } catch (error) {
        authLogger.error(
          "Failed to merge OIDC user into password user",
          error,
          {
            operation: "merge_oidc_user_transaction_failed",
            sourceUserId,
            targetUserId,
          },
        );
        throw error;
      }
    },
    true,
  );
}
