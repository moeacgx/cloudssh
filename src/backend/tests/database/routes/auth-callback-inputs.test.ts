import type { Server } from "http";
import express from "express";
import { JSDOM } from "jsdom";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  completeVaultAuth: vi.fn(),
  findProvider: vi.fn(),
  createProviderRepository: vi.fn(),
  loadProviderConfig: vi.fn(),
  createLDAPClient: vi.fn(),
}));

vi.mock("../../../database/repositories/factory.js", () => ({
  createCurrentSsoProviderRepository: mocks.createProviderRepository,
  createCurrentRoleRepository: vi.fn(),
  createCurrentSettingsRepository: vi.fn(),
  createCurrentUserRepository: vi.fn(),
  createCurrentVaultProfileRepository: vi.fn(),
  createCurrentSyncTombstoneRepository: vi.fn(),
}));
vi.mock("../../../utils/auth-manager.js", () => ({
  AuthManager: {
    getInstance: () => ({ createAuthMiddleware: () => vi.fn() }),
  },
}));
vi.mock("../../../utils/logger.js", () => ({
  authLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("../../../hosts/vault-oidc-auth.js", () => ({
  completeVaultAuth: mocks.completeVaultAuth,
}));
vi.mock("../../../database/routes/user-oidc-utils.js", () => ({
  loadProviderConfig: mocks.loadProviderConfig,
  isOIDCUserAllowed: vi.fn(),
}));
vi.mock("ldapjs", () => ({
  default: { createClient: mocks.createLDAPClient },
}));

const { default: vaultRouter } =
  await import("../../../database/routes/vault.js");
const { registerLDAPAuthRoutes } =
  await import("../../../database/routes/ldap-auth-routes.js");

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.set("query parser", "extended");
  app.use(express.json());
  app.use("/vault", vaultRouter);
  const users = express.Router();
  registerLDAPAuthRoutes(users);
  app.use("/users", users);
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("本地测试端口无效");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.createProviderRepository.mockReturnValue({
    findById: mocks.findProvider,
  });
  mocks.findProvider.mockResolvedValue(null);
  mocks.completeVaultAuth.mockResolvedValue({ ok: true });
});

describe("Vault 回调的 HTML 与参数边界", () => {
  const payloads = [
    "</title><script>alert(7788)</script>",
    "<img src=x onerror=alert(1)>",
    "<svg/onload=alert(2)>",
    "<&\"'&lt;script&gt;",
  ];

  it.each(payloads)("错误参数只显示为文本：%s", async (payload) => {
    for (const path of ["/vault/oidc/callback", "/vault/oidc/callback/"]) {
      const response = await fetch(
        `${baseUrl}${path}?error=${encodeURIComponent(payload)}`,
      );
      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toContain("text/html");
      const { document } = new JSDOM(await response.text()).window;
      expect(document.title).toBe("Vault sign-in failed");
      expect(document.querySelector("p")?.textContent).toBe(
        `Vault returned: ${payload}`,
      );
      expect(document.querySelectorAll("img,svg")).toHaveLength(0);
      expect(document.querySelectorAll("script")).toHaveLength(1);
      expect(document.querySelector("script")?.textContent).toContain(
        "window.close()",
      );
      expect(mocks.completeVaultAuth).not.toHaveBeenCalled();
    }
  });

  it.each([
    "error=one&error=two",
    "error[nested]=value",
    "state=one&state=two&code=valid",
    "state[nested]=value&code=valid",
    "state=valid&code=one&code=two",
    "state=valid&code[nested]=value",
  ])("拒绝非单字符串查询参数：%s", async (query) => {
    const response = await fetch(`${baseUrl}/vault/oidc/callback?${query}`);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Invalid callback parameters.");
    expect(mocks.completeVaultAuth).not.toHaveBeenCalled();
  });

  it("认证服务返回的错误同样转义", async () => {
    mocks.completeVaultAuth.mockResolvedValue({
      ok: false,
      error: payloads[1],
    });
    const response = await fetch(
      `${baseUrl}/vault/oidc/callback?state=state&code=code`,
    );
    expect(response.status).toBe(400);
    const { document } = new JSDOM(await response.text()).window;
    expect(document.querySelector("p")?.textContent).toBe(payloads[1]);
    expect(document.querySelectorAll("img")).toHaveLength(0);
  });

  it("有效回调保留原始 state/code 并正常完成", async () => {
    const response = await fetch(
      `${baseUrl}/vault/oidc/callback?state=state%2B1&code=code%2B2`,
    );
    expect(response.status).toBe(200);
    expect(mocks.completeVaultAuth).toHaveBeenCalledWith("state+1", "code+2");
    expect(await response.text()).toContain("Vault sign-in complete");
  });
});

async function ldapLogin(body: unknown) {
  return fetch(`${baseUrl}/users/ldap/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("LDAP 登录在数据库与网络前校验 JSON 类型", () => {
  it.each(
    [
      {},
      { $ne: null },
      { $regex: ".*" },
      { $where: "invalid" },
      [],
      [1],
      true,
      false,
      "1",
      "x",
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      null,
    ].map((providerId) => ({ providerId })),
  )("拒绝非法 providerId：%j", async ({ providerId }) => {
    const response = await ldapLogin({
      providerId,
      username: "alice",
      password: "secret",
    });
    expect(response.status).toBe(400);
    expect(mocks.createProviderRepository).not.toHaveBeenCalled();
    expect(mocks.loadProviderConfig).not.toHaveBeenCalled();
    expect(mocks.createLDAPClient).not.toHaveBeenCalled();
  });

  it.each([
    { username: {} },
    { username: [] },
    { username: "" },
    { password: {} },
    { password: true },
    { password: "" },
    { rememberMe: "true" },
    { rememberMe: {} },
  ])("拒绝其他非法字段：%j", async (invalid) => {
    const response = await ldapLogin({
      providerId: 1,
      username: "alice",
      password: "secret",
      ...invalid,
    });
    expect(response.status).toBe(400);
    expect(mocks.createProviderRepository).not.toHaveBeenCalled();
    expect(mocks.createLDAPClient).not.toHaveBeenCalled();
  });

  it("有效数值 ID 仍查询供应商并返回原有 404", async () => {
    const response = await ldapLogin({
      providerId: 42,
      username: "alice",
      password: "secret",
      rememberMe: false,
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "LDAP provider not found" });
    expect(mocks.findProvider).toHaveBeenCalledWith(42);
    expect(mocks.createLDAPClient).not.toHaveBeenCalled();
  });

  it.each([null, [], {}].map((body) => ({ body })))(
    "拒绝无登录字段的请求体：%j",
    async ({ body }) => {
      const response = await ldapLogin(body);
      expect(response.status).toBe(400);
      expect(mocks.createProviderRepository).not.toHaveBeenCalled();
      expect(mocks.createLDAPClient).not.toHaveBeenCalled();
    },
  );

  it("正常字段允许加载配置并尝试 LDAP 认证", async () => {
    mocks.findProvider.mockResolvedValue({ type: "ldap", enabled: true });
    mocks.loadProviderConfig.mockResolvedValue({
      config: {
        host: "ldap.test.invalid",
        bindDN: "cn=service",
        bindPassword: "service-password",
        userSearchBase: "dc=test",
        userSearchFilter: "(uid={{username}})",
      },
    });
    const bind = vi.fn((_dn, _password, callback) =>
      callback(new Error("离线测试")),
    );
    const unbind = vi.fn();
    mocks.createLDAPClient.mockReturnValue({ bind, unbind });
    const response = await ldapLogin({
      providerId: 42,
      username: "alice",
      password: " secret ",
      rememberMe: true,
    });
    expect(await response.json()).toEqual({
      error: "LDAP authentication failed",
    });
    expect(mocks.loadProviderConfig).toHaveBeenCalledWith(42);
    expect(mocks.createLDAPClient).toHaveBeenCalledWith({
      url: "ldap://ldap.test.invalid:389",
      tlsOptions: undefined,
    });
    expect(bind).toHaveBeenCalledWith(
      "cn=service",
      "service-password",
      expect.any(Function),
    );
    expect(unbind).toHaveBeenCalledOnce();
  });
});
