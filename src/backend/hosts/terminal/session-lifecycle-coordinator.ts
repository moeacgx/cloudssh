export interface TerminalLifecycleScope {
  hostIds?: readonly number[];
  projectHostIds?: readonly number[];
  userIds?: readonly string[];
}

export class TerminalLifecycleUnavailableError extends Error {
  readonly code = "TERMINAL_LIFECYCLE_UNAVAILABLE";

  constructor() {
    super("Terminal host lifecycle is changing; retry after it completes");
    this.name = "TerminalLifecycleUnavailableError";
  }
}

function positiveIds(values: readonly number[] | undefined): number[] {
  if (!values) return [];
  return [
    ...new Set(
      values.filter((value) => Number.isSafeInteger(value) && value > 0),
    ),
  ];
}

function scopeKeys(scope: TerminalLifecycleScope): string[] {
  const userIds = [
    ...new Set(
      (scope.userIds ?? []).filter(
        (value) =>
          typeof value === "string" && value.length > 0 && value.length <= 128,
      ),
    ),
  ];
  return [
    ...positiveIds(scope.hostIds).map((id) => `host:${id}`),
    ...positiveIds(scope.projectHostIds).map((id) => `project-host:${id}`),
    ...userIds.map((id) => `user:${id}`),
  ].sort();
}

/**
 * 串行化固定窗口写入与主机生命周期变更。
 *
 * 破坏性操作在排队时立即封锁对应目标，因此已经在 SSH 握手中的旧请求也不能在
 * 检查通过后补建会话。锁使用单进程队列；SQLite 事务继续负责数据库内的原子性。
 */
export class TerminalSessionLifecycleCoordinator {
  private queue: Promise<void> = Promise.resolve();
  private readonly pendingDestructive = new Map<string, number>();
  private readonly retired = new Set<string>();

  assertSessionCreationAllowed(scope: TerminalLifecycleScope): void {
    const keys = scopeKeys(scope);
    if (
      keys.some(
        (key) => this.retired.has(key) || this.pendingDestructive.has(key),
      )
    ) {
      throw new TerminalLifecycleUnavailableError();
    }
  }

  async runSessionMutation<T>(
    scope: TerminalLifecycleScope,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const keys = scopeKeys(scope);
    this.assertSessionCreationAllowed(scope);
    return this.enqueue(async () => {
      if (keys.some((key) => this.retired.has(key))) {
        throw new TerminalLifecycleUnavailableError();
      }
      return operation();
    });
  }

  async runDestructiveOperation<T>(
    scope: TerminalLifecycleScope,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const keys = scopeKeys(scope);
    for (const key of keys) {
      this.pendingDestructive.set(
        key,
        (this.pendingDestructive.get(key) ?? 0) + 1,
      );
    }

    try {
      return await this.enqueue(operation);
    } finally {
      for (const key of keys) {
        const remaining = (this.pendingDestructive.get(key) ?? 1) - 1;
        if (remaining <= 0) this.pendingDestructive.delete(key);
        else this.pendingDestructive.set(key, remaining);
      }
    }
  }

  retire(scope: TerminalLifecycleScope): void {
    for (const key of scopeKeys(scope)) this.retired.add(key);
  }

  private async enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queue = previous.then(
      () => gate,
      () => gate,
    );

    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export const terminalSessionLifecycleCoordinator =
  new TerminalSessionLifecycleCoordinator();
