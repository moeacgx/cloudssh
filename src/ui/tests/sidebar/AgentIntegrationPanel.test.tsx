import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const agentApi = vi.hoisted(() => ({
  getAgentAdminAccess: vi.fn(),
  resolveAgentDeviceCode: vi.fn(),
  approveAgentDevice: vi.fn(),
  updateAgentDevice: vi.fn(),
  revokeAgentDevice: vi.fn(),
}));
const notifications = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));
const mfaApi = vi.hoisted(() => ({
  stepUpWithTotp: vi.fn(),
  getMfaStepUpMethods: vi.fn((error: unknown) => {
    const value = error as {
      code?: unknown;
      details?: { methods?: unknown };
    };
    return value.code === "MFA_STEP_UP_REQUIRED" &&
      Array.isArray(value.details?.methods)
      ? value.details.methods
      : null;
  }),
}));
const webauthnApi = vi.hoisted(() => ({
  stepUpWithWebAuthn: vi.fn(),
}));

vi.mock("@/api/agent-admin-api", () => agentApi);
vi.mock("@/api/mfa-api", () => mfaApi);
vi.mock("@/api/webauthn-api", () => webauthnApi);
vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: vi.fn(async () => true),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { username?: string }) =>
      options?.username ? `${key}:${options.username}` : key,
  }),
}));
vi.mock("sonner", () => ({
  toast: notifications,
}));

import { AgentIntegrationPanel } from "../../sidebar/AgentIntegrationPanel";
import {
  CLOUDSSH_REPOSITORY,
  isPublicHttpUrl,
} from "../../sidebar/agent-integration";

