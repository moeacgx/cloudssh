import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client, ConnectConfig } from "ssh2";
import {
  cleanupExpiredPendingTOTPSessions,
  getSessionKey,
  pendingTOTPSessions,
} from "../../../hosts/metrics/sessions.js";

function addPendingSession(
  sessionId: string,
  createdAt: number,
  end: () => void,
): void {
  pendingTOTPSessions[sessionId] = {
    client: { end } as unknown as Client,
    finish: () => {},
    config: {} as ConnectConfig,
    createdAt,
    sessionId,
    hostId: 7,
    projectHostId: 11,
    userId: "user-a",
    totpAttempts: 0,
  };
}

afterEach(() => {
  for (const sessionId of Object.keys(pendingTOTPSessions)) {
    delete pendingTOTPSessions[sessionId];
  }
});

describe("metrics session scope", () => {
  it("separates personal and project sessions for the same user and host", () => {
    expect(getSessionKey(7, "user-a")).not.toBe(getSessionKey(7, "user-a", 11));
    expect(getSessionKey(7, "user-a", 11)).not.toBe(
      getSessionKey(7, "user-a", 12),
    );
  });

  it("expires abandoned TOTP sessions without touching active ones", () => {
    const expiredEnd = vi.fn();
    const activeEnd = vi.fn();
    addPendingSession("totp-expired", 1_000, expiredEnd);
    addPendingSession("totp-active", 9_500, activeEnd);

    const removed = cleanupExpiredPendingTOTPSessions(3_000, 10_000);

    expect(removed).toBe(1);
    expect(expiredEnd).toHaveBeenCalledOnce();
    expect(activeEnd).not.toHaveBeenCalled();
    expect(pendingTOTPSessions["totp-expired"]).toBeUndefined();
    expect(pendingTOTPSessions["totp-active"]).toBeDefined();
  });
});
