import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
}));
const errorHandling = vi.hoisted(() => ({
  handleApiError: vi.fn((error: unknown) => error),
}));

vi.mock("@/main-axios", () => ({
  authApi: api,
  handleApiError: errorHandling.handleApiError,
}));

import {
  generatePanelAgentPlan,
  getPanelAgentModels,
  getPanelAgentSettings,
  sendPanelAgentChat,
  updatePanelAgentSettings,
} from "@/api/panel-agent-api";

describe("panel agent API", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads settings from the panel-agent control route", async () => {
    api.get.mockResolvedValue({
      data: {
        settings: {
          enabled: true,
          provider: "openai-compatible",
          baseUrl: "https://api.example.test/v1",
          model: "ops-model",
          temperature: 0.2,
          maxTokens: 1800,
          multiServerEnabled: true,
          maxTargets: 4,
          apiKeyConfigured: true,
          skills: [],
        },
      },
    });

    const settings = await getPanelAgentSettings();

    expect(api.get).toHaveBeenCalledWith("/panel-agent/settings");
    expect(settings).toMatchObject({ enabled: true, model: "ops-model" });
  });

  it("saves settings without returning the API key", async () => {
    api.patch.mockResolvedValue({
      data: {
        settings: {
          enabled: false,
          provider: "openai-compatible",
          baseUrl: "",
          model: "",
          temperature: 0.2,
          maxTokens: 1800,
          multiServerEnabled: false,
          maxTargets: 1,
          apiKeyConfigured: true,
          skills: [],
        },
      },
    });

    const settings = await updatePanelAgentSettings({ apiKey: "secret" });

    expect(api.patch).toHaveBeenCalledWith("/panel-agent/settings", {
      apiKey: "secret",
    });
    expect(JSON.stringify(settings)).not.toContain("secret");
  });

  it("loads model choices", async () => {
    api.post.mockResolvedValue({
      data: { models: [{ id: "ops-model" }, { id: "fast-model" }] },
    });

    const models = await getPanelAgentModels({
      baseUrl: "https://api.example.test/v1",
      apiKey: "draft-key",
    });

    expect(api.post).toHaveBeenCalledWith("/panel-agent/models", {
      baseUrl: "https://api.example.test/v1",
      apiKey: "draft-key",
    });
    expect(models.map((model) => model.id)).toEqual([
      "ops-model",
      "fast-model",
    ]);
  });

  it("sends contextual chat messages", async () => {
    api.post.mockResolvedValue({
      data: {
        message: {
          role: "assistant",
          content: "I will inspect nginx.",
          toolCalls: [
            {
              id: "call-1",
              name: "run_terminal_command",
              arguments: {
                targetId: "tab-1",
                command: "systemctl status nginx",
              },
            },
          ],
        },
      },
    });

    const response = await sendPanelAgentChat({
      messages: [{ role: "user", content: "检查 nginx" }],
      model: "ops-model",
      targets: [{ targetId: "tab-1", hostName: "web-1", connected: true }],
    });

    expect(api.post).toHaveBeenCalledWith("/panel-agent/chat", {
      messages: [{ role: "user", content: "检查 nginx" }],
      model: "ops-model",
      targets: [{ targetId: "tab-1", hostName: "web-1", connected: true }],
    });
    expect(response.message.toolCalls[0].name).toBe("run_terminal_command");
  });

  it("sends terminal context for plan generation", async () => {
    api.post.mockResolvedValue({
      data: {
        plan: {
          summary: "Check nginx",
          warnings: [],
          targets: [
            {
              targetId: "tab-1",
              analysis: "nginx failed",
              commands: [
                {
                  title: "status",
                  command: "systemctl status nginx",
                  risk: "low",
                },
              ],
            },
          ],
        },
      },
    });

    const plan = await generatePanelAgentPlan({
      instruction: "check nginx",
      targets: [
        {
          targetId: "tab-1",
          hostName: "web-1",
          connected: true,
          recentOutput: "nginx failed",
        },
      ],
    });

    expect(api.post).toHaveBeenCalledWith("/panel-agent/generate", {
      instruction: "check nginx",
      targets: [
        {
          targetId: "tab-1",
          hostName: "web-1",
          connected: true,
          recentOutput: "nginx failed",
        },
      ],
    });
    expect(plan.targets[0].commands[0].command).toBe("systemctl status nginx");
  });
});
