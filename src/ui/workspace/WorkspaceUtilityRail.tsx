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

type UtilityView = "activity" | null;

const UTILITY_PANEL_DEFAULT_WIDTH = 520;
const UTILITY_PANEL_MIN_WIDTH = 360;
const UTILITY_PANEL_MAX_WIDTH = 860;
const UTILITY_PANEL_WIDTH_KEY = "termix_workspaceUtilityWidth";

type AgentFloatMode = "bubble" | "quick" | "hidden";
type MobileAgentMode = AgentFloatMode;
type MobileAgentSide = "left" | "right";
type MobileAgentPosition = {
  side: MobileAgentSide;
  y: number;
};
type DesktopAgentPosition = {
  x: number;
  y: number;
};
type DesktopAgentDragKind = "dock" | "panel" | "hidden";
type DesktopAgentSize = {
  width: number;
  height: number;
};

const MOBILE_AGENT_POSITION_KEY = "termix_mobileAgentPosition";
const DESKTOP_AGENT_POSITION_KEY = "termix_desktopAgentPosition";
const DESKTOP_AGENT_POSITION_VERSION = 2;
const MOBILE_AGENT_MIN_Y = 92;
const MOBILE_AGENT_BOTTOM_GUARD = 156;
const MOBILE_AGENT_PANEL_BOTTOM_GUARD = 104;
const DESKTOP_AGENT_DOCK_SIZE: DesktopAgentSize = { width: 104, height: 48 };
const DESKTOP_AGENT_HIDDEN_SIZE: DesktopAgentSize = { width: 44, height: 44 };
const DESKTOP_AGENT_PANEL_MARGIN = 16;

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

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(Math.max(min, max), Math.round(value)));
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

function desktopAgentPanelSize(
  width = viewportWidth(),
  height = viewportHeight(),
) {
  return {
    width: Math.max(340, Math.min(460, width - 96)),
    height: Math.max(380, Math.min(680, height - 48)),
  };
}

function desktopAgentDockSize(
  kind: Exclude<DesktopAgentDragKind, "panel"> = "dock",
): DesktopAgentSize {
  return kind === "hidden"
    ? DESKTOP_AGENT_HIDDEN_SIZE
    : DESKTOP_AGENT_DOCK_SIZE;
}

function clampDesktopAgentPositionForSize(
  position: DesktopAgentPosition,
  size: DesktopAgentSize,
  width = viewportWidth(),
  height = viewportHeight(),
  margin = 0,
): DesktopAgentPosition {
  return {
    x: clampNumber(position.x, margin, width - size.width - margin),
    y: clampNumber(position.y, margin, height - size.height - margin),
  };
}

function clampDesktopAgentPanelPosition(
  position: DesktopAgentPosition,
  width = viewportWidth(),
  height = viewportHeight(),
): DesktopAgentPosition {
  return clampDesktopAgentPositionForSize(
    position,
    desktopAgentPanelSize(width, height),
    width,
    height,
    DESKTOP_AGENT_PANEL_MARGIN,
  );
}

function clampDesktopAgentDockPosition(
  position: DesktopAgentPosition,
  width = viewportWidth(),
  height = viewportHeight(),
  kind: Exclude<DesktopAgentDragKind, "panel"> = "dock",
): DesktopAgentPosition {
  return clampDesktopAgentPositionForSize(
    position,
    desktopAgentDockSize(kind),
    width,
    height,
  );
}

function defaultDesktopAgentPosition(): DesktopAgentPosition {
  const width = viewportWidth();
  const height = viewportHeight();
  const dock = desktopAgentDockSize();
  return clampDesktopAgentDockPosition(
    {
      x: width - dock.width,
      y: Math.max(24, Math.round(height * 0.16)),
    },
    width,
    height,
  );
}

function storedDesktopAgentPosition(): DesktopAgentPosition {
  const fallback = defaultDesktopAgentPosition();
  const saved = readLocalStorage(DESKTOP_AGENT_POSITION_KEY);
  if (!saved) return fallback;

  try {
    const parsed = JSON.parse(saved) as Partial<DesktopAgentPosition> & {
      version?: number;
    };
    if (parsed.version !== DESKTOP_AGENT_POSITION_VERSION) {
      return fallback;
    }
    return clampDesktopAgentDockPosition({
      x: Number(parsed.x) || fallback.x,
      y: Number(parsed.y) || fallback.y,
    });
  } catch {
    return fallback;
  }
}

