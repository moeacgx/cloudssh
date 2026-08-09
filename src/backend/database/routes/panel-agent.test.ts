import express, { type RequestHandler } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "http";
import { createPanelAgentRouter } from "./panel-agent.js";

class MemorySettingsStore {
  readonly values = new Map<string, string>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string) {
    this.values.set(key, value);
  }

  async delete(key: string) {
    this.values.delete(key);
  }
}

const userAuth: RequestHandler = (req, _res, next) => {
  Object.assign(req, {
    userId: "user-1",
    sessionId: "session-1",
    user: { id: "user-1", username: "admin", isAdmin: true },
  });
  next();
};

async function startRouter(store: MemorySettingsStore, fetchImpl = vi.fn()) {
  const app = express();
  app.use(express.json());
  app.use(
    "/panel-agent",
    createPanelAgentRouter({
      authenticate: userAuth,
      requireAdmin: userAuth,
      settings: store,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }),
  );
  let server!: Server;
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listen failed");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/panel-agent`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("Panel Agent routes", () => {
  let runtime: { baseUrl: string; close: () => Promise<void> } | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
  });

  it("returns public settings without leaking the API key", async () => {
    const store = new MemorySettingsStore();
    store.values.set("panel_agent_api_key", "secret-key");
    runtime = await startRouter(store);

    const response = await fetch(`${runtime.baseUrl}/settings`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.settings.apiKeyConfigured).toBe(true);
    expect(JSON.stringify(body)).not.toContain("secret-key");
  });

  it("persists skills with empty content", async () => {
    const store = new MemorySettingsStore();
    runtime = await startRouter(store);

    const response = await fetch(`${runtime.baseUrl}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        skills: [
          {
            id: "tag-only",
            name: "标签只填名字",
            content: "",
            enabled: true,
          },
        ],
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.settings.skills).toEqual([
      expect.objectContaining({
        id: "tag-only",
        name: "标签只填名字",
        content: "",
        enabled: true,
      }),
    ]);

    const reload = await fetch(`${runtime.baseUrl}/settings`);
    const reloadBody = await reload.json();
    expect(reloadBody.settings.skills).toEqual(body.settings.skills);
  });

  it("lists models with draft admin connection settings", async () => {
    const store = new MemorySettingsStore();
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "z-model", owned_by: "ops" },
              { id: "a-model", created: 123 },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    runtime = await startRouter(store, fetchImpl);

    const response = await fetch(`${runtime.baseUrl}/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: "https://api.example.test/v1",
        apiKey: "draft-key",
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.example.test/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ authorization: "Bearer draft-key" }),
      }),
    );
    expect(body.models).toEqual([
      { id: "a-model", created: 123 },
      { id: "z-model", ownedBy: "ops" },
    ]);
  });

  it("returns contextual chat tool calls", async () => {
    const store = new MemorySettingsStore();
    store.values.set(
      "panel_agent_settings_v1",
      JSON.stringify({
        enabled: true,
        provider: "openai-compatible",
        baseUrl: "https://api.example.test/v1",
        model: "ops-model",
        temperature: 0.2,
        maxTokens: 1024,
        multiServerEnabled: true,
        maxTargets: 4,
        skills: [],
      }),
    );
    store.values.set("panel_agent_api_key", "secret-key");
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "我先检查 nginx 状态。",
                  tool_calls: [
                    {
                      id: "call-1",
                      type: "function",
                      function: {
                        name: "run_terminal_command",
                        arguments: JSON.stringify({
                          targetId: "tab-1",
                          command: "systemctl status nginx",
                          purpose: "Read nginx status",
                          risk: "low",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    runtime = await startRouter(store, fetchImpl);

    const response = await fetch(`${runtime.baseUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "检查 nginx" }],
        model: "override-model",
        targets: [
          {
            targetId: "tab-1",
            hostName: "web-1",
            connected: true,
            recentOutput: "nginx failed\napi_key=secret-token",
          },
        ],
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toEqual({
      role: "assistant",
      content: "我先检查 nginx 状态。",
      toolCalls: [
        {
          id: "call-1",
          name: "run_terminal_command",
          arguments: {
            targetId: "tab-1",
            command: "systemctl status nginx",
            purpose: "Read nginx status",
            risk: "low",
          },
        },
      ],
    });
    const request = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
    expect(request.model).toBe("override-model");
    expect(
      request.tools.map(
        (tool: { function: { name: string } }) => tool.function.name,
      ),
    ).toEqual(["read_terminal_context", "run_terminal_command"]);
    expect(request.messages[1].content).toContain("nginx failed");
    expect(request.messages[1].content).not.toContain("secret-token");
  });

  it("allows contextual chat without selected SSH targets", async () => {
    const store = new MemorySettingsStore();
    store.values.set(
      "panel_agent_settings_v1",
      JSON.stringify({
        enabled: true,
        provider: "openai-compatible",
        baseUrl: "https://api.example.test/v1",
        model: "ops-model",
        temperature: 0.2,
        maxTokens: 1024,
        multiServerEnabled: true,
        maxTargets: 4,
        skills: [],
      }),
    );
    store.values.set("panel_agent_api_key", "secret-key");
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "你好，我可以先帮你分析。" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    runtime = await startRouter(store, fetchImpl);

    const response = await fetch(`${runtime.baseUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
        targets: [],
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message.content).toBe("你好，我可以先帮你分析。");
    const request = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
    expect(request.messages[1].content).toContain("No SSH target is selected");
  });

  it("rejects multi-server generation when disabled", async () => {
    const store = new MemorySettingsStore();
    store.values.set(
      "panel_agent_settings_v1",
      JSON.stringify({
        enabled: true,
        provider: "openai-compatible",
        baseUrl: "https://api.example.test/v1",
        model: "ops-model",
        temperature: 0.2,
        maxTokens: 1024,
        multiServerEnabled: false,
        maxTargets: 4,
        skills: [],
      }),
    );
    store.values.set("panel_agent_api_key", "secret-key");
    runtime = await startRouter(store);

    const response = await fetch(`${runtime.baseUrl}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instruction: "check all",
        targets: [
          { targetId: "one", hostName: "one" },
          { targetId: "two", hostName: "two" },
        ],
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe("MULTI_SERVER_DISABLED");
  });

  it("calls an OpenAI-compatible model and validates commands by target", async () => {
    const store = new MemorySettingsStore();
    store.values.set(
      "panel_agent_settings_v1",
      JSON.stringify({
        enabled: true,
        provider: "openai-compatible",
        baseUrl: "https://api.example.test/v1",
        model: "ops-model",
        temperature: 0.2,
        maxTokens: 1024,
        multiServerEnabled: true,
        maxTargets: 4,
        skills: [
          {
            id: "safe-ops",
            name: "Safe Ops",
            content: "Prefer read-only checks first.",
            enabled: true,
          },
        ],
      }),
    );
    store.values.set("panel_agent_api_key", "secret-key");
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: "Check nginx",
                    warnings: ["No mutation yet"],
                    targets: [
                      {
                        targetId: "tab-1",
                        analysis: "nginx failed",
                        commands: [
                          {
                            title: "Status",
                            command: "systemctl status nginx",
                            risk: "low",
                            reason: "Read status",
                          },
                        ],
                      },
                      {
                        targetId: "unknown",
                        analysis: "ignored",
                        commands: [
                          { title: "bad", command: "rm -rf /", risk: "high" },
                        ],
                      },
                    ],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    runtime = await startRouter(store, fetchImpl);

    const response = await fetch(`${runtime.baseUrl}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instruction: "check nginx",
        model: "override-model",
        skillIds: ["safe-ops"],
        targets: [
          {
            targetId: "tab-1",
            hostName: "web-1",
            recentOutput: "\u001b[31mnginx failed\u001b[0m\ntoken=secret-token",
          },
        ],
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.example.test/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer secret-key",
        }),
      }),
    );
    expect(body.plan.targets).toEqual([
      {
        targetId: "tab-1",
        analysis: "nginx failed",
        commands: [
          {
            title: "Status",
            command: "systemctl status nginx",
            risk: "low",
            reason: "Read status",
          },
        ],
      },
    ]);
    const request = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
    expect(request.messages[1].content).toContain("nginx failed");
    expect(request.model).toBe("override-model");
    expect(request.messages[1].content).not.toContain("\u001b[31m");
    expect(request.messages[1].content).not.toContain("secret-token");
    expect(request.messages[1].content).toContain("token=[REDACTED]");
  });
});
