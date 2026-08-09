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
};

export type PanelAgentChatInput = {
  messages: PanelAgentChatMessage[];
  skillIds?: string[];
  targets: PanelAgentTargetInput[];
  model?: string;
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

export async function getPanelAgentSettings(): Promise<PanelAgentSettings> {
  try {
    const response = await authApi.get(`${PANEL_AGENT_PREFIX}/settings`);
    return response.data.settings;
  } catch (error) {
    throw handleApiError(error, "load panel agent settings", {
      preserveAuthErrorMessage: true,
    });
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
    return response.data.settings;
  } catch (error) {
    throw handleApiError(error, "update panel agent settings", {
      preserveAuthErrorMessage: true,
    });
  }
}

export async function getPanelAgentModels(
  input: PanelAgentModelListInput = {},
): Promise<PanelAgentModel[]> {
  try {
    const response = await authApi.post(`${PANEL_AGENT_PREFIX}/models`, input);
    return response.data.models;
  } catch (error) {
    throw handleApiError(error, "load panel agent models", {
      preserveAuthErrorMessage: true,
    });
  }
}

export async function sendPanelAgentChat(
  input: PanelAgentChatInput,
): Promise<PanelAgentChatResponse> {
  try {
    const response = await authApi.post(`${PANEL_AGENT_PREFIX}/chat`, input);
    return response.data;
  } catch (error) {
    throw handleApiError(error, "send panel agent chat", {
      preserveAuthErrorMessage: true,
    });
  }
}

export async function generatePanelAgentPlan(
  input: PanelAgentGenerateInput,
): Promise<PanelAgentPlan> {
  try {
    const response = await authApi.post(
      `${PANEL_AGENT_PREFIX}/generate`,
      input,
    );
    return response.data.plan;
  } catch (error) {
    throw handleApiError(error, "generate panel agent plan", {
      preserveAuthErrorMessage: true,
    });
  }
}
