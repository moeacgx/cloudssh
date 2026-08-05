export type HostScopeKey = number | string;

class RequestQueue {
  private queues = new Map<HostScopeKey, Array<() => Promise<unknown>>>();
  private processing = new Set<HostScopeKey>();
  private requestTimeout = 60000;

  async queueRequest<T>(
    scopeKey: HostScopeKey,
    request: () => Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const wrappedRequest = async () => {
        try {
          const result = await Promise.race<T>([
            request(),
            new Promise<never>((_, rej) =>
              setTimeout(
                () =>
                  rej(
                    new Error(
                      `Request timeout after ${this.requestTimeout}ms for host scope ${scopeKey}`,
                    ),
                  ),
                this.requestTimeout,
              ),
            ),
          ]);
          resolve(result);
        } catch (error) {
          reject(error);
        }
      };

      const queue = this.queues.get(scopeKey) || [];
      queue.push(wrappedRequest);
      this.queues.set(scopeKey, queue);
      this.processQueue(scopeKey);
    });
  }

  private async processQueue(scopeKey: HostScopeKey): Promise<void> {
    if (this.processing.has(scopeKey)) return;

    this.processing.add(scopeKey);
    const queue = this.queues.get(scopeKey) || [];

    while (queue.length > 0) {
      const request = queue.shift();
      if (request) {
        try {
          await request();
        } catch {
          // expected
        }
      }
    }

    this.processing.delete(scopeKey);
    const currentQueue = this.queues.get(scopeKey);
    if (currentQueue && currentQueue.length > 0) {
      this.processQueue(scopeKey);
    }
  }
}

interface CachedMetrics {
  data: unknown;
  timestamp: number;
  scopeKey: HostScopeKey;
}

class MetricsCache {
  private cache = new Map<HostScopeKey, CachedMetrics>();
  private ttl = 30000;

  get(scopeKey: HostScopeKey): unknown | null {
    const cached = this.cache.get(scopeKey);
    if (cached && Date.now() - cached.timestamp < this.ttl) {
      return cached.data;
    }
    return null;
  }

  set(scopeKey: HostScopeKey, data: unknown): void {
    this.cache.set(scopeKey, {
      data,
      timestamp: Date.now(),
      scopeKey,
    });
  }

  clear(scopeKey?: HostScopeKey): void {
    if (scopeKey !== undefined) {
      this.cache.delete(scopeKey);
    } else {
      this.cache.clear();
    }
  }
}

interface AuthFailureRecord {
  count: number;
  lastFailure: number;
  reason: "TOTP" | "AUTH" | "TIMEOUT";
  permanent: boolean;
}

class AuthFailureTracker {
  private failures = new Map<HostScopeKey, AuthFailureRecord>();
  private maxRetries = 3;
  private backoffBase = 5000;

  recordFailure(
    scopeKey: HostScopeKey,
    reason: "TOTP" | "AUTH" | "TIMEOUT",
    permanent = false,
  ): void {
    const existing = this.failures.get(scopeKey);
    if (existing) {
      existing.count++;
      existing.lastFailure = Date.now();
      existing.reason = reason;
      if (permanent) existing.permanent = true;
    } else {
      this.failures.set(scopeKey, {
        count: 1,
        lastFailure: Date.now(),
        reason,
        permanent,
      });
    }
  }

  shouldSkip(scopeKey: HostScopeKey): boolean {
    const record = this.failures.get(scopeKey);
    if (!record) return false;

    if (record.reason === "TOTP" || record.permanent) {
      return true;
    }

    if (record.count >= this.maxRetries) {
      return true;
    }

    const backoffTime = this.backoffBase * Math.pow(2, record.count - 1);
    const timeSinceFailure = Date.now() - record.lastFailure;

    return timeSinceFailure < backoffTime;
  }

  getSkipReason(scopeKey: HostScopeKey): string | null {
    const record = this.failures.get(scopeKey);
    if (!record) return null;

    if (record.reason === "TOTP") {
      return "TOTP authentication required (metrics unavailable)";
    }

    if (record.permanent) {
      return "Authentication permanently failed";
    }

    if (record.count >= this.maxRetries) {
      return `Too many authentication failures (${record.count} attempts)`;
    }

    const backoffTime = this.backoffBase * Math.pow(2, record.count - 1);
    const timeSinceFailure = Date.now() - record.lastFailure;
    const remainingTime = Math.ceil((backoffTime - timeSinceFailure) / 1000);

    if (timeSinceFailure < backoffTime) {
      return `Retry in ${remainingTime}s (attempt ${record.count}/${this.maxRetries})`;
    }

    return null;
  }

