import { describe, expect, it } from "vitest";
import type { ActiveSessionInfo, OpenTabRecord } from "@/api/open-tabs-api";
import {
  createActiveSessionByTabInstance,
  shouldRestoreSavedTab,
} from "@/shell/tab-restore";

function openTabRecord(overrides: Partial<OpenTabRecord> = {}): OpenTabRecord {
  return {
    id: "tab-1",
    userId: "user-1",
    tabType: "terminal",
    hostId: 7,
    label: "prod",
    tabOrder: 0,
    backendSessionId: "session-stale",
    sessionPinned: false,
    tmuxSessionName: null,
    lastDetachedAt: null,
    retentionExpiresAt: null,
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    ...overrides,
  };
}

function activeSession(
  overrides: Partial<ActiveSessionInfo> = {},
): ActiveSessionInfo {
  return {
    sessionId: "session-live",
    hostId: 7,
    hostName: "prod",
    tabInstanceId: "tab-1",
    isConnected: true,
    createdAt: Date.now(),
    isOwnSession: true,
    sharedByUsername: null,
    permissionLevel: null,
    shareId: null,
    sessionPinned: false,
    lastDetachedAt: null,
    retentionExpiresAt: null,
    tmuxSessionName: null,
    recoverable: false,
    ...overrides,
  };
}

describe("tab restore", () => {
  it("restores pinned SSH tabs even when normal reopen is disabled", () => {
    expect(shouldRestoreSavedTab(openTabRecord(), undefined, false)).toBe(
      false,
    );
    expect(
      shouldRestoreSavedTab(
        openTabRecord({ sessionPinned: true }),
        undefined,
        false,
      ),
    ).toBe(true);
    expect(
      shouldRestoreSavedTab(
        openTabRecord(),
        activeSession({ sessionPinned: true }),
        false,
      ),
    ).toBe(true);
    expect(shouldRestoreSavedTab(openTabRecord(), undefined, true)).toBe(true);
  });

  it("indexes only sessions with a tab instance", () => {
    const indexed = createActiveSessionByTabInstance([
      activeSession({ tabInstanceId: "tab-live" }),
      activeSession({ sessionId: "session-hostless", tabInstanceId: null }),
    ]);

    expect(indexed.get("tab-live")?.sessionId).toBe("session-live");
    expect(indexed.has("session-hostless")).toBe(false);
  });
});
