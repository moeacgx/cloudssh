import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  ArrowRight,
  Bot,
  Clock3,
  MonitorDot,
  Server,
  TerminalSquare,
  Users,
} from "lucide-react";
import { Button } from "@/components/button";
import { HostNetworkInfoView } from "@/components/host-network-info";
import { getActiveSessions, getSSHHosts } from "@/main-axios";
import type { ActiveSessionInfo, SSHHostWithStatus } from "@/main-axios";
import { sshHostToHost } from "@/sidebar/HostManagerData";
import type { Host, TabType } from "@/types/ui-types";
import { usePageVisibleInterval } from "@/hooks/use-page-visible-interval";
import { hasPendingHostNetworkInfo } from "@/lib/host-network-info";
import { useWorkspace } from "@/workspace/WorkspaceContext";
import {
  getWorkspaceProjectOverview,
  getWorkspaceProjectServers,
  type AgentActivity,
  type WorkspaceProjectSession,
} from "@/api/workspace-api";
import { ProjectSettingsDialog } from "@/workspace/ProjectSettingsDialog";

export function ProjectOverview({
  onOpenTab,
  onOpenAgentSession,
}: {
  onOpenTab: (host: Host, type: TabType) => void;
  onOpenAgentSession?: (host: Host, sessionId: string, label: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const { activeProject, refreshProjects } = useWorkspace();
  const [hosts, setHosts] = useState<SSHHostWithStatus[]>([]);
  const [sessions, setSessions] = useState<ActiveSessionInfo[]>([]);
  const [activity, setActivity] = useState<AgentActivity[]>([]);
  const [agentSessions, setAgentSessions] = useState<WorkspaceProjectSession[]>(
    [],
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [networkInfoRefreshVersion, setNetworkInfoRefreshVersion] = useState(0);

  usePageVisibleInterval(
    () => setNetworkInfoRefreshVersion((version) => version + 1),
    3_000,
    hasPendingHostNetworkInfo(hosts),
    { runOnMount: false },
  );

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getSSHHosts(),
      getWorkspaceProjectServers(activeProject.id),
      getActiveSessions().catch(() => []),
      getWorkspaceProjectOverview(activeProject.id).catch(() => ({
        sessions: [],
        recentAgentActivity: [],
      })),
    ]).then(([nextHosts, projectServers, nextSessions, nextOverview]) => {
      if (cancelled) return;
      const hostsById = new Map(
        nextHosts.map((host) => [Number(host.id), host]),
      );
      setHosts(
        projectServers.flatMap((server) => {
          const host = hostsById.get(Number(server.hostId));
          if (!host) return [];
          return [
            {
              ...host,
              projectHostId: server.projectHostId,
              sourceName: host.name,
              sourceFolder: host.folder ?? "",
              name: server.name || host.name,
              folder: server.folder ?? "",
              networkInfo: server.networkInfo ?? host.networkInfo,
            },
          ];
        }),
      );
      const projectHostIds = new Set(
        projectServers.map((server) => Number(server.projectHostId)),
      );
      const projectHostIdsByHostId = new Set(
        projectServers.map((server) => Number(server.hostId)),
      );
      setSessions(
        nextSessions.filter((session) => {
          // Agent 浏览器观察附件拥有独立的网页 sessionId，但它并不是
          // 第二条持续会话；权威行的 sessionId 与 agentSessionId 相同。
          if (
            session.agentSessionId &&
            session.sessionId !== session.agentSessionId
          ) {
            return false;
          }
          // 新接口带有项目主机关联 ID，优先使用它避免同一主机跨项目串线；
          // 旧网页会话没有该字段时再按主机 ID兼容过滤。
          if (session.projectHostId != null) {
            return projectHostIds.has(Number(session.projectHostId));
          }
          return projectHostIdsByHostId.has(Number(session.hostId));
        }),
      );
      setActivity(nextOverview.recentAgentActivity.slice(0, 8));
      // 概览中的持续会话既可能由网页用户创建，也可能由 Agent 创建。
      // 只有服务账号会话才能走 Agent 附着流程，避免把普通固定窗口误标为 Agent。
      setAgentSessions(
        nextOverview.sessions.filter(
          (session) => session.actor.type === "service_account",
        ),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [activeProject.id, networkInfoRefreshVersion]);

  const online = hosts.filter((host) => host.status === "online").length;
  const pinned = useMemo(
    () => [...hosts].sort((a, b) => Number(b.pin) - Number(a.pin)).slice(0, 8),
    [hosts],
  );
  const hostByProjectHostId = useMemo(
    () => new Map(hosts.map((host) => [Number(host.projectHostId), host])),
    [hosts],
  );

  function describeActivity(item: AgentActivity): string {
    const action = item.action.toLowerCase();
    if (action.includes("/sessions/") && action.includes("/read")) {
      return t("workspace.agentActivityReadOutput");
    }
    if (action.includes("/sessions/") && action.includes("/write")) {
      return t("workspace.agentActivityWriteInput");
    }
    if (action.includes("/sessions/") && action.includes("/resize")) {
      return t("workspace.agentActivityResize");
    }
    if (action.includes("/attach")) {
      return t("workspace.agentActivityAttach");
    }
    if (action.includes("/detach")) {
      return t("workspace.agentActivityDetach");
    }
    if (action.includes("/close")) {
      return t("workspace.agentActivityClose");
    }
    // 创建会话只匹配集合端点，不能把 write/attach 等 POST 操作误判为创建。
    if (/^post\s+(?:\/agent\/v1)?\/sessions(?::intent)?$/.test(action)) {
      return t("workspace.agentActivityCreateSession");
    }
    if (action.includes("/jobs")) {
      return t("workspace.agentActivityJob");
    }
    if (action.includes("/servers")) {
      return t("workspace.agentActivityListServers");
    }
    return item.action.replace(/^(get|post|patch|delete)\s+/i, "");
  }

  function renderActivityItem(item: AgentActivity) {
    const activitySession = item.sessionId
      ? agentSessions.find((session) => session.id === item.sessionId)
      : undefined;
    const activityHost =
      item.projectHostId == null
        ? undefined
        : hostByProjectHostId.get(Number(item.projectHostId));
    const activityHostModel = activityHost
      ? sshHostToHost(activityHost)
      : undefined;
    const canEnterAgent = Boolean(
      activitySession &&
      activityHostModel &&
      onOpenAgentSession &&
      (activitySession.state === "RUNNING" ||
        activitySession.state === "RECOVERING"),
    );
    const openAgent = () => {
      if (!canEnterAgent || !activitySession || !activityHostModel) return;
      onOpenAgentSession?.(
        activityHostModel,
        activitySession.id,
        activitySession.title || activitySession.serverName,
      );
    };

    return (
      <div key={item.id} className="px-3 py-3">
        <div
          role={canEnterAgent ? "button" : undefined}
          tabIndex={canEnterAgent ? 0 : undefined}
          onClick={canEnterAgent ? openAgent : undefined}
          onKeyDown={
            canEnterAgent
              ? (event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openAgent();
                  }
                }
              : undefined
          }
          className={`rounded ${canEnterAgent ? "cursor-pointer transition-colors hover:bg-muted/40" : ""}`}
        >
          <div className="flex items-center gap-2">
            <Bot className="size-3 text-muted-foreground" />
            <span className="truncate text-[11px] font-medium">
              {item.actorName}
            </span>
            <time className="ml-auto text-[9px] text-muted-foreground">
              {new Date(item.createdAt).toLocaleTimeString(i18n.language, {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
          </div>
          <p className="mt-1 truncate pl-5 text-[10px] text-muted-foreground">
            {item.actorFingerprint
              ? `${item.actorFingerprint} · ${describeActivity(item)}`
              : describeActivity(item)}
          </p>
        </div>
        {(activityHostModel || canEnterAgent) && (
          <div className="mt-2 flex justify-end gap-1.5">
            {canEnterAgent && (
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[10px]"
                onClick={openAgent}
              >
                {t("workspace.enterAgentSession")}
              </Button>
            )}
            {activityHostModel && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[10px]"
                onClick={() => onOpenTab(activityHostModel, "terminal")}
              >
                {t("workspace.newSshTerminal")}
              </Button>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-background">
      <div className="mx-auto flex w-full max-w-6xl flex-col px-4 py-6 md:px-7 md:py-8">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
              <span>
                {activeProject.kind === "personal"
                  ? t("workspace.personalSpace")
                  : t("workspace.teamProject")}
              </span>
              <span>·</span>
              <span>
                {t("workspace.memberCount", {
                  count: activeProject.memberCount,
                })}
              </span>
            </div>
            <h1 className="text-xl font-semibold">{activeProject.name}</h1>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("workspace.overviewDescription")}
            </p>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            {t("workspace.hostsOnline", { online, total: hosts.length })}
          </div>
        </div>

        <section className="mt-6 grid grid-cols-2 border border-border md:grid-cols-4">
          {[
            [Server, t("workspace.metrics.servers"), String(hosts.length)],
            [MonitorDot, t("workspace.metrics.online"), String(online)],
            [
              TerminalSquare,
              t("workspace.metrics.persistentSessions"),
              String(sessions.length),
            ],
            [
              Bot,
              t("workspace.metrics.agentActivity"),
              String(activity.length),
            ],
          ].map(([Icon, label, value], index) => {
            const MetricIcon = Icon as typeof Server;
            return (
              <div
                key={label as string}
                className={`flex min-h-24 flex-col justify-between p-3.5 ${index % 2 ? "border-l" : ""} ${index >= 2 ? "border-t md:border-t-0" : ""} md:border-l first:md:border-l-0 border-border`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[10px] uppercase text-muted-foreground">
                    {label as string}
                  </span>
                  <MetricIcon className="size-3.5 text-muted-foreground" />
                </div>
                <span className="text-2xl font-semibold">
                  {value as string}
                </span>
              </div>
            );
          })}
        </section>

        <section className="mt-6">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-xs font-semibold">
                {t("workspace.persistentSessions")}
              </h2>
              {agentSessions.length > 0 && (
                <span className="text-[10px] text-muted-foreground">
                  {t("workspace.agentSessionHint")}
                </span>
              )}
            </div>
            <TerminalSquare className="size-3.5 text-muted-foreground" />
          </div>
          <div className="divide-y divide-border border border-border">
            {agentSessions.length === 0 ? (
              <div className="px-4 py-7 text-center text-xs text-muted-foreground">
                {t("workspace.noPersistentSessions")}
              </div>
            ) : (
              agentSessions.map((session) => {
                const host = hostByProjectHostId.get(
                  Number(session.projectHostId),
                );
                const hostModel = host ? sshHostToHost(host) : undefined;
                const isRunning =
                  session.state === "RUNNING" || session.state === "RECOVERING";
                return (
                  <div
                    key={session.id}
                    className="group flex flex-wrap items-center gap-3 px-3.5 py-3"
                  >
                    <span
                      className={`size-2 shrink-0 rounded-full ${isRunning ? "bg-emerald-500" : "bg-amber-500"}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <p className="truncate text-xs font-medium">
                          {session.title || session.serverName}
                        </p>
                        <span className="rounded border border-violet-400/40 bg-violet-500/10 px-1 py-0.5 text-[9px] font-semibold text-violet-600 dark:text-violet-300">
                          Agent
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                        {session.serverName} · {t("workspace.agentActor")} ·{" "}
                        {t(
                          session.state === "CREATING"
                            ? "workspace.sessionStateCreating"
                            : session.state === "RUNNING"
                              ? "workspace.sessionStateRunning"
                              : session.state === "RECOVERING"
                                ? "workspace.sessionStateRecovering"
                                : "workspace.sessionStateClosing",
                        )}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {hostModel && onOpenAgentSession && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-[10px]"
                          disabled={!isRunning}
                          onClick={() =>
                            onOpenAgentSession(
                              hostModel,
                              session.id,
                              session.title || session.serverName,
                            )
                          }
                        >
                          {t("workspace.enterAgentSession")}
                        </Button>
                      )}
                      {hostModel && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-[10px]"
                          onClick={() => onOpenTab(hostModel, "terminal")}
                        >
                          {t("workspace.newSshTerminal")}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        <div className="mt-6 grid min-h-0 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-xs font-semibold">
                {t("workspace.servers")}
              </h2>
              <span className="text-[10px] text-muted-foreground">
                {t("workspace.currentProject")}
              </span>
            </div>
            <div className="divide-y divide-border border border-border">
              {pinned.length === 0 ? (
                <div className="px-4 py-12 text-center text-xs text-muted-foreground">
                  {t("workspace.noServers")}
                </div>
              ) : (
                pinned.map((host) => (
                  <button
                    key={host.id}
                    className="group flex w-full items-center gap-3 px-3.5 py-3 text-left hover:bg-muted/50"
                    onClick={() => onOpenTab(sshHostToHost(host), "terminal")}
                  >
                    <span
                      className={`size-2 rounded-full ${host.status === "online" ? "bg-emerald-500" : "bg-muted-foreground/35"}`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">
                        {host.name}
                      </p>
                      <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                        {host.username}@{host.ip}:{host.port}
                      </p>
                      <HostNetworkInfoView
                        networkInfo={host.networkInfo}
                        className="mt-1 max-w-xl"
                      />
                    </div>
                    <ArrowRight className="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                  </button>
                ))
              )}
            </div>
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-xs font-semibold">
                {t("workspace.recentActivity")}
              </h2>
              <Activity className="size-3.5 text-muted-foreground" />
            </div>
            <div className="divide-y divide-border border border-border">
              {activity.length === 0 ? (
                <div className="px-4 py-12 text-center">
                  <Clock3 className="mx-auto mb-2 size-5 text-muted-foreground/40" />
                  <p className="text-xs text-muted-foreground">
                    {t("workspace.noAgentActivity")}
                  </p>
                </div>
              ) : (
                activity.map(renderActivityItem)
              )}
            </div>
          </section>
        </div>

        <footer className="mt-7 flex items-center gap-2 border-t border-border pt-4 text-[10px] text-muted-foreground">
          <Users className="size-3" />
          {t("workspace.memberCount", { count: activeProject.memberCount })}
          <Button
            variant="link"
            size="sm"
            className="ml-auto h-auto px-0 text-[10px]"
            onClick={() => setSettingsOpen(true)}
          >
            {t("workspace.projectSettings")}
          </Button>
        </footer>
      </div>
      <ProjectSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        project={activeProject}
        onUpdated={refreshProjects}
      />
    </div>
  );
}
