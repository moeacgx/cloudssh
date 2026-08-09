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
    expect(panelAgentApi.sendPanelAgentChat).toHaveBeenCalledWith({
      messages: [{ role: "user", content: "hi" }],
      skillIds: ["safe-ops"],
      model: "ops-model",
      targets: [],
    });
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
    expect(panelAgentApi.sendPanelAgentChat).toHaveBeenCalledWith({
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
    });
    await waitFor(() =>
      expect(tab.terminalRef?.current?.sendInput).toHaveBeenCalledWith(
        "systemctl status nginx\r",
      ),
    );
    await screen.findByText("panelAgent.toolCompleted", {}, { timeout: 3_000 });
    expect(await screen.findAllByText("nginx failed to start")).toHaveLength(2);
    expect(panelAgentApi.sendPanelAgentChat).toHaveBeenCalledTimes(2);
  });
});
