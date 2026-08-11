import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "@/types/ui-types";

const panelAgentApi = vi.hoisted(() => ({
  getPanelAgentSettings: vi.fn(),
  getPanelAgentModels: vi.fn(),
  sendPanelAgentChat: vi.fn(),
}));
const notifications = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/api/panel-agent-api", () => panelAgentApi);
vi.mock("sonner", () => ({ toast: notifications }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts?.host ? `${key}:${opts.host}` : key,
  }),
}));

import { PanelAgentPanel } from "@/sidebar/PanelAgentPanel";

function terminalTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: "tab-1",
    instanceId: "instance-1",
    type: "terminal",
    label: "web-1",
    openedAt: 1,
    host: {
      id: "42",
      name: "web-1",
      username: "root",
      ip: "192.0.2.10",
      port: 22,
      folder: "",
      online: true,
      cpu: null,
      ram: null,
      lastAccess: "",
      authType: "credential",
      enableTerminal: true,
      enableCommandHistory: true,
      enableTunnel: false,
      serverTunnels: [],
      enableFileManager: false,
      enableDocker: false,
      enableProxmox: false,
      enableTmuxMonitor: false,
      quickActions: [],
      enableSsh: true,
      enableRdp: false,
      enableVnc: false,
      enableTelnet: false,
      sshPort: 22,
      rdpPort: 3389,
      vncPort: 5900,
      telnetPort: 23,
    },
    terminalRef: {
      current: {
        isConnected: () => true,
        sendInput: vi.fn(),
        getRecentOutput: () => "nginx failed to start",
        getSessionContext: () => ({
          sessionId: "session-1",
          hostId: "42",
          connected: true,
        }),
      },
    },
    ...overrides,
  };
}

