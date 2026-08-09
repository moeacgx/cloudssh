/* eslint-disable react-refresh/only-export-components */
/* eslint-disable react-hooks/exhaustive-deps */
import axios from "axios";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Separator } from "@/components/separator";
import { Button } from "@/components/button";
import { Sheet, SheetContent } from "@/components/sheet";
import {
  ChevronLeft,
  ChevronRight,
  Maximize2,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import {
  useState,
  useRef,
  useCallback,
  useEffect,
  createRef,
  lazy,
  Suspense,
} from "react";
import { createPortal } from "react-dom";
import { useIsMobile } from "@/hooks/use-mobile";
import { MobileBottomBar } from "@/shell/MobileBottomBar";
import { AppRail } from "@/sidebar/AppRail";
import type { RailView } from "@/sidebar/AppRail";
import { SplitView } from "@/shell/SplitView";
import { renderTabContent } from "@/shell/tabUtils";
import { TabBar } from "@/shell/TabBar";
import { CloseTabConfirmDialog } from "@/shell/CloseTabConfirmDialog";
import { RenderErrorBoundary } from "@/components/render-error-boundary";

// Shell surfaces that are not needed for first paint.
const CommandPalette = lazy(() =>
  import("@/shell/CommandPalette").then((m) => ({
    default: m.CommandPalette,
  })),
);
const HostsPanel = lazy(() =>
  import("@/sidebar/HostsPanel").then((m) => ({ default: m.HostsPanel })),
);
const QuickConnectPanel = lazy(() =>
  import("@/sidebar/QuickConnectPanel").then((m) => ({
    default: m.QuickConnectPanel,
  })),
);
const SerialPanel = lazy(() =>
  import("@/sidebar/SerialPanel").then((m) => ({ default: m.SerialPanel })),
);
const SplitScreenPanel = lazy(() =>
  import("@/sidebar/SplitScreenPanel").then((m) => ({
    default: m.SplitScreenPanel,
  })),
);

// Secondary rail panels — load on first open, not with the shell critical path.
const SshToolsPanel = lazy(() =>
  import("@/sidebar/SshToolsPanel").then((m) => ({ default: m.SshToolsPanel })),
);
const SnippetsPanel = lazy(() =>
  import("@/sidebar/SnippetsPanel").then((m) => ({ default: m.SnippetsPanel })),
);
const HistoryPanel = lazy(() =>
  import("@/sidebar/HistoryPanel").then((m) => ({ default: m.HistoryPanel })),
);
const SessionLogsPanel = lazy(() =>
  import("@/sidebar/SessionLogsPanel").then((m) => ({
    default: m.SessionLogsPanel,
  })),
);
const UserProfilePanel = lazy(() =>
  import("@/sidebar/UserProfilePanel").then((m) => ({
    default: m.UserProfilePanel,
  })),
);
const AdminSettingsPanel = lazy(() =>
  import("@/sidebar/AdminSettingsPanel").then((m) => ({
    default: m.AdminSettingsPanel,
  })),
);
const AlertsPanel = lazy(() =>
  import("@/sidebar/AlertsPanel").then((m) => ({ default: m.AlertsPanel })),
);
const CredentialsPanel = lazy(() =>
  import("@/sidebar/CredentialsPanel").then((m) => ({
    default: m.CredentialsPanel,
  })),
);
const TermixIdPanel = lazy(() =>
  import("@/sidebar/TermixIdPanel").then((m) => ({ default: m.TermixIdPanel })),
);
const ConnectionsPanel = lazy(() =>
  import("@/sidebar/ConnectionsPanel").then((m) => ({
    default: m.ConnectionsPanel,
  })),
);
const AgentIntegrationPanel = lazy(() =>
  import("@/sidebar/AgentIntegrationPanel").then((m) => ({
    default: m.AgentIntegrationPanel,
  })),
);

function SidebarPanelFallback() {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="size-5 rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground/70 animate-spin" />
    </div>
  );
}
import type {
  Tab,
  TabType,
  Host,
  SplitMode,
  HostFolder,
  ThemeId,
  FontSizeId,
  SerialConfig,
  AdminSection,
} from "@/types/ui-types";
import { applyAccentColor, applyFontSize, PANE_COUNTS } from "@/lib/theme";
import { globalShortcutHandler } from "@/lib/global-shortcut-handler";
import { useTheme } from "@/components/theme-provider";
import {
  getSSHHosts,
  getUserInfo,
  getOpenTabs,
  addOpenTab,
  deleteOpenTab,
  detachPinnedOpenTab,
  closeAgentSession,
  upsertOpenTabRecord,
  patchOpenTab,
  createSSHHost,
  deleteSSHHost,
  getActiveSessions,
  getUserPreferences,
  isElectron,
  type UserPreferences,
  type OpenTabRecord,
  type ActiveSessionInfo,
} from "@/main-axios";
import { RemoteSyncBanner } from "@/components/RemoteSyncBanner.tsx";
import { MigrationNoticeDialog } from "@/components/MigrationNoticeDialog.tsx";
import { dbHealthMonitor } from "@/lib/db-health-monitor";
import type { SSHHostWithStatus } from "@/main-axios";
import { ServerStatusProvider } from "@/lib/ServerStatusContext";
import { TransferMonitor } from "@/features/file-manager/TransferMonitor.tsx";
import {
  createHostManagerEditEvent,
  sshHostToHost,
} from "@/sidebar/HostManagerData";
import { resolveHostTabType } from "@/lib/host-connection-tabs";
import { changeAppLanguage } from "@/i18n/i18n";
import { usePageVisibleInterval } from "@/hooks/use-page-visible-interval";
import { hasPendingHostNetworkInfo } from "@/lib/host-network-info";
import { quickConnectHostToPayload } from "@/sidebar/quick-connect-host";
import { WorkspaceProvider, useWorkspace } from "@/workspace/WorkspaceContext";
import { WorkspaceTopbar } from "@/workspace/WorkspaceTopbar";
import { WorkspaceUtilityRail } from "@/workspace/WorkspaceUtilityRail";
import { removeWorkspaceHosts } from "@/workspace/project-host-removal";
import type { TerminalSessionPersistenceState } from "@/features/terminal/terminal-types";
import {
  deleteWorkspaceProjectFolder,
  getWorkspaceProjectFolders,
  getWorkspaceProjectServers,
  moveWorkspaceProjectHosts,
  removeWorkspaceProjectHost,
  renameWorkspaceProjectFolder,
  saveWorkspaceProjectFolder,
} from "@/api/workspace-api";

function buildHostTree(
  hosts: SSHHostWithStatus[],
  folderMeta?: Map<
    string,
    { color?: string; icon?: string; credentialId?: number | null }
  >,
): HostFolder {
  const root: HostFolder = { name: "root", children: [] };
  const folderMap = new Map<string, HostFolder>();
  const getOrCreateFolder = (path: string): HostFolder => {
    if (folderMap.has(path)) return folderMap.get(path)!;
    const parts = path.split(" / ");
    let current = root;
    let accumulated = "";
    for (const part of parts) {
      accumulated = accumulated ? `${accumulated} / ${part}` : part;
      if (!folderMap.has(accumulated)) {
        const meta = folderMeta?.get(accumulated);
        const folder: HostFolder = {
          name: part,
          path: accumulated,
          color: meta?.color,
          icon: meta?.icon,
          credentialId: meta?.credentialId ?? null,
          children: [],
        };
        folderMap.set(accumulated, folder);
        current.children.push(folder);
      }
      current = folderMap.get(accumulated)!;
    }
    return current;
  };
  // Surface empty folders (created but with no hosts yet) so they stay visible.
  if (folderMeta) {
    for (const path of folderMeta.keys()) getOrCreateFolder(path);
  }
  for (const h of hosts) {
    const host = sshHostToHost(h);
    if (h.folder) {
      getOrCreateFolder(h.folder).children.push(host);
    } else {
      root.children.push(host);
    }
  }
  return root;
}
export { tabIcon, renderTabContent } from "@/shell/tabUtils";

type PendingTabClose = {
  kind: "connection" | "pinned" | "agent";
  tabId?: string;
  recordId?: string;
  agentSessionId?: string;
  title: string;
  description?: string;
  confirmLabel: string;
};

// ─── AppShell ────────────────────────────────────────────────────────────────

