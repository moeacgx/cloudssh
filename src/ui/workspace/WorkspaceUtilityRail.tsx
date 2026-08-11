import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  Bot,
  ChevronRight,
  FileText,
  FolderOpen,
  Gauge,
  History,
  MessageSquarePlus,
  Minus,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/button";
import { ScrollArea } from "@/components/scroll-area";
import { useWorkspace } from "@/workspace/WorkspaceContext";
import {
  getProjectAgentActivity,
  type AgentActivity,
} from "@/api/workspace-api";
import {
  PanelAgentPanel,
  type PanelAgentConversationAction,
} from "@/sidebar/PanelAgentPanel";
import type { Host, Tab } from "@/types/ui-types";

type UtilityView = "agent" | "activity" | null;

const UTILITY_PANEL_DEFAULT_WIDTH = 520;
const UTILITY_PANEL_MIN_WIDTH = 360;
const UTILITY_PANEL_MAX_WIDTH = 860;
const UTILITY_PANEL_WIDTH_KEY = "termix_workspaceUtilityWidth";

type MobileAgentMode = "bubble" | "quick" | "hidden";
type MobileAgentSide = "left" | "right";
type MobileAgentPosition = {
  side: MobileAgentSide;
  y: number;
};

const MOBILE_AGENT_POSITION_KEY = "termix_mobileAgentPosition";
const MOBILE_AGENT_MIN_Y = 92;
const MOBILE_AGENT_BOTTOM_GUARD = 156;
const MOBILE_AGENT_PANEL_BOTTOM_GUARD = 104;

function readLocalStorage(key: string) {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalStorage(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage quota/private-mode failures; the in-memory state still works.
  }
}

function viewportHeight() {
  return typeof window === "undefined" ? 720 : window.innerHeight || 720;
}

function viewportWidth() {
  return typeof window === "undefined" ? 390 : window.innerWidth || 390;
}

function clampMobileAgentY(y: number, height = viewportHeight()) {
  return Math.max(
    MOBILE_AGENT_MIN_Y,
    Math.min(height - MOBILE_AGENT_BOTTOM_GUARD, Math.round(y)),
  );
}

function defaultMobileAgentPosition(): MobileAgentPosition {
  const height = viewportHeight();
  return {
    side: "right",
    y: clampMobileAgentY(height * 0.56, height),
  };
}

function storedMobileAgentPosition(): MobileAgentPosition {
  const fallback = defaultMobileAgentPosition();
  const saved = readLocalStorage(MOBILE_AGENT_POSITION_KEY);
  if (!saved) return fallback;

  try {
    const parsed = JSON.parse(saved) as Partial<MobileAgentPosition>;
    return {
      side: parsed.side === "left" ? "left" : "right",
      y: clampMobileAgentY(Number(parsed.y) || fallback.y),
    };
  } catch {
    return fallback;
  }
}

function compactMobileAgentPanelHeight(height: number) {
  const available = Math.max(360, height - 128);
  return Math.min(Math.max(Math.round(height * 0.62), 360), 560, available);
}

function clampUtilityPanelWidth(width: number) {
  return Math.max(
    UTILITY_PANEL_MIN_WIDTH,
    Math.min(UTILITY_PANEL_MAX_WIDTH, Math.round(width)),
  );
}

function storedUtilityPanelWidth() {
  const saved = readLocalStorage(UTILITY_PANEL_WIDTH_KEY);
  const parsed = saved ? Number.parseInt(saved, 10) : NaN;
  return Number.isFinite(parsed)
    ? clampUtilityPanelWidth(parsed)
    : UTILITY_PANEL_DEFAULT_WIDTH;
}

function statusClass(status: AgentActivity["status"]) {
  if (status === "running") return "bg-emerald-500";
  if (status === "failed") return "bg-red-500";
  if (status === "waiting") return "bg-amber-500";
  return "bg-muted-foreground/50";
}

