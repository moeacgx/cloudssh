import { AxiosError } from "axios";
import {
  authApi,
  getAllServerStatuses,
  handleApiError,
  sshHostApi,
} from "@/main-axios";
import type { SSHHost, SSHHostData, ProxyNode } from "@/types/index";
import type { ServerStatus, SSHHostWithStatus } from "@/main-axios";
import type { ProxmoxDiscoverResult, ProxmoxSyncResult } from "@/types/proxmox";
import {
  getCachedSSHHosts,
  invalidateHostsAndStatusCaches,
} from "@/lib/hosts-request-cache";
import {
  invalidateWorkspaceProjectCaches,
  requireResolvedWorkspaceProjectId,
} from "@/api/workspace-api";

// SSH HOST MANAGEMENT
// ============================================================================

export type GetSSHHostsOptions = {
  /** When false, skip the status service call (host config only). Default true. */
  includeStatus?: boolean;
};

export type ProjectHostUpdateContext = {
  projectId: string;
  projectHostId: number;
  alias: string | null;
  folder: string | null;
  tags?: string[];
};

async function loadSSHHostsFromApi(): Promise<SSHHost[]> {
  const hostsResponse = await sshHostApi.get("/db/host");
  return Array.isArray(hostsResponse.data) ? hostsResponse.data : [];
}

async function findProjectHostAssociation(
  projectId: string,
  hostId: number,
): Promise<{ projectHostId: number } | null> {
  try {
    const resolvedProjectId = requireResolvedWorkspaceProjectId(projectId);
    const response = await authApi.get(
      `/control-plane/projects/${encodeURIComponent(resolvedProjectId)}/servers`,
    );
    return (
      (Array.isArray(response.data?.servers) ? response.data.servers : []).find(
        (server: { hostId?: unknown }) => Number(server.hostId) === hostId,
      ) ?? null
    );
  } catch {
    return null;
  }
}

export async function getSSHHosts(
  options: GetSSHHostsOptions = {},
): Promise<SSHHostWithStatus[]> {
  const includeStatus = options.includeStatus !== false;

  try {
    const hosts = await getCachedSSHHosts(loadSSHHostsFromApi);

    if (!includeStatus) {
      return hosts.map((host) => ({
        ...host,
        status: "unknown",
      }));
    }

    let statuses: Record<number, ServerStatus> = {};
    try {
      statuses = (await getAllServerStatuses()) || {};
    } catch {
      // Status fetch failure should not prevent host list from loading
    }

    return hosts.map((host) => ({
      ...host,
      status: statuses[host.id]?.status || "unknown",
    }));
  } catch (error) {
    throw handleApiError(error, "fetch SSH hosts");
  }
}

