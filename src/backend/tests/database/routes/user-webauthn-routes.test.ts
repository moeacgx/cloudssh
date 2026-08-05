import type { Server } from "http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedRequest } from "../../../../types/index.js";
import type { AuthManager } from "../../../utils/auth-manager.js";

const mocks = vi.hoisted(() => ({
  generateAuthenticationOptions: vi.fn(),
  generateRegistrationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
  listCredentials: vi.fn(),
  findCredential: vi.fn(),
  createCredential: vi.fn(),
  deleteCredential: vi.fn(),
  updateAuthState: vi.fn(),
  findUserById: vi.fn(),
  findUserByUsername: vi.fn(),
  refreshSessionToken: vi.fn(),
  getSecureCookieOptions: vi.fn(),
  authenticateWebAuthnUser: vi.fn(),
  generateJWTToken: vi.fn(),
  getUserDataKey: vi.fn(),
}));

vi.mock("@simplewebauthn/server", () => ({
  generateAuthenticationOptions: mocks.generateAuthenticationOptions,
  generateRegistrationOptions: mocks.generateRegistrationOptions,
  verifyAuthenticationResponse: mocks.verifyAuthenticationResponse,
  verifyRegistrationResponse: mocks.verifyRegistrationResponse,
}));

vi.mock("../../../database/repositories/factory.js", () => ({
  createCurrentWebauthnCredentialRepository: () => ({
    listByUserId: mocks.listCredentials,
    findByCredentialId: mocks.findCredential,
    create: mocks.createCredential,
    deleteForUser: mocks.deleteCredential,
    updateAuthState: mocks.updateAuthState,
  }),
  createCurrentUserRepository: () => ({
    findById: mocks.findUserById,
    findByUsername: mocks.findUserByUsername,
  }),
  getCurrentSettingValue: vi.fn(() => null),
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

const { registerUserWebAuthnRoutes } =
  await import("../../../database/routes/user-webauthn-routes.js");

const credential = {
  id: "credential-row-1",
  userId: "user-1",
  name: "Laptop passkey",
  credentialId: "credential-id-1",
  publicKey: Buffer.from([1, 2, 3, 4]).toString("base64url"),
  counter: 2,
  deviceType: "multiDevice",
  backedUp: true,
  transports: JSON.stringify(["internal"]),
  userVerification: "required",
  createdAt: new Date().toISOString(),
  lastUsedAt: null,
};

describe("WebAuthn 当前会话二次验证", () => {
  let server: Server | undefined;
  let baseUrl = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.listCredentials.mockResolvedValue([credential]);
    mocks.findCredential.mockResolvedValue(credential);
    mocks.createCredential.mockResolvedValue(credential);
    mocks.deleteCredential.mockResolvedValue(true);
    mocks.updateAuthState.mockResolvedValue(undefined);
    mocks.generateAuthenticationOptions.mockResolvedValue({
      challenge: "generated-challenge",
    });
    mocks.generateRegistrationOptions.mockResolvedValue({
      challenge: "registration-challenge",
    });
    mocks.verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: {
        newCounter: 3,
        userVerified: true,
        credentialDeviceType: "multiDevice",
        credentialBackedUp: true,
      },
    });
    mocks.verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: "new-credential-id",
          publicKey: new Uint8Array([1, 2, 3, 4]),
          counter: 0,
        },
        credentialDeviceType: "multiDevice",
        credentialBackedUp: true,
        userVerified: true,
      },
    });
    mocks.refreshSessionToken.mockResolvedValue({
      token: "refreshed-session-token",
      maxAge: 60_000,
    });
    mocks.findUserById.mockResolvedValue({
      id: "user-1",
      username: "alice",
      isAdmin: false,
      isOidc: false,
      totpEnabled: false,
    });
    mocks.findUserByUsername.mockResolvedValue({
      id: "user-1",
      username: "alice",
    });
    mocks.authenticateWebAuthnUser.mockResolvedValue(true);
    mocks.generateJWTToken.mockResolvedValue("login-session-token");
    mocks.getUserDataKey.mockReturnValue(Buffer.alloc(32, 1));
    mocks.getSecureCookieOptions.mockImplementation(
      (_req: unknown, maxAge: number) => ({
        httpOnly: true,
        sameSite: "lax" as const,
        path: "/",
        maxAge,
      }),
    );

    const app = express();
    app.set("trust proxy", true);
    app.use(express.json());
    app.use((req, _res, next) => {
      const testHost = req.get("x-test-host");
      if (testHost) req.headers.host = testHost;
      next();
    });
    const router = express.Router();
    const authManager = {
      refreshSessionToken: mocks.refreshSessionToken,
      getSecureCookieOptions: mocks.getSecureCookieOptions,
      authenticateWebAuthnUser: mocks.authenticateWebAuthnUser,
      generateJWTToken: mocks.generateJWTToken,
      getUserDataKey: mocks.getUserDataKey,
    } as unknown as AuthManager;

    registerUserWebAuthnRoutes(router, {
      authenticateJWT: (req, _res, next) => {
        const authReq = req as AuthenticatedRequest;
        authReq.userId = String(req.get("x-test-user") || "user-1");
        authReq.sessionId = String(req.get("x-test-session") || "session-1");
        authReq.mfaVerifiedAt = Number(
          req.get("x-test-mfa-verified-at") || Math.floor(Date.now() / 1000),
        );
        authReq.authVerifiedAt = Number(
          req.get("x-test-auth-verified-at") || Math.floor(Date.now() / 1000),
        );
        if (req.get("x-test-api-key")) authReq.apiKeyId = "api-key-1";
        next();
      },
      authManager,
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
    if (!server) return;
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
    server = undefined;
  });

  function webAuthnHeaders(extra: Record<string, string> = {}) {
    return {
      "content-type": "application/json",
      origin: "https://cloudssh.test",
      "x-test-host": "cloudssh.test",
      "x-forwarded-proto": "https",
      ...extra,
    };
  }

  async function createStepUpChallenge() {
    const response = await fetch(`${baseUrl}/webauthn/step-up/options`, {
      method: "POST",
      headers: webAuthnHeaders({
        "x-test-user": "user-1",
        "x-test-session": "session-1",
      }),
      body: JSON.stringify({ userVerification: "discouraged" }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as { challengeId: string };
  }

  function verifyStepUp(
    challengeId: string,
    userId = "user-1",
    sessionId = "session-1",
  ) {
    return fetch(`${baseUrl}/webauthn/step-up/verify`, {
      method: "POST",
      headers: webAuthnHeaders({
        "x-test-user": userId,
        "x-test-session": sessionId,
      }),
      body: JSON.stringify({
        challengeId,
        response: { id: credential.credentialId, type: "public-key" },
      }),
    });
  }

  it("无论客户端请求什么模式都强制执行用户验证", async () => {
    await createStepUpChallenge();

    expect(mocks.generateAuthenticationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: "cloudssh.test",
        userVerification: "required",
        allowCredentials: [
          expect.objectContaining({
            id: credential.credentialId,
            transports: ["internal"],
          }),
        ],
      }),
    );
  });

  it("旧通行密钥可在强制本地用户验证后迁移用于二次验证", async () => {
    mocks.listCredentials.mockResolvedValue([
      { ...credential, userVerification: "preferred" },
    ]);

    const { challengeId } = await createStepUpChallenge();
    const response = await verifyStepUp(challengeId);

    expect(response.status).toBe(200);
    expect(mocks.verifyAuthenticationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        requireUserVerification: true,
        advancedFIDOConfig: { userVerification: "required" },
      }),
    );
    expect(mocks.updateAuthState).toHaveBeenCalledWith(
      credential.id,
      expect.objectContaining({ userVerification: "required" }),
    );
  });

  it("注册和密码无关登录都拒绝客户端降低用户验证等级", async () => {
    const registration = await fetch(`${baseUrl}/webauthn/register/options`, {
      method: "POST",
      headers: webAuthnHeaders(),
      body: JSON.stringify({ userVerification: "discouraged" }),
    });
    expect(registration.status).toBe(200);
    const registrationBody = (await registration.json()) as {
      challengeId: string;
    };
    expect(mocks.generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: "cloudssh.test",
        authenticatorSelection: expect.objectContaining({
          residentKey: "required",
          userVerification: "required",
        }),
      }),
    );
    const registered = await fetch(`${baseUrl}/webauthn/register/verify`, {
      method: "POST",
      headers: webAuthnHeaders(),
      body: JSON.stringify({
        challengeId: registrationBody.challengeId,
        name: "Windows Hello",
        response: { id: "new-credential-id", type: "public-key" },
      }),
    });
    expect(registered.status).toBe(200);
    expect(mocks.verifyRegistrationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedOrigin: "https://cloudssh.test",
        expectedRPID: "cloudssh.test",
        requireUserVerification: true,
      }),
    );
    expect(mocks.createCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        name: "Windows Hello",
        userVerification: "required",
      }),
    );

    const options = await fetch(`${baseUrl}/webauthn/authenticate/options`, {
      method: "POST",
      headers: webAuthnHeaders(),
      body: JSON.stringify({ userVerification: "discouraged" }),
    });
    expect(options.status).toBe(200);
    const { challengeId } = (await options.json()) as { challengeId: string };
    expect(mocks.generateAuthenticationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: "cloudssh.test",
        userVerification: "required",
      }),
    );

    const verified = await fetch(`${baseUrl}/webauthn/authenticate/verify`, {
      method: "POST",
      headers: webAuthnHeaders(),
      body: JSON.stringify({
        challengeId,
        response: { id: credential.credentialId, type: "public-key" },
      }),
    });
    expect(verified.status).toBe(200);
    expect(mocks.verifyAuthenticationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        requireUserVerification: true,
        advancedFIDOConfig: { userVerification: "required" },
      }),
    );
    expect(mocks.generateJWTToken).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ mfaVerifiedAt: expect.any(Number) }),
    );
    expect(mocks.updateAuthState).toHaveBeenCalledWith(
      credential.id,
      expect.objectContaining({ userVerification: "required" }),
    );
  });

  it("底层未确认本地用户验证时拒绝签发登录会话", async () => {
    const options = await fetch(`${baseUrl}/webauthn/authenticate/options`, {
      method: "POST",
      headers: webAuthnHeaders(),
    });
    const { challengeId } = (await options.json()) as { challengeId: string };
    mocks.verifyAuthenticationResponse.mockResolvedValueOnce({
      verified: true,
      authenticationInfo: {
        newCounter: 3,
        userVerified: false,
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
      },
    });

    const verified = await fetch(`${baseUrl}/webauthn/authenticate/verify`, {
      method: "POST",
      headers: webAuthnHeaders(),
      body: JSON.stringify({
        challengeId,
        response: { id: credential.credentialId, type: "public-key" },
      }),
    });

    expect(verified.status).toBe(401);
    expect(mocks.generateJWTToken).not.toHaveBeenCalled();
    expect(mocks.updateAuthState).not.toHaveBeenCalled();
  });

  it("注册阶段底层未确认本地用户验证时不保存通行密钥", async () => {
    const options = await fetch(`${baseUrl}/webauthn/register/options`, {
      method: "POST",
      headers: webAuthnHeaders(),
    });
    const { challengeId } = (await options.json()) as { challengeId: string };
    mocks.verifyRegistrationResponse.mockResolvedValueOnce({
      verified: true,
      registrationInfo: {
        credential: {
          id: "new-credential-id",
          publicKey: new Uint8Array([1, 2, 3, 4]),
          counter: 0,
        },
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
        userVerified: false,
      },
    });

    const response = await fetch(`${baseUrl}/webauthn/register/verify`, {
      method: "POST",
      headers: webAuthnHeaders(),
      body: JSON.stringify({
        challengeId,
        response: { id: "new-credential-id", type: "public-key" },
      }),
    });

    expect(response.status).toBe(400);
    expect(mocks.createCredential).not.toHaveBeenCalled();
  });

  it("API Key 不能查看或注册通行密钥", async () => {
    const headers = webAuthnHeaders({ "x-test-api-key": "true" });
    const listed = await fetch(`${baseUrl}/webauthn/credentials`, { headers });
    const registration = await fetch(`${baseUrl}/webauthn/register/options`, {
      method: "POST",
      headers,
    });

    expect(listed.status).toBe(401);
    expect(registration.status).toBe(401);
    await expect(registration.json()).resolves.toMatchObject({
      code: "INTERACTIVE_SESSION_REQUIRED",
    });
    expect(mocks.generateRegistrationOptions).not.toHaveBeenCalled();
  });

  it("首次注册没有现有 MFA 时仅接受近期主登录", async () => {
    mocks.listCredentials.mockResolvedValue([]);
    const recent = await fetch(`${baseUrl}/webauthn/register/options`, {
      method: "POST",
      headers: webAuthnHeaders({
        "x-test-mfa-verified-at": "0",
      }),
    });
    expect(recent.status).toBe(200);

    const stale = await fetch(`${baseUrl}/webauthn/register/options`, {
      method: "POST",
      headers: webAuthnHeaders({
        "x-test-mfa-verified-at": "0",
        "x-test-auth-verified-at": String(
          Math.floor(Date.now() / 1000) - 10 * 60,
        ),
      }),
    });
    expect(stale.status).toBe(401);
    await expect(stale.json()).resolves.toMatchObject({
      code: "RECENT_LOGIN_REQUIRED",
    });
  });

  it("拒绝 Origin 与当前可信面板地址不一致的请求", async () => {
    const response = await fetch(`${baseUrl}/webauthn/authenticate/options`, {
      method: "POST",
      headers: webAuthnHeaders({
        origin: "https://attacker.example",
        "x-forwarded-host": "attacker.example",
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "WEBAUTHN_ORIGIN_MISMATCH",
    });
    expect(mocks.generateAuthenticationOptions).not.toHaveBeenCalled();
  });

  it("限制单个来源频繁创建公开登录挑战", async () => {
    const headers = webAuthnHeaders({
      "x-forwarded-for": "198.51.100.77",
    });
    for (let index = 0; index < 30; index += 1) {
      const response = await fetch(`${baseUrl}/webauthn/authenticate/options`, {
        method: "POST",
        headers,
      });
      expect(response.status).toBe(200);
    }

    const limited = await fetch(`${baseUrl}/webauthn/authenticate/options`, {
      method: "POST",
      headers,
    });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("挑战只能由创建它的用户和会话消费，成功后刷新 Cookie", async () => {
    const { challengeId } = await createStepUpChallenge();

    const wrongUser = await verifyStepUp(challengeId, "user-2", "session-1");
    expect(wrongUser.status).toBe(400);

    const wrongSession = await verifyStepUp(challengeId, "user-1", "session-2");
    expect(wrongSession.status).toBe(400);

    const verified = await verifyStepUp(challengeId);
    expect(verified.status).toBe(200);
    await expect(verified.json()).resolves.toMatchObject({
      success: true,
      method: "webauthn",
    });

    expect(mocks.verifyAuthenticationResponse).toHaveBeenCalledTimes(1);
    expect(mocks.verifyAuthenticationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: "generated-challenge",
        expectedOrigin: "https://cloudssh.test",
        expectedRPID: "cloudssh.test",
        requireUserVerification: true,
        advancedFIDOConfig: { userVerification: "required" },
      }),
    );
    expect(mocks.refreshSessionToken).toHaveBeenCalledWith(
      "user-1",
      "session-1",
      { mfaVerifiedAt: expect.any(Number) },
    );
    expect(verified.headers.get("set-cookie")).toContain(
      "jwt=refreshed-session-token",
    );
    expect(verified.headers.get("set-cookie")).toContain("HttpOnly");

    const replay = await verifyStepUp(challengeId);
    expect(replay.status).toBe(400);
    expect(mocks.verifyAuthenticationResponse).toHaveBeenCalledTimes(1);
  });

  it("底层未确认本地用户验证时拒绝提升当前会话", async () => {
    const { challengeId } = await createStepUpChallenge();
    mocks.verifyAuthenticationResponse.mockResolvedValueOnce({
      verified: true,
      authenticationInfo: {
        newCounter: 3,
        userVerified: false,
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
      },
    });

    const response = await verifyStepUp(challengeId);

    expect(response.status).toBe(401);
    expect(mocks.refreshSessionToken).not.toHaveBeenCalled();
    expect(mocks.updateAuthState).not.toHaveBeenCalled();
  });
});
