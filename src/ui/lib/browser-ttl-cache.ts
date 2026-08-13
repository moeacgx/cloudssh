const CACHE_PREFIX = "cloudssh.browserCache.";

type BrowserTtlEnvelope<T> = {
  expiresAt: number;
  value: T;
};

function getCacheStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function storageKey(key: string): string {
  return `${CACHE_PREFIX}${key}`;
}

export function readBrowserTtlCache<T>(key: string): T | null {
  const storage = getCacheStorage();
  if (!storage) return null;

  try {
    const raw = storage.getItem(storageKey(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BrowserTtlEnvelope<T>;
    if (!Number.isFinite(parsed.expiresAt) || parsed.expiresAt <= Date.now()) {
      storage.removeItem(storageKey(key));
      return null;
    }
    return parsed.value;
  } catch {
    storage.removeItem(storageKey(key));
    return null;
  }
}

export function writeBrowserTtlCache<T>(
  key: string,
  value: T,
  ttlMs: number,
): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
  const storage = getCacheStorage();
  if (!storage) return;

  try {
    storage.setItem(
      storageKey(key),
      JSON.stringify({ expiresAt: Date.now() + ttlMs, value }),
    );
  } catch {
    // Cache writes must never block the API response path.
  }
}

export function clearBrowserTtlCache(key: string): void {
  const storage = getCacheStorage();
  if (!storage) return;

  try {
    storage.removeItem(storageKey(key));
  } catch {
    // Cache invalidation is best-effort.
  }
}

export function clearBrowserTtlCachesByPrefix(keyPrefix: string): void {
  const storage = getCacheStorage();
  if (!storage) return;

  const storageKeyPrefix = storageKey(keyPrefix);
  try {
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key?.startsWith(storageKeyPrefix)) storage.removeItem(key);
    }
  } catch {
    // Cache invalidation is best-effort.
  }
}

export function clearAllBrowserTtlCaches(): void {
  const storage = getCacheStorage();
  if (!storage) return;

  try {
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key?.startsWith(CACHE_PREFIX)) storage.removeItem(key);
    }
  } catch {
    // Cache invalidation is best-effort.
  }
}
