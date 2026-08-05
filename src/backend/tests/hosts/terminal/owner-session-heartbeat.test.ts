import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { startOwnerSessionHeartbeat } from "../../../hosts/terminal/owner-session-heartbeat.js";

function createFakeWebSocket() {
  const handlers = new Map<string, Set<() => void>>();
  return {
    readyState: WebSocket.OPEN,
    ping: vi.fn(),
    close: vi.fn(),
    on: vi.fn((event: string, handler: () => void) => {
      const listeners = handlers.get(event) ?? new Set();
      listeners.add(handler);
      handlers.set(event, listeners);
    }),
    off: vi.fn((event: string, handler: () => void) => {
      handlers.get(event)?.delete(handler);
    }),
    emit(event: string) {
      for (const handler of handlers.get(event) ?? []) handler();
    },
  } as unknown as WebSocket & { emit: (event: string) => void };
}

describe("owner session heartbeat", () => {
  it("revokes an owner that only replies with protocol pong messages", async () => {
    vi.useFakeTimers();
    try {
      const ws = createFakeWebSocket();
      const session = {
        id: "fixed-session",
        pinned: true,
        managedTmux: true,
      };
      const hasCurrentHostAccess = vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      const onAccessRevoked = vi.fn(() => {
        ws.close(4003, "Host access revoked");
      });
      const heartbeat = startOwnerSessionHeartbeat({
        ws,
        getCurrentOwnerSession: () => session,
        hasCurrentHostAccess,
        onAccessRevoked,
        onPongTimeout: vi.fn(),
        intervalMs: 1_000,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(onAccessRevoked).not.toHaveBeenCalled();

      ws.emit("pong");
      await vi.advanceTimersByTimeAsync(1_000);

      expect(ws.ping).toHaveBeenCalledTimes(2);
      expect(hasCurrentHostAccess).toHaveBeenCalledTimes(2);
      expect(onAccessRevoked).toHaveBeenCalledWith(session);
      expect(ws.close).toHaveBeenCalledWith(4003, "Host access revoked");
      expect(session).toMatchObject({ pinned: true, managedTmux: true });
      heartbeat.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("disconnects an expired web login without requiring an owner session", async () => {
    vi.useFakeTimers();
    try {
      const ws = createFakeWebSocket();
      const hasCurrentAuthenticationAccess = vi.fn().mockResolvedValue(false);
      const onAuthenticationExpired = vi.fn(() => {
        ws.close(1008, "Login session expired");
      });
      const heartbeat = startOwnerSessionHeartbeat({
        ws,
        getCurrentOwnerSession: () => null,
        hasCurrentHostAccess: vi.fn().mockResolvedValue(true),
        hasCurrentAuthenticationAccess,
        onAccessRevoked: vi.fn(),
        onAuthenticationExpired,
        onPongTimeout: vi.fn(),
        intervalMs: 1_000,
      });

      await vi.advanceTimersByTimeAsync(1_000);

      expect(hasCurrentAuthenticationAccess).toHaveBeenCalledOnce();
      expect(onAuthenticationExpired).toHaveBeenCalledOnce();
      expect(ws.close).toHaveBeenCalledWith(1008, "Login session expired");

      ws.emit("pong");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(hasCurrentAuthenticationAccess).toHaveBeenCalledOnce();
      heartbeat.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when login revalidation errors", async () => {
    vi.useFakeTimers();
    try {
      const ws = createFakeWebSocket();
      const onAuthenticationExpired = vi.fn();
      const heartbeat = startOwnerSessionHeartbeat({
        ws,
        getCurrentOwnerSession: () => null,
        hasCurrentHostAccess: vi.fn().mockResolvedValue(true),
        hasCurrentAuthenticationAccess: vi
          .fn()
          .mockRejectedValue(new Error("database unavailable")),
        onAccessRevoked: vi.fn(),
        onAuthenticationExpired,
        onPongTimeout: vi.fn(),
        intervalMs: 1_000,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(onAuthenticationExpired).toHaveBeenCalledOnce();
      heartbeat.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
