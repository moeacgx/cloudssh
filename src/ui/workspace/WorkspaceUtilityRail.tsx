import { useEffect, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  Bot,
  ChevronRight,
  FileText,
  FolderOpen,
  Gauge,
} from "lucide-react";
import { Button } from "@/components/button";
import { ScrollArea } from "@/components/scroll-area";
import { useWorkspace } from "@/workspace/WorkspaceContext";
import {
  getProjectAgentActivity,
  type AgentActivity,
} from "@/api/workspace-api";
import { PanelAgentPanel } from "@/sidebar/PanelAgentPanel";
import type { Host, Tab } from "@/types/ui-types";

type UtilityView = "agent" | "activity" | null;

const UTILITY_PANEL_DEFAULT_WIDTH = 520;
const UTILITY_PANEL_MIN_WIDTH = 360;
const UTILITY_PANEL_MAX_WIDTH = 860;
const UTILITY_PANEL_WIDTH_KEY = "termix_workspaceUtilityWidth";

function clampUtilityPanelWidth(width: number) {
  return Math.max(
    UTILITY_PANEL_MIN_WIDTH,
    Math.min(UTILITY_PANEL_MAX_WIDTH, Math.round(width)),
  );
}

function storedUtilityPanelWidth() {
  const saved = localStorage.getItem(UTILITY_PANEL_WIDTH_KEY);
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
  const [activities, setActivities] = useState<AgentActivity[]>([]);
  const [panelWidth, setPanelWidth] = useState(storedUtilityPanelWidth);
  const [panelDragging, setPanelDragging] = useState(false);

  useEffect(() => {
    localStorage.setItem(UTILITY_PANEL_WIDTH_KEY, String(panelWidth));
  }, [panelWidth]);

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

  return (
    <aside className="hidden md:flex shrink-0 border-l border-border bg-sidebar">
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
  );
}
