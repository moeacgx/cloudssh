import { useCallback, useEffect, useRef, useState } from "react";
import { getSSHHosts, type SSHHostWithStatus } from "@/main-axios";
import {
  getWorkspaceProjectFolders,
  getWorkspaceProjectServers,
} from "@/api/workspace-api";
import type { Host, HostFolder } from "@/types/ui-types";
import { sshHostToHost } from "@/sidebar/HostManagerData";
import { dbHealthMonitor } from "@/lib/db-health-monitor";
import { hasPendingHostNetworkInfo } from "@/lib/host-network-info";
import { usePageVisibleInterval } from "@/hooks/use-page-visible-interval";

type HostState = {
  projectId: string;
  hostTree: HostFolder | null;
  hosts: Host[];
  projectHostIdsByHostId: Map<string, number>;
  loading: boolean;
  loaded: boolean;
  error: boolean;
};

const EMPTY_HOSTS: Host[] = [];
const EMPTY_ASSOCIATIONS = new Map<string, number>();

function emptyState(projectId: string): HostState {
  return {
    projectId,
    hostTree: null,
    hosts: EMPTY_HOSTS,
    projectHostIdsByHostId: EMPTY_ASSOCIATIONS,
    loading: true,
    loaded: false,
    error: false,
  };
}

export function useWorkspaceHosts(projectId: string) {
  const [state, setState] = useState(() => emptyState(projectId));
  const loadRef = useRef<(queue?: boolean) => Promise<void>>(async () => {});
  // 渲染阶段即隔离项目，不能等待 effect 清空上一项目的资产。
  const current = state.projectId === projectId ? state : emptyState(projectId);
  const reload = useCallback(() => loadRef.current(), []);

  usePageVisibleInterval(
    reload,
    3_000,
    hasPendingHostNetworkInfo(current.hosts),
    { runOnMount: false },
  );

  useEffect(() => {
    let cancelled = false;
    let inFlight: Promise<void> | null = null;
    let queued = false;
    let failed = false;
    setState(emptyState(projectId));

    const load = (queue = false): Promise<void> => {
      if (inFlight) {
        // 轮询共享在途请求；真实资产变更必须在其完成后再查询一次。
        if (queue) queued = true;
        return inFlight;
      }
      inFlight = (async () => {
        do {
          queued = false;
          setState((previous) => ({ ...previous, loading: !previous.loaded }));
          try {
            const [raw, projectServers, folders] = await Promise.all([
              getSSHHosts({ includeStatus: false }),
              getWorkspaceProjectServers(projectId),
              getWorkspaceProjectFolders(projectId),
            ]);
            if (cancelled) return;
            const byHostId = new Map(
              projectServers.map((server) => [String(server.hostId), server]),
            );
            const visible = raw
              .filter((host) => byHostId.has(String(host.id)))
              .map((host) => {
                const server = byHostId.get(String(host.id))!;
                return {
                  ...host,
                  projectHostId: server.projectHostId,
                  sourceName: host.name,
                  sourceFolder: host.folder ?? "",
                  name: server.name || host.name,
                  folder: server.folder ?? "",
                  tags: server.tags ?? host.tags,
                  networkInfo: server.networkInfo ?? host.networkInfo,
                  linkedProjectCount: server.linkedProjectCount ?? 1,
                  canDeleteFromAllProjects:
                    server.canDeleteFromAllProjects ?? !host.isShared,
                };
              });
            const metadata = new Map(
              folders.map((folder) => [
                folder.path,
                {
                  color: folder.color ?? undefined,
                  icon: folder.icon ?? undefined,
                  credentialId: null,
                },
              ]),
            );
            failed = false;
            setState({
              projectId,
              hosts: visible.map(sshHostToHost),
              hostTree: buildHostTree(visible, metadata),
              projectHostIdsByHostId: new Map(
                projectServers.map((server) => [
                  String(server.hostId),
                  server.projectHostId,
                ]),
              ),
              loading: false,
              loaded: true,
              error: false,
            });
          } catch {
            if (cancelled) return;
            failed = true;
            // 失败不代表空项目，也不能提前放行标签恢复。
            setState((previous) => ({
              ...previous,
              loading: false,
              error: true,
            }));
          }
        } while (queued && !cancelled);
      })().finally(() => {
        inFlight = null;
      });
      return inFlight;
    };
    loadRef.current = load;
    const onChanged = () => {
      void load(true);
    };
    const onRestored = () => {
      if (failed) void load();
    };
    const events = [
      "termix:hosts-changed",
      "ssh-hosts:changed",
      "hosts:refresh",
    ];
    events.forEach((event) => window.addEventListener(event, onChanged));
    dbHealthMonitor.on("database-connection-degraded-cleared", onRestored);
    void load();
    return () => {
      cancelled = true;
      events.forEach((event) => window.removeEventListener(event, onChanged));
      dbHealthMonitor.off("database-connection-degraded-cleared", onRestored);
    };
  }, [projectId]);

  return { ...current, reload };
}

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
  // 保留尚未添加主机的空目录，避免它们在刷新后消失。
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
