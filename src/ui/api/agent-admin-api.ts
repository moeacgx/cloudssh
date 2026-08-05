import { agentApi, handleApiError } from "@/main-axios";

const AGENT_ADMIN_PREFIX = "/agent/admin/v1";

export type AgentScope =
  | "sessions:create"
  | "sessions:read"
  | "sessions:write"
  | "sessions:close"
  | "jobs:execute"
  | "servers:create"
  | "quick-connections:create"
  | "files:read"
  | "files:write";

export type AgentProjectOption = { id: string; name: string };

export type AgentDevice = {
  id: string;
  name: string;
  fingerprint: string;
  status: "active" | "revoked";
  accessMode: "all" | "selected";
  scopes: AgentScope[];
  projectIds: string[];
  maxConcurrentSessions: number;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  owner: {
    userId: string | null;
    username: string | null;
    isCurrentUser: boolean;
  };
};

export type PendingAgentDevice = {
  requestId: string;
  deviceName: string;
  fingerprint: string;
  expiresAt: string;
};

export type AgentAdminAccess = {
  projects: AgentProjectOption[];
  devices: AgentDevice[];
};

export type ApproveAgentDeviceInput = {
  name?: string;
  scopes: AgentScope[];
  accessMode: "all" | "selected";
  projectIds: string[];
  maxConcurrentSessions: number;
  expiresAt: string | null;
};

export type UpdateAgentDeviceInput = Partial<ApproveAgentDeviceInput>;

export async function getAgentAdminAccess(): Promise<AgentAdminAccess> {
  try {
    const response = await agentApi.get(`${AGENT_ADMIN_PREFIX}/devices`);
    return {
      projects: Array.isArray(response.data?.projects)
        ? response.data.projects
        : [],
      devices: Array.isArray(response.data?.devices)
        ? response.data.devices
        : [],
    };
  } catch (error) {
    throw handleApiError(error, "load agent devices", {
      preserveAuthErrorMessage: true,
    });
  }
}

export async function resolveAgentDeviceCode(
  code: string,
): Promise<PendingAgentDevice> {
  try {
    const response = await agentApi.post(
      `${AGENT_ADMIN_PREFIX}/device-requests/resolve`,
      { code },
    );
    return response.data.request;
  } catch (error) {
    throw handleApiError(error, "resolve agent device code", {
      preserveAuthErrorMessage: true,
    });
  }
}

export async function approveAgentDevice(
  requestId: string,
  input: ApproveAgentDeviceInput,
): Promise<AgentDevice> {
  try {
    const response = await agentApi.post(
      `${AGENT_ADMIN_PREFIX}/device-requests/${encodeURIComponent(requestId)}/approve`,
      input,
    );
    return response.data.device;
  } catch (error) {
    throw handleApiError(error, "approve agent device", {
      preserveAuthErrorMessage: true,
    });
  }
}

export async function denyAgentDevice(requestId: string): Promise<void> {
  try {
    await agentApi.post(
      `${AGENT_ADMIN_PREFIX}/device-requests/${encodeURIComponent(requestId)}/deny`,
    );
  } catch (error) {
    throw handleApiError(error, "deny agent device", {
      preserveAuthErrorMessage: true,
    });
  }
}

export async function updateAgentDevice(
  deviceId: string,
  input: UpdateAgentDeviceInput,
): Promise<AgentDevice> {
  try {
    const response = await agentApi.patch(
      `${AGENT_ADMIN_PREFIX}/devices/${encodeURIComponent(deviceId)}`,
      input,
    );
    return response.data.device;
  } catch (error) {
    throw handleApiError(error, "update agent device", {
      preserveAuthErrorMessage: true,
    });
  }
}

export async function revokeAgentDevice(deviceId: string): Promise<void> {
  try {
    await agentApi.delete(
      `${AGENT_ADMIN_PREFIX}/devices/${encodeURIComponent(deviceId)}`,
    );
  } catch (error) {
    throw handleApiError(error, "revoke agent device", {
      preserveAuthErrorMessage: true,
    });
  }
}
