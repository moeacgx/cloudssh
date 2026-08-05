import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  Bot,
  ExternalLink,
  Plug,
  Search,
  X,
  Pencil,
  Check,
  Pin,
  Plus,
  LoaderCircle,
} from "lucide-react";
import {
  getActiveSessions,
  deleteOpenTab,
  type ActiveSessionInfo,
  type OpenTabRecord,
} from "@/main-axios";
import { tabIcon } from "@/shell/tabUtils";
import type { Tab, TabType } from "@/types/ui-types";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { Input } from "@/components/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/tooltip";
import { usePageVisibleInterval } from "@/hooks/use-page-visible-interval";

const CONNECTION_TAB_TYPES: TabType[] = [
  "terminal",
  "rdp",
  "vnc",
  "telnet",
  "files",
  "docker",
  "host-metrics",
  "tunnel",
];

const TYPE_LABELS: Record<string, string> = {
  terminal: "SSH",
  rdp: "RDP",
  vnc: "VNC",
  telnet: "Telnet",
  files: "Files",
  docker: "Docker",
  "host-metrics": "Host Metrics",
  tunnel: "Tunnel",
};

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function sessionsUnchanged(
  prev: ActiveSessionInfo[],
  next: ActiveSessionInfo[],
): boolean {
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i];
    const b = next[i];
    if (
      a.sessionId !== b.sessionId ||
      a.hostId !== b.hostId ||
      a.hostName !== b.hostName ||
      a.tabInstanceId !== b.tabInstanceId ||
      a.isConnected !== b.isConnected ||
      a.createdAt !== b.createdAt ||
      a.isOwnSession !== b.isOwnSession ||
      a.sharedByUsername !== b.sharedByUsername ||
      a.permissionLevel !== b.permissionLevel ||
      a.shareId !== b.shareId ||
      a.sessionPinned !== b.sessionPinned ||
      a.sessionManagedTmux !== b.sessionManagedTmux ||
      a.lastDetachedAt !== b.lastDetachedAt ||
      a.retentionExpiresAt !== b.retentionExpiresAt ||
      a.tmuxSessionName !== b.tmuxSessionName ||
      a.recoverable !== b.recoverable ||
      a.projectId !== b.projectId ||
      a.projectHostId !== b.projectHostId ||
      a.sessionSource !== b.sessionSource ||
      a.agentSessionId !== b.agentSessionId ||
      a.agentActorName !== b.agentActorName ||
      a.runtimeMode !== b.runtimeMode
    ) {
      return false;
    }
  }
  return true;
}

function formatExpiry(expiresAt: number, now: number): string | null {
  const remaining = expiresAt - now;
  if (remaining <= 0) return null;
  return formatDuration(remaining);
}

function pinnedSessionLabelKey(managedTmux: boolean | undefined) {
  if (managedTmux === true) return "connections.tmuxPinnedSession";
  if (managedTmux === false) {
    return "connections.platformKeepaliveSession";
  }
  return "connections.pinnedSession";
}

