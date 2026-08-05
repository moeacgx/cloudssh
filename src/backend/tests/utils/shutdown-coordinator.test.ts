import http from "http";
import type { AddressInfo } from "net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeHttpServer,
  ShutdownCleanupRegistry,
  ShutdownCoordinator,
} from "../../utils/shutdown-coordinator.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("ShutdownCleanupRegistry", () => {
  it("runs each cleanup once across repeated shutdown requests", async () => {
    const firstCleanup = vi.fn().mockResolvedValue(undefined);
    const secondCleanup = vi.fn().mockResolvedValue(undefined);
    const registry = new ShutdownCleanupRegistry();
    registry.register("first", firstCleanup);
    registry.register("second", secondCleanup);

    const firstRun = registry.runAll();
    const secondRun = registry.runAll();

    expect(firstRun).toBe(secondRun);
    await Promise.all([firstRun, secondRun]);
    expect(firstCleanup).toHaveBeenCalledTimes(1);
    expect(secondCleanup).toHaveBeenCalledTimes(1);
  });

  it("reports failures without skipping other cleanups", async () => {
    const successfulCleanup = vi.fn().mockResolvedValue(undefined);
    const registry = new ShutdownCleanupRegistry();
    registry.register("failed", async () => {
      throw new Error("cleanup failed");
    });
    registry.register("successful", successfulCleanup);

    const failures = await registry.runAll();

    expect(failures).toHaveLength(1);
    expect(failures[0].name).toBe("failed");
    expect(successfulCleanup).toHaveBeenCalledTimes(1);
  });

  it("reports a cleanup that exceeds its timeout", async () => {
    vi.useFakeTimers();
    const registry = new ShutdownCleanupRegistry(100);
    registry.register("blocked", () => new Promise<void>(() => undefined));

    const cleanup = registry.runAll();
    await vi.advanceTimersByTimeAsync(100);

    const failures = await cleanup;
    expect(failures).toHaveLength(1);
    expect(failures[0].name).toBe("blocked");
    expect(failures[0].error).toBeInstanceOf(Error);
  });
});

describe("ShutdownCoordinator", () => {
  it("coordinates repeated shutdown requests through one operation", async () => {
    let releaseShutdown!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseShutdown = resolve;
    });
    const shutdownOperation = vi.fn(() => blocked);
    const coordinator = new ShutdownCoordinator();

    const first = coordinator.run(shutdownOperation);
    const second = coordinator.run(shutdownOperation);

    expect(first).toBe(second);
    expect(shutdownOperation).toHaveBeenCalledTimes(1);

    releaseShutdown();
    await Promise.all([first, second]);
  });
});

describe("closeHttpServer", () => {
  it("stops accepting connections after an active request finishes", async () => {
    let markRequestStarted!: () => void;
    let releaseResponse!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    const responseReleased = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const server = http.createServer((_request, response) => {
      markRequestStarted();
      void responseReleased.then(() => response.end("done"));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as AddressInfo;
    const responseComplete = new Promise<void>((resolve, reject) => {
      const request = http.get(
        { host: "127.0.0.1", port: address.port },
        (response) => {
          response.resume();
          response.once("end", resolve);
        },
      );
      request.once("error", reject);
    });
    await requestStarted;

    let serverClosed = false;
    const close = closeHttpServer(server).then(() => {
      serverClosed = true;
    });
    await Promise.resolve();
    expect(serverClosed).toBe(false);

    releaseResponse();
    await Promise.all([close, responseComplete]);

    expect(server.listening).toBe(false);
  });
});
