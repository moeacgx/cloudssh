interface FixedSessionRecoveryLock {
  userId: string;
  completed: Promise<void>;
  release: () => void;
}

export const DEFAULT_FIXED_SESSION_RECOVERY_WAIT_TIMEOUT_MS = 30_000;

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type FixedSessionRecoveryWaitResult =
  | "completed"
  | "timed-out"
  | "not-waiting";

export class FixedSessionRecoveryCoordinator {
  private readonly locks = new Map<string, FixedSessionRecoveryLock>();

  begin(sessionId: string, userId: string): boolean {
    if (this.locks.has(sessionId)) return false;

    let release!: () => void;
    const completed = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(sessionId, { userId, completed, release });
    return true;
  }

  finish(sessionId: string, userId: string): void {
    const lock = this.locks.get(sessionId);
    if (!lock || lock.userId !== userId) return;

    this.locks.delete(sessionId);
    lock.release();
  }

  async wait(
    sessionId: string,
    userId: string,
    timeoutMs = DEFAULT_FIXED_SESSION_RECOVERY_WAIT_TIMEOUT_MS,
  ): Promise<FixedSessionRecoveryWaitResult> {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > MAX_TIMER_DELAY_MS
    ) {
      throw new RangeError(
        "Fixed session recovery wait timeout must be a positive safe integer within the timer range",
      );
    }

    const lock = this.locks.get(sessionId);
    if (!lock || lock.userId !== userId) return "not-waiting";

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race<FixedSessionRecoveryWaitResult>([
        lock.completed.then(() => "completed"),
        new Promise<FixedSessionRecoveryWaitResult>((resolve) => {
          timeout = setTimeout(() => resolve("timed-out"), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}

export const fixedSessionRecoveryCoordinator =
  new FixedSessionRecoveryCoordinator();