function AppShellContent({
  username,
  onUsernameChange,
  onLogout,
}: {
  username: string;
  onUsernameChange: (username: string) => void;
  onLogout: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { activeProject, refreshProjects } = useWorkspace();
  const { setTheme } = useTheme();
  const [tabs, setTabs] = useState<Tab[]>([
    {
      id: "dashboard",
      instanceId: "dashboard",
      type: "dashboard",
      label: t("nav.dashboard"),
      openedAt: Date.now(),
    },
  ]);
  const [activeTabId, setActiveTabId] = useState("dashboard");
  const [pinningTabIds, setPinningTabIds] = useState<Set<string>>(new Set());
  const pinToggleInFlightRef = useRef<Set<string>>(new Set());
  const pinnedDetachInFlightRef = useRef<Set<string>>(new Set());
  const pinnedTerminateInFlightRef = useRef<Set<string>>(new Set());
  const agentTerminateInFlightRef = useRef<Set<string>>(new Set());
  const [terminatingAgentSessionIds, setTerminatingAgentSessionIds] = useState<
    Set<string>
  >(new Set());
  const [terminatedAgentSessionIds, setTerminatedAgentSessionIds] = useState<
    Set<string>
  >(new Set());
  const [agentSessionsRefreshVersion, setAgentSessionsRefreshVersion] =
    useState(0);
  const [pendingTabClose, setPendingTabClose] =
    useState<PendingTabClose | null>(null);
  const [userPrefs, setUserPrefs] = useState<UserPreferences>({
    reopenTabsOnLogin: false,
  });
  const [userPrefsLoaded, setUserPrefsLoaded] = useState(false);
  const [hostsLoaded, setHostsLoaded] = useState(false);
  // Flips to true once the initial DB read (restore or skip) is done — sync must not fire before this
  const [tabsReady, setTabsReady] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [splitMode, setSplitMode] = useState<SplitMode>(
    () => (localStorage.getItem("termix_splitMode") as SplitMode) ?? "none",
  );
  // paneTabIds holds live tab.id values, which change on every restore, so we
  // can't restore it from storage directly. It starts empty and gets filled in
  // once by the reconciliation effect below, keyed off the stable instanceId
  // values saved in termix_paneInstanceIds.
  const [paneTabIds, setPaneTabIds] = useState<(string | null)[]>(() =>
    Array(6).fill(null),
  );
  const paneLayoutRestoredRef = useRef(false);
  useEffect(() => {
    paneTabIdsRef.current = paneTabIds;
  }, [paneTabIds]);
  const [focusedPaneIndex, setFocusedPaneIndex] = useState<number | null>(null);
  const [realHostTree, setRealHostTree] = useState<HostFolder | null>(null);
  const [hostsLoading, setHostsLoading] = useState(true);
  const [allHosts, setAllHosts] = useState<Host[]>([]);
  const [projectHostIdsByHostId, setProjectHostIdsByHostId] = useState<
    Map<string, number>
  >(new Map());
  const activeProjectIdRef = useRef(activeProject.id);
  activeProjectIdRef.current = activeProject.id;
  const [isAdmin, setIsAdmin] = useState(false);
  // Remote sync is not yet configurable (added in a later phase), so this
  // is always false for now -- admin/user-management UI stays hidden until
  // the desktop app is connected to a remote Termix server, since a
  // standalone local install has exactly one implicit user and nothing to
  // administer.
  const [isRemoteSyncConnected] = useState(false);
  const showMultiUserUI = isAdmin && (!isElectron() || isRemoteSyncConnected);
  const [backgroundTabRecords, setBackgroundTabRecords] = useState<
    OpenTabRecord[]
  >([]);

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [railView, setRailView] = useState<RailView>("hosts");
  const adminFocusRequestId = useRef(0);
  const [adminFocusRequest, setAdminFocusRequest] = useState<{
    section: AdminSection;
    requestId: number;
  } | null>(null);
  const [remoteSyncInitialServerUrl, setRemoteSyncInitialServerUrl] = useState<
    string | undefined
  >(undefined);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem("termix_sidebarWidth");
    return saved ? parseInt(saved, 10) : 291;
  });
  const [sidebarDragging, setSidebarDragging] = useState(false);
  const [sidebarEditing, setSidebarEditing] = useState(false);
  const [isAppFullscreen, setIsAppFullscreen] = useState(
    () => !!document.fullscreenElement,
  );

  useEffect(() => {
    localStorage.setItem("termix_sidebarWidth", String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    localStorage.setItem("termix_splitMode", splitMode);
  }, [splitMode]);

  useEffect(() => {
    // Don't overwrite the saved layout with the empty initial state before
    // reconciliation has had a chance to restore it.
    if (!paneLayoutRestoredRef.current) return;
    const instanceIds = paneTabIds.map((id) => {
      if (id == null) return null;
      return tabs.find((t) => t.id === id)?.instanceId ?? null;
    });
    localStorage.setItem("termix_paneInstanceIds", JSON.stringify(instanceIds));
  }, [paneTabIds, tabs]);

  const isMobile = useIsMobile();

  const sidebarOpenBeforeMobile = useRef(sidebarOpen);
  useEffect(() => {
    if (isMobile) {
      sidebarOpenBeforeMobile.current = sidebarOpen;
      setSidebarOpen(false);
    } else {
      setSidebarOpen(sidebarOpenBeforeMobile.current);
    }
  }, [isMobile]);

  useEffect(() => {
    getUserInfo()
      .then((info) => {
        setIsAdmin(info.is_admin);
      })
      .catch(() => setIsAdmin(false));
  }, []);

  const toggleAppFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }

      if (!document.fullscreenEnabled) {
        toast.error("Fullscreen is not supported by this browser");
        return;
      }

      await document.documentElement.requestFullscreen();
    } catch {
      toast.error("Unable to toggle fullscreen mode");
    }
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsAppFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  const lastShiftTime = useRef(0);
  const tabsRef = useRef(tabs);
  const activeTabIdRef = useRef(activeTabId);
  const splitModeRef = useRef(splitMode);
  const focusedPaneIndexRef = useRef<number | null>(null);
  const paneContentElsRef = useRef<(HTMLDivElement | null)[]>(
    Array(6).fill(null),
  );
  const paneTabIdsRef = useRef<(string | null)[]>(Array(6).fill(null));
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);
  useEffect(() => {
    splitModeRef.current = splitMode;
  }, [splitMode]);
  useEffect(() => {
    focusedPaneIndexRef.current = focusedPaneIndex;
  }, [focusedPaneIndex]);
  const [commandPaletteShortcutEnabled, setCommandPaletteShortcutEnabled] =
    useState<boolean>(() => {
      const v = localStorage.getItem("commandPaletteShortcutEnabled");
      return v !== null ? v === "true" : true;
    });
  const terminalRefs = useRef<Map<string, ReturnType<typeof createRef>>>(
    new Map(),
  );
  const [paneContentEls, setPaneContentEls] = useState<
    (HTMLDivElement | null)[]
  >(Array(6).fill(null));
  useEffect(() => {
    paneContentElsRef.current = paneContentEls;
  }, [paneContentEls]);

  // Stable per-tab DOM nodes — created once per tab, never destroyed while the tab lives.
  // We always portal each tab's content into its own node, then move that node between
  // the normal-view container and the pane container via vanilla DOM so React's portal
  // target never changes (changing the target causes a remount).
  const tabNodesRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const normalViewRef = useRef<HTMLDivElement>(null);

  const getTabNode = useCallback((tabId: string, isTerminal: boolean) => {
    if (!tabNodesRef.current.has(tabId)) {
      const el = document.createElement("div");
      el.style.position = "absolute";
      el.style.inset = "0";
      el.style.overflow = "hidden";
      if (!isTerminal) el.classList.add("bg-background");
      tabNodesRef.current.set(tabId, el);
    }
    return tabNodesRef.current.get(tabId)!;
  }, []);

  const onPaneContentRef = useCallback(
    (paneIndex: number, el: HTMLDivElement | null) => {
      setPaneContentEls((prev) => {
        if (prev[paneIndex] === el) return prev;
        const next = [...prev];
        next[paneIndex] = el;
        return next;
      });
    },
    [],
  );

  const sidebarTitle: Record<RailView, string> = {
    hosts: t("nav.hosts"),
    "agent-integration": t("nav.agentIntegration"),
    credentials: t("nav.credentials"),
    "termix-id": t("nav.termixId"),
    "quick-connect": t("nav.quickConnect"),
    serial: t("nav.serial"),
    "ssh-tools": t("nav.sshTools"),
    snippets: t("nav.snippets"),
    history: t("nav.history"),
    "session-logs": t("nav.sessionLogs"),
    "split-screen": t("nav.splitScreen"),
    connections: t("nav.connections"),
    "user-profile": t("nav.userProfile"),
    "admin-settings": t("nav.admin"),
    alerts: t("nav.alerts"),
  };

  // Double-shift opens command palette
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === "ShiftLeft" && !e.repeat) {
        const now = Date.now();
        if (now - lastShiftTime.current < 300 && commandPaletteShortcutEnabled)
          setCommandPaletteOpen((prev) => !prev);
        lastShiftTime.current = now;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [commandPaletteShortcutEnabled]);

  // Split-screen and tab navigation hotkeys
  // Also registered in globalShortcutHandler so xterm can invoke directly
  // without going through synthetic DOM events (which are unreliable).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
        if (e.code === "KeyF") {
          e.preventDefault();
          toggleAppFullscreen();
          return;
        }
      }

      // Ctrl+Shift+\ — toggle 2-way split (side by side)
      if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === "Backslash") {
        e.preventDefault();
        if (splitModeRef.current !== "none") {
          splitModeRef.current = "none";
          setSplitMode("none");
          setPaneTabIds(Array(6).fill(null));
        } else {
          const mode = "2-way";
          splitModeRef.current = mode;
          const currentTabs = tabsRef.current;
          const currentActiveId = activeTabIdRef.current;
          const count = PANE_COUNTS[mode];
          const next: (string | null)[] = Array(6).fill(null);
          next[0] = currentActiveId;
          let slot = 1;
          for (const tab of currentTabs) {
            if (slot >= count) break;
            if (tab.id !== currentActiveId && tab.type !== "dashboard") {
              next[slot] = tab.id;
              slot++;
            }
          }
          setSplitMode(mode);
          setPaneTabIds(next);
        }
        return;
      }

      // Ctrl+Shift+- — toggle 3-way-horizontal split (top/bottom)
      if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === "Minus") {
        e.preventDefault();
        if (splitModeRef.current !== "none") {
          splitModeRef.current = "none";
          setSplitMode("none");
          setPaneTabIds(Array(6).fill(null));
        } else {
          const mode = "3-way-horizontal";
          splitModeRef.current = mode;
          const currentTabs = tabsRef.current;
          const currentActiveId = activeTabIdRef.current;
          const count = PANE_COUNTS[mode];
          const next: (string | null)[] = Array(6).fill(null);
          next[0] = currentActiveId;
          let slot = 1;
          for (const tab of currentTabs) {
            if (slot >= count) break;
            if (tab.id !== currentActiveId && tab.type !== "dashboard") {
              next[slot] = tab.id;
              slot++;
            }
          }
          setSplitMode(mode);
          setPaneTabIds(next);
        }
        return;
      }

      // Alt+Arrow — navigate between panes in split mode
      if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
        if (
          e.code === "ArrowLeft" ||
          e.code === "ArrowRight" ||
          e.code === "ArrowUp" ||
          e.code === "ArrowDown"
        ) {
          if (splitModeRef.current === "none") return;
          const count = PANE_COUNTS[splitModeRef.current];
          if (count < 2) return;
          e.preventDefault();
          const current = focusedPaneIndexRef.current ?? 0;
          const mode = splitModeRef.current;
          const dir = e.code;

          // Layout-aware navigation maps: [left, right, up, down] per pane index.
          // null means no movement in that direction.
          const navMap: Record<string, (number | null)[][]> = {
            "2-way": [
              [null, 1, null, null],
              [0, null, null, null],
            ],
            "3-way": [
              [null, 1, null, null],
              [0, null, null, 2],
              [0, null, 1, null],
            ],
            "3-way-horizontal": [
              [null, 1, null, 2],
              [0, null, null, 2],
              [null, null, 0, null],
            ],
            "4-way": [
              [null, 1, null, 2],
              [0, null, null, 3],
              [null, 3, 0, null],
              [2, null, 1, null],
            ],
            "5-way": [
              [null, 1, null, 3],
              [0, 2, null, 4],
              [1, null, null, 4],
              [null, 4, 0, null],
              [3, null, 1, null],
            ],
            "6-way": [
              [null, 1, null, 3],
              [0, 2, null, 4],
              [1, null, null, 5],
              [null, 4, 0, null],
              [3, 5, 1, null],
              [4, null, 2, null],
            ],
          };

          const paneNav = navMap[mode]?.[current];
          const dirIndex =
            { ArrowLeft: 0, ArrowRight: 1, ArrowUp: 2, ArrowDown: 3 }[dir] ??
            -1;
          const next = paneNav?.[dirIndex] ?? null;
          if (next === null) return;

          focusedPaneIndexRef.current = next;
          setFocusedPaneIndex(next);
          // Physically move DOM focus into the target pane's terminal
          const tabId = paneTabIdsRef.current[next];
          if (tabId) {
            const termRef = terminalRefs.current.get(tabId);
            (
              termRef?.current as
                | import("@/features/terminal/Terminal").TerminalHandle
                | null
            )?.focus();
          }
          return;
        }
      }

      // Ctrl+Shift+] / Ctrl+Shift+[ — cycle through open tabs (] = next, [ = previous)
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
        if (e.code === "BracketRight" || e.code === "BracketLeft") {
          e.preventDefault();
          const currentTabs = tabsRef.current;
          if (currentTabs.length < 2) return;
          const currentId = activeTabIdRef.current;
          const idx = currentTabs.findIndex((t) => t.id === currentId);
          const next =
            e.code === "BracketRight"
              ? (idx + 1) % currentTabs.length
              : (idx - 1 + currentTabs.length) % currentTabs.length;
          setActiveTabId(currentTabs[next].id);
          return;
        }
      }
    };

    globalShortcutHandler.current = handleKeyDown;
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      globalShortcutHandler.current = null;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    const handler = () => {
      const v = localStorage.getItem("commandPaletteShortcutEnabled");
      setCommandPaletteShortcutEnabled(v !== null ? v === "true" : true);
    };
    window.addEventListener("commandPaletteShortcutEnabledChanged", handler);
    return () =>
      window.removeEventListener(
        "commandPaletteShortcutEnabledChanged",
        handler,
      );
  }, []);

  useEffect(() => {
    const handle = () => onLogout();
    window.addEventListener("termix:logout", handle);
    return () => window.removeEventListener("termix:logout", handle);
  }, [onLogout]);

  useEffect(() => {
    const handleSessionExpired = () => onLogout();
    dbHealthMonitor.on("session-expired", handleSessionExpired);
    return () => dbHealthMonitor.off("session-expired", handleSessionExpired);
  }, [onLogout]);

  useEffect(() => {
    const activeTab = tabs.find((t) => t.id === activeTabId);
    if (!activeTab?.terminalRef) return;
    let innerRafId: number;
    const outerRafId = requestAnimationFrame(() => {
      innerRafId = requestAnimationFrame(() => {
        const ref = activeTab.terminalRef?.current;
        ref?.fit?.();
        ref?.notifyResize?.();
        ref?.refresh?.();
      });
    });
    return () => {
      cancelAnimationFrame(outerRafId);
      cancelAnimationFrame(innerRafId);
    };
  }, [activeTabId]);

  useEffect(() => {
    const handleDegraded = () => {
      toast.loading(t("common.connectionDegraded"), {
        id: "db-connection-degraded",
        duration: Infinity,
        dismissible: false,
        action: {
          label: t("common.reload"),
          onClick: () => window.location.reload(),
        },
      });
    };

    const handleRestored = () => {
      toast.dismiss("db-connection-degraded");
      toast.success(t("common.backendReconnected"), { duration: 3000 });
    };

    dbHealthMonitor.on("database-connection-degraded", handleDegraded);
    dbHealthMonitor.on("database-connection-degraded-cleared", handleRestored);

    return () => {
      dbHealthMonitor.off("database-connection-degraded", handleDegraded);
      dbHealthMonitor.off(
        "database-connection-degraded-cleared",
        handleRestored,
      );
    };
  }, [t]);

  useEffect(() => {
    getUserPreferences()
      .then((prefs) => {
        setUserPrefs(prefs);
        if (prefs.storageMode === "cloud") {
          // Persist the current browser values before overwriting, so any tab can restore them
          if (!localStorage.getItem("termix-local-snapshot")) {
            const SNAPSHOT_KEYS = [
              "termix-accent",
              "termix-font-size",
              "i18nextLng",
              "commandAutocomplete",
              "commandPaletteShortcutEnabled",
              "showHostTags",
              "hostTrayOnClick",
              "pinAppRail",
              "expandAppRailOnHover",
              "defaultSnippetFoldersCollapsed",
              "confirmSnippetExecution",
              "disableUpdateCheck",
              "confirmTabClose",
              "hiddenRailTabs",
            ];
            const snap: Record<string, string | null> = {
              __theme: localStorage.getItem("termix-theme"),
            };
            for (const key of SNAPSHOT_KEYS)
              snap[key] = localStorage.getItem(key);
            localStorage.setItem("termix-local-snapshot", JSON.stringify(snap));
          }
          if (prefs.theme) setTheme(prefs.theme as ThemeId);
          if (prefs.fontSize) applyFontSize(prefs.fontSize as FontSizeId);
          if (prefs.accentColor) {
            localStorage.setItem("termix-accent", prefs.accentColor);
            applyAccentColor(prefs.accentColor);
          }
          if (prefs.language && prefs.language !== i18n.language) {
            void changeAppLanguage(prefs.language);
          }
          if (
            prefs.commandAutocomplete !== null &&
            prefs.commandAutocomplete !== undefined
          )
            localStorage.setItem(
              "commandAutocomplete",
              String(prefs.commandAutocomplete),
            );
          if (
            prefs.commandPaletteEnabled !== null &&
            prefs.commandPaletteEnabled !== undefined
          )
            localStorage.setItem(
              "commandPaletteShortcutEnabled",
              String(prefs.commandPaletteEnabled),
            );
          if (prefs.showHostTags !== null && prefs.showHostTags !== undefined) {
            localStorage.setItem("showHostTags", String(prefs.showHostTags));
            window.dispatchEvent(new CustomEvent("showHostTagsChanged"));
          }
          if (
            prefs.hostTrayOnClick !== null &&
            prefs.hostTrayOnClick !== undefined
          )
            localStorage.setItem(
              "hostTrayOnClick",
              String(prefs.hostTrayOnClick),
            );
          if (prefs.pinAppRail !== null && prefs.pinAppRail !== undefined) {
            localStorage.setItem("pinAppRail", String(prefs.pinAppRail));
            window.dispatchEvent(new Event("pinAppRailChanged"));
          }
          if (
            prefs.expandAppRailOnHover !== null &&
            prefs.expandAppRailOnHover !== undefined
          ) {
            localStorage.setItem(
              "expandAppRailOnHover",
              String(prefs.expandAppRailOnHover),
            );
            window.dispatchEvent(new Event("expandAppRailOnHoverChanged"));
          }
          if (
            prefs.foldersCollapsed !== null &&
            prefs.foldersCollapsed !== undefined
          )
            localStorage.setItem(
              "defaultSnippetFoldersCollapsed",
              String(prefs.foldersCollapsed),
            );
          if (
            prefs.confirmSnippetExecution !== null &&
            prefs.confirmSnippetExecution !== undefined
          )
            localStorage.setItem(
              "confirmSnippetExecution",
              String(prefs.confirmSnippetExecution),
            );
          if (
            prefs.disableUpdateCheck !== null &&
            prefs.disableUpdateCheck !== undefined
          )
            localStorage.setItem(
              "disableUpdateCheck",
              String(prefs.disableUpdateCheck),
            );
          if (
            prefs.confirmTabClose !== null &&
            prefs.confirmTabClose !== undefined
          )
            localStorage.setItem(
              "confirmTabClose",
              String(prefs.confirmTabClose),
            );
          if (
            prefs.hiddenRailTabs !== null &&
            prefs.hiddenRailTabs !== undefined
          ) {
            localStorage.setItem("hiddenRailTabs", prefs.hiddenRailTabs);
            window.dispatchEvent(new CustomEvent("hiddenRailTabsChanged"));
          }
        }
      })
      .catch(() => {})
      .finally(() => setUserPrefsLoaded(true));
  }, []);

  // Load real hosts from API
  const loadHosts = useCallback(
    async (background = false) => {
      const requestedProjectId = activeProject.id;
      if (!background) {
        // 项目切换时立即清空上一项目的树，避免异步加载期间短暂显示错项目资产。
        setHostsLoading(true);
        setRealHostTree(null);
        setAllHosts([]);
        setProjectHostIdsByHostId(new Map());
      }
      try {
        const [raw, projectServers, folders] = await Promise.all([
          getSSHHosts(),
          getWorkspaceProjectServers(requestedProjectId),
          getWorkspaceProjectFolders(requestedProjectId),
        ]);
        if (activeProjectIdRef.current !== requestedProjectId) return;
        const projectServerByHostId = new Map(
          projectServers.map((server) => [String(server.hostId), server]),
        );
        const visibleRaw = raw
          .filter((host) => projectServerByHostId.has(String(host.id)))
          .map((host) => {
            const projectServer = projectServerByHostId.get(String(host.id));
            return {
              ...host,
              projectHostId: projectServer?.projectHostId,
              sourceName: host.name,
              sourceFolder: host.folder ?? "",
              name: projectServer?.name || host.name,
              folder: projectServer?.folder ?? "",
              networkInfo: projectServer?.networkInfo ?? host.networkInfo,
              linkedProjectCount: projectServer?.linkedProjectCount ?? 1,
              canDeleteFromAllProjects:
                projectServer?.canDeleteFromAllProjects ?? !host.isShared,
            };
          });
        const converted = visibleRaw.map(sshHostToHost);
        setAllHosts(converted);
        setProjectHostIdsByHostId(
          new Map(
            projectServers.map((server) => [
              String(server.hostId),
              server.projectHostId,
            ]),
          ),
        );
        const folderMeta = new Map<
          string,
          { color?: string; icon?: string; credentialId?: number | null }
        >();
        for (const f of folders) {
          folderMeta.set(f.path, {
            color: f.color ?? undefined,
            icon: f.icon ?? undefined,
            credentialId: null,
          });
        }
        setRealHostTree(buildHostTree(visibleRaw, folderMeta));
      } catch {
        // 首次加载保持空状态；后台补查失败时保留当前主机树。
      } finally {
        if (!background && activeProjectIdRef.current === requestedProjectId) {
          setHostsLoading(false);
          setHostsLoaded(true);
        }
      }
    },
    [activeProject.id],
  );

  const canManageProjectFolders = [
    "instance_admin",
    "team_admin",
    "project_admin",
  ].includes(activeProject.role);

  const projectHostRemovalMetadata = new Map(
    allHosts.map((host) => [
      String(host.id),
      {
        linkedProjectCount: host.linkedProjectCount ?? 1,
        canDeleteFromAllProjects: host.canDeleteFromAllProjects === true,
      },
    ]),
  );

  const projectFolderActions = {
    canManage: canManageProjectFolders,
    removeHosts: async (
      hostIds: string[],
      scope: "current-project" | "all-projects",
    ) => {
      await removeWorkspaceHosts({
        projectId: activeProject.id,
        hostIds,
        scope,
        projectHostIdsByHostId,
        hostRemovalMetadataByHostId: projectHostRemovalMetadata,
        deleteHost: deleteSSHHost,
        unlinkHost: removeWorkspaceProjectHost,
      });
    },
    moveHosts: async (hostIds: string[], targetPath: string) => {
      const projectHostIds = hostIds.map((hostId) =>
        projectHostIdsByHostId.get(String(hostId)),
      );
      if (projectHostIds.some((id) => id === undefined)) {
        throw new Error("Project host mapping is unavailable");
      }
      await moveWorkspaceProjectHosts(
        activeProject.id,
        projectHostIds as number[],
        targetPath || null,
      );
    },
    saveFolder: async ({
      oldPath,
      path,
      color,
      icon,
    }: {
      oldPath?: string;
      path: string;
      color: string;
      icon: string;
    }) => {
      if (oldPath && oldPath !== path) {
        await renameWorkspaceProjectFolder(activeProject.id, oldPath, path);
      }
      await saveWorkspaceProjectFolder(activeProject.id, {
        path,
        color,
        icon,
      });
    },
    deleteFolder: async (path: string) => {
      await deleteWorkspaceProjectFolder(activeProject.id, path);
    },
  };

  useEffect(() => {
    loadHosts();
  }, [loadHosts]);

  usePageVisibleInterval(
    () => void loadHosts(true),
    3_000,
    hasPendingHostNetworkInfo(allHosts),
    { runOnMount: false },
  );

  useEffect(() => {
    const onHostsChanged = () => {
      void loadHosts();
    };
    window.addEventListener("termix:hosts-changed", onHostsChanged);
    window.addEventListener("ssh-hosts:changed", onHostsChanged);
    window.addEventListener("hosts:refresh", onHostsChanged);
    return () => {
      window.removeEventListener("termix:hosts-changed", onHostsChanged);
      window.removeEventListener("ssh-hosts:changed", onHostsChanged);
      window.removeEventListener("hosts:refresh", onHostsChanged);
    };
  }, [loadHosts]);

  // Sync tab host data when allHosts updates (e.g. after editing terminal theme in host settings)
  useEffect(() => {
    if (allHosts.length === 0) return;
    setTabs((prev) =>
      prev.map((t) =>
        t.host
          ? { ...t, host: allHosts.find((h) => h.id === t.host!.id) ?? t.host }
          : t,
      ),
    );
  }, [allHosts]);

  // Let HostManager trigger tab opens via custom event
  useEffect(() => {
    const handle = (e: Event) => {
      const { hostId, type } = (
        e as CustomEvent<{ hostId: string; type?: TabType }>
      ).detail;
      const host = allHosts.find((h) => h.id === hostId);
      if (host) connectHost(host, type);
    };
    window.addEventListener("termix:open-tab", handle);
    return () => window.removeEventListener("termix:open-tab", handle);
  }, [allHosts]);

  const PERSISTENT_TAB_TYPES: TabType[] = [
    "terminal",
    "rdp",
    "vnc",
    "telnet",
    "files",
    "docker",
    "host-metrics",
    "tunnel",
  ];

  // On load: always read saved tabs from DB so background sessions are preserved across refreshes.
  // If reopenTabsOnLogin is on, also restore them as open tabs in the tab bar.
  const tabRestoreAttemptedRef = useRef(false);
  useEffect(() => {
    if (!hostsLoaded || !userPrefsLoaded) return;
    if (tabRestoreAttemptedRef.current) return;
    tabRestoreAttemptedRef.current = true;

    async function loadSavedTabs() {
      try {
        const [savedTabs, activeSessions] = await Promise.all([
          getOpenTabs(),
          getActiveSessions(),
        ]);

        if (!Array.isArray(savedTabs) || savedTabs.length === 0) return;

        const sessionByInstanceId = new Map(
          (Array.isArray(activeSessions) ? activeSessions : [])
            .filter((s) => s.tabInstanceId != null)
            .map((s) => [s.tabInstanceId, s]),
        );

        if (userPrefs.reopenTabsOnLogin) {
          const hasPersistentTabs = tabs.some((t) =>
            PERSISTENT_TAB_TYPES.includes(t.type),
          );
          if (!hasPersistentTabs) {
            const restoredTabs: Tab[] = [];
            for (const saved of savedTabs as OpenTabRecord[]) {
              const host = saved.hostId
                ? allHosts.find((h) => h.id === String(saved.hostId))
                : undefined;
              const hostlessTypes: TabType[] = ["dashboard", "tunnel"];
              if (!host && !hostlessTypes.includes(saved.tabType as TabType))
                continue;

              if (host) {
                if (saved.tabType === "terminal" && !host.enableSsh) continue;
                if (saved.tabType === "rdp" && !host.enableRdp) continue;
                if (saved.tabType === "vnc" && !host.enableVnc) continue;
                if (saved.tabType === "telnet" && !host.enableTelnet) continue;
              }

              // Singleton tabs use their type as the stable ID; host-bound tabs get a unique ID
              const tabId = host
                ? `${host.name}-${saved.tabType}-${Date.now()}-${saved.tabOrder}`
                : saved.id;
              const liveSession = sessionByInstanceId.get(saved.id);
              const restoredSessionId =
                liveSession?.sessionId ?? saved.backendSessionId ?? null;

              const isCustomLabel =
                host &&
                saved.label !== host.name &&
                !/^.+ \(\d+\)$/.test(saved.label);

              restoredTabs.push({
                id: tabId,
                instanceId: saved.id,
                type: saved.tabType as TabType,
                label: saved.label,
                customLabel: isCustomLabel ? saved.label : undefined,
                host,
                openedAt: new Date(saved.createdAt).getTime(),
                restoredSessionId,
                sessionPinned:
                  liveSession?.sessionPinned ?? saved.sessionPinned ?? false,
                sessionManagedTmux:
                  liveSession?.sessionManagedTmux ??
                  Boolean(saved.sessionPinned && saved.tmuxSessionName),
                persistentSessionId: restoredSessionId,
                persistentTmuxSessionName:
                  liveSession?.tmuxSessionName ?? saved.tmuxSessionName ?? null,
                terminalRef: SESSION_TAB_TYPES.includes(
                  saved.tabType as TabType,
                )
                  ? createRef()
                  : undefined,
              });
            }

            if (restoredTabs.length > 0) {
              setTabs((prev) => {
                const existingIds = new Set(prev.map((t) => t.id));
                const newTabs = restoredTabs.filter(
                  (t) => !existingIds.has(t.id),
                );
                return newTabs.length > 0 ? [...prev, ...newTabs] : prev;
              });
              setActiveTabId(restoredTabs[0].id);
            }
            // Restored tabs are in the tab bar, not in background records
          }
        } else {
          // Not restoring to tab bar — keep as background records for ConnectionsPanel
          setBackgroundTabRecords(savedTabs as OpenTabRecord[]);
        }
      } catch {
        // silently fail
      } finally {
        setTabsReady(true);
      }
    }

    loadSavedTabs();
  }, [hostsLoaded, userPrefsLoaded]);

  // Restore split-screen pane assignments once tabs are settled. Saved assignments are
  // keyed by instanceId (stable across reloads) and remapped to the live tab.id here,
  // since tab.id is regenerated every time a tab is (re)opened.
  useEffect(() => {
    if (!tabsReady || paneLayoutRestoredRef.current) return;
    paneLayoutRestoredRef.current = true;

    try {
      const savedInstanceIds: (string | null)[] = JSON.parse(
        localStorage.getItem("termix_paneInstanceIds") ?? "null",
      );
      if (!Array.isArray(savedInstanceIds)) return;

      const restored = savedInstanceIds.map((instanceId) => {
        if (instanceId == null) return null;
        return tabs.find((t) => t.instanceId === instanceId)?.id ?? null;
      });
      if (restored.some((id) => id != null)) {
        setPaneTabIds(restored);
      } else {
        // None of the saved panes could be restored (e.g. reopen-tabs-on-login
        // is disabled), so drop back to a single view instead of an empty split.
        setSplitMode("none");
      }
    } catch {
      // silently fail
    }
  }, [tabsReady, tabs]);

  // Debounced tab-order sync: when tab order changes, patch each persistent tab's tabOrder in DB.
  const orderSyncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const prevTabOrderRef = useRef<string>("");
  useEffect(() => {
    if (!tabsReady) return;
    const persistable = tabs.filter(
      (t) => PERSISTENT_TAB_TYPES.includes(t.type) && !t.agentSessionId,
    );
    const orderKey = persistable.map((t) => t.instanceId).join(",");
    if (orderKey === prevTabOrderRef.current) return;
    prevTabOrderRef.current = orderKey;

    if (orderSyncTimeoutRef.current) clearTimeout(orderSyncTimeoutRef.current);
    orderSyncTimeoutRef.current = setTimeout(() => {
      persistable.forEach((t, i) => {
        patchOpenTab(t.instanceId, { tabOrder: i }).catch(() => {});
      });
    }, 500);

    return () => {
      if (orderSyncTimeoutRef.current)
        clearTimeout(orderSyncTimeoutRef.current);
    };
  }, [tabs, tabsReady]);

  // ─── Tab management ──────────────────────────────────────────────────────

  const openTab = useCallback(function openTab(
    host: Host,
    type: TabType,
    restore?: {
      instanceId: string;
      restoredSessionId: string | null;
      savedLabel?: string;
      initialFilePath?: string;
      serialConfig?: SerialConfig;
      sessionManagedTmux?: boolean;
      joinSharedSessionId?: string | null;
      joinShareId?: string | null;
      agentSessionId?: string | null;
      sessionPinned?: boolean;
      tmuxSessionName?: string | null;
    },
  ) {
    const tabId = `${host.name}-${type}-${Date.now()}`;
    const instanceId =
      restore?.instanceId ??
      (typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);
    const openedAt = Date.now();
    const ref = SESSION_TAB_TYPES.includes(type) ? createRef() : undefined;
    if (ref) terminalRefs.current.set(tabId, ref);

    let finalLabel = host.name;
    const savedLabel = restore?.savedLabel;
    const initialFilePath = restore?.initialFilePath;
    const serialConfig = restore?.serialConfig;
    const joinSharedSessionId = restore?.joinSharedSessionId ?? null;
    const joinShareId = restore?.joinShareId ?? null;
    const agentSessionId = restore?.agentSessionId ?? null;
    // A saved label that doesn't match the bare host name or the auto-numbered pattern is a custom label
    const isCustomLabel =
      savedLabel != null &&
      savedLabel !== host.name &&
      !/^.+ \(\d+\)$/.test(savedLabel);

    setTabs((prev) => {
      if (isCustomLabel && savedLabel) {
        finalLabel = savedLabel;
        return [
          ...prev,
          {
            id: tabId,
            instanceId,
            type,
            label: finalLabel,
            customLabel: finalLabel,
            host,
            openedAt,
            sessionManagedTmux:
              restore?.sessionManagedTmux ??
              Boolean(restore?.sessionPinned && restore?.tmuxSessionName),
            terminalRef: ref,
            restoredSessionId: restore?.restoredSessionId ?? null,
            sessionPinned: restore?.sessionPinned ?? false,
            persistentSessionId: restore?.restoredSessionId ?? null,
            persistentTmuxSessionName: restore?.tmuxSessionName ?? null,
            joinSharedSessionId,
            joinShareId,
            agentSessionId,
            initialFilePath,
            serialConfig,
          },
        ];
      }

      const same = prev.filter(
        (t) =>
          t.type === type && t.label.replace(/ \(\d+\)$/, "") === host.name,
      );
      finalLabel =
        same.length === 0 ? host.name : `${host.name} (${same.length + 1})`;

      // Retrofit the first duplicate's label to "(1)" if needed
      const next =
        same.length === 1 && !/\(\d+\)$/.test(same[0].label)
          ? prev.map((t) =>
              t.id === same[0].id ? { ...t, label: `${host.name} (1)` } : t,
            )
          : prev;

      return [
        ...next,
        {
          id: tabId,
          instanceId,
          type,
          label: finalLabel,
          host,
          openedAt,
          sessionManagedTmux:
            restore?.sessionManagedTmux ??
            Boolean(restore?.sessionPinned && restore?.tmuxSessionName),
          terminalRef: ref,
          restoredSessionId: restore?.restoredSessionId ?? null,
          sessionPinned: restore?.sessionPinned ?? false,
          persistentSessionId: restore?.restoredSessionId ?? null,
          persistentTmuxSessionName: restore?.tmuxSessionName ?? null,
          joinSharedSessionId,
          joinShareId,
          agentSessionId,
          initialFilePath,
          serialConfig,
        },
      ];
    });
    setActiveTabId(tabId);

    // Agent 会话 ID 不属于 user_open_tabs 的持久化字段；如果把它写入，
    // 刷新后会退化为普通 SSH 连接并丢失原 Agent tmux 关联。Agent 标签
    // 由连接列表/项目概览重新发现，因此只保留在当前页面内存中。
    if (PERSISTENT_TAB_TYPES.includes(type) && !agentSessionId) {
      addOpenTab({
        id: instanceId,
        tabType: type,
        hostId: host ? parseInt(host.id) : null,
        label: finalLabel,
        tabOrder: 0,
      }).catch(() => {});
    }
  }, []);

  function connectHost(host: Host, preferredType?: TabType) {
    const type = resolveHostTabType(host, preferredType);
    // --- tmux-monitor --- singleton tab, not a per-host tab
    if (type === "tmux_monitor") {
      openSingletonTab(type, undefined, host);
      return;
    }
    openTab(host, type);
  }

  const openAgentSessionTab = useCallback(
    (host: Host, agentSessionId: string, label?: string) => {
      const existing = tabs.find(
        (tab) => tab.agentSessionId === agentSessionId,
      );
      if (existing) {
        setActiveTabId(existing.id);
        if (isMobile) setSidebarOpen(false);
        return;
      }
      const instanceId =
        typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      openTab(host, "terminal", {
        instanceId,
        restoredSessionId: null,
        agentSessionId,
        savedLabel: label ? `${label} · Agent` : `${host.name} · Agent`,
      });
      if (isMobile) setSidebarOpen(false);
    },
    [isMobile, openTab, tabs],
  );

  const saveQuickConnectHost = useCallback(
    async (tab: Tab, host: Host) => {
      try {
        const savedHost = await createSSHHost(
          quickConnectHostToPayload(host),
          activeProject.id,
        );
        await patchOpenTab(tab.instanceId, { hostId: savedHost.id });
        const persistentHost = sshHostToHost({
          ...savedHost,
          status: "unknown",
        });
        setTabs((previous) =>
          previous.map((item) =>
            item.instanceId === tab.instanceId
              ? { ...item, host: persistentHost }
              : item,
          ),
        );
        setBackgroundTabRecords((previous) =>
          previous.map((item) =>
            item.id === tab.instanceId
              ? { ...item, hostId: savedHost.id }
              : item,
          ),
        );
        await refreshProjects().catch(() => undefined);
        window.dispatchEvent(new CustomEvent("termix:hosts-changed"));
        toast.success(t("hosts.hostCreated"));
      } catch (error) {
        toast.error(t("hosts.failedToSave"));
        throw error;
      }
    },
    [activeProject.id, refreshProjects, t],
  );

  function openSerialTab(config: SerialConfig) {
    const pseudoHost: Host = {
      id: `serial-${Date.now()}`,
      name: config.path
        ? `${config.path} (${config.baudRate})`
        : `Serial (${config.baudRate})`,
      username: "",
      ip: "",
      port: 0,
      folder: "",
      online: false,
      cpu: null,
      ram: null,
      lastAccess: new Date().toISOString(),
      authType: "none",
      enableTerminal: false,
      enableCommandHistory: false,
      enableTunnel: false,
      enableFileManager: false,
      enableDocker: false,
      enableProxmox: false,
      enableTmuxMonitor: false,
      enableSsh: false,
      enableRdp: false,
      enableVnc: false,
      enableTelnet: false,
      sshPort: 22,
      rdpPort: 3389,
      vncPort: 5900,
      telnetPort: 23,
      serverTunnels: [],
      quickActions: [],
    };
    const instanceId =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    openTab(pseudoHost, "serial", {
      instanceId,
      restoredSessionId: null,
      serialConfig: config,
    });
  }

  const openSingletonTab = useCallback(
    // --- tmux-monitor --- (added optional `host` so tmux_monitor can open
    // with a preselected host; existing callers are unaffected)
    function openSingletonTab(
      type: TabType,
      pendingEvent?: string,
      host?: Host,
    ) {
      if (type === "host-manager") {
        if (pendingEvent === "host-manager:add-credential") {
          setSidebarOpen(true);
          setRailView("credentials");
          setTimeout(
            () =>
              window.dispatchEvent(
                new CustomEvent("host-manager:add-credential"),
              ),
            0,
          );
        } else if (pendingEvent === "host-manager:show-credentials") {
          setSidebarOpen(true);
          setRailView("credentials");
        } else {
          setSidebarOpen(true);
          setRailView("hosts");
          if (pendingEvent) {
            setTimeout(
              () => window.dispatchEvent(new CustomEvent(pendingEvent)),
              0,
            );
          }
        }
        return;
      }
      if (type === "user-profile" || type === "admin-settings") {
        if (
          type === "admin-settings" &&
          pendingEvent === "admin-settings:open-updates"
        ) {
          adminFocusRequestId.current += 1;
          setAdminFocusRequest({
            section: "updates",
            requestId: adminFocusRequestId.current,
          });
        } else {
          setAdminFocusRequest(null);
        }
        setSidebarEditing(false);
        setRailView(type as RailView);
        setSidebarOpen(true);
        return;
      }
      const id = type;
      const singletonLabels: Partial<Record<TabType, string>> = {
        "host-manager": t("nav.hostManager"),
        docker: t("nav.docker"),
        tunnel: t("nav.tunnels"),
        network_graph: t("nav.networkGraph"),
        tmux_monitor: t("nav.tmuxMonitor"), // --- tmux-monitor ---
        homepage: t("nav.homepage"),
      };
      setTabs((prev) => {
        const existing = prev.find((t) => t.id === id);
        if (existing) {
          // --- tmux-monitor --- refocusing with a host preselects it
          if (!host) return prev;
          return prev.map((t) => (t.id === id ? { ...t, host } : t));
        }
        return [
          ...prev,
          {
            id,
            instanceId: id,
            type,
            label: singletonLabels[type] ?? type,
            openedAt: Date.now(),
            ...(host ? { host } : {}), // --- tmux-monitor ---
          },
        ];
      });
      setActiveTabId(id);
      if (PERSISTENT_TAB_TYPES.includes(type)) {
        addOpenTab({
          id,
          tabType: type,
          hostId: null,
          label: singletonLabels[type] ?? type,
          tabOrder: 0,
        }).catch(() => {});
      }
    },
    [t],
  );

  const SESSION_TAB_TYPES: TabType[] = [
    "terminal",
    "rdp",
    "vnc",
    "telnet",
    "serial",
  ];
  const ACTIVE_CLOSE_CONFIRM_TYPES: TabType[] = SESSION_TAB_TYPES;

  const getTabCloseLabel = useCallback((tab: Tab) => {
    return tab.customLabel || tab.label || tab.host?.name || String(tab.id);
  }, []);

  const isActiveConnectionTab = useCallback((tab: Tab) => {
    if (!ACTIVE_CLOSE_CONFIRM_TYPES.includes(tab.type)) return false;
    return tab.terminalRef?.current?.isConnected?.() === true;
  }, []);

  const hasActiveConnection = useCallback(() => {
    return tabsRef.current.some(
      (tab) => !tab.sessionPinned && isActiveConnectionTab(tab),
    );
  }, [isActiveConnectionTab]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasActiveConnection()) return;

      event.preventDefault();
      event.returnValue = "";
      return "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [hasActiveConnection]);

  function doCloseTab(
    id: string,
    serverRecordAlreadyDeleted = false,
    preserveSession = false,
  ) {
    const tabToClose = tabs.find((t) => t.id === id);
    if (preserveSession) {
      tabToClose?.terminalRef?.current?.detach?.();
    } else {
      tabToClose?.terminalRef?.current?.disconnect?.();
    }
    if (
      tabToClose?.instanceId &&
      PERSISTENT_TAB_TYPES.includes(tabToClose.type) &&
      !tabToClose.agentSessionId &&
      !serverRecordAlreadyDeleted
    ) {
      deleteOpenTab(tabToClose.instanceId).catch(() => {});
    }

    terminalRefs.current.delete(id);
    if (id === activeTabId) {
      const remaining = tabs.filter((t) => t.id !== id);
      setActiveTabId(
        remaining.length > 0 ? remaining[remaining.length - 1].id : "dashboard",
      );
    }
    setPaneTabIds((prev) => prev.map((p) => (p === id ? null : p)));
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (next.length === 0)
        return [
          {
            id: "dashboard",
            instanceId: "dashboard",
            type: "dashboard",
            label: t("nav.dashboard"),
            openedAt: Date.now(),
          },
        ];
      return next;
    });
  }

  function closeAgentSessionAttachments(agentSessionId: string) {
    const currentTabs = tabsRef.current;
    const closingTabs = currentTabs.filter(
      (tab) => tab.agentSessionId === agentSessionId,
    );
    if (closingTabs.length === 0) return;

    const closingTabIds = new Set(closingTabs.map((tab) => tab.id));
    for (const tab of closingTabs) {
      tab.terminalRef?.current?.detach?.();
      terminalRefs.current.delete(tab.id);
    }

    const remainingTabs = currentTabs.filter(
      (tab) => !closingTabIds.has(tab.id),
    );
    const nextTabs =
      remainingTabs.length > 0
        ? remainingTabs
        : [
            {
              id: "dashboard",
              instanceId: "dashboard",
              type: "dashboard" as const,
              label: t("nav.dashboard"),
              openedAt: Date.now(),
            },
          ];
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    setPaneTabIds((current) =>
      current.map((tabId) =>
        tabId && closingTabIds.has(tabId) ? null : tabId,
      ),
    );

    if (closingTabIds.has(activeTabIdRef.current)) {
      const nextActiveTabId = nextTabs[nextTabs.length - 1]?.id ?? "dashboard";
      activeTabIdRef.current = nextActiveTabId;
      setActiveTabId(nextActiveTabId);
    }
  }

  async function detachPinnedTab(id: string) {
    const tab = tabs.find((item) => item.id === id);
    if (
      !tab?.instanceId ||
      pinnedDetachInFlightRef.current.has(id) ||
      pinnedTerminateInFlightRef.current.has(tab.instanceId)
    )
      return;

    pinnedDetachInFlightRef.current.add(id);
    try {
      const detachedRecord = await detachPinnedOpenTab(tab.instanceId);
      setBackgroundTabRecords((current) =>
        upsertOpenTabRecord(current, detachedRecord),
      );
      doCloseTab(id, true, true);
      toast.info(t("terminal.pinnedTabDetached"));
    } catch {
      toast.error(t("terminal.detachPinnedFailed"));
    } finally {
      pinnedDetachInFlightRef.current.delete(id);
    }
  }

  function requestPinnedTermination(
    recordId: string,
    label: string,
    tabId?: string,
  ) {
    if (pinnedTerminateInFlightRef.current.has(recordId)) return;
    if (
      tabId &&
      (pinToggleInFlightRef.current.has(tabId) || pinningTabIds.has(tabId))
    ) {
      toast.info(t("terminal.sessionPinInProgress"));
      return;
    }
    setPendingTabClose({
      kind: "pinned",
      tabId,
      recordId,
      title: t("terminal.confirmClosePinned", { host: label }),
      description: t("terminal.confirmClosePinnedDesc"),
      confirmLabel: t("terminal.closePinnedWindow"),
    });
  }

  function requestTerminatePinnedTab(id: string) {
    const tab = tabs.find((item) => item.id === id);
    if (!tab?.instanceId) {
      toast.error(t("terminal.closePinnedFailed"));
      return;
    }
    requestPinnedTermination(tab.instanceId, getTabCloseLabel(tab), id);
  }

  function requestTerminatePinnedRecord(record: OpenTabRecord) {
    const host = record.hostId
      ? allHosts.find((item) => item.id === String(record.hostId))
      : undefined;
    requestPinnedTermination(record.id, host?.name ?? record.label);
  }

  async function terminatePinnedWindow(recordId: string, tabId?: string) {
    if (pinnedTerminateInFlightRef.current.has(recordId)) return;
    pinnedTerminateInFlightRef.current.add(recordId);
    try {
      await deleteOpenTab(recordId);
      if (tabId) doCloseTab(tabId, true, true);
      setBackgroundTabRecords((current) =>
        current.filter((record) => record.id !== recordId),
      );
    } catch (error) {
      if (
        axios.isAxiosError<{ code?: string }>(error) &&
        error.response?.data?.code === "PINNED_SESSION_RESTORE_REQUIRED"
      ) {
        toast.info(t("terminal.restorePinnedBeforeClose"));
      } else {
        toast.error(t("terminal.closePinnedFailed"));
      }
    } finally {
      pinnedTerminateInFlightRef.current.delete(recordId);
    }
  }

  function requestTerminateAgentSession(session: ActiveSessionInfo) {
    const agentSessionId = session.agentSessionId;
    if (
      !agentSessionId ||
      agentTerminateInFlightRef.current.has(agentSessionId) ||
      terminatedAgentSessionIds.has(agentSessionId)
    ) {
      return;
    }
    setPendingTabClose({
      kind: "agent",
      agentSessionId,
      title: t("connections.confirmTerminateAgentSession", {
        host: session.hostName,
      }),
      description: t("connections.confirmTerminateAgentSessionDesc"),
      confirmLabel: t("connections.terminateAgentSession"),
    });
  }

  async function terminateAgentSession(agentSessionId: string) {
    if (agentTerminateInFlightRef.current.has(agentSessionId)) return;
    agentTerminateInFlightRef.current.add(agentSessionId);
    setTerminatingAgentSessionIds((current) =>
      new Set(current).add(agentSessionId),
    );
    try {
      await closeAgentSession(agentSessionId);
      closeAgentSessionAttachments(agentSessionId);
      setTerminatedAgentSessionIds((current) =>
        new Set(current).add(agentSessionId),
      );
      setAgentSessionsRefreshVersion((current) => current + 1);
      toast.success(t("connections.agentSessionTerminated"));
    } catch {
      toast.error(t("connections.agentSessionTerminateFailed"));
    } finally {
      agentTerminateInFlightRef.current.delete(agentSessionId);
      setTerminatingAgentSessionIds((current) => {
        const next = new Set(current);
        next.delete(agentSessionId);
        return next;
      });
    }
  }

  function refreshTab(id: string) {
    if (pinToggleInFlightRef.current.has(id)) {
      toast.info(t("terminal.sessionPinInProgress"));
      return;
    }
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    if (tab.type === "terminal") {
      const ref = tab.terminalRef?.current;
      ref?.reconnect?.();
    } else if (["rdp", "vnc", "telnet"].includes(tab.type)) {
      window.dispatchEvent(
        new CustomEvent("termix:refresh-guacamole", { detail: { tabId: id } }),
      );
    }
  }

  function openShareForTab(id: string) {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    const ref = tab.terminalRef?.current;
    if (ref?.canShare?.()) {
      ref.openShareModal?.();
    } else {
      toast.error(t("sessionSharing.notReadyToShare"));
    }
  }

  const handleSessionPersistenceChange = useCallback(
    (tabId: string, state: TerminalSessionPersistenceState) => {
      setTabs((current) =>
        current.map((tab) =>
          tab.id === tabId
            ? {
                ...tab,
                sessionPinned: state.sessionPinned,
                sessionManagedTmux: state.sessionManagedTmux,
                persistentSessionId: state.sessionId,
                persistentTmuxSessionName: state.tmuxSessionName,
                restoredSessionId: state.sessionId,
                agentSessionId:
                  state.agentSessionId ?? tab.agentSessionId ?? null,
              }
            : tab,
        ),
      );
    },
    [],
  );

  async function pinSession(id: string) {
    if (pinToggleInFlightRef.current.has(id)) return;
    const tab = tabs.find((item) => item.id === id);
    const terminalHandle = tab?.terminalRef?.current;
    if (!tab || tab.type !== "terminal") {
      return;
    }
    if (tab.sessionPinned) {
      toast.info(t("terminal.pinnedWindowCloseOnly"));
      return;
    }
    if (!terminalHandle?.pinSession) {
      toast.error(t("terminal.sessionNotReadyToPin"));
      return;
    }

    pinToggleInFlightRef.current.add(id);
    setPinningTabIds((current) => new Set(current).add(id));
    try {
      const success = await terminalHandle.pinSession();
      if (!success) {
        return;
      }
      setTabs((current) =>
        current.map((item) =>
          item.id === id ? { ...item, sessionPinned: true } : item,
        ),
      );
      toast.success(t("terminal.sessionPinned"));
    } finally {
      pinToggleInFlightRef.current.delete(id);
      setPinningTabIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }

  function closeTab(id: string) {
    if (pinnedDetachInFlightRef.current.has(id)) return;
    if (pinToggleInFlightRef.current.has(id) || pinningTabIds.has(id)) {
      toast.info(t("terminal.sessionPinInProgress"));
      return;
    }
    const tab = tabs.find((t) => t.id === id);
    if (tab?.sessionPinned) {
      if (tab.agentSessionId) {
        doCloseTab(id, true, true);
      } else {
        void detachPinnedTab(id);
      }
      return;
    }
    const confirmEnabled = localStorage.getItem("confirmTabClose") === "true";
    if (tab && confirmEnabled && isActiveConnectionTab(tab)) {
      const closeLabel = getTabCloseLabel(tab);
      setPendingTabClose({
        kind: "connection",
        tabId: id,
        title: t("nav.confirmCloseHost", {
          host: closeLabel,
          defaultValue: `Close ${closeLabel}?`,
        }),
        confirmLabel: t("nav.close"),
      });
      return;
    }

    doCloseTab(id);
  }

  function renameTab(tabId: string, newLabel: string) {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId ? { ...t, customLabel: newLabel, label: newLabel } : t,
      ),
    );
    const tab = tabs.find((t) => t.id === tabId);
    if (tab?.instanceId && !tab.agentSessionId) {
      patchOpenTab(tab.instanceId, { label: newLabel }).catch(() => {});
    }
  }

  function splitTabQuick(tabId: string, mode: SplitMode) {
    setSplitMode(mode);
    setPaneTabIds(() => {
      const count = PANE_COUNTS[mode];
      const next: (string | null)[] = Array(6).fill(null);
      next[0] = tabId;
      // Fill remaining panes with other non-dashboard tabs in order
      let slot = 1;
      for (const tab of tabs) {
        if (slot >= count) break;
        if (tab.id !== tabId && tab.type !== "dashboard") {
          next[slot] = tab.id;
          slot++;
        }
      }
      return next;
    });
  }

  function addTabToSplit(tabId: string) {
    setPaneTabIds((prev) => {
      // Remove from any current slot first
      const next = prev.map((p) => (p === tabId ? null : p));
      // Find first empty slot within the current pane count
      const count = PANE_COUNTS[splitMode];
      for (let i = 0; i < count; i++) {
        if (!next[i]) {
          next[i] = tabId;
          break;
        }
      }
      return next;
    });
  }

  function removeTabFromSplit(tabId: string) {
    setPaneTabIds((prev) => prev.map((p) => (p === tabId ? null : p)));
  }

  function assignPane(paneIndex: number, tabId: string) {
    setPaneTabIds((prev) => {
      const next = prev.map((p) => (p === tabId ? null : p));
      next[paneIndex] = tabId;
      return next;
    });
  }

  // ─── Rail / sidebar ──────────────────────────────────────────────────────

  function handleRailClick(view: RailView) {
    if (railView === view && sidebarOpen) {
      setSidebarOpen(false);
    } else {
      if (view !== railView) setSidebarEditing(false);
      setRailView(view);
      setSidebarOpen(true);
    }
  }

  function editHostInManager(host: Host) {
    setSidebarOpen(true);
    setRailView("hosts");
    setTimeout(() => {
      window.dispatchEvent(createHostManagerEditEvent(host));
    }, 0);
  }

  const onSidebarMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setSidebarDragging(true);
      const startX = e.clientX;
      const startW = sidebarWidth;
      function onMove(ev: MouseEvent) {
        setSidebarWidth(
          Math.max(160, Math.min(480, startW + ev.clientX - startX)),
        );
      }
      function onUp() {
        setSidebarDragging(false);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      }
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [sidebarWidth],
  );

  // Resize all terminals in panes + active terminal when split mode or sidebar changes
  const resizeAllTerminals = useCallback(() => {
    const id = requestAnimationFrame(() => {
      tabs.forEach((tab) => {
        if (!tab.terminalRef) return;
        const ref = tab.terminalRef.current;
        ref?.fit?.();
        ref?.notifyResize?.();
      });
    });
    return id;
  }, [tabs]);

  useEffect(() => {
    const id = resizeAllTerminals();
    return () => cancelAnimationFrame(id);
  }, [splitMode, sidebarWidth, sidebarOpen]);

  const isSplit = splitMode !== "none";

  // Move each tab's stable DOM node to the right container (pane or normal-view).
  // This is vanilla DOM so React's portal target never changes — changing the portal
  // target causes a remount which is exactly what we're trying to avoid.
  useEffect(() => {
    const normalView = normalViewRef.current;
    if (!normalView) return;

    const tabIds = new Set(tabs.map((t) => t.id));

    // Remove nodes for closed tabs
    for (const [id, node] of tabNodesRef.current) {
      if (!tabIds.has(id)) {
        node.remove();
        tabNodesRef.current.delete(id);
      }
    }

    for (const tab of tabs) {
      const isTerminal = tab.type === "terminal";
      const node = getTabNode(tab.id, isTerminal);
      const paneIdx = isSplit ? paneTabIds.indexOf(tab.id) : -1;
      const inPane = paneIdx !== -1;
      const paneEl = inPane ? paneContentEls[paneIdx] : null;
      const activeInline = !inPane && tab.id === activeTabId;

      if (inPane && paneEl) {
        if (node.parentElement !== paneEl) paneEl.appendChild(node);
        node.style.visibility = "visible";
        node.style.pointerEvents = "auto";
        node.style.display = "";
        node.style.zIndex = "";
      } else {
        if (node.parentElement !== normalView) normalView.appendChild(node);
        if (isTerminal) {
          node.style.display = "";
          node.style.visibility = activeInline ? "visible" : "hidden";
          node.style.pointerEvents = activeInline ? "auto" : "none";
          node.style.zIndex = activeInline ? "1" : "0";
        } else {
          node.style.visibility = "";
          node.style.pointerEvents = "";
          node.style.zIndex = activeInline ? "2" : "";
          node.style.display = activeInline ? "" : "none";
        }
      }
    }
  });

  const terminalTabs = tabs.filter((t) => t.type === "terminal");

  // Sidebar panel content — shared between desktop inline sidebar and mobile sheet
  const sidebarPanelContent = (
    <Suspense fallback={<SidebarPanelFallback />}>
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        <div
          className={`flex flex-col flex-1 min-h-0 ${railView === "hosts" ? "" : "hidden"}`}
        >
          <HostsPanel
            onOpenTab={(host, type) => {
              connectHost(host, type);
              if (isMobile) setSidebarOpen(false);
            }}
            onEditHost={editHostInManager}
            hostTree={realHostTree ?? undefined}
            loading={hostsLoading}
            onEditingChange={setSidebarEditing}
            active={railView === "hosts"}
            projectFolderActions={projectFolderActions}
          />
        </div>

        {railView === "agent-integration" && (
          <div className="flex flex-col flex-1 min-h-0">
            <AgentIntegrationPanel />
          </div>
        )}

        <div
          className={`flex flex-col flex-1 min-h-0 ${railView === "credentials" ? "" : "hidden"}`}
        >
          <CredentialsPanel
            onEditingChange={setSidebarEditing}
            active={railView === "credentials"}
          />
        </div>

        {railView === "termix-id" && (
          <div className="flex flex-col flex-1 min-h-0">
            <TermixIdPanel />
          </div>
        )}

        {railView === "serial" && (
          <SerialPanel
            onConnect={(config) => {
              openSerialTab(config);
              if (isMobile) setSidebarOpen(false);
            }}
          />
        )}

        {railView === "quick-connect" && (
          <QuickConnectPanel
            onConnect={(host, type) => {
              openTab(host, type);
              if (isMobile) setSidebarOpen(false);
            }}
          />
        )}

        {railView === "ssh-tools" && (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <SshToolsPanel
              terminalTabs={terminalTabs}
              activeTabId={activeTabId}
            />
          </div>
        )}

        {railView === "snippets" && (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <SnippetsPanel
              terminalTabs={terminalTabs}
              activeTabId={activeTabId}
            />
          </div>
        )}

        {railView === "history" && (
          <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
            <HistoryPanel
              terminalTabs={terminalTabs}
              activeTabId={activeTabId}
            />
          </div>
        )}

        {railView === "split-screen" && (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <SplitScreenPanel
              tabs={tabs}
              splitMode={splitMode}
              setSplitMode={setSplitMode}
              paneTabIds={paneTabIds}
              setPaneTabIds={setPaneTabIds}
              onAssignPane={assignPane}
            />
          </div>
        )}

        {railView === "connections" && (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <ConnectionsPanel
              tabs={tabs}
              activeTabId={activeTabId}
              activeProjectId={activeProject.id}
              allHosts={allHosts}
              backgroundTabRecords={backgroundTabRecords}
              onSwitchToTab={(tabId) => {
                setActiveTabId(tabId);
                if (isMobile) setSidebarOpen(false);
              }}
              onCloseTab={closeTab}
              onTerminatePinnedTab={requestTerminatePinnedTab}
              onTerminatePinnedRecord={requestTerminatePinnedRecord}
              onPinnedRestoreRequired={() => {
                toast.info(t("terminal.restorePinnedBeforeClose"));
              }}
              onReopenTab={async (record, restoredSessionId, sessionPinned) => {
                let host = record.hostId
                  ? allHosts.find((h) => h.id === String(record.hostId))
                  : undefined;
                const hostlessTypes: TabType[] = ["tunnel"];
                if (
                  !host &&
                  record.hostId &&
                  !hostlessTypes.includes(record.tabType as TabType)
                ) {
                  try {
                    const latestHosts = await getSSHHosts();
                    const savedHost = latestHosts.find(
                      (item) => String(item.id) === String(record.hostId),
                    );
                    host = savedHost ? sshHostToHost(savedHost) : undefined;
                    await refreshProjects();
                    window.dispatchEvent(
                      new CustomEvent("termix:hosts-changed"),
                    );
                  } catch (error) {
                    console.error(
                      "Failed to refresh host before reconnect",
                      error,
                    );
                  }
                }
                if (
                  !host &&
                  !hostlessTypes.includes(record.tabType as TabType)
                ) {
                  toast.error(
                    record.hostId
                      ? "找不到此连接对应的主机，请确认主机仍然存在"
                      : "此快速连接尚未保存为主机，无法恢复，请重新创建连接",
                  );
                  return;
                }
                setBackgroundTabRecords((prev) =>
                  prev.filter((r) => r.id !== record.id),
                );
                if (host) {
                  const effectiveSessionId =
                    restoredSessionId ?? record.backendSessionId ?? null;
                  openTab(host, record.tabType as TabType, {
                    instanceId: record.id,
                    restoredSessionId: effectiveSessionId,
                    savedLabel: record.label,
                    sessionPinned,
                  });
                } else {
                  openSingletonTab(record.tabType as TabType);
                }
                if (isMobile) setSidebarOpen(false);
              }}
              onForgetBackground={(recordId) => {
                setBackgroundTabRecords((prev) =>
                  prev.filter((r) => r.id !== recordId),
                );
              }}
              onRenameTab={renameTab}
              onReorderTabs={setTabs}
              onOpenAgentSession={(session) => {
                const host = allHosts.find(
                  (candidate) => candidate.id === String(session.hostId),
                );
                if (!host || !session.agentSessionId) {
                  toast.error(t("connections.agentHostUnavailable"));
                  return;
                }
                openAgentSessionTab(
                  host,
                  session.agentSessionId,
                  session.hostName,
                );
              }}
              onTerminateAgentSession={requestTerminateAgentSession}
              terminatingAgentSessionIds={terminatingAgentSessionIds}
              terminatedAgentSessionIds={terminatedAgentSessionIds}
              agentSessionsRefreshVersion={agentSessionsRefreshVersion}
              onOpenAgentNewTerminal={(session) => {
                const host = allHosts.find(
                  (candidate) => candidate.id === String(session.hostId),
                );
                if (!host) {
                  toast.error(t("connections.agentHostUnavailable"));
                  return;
                }
                connectHost(host, "terminal");
                if (isMobile) setSidebarOpen(false);
              }}
              onJoinSharedSession={(session) => {
                if (!session.shareId) return;
                const existingHost = allHosts.find(
                  (h) => h.id === String(session.hostId),
                );
                const host: Host = existingHost ?? {
                  id: String(session.hostId),
                  name: session.hostName,
                  username: "",
                  ip: "",
                  port: 0,
                  folder: "",
                  online: false,
                  cpu: null,
                  ram: null,
                  lastAccess: new Date().toISOString(),
                  authType: "none",
                  enableTerminal: false,
                  enableCommandHistory: false,
                  enableTunnel: false,
                  enableFileManager: false,
                  enableDocker: false,
                  enableProxmox: false,
                  enableTmuxMonitor: false,
                  enableSsh: false,
                  enableRdp: false,
                  enableVnc: false,
                  enableTelnet: false,
                  sshPort: 22,
                  rdpPort: 3389,
                  vncPort: 5900,
                  telnetPort: 23,
                  serverTunnels: [],
                  quickActions: [],
                };
                const instanceId =
                  typeof crypto.randomUUID === "function"
                    ? crypto.randomUUID()
                    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
                openTab(host, "terminal", {
                  instanceId,
                  restoredSessionId: null,
                  joinSharedSessionId: session.sessionId,
                  joinShareId: session.shareId,
                  savedLabel: t("connections.sharedSessionLabel", {
                    hostName: session.hostName,
                  }),
                });
                if (isMobile) setSidebarOpen(false);
              }}
            />
          </div>
        )}

        {railView === "session-logs" && (
          <div className="relative flex-1 min-h-0 flex flex-col">
            <SessionLogsPanel />
          </div>
        )}

        {railView === "user-profile" && (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <UserProfilePanel
              username={username}
              onUsernameChange={onUsernameChange}
              onLogout={onLogout}
              onOpenUpdates={
                showMultiUserUI
                  ? () => {
                      adminFocusRequestId.current += 1;
                      setAdminFocusRequest({
                        section: "updates",
                        requestId: adminFocusRequestId.current,
                      });
                      setRailView("admin-settings");
                    }
                  : undefined
              }
              userPrefs={userPrefs}
              onPrefsChange={(updates) =>
                setUserPrefs((current) => ({ ...current, ...updates }))
              }
              remoteSyncInitialServerUrl={remoteSyncInitialServerUrl}
            />
          </div>
        )}

        {railView === "admin-settings" && showMultiUserUI && (
          <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
            <RenderErrorBoundary
              fallback={(reset) => (
                <div
                  role="alert"
                  className="m-3 flex flex-col items-start gap-3 border border-destructive/40 bg-destructive/5 p-3"
                >
                  <div className="text-xs font-semibold text-foreground">
                    {t("common.error")}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={reset}>
                      <RotateCcw className="size-4" aria-hidden="true" />
                      {t("common.retry")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => window.location.reload()}
                    >
                      <RefreshCw className="size-4" aria-hidden="true" />
                      {t("common.reload")}
                    </Button>
                  </div>
                </div>
              )}
            >
              <AdminSettingsPanel
                focusRequest={adminFocusRequest}
                onFocusHandled={(requestId) =>
                  setAdminFocusRequest((current) =>
                    current?.requestId === requestId ? null : current,
                  )
                }
                onEditingChange={setSidebarEditing}
                onOpenHostTab={(host) => {
                  connectHost(host);
                  if (isMobile) setSidebarOpen(false);
                }}
              />
            </RenderErrorBoundary>
          </div>
        )}

        {railView === "alerts" && (
          <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
            <AlertsPanel />
          </div>
        )}
      </div>
    </Suspense>
  );

  // Sidebar header — shared
  const sidebarHeader = (
    <div className="flex flex-row items-center border-b border-border h-12.5 shrink-0">
      <span className="flex-1 text-base font-bold tracking-tight text-foreground px-3">
        {sidebarTitle[railView]}
      </span>
      {!isMobile && (
        <>
          <Separator orientation="vertical" />
          <Button
            variant="ghost"
            size="icon"
            className="h-full w-12.5 border-y-0 border-border rounded-none text-muted-foreground hover:text-foreground"
            title="Reset width"
            onClick={() => setSidebarWidth(291)}
          >
            <Maximize2 className="size-3.5" />
          </Button>
        </>
      )}
      <Separator orientation="vertical" />
      <Button
        variant="ghost"
        size="icon"
        className="h-full w-12.5 rounded-none text-muted-foreground hover:text-foreground"
        onClick={() => setSidebarOpen(false)}
      >
        <ChevronLeft className="size-4" />
      </Button>
    </div>
  );

  return (
    <ServerStatusProvider isAuthenticated={!!username}>
      <div
        className="flex flex-col w-screen bg-background"
        style={{ height: "100dvh" }}
      >
        {isElectron() && (
          <>
            <RemoteSyncBanner
              onReconnect={() => {
                setRailView("user-profile");
                if (!sidebarOpen) setSidebarOpen(true);
              }}
            />
            <MigrationNoticeDialog
              onOpenRemoteSync={(url) => {
                setRemoteSyncInitialServerUrl(url);
                setRailView("user-profile");
                if (!sidebarOpen) setSidebarOpen(true);
              }}
            />
          </>
        )}
        <div className="flex flex-1 min-h-0">
          {/* Skinny icon rail — desktop only, hidden on mobile */}
          <AppRail
            railView={railView}
            sidebarOpen={sidebarOpen}
            splitMode={splitMode}
            username={username}
            isAdmin={showMultiUserUI}
            onRailClick={handleRailClick}
            onOpenTab={openSingletonTab}
            onLogout={onLogout}
          />

          {/* Desktop: inline resizable sidebar */}
          {!isMobile && (
            <div
              className={`relative flex flex-col min-h-0 bg-sidebar shrink-0 overflow-hidden ${sidebarOpen ? `border-r transition-colors ${sidebarDragging ? "border-accent-brand/60" : "border-border"}` : ""}`}
              style={{
                width: sidebarOpen ? (sidebarEditing ? 560 : sidebarWidth) : 0,
                transition: sidebarDragging ? "none" : "width 0.2s",
              }}
            >
              {sidebarHeader}
              {sidebarPanelContent}

              {sidebarOpen && !sidebarEditing && (
                <div
                  onMouseDown={onSidebarMouseDown}
                  className={`absolute right-0 top-0 bottom-0 w-1 cursor-col-resize z-30 transition-colors ${sidebarDragging ? "bg-accent-brand/60" : "hover:bg-accent-brand/40"}`}
                />
              )}
            </div>
          )}

          {/* Mobile: sidebar as overlay sheet */}
          {isMobile && (
            <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
              <SheetContent
                side="left"
                showCloseButton={false}
                className="p-0 flex flex-col min-h-0 w-[min(85vw,360px)] max-w-full bg-sidebar border-r border-border gap-0"
                style={{ height: "100dvh" }}
              >
                {sidebarHeader}
                {sidebarPanelContent}
              </SheetContent>
            </Sheet>
          )}

          {/* Main content area */}
          <div
            className={`relative flex flex-col flex-1 min-w-0 overflow-hidden transition-all duration-200 ${!isMobile && !sidebarOpen ? "pl-6" : ""}`}
          >
            {!isMobile && !sidebarOpen && (
              <button
                onClick={() => setSidebarOpen(true)}
                title="Open Sidebar"
                className="absolute left-0 top-0 bottom-0 z-20 flex items-center justify-center w-6 bg-sidebar border-r border-border text-muted-foreground hover:text-accent-brand hover:bg-accent-brand/5 transition-colors"
              >
                <ChevronRight className="size-3.5" />
              </button>
            )}
            <div className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden">
              <WorkspaceTopbar
                onOpenCommandPalette={() => setCommandPaletteOpen(true)}
                onNewConnection={() => {
                  setRailView("quick-connect");
                  setSidebarOpen(true);
                }}
              />
              <TabBar
                tabs={tabs}
                activeTabId={activeTabId}
                splitMode={splitMode}
                paneTabIds={paneTabIds}
                focusedPaneIndex={focusedPaneIndex}
                onSetActiveTab={setActiveTabId}
                onCloseTab={closeTab}
                onRefreshTab={refreshTab}
                onReorderTabs={setTabs}
                onSplitTab={splitTabQuick}
                onAddToSplit={addTabToSplit}
                onRemoveFromSplit={removeTabFromSplit}
                onRenameTab={renameTab}
                onOpenFileManager={(tabId) => {
                  const targetTab = tabs.find((t) => t.id === tabId);
                  if (targetTab?.host) openTab(targetTab.host, "files");
                }}
                onOpenShare={openShareForTab}
                onPinSession={pinSession}
                pinningTabIds={pinningTabIds}
                isAppFullscreen={isAppFullscreen}
                onToggleAppFullscreen={toggleAppFullscreen}
              />
              <div className="relative flex flex-col flex-1 min-h-0 overflow-hidden">
                {/* Split view — always mounted when not mobile, hidden via CSS when inactive */}
                {!isMobile && (
                  <div
                    className="absolute inset-0"
                    style={{
                      display: isSplit ? "flex" : "none",
                      flexDirection: "column",
                    }}
                  >
                    <SplitView
                      tabs={tabs}
                      paneTabIds={paneTabIds}
                      splitMode={splitMode}
                      focusedPaneIndex={focusedPaneIndex}
                      onTerminalResize={resizeAllTerminals}
                      onPaneContentRef={onPaneContentRef}
                      onPaneClick={setFocusedPaneIndex}
                      onAssignPane={assignPane}
                    />
                  </div>
                )}

                {/* Normal-view container. Tab nodes are appended here (or to pane elements)
                  by the DOM-placement effect above. React portals each tab's content
                  into its stable per-tab node so the component is never remounted.
                  When split is active, shown on top only if the active tab is not in a pane. */}
                <div
                  ref={normalViewRef}
                  className="absolute inset-0"
                  style={{
                    display:
                      isSplit && !isMobile && paneTabIds.includes(activeTabId)
                        ? "none"
                        : undefined,
                    zIndex:
                      isSplit && !paneTabIds.includes(activeTabId)
                        ? 10
                        : undefined,
                  }}
                >
                  {tabs.map((tab) => {
                    const tabNode = getTabNode(tab.id, tab.type === "terminal");
                    const paneIdx = isSplit ? paneTabIds.indexOf(tab.id) : -1;
                    const inPane = paneIdx !== -1;
                    const activeInline = !inPane && tab.id === activeTabId;
                    return createPortal(
                      renderTabContent(
                        tab,
                        openSingletonTab,
                        openTab,
                        closeTab,
                        inPane || activeInline,
                        (host, filePath) =>
                          openTab(host, "files", {
                            instanceId:
                              typeof crypto.randomUUID === "function"
                                ? crypto.randomUUID()
                                : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
                            restoredSessionId: null,
                            initialFilePath: filePath,
                          }),
                        (host, _path) => openTab(host, "files"),
                        (host, path) =>
                          openTab(host, "terminal", {
                            instanceId:
                              typeof crypto.randomUUID === "function"
                                ? crypto.randomUUID()
                                : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
                            restoredSessionId: null,
                            initialFilePath: path,
                          }),
                        renameTab,
                        saveQuickConnectHost,
                        handleSessionPersistenceChange,
                        openAgentSessionTab,
                      ),
                      tabNode,
                      tab.id,
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Bottom nav bar — mobile only */}
            <MobileBottomBar
              railView={railView}
              sidebarOpen={sidebarOpen}
              splitMode={splitMode}
              onRailClick={handleRailClick}
            />
          </div>

          <WorkspaceUtilityRail
            activeHost={tabs.find((tab) => tab.id === activeTabId)?.host}
            activeTabId={activeTabId}
            terminalTabs={terminalTabs}
            onOpenFiles={() => {
              const host = tabs.find((tab) => tab.id === activeTabId)?.host;
              if (host) openTab(host, "files");
            }}
            onOpenMetrics={() => {
              const host = tabs.find((tab) => tab.id === activeTabId)?.host;
              if (host) openTab(host, "host-metrics");
            }}
            onLayoutChange={resizeAllTerminals}
          />
        </div>
      </div>

      {commandPaletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette
            isOpen={commandPaletteOpen}
            setIsOpen={setCommandPaletteOpen}
            hosts={allHosts}
            onOpenTab={(type, label, pendingEvent) => {
              if (
                [
                  "dashboard",
                  "host-manager",
                  "user-profile",
                  "admin-settings",
                ].includes(type)
              ) {
                openSingletonTab(type, pendingEvent);
              } else if (type === "tmux_monitor") {
                // --- tmux-monitor --- singleton tab, optionally preselecting a host
                openSingletonTab(
                  type,
                  undefined,
                  label ? allHosts.find((h) => h.name === label) : undefined,
                );
              } else if (label) {
                const host = allHosts.find((h) => h.name === label);
                if (host) openTab(host, type);
              }
            }}
          />
        </Suspense>
      )}
      <CloseTabConfirmDialog
        open={pendingTabClose !== null}
        title={pendingTabClose?.title ?? ""}
        description={pendingTabClose?.description}
        confirmLabel={pendingTabClose?.confirmLabel ?? t("nav.close")}
        cancelLabel={t("nav.cancel")}
        onOpenChange={(open) => {
          if (!open) setPendingTabClose(null);
        }}
        onConfirm={() => {
          const pending = pendingTabClose;
          setPendingTabClose(null);
          if (!pending) return;
          if (pending.kind === "agent") {
            if (pending.agentSessionId) {
              void terminateAgentSession(pending.agentSessionId);
            }
            return;
          }
          if (pending.kind === "pinned") {
            if (pending.recordId) {
              void terminatePinnedWindow(pending.recordId, pending.tabId);
            }
            return;
          }
          if (pending.tabId) doCloseTab(pending.tabId);
        }}
      />
      <TransferMonitor />
    </ServerStatusProvider>
  );
}

export function AppShell(props: {
  username: string;
  onUsernameChange: (username: string) => void;
  onLogout: () => void;
}) {
  return (
    <WorkspaceProvider>
      <AppShellContent {...props} />
    </WorkspaceProvider>
  );
}
