import type { Server } from "http";
import express from "express";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import bcrypt from "bcryptjs";
import speakeasy from "speakeasy";
import type { AuthenticatedRequest } from "../../../../types/index.js";
import type { AuthManager } from "../../../utils/auth-manager.js";
import { loginRateLimiter } from "../../../utils/login-rate-limiter.js";

// The route module imports repository factories and the logger; stub both so
// importing stays inert.
const userRepositoryUpdate = vi.fn().mockResolvedValue(null);
const userRepositoryFindById = vi.fn();

vi.mock("../../../database/repositories/factory.js", () => ({
  createCurrentUserRepository: () => ({
    findById: userRepositoryFindById,
    update: userRepositoryUpdate,
  }),
}));

vi.mock("../../../utils/logger.js", () => ({
  authLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

const { registerUserTotpRoutes, verifyTotpReauth } =
  await import("../../../database/routes/user-totp-routes.js");

type AnyUser = Parameters<typeof verifyTotpReauth>[0];

const secret = speakeasy.generateSecret({ name: "test" }).base32;

function makeUser(overrides: Partial<AnyUser> = {}): AnyUser {
  return {
    id: "user-1",
    isOidc: false,
    passwordHash: bcrypt.hashSync("correct-horse", 4),
    totpSecret: secret,
    totpBackupCodes: JSON.stringify(["BACKUP01", "BACKUP02"]),
    totpEnabled: true,
    ...overrides,
  } as AnyUser;
}

describe("verifyTotpReauth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not accept the account password as a second factor", async () => {
    expect(await verifyTotpReauth(makeUser(), "correct-horse")).toBe(false);
  });

  it("accepts a valid TOTP code without a password", async () => {
    const token = speakeasy.totp({ secret, encoding: "base32" });
    expect(await verifyTotpReauth(makeUser(), token)).toBe(true);
  });

  it("accepts a valid backup code and consumes it", async () => {
    const result = await verifyTotpReauth(makeUser(), "BACKUP01");
    expect(result).toBe(true);
    expect(userRepositoryUpdate).toHaveBeenCalledWith("user-1", {
      totpBackupCodes: JSON.stringify(["BACKUP02"]),
    });
  });

  it("rejects a wrong password / invalid code", async () => {
    expect(await verifyTotpReauth(makeUser(), "wrong")).toBe(false);
    expect(userRepositoryUpdate).not.toHaveBeenCalled();
  });

  it("ignores the password path for OIDC users but still accepts TOTP", async () => {
    const token = speakeasy.totp({ secret, encoding: "base32" });
    const oidcUser = makeUser({ isOidc: true, passwordHash: null });
    expect(await verifyTotpReauth(oidcUser, token)).toBe(true);
    expect(await verifyTotpReauth(oidcUser, "anything")).toBe(false);
  });

  it("handles malformed backup-code JSON without throwing", async () => {
    const user = makeUser({ totpBackupCodes: "not json" });
    expect(await verifyTotpReauth(user, "BACKUP01")).toBe(false);
  });
});

describe("TOTP 当前会话二次验证", () => {
  let server: Server | undefined;
  let baseUrl = "";
  let authState: {
    sessionId?: string;
    apiKeyId?: string;
    pendingTOTP?: boolean;
  };
  const refreshSessionToken = vi.fn();
  const getUserDataKey = vi.fn();
  const getSecureCookieOptions = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    authState = { sessionId: "session-1" };
    userRepositoryFindById.mockResolvedValue(
      makeUser({ username: "alice" } as Partial<AnyUser>),
    );
    refreshSessionToken.mockResolvedValue({
      token: "refreshed-session-token",
      maxAge: 60_000,
    });
    getUserDataKey.mockReturnValue(Buffer.alloc(32, 1));
    getSecureCookieOptions.mockImplementation(
      (_req: unknown, maxAge: number) => ({
        httpOnly: true,
        sameSite: "lax" as const,
        path: "/",
        maxAge,
      }),
    );
    loginRateLimiter.resetTOTPAttempts("user-1");

    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerUserTotpRoutes(router, {
      authenticateJWT: (req, _res, next) => {
        const authReq = req as AuthenticatedRequest;
        authReq.userId = "user-1";
        authReq.sessionId = authState.sessionId;
        authReq.apiKeyId = authState.apiKeyId;
        authReq.pendingTOTP = authState.pendingTOTP;
        next();
      },
      authManager: {
        refreshSessionToken,
        getUserDataKey,
        getSecureCookieOptions,
      } as unknown as AuthManager,
      isNativeAppRequest: () => false,
    });
    app.use("/users", router);

    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("测试服务启动失败");
    }
    baseUrl = `http://127.0.0.1:${address.port}/users`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
      server = undefined;
    }
  });

  function stepUp(totpCode: string) {
    return fetch(`${baseUrl}/totp/step-up`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ totp_code: totpCode }),
    });
  }

  it("验证码正确时提升原会话并刷新 Cookie", async () => {
    const token = speakeasy.totp({ secret, encoding: "base32" });

    const response = await stepUp(token);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      method: "totp",
    });
    expect(refreshSessionToken).toHaveBeenCalledWith("user-1", "session-1", {
      mfaVerifiedAt: expect.any(Number),
    });
    expect(response.headers.get("set-cookie")).toContain(
      "jwt=refreshed-session-token",
    );
  });

  it("错误验证码不会提升会话", async () => {
    const response = await stepUp("NOT-A-CODE");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      code: "INVALID_TOTP_CODE",
    });
    expect(refreshSessionToken).not.toHaveBeenCalled();
  });

  it("未启用身份验证器时返回可操作原因", async () => {
    userRepositoryFindById.mockResolvedValueOnce(
      makeUser({ totpEnabled: false, totpSecret: null }),
    );

    const response = await stepUp("123456");

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "TOTP_NOT_ENROLLED",
    });
    expect(refreshSessionToken).not.toHaveBeenCalled();
  });

  it("API Key 或未完成登录的临时令牌不能执行二次验证", async () => {
    authState = { apiKeyId: "api-key-1", pendingTOTP: true };

    const response = await stepUp("123456");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      code: "INTERACTIVE_SESSION_REQUIRED",
    });
    expect(userRepositoryFindById).not.toHaveBeenCalled();
  });
});