function suspendDocumentTextSelection() {
  if (typeof document === "undefined") return () => undefined;

  const body = document.body;
  const root = document.documentElement;
  const previousBodyUserSelect = body.style.userSelect;
  const previousRootUserSelect = root.style.userSelect;
  body.style.userSelect = "none";
  root.style.userSelect = "none";
  window.getSelection()?.removeAllRanges();

  return () => {
    body.style.userSelect = previousBodyUserSelect;
    root.style.userSelect = previousRootUserSelect;
  };
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
  const [desktopAgentMode, setDesktopAgentMode] =
    useState<AgentFloatMode>("bubble");
  const [mobileAgentMounted, setMobileAgentMounted] = useState(false);
  const [desktopAgentMounted, setDesktopAgentMounted] = useState(false);
  const [mobileAgentPosition, setMobileAgentPosition] =
    useState<MobileAgentPosition>(storedMobileAgentPosition);
  const [desktopAgentPosition, setDesktopAgentPosition] =
    useState<DesktopAgentPosition>(storedDesktopAgentPosition);
  const [mobileViewportHeight, setMobileViewportHeight] =
    useState(viewportHeight);
  const [desktopDockSize, setDesktopDockSize] = useState<DesktopAgentSize>(
    DESKTOP_AGENT_DOCK_SIZE,
  );
  const [desktopHiddenSize, setDesktopHiddenSize] = useState<DesktopAgentSize>(
    DESKTOP_AGENT_HIDDEN_SIZE,
  );
  const mobileAgentClickSuppressed = useRef(false);
  const desktopAgentClickSuppressed = useRef(false);
  const [activities, setActivities] = useState<AgentActivity[]>([]);
  const [panelWidth, setPanelWidth] = useState(storedUtilityPanelWidth);
  const [panelDragging, setPanelDragging] = useState(false);
  const [mobileConversationAction, setMobileConversationAction] =
    useState<PanelAgentConversationAction | null>(null);
  const [desktopConversationAction, setDesktopConversationAction] =
    useState<PanelAgentConversationAction | null>(null);

  function rememberDesktopFloatSize(
    kind: Exclude<DesktopAgentDragKind, "panel">,
    element: HTMLButtonElement | null,
  ) {
    if (!element) return;
    const fallback =
      kind === "hidden" ? DESKTOP_AGENT_HIDDEN_SIZE : DESKTOP_AGENT_DOCK_SIZE;
    const rect = element.getBoundingClientRect();
    const next = {
      width: Math.ceil(rect.width) || fallback.width,
      height: Math.ceil(rect.height) || fallback.height,
    };
    const updateSize =
      kind === "hidden" ? setDesktopHiddenSize : setDesktopDockSize;
    updateSize((current) =>
      current.width === next.width && current.height === next.height
        ? current
        : next,
    );
  }

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
    writeLocalStorage(
      DESKTOP_AGENT_POSITION_KEY,
      JSON.stringify({
        ...desktopAgentPosition,
        version: DESKTOP_AGENT_POSITION_VERSION,
      }),
    );
  }, [desktopAgentPosition]);

  useEffect(() => {
    function onResize() {
      const nextHeight = viewportHeight();
      const nextWidth = viewportWidth();
      setMobileViewportHeight(nextHeight);
      setMobileAgentPosition((current) => ({
        ...current,
        y: clampMobileAgentY(current.y, nextHeight),
      }));
      setDesktopAgentPosition((current) => {
        if (desktopAgentMode === "quick") {
          return clampDesktopAgentPanelPosition(current, nextWidth, nextHeight);
        }
        return clampDesktopAgentPositionForSize(
          current,
          desktopAgentMode === "hidden" ? desktopHiddenSize : desktopDockSize,
          nextWidth,
          nextHeight,
        );
      });
    }

    onResize();
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, [desktopAgentMode, desktopDockSize, desktopHiddenSize]);

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

  function onDesktopAgentDragPointerDown(
    event: ReactPointerEvent<HTMLElement>,
    kind: DesktopAgentDragKind = "dock",
  ) {
    if (event.button !== 0) return;

    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startY = event.clientY;
    const floatSize =
      kind === "panel"
        ? null
        : (() => {
            const fallback =
              kind === "hidden" ? desktopHiddenSize : desktopDockSize;
            const rect = event.currentTarget.getBoundingClientRect();
            return {
              width: Math.ceil(rect.width) || fallback.width,
              height: Math.ceil(rect.height) || fallback.height,
            };
          })();
    const startPosition =
      kind === "panel"
        ? clampDesktopAgentPanelPosition(desktopAgentPosition)
        : clampDesktopAgentPositionForSize(
            desktopAgentPosition,
            floatSize,
            viewportWidth(),
            viewportHeight(),
          );

    let moved = false;
    const dragTarget = event.currentTarget;
    const pointerId = event.pointerId;
    const restoreTextSelection = suspendDocumentTextSelection();
    desktopAgentClickSuppressed.current = false;

    try {
      dragTarget.setPointerCapture(pointerId);
    } catch {
      // Some test/browser environments do not expose pointer capture.
    }

    function onMove(moveEvent: globalThis.PointerEvent) {
      moveEvent.preventDefault();
      window.getSelection()?.removeAllRanges();
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      if (Math.hypot(deltaX, deltaY) > 4) moved = true;
      const width = viewportWidth();
      const height = viewportHeight();
      const nextPosition = {
        x: startPosition.x + deltaX,
        y: startPosition.y + deltaY,
      };
      setDesktopAgentPosition(
        kind === "panel"
          ? clampDesktopAgentPanelPosition(nextPosition, width, height)
          : clampDesktopAgentPositionForSize(
              nextPosition,
              floatSize,
              width,
              height,
            ),
      );
    }

    function onUp() {
      restoreTextSelection();
      try {
        dragTarget.releasePointerCapture(pointerId);
      } catch {
        // Ignore stale capture in jsdom and cancelled native drags.
      }
      if (moved) {
        desktopAgentClickSuppressed.current = true;
        window.setTimeout(() => {
          desktopAgentClickSuppressed.current = false;
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

  function onDesktopAgentFloatClick(event: MouseEvent<HTMLButtonElement>) {
    if (desktopAgentClickSuppressed.current) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    setDesktopAgentPosition((current) =>
      clampDesktopAgentPanelPosition(current),
    );
    setDesktopAgentMounted(true);
    setDesktopAgentMode("quick");
  }

  function openDesktopAgentPanel() {
    setDesktopAgentMounted(true);
    setDesktopAgentPosition((current) =>
      desktopAgentMode === "quick"
        ? clampDesktopAgentDockPosition(current)
        : clampDesktopAgentPanelPosition(current),
    );
    setDesktopAgentMode((current) =>
      current === "quick" ? "bubble" : "quick",
    );
  }

  function collapseDesktopAgentPanel() {
    setDesktopAgentPosition((current) =>
      clampDesktopAgentDockPosition(current),
    );
    setDesktopAgentMode("bubble");
  }

  function collapseMobileAgentPanel() {
    setMobileAgentMode("bubble");
  }

  function runMobileConversationAction(
    type: PanelAgentConversationAction["type"],
  ) {
    setMobileConversationAction({ id: Date.now(), type });
  }

  function runDesktopConversationAction(
    type: PanelAgentConversationAction["type"],
  ) {
    setDesktopConversationAction({ id: Date.now(), type });
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

  function toggle(next: Exclude<UtilityView, null>) {
    setView((current) => (current === next ? null : next));
  }

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

  const desktopViewportWidth = viewportWidth();
  const desktopViewportHeight = viewportHeight();
  const desktopPanelSize = desktopAgentPanelSize(
    desktopViewportWidth,
    desktopViewportHeight,
  );
  const desktopPanelPosition = clampDesktopAgentPanelPosition(
    desktopAgentPosition,
    desktopViewportWidth,
    desktopViewportHeight,
  );
  const desktopFloatSize =
    desktopAgentMode === "hidden" ? desktopHiddenSize : desktopDockSize;
  const desktopDockPosition = clampDesktopAgentPositionForSize(
    desktopAgentPosition,
    desktopFloatSize,
    desktopViewportWidth,
    desktopViewportHeight,
  );

  const desktopAgentDockStyle: CSSProperties = {
    left: desktopDockPosition.x,
    top: desktopDockPosition.y,
  };
  const desktopAgentPanelStyle: CSSProperties = {
    left: desktopPanelPosition.x,
    top: desktopPanelPosition.y,
    width: desktopPanelSize.width,
    height: desktopPanelSize.height,
    backgroundColor: "rgba(255, 255, 255, 0.3)",
    backdropFilter: "blur(40px) saturate(170%)",
    WebkitBackdropFilter: "blur(40px) saturate(170%)",
  };

  return (
    <>
      <aside className="hidden shrink-0 border-l border-border bg-sidebar md:flex">
        {view === "activity" && (
          <div
            className={`relative min-w-0 shrink-0 flex flex-col border-r bg-background transition-colors ${panelDragging ? "border-accent-brand/60" : "border-border"}`}
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
                  {t("workspace.utility.activityLog")}
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
            <div
              className="min-h-0 flex-1 flex-col overflow-hidden data-[visible=true]:flex"
              data-visible={view === "activity"}
            >
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
            </div>
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
            variant={desktopAgentMode === "quick" ? "secondary" : "ghost"}
            size="icon"
            className="size-8"
            onClick={openDesktopAgentPanel}
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

      <div className="hidden md:block">
        {desktopAgentMounted && desktopAgentMode === "quick" && (
          <div
            aria-hidden="true"
            className="fixed inset-0 z-40 bg-transparent"
            data-testid="desktop-agent-outside-dismiss"
            onPointerDown={collapseDesktopAgentPanel}
          />
        )}

        {desktopAgentMounted && (
          <div
            role="dialog"
            aria-label={t("workspace.utility.agentChat")}
            className="fixed z-50 flex flex-col overflow-hidden rounded-3xl border border-white/45 bg-white/30 shadow-[0_24px_80px_rgba(0,0,0,0.22)] backdrop-blur-2xl dark:border-white/10 dark:bg-zinc-950/35"
            hidden={desktopAgentMode !== "quick"}
            style={desktopAgentPanelStyle}
            data-testid="desktop-agent-floating-panel"
          >
            <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-white/30 bg-white/20 px-2.5 backdrop-blur-2xl dark:border-white/10 dark:bg-zinc-950/20">
              <div
                className="flex min-w-0 flex-1 touch-none select-none cursor-grab items-center gap-2 active:cursor-grabbing"
                data-desktop-agent-drag-handle="true"
                onPointerDown={(event) =>
                  onDesktopAgentDragPointerDown(event, "panel")
                }
                title={t("workspace.utility.agentFloatMove")}
              >
                <div className="flex size-8 shrink-0 items-center justify-center rounded-full border border-accent-brand/30 bg-accent-brand/15 text-accent-brand">
                  <Bot className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">
                    {t("workspace.utility.agentChat")}
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {activeProject.name}
                  </p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 rounded-full bg-background/15"
                onClick={() => runDesktopConversationAction("settings")}
                aria-label={t("panelAgent.settings")}
                title={t("panelAgent.settings")}
              >
                <Settings2 className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 rounded-full bg-background/15"
                onClick={() => runDesktopConversationAction("clear")}
                aria-label={t("panelAgent.clear")}
                title={t("panelAgent.clear")}
              >
                <Trash2 className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 rounded-full bg-background/15"
                onClick={() => runDesktopConversationAction("history")}
                aria-label={t("panelAgent.history")}
                title={t("panelAgent.history")}
              >
                <History className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 rounded-full bg-background/15"
                onClick={() => runDesktopConversationAction("new")}
                aria-label={t("panelAgent.newChat")}
                title={t("panelAgent.newChat")}
              >
                <MessageSquarePlus className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={collapseDesktopAgentPanel}
                aria-label={t("workspace.utility.agentFloatMinimize")}
                title={t("workspace.utility.agentFloatMinimize")}
              >
                <Minus className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={() => setDesktopAgentMode("hidden")}
                aria-label={t("workspace.utility.agentFloatHide")}
                title={t("workspace.utility.agentFloatHide")}
              >
                <X className="size-4" />
              </Button>
            </div>
            <PanelAgentPanel
              terminalTabs={terminalTabs}
              activeTabId={activeTabId}
              embedded
              compact
              conversationAction={desktopConversationAction}
            />
          </div>
        )}

        {desktopAgentMode === "hidden" ? (
          <button
            type="button"
            className="fixed z-50 flex size-11 items-center justify-center rounded-full border border-accent-brand/35 bg-background/55 text-accent-brand shadow-xl shadow-black/20 backdrop-blur-2xl active:scale-95 dark:bg-zinc-950/45"
            style={desktopAgentDockStyle}
            ref={(element) => rememberDesktopFloatSize("hidden", element)}
            onClick={() => setDesktopAgentMode("bubble")}
            aria-label={t("workspace.utility.agentFloatRestore")}
            title={t("workspace.utility.agentFloatRestore")}
          >
            <Bot className="size-5" />
          </button>
        ) : desktopAgentMode === "quick" ? null : (
          <button
            type="button"
            className="fixed z-50 flex h-12 touch-none select-none items-center gap-2 rounded-full border border-accent-brand/25 bg-background/45 py-2 pl-2 pr-3 text-accent-brand shadow-xl shadow-black/20 backdrop-blur-2xl active:scale-95 dark:bg-zinc-950/45"
            style={desktopAgentDockStyle}
            ref={(element) => rememberDesktopFloatSize("dock", element)}
            onPointerDown={(event) =>
              onDesktopAgentDragPointerDown(event, "dock")
            }
            onClick={onDesktopAgentFloatClick}
            aria-label={t("workspace.utility.agentFloatDesktop")}
            title={t("workspace.utility.agentFloatDesktop")}
            data-testid="desktop-agent-float"
          >
            <span className="relative flex size-8 items-center justify-center rounded-full bg-accent-brand/10">
              <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-emerald-500 ring-2 ring-background" />
              <Bot className="size-5" />
            </span>
            <span className="text-[11px] font-semibold uppercase tracking-widest">
              Agent
            </span>
          </button>
        )}
      </div>
      <div className="md:hidden">
        {mobileAgentMounted && mobileAgentMode === "quick" && (
          <div
            aria-hidden="true"
            className="fixed inset-0 z-40 bg-transparent"
            data-testid="mobile-agent-outside-dismiss"
            onPointerDown={collapseMobileAgentPanel}
          />
        )}

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
                onClick={collapseMobileAgentPanel}
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
