import { agentApi, authApi } from "@/main-axios";
import { createTtlRequestCache } from "@/lib/ttl-request-cache";
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

const activeSessionsCache = createTtlRequestCache<ActiveSessionInfo[]>(2_000);

export async function getOpenTabs(): Promise<OpenTabRecord[]> {
  const response = await authApi.get("/open-tabs");
  return response.data;
}

export async function syncOpenTabs(tabs: OpenTabSyncPayload[]): Promise<void> {
  await authApi.put("/open-tabs", { tabs });
}

export async function deleteOpenTab(instanceId: string): Promise<void> {
  await authApi.delete(`/open-tabs/${instanceId}`);
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
  return response.data.tab;
}

export async function patchOpenTab(
  instanceId: string,
  updates: Partial<
    Pick<OpenTabRecord, "label" | "tabOrder" | "backendSessionId">
  >,
): Promise<void> {
  await authApi.patch(`/open-tabs/${instanceId}`, updates);
}

export async function addOpenTab(tab: OpenTabUpsertPayload): Promise<void> {
  await authApi.post("/open-tabs", tab);
}

export async function closeAgentSession(sessionId: string): Promise<void> {
  await agentApi.post(
    `/agent/admin/v1/sessions/${encodeURIComponent(sessionId)}/close`,
  );
  activeSessionsCache.invalidate();
}

export async function getActiveSessions(): Promise<ActiveSessionInfo[]> {
  return activeSessionsCache.get(async () => {
    const response = await authApi.get("/open-tabs/active-sessions");
    return Array.isArray(response.data) ? response.data : [];
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
