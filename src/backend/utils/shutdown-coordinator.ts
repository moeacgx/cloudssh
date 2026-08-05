import type { Server } from "http";

export type ShutdownCleanup = () => void | Promise<void>;

export interface ShutdownCleanupFailure {
  name: string;
  error: unknown;
}

interface RegisteredCleanup {
  name: string;
  run: () => Promise<void>;
}

const DEFAULT_CLEANUP_TIMEOUT_MS = 10_000;

function makeIdempotent(cleanup: ShutdownCleanup): () => Promise<void> {
  let cleanupPromise: Promise<void> | null = null;

  return () => {
    if (!cleanupPromise) {
      cleanupPromise = Promise.resolve().then(cleanup);
    }
    return cleanupPromise;
  };
}

export class ShutdownCleanupRegistry {
  private readonly cleanups = new Map<string, RegisteredCleanup>();
  private cleanupPromise: Promise<ShutdownCleanupFailure[]> | null = null;

  constructor(private readonly cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS) {}

  register(name: string, cleanup: ShutdownCleanup): void {
    if (this.cleanupPromise) {
      throw new Error(
        "Cannot register shutdown cleanup after shutdown started",
      );
    }
    if (this.cleanups.has(name)) {
      throw new Error(`Shutdown cleanup already registered: ${name}`);
    }

    this.cleanups.set(name, { name, run: makeIdempotent(cleanup) });
  }

  runAll(): Promise<ShutdownCleanupFailure[]> {
    if (!this.cleanupPromise) {
      this.cleanupPromise = Promise.all(
        [...this.cleanups.values()].map((cleanup) =>
          this.runWithTimeout(cleanup),
        ),
      ).then((results) =>
        results.filter(
          (result): result is ShutdownCleanupFailure => result !== null,
        ),
      );
    }

    return this.cleanupPromise;
  }

  private async runWithTimeout(
    cleanup: RegisteredCleanup,
  ): Promise<ShutdownCleanupFailure | null> {
    let timeout: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        cleanup.run(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error(
                  `Shutdown cleanup timed out after ${this.cleanupTimeoutMs}ms`,
                ),
              ),
            this.cleanupTimeoutMs,
          );
        }),
      ]);
      return null;
    } catch (error) {
      return { name: cleanup.name, error };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

export class ShutdownCoordinator {
  private shutdownPromise: Promise<void> | null = null;

  run(shutdownOperation: () => Promise<void>): Promise<void> {
    if (!this.shutdownPromise) {
      this.shutdownPromise = (async () => shutdownOperation())();
    }

    return this.shutdownPromise;
  }
}

export async function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return;

  await new Promise<void>((resolve, reject) => {
    const closeIdleConnections = () => server.closeIdleConnections();
    const idleConnectionSweep = setInterval(closeIdleConnections, 100);
    idleConnectionSweep.unref();

    try {
      server.close((error) => {
        clearInterval(idleConnectionSweep);
        if (error) reject(error);
        else resolve();
      });
      closeIdleConnections();
    } catch (error) {
      clearInterval(idleConnectionSweep);
      reject(error);
    }
  });
}

export const shutdownCleanupRegistry = new ShutdownCleanupRegistry();
