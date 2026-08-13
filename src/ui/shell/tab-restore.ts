import type { ActiveSessionInfo, OpenTabRecord } from "@/api/open-tabs-api";

export function createActiveSessionByTabInstance(
  activeSessions: ActiveSessionInfo[] | null | undefined,
): Map<string, ActiveSessionInfo> {
  return new Map(
    (Array.isArray(activeSessions) ? activeSessions : [])
      .filter((session) => session.tabInstanceId != null)
      .map((session) => [session.tabInstanceId!, session]),
  );
}

export function shouldRestoreSavedTab(
  savedTab: OpenTabRecord,
  liveSession: ActiveSessionInfo | undefined,
  reopenTabsOnLogin: boolean,
): boolean {
  if (reopenTabsOnLogin) return true;
  return (liveSession?.sessionPinned ?? savedTab.sessionPinned) === true;
}