export function WorkspaceUtilityRail({
  activeHost,
  activeTabId,
  terminalTabs,
  onOpenFiles,
  onOpenMetrics,
  onLayoutChange,
}: {
  activeHost?: Host;
  activeTabId: string;
  terminalTabs: Tab[];
  onOpenFiles: () => void;
  onOpenMetrics: () => void;
  onLayoutChange: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { activeProject } = useWorkspace();
  const [view, setView] = useState<UtilityView>(null);
  const [mobileAgentMode, setMobileAgentMode] =
    useState<MobileAgentMode>("bubble");
  const [mobileAgentMounted, setMobileAgentMounted] = useState(false);
  const [mobileAgentPosition, setMobileAgentPosition] =
    useState<MobileAgentPosition>(storedMobileAgentPosition);
  const [mobileViewportHeight, setMobileViewportHeight] =
    useState(viewportHeight);
  const mobileAgentClickSuppressed = useRef(false);
  const [activities, setActivities] = useState<AgentActivity[]>([]);
  const [panelWidth, setPanelWidth] = useState(storedUtilityPanelWidth);
  const [panelDragging, setPanelDragging] = useState(false);
  const [mobileConversationAction, setMobileConversationAction] =
    useState<PanelAgentConversationAction | null>(null);

  useEffect(() => {
    writeLocalStorage(UTILITY_PANEL_WIDTH_KEY, String(panelWidth));
  }, [panelWidth]);

  useEffect(() => {
    writeLocalStorage(
      MOBILE_AGENT_POSITION_KEY,
      JSON.stringify(mobileAgentPosition),
    );
  }, [mobileAgentPosition]);

  useEffect(() => {
    function onResize() {
      const nextHeight = viewportHeight();
      setMobileViewportHeight(nextHeight);
      setMobileAgentPosition((current) => ({
        ...current,
        y: clampMobileAgentY(current.y, nextHeight),
      }));
    }

    onResize();
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);

  function onPanelResizeMouseDown(event: MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    setPanelDragging(true);
    const startX = event.clientX;
    const startWidth = panelWidth;

    function onMove(moveEvent: globalThis.MouseEvent) {
      setPanelWidth(
        clampUtilityPanelWidth(startWidth + startX - moveEvent.clientX),
      );
    }

    function onUp() {
      setPanelDragging(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function onMobileAgentDragPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) return;

    const startX = event.clientX;
    const startY = event.clientY;
    const startPosition = mobileAgentPosition;
    let moved = false;
    mobileAgentClickSuppressed.current = false;

    function onMove(moveEvent: globalThis.PointerEvent) {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      if (Math.hypot(deltaX, deltaY) > 4) moved = true;
      const width = viewportWidth();
      const height = viewportHeight();
      setMobileViewportHeight(height);
      setMobileAgentPosition({
        side: moveEvent.clientX < width / 2 ? "left" : "right",
        y: clampMobileAgentY(startPosition.y + deltaY, height),
      });
    }

    function onUp() {
      if (moved) {
        mobileAgentClickSuppressed.current = true;
        window.setTimeout(() => {
          mobileAgentClickSuppressed.current = false;
        }, 0);
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  function onMobileAgentFloatClick(event: MouseEvent<HTMLButtonElement>) {
    if (mobileAgentClickSuppressed.current) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    setMobileAgentMounted(true);
    setMobileAgentMode("quick");
  }

  function runMobileConversationAction(
    type: PanelAgentConversationAction["type"],
  ) {
    setMobileConversationAction({ id: Date.now(), type });
  }

  useEffect(() => {
    if (view !== "activity") return;
    let cancelled = false;
    getProjectAgentActivity(activeProject.id)
      .then((items) => {
        if (!cancelled) setActivities(items);
      })
      .catch(() => {
        if (!cancelled) setActivities([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProject.id, view]);

  useEffect(() => {
    const frame = requestAnimationFrame(onLayoutChange);
    return () => cancelAnimationFrame(frame);
  }, [onLayoutChange, view, panelWidth]);

  const toggle = (next: Exclude<UtilityView, null>) =>
    setView((current) => (current === next ? null : next));

  const mobilePanelHeight = compactMobileAgentPanelHeight(mobileViewportHeight);
  const mobilePanelTop = Math.max(
    12,
    Math.min(
      Math.max(
        12,
        mobileViewportHeight -
          mobilePanelHeight -
          MOBILE_AGENT_PANEL_BOTTOM_GUARD,
      ),
      mobileAgentPosition.y - mobilePanelHeight / 2,
    ),
  );
  const mobileAgentDockStyle: CSSProperties = {
    top: mobileAgentPosition.y,
    transform: "translateY(-50%)",
  };
  const mobileAgentPanelStyle: CSSProperties = {
    top: mobilePanelTop,
    height: mobilePanelHeight,
    backgroundColor: "rgba(255, 255, 255, 0.3)",
    backdropFilter: "blur(40px) saturate(170%)",
    WebkitBackdropFilter: "blur(40px) saturate(170%)",
  };
  if (mobileAgentPosition.side === "left") {
    mobileAgentDockStyle.left = 0;
    mobileAgentPanelStyle.left = 12;
  } else {
    mobileAgentDockStyle.right = 0;
    mobileAgentPanelStyle.right = 12;
  }

  return (
    <>
      <aside className="hidden shrink-0 border-l border-border bg-sidebar md:flex">
        {view && (
          <div
            className={`relative flex min-w-0 shrink-0 flex-col border-r bg-background transition-colors ${panelDragging ? "border-accent-brand/60" : "border-border"}`}
            style={{
              width: panelWidth,
              transition: panelDragging ? "none" : "width 0.16s",
            }}
          >
            <div
              aria-orientation="vertical"
              className={`absolute left-0 top-0 bottom-0 z-30 w-1 -translate-x-1/2 cursor-col-resize transition-colors ${panelDragging ? "bg-accent-brand/60" : "hover:bg-accent-brand/40"}`}
              data-workspace-utility-resize-handle="true"
              onMouseDown={onPanelResizeMouseDown}
              role="separator"
              title={t("workspace.utility.resizePanel")}
            />
            <div className="flex h-11 items-center border-b border-border px-3">
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold">
                  {view === "agent"
                    ? t("workspace.utility.agentChat")
                    : t("workspace.utility.activityLog")}
                </p>
                <p className="truncate text-[10px] text-muted-foreground">
                  {activeProject.name}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="ml-auto size-7"
                onClick={() => setView(null)}
                title={t("workspace.utility.collapse")}
              >
                <ChevronRight className="size-3.5" />
              </Button>
            </div>

            {view === "agent" ? (
              <PanelAgentPanel
                terminalTabs={terminalTabs}
                activeTabId={activeTabId}
                embedded
              />
            ) : (
              <ScrollArea className="flex-1">
                <div className="divide-y divide-border">
                  {activities.length === 0 ? (
                    <div className="flex flex-col items-center px-6 py-16 text-center">
                      <Bot className="mb-3 size-6 text-muted-foreground/40" />
                      <p className="text-xs font-medium">
                        {t("workspace.utility.noActivity")}
                      </p>
                    </div>
                  ) : (
                    activities.map((item) => (
                      <div key={item.id} className="px-3 py-3">
                        <div className="flex items-center gap-2">
                          <span
                            className={`size-1.5 rounded-full ${statusClass(item.status)}`}
                          />
                          <span className="truncate text-xs font-medium">
                            {item.actorName}
                          </span>
                          <time className="ml-auto text-[10px] text-muted-foreground">
                            {new Date(item.createdAt).toLocaleTimeString(
                              i18n.language,
                              {
                                hour: "2-digit",
                                minute: "2-digit",
                              },
                            )}
                          </time>
                        </div>
                        <p className="mt-1 truncate pl-3.5 text-[11px] text-muted-foreground">
                          {item.actorFingerprint
                            ? `${item.actorFingerprint} · ${item.action}`
                            : item.action}
                          {item.hostName ? ` · ${item.hostName}` : ""}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </ScrollArea>
            )}
          </div>
        )}

        <nav
          className="flex w-11 flex-col items-center py-1.5"
          aria-label={t("workspace.utility.tools")}
        >
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={onOpenMetrics}
            disabled={!activeHost}
            title={t("workspace.utility.hostMetrics")}
          >
            <Gauge className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={onOpenFiles}
            disabled={!activeHost}
            title={t("workspace.utility.sftpFiles")}
          >
            <FolderOpen className="size-4" />
          </Button>
          <Button
            variant={view === "agent" ? "secondary" : "ghost"}
            size="icon"
            className="size-8"
            onClick={() => toggle("agent")}
            aria-label={t("workspace.utility.agentChat")}
            title={t("workspace.utility.agentChat")}
          >
            <Bot className="size-4" />
          </Button>
          <Button
            variant={view === "activity" ? "secondary" : "ghost"}
            size="icon"
            className="size-8"
            onClick={() => toggle("activity")}
            title={t("workspace.utility.activityLog")}
          >
            <Activity className="size-4" />
          </Button>
          <div className="mt-auto flex flex-col items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              disabled
              title={t("workspace.utility.recordings")}
            >
              <FileText className="size-4" />
            </Button>
          </div>
        </nav>
      </aside>

      <div className="md:hidden">
        {mobileAgentMounted && (
          <div
            role="dialog"
            aria-label={t("workspace.utility.agentChat")}
            className="fixed z-50 flex w-[min(calc(100vw-1.5rem),26rem)] flex-col overflow-hidden rounded-3xl border border-white/45 bg-white/30 shadow-[0_24px_80px_rgba(0,0,0,0.26)] backdrop-blur-2xl dark:border-white/10 dark:bg-zinc-950/35"
            hidden={mobileAgentMode !== "quick"}
            style={mobileAgentPanelStyle}
          >
            <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-white/30 bg-white/20 px-2.5 backdrop-blur-2xl dark:border-white/10 dark:bg-zinc-950/20">
              <div
                className="flex min-w-0 flex-1 touch-none cursor-grab items-center gap-2 active:cursor-grabbing"
                data-mobile-agent-drag-handle="true"
                onPointerDown={onMobileAgentDragPointerDown}
                title={t("workspace.utility.agentFloatMove")}
              >
                <div className="flex size-7 shrink-0 items-center justify-center rounded-full border border-accent-brand/30 bg-accent-brand/15 text-accent-brand">
                  <Bot className="size-3.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-semibold">
                    {t("workspace.utility.agentChat")}
                  </p>
                  <p className="truncate text-[10px] text-muted-foreground">
                    {activeProject.name}
                  </p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 rounded-full bg-background/15"
                onClick={() => runMobileConversationAction("settings")}
                aria-label={t("panelAgent.settings")}
                title={t("panelAgent.settings")}
              >
                <Settings2 className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 rounded-full bg-background/15"
                onClick={() => runMobileConversationAction("clear")}
                aria-label={t("panelAgent.clear")}
                title={t("panelAgent.clear")}
              >
                <Trash2 className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 rounded-full bg-background/15"
                onClick={() => runMobileConversationAction("history")}
                aria-label={t("panelAgent.history")}
                title={t("panelAgent.history")}
              >
                <History className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 rounded-full bg-background/15"
                onClick={() => runMobileConversationAction("new")}
                aria-label={t("panelAgent.newChat")}
                title={t("panelAgent.newChat")}
              >
                <MessageSquarePlus className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={() => setMobileAgentMode("bubble")}
                aria-label={t("workspace.utility.agentFloatMinimize")}
                title={t("workspace.utility.agentFloatMinimize")}
              >
                <Minus className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={() => setMobileAgentMode("hidden")}
                aria-label={t("workspace.utility.agentFloatHide")}
                title={t("workspace.utility.agentFloatHide")}
              >
                <X className="size-3.5" />
              </Button>
            </div>
            <PanelAgentPanel
              terminalTabs={terminalTabs}
              activeTabId={activeTabId}
              embedded
              compact
              conversationAction={mobileConversationAction}
            />
          </div>
        )}

        {mobileAgentMode === "hidden" ? (
          <button
            type="button"
            className={`fixed z-50 h-14 w-2 border border-accent-brand/35 bg-accent-brand/45 shadow-lg shadow-black/20 backdrop-blur-2xl ${mobileAgentPosition.side === "right" ? "rounded-l-full border-r-0" : "rounded-r-full border-l-0"}`}
            style={mobileAgentDockStyle}
            onClick={() => setMobileAgentMode("bubble")}
            aria-label={t("workspace.utility.agentFloatRestore")}
            title={t("workspace.utility.agentFloatRestore")}
          />
        ) : mobileAgentMode === "quick" ? null : (
          <button
            type="button"
            className={`fixed z-50 flex h-11 touch-none items-center gap-2 border border-accent-brand/25 bg-background/45 text-accent-brand shadow-xl shadow-black/20 backdrop-blur-2xl active:scale-95 dark:bg-zinc-950/45 ${mobileAgentPosition.side === "right" ? "rounded-l-full border-r-0 py-2 pl-2 pr-3" : "rounded-r-full border-l-0 py-2 pl-3 pr-2"}`}
            style={mobileAgentDockStyle}
            onPointerDown={onMobileAgentDragPointerDown}
            onClick={onMobileAgentFloatClick}
            aria-label={t("workspace.utility.agentFloat")}
            title={t("workspace.utility.agentFloat")}
          >
            <span className="relative flex size-7 items-center justify-center rounded-full bg-accent-brand/10">
              <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-emerald-500 ring-2 ring-background" />
              <Bot className="size-4" />
            </span>
            <span className="text-[11px] font-semibold uppercase tracking-widest">
              Agent
            </span>
          </button>
        )}
      </div>
    </>
  );
}