  reset(scopeKey: HostScopeKey): void {
    this.failures.delete(scopeKey);
  }

  cleanup(): void {
    const maxAge = 60 * 60 * 1000;
    const now = Date.now();

    for (const [scopeKey, record] of this.failures.entries()) {
      if (!record.permanent && now - record.lastFailure > maxAge) {
        this.failures.delete(scopeKey);
      }
    }
  }
}

class PollingBackoff {
  private failures = new Map<
    HostScopeKey,
    { count: number; nextRetry: number }
  >();
  private baseDelay = 30000;
  private maxDelay = 600000;
  private maxRetries = 5;

  recordFailure(scopeKey: HostScopeKey): void {
    const existing = this.failures.get(scopeKey) || {
      count: 0,
      nextRetry: 0,
    };
    const delay = Math.min(
      this.baseDelay * Math.pow(2, existing.count),
      this.maxDelay,
    );
    this.failures.set(scopeKey, {
      count: existing.count + 1,
      nextRetry: Date.now() + delay,
    });
  }

  shouldSkip(scopeKey: HostScopeKey): boolean {
    const backoff = this.failures.get(scopeKey);
    if (!backoff) return false;

    if (backoff.count >= this.maxRetries) {
      return true;
    }

    return Date.now() < backoff.nextRetry;
  }

  getBackoffInfo(scopeKey: HostScopeKey): string | null {
    const backoff = this.failures.get(scopeKey);
    if (!backoff) return null;

    if (backoff.count >= this.maxRetries) {
      return `Max retries exceeded (${backoff.count} failures) - polling suspended`;
    }

    const remainingMs = backoff.nextRetry - Date.now();
    if (remainingMs > 0) {
      const remainingSec = Math.ceil(remainingMs / 1000);
      return `Retry in ${remainingSec}s (attempt ${backoff.count}/${this.maxRetries})`;
    }

    return null;
  }

  reset(scopeKey: HostScopeKey): void {
    this.failures.delete(scopeKey);
  }

  cleanup(): void {
    const maxAge = 60 * 60 * 1000;
    const now = Date.now();

    for (const [scopeKey, backoff] of this.failures.entries()) {
      if (backoff.count < this.maxRetries && now - backoff.nextRetry > maxAge) {
        this.failures.delete(scopeKey);
      }
    }
  }
}

/**
 * Limits how many async jobs run at once. Extra callers wait in FIFO order.
 * Used to stop host-metrics status/metrics polls from stampeding under load.
 */
export class ConcurrentLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number) {
    if (maxConcurrent < 1) {
      throw new Error("maxConcurrent must be >= 1");
    }
  }

  get activeCount(): number {
    return this.active;
  }

  get pendingCount(): number {
    return this.waiters.length;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }

    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.waiters.shift();
      if (next) next();
    }
  }
}

/** Short-lived host snapshots for polling — avoids decrypting host rows every tick. */
export class HostPollCache<THost extends { id: number } = { id: number }> {
  private cache = new Map<string, { host: THost; expiresAt: number }>();

  constructor(private readonly ttlMs = 30_000) {}

  get(hostId: number, userId: string): THost | null {
    const key = `${userId}:${hostId}`;
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.host;
  }

  set(hostId: number, userId: string, host: THost): void {
    this.cache.set(`${userId}:${hostId}`, {
      host,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  invalidate(hostId?: number): void {
    if (hostId === undefined) {
      this.cache.clear();
      return;
    }
    const suffix = `:${hostId}`;
    for (const key of this.cache.keys()) {
      if (key.endsWith(suffix)) this.cache.delete(key);
    }
  }
}

/** TCP status checks are cheap relative to SSH metrics collection. */
export const statusPollLimiter = new ConcurrentLimiter(20);
/** SSH metrics execs are expensive; keep concurrency tight. */
export const metricsPollLimiter = new ConcurrentLimiter(5);
export const hostPollCache = new HostPollCache(30_000);

export const requestQueue = new RequestQueue();
export const metricsCache = new MetricsCache();
export const authFailureTracker = new AuthFailureTracker();
export const pollingBackoff = new PollingBackoff();
