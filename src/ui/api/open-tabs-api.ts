import { agentApi, authApi } from "@/main-axios";
import { createTtlRequestCache } from "@/lib/ttl-request-cache";
import {
  clearBrowserTtlCache,
  readBrowserTtlCache,
  writeBrowserTtlCache,
} from "@/lib/browser-ttl-cache";
import type { TerminalTheme } from "@/lib/terminal-themes";
import type { CustomKeybinding } from "@/types/keybindings";

// OPEN TABS API
// ============================================================================

export interface OpenTabRecord {
  id: string;
  userId: string;
  tabType: string;
  hostId: number | null;
  label: string;
  tabOrder: number;
  backendSessionId: string | null;
  sessionPinned: boolean;
  tmuxSessionName: string | null;
  lastDetachedAt: number | null;
  retentionExpiresAt: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface OpenTabSyncPayload {
  id: string;
  tabType: string;
  hostId?: number | null;
  label: string;
  tabOrder: number;
  backendSessionId?: string | null;
}

export interface OpenTabUpsertPayload {
  id: string;
  tabType: string;
  hostId?: number | null;
  label: string;
  tabOrder: number;
  backendSessionId?: string | null;
}

interface DetachPinnedOpenTabResponse {
  success: true;
  sessionId: string;
  tab: OpenTabRecord;
}

export interface ActiveSessionInfo {
  sessionId: string;
  hostId: number;
  hostName: string;
  tabInstanceId: string | null;
  isConnected: boolean;
  createdAt: number;
  isOwnSession: boolean;
  sharedByUsername: string | null;
  permissionLevel: string | null;
  shareId: string | null;
  sessionPinned: boolean;
  sessionManagedTmux?: boolean;
  lastDetachedAt: number | null;
  retentionExpiresAt: number | null;
  tmuxSessionName: string | null;
  recoverable: boolean;
  /** Agent 会话所属项目；普通网页会话可能为空。 */
  projectId?: string | null;
  projectHostId?: number | null;
  /** 普通网页会话或由 Agent 创建的持续会话。 */
  sessionSource?: "web" | "agent";
  agentSessionId?: string | null;
  agentActorName?: string | null;
  /** Agent 运行时：平台中转无需 tmux；tmux 可在平台重启后恢复。 */
  runtimeMode?: "platform" | "tmux" | null;
}

const OPEN_TABS_BROWSER_CACHE_KEY = "cloudssh.openTabs.v1";
const ACTIVE_SESSIONS_BROWSER_CACHE_KEY = "cloudssh.activeSessions.v1";
const OPEN_TABS_BROWSER_CACHE_TTL_MS = 10_000;
const ACTIVE_SESSIONS_BROWSER_CACHE_TTL_MS = 5_000;

const openTabsCache = createTtlRequestCache<OpenTabRecord[]>(2_000);
const activeSessionsCache = createTtlRequestCache<ActiveSessionInfo[]>(2_000);

export function invalidateOpenTabsCache(): void {
  openTabsCache.invalidate();
  clearBrowserTtlCache(OPEN_TABS_BROWSER_CACHE_KEY);
}

export function invalidateActiveSessionsCache(): void {
  activeSessionsCache.invalidate();
  clearBrowserTtlCache(ACTIVE_SESSIONS_BROWSER_CACHE_KEY);
}

export async function getOpenTabs(): Promise<OpenTabRecord[]> {
  return openTabsCache.get(async () => {
    const cached = readBrowserTtlCache<OpenTabRecord[]>(
      OPEN_TABS_BROWSER_CACHE_KEY,
    );
    if (cached) return cached;

    const response = await authApi.get("/open-tabs");
    const records = Array.isArray(response.data) ? response.data : [];
    writeBrowserTtlCache(
      OPEN_TABS_BROWSER_CACHE_KEY,
      records,
      OPEN_TABS_BROWSER_CACHE_TTL_MS,
    );
    return records;
  });
}

export async function syncOpenTabs(tabs: OpenTabSyncPayload[]): Promise<void> {
  await authApi.put("/open-tabs", { tabs });
  invalidateOpenTabsCache();
}

export async function deleteOpenTab(instanceId: string): Promise<void> {
  await authApi.delete(`/open-tabs/${instanceId}`);
  invalidateOpenTabsCache();
  invalidateActiveSessionsCache();
}

export function upsertOpenTabRecord(
  records: OpenTabRecord[],
  nextRecord: OpenTabRecord,
): OpenTabRecord[] {
  const existingIndex = records.findIndex(
    (record) => record.id === nextRecord.id,
  );
  if (existingIndex === -1) return [...records, nextRecord];
  return records.map((record, index) =>
    index === existingIndex ? nextRecord : record,
  );
}

export async function detachPinnedOpenTab(
  instanceId: string,
): Promise<OpenTabRecord> {
  const response = await authApi.post<DetachPinnedOpenTabResponse>(
    `/open-tabs/${instanceId}/detach`,
  );
  invalidateOpenTabsCache();
  invalidateActiveSessionsCache();
  return response.data.tab;
}

export async function patchOpenTab(
  instanceId: string,
  updates: Partial<
    Pick<OpenTabRecord, "label" | "tabOrder" | "backendSessionId" | "hostId">
  >,
): Promise<void> {
  await authApi.patch(`/open-tabs/${instanceId}`, updates);
  invalidateOpenTabsCache();
}

export async function addOpenTab(tab: OpenTabUpsertPayload): Promise<void> {
  await authApi.post("/open-tabs", tab);
  invalidateOpenTabsCache();
}

export async function closeAgentSession(sessionId: string): Promise<void> {
  await agentApi.post(
    `/agent/admin/v1/sessions/${encodeURIComponent(sessionId)}/close`,
  );
  invalidateActiveSessionsCache();
}

export async function getActiveSessions(): Promise<ActiveSessionInfo[]> {
  return activeSessionsCache.get(async () => {
    const cached = readBrowserTtlCache<ActiveSessionInfo[]>(
      ACTIVE_SESSIONS_BROWSER_CACHE_KEY,
    );
    if (cached) return cached;

    const response = await authApi.get("/open-tabs/active-sessions");
    const sessions = Array.isArray(response.data) ? response.data : [];
    writeBrowserTtlCache(
      ACTIVE_SESSIONS_BROWSER_CACHE_KEY,
      sessions,
      ACTIVE_SESSIONS_BROWSER_CACHE_TTL_MS,
    );
    return sessions;
  });
}

// ============================================================================
// USER PREFERENCES API
// ============================================================================

export interface SavedCustomTheme {
  id: string;
  name: string;
  colors: TerminalTheme["colors"];
}

export interface UserPreferences {
  reopenTabsOnLogin: boolean;
  theme?: string | null;
  fontSize?: string | null;
  accentColor?: string | null;
  language?: string | null;
  storageMode?: string | null;
  terminalDefaultTheme?: string | null;
  commandAutocomplete?: boolean | null;
  commandPaletteEnabled?: boolean | null;
  showHostTags?: boolean | null;
  hostTrayOnClick?: boolean | null;
  pinAppRail?: boolean | null;
  expandAppRailOnHover?: boolean | null;
  foldersCollapsed?: boolean | null;
  confirmSnippetExecution?: boolean | null;
  disableUpdateCheck?: boolean | null;
  confirmTabClose?: boolean | null;
  hiddenRailTabs?: string | null;
  compactHostView?: boolean | null;
  statusColorScheme?: string | null;
  customThemes?: string | null;
  customKeybindings?: string | null;
}

export function parseCustomThemes(raw?: string | null): SavedCustomTheme[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function parseCustomKeybindings(
  raw?: string | null,
): CustomKeybinding[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function getUserPreferences(): Promise<UserPreferences> {
  const response = await authApi.get("/user-preferences");
  return response.data;
}

export async function saveUserPreferences(
  prefs: Partial<UserPreferences>,
): Promise<void> {
  await authApi.put("/user-preferences", prefs);
}