beforeEach(() => {
  vi.clearAllMocks();
  agentApi.getAgentAdminAccess.mockResolvedValue({
    projects: [{ id: "project-1", name: "生产项目" }],
    devices: [
      {
        id: "device-1",
        name: "工作站",
        fingerprint: "1234567890abcdef1234567890abcdef",
        status: "active",
        accessMode: "selected",
        projectIds: ["project-1"],
        scopes: ["sessions:read"],
        maxConcurrentSessions: 1,
        expiresAt: null,
        lastUsedAt: null,
        createdAt: "2026-07-31T00:00:00.000Z",
        revokedAt: null,
        owner: {
          userId: "admin",
          username: "admin",
          isCurrentUser: true,
        },
      },
    ],
  });
  agentApi.resolveAgentDeviceCode.mockResolvedValue({
    requestId: "request-1",
    deviceName: "Codex 工作站",
    fingerprint: "abcdef1234567890",
    expiresAt: "2026-07-31T12:00:00.000Z",
  });
  agentApi.approveAgentDevice.mockResolvedValue({ id: "device-2" });
  agentApi.updateAgentDevice.mockResolvedValue({ id: "device-1" });
  agentApi.revokeAgentDevice.mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("AgentIntegrationPanel", () => {
  it("只展示 Skill 与无 Token 登录命令", async () => {
    render(<AgentIntegrationPanel platformUrl="https://ssh.example.com" />);
    expect(document.body.textContent).toContain(
      `${CLOUDSSH_REPOSITORY}/tree/main/skills/cloudssh-agent`,
    );
    expect(document.body.textContent).toContain(
      "auth login --url https://ssh.example.com",
    );
    expect(document.body.textContent).not.toMatch(
      /--token|MCP JSON|privateKey|password/i,
    );
    await waitFor(() =>
      expect(agentApi.getAgentAdminAccess).toHaveBeenCalled(),
    );
  });

  it("默认收起低频 Agent 提示词并允许手动展开", async () => {
    render(<AgentIntegrationPanel platformUrl="https://ssh.example.com" />);

    const promptTrigger = screen.getByRole("button", {
      name: /agentIntegration\.agentPromptTitle/,
    });
    expect(promptTrigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("agentIntegration.agentPrompt")).toBeNull();

    fireEvent.click(promptTrigger);

    expect(promptTrigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("agentIntegration.agentPrompt")).toBeTruthy();
    await waitFor(() =>
      expect(agentApi.getAgentAdminAccess).toHaveBeenCalled(),
    );
  });

  it("输入设备码后核对指纹并批准一次", async () => {
    render(<AgentIntegrationPanel platformUrl="https://ssh.example.com" />);
    fireEvent.change(screen.getByPlaceholderText("ABCD-EFGH"), {
      target: { value: "ABCD-EFGH" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "agentIntegration.management.verifyDeviceCode",
      }),
    );
    expect(await screen.findByText("Codex 工作站")).toBeTruthy();
    expect(document.body.textContent).toContain("abcdef1234567890");
    expect(document.body.textContent).toContain(
      "agentIntegration.management.scopeClose",
    );
    expect(document.body.textContent).toContain(
      "agentIntegration.management.scopeServersCreate",
    );
    expect(document.body.textContent).toContain(
      "agentIntegration.management.scopeQuickConnectionsCreate",
    );
    expect(document.body.textContent).toContain(
      "agentIntegration.management.scopeFilesRead",
    );
    expect(document.body.textContent).toContain(
      "agentIntegration.management.scopeFilesWrite",
    );
    const filesWriteCheckbox = screen
      .getByText("agentIntegration.management.scopeFilesWrite")
      .closest("label")
      ?.querySelector('[role="checkbox"]');
    expect(filesWriteCheckbox?.getAttribute("data-state")).toBe("unchecked");
    expect(document.body.textContent).not.toContain("sessions:close");
    expect(
      screen.getByLabelText("agentIntegration.management.maxConcurrency"),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("agentIntegration.management.expirationOptional"),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "agentIntegration.management.approveDevice",
      }),
    );
    await waitFor(() =>
      expect(agentApi.approveAgentDevice).toHaveBeenCalledWith(
        "request-1",
        expect.objectContaining({
          accessMode: "all",
          projectIds: [],
          scopes: expect.arrayContaining([
            "sessions:create",
            "sessions:read",
            "sessions:write",
            "sessions:close",
            "jobs:execute",
            "servers:create",
            "quick-connections:create",
            "files:read",
          ]),
        }),
      ),
    );
    expect(agentApi.approveAgentDevice.mock.calls[0][1].scopes).not.toContain(
      "files:write",
    );
  });

  it("更换设备码或查询失败后不能批准之前的请求", async () => {
    agentApi.resolveAgentDeviceCode
      .mockResolvedValueOnce({
        requestId: "request-a",
        deviceName: "设备 A",
        fingerprint: "fingerprint-a",
        expiresAt: "2026-07-31T12:00:00.000Z",
      })
      .mockRejectedValueOnce(new Error("无效设备码"));

    render(<AgentIntegrationPanel platformUrl="https://ssh.example.com" />);
    const codeInput = screen.getByPlaceholderText("ABCD-EFGH");
    const verifyButton = screen.getByRole("button", {
      name: "agentIntegration.management.verifyDeviceCode",
    });

    fireEvent.change(codeInput, { target: { value: "AAAA-BBBB" } });
    fireEvent.click(verifyButton);
    expect(await screen.findByText("设备 A")).toBeTruthy();

    fireEvent.change(codeInput, { target: { value: "CCCC-DDDD" } });
    expect(screen.queryByText("设备 A")).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "agentIntegration.management.approveDevice",
      }),
    ).toBeNull();

    fireEvent.click(verifyButton);
    await waitFor(() =>
      expect(agentApi.resolveAgentDeviceCode).toHaveBeenLastCalledWith(
        "CCCC-DDDD",
      ),
    );
    expect(screen.queryByText("设备 A")).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "agentIntegration.management.approveDevice",
      }),
    ).toBeNull();
    expect(agentApi.approveAgentDevice).not.toHaveBeenCalled();
  });

  it("忽略设备码变化前仍在等待的查询结果", async () => {
    let finishLookup!: (value: {
      requestId: string;
      deviceName: string;
      fingerprint: string;
      expiresAt: string;
    }) => void;
    agentApi.resolveAgentDeviceCode.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishLookup = resolve;
        }),
    );

    render(<AgentIntegrationPanel platformUrl="https://ssh.example.com" />);
    const codeInput = screen.getByPlaceholderText("ABCD-EFGH");
    fireEvent.change(codeInput, { target: { value: "AAAA-BBBB" } });
    fireEvent.click(
      screen.getByRole("button", {
        name: "agentIntegration.management.verifyDeviceCode",
      }),
    );
    await waitFor(() =>
      expect(agentApi.resolveAgentDeviceCode).toHaveBeenCalledWith("AAAA-BBBB"),
    );

    fireEvent.change(codeInput, { target: { value: "CCCC-DDDD" } });
    await act(async () => {
      finishLookup({
        requestId: "stale-request",
        deviceName: "过期设备",
        fingerprint: "stale-fingerprint",
        expiresAt: "2026-07-31T12:00:00.000Z",
      });
    });

    expect(screen.queryByText("过期设备")).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "agentIntegration.management.approveDevice",
      }),
    ).toBeNull();
  });

  it("按设备所有者分组同名设备，并标出其他账号和未知账号", async () => {
    const baseDevice = {
      id: "device-own",
      name: "共享工作站",
      fingerprint: "1234567890abcdef1234567890abcdef",
      status: "active" as const,
      accessMode: "selected" as const,
      projectIds: ["project-1"],
      scopes: ["sessions:read"] as const,
      maxConcurrentSessions: 1,
      expiresAt: null,
      lastUsedAt: null,
      createdAt: "2026-07-31T00:00:00.000Z",
      revokedAt: null,
    };
    agentApi.getAgentAdminAccess.mockResolvedValueOnce({
      projects: [{ id: "project-1", name: "生产项目" }],
      devices: [
        {
          ...baseDevice,
          owner: {
            userId: "admin",
            username: "admin",
            isCurrentUser: true,
          },
        },
        {
          ...baseDevice,
          id: "device-other",
          fingerprint: "abcdef1234567890abcdef1234567890",
          owner: {
            userId: "project-admin",
            username: "project-admin",
            isCurrentUser: false,
          },
        },
        {
          ...baseDevice,
          id: "device-unknown",
          name: "旧设备",
          fingerprint: "fedcba0987654321fedcba0987654321",
          owner: {
            userId: null,
            username: null,
            isCurrentUser: false,
          },
        },
      ],
    });

    render(<AgentIntegrationPanel platformUrl="https://ssh.example.com" />);

    const ownGroup = await screen.findByRole("region", {
      name: "agentIntegration.management.currentAccountDevices",
    });
    const otherGroup = screen.getByRole("region", {
      name: "agentIntegration.management.otherAccountDevices",
    });
    expect(within(ownGroup).getAllByText("共享工作站")).toHaveLength(1);
    expect(within(otherGroup).getAllByText("共享工作站")).toHaveLength(1);
    expect(otherGroup.textContent).toContain(
      "agentIntegration.management.deviceOwnerAccount:project-admin",
    );
    expect(otherGroup.textContent).toContain(
      "agentIntegration.management.deviceOwnerAccount:agentIntegration.management.unknownOwner",
    );
    expect(ownGroup.textContent).not.toContain(
      "agentIntegration.management.deviceOwnerAccount",
    );
  });

  it("可以撤销已授权设备", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<AgentIntegrationPanel platformUrl="https://ssh.example.com" />);
    await screen.findByText("工作站");
    fireEvent.click(
      screen.getByTitle("agentIntegration.management.revokeDevice"),
    );
    await waitFor(() =>
      expect(agentApi.revokeAgentDevice).toHaveBeenCalledWith("device-1"),
    );
  });

  it("可以编辑已授权设备的名称和权限配置", async () => {
    render(<AgentIntegrationPanel platformUrl="https://ssh.example.com" />);
    await screen.findByText("工作站");
    fireEvent.click(
      screen.getByRole("button", {
        name: "agentIntegration.management.editDevice",
      }),
    );

    const name = screen.getByLabelText(
      "agentIntegration.management.deviceName",
    );
    fireEvent.change(name, { target: { value: "部署工作站" } });
    fireEvent.change(
      screen.getByLabelText("agentIntegration.management.maxConcurrency"),
      { target: { value: "4" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() =>
      expect(agentApi.updateAgentDevice).toHaveBeenCalledWith("device-1", {
        name: "部署工作站",
        accessMode: "selected",
        projectIds: ["project-1"],
        scopes: ["sessions:read"],
        maxConcurrentSessions: 4,
        expiresAt: null,
      }),
    );
    expect(notifications.success).toHaveBeenCalledWith(
      "agentIntegration.management.deviceUpdated",
    );
  });

  it("保存设备遇到近期 MFA 要求时显示具体验证方式并自动重试", async () => {
    const mfaRequired = Object.assign(
      new Error("请使用 TOTP 身份验证器或通行密钥完成二次验证"),
      {
        code: "MFA_STEP_UP_REQUIRED",
        details: { methods: ["totp", "webauthn"] },
      },
    );
    agentApi.updateAgentDevice
      .mockRejectedValueOnce(mfaRequired)
      .mockResolvedValueOnce({ id: "device-1" });
    mfaApi.stepUpWithTotp.mockResolvedValue({
      success: true,
      method: "totp",
    });

    render(<AgentIntegrationPanel platformUrl="https://ssh.example.com" />);
    await screen.findByText("工作站");
    fireEvent.click(
      screen.getByRole("button", {
        name: "agentIntegration.management.editDevice",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));

    expect(await screen.findByText("auth.stepUpTitle")).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "common.save",
          hidden: true,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "auth.useTotpAuthenticator" }),
    );
    fireEvent.change(screen.getByLabelText("auth.totpAuthenticatorLabel"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "auth.verifyCode" }));

    await waitFor(() =>
      expect(agentApi.updateAgentDevice).toHaveBeenCalledTimes(2),
    );
    expect(mfaApi.stepUpWithTotp).toHaveBeenCalledWith("123456");
    expect(notifications.success).toHaveBeenCalledWith(
      "agentIntegration.management.deviceUpdated",
    );
  });

  it("手动刷新失败时显示错误且保留现有设备", async () => {
    render(<AgentIntegrationPanel platformUrl="https://ssh.example.com" />);
    expect(await screen.findByText("工作站")).toBeTruthy();
    const refreshButton = screen.getByRole("button", {
      name: "agentIntegration.management.refresh",
    });
    await waitFor(() =>
      expect((refreshButton as HTMLButtonElement).disabled).toBe(false),
    );
    agentApi.getAgentAdminAccess.mockRejectedValueOnce({});

    fireEvent.click(refreshButton);

    await waitFor(() =>
      expect(notifications.error).toHaveBeenCalledWith(
        "agentIntegration.management.refreshFailed",
      ),
    );
    expect(screen.getByText("工作站")).toBeTruthy();
  });

  it("公网 HTTP 地址显示 HTTPS 警告", async () => {
    render(<AgentIntegrationPanel platformUrl="http://203.0.113.10:18080" />);
    expect(document.body.textContent).toContain(
      "agentIntegration.httpsRequiredDescription",
    );
    expect(document.body.textContent).toContain(
      "auth login --url http://203.0.113.10:18080",
    );
    expect(document.body.textContent).not.toContain("https://ssh.example.com");
    expect(await screen.findByText("工作站")).toBeTruthy();
  });
});

describe("isPublicHttpUrl", () => {
  it("只阻止公网 HTTP", () => {
    expect(isPublicHttpUrl("http://203.0.113.10:18080")).toBe(true);
    expect(isPublicHttpUrl("http://localhost:5173")).toBe(false);
    expect(isPublicHttpUrl("https://ssh.example.com")).toBe(false);
  });
});