export async function createSSHHost(
  hostData: SSHHostData,
  projectId: string,
): Promise<SSHHost> {
  try {
    const normalizedProjectId = requireResolvedWorkspaceProjectId(projectId);
    const requestData = { ...hostData, projectId: normalizedProjectId };
    if (hostData.authType === "key" && hostData.key instanceof File) {
      const formData = new FormData();
      formData.append("key", hostData.key);
      const dataWithoutFile = { ...requestData, key: undefined };
      formData.append("data", JSON.stringify(dataWithoutFile));
      const response = await sshHostApi.post("/db/host", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      invalidateHostsAndStatusCaches();
      invalidateWorkspaceProjectCaches();
      return response.data;
    }

    const response = await sshHostApi.post("/db/host", requestData);
    invalidateHostsAndStatusCaches();
    invalidateWorkspaceProjectCaches();
    return response.data;
  } catch (error) {
    throw handleApiError(error, "create SSH host");
  }
}

export async function updateSSHHost(
  hostId: number,
  hostData: SSHHostData,
  projectContext?: ProjectHostUpdateContext,
): Promise<SSHHost> {
  try {
    const requestData = projectContext
      ? {
          ...hostData,
          projectContext: {
            ...projectContext,
            projectId: requireResolvedWorkspaceProjectId(
              projectContext.projectId,
            ),
          },
        }
      : hostData;
    if (hostData.authType === "key" && hostData.key instanceof File) {
      const formData = new FormData();
      formData.append("key", hostData.key);
      const dataWithoutFile = { ...requestData, key: undefined };
      formData.append("data", JSON.stringify(dataWithoutFile));
      const response = await sshHostApi.put(`/db/host/${hostId}`, formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      invalidateHostsAndStatusCaches();
      invalidateWorkspaceProjectCaches();
      return response.data;
    }
    const response = await sshHostApi.put(`/db/host/${hostId}`, requestData);
    invalidateHostsAndStatusCaches();
    invalidateWorkspaceProjectCaches();
    return response.data;
  } catch (error) {
    throw handleApiError(error, "update SSH host");
  }
}

export async function wakeOnLan(hostId: number): Promise<{ success: boolean }> {
  try {
    const response = await sshHostApi.post(`/db/host/${hostId}/wake`);
    return response.data;
  } catch (error) {
    throw handleApiError(error, "wake on LAN");
  }
}

export type HostImportResult = {
  message: string;
  success: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: string[];
  createdHostIds: number[];
  updatedHostIds: number[];
  matchedHostIds: number[];
  associationFailed: number;
};

function isAlreadyAssociated(error: unknown): boolean {
  return error instanceof AxiosError && error.response?.status === 409;
}

async function associateImportedHosts(
  result: Omit<
    HostImportResult,
    "associationFailed" | "createdHostIds" | "updatedHostIds" | "matchedHostIds"
  > & {
    createdHostIds?: number[];
    updatedHostIds?: number[];
    matchedHostIds?: number[];
  },
  projectId?: string,
): Promise<HostImportResult> {
  const createdHostIds = Array.isArray(result.createdHostIds)
    ? result.createdHostIds
    : [];
  const updatedHostIds = Array.isArray(result.updatedHostIds)
    ? result.updatedHostIds
    : [];
  const matchedHostIds = Array.isArray(result.matchedHostIds)
    ? result.matchedHostIds
    : [];
  const normalized: HostImportResult = {
    ...result,
    createdHostIds,
    updatedHostIds,
    matchedHostIds,
    associationFailed: 0,
  };
  if (!projectId) return normalized;
  const resolvedProjectId = requireResolvedWorkspaceProjectId(projectId);

  const hostIds = [
    ...new Set([...createdHostIds, ...updatedHostIds, ...matchedHostIds]),
  ];
  const associationResults = await Promise.all(
    hostIds.map(async (hostId) => {
      try {
        await authApi.post(
          `/control-plane/projects/${encodeURIComponent(resolvedProjectId)}/servers`,
          { hostId, alias: null },
        );
        return { hostId, associated: true };
      } catch (error) {
        if (isAlreadyAssociated(error)) {
          return { hostId, associated: true };
        }
        return { hostId, associated: false };
      }
    }),
  );

  const uncertainHostIds = associationResults
    .filter((association) => !association.associated)
    .map((association) => association.hostId);
  if (uncertainHostIds.length > 0) {
    const confirmed = await Promise.all(
      uncertainHostIds.map(async (hostId) => ({
        hostId,
        associated: Boolean(
          await findProjectHostAssociation(resolvedProjectId, hostId),
        ),
      })),
    );
    const confirmedByHostId = new Map(
      confirmed.map((association) => [association.hostId, association]),
    );
    for (const association of associationResults) {
      if (confirmedByHostId.get(association.hostId)?.associated) {
        association.associated = true;
      }
    }
  }

  for (const association of associationResults) {
    if (association.associated) continue;
    normalized.associationFailed += 1;
    normalized.errors.push(
      `Host ${association.hostId}: failed to associate with the selected project`,
    );
  }

  return normalized;
}

export async function bulkImportSSHHosts(
  hosts: SSHHostData[],
  overwrite = false,
  credentials?: Record<string, unknown>[],
  projectId?: string,
): Promise<HostImportResult> {
  try {
    const response = await sshHostApi.post("/bulk-import", {
      hosts,
      overwrite,
      ...(credentials ? { credentials } : {}),
    });
    const result = await associateImportedHosts(response.data, projectId);
    invalidateHostsAndStatusCaches();
    invalidateWorkspaceProjectCaches();
    return result;
  } catch (error) {
    handleApiError(error, "bulk import SSH hosts");
  }
}

export async function importSSHConfigHosts(
  content: string,
  overwrite = false,
  projectId?: string,
): Promise<HostImportResult> {
  try {
    const response = await sshHostApi.post("/ssh-config-import", {
      content,
      overwrite,
    });
    const result = await associateImportedHosts(response.data, projectId);
    invalidateHostsAndStatusCaches();
    invalidateWorkspaceProjectCaches();
    return result;
  } catch (error) {
    handleApiError(error, "import SSH config hosts");
  }
}

export async function discoverProxmoxGuests(
  hostId: number,
): Promise<ProxmoxDiscoverResult> {
  try {
    const response = await authApi.post(
      "/proxmox/discover",
      { hostId },
      { timeout: 120000 },
    );
    return response.data;
  } catch (error) {
    handleApiError(error, "discover Proxmox guests");
  }
}

export async function syncProxmoxGuests(
  hostId: number,
): Promise<ProxmoxSyncResult> {
  try {
    const response = await authApi.post(
      "/proxmox/sync",
      { hostId },
      { timeout: 120000 },
    );
    return response.data;
  } catch (error) {
    handleApiError(error, "sync Proxmox guests");
  }
}

export async function bulkUpdateSSHHosts(
  hostIds: number[],
  updates: Record<string, unknown>,
): Promise<{ updated: number; failed: number; errors: string[] }> {
  try {
    const response = await sshHostApi.patch("/bulk-update", {
      hostIds,
      updates,
    });
    invalidateHostsAndStatusCaches();
    invalidateWorkspaceProjectCaches();
    return response.data;
  } catch (error) {
    handleApiError(error, "bulk update SSH hosts");
  }
}

export async function deleteSSHHost(
  hostId: number,
): Promise<Record<string, unknown>> {
  try {
    const response = await sshHostApi.delete(`/db/host/${hostId}`);
    invalidateHostsAndStatusCaches();
    invalidateWorkspaceProjectCaches();
    return response.data;
  } catch (error) {
    handleApiError(error, "delete SSH host");
  }
}

export async function getSSHHostById(hostId: number): Promise<SSHHost> {
  try {
    const response = await sshHostApi.get(`/db/host/${hostId}`);
    return response.data;
  } catch (error) {
    handleApiError(error, "fetch SSH host");
  }
}

export async function exportSSHHostWithCredentials(
  hostId: number,
): Promise<SSHHost> {
  try {
    const response = await sshHostApi.get(`/db/host/${hostId}/export`);
    return response.data;
  } catch (error) {
    handleApiError(error, "export SSH host with credentials");
  }
}

export function exportAllSSHHosts(): Promise<{
  hosts: SSHHost[];
}>;
export function exportAllSSHHosts(options: {
  share?: false;
  hostIds?: number[];
}): Promise<{
  hosts: SSHHost[];
}>;
export function exportAllSSHHosts(options: {
  share: true;
  hostIds?: number[];
}): Promise<{
  version: string;
  exportedAt: string;
  credentials: Record<string, unknown>[];
  hosts: SSHHost[];
}>;
export async function exportAllSSHHosts(options?: {
  share?: boolean;
  hostIds?: number[];
}): Promise<{
  version?: string;
  exportedAt?: string;
  credentials?: Record<string, unknown>[];
  hosts: SSHHost[];
}> {
  try {
    const response = await sshHostApi.get("/db/hosts/export", {
      params: {
        ...(options?.share ? { share: 1 } : {}),
        ...(options?.hostIds ? { hostIds: options.hostIds.join(",") } : {}),
      },
    });
    return response.data;
  } catch (error) {
    handleApiError(error, "export all SSH hosts");
  }
}

// ============================================================================
// SSH AUTOSTART MANAGEMENT
// ============================================================================

export async function enableAutoStart(
  sshConfigId: number,
): Promise<Record<string, unknown>> {
  try {
    const response = await sshHostApi.post("/autostart/enable", {
      sshConfigId,
    });
    return response.data;
  } catch (error) {
    handleApiError(error, "enable autostart");
  }
}

export async function disableAutoStart(
  sshConfigId: number,
): Promise<Record<string, unknown>> {
  try {
    const response = await sshHostApi.delete("/autostart/disable", {
      data: { sshConfigId },
    });
    return response.data;
  } catch (error) {
    handleApiError(error, "disable autostart");
  }
}

export async function getAutoStartStatus(): Promise<{
  autostart_configs: Array<{
    sshConfigId: number;
    host: string;
    port: number;
    username: string;
    authType: string;
  }>;
  total_count: number;
}> {
  try {
    const response = await sshHostApi.get("/autostart/status");
    return response.data;
  } catch (error) {
    handleApiError(error, "fetch autostart status");
  }
}

// ============================================================================
// PROXY CONNECTIVITY TEST
// ============================================================================

export async function testProxyConnection(options: {
  singleProxy?: {
    host: string;
    port: number;
    type?: 4 | 5 | "http";
    username?: string;
    password?: string;
  };
  proxyChain?: ProxyNode[];
  testTarget?: { host: string; port: number };
}): Promise<{ success: boolean; latencyMs?: number; error?: string }> {
  try {
    const response = await sshHostApi.post("/db/proxy/test", options);
    return response.data;
  } catch (error) {
    if (error instanceof AxiosError && error.response?.data?.error) {
      return { success: false, error: error.response.data.error };
    }
    handleApiError(error, "test proxy connection");
  }
}

// ============================================================================
