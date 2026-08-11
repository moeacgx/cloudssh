import axios, { type AxiosRequestConfig } from "axios";
import { authApi, handleApiError } from "@/main-axios";

const PANEL_AGENT_PREFIX = "/panel-agent";

export type PanelAgentRisk = "low" | "medium" | "high";

export type PanelAgentSkill = {
  id: string;
  name: string;
  description?: string;
  content: string;
  enabled: boolean;
};

export type PanelAgentModel = {
  id: string;
  created?: number;
  ownedBy?: string;
};

export type PanelAgentReasoningEffort = "auto" | "low" | "medium" | "high";

export type PanelAgentChatAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: "image" | "text" | "file";
  dataUrl?: string;
  text?: string;
};

export type PanelAgentSettings = {
  enabled: boolean;
  provider: "openai-compatible";
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  multiServerEnabled: boolean;
  maxTargets: number;
  skills: PanelAgentSkill[];
  apiKeyConfigured: boolean;
};

export type PanelAgentSettingsInput = Partial<
  Omit<PanelAgentSettings, "provider" | "apiKeyConfigured">
> & {
  provider?: "openai-compatible";
  apiKey?: string;
};

export type PanelAgentModelListInput = {
  baseUrl?: string;
  apiKey?: string;
};

export type PanelAgentTargetInput = {
  targetId: string;
  hostId?: string | number | null;
  hostName: string;
  sessionId?: string | null;
  agentSessionId?: string | null;
  connected?: boolean;
  recentOutput?: string;
};

export type PanelAgentGenerateInput = {
  instruction: string;
  mode?: "observe" | "commands";
  skillIds?: string[];
  targets: PanelAgentTargetInput[];
  model?: string;
};

export type PanelAgentToolName =
  | "run_terminal_command"
  | "read_terminal_context";

export type PanelAgentToolCall = {
  id: string;
  name: PanelAgentToolName;
  arguments: Record<string, unknown>;
};

export type PanelAgentChatMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  name?: string;
  toolCalls?: PanelAgentToolCall[];
  attachments?: PanelAgentChatAttachment[];
};

export type PanelAgentChatInput = {
  messages: PanelAgentChatMessage[];
  skillIds?: string[];
  targets: PanelAgentTargetInput[];
  model?: string;
  reasoningEffort?: PanelAgentReasoningEffort;
};

export type PanelAgentChatResponse = {
  message: {
    role: "assistant";
    content: string;
    toolCalls: PanelAgentToolCall[];
  };
};
export type PanelAgentCommand = {
  title: string;
  command: string;
  risk: PanelAgentRisk;
  reason?: string;
};

export type PanelAgentTargetPlan = {
  targetId: string;
  analysis: string;
  commands: PanelAgentCommand[];
};

export type PanelAgentPlan = {
  summary: string;
  warnings: string[];
  targets: PanelAgentTargetPlan[];
};

const PANEL_AGENT_REQUEST_CONFIG = {
  timeout: 180_000,
} satisfies AxiosRequestConfig;

function panelAgentApiError(error: unknown, operation: string): never {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as
      | { error?: unknown; message?: unknown; detail?: unknown; code?: unknown }
      | undefined;
    const message =
      (typeof data?.error === "string" && data.error) ||
      (typeof data?.message === "string" && data.message) ||
      "";
    const detail = typeof data?.detail === "string" ? data.detail : "";
    if (message) {
      throw new Error(detail ? `${message}: ${detail}` : message);
    }
  }
  throw handleApiError(error, operation, {
    preserveAuthErrorMessage: true,
    preserveResponseMessage: true,
  });
}

function readSettingsPayload(payload: unknown): PanelAgentSettings {
  const wrappedPayload =
    payload !== null && typeof payload === "object"
      ? (payload as { settings?: unknown })
      : null;
  const candidate =
    wrappedPayload && "settings" in wrappedPayload
      ? wrappedPayload.settings
      : payload;

  if (candidate === null || typeof candidate !== "object") {
    throw new Error("Invalid Panel Agent settings response");
  }
  const settings = candidate as Partial<PanelAgentSettings>;
  if (
    typeof settings.enabled !== "boolean" ||
    settings.provider !== "openai-compatible" ||
    typeof settings.baseUrl !== "string" ||
    typeof settings.model !== "string" ||
    typeof settings.temperature !== "number" ||
    typeof settings.maxTokens !== "number" ||
    typeof settings.multiServerEnabled !== "boolean" ||
    typeof settings.maxTargets !== "number" ||
    !Array.isArray(settings.skills) ||
    typeof settings.apiKeyConfigured !== "boolean"
  ) {
    throw new Error("Invalid Panel Agent settings response");
  }

  return settings as PanelAgentSettings;
}

export async function getPanelAgentSettings(): Promise<PanelAgentSettings> {
  try {
    const response = await authApi.get(`${PANEL_AGENT_PREFIX}/settings`);
    return readSettingsPayload(response.data);
  } catch (error) {
    panelAgentApiError(error, "load panel agent settings");
  }
}

export async function updatePanelAgentSettings(
  input: PanelAgentSettingsInput,
): Promise<PanelAgentSettings> {
  try {
    const response = await authApi.patch(
      `${PANEL_AGENT_PREFIX}/settings`,
      input,
    );
    return readSettingsPayload(response.data);
  } catch (error) {
    panelAgentApiError(error, "update panel agent settings");
  }
}

export async function getPanelAgentModels(
  input: PanelAgentModelListInput = {},
): Promise<PanelAgentModel[]> {
  try {
    const response = await authApi.post(
      `${PANEL_AGENT_PREFIX}/models`,
      input,
      PANEL_AGENT_REQUEST_CONFIG,
    );
    return response.data.models;
  } catch (error) {
    panelAgentApiError(error, "load panel agent models");
  }
}

export async function sendPanelAgentChat(
  input: PanelAgentChatInput,
  signal?: AbortSignal,
): Promise<PanelAgentChatResponse> {
  try {
    const response = await authApi.post(`${PANEL_AGENT_PREFIX}/chat`, input, {
      ...PANEL_AGENT_REQUEST_CONFIG,
      signal,
    });
    return response.data;
  } catch (error) {
    if (axios.isCancel(error)) throw error;
    panelAgentApiError(error, "send panel agent chat");
  }
}

export async function generatePanelAgentPlan(
  input: PanelAgentGenerateInput,
): Promise<PanelAgentPlan> {
  try {
    const response = await authApi.post(
      `${PANEL_AGENT_PREFIX}/generate`,
      input,
      PANEL_AGENT_REQUEST_CONFIG,
    );
    return response.data.plan;
  } catch (error) {
    panelAgentApiError(error, "generate panel agent plan");
  }
}
