import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  Bot,
  ChevronRight,
  FileText,
  FolderOpen,
  Gauge,
  Radio,
} from "lucide-react";
import { Button } from "@/components/button";
import { ScrollArea } from "@/components/scroll-area";
import { useWorkspace } from "@/workspace/WorkspaceContext";
import {
  getProjectAgentActivity,
  type AgentActivity,
} from "@/api/workspace-api";
import type { Host } from "@/types/ui-types";

type UtilityView = "agent" | "activity" | null;

function statusClass(status: AgentActivity["status"]) {
  if (status === "running") return "bg-emerald-500";
  if (status === "failed") return "bg-red-500";
  if (status === "waiting") return "bg-amber-500";
  return "bg-muted-foreground/50";
}

export function WorkspaceUtilityRail({
  activeHost,
  onOpenFiles,
  onOpenMetrics,
  onLayoutChange,
}: {
  activeHost?: Host;
  onOpenFiles: () => void;
  onOpenMetrics: () => void;
  onLayoutChange: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { activeProject } = useWorkspace();
  const [view, setView] = useState<UtilityView>(null);
  const [activities, setActivities] = useState<AgentActivity[]>([]);

  useEffect(() => {
    if (!view) return;
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
  }, [onLayoutChange, view]);

  const toggle = (next: Exclude<UtilityView, null>) =>
    setView((current) => (current === next ? null : next));

  return (
    <aside className="hidden md:flex shrink-0 border-l border-border bg-sidebar">
      {view && (
        <div className="flex w-[340px] flex-col border-r border-border bg-background">
          <div className="flex h-11 items-center border-b border-border px-3">
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold">
                {view === "agent"
                  ? t("workspace.utility.agentSessions")
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

          {view === "agent" && (
            <div className="border-b border-border p-3">
              <div className="flex items-center gap-2 text-xs">
                <Radio className="size-3.5 text-emerald-500" />
                <span className="font-semibold">
                  {t("workspace.utility.singleWriterLease")}
                </span>
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {activities.some((item) => item.status === "running")
                    ? t("workspace.utility.inUse")
                    : t("workspace.utility.idle")}
                </span>
              </div>
            </div>
          )}

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
          title={t("workspace.utility.agentSessions")}
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