function ConnectionRow({
  isActive,
  isLive,
  tabType,
  name,
  hostName,
  subLabel,
  icon,
  onSwitch,
  onClose,
  closeTitle,
  switchTitle,
  faded,
  onRename,
  isDragging,
  isPinned,
  isAgent,
}: {
  isActive?: boolean;
  isLive: boolean;
  tabType: string;
  name: string;
  hostName?: string;
  subLabel: string;
  icon: React.ReactNode;
  onSwitch?: () => void;
  onClose?: () => void;
  closeTitle?: string;
  switchTitle?: string;
  faded?: boolean;
  onRename?: (newLabel: string) => void;
  isDragging?: boolean;
  isPinned?: boolean;
  isAgent?: boolean;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(name);
  const typeLabel =
    tabType === "files"
      ? t("nav.fileManager")
      : tabType === "host-metrics"
        ? t("nav.hostMetrics")
        : tabType === "tunnel"
          ? t("nav.tunnels")
          : (TYPE_LABELS[tabType] ?? tabType);

  function startEdit(e: React.MouseEvent) {
    e.stopPropagation();
    setEditValue(name);
    setEditing(true);
  }

  function commitEdit() {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== name && onRename) {
      onRename(trimmed);
    }
    setEditing(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") commitEdit();
    if (e.key === "Escape") setEditing(false);
  }

  return (
    <div
      role={onSwitch && !editing ? "button" : undefined}
      tabIndex={onSwitch && !editing ? 0 : undefined}
      onClick={!editing ? onSwitch : undefined}
      onKeyDown={(e) => !editing && e.key === "Enter" && onSwitch?.()}
      className={`group flex items-center gap-2.5 px-3 py-2.5 border-b border-border/40 transition-colors last:border-b-0 ${
        faded ? "opacity-60" : ""
      } ${isDragging ? "opacity-30" : ""} ${
        isActive
          ? "bg-accent-brand/8 cursor-pointer border-l-2 border-l-accent-brand"
          : onSwitch && !editing
            ? "hover:bg-muted/40 cursor-pointer"
            : ""
      }`}
    >
      <div
        className={`shrink-0 flex items-center justify-center size-7 rounded ${
          isActive
            ? "bg-accent-brand/15 text-accent-brand"
            : "bg-muted/60 text-muted-foreground"
        }`}
      >
        {icon}
      </div>

      <div className="flex flex-col flex-1 min-w-0 gap-0.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className={`shrink-0 size-1.5 rounded-full ${
              isLive ? "bg-green-500" : "bg-muted-foreground/30"
            }`}
          />
          {editing ? (
            <input
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={handleKeyDown}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              className="text-xs font-semibold flex-1 min-w-0 bg-transparent border-b border-accent-brand outline-none text-foreground"
              autoFocus
            />
          ) : (
            <span
              className={`text-xs font-semibold truncate flex-1 ${
                isActive ? "text-accent-brand" : "text-foreground"
              }`}
            >
              {name}
            </span>
          )}
          <Badge
            variant="outline"
            className="text-[9px] px-1 py-0 h-4 font-mono shrink-0 text-muted-foreground/60 border-border/60"
          >
            {typeLabel}
          </Badge>
          {isAgent && (
            <Badge className="h-4 shrink-0 border-violet-400/40 bg-violet-500/10 px-1 text-[9px] text-violet-600 dark:text-violet-300">
              Agent
            </Badge>
          )}
          {isPinned && (
            <Pin
              className="size-3 shrink-0 text-accent-brand"
              aria-label={t("connections.pinned")}
            />
          )}
        </div>
        <span className="text-[10px] text-muted-foreground/60 truncate pl-3">
          {hostName && hostName !== name ? (
            <span className="text-muted-foreground/50">
              {hostName} &middot;{" "}
            </span>
          ) : null}
          {subLabel}
        </span>
      </div>

      <TooltipProvider>
        <div className="flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100">
          {editing ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                commitEdit();
              }}
              className="flex size-9 items-center justify-center rounded text-accent-brand transition-colors hover:bg-muted/60 md:size-6"
            >
              <Check className="size-3" />
            </button>
          ) : (
            onRename && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={startEdit}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="flex size-9 items-center justify-center rounded text-muted-foreground/50 transition-colors hover:bg-muted/60 hover:text-foreground md:size-6"
                  >
                    <Pencil className="size-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left">
                  {t("connections.rename")}
                </TooltipContent>
              </Tooltip>
            )
          )}
          {switchTitle && onSwitch && !editing && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onSwitch();
                  }}
                  className="flex size-9 items-center justify-center rounded text-muted-foreground/50 transition-colors hover:bg-muted/60 hover:text-foreground md:size-6"
                >
                  <ExternalLink className="size-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left">{switchTitle}</TooltipContent>
            </Tooltip>
          )}
          {!editing && onClose && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              aria-label={closeTitle ?? t("connections.closeConnection")}
              title={closeTitle ?? t("connections.closeConnection")}
              className="flex size-9 items-center justify-center rounded text-muted-foreground/50 transition-colors hover:bg-destructive/10 hover:text-destructive md:size-6"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      </TooltipProvider>
    </div>
  );
}

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-border/60 bg-muted/20">
      <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60 flex-1">
        {label}
      </span>
      <span className="text-[10px] font-semibold text-muted-foreground/40 bg-muted/60 rounded px-1.5 py-0.5">
        {count}
      </span>
    </div>
  );
}

export function ConnectionsPanel({
  tabs,
  activeTabId,
  activeProjectId,
  allHosts,
  backgroundTabRecords,
  onSwitchToTab,
  onCloseTab,
  onTerminatePinnedTab,
  onTerminatePinnedRecord,
  onPinnedRestoreRequired,
  onReopenTab,
  onForgetBackground,
  onRenameTab,
  onReorderTabs,
  onJoinSharedSession,
  onOpenAgentSession,
  onOpenAgentNewTerminal,
  onTerminateAgentSession,
  terminatingAgentSessionIds,
  terminatedAgentSessionIds,
  agentSessionsRefreshVersion,
}: {
  tabs: Tab[];
  activeTabId: string;
  activeProjectId?: string;
  allHosts: { id: string; name: string }[];
  backgroundTabRecords: OpenTabRecord[];
  onSwitchToTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onTerminatePinnedTab?: (tabId: string) => void;
  onTerminatePinnedRecord?: (record: OpenTabRecord) => void;
  onPinnedRestoreRequired?: (record: OpenTabRecord) => void;
  onReopenTab: (
    record: OpenTabRecord,
    restoredSessionId: string | null,
    sessionPinned: boolean,
  ) => void;
  onForgetBackground: (recordId: string) => void;
  onRenameTab?: (tabId: string, newLabel: string) => void;
  onReorderTabs?: (tabs: Tab[]) => void;
  onJoinSharedSession?: (session: ActiveSessionInfo) => void;
  onOpenAgentSession?: (session: ActiveSessionInfo) => void;
  onOpenAgentNewTerminal?: (session: ActiveSessionInfo) => void;
  onTerminateAgentSession?: (session: ActiveSessionInfo) => void;
  terminatingAgentSessionIds?: ReadonlySet<string>;
  terminatedAgentSessionIds?: ReadonlySet<string>;
  agentSessionsRefreshVersion?: number;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now());
  const [activeSessions, setActiveSessions] = useState<ActiveSessionInfo[]>([]);
  const [search, setSearch] = useState("");

  // Drag-to-reorder state
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
  const rowEls = useRef<Map<string, HTMLDivElement>>(new Map());
  const dragStartY = useRef<number>(0);
  const didDragRef = useRef(false);

  const openTabs = tabs.filter((tab) =>
    CONNECTION_TAB_TYPES.includes(tab.type),
  );

  const openInstanceIds = new Set(
    tabs.map((t) => t.instanceId).filter(Boolean),
  );
  const backgroundTabs = backgroundTabRecords.filter(
    (r) => !openInstanceIds.has(r.id),
  );

  const q = search.trim().toLowerCase();
  const filteredOpenTabs = q
    ? openTabs.filter((tab) => {
        const displayName = tab.customLabel ?? tab.host?.name ?? tab.label;
        return (
          displayName.toLowerCase().includes(q) ||
          (tab.host?.name ?? "").toLowerCase().includes(q)
        );
      })
    : openTabs;
  const filteredBackgroundTabs = q
    ? backgroundTabs.filter((r) => {
        const host = allHosts.find((h) => h.id === String(r.hostId));
        return (host?.name ?? r.label).toLowerCase().includes(q);
      })
    : backgroundTabs;

  const joinedInstanceIds = new Set(
    tabs
      .map((t) => (t.joinSharedSessionId ? t.instanceId : null))
      .filter(Boolean),
  );
  const sharedWithMe = activeSessions.filter(
    (s) =>
      s.isOwnSession === false &&
      s.sessionSource !== "agent" &&
      !joinedInstanceIds.has(s.sessionId),
  );
  const filteredSharedWithMe = q
    ? sharedWithMe.filter(
        (s) =>
          s.hostName.toLowerCase().includes(q) ||
          (s.sharedByUsername ?? "").toLowerCase().includes(q),
      )
    : sharedWithMe;
  const agentSessions = activeSessions.filter(
    (s) =>
      s.sessionSource === "agent" &&
      Boolean(s.agentSessionId) &&
      (!activeProjectId || s.projectId === activeProjectId) &&
      !terminatedAgentSessionIds?.has(s.agentSessionId ?? s.sessionId) &&
      // 浏览器附着会话的 sessionId 是网页 UUID；控制面 Agent 行的
      // sessionId 与 agentSessionId 相同。只把后者放在 Agent 区，
      // 这样即使已打开网页标签，仍能从这里新建另一条普通 SSH。
      s.sessionId === s.agentSessionId,
  );
  const filteredAgentSessions = q
    ? agentSessions.filter(
        (s) =>
          s.hostName.toLowerCase().includes(q) ||
          (s.agentActorName ?? "Agent").toLowerCase().includes(q),
      )
    : agentSessions;

  // Duration labels only need minute-level freshness; 1s ticks re-render the whole panel.
  usePageVisibleInterval(() => setNow(Date.now()), 15_000);

  const refresh = useCallback(async () => {
    try {
      const sessions = await getActiveSessions();
      setActiveSessions((prev) => {
        const next = Array.isArray(sessions) ? sessions : [];
        if (sessionsUnchanged(prev, next)) return prev;
        return next;
      });
    } catch {
      // silently ignore
    }
  }, []);

  const observedAgentRefreshVersion = useRef(agentSessionsRefreshVersion);
  useEffect(() => {
    if (observedAgentRefreshVersion.current === agentSessionsRefreshVersion) {
      return;
    }
    observedAgentRefreshVersion.current = agentSessionsRefreshVersion;
    void refresh();
  }, [agentSessionsRefreshVersion, refresh]);

  // Initial fetch + visibility-aware poll (hook fires once on mount).
  usePageVisibleInterval(() => {
    void refresh();
  }, 5_000);

  // Global pointer listeners for drag reorder
  useEffect(() => {
    if (!dragTabId) return;

    function onPointerMove(e: PointerEvent) {
      if (Math.abs(e.clientY - dragStartY.current) > 4)
        didDragRef.current = true;
      if (!didDragRef.current) return;

      // Find which row the pointer is over
      let overTabId: string | null = null;
      rowEls.current.forEach((el, id) => {
        if (id === dragTabId) return;
        const rect = el.getBoundingClientRect();
        if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
          overTabId = id;
        }
      });
      setDragOverTabId(overTabId);
    }

    function onPointerUp(e: PointerEvent) {
      if (didDragRef.current && dragTabId && onReorderTabs) {
        // Find drop target
        let targetTabId: string | null = null;
        rowEls.current.forEach((el, id) => {
          if (id === dragTabId) return;
          const rect = el.getBoundingClientRect();
          if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
            targetTabId = id;
          }
        });

        if (targetTabId) {
          const fromIdx = openTabs.findIndex((t) => t.id === dragTabId);
          const toIdx = openTabs.findIndex((t) => t.id === targetTabId);
          if (fromIdx !== -1 && toIdx !== -1 && fromIdx !== toIdx) {
            const reordered = [...openTabs];
            reordered.splice(toIdx, 0, reordered.splice(fromIdx, 1)[0]);
            const connectionSet = new Set(CONNECTION_TAB_TYPES as string[]);
            const nonConnectionTabs = tabs.filter(
              (t) => !connectionSet.has(t.type),
            );
            onReorderTabs([...nonConnectionTabs, ...reordered]);
          }
        }
      }

      setDragTabId(null);
      setDragOverTabId(null);
      setTimeout(() => {
        didDragRef.current = false;
      }, 0);
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [dragTabId, openTabs, tabs, onReorderTabs]);

  const sessionByInstanceId = new Map(
    activeSessions.map((s) => [s.tabInstanceId, s]),
  );

  const hasAnything =
    openTabs.length > 0 ||
    backgroundTabs.length > 0 ||
    sharedWithMe.length > 0 ||
    agentSessions.length > 0;
  const hasResults =
    filteredOpenTabs.length > 0 ||
    filteredBackgroundTabs.length > 0 ||
    filteredSharedWithMe.length > 0 ||
    filteredAgentSessions.length > 0;

  if (!hasAnything) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-3 p-6 text-center py-16">
        <div className="size-10 rounded-full bg-muted/40 flex items-center justify-center">
          <Plug className="size-5 text-muted-foreground/30" />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-muted-foreground/60">
            {t("connections.noConnections")}
          </span>
          <span className="text-xs text-muted-foreground/40">
            {t("connections.noConnectionsDesc")}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="relative px-3 py-2 border-b border-border/60">
        <Search className="absolute left-5.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground/50 pointer-events-none" />
        <Input
          placeholder={t("connections.search")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-8 h-7 text-xs"
        />
      </div>

      {!hasResults && (
        <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
          <span className="text-xs text-muted-foreground/50">
            {t("connections.noSearchResults")}
          </span>
        </div>
      )}

      {filteredOpenTabs.length > 0 && (
        <div className="flex flex-col">
          <SectionHeader
            label={t("connections.sectionOpen")}
            count={filteredOpenTabs.length}
          />
          {filteredOpenTabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const liveSession = tab.instanceId
              ? sessionByInstanceId.get(tab.instanceId)
              : undefined;
            const isLive =
              tab.type === "terminal"
                ? (liveSession?.isConnected ?? false)
                : true;
            const isPinned =
              liveSession?.sessionPinned ?? tab.sessionPinned ?? false;
            const isAgent = Boolean(
              tab.agentSessionId || liveSession?.agentSessionId,
            );
            const canTerminatePinned = isPinned && !isAgent;
            const isManagedTmux =
              liveSession?.sessionManagedTmux ??
              tab.sessionManagedTmux ??
              (liveSession?.tmuxSessionName ? true : undefined);
            const duration = liveSession?.createdAt
              ? formatDuration(now - liveSession.createdAt)
              : formatDuration(now - tab.openedAt);

            const displayName = tab.customLabel ?? tab.host?.name ?? tab.label;
            const hostName = tab.host?.name;
            const isDraggingThis = dragTabId === tab.id;
            const isDropTarget = dragOverTabId === tab.id && !isDraggingThis;

            return (
              <div
                key={tab.id}
                ref={(el) => {
                  if (el) rowEls.current.set(tab.id, el);
                  else rowEls.current.delete(tab.id);
                }}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  dragStartY.current = e.clientY;
                  didDragRef.current = false;
                  setDragTabId(tab.id);
                }}
                className={`relative ${isDropTarget ? "border-t-2 border-accent-brand" : ""}`}
                style={{
                  cursor: dragTabId
                    ? isDraggingThis
                      ? "grabbing"
                      : "default"
                    : "grab",
                }}
              >
                <ConnectionRow
                  isActive={isActive}
                  isLive={isLive}
                  tabType={tab.type}
                  name={displayName}
                  hostName={tab.customLabel ? hostName : undefined}
                  subLabel={
                    isPinned && tab.type === "terminal"
                      ? t(pinnedSessionLabelKey(isManagedTmux))
                      : isLive && tab.type === "terminal"
                        ? t("connections.connectedFor", { duration })
                        : isLive
                          ? t("connections.connected")
                          : t("connections.disconnected")
                  }
                  icon={tabIcon(tab.type)}
                  onSwitch={() => {
                    if (!didDragRef.current) onSwitchToTab(tab.id);
                  }}
                  onClose={
                    canTerminatePinned
                      ? onTerminatePinnedTab
                        ? () => onTerminatePinnedTab(tab.id)
                        : undefined
                      : () => onCloseTab(tab.id)
                  }
                  closeTitle={
                    canTerminatePinned
                      ? t("terminal.closePinnedWindow")
                      : t("connections.closeTab")
                  }
                  onRename={
                    onRenameTab
                      ? (newLabel) => onRenameTab(tab.id, newLabel)
                      : undefined
                  }
                  isDragging={isDraggingThis}
                  isPinned={isPinned}
                  isAgent={isAgent}
                />
              </div>
            );
          })}
        </div>
      )}

      {filteredBackgroundTabs.length > 0 && (
        <div
          className={`flex flex-col ${filteredOpenTabs.length > 0 ? "mt-2" : ""}`}
        >
          <SectionHeader
            label={t("connections.sectionBackground")}
            count={filteredBackgroundTabs.length}
          />
          <div className="px-3 py-1.5 border-b border-border/40">
            <span className="text-[10px] text-muted-foreground/50">
              {t("connections.backgroundRetentionDesc")}
            </span>
          </div>
          {filteredBackgroundTabs.map((record) => {
            const host = record.hostId
              ? allHosts.find((h) => h.id === String(record.hostId))
              : undefined;
            const liveSession = sessionByInstanceId.get(record.id);
            const isLive = liveSession?.isConnected ?? false;
            const isPinned =
              liveSession?.sessionPinned ?? record.sessionPinned ?? false;
            const requiresPinnedRestore =
              isPinned &&
              liveSession === undefined &&
              Boolean(record.tmuxSessionName);
            const canTerminatePinned = isPinned && !requiresPinnedRestore;
            const isManagedTmux =
              liveSession?.sessionManagedTmux ??
              (record.tmuxSessionName ? true : undefined);
            const retentionExpiresAt =
              liveSession?.retentionExpiresAt ?? record.retentionExpiresAt;
            const expiresIn = retentionExpiresAt
              ? formatExpiry(retentionExpiresAt, now)
              : null;

            return (
              <ConnectionRow
                key={record.id}
                isLive={isLive}
                faded={!isLive && !isPinned}
                isPinned={isPinned}
                tabType={record.tabType}
                name={host?.name ?? record.label}
                subLabel={
                  isPinned
                    ? t(pinnedSessionLabelKey(isManagedTmux))
                    : expiresIn
                      ? t("connections.expiresIn", { duration: expiresIn })
                      : t("connections.retentionUnknown")
                }
                icon={tabIcon(record.tabType as TabType)}
                onSwitch={() => {
                  onReopenTab(record, liveSession?.sessionId ?? null, isPinned);
                }}
                onClose={
                  isPinned
                    ? canTerminatePinned
                      ? onTerminatePinnedRecord
                        ? () => onTerminatePinnedRecord(record)
                        : undefined
                      : onPinnedRestoreRequired
                        ? () => onPinnedRestoreRequired(record)
                        : undefined
                    : async () => {
                        await deleteOpenTab(record.id).catch(() => {});
                        onForgetBackground(record.id);
                      }
                }
                closeTitle={
                  isPinned
                    ? t(
                        canTerminatePinned
                          ? "terminal.closePinnedWindow"
                          : "terminal.restorePinnedBeforeClose",
                      )
                    : t("connections.removeBackground")
                }
                switchTitle={t("connections.reconnect")}
              />
            );
          })}
        </div>
      )}

      {filteredAgentSessions.length > 0 && (
        <div
          className={`flex flex-col ${filteredOpenTabs.length > 0 || filteredBackgroundTabs.length > 0 ? "mt-2" : ""}`}
        >
          <SectionHeader
            label={t("connections.sectionAgent")}
            count={filteredAgentSessions.length}
          />
          <div className="border-b border-border/40 px-3 py-1.5">
            <span className="text-[10px] text-muted-foreground/50">
              {t("connections.agentSessionDesc")}
            </span>
          </div>
          {filteredAgentSessions.map((session) => (
            <AgentSessionRow
              key={session.agentSessionId ?? session.sessionId}
              session={session}
              onOpen={() => onOpenAgentSession?.(session)}
              onNewTerminal={() => onOpenAgentNewTerminal?.(session)}
              onTerminate={
                onTerminateAgentSession
                  ? () => onTerminateAgentSession(session)
                  : undefined
              }
              isTerminating={Boolean(
                terminatingAgentSessionIds?.has(
                  session.agentSessionId ?? session.sessionId,
                ),
              )}
            />
          ))}
        </div>
      )}

      {filteredSharedWithMe.length > 0 && (
        <div
          className={`flex flex-col ${filteredOpenTabs.length > 0 || filteredBackgroundTabs.length > 0 || filteredAgentSessions.length > 0 ? "mt-2" : ""}`}
        >
          <SectionHeader
            label={t("connections.sectionSharedWithMe")}
            count={filteredSharedWithMe.length}
          />
          {filteredSharedWithMe.map((session) => (
            <SharedWithMeRow
              key={session.sessionId}
              session={session}
              onJoin={() => onJoinSharedSession?.(session)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentSessionRow({
  session,
  onOpen,
  onNewTerminal,
  onTerminate,
  isTerminating = false,
}: {
  session: ActiveSessionInfo;
  onOpen: () => void;
  onNewTerminal: () => void;
  onTerminate?: () => void;
  isTerminating?: boolean;
}) {
  const { t } = useTranslation();
  const isRunning = session.isConnected;
  const canOpen = isRunning && !isTerminating;
  return (
    <div className="group flex items-center gap-2.5 border-b border-border/40 px-3 py-2.5">
      <div
        role="button"
        tabIndex={canOpen ? 0 : -1}
        aria-disabled={!canOpen}
        onClick={() => {
          if (canOpen) onOpen();
        }}
        onKeyDown={(event) => {
          if (canOpen && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            onOpen();
          }
        }}
        className={`flex min-w-0 flex-1 items-center gap-2.5 rounded ${canOpen ? "cursor-pointer transition-colors hover:bg-muted/40" : "cursor-not-allowed opacity-70"}`}
      >
        <div className="flex size-7 shrink-0 items-center justify-center rounded bg-violet-500/10 text-violet-600 dark:text-violet-300">
          <Bot className="size-3.5" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              className={`size-1.5 shrink-0 rounded-full ${isRunning ? "bg-green-500" : "bg-amber-500"}`}
            />
            <span className="truncate text-xs font-semibold text-foreground">
              {session.hostName}
            </span>
            <Badge className="h-4 shrink-0 border-violet-400/40 bg-violet-500/10 px-1 text-[9px] text-violet-600 dark:text-violet-300">
              Agent
            </Badge>
            <Badge
              variant="outline"
              className="h-4 shrink-0 px-1 text-[9px] font-normal text-muted-foreground"
            >
              {session.runtimeMode === "platform"
                ? t("connections.platformRuntimeMode")
                : "tmux"}
            </Badge>
          </div>
          <span className="truncate pl-3 text-[10px] text-muted-foreground/60">
            {session.agentActorName || "Agent"} ·{" "}
            {isTerminating
              ? t("connections.agentTerminating")
              : isRunning
                ? t("connections.agentRunning")
                : t("connections.agentRecovering")}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                disabled={!canOpen}
                aria-label={t("connections.enterAgentSession")}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpen();
                }}
                className="flex size-8 items-center justify-center rounded text-accent-brand transition-colors hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-40 md:size-6"
              >
                <ExternalLink className="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">
              {t("connections.enterAgentSession")}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                disabled={isTerminating}
                aria-label={t("connections.newSshTerminal")}
                onClick={(event) => {
                  event.stopPropagation();
                  onNewTerminal();
                }}
                className="flex size-8 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 md:size-6"
              >
                <Plus className="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">
              {t("connections.newSshTerminal")}
            </TooltipContent>
          </Tooltip>
          {onTerminate && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  disabled={isTerminating}
                  aria-label={t(
                    isTerminating
                      ? "connections.agentSessionTerminating"
                      : "connections.terminateAgentSession",
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (!isTerminating) onTerminate();
                  }}
                  className="flex size-8 items-center justify-center rounded text-destructive/70 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40 md:size-6"
                >
                  {isTerminating ? (
                    <LoaderCircle className="size-3 animate-spin" />
                  ) : (
                    <X className="size-3" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="left">
                {t(
                  isTerminating
                    ? "connections.agentSessionTerminating"
                    : "connections.terminateAgentSession",
                )}
              </TooltipContent>
            </Tooltip>
          )}
        </TooltipProvider>
      </div>
    </div>
  );
}

function SharedWithMeRow({
  session,
  onJoin,
}: {
  session: ActiveSessionInfo;
  onJoin: () => void;
}) {
  const { t } = useTranslation();
  const isReadWrite = session.permissionLevel === "read-write";

  return (
    <div className="group flex items-center gap-2.5 px-3 py-2.5 border-b border-border/40 last:border-b-0">
      <div className="shrink-0 flex items-center justify-center size-7 rounded bg-muted/60 text-muted-foreground">
        {tabIcon("terminal")}
      </div>
      <div className="flex flex-col flex-1 min-w-0 gap-0.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className={`shrink-0 size-1.5 rounded-full ${
              session.isConnected ? "bg-green-500" : "bg-muted-foreground/30"
            }`}
          />
          <span className="text-xs font-semibold truncate flex-1 text-foreground">
            {session.hostName}
          </span>
          <Badge
            variant="outline"
            className={`text-[9px] px-1 py-0 h-4 font-mono shrink-0 border-border/60 ${
              isReadWrite ? "text-accent-brand" : "text-muted-foreground/60"
            }`}
          >
            {isReadWrite
              ? t("sessionSharing.permissionLevel.readWrite")
              : t("sessionSharing.permissionLevel.readOnly")}
          </Badge>
        </div>
        <span className="text-[10px] text-muted-foreground/60 truncate pl-3">
          {t("connections.sharedBy", {
            username: session.sharedByUsername ?? "?",
          })}
        </span>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="h-6 text-[10px] px-2 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={onJoin}
      >
        {t("connections.join")}
      </Button>
    </div>
  );
}
