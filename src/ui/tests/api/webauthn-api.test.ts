import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  post: vi.fn(),
}));
const browser = vi.hoisted(() => ({
  browserSupportsWebAuthn: vi.fn(() => true),
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
}));

vi.mock("@/main-axios", () => ({
  authApi: api,
  handleApiError: (error: unknown) => error,
}));
vi.mock("@simplewebauthn/browser", () => browser);

import {
  authenticateWithWebAuthn,
  stepUpWithWebAuthn,
} from "@/api/webauthn-api";

beforeEach(() => {
  vi.clearAllMocks();
  browser.browserSupportsWebAuthn.mockReturnValue(true);
  localStorage.clear();
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: true,
  });
  browser.startAuthentication.mockResolvedValue({
    id: "credential-id",
    response: {},
    type: "public-key",
  });
});

describe("WebAuthn 登录与二次验证 API", () => {
  it("允许空用户名启动发现式通行密钥登录", async () => {
    api.post
      .mockResolvedValueOnce({
        data: {
          options: { challenge: "challenge" },
          challengeId: "login-challenge",
        },
      })
      .mockResolvedValueOnce({
        data: {
          success: true,
          username: "alice",
          userId: "user-1",
        },
      });

    const result = await authenticateWithWebAuthn("", true);

    expect(api.post).toHaveBeenNthCalledWith(
      1,
      "/users/webauthn/authenticate/options",
      { username: undefined, userVerification: "required" },
    );
    expect(browser.startAuthentication).toHaveBeenCalledWith({
      optionsJSON: { challenge: "challenge" },
    });
    expect(api.post).toHaveBeenNthCalledWith(
      2,
      "/users/webauthn/authenticate/verify",
      expect.objectContaining({
        challengeId: "login-challenge",
        rememberMe: true,
      }),
    );
    expect(result).toMatchObject({ success: true, username: "alice" });
  });

  it("通行密钥完成用户验证后刷新当前会话", async () => {
    api.post
      .mockResolvedValueOnce({
        data: {
          options: { challenge: "challenge" },
          challengeId: "step-up-challenge",
        },
      })
      .mockResolvedValueOnce({
        data: {
          success: true,
          method: "webauthn",
          mfa_verified_at: 123,
          token: "refreshed-session-token",
        },
      });

    await expect(stepUpWithWebAuthn()).resolves.toMatchObject({
      success: true,
      method: "webauthn",
    });
    expect(api.post).toHaveBeenNthCalledWith(
      1,
      "/users/webauthn/step-up/options",
      { userVerification: "required" },
    );
    expect(localStorage.getItem("jwt")).toBe("refreshed-session-token");
  });

  it("公网 HTTP 环境在请求后端前给出 HTTPS 原因", async () => {
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });

    await expect(authenticateWithWebAuthn("", false)).rejects.toMatchObject({
      code: "WEBAUTHN_SECURE_CONTEXT_REQUIRED",
    });
    expect(api.post).not.toHaveBeenCalled();
  });

  it("浏览器取消或没有当前站点通行密钥时返回可识别错误码", async () => {
    api.post.mockResolvedValueOnce({
      data: {
        options: { challenge: "challenge" },
        challengeId: "login-challenge",
      },
    });
    browser.startAuthentication.mockRejectedValueOnce(
      Object.assign(new Error("The operation was not allowed"), {
        code: "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY",
      }),
    );

    await expect(authenticateWithWebAuthn("", false)).rejects.toMatchObject({
      code: "WEBAUTHN_CANCELED_OR_UNAVAILABLE",
    });
  });
});