describe("PanelAgentPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    panelAgentApi.getPanelAgentSettings.mockResolvedValue({
      enabled: true,
      provider: "openai-compatible",
      baseUrl: "https://api.example.test/v1",
      model: "ops-model",
      temperature: 0.2,
      maxTokens: 1800,
      multiServerEnabled: true,
      maxTargets: 4,
      apiKeyConfigured: true,
      skills: [
        {
          id: "safe-ops",
          name: "安全运维边界",
          content: "高风险动作必须标红",
          enabled: true,
        },
      ],
    });
  });

  it("allows chat before an SSH terminal is open", async () => {
    panelAgentApi.sendPanelAgentChat.mockResolvedValue({
      message: { role: "assistant", content: "你好", toolCalls: [] },
    });
    render(<PanelAgentPanel terminalTabs={[]} activeTabId="" />);

    await screen.findByText("panelAgent.noTerminals");
    await waitFor(() =>
      expect(screen.getByText("panelAgent.send")).toHaveProperty(
        "disabled",
        false,
      ),
    );
    fireEvent.change(
      screen.getByPlaceholderText("panelAgent.chatPlaceholder"),
      { target: { value: "hi" } },
    );
    fireEvent.click(screen.getByText("panelAgent.send"));

    await screen.findByText("你好");
    expect(panelAgentApi.sendPanelAgentChat).toHaveBeenCalledWith(
      {
        messages: [{ role: "user", content: "hi" }],
        skillIds: ["safe-ops"],
        model: "ops-model",
        targets: [],
      },
      expect.any(AbortSignal),
    );
  });

  it("submits the compact composer with Enter like Codex", async () => {
    panelAgentApi.sendPanelAgentChat.mockResolvedValue({
      message: { role: "assistant", content: "compact ok", toolCalls: [] },
    });
    render(
      <PanelAgentPanel terminalTabs={[]} activeTabId="" embedded compact />,
    );

    const input = await screen.findByPlaceholderText(
      "panelAgent.chatPlaceholder",
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "panelAgent.send" }),
      ).toHaveProperty("disabled", false),
    );

    fireEvent.change(input, { target: { value: "hi" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await screen.findByText("compact ok");
    expect(screen.getByTestId("panel-agent-composer").className).toContain(
      "rounded-2xl",
    );
  });

  it("renders assistant markdown as structured content", async () => {
    panelAgentApi.sendPanelAgentChat.mockResolvedValue({
      message: {
        role: "assistant",
        content: "## Plan\n\n- Check nginx\n- Restart service",
        toolCalls: [],
      },
    });
    render(<PanelAgentPanel terminalTabs={[]} activeTabId="" />);

    await screen.findByText("panelAgent.noTerminals");
    fireEvent.change(
      screen.getByPlaceholderText("panelAgent.chatPlaceholder"),
      { target: { value: "plan" } },
    );
    fireEvent.click(screen.getByText("panelAgent.send"));

    expect(await screen.findByRole("heading", { name: "Plan" })).toBeTruthy();
    expect(screen.getByText("Check nginx").closest("li")).not.toBeNull();
  });

  it("clears the visible conversation and starts the next chat from an empty history", async () => {
    panelAgentApi.sendPanelAgentChat
      .mockResolvedValueOnce({
        message: { role: "assistant", content: "old answer", toolCalls: [] },
      })
      .mockResolvedValueOnce({
        message: { role: "assistant", content: "fresh answer", toolCalls: [] },
      });

    render(<PanelAgentPanel terminalTabs={[]} activeTabId="" />);

    await screen.findByText("panelAgent.noTerminals");
    expect(screen.getByText("panelAgent.clear")).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.change(
      screen.getByPlaceholderText("panelAgent.chatPlaceholder"),
      { target: { value: "old question" } },
    );
    fireEvent.click(screen.getByText("panelAgent.send"));

    await screen.findByText("old answer");
    fireEvent.click(screen.getByText("panelAgent.clear"));

    expect(screen.queryByText("old question")).toBeNull();
    expect(screen.queryByText("old answer")).toBeNull();
    expect(screen.getByText("panelAgent.chatEmpty")).toBeTruthy();

    fireEvent.change(
      screen.getByPlaceholderText("panelAgent.chatPlaceholder"),
      { target: { value: "fresh question" } },
    );
    fireEvent.click(screen.getByText("panelAgent.send"));

    await screen.findByText("fresh answer");
    expect(panelAgentApi.sendPanelAgentChat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: [{ role: "user", content: "fresh question" }],
      }),
      expect.any(AbortSignal),
    );
  });

  it("restores the selected model from localStorage", async () => {
    localStorage.setItem("panelAgentSelectedModel", "remembered-model");
    panelAgentApi.getPanelAgentSettings.mockResolvedValueOnce({
      enabled: true,
      provider: "openai-compatible",
      baseUrl: "https://api.example.test/v1",
      model: "",
      temperature: 0.2,
      maxTokens: 1800,
      multiServerEnabled: true,
      maxTargets: 4,
      apiKeyConfigured: true,
      skills: [],
    });
    panelAgentApi.sendPanelAgentChat.mockResolvedValue({
      message: { role: "assistant", content: "ok", toolCalls: [] },
    });

    render(<PanelAgentPanel terminalTabs={[]} activeTabId="" />);

    await screen.findByText("panelAgent.noTerminals");
    expect(await screen.findByDisplayValue("remembered-model")).toBeTruthy();
    expect(screen.queryByText("panelAgent.adminConfigRequired")).toBeNull();
    expect(screen.queryByText("panelAgent.modelRequired")).toBeNull();

    fireEvent.change(
      screen.getByPlaceholderText("panelAgent.chatPlaceholder"),
      { target: { value: "hi" } },
    );
    fireEvent.click(screen.getByText("panelAgent.send"));

    await screen.findByText("ok");
    expect(panelAgentApi.sendPanelAgentChat).toHaveBeenCalledWith(
      expect.objectContaining({ model: "remembered-model" }),
      expect.any(AbortSignal),
    );
  });

  it("shows a model-specific warning when only the chat model is missing", async () => {
    panelAgentApi.getPanelAgentSettings.mockResolvedValueOnce({
      enabled: true,
      provider: "openai-compatible",
      baseUrl: "https://api.example.test/v1",
      model: "",
      temperature: 0.2,
      maxTokens: 1800,
      multiServerEnabled: true,
      maxTargets: 4,
      apiKeyConfigured: true,
      skills: [],
    });

    render(<PanelAgentPanel terminalTabs={[]} activeTabId="" />);

    await screen.findByText("panelAgent.noTerminals");
    expect(await screen.findByText("panelAgent.modelRequired")).toBeTruthy();
    expect(screen.queryByText("panelAgent.adminConfigRequired")).toBeNull();
    expect(screen.getByText("panelAgent.send")).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("keeps the composer fixed while only the message list scrolls", async () => {
    render(<PanelAgentPanel terminalTabs={[]} activeTabId="" />);

    await screen.findByText("panelAgent.noTerminals");

    const messageList = screen.getByTestId("panel-agent-message-list");
    const composer = screen.getByTestId("panel-agent-composer");

    expect(messageList.className).toContain("overflow-y-auto");
    expect(messageList.className).toContain("touch-pan-y");
    expect(messageList.className).toContain(
      "[-webkit-overflow-scrolling:touch]",
    );
    expect(messageList.contains(composer)).toBe(false);
    expect(composer.className).toContain("shrink-0");
  });

  it("runs model tool calls against the selected terminal and continues the chat", async () => {
    const tab = terminalTab();
    panelAgentApi.sendPanelAgentChat
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: "我先检查 nginx。",
          toolCalls: [
            {
              id: "call-1",
              name: "run_terminal_command",
              arguments: {
                targetId: "tab-1",
                command: "systemctl status nginx",
                purpose: "read status",
                risk: "low",
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: "nginx failed to start",
          toolCalls: [],
        },
      });

    render(<PanelAgentPanel terminalTabs={[tab]} activeTabId="tab-1" />);

    await waitFor(() =>
      expect(screen.getByText("panelAgent.send")).toHaveProperty(
        "disabled",
        false,
      ),
    );
    fireEvent.change(
      screen.getByPlaceholderText("panelAgent.chatPlaceholder"),
      {
        target: { value: "检查 nginx" },
      },
    );
    fireEvent.click(screen.getByText("panelAgent.send"));

    await screen.findByText("我先检查 nginx。");
    expect(panelAgentApi.sendPanelAgentChat).toHaveBeenCalledWith(
      {
        messages: [{ role: "user", content: "检查 nginx" }],
        skillIds: ["safe-ops"],
        model: "ops-model",
        targets: [
          expect.objectContaining({
            targetId: "tab-1",
            hostName: "web-1",
            sessionId: "session-1",
            recentOutput: "nginx failed to start",
          }),
        ],
      },
      expect.any(AbortSignal),
    );
    await waitFor(() =>
      expect(tab.terminalRef?.current?.sendInput).toHaveBeenCalledWith(
        "systemctl status nginx\r",
      ),
    );
    await screen.findByText("panelAgent.toolCompleted", {}, { timeout: 3_000 });
    expect(await screen.findAllByText("nginx failed to start")).toHaveLength(2);
    expect(panelAgentApi.sendPanelAgentChat).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed prompt retryable and replays it", async () => {
    panelAgentApi.sendPanelAgentChat
      .mockRejectedValueOnce(new Error("HTTP 404: Cloudflare block"))
      .mockResolvedValueOnce({
        message: { role: "assistant", content: "recovered", toolCalls: [] },
      });

    render(<PanelAgentPanel terminalTabs={[]} activeTabId="" />);

    await waitFor(() =>
      expect(screen.getByText("panelAgent.send")).toHaveProperty(
        "disabled",
        false,
      ),
    );
    fireEvent.change(
      screen.getByPlaceholderText("panelAgent.chatPlaceholder"),
      {
        target: { value: "hi" },
      },
    );
    fireEvent.click(screen.getByText("panelAgent.send"));

    await screen.findByText("HTTP 404: Cloudflare block");
    fireEvent.click(screen.getByText("panelAgent.retry"));

    await screen.findByText("recovered");
    expect(panelAgentApi.sendPanelAgentChat).toHaveBeenCalledTimes(2);
    expect(panelAgentApi.sendPanelAgentChat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: [{ role: "user", content: "hi" }],
      }),
      expect.any(AbortSignal),
    );
  });

  it("aborts an in-flight chat from the stop button", async () => {
    let requestSignal: AbortSignal | undefined;
    panelAgentApi.sendPanelAgentChat.mockImplementation(
      (_input: unknown, signal: AbortSignal) => {
        requestSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("stopped"), { name: "AbortError" }));
          });
        });
      },
    );

    render(<PanelAgentPanel terminalTabs={[]} activeTabId="" />);

    await waitFor(() =>
      expect(screen.getByText("panelAgent.send")).toHaveProperty(
        "disabled",
        false,
      ),
    );
    fireEvent.change(
      screen.getByPlaceholderText("panelAgent.chatPlaceholder"),
      {
        target: { value: "inspect" },
      },
    );
    fireEvent.click(screen.getByText("panelAgent.send"));

    fireEvent.click(await screen.findByText("panelAgent.stop"));

    await screen.findByText("panelAgent.chatStopped");
    expect(requestSignal?.aborted).toBe(true);
  });
});
