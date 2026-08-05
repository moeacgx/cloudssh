import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  post: vi.fn(),
}));

vi.mock("@/main-axios", () => ({
  authApi: api,
  handleApiError: (error: unknown) => error,
}));

import { getMfaStepUpMethods, verifyTotpStepUp } from "@/api/mfa-api";

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("MFA 二次验证 API", () => {
  it("从结构化错误中提取服务端允许的验证方式", () => {
    const error = Object.assign(new Error("需要二次验证"), {
      code: "MFA_STEP_UP_REQUIRED",
      details: { methods: ["totp", "webauthn", "totp", "invalid"] },
    });

    expect(getMfaStepUpMethods(error)).toEqual(["totp", "webauthn"]);
  });

  it("兼容旧服务端未返回验证方式，并忽略无关错误", () => {
    expect(
      getMfaStepUpMethods({
        details: { code: "MFA_STEP_UP_REQUIRED" },
      }),
    ).toEqual(["webauthn", "totp"]);
    expect(getMfaStepUpMethods({ code: "AUTH_REQUIRED" })).toBeNull();
  });

  it("使用 TOTP 提升当前会话并保存原生客户端返回的令牌", async () => {
    api.post.mockResolvedValueOnce({
      data: {
        success: true,
        method: "totp",
        token: "refreshed-session-token",
      },
    });

    await expect(verifyTotpStepUp("123456")).resolves.toMatchObject({
      success: true,
      method: "totp",
    });
    expect(api.post).toHaveBeenCalledWith("/users/totp/step-up", {
      totp_code: "123456",
    });
    expect(localStorage.getItem("jwt")).toBe("refreshed-session-token");
  });
});
