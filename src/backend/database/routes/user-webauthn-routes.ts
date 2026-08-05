import type { Request, RequestHandler, Response, Router } from "express";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
  AuthenticatorTransportFuture,
  Base64URLString,
  WebAuthnCredential,
} from "@simplewebauthn/server";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { nanoid } from "nanoid";
import type { AuthenticatedRequest } from "../../../types/index.js";
import { AuthManager } from "../../utils/auth-manager.js";
import { hasRecentVerification } from "../../utils/admin-sensitive-access.js";
import { authLogger } from "../../utils/logger.js";
import { parseUserAgent } from "../../utils/user-agent-parser.js";
import {
  createCurrentUserRepository,
  createCurrentWebauthnCredentialRepository,
  getCurrentSettingValue,
} from "../repositories/factory.js";
import type { WebauthnCredentialRecord } from "../repositories/webauthn-credential-repository.js";

type UserVerification = "discouraged" | "preferred" | "required";
type NativeAppRequestChecker = (req: Request) => boolean;

interface WebAuthnRoutesDeps {
  authenticateJWT: RequestHandler;
  authManager: AuthManager;
  isNativeAppRequest: NativeAppRequestChecker;
}

interface ChallengeRecord {
  challenge: string;
  userId?: string;
  sessionId?: string;
  rpID: string;
  origin: string;
  userVerification: UserVerification;
  createdAt: number;
}

const challengeTtlMs = 5 * 60 * 1000;
const challengePruneIntervalMs = 30 * 1000;
const maxChallengesPerStore = 1024;
const registrationChallenges = new Map<string, ChallengeRecord>();
const authenticationChallenges = new Map<string, ChallengeRecord>();
const stepUpChallenges = new Map<string, ChallengeRecord>();
const lastChallengePrune = new WeakMap<Map<string, ChallengeRecord>, number>();

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

const authenticationOptionRateWindowMs = 60 * 1000;
const authenticationOptionRateLimit = 30;
const maxAuthenticationRateClients = 4096;
const authenticationOptionRate = new Map<string, RateLimitRecord>();

function normalizeHttpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * 只使用 Express 已按 trust proxy 规则解析出的协议和实际 Host。原始
 * X-Forwarded-* 头不能直接参与 WebAuthn RP ID 计算。
 */
function getTrustedRequestOrigin(req: Request): string | null {
  if (req.protocol !== "http" && req.protocol !== "https") return null;
  const host = req.get("host");
  if (!host || host.includes(",")) return null;
  return normalizeHttpOrigin(`${req.protocol}://${host}`);
}

function requireMatchingWebAuthnOrigin(
  req: Request,
  res: Response,
): string | null {
  const trustedOrigin = getTrustedRequestOrigin(req);
  const browserOrigin = normalizeHttpOrigin(req.get("origin") || "");
  if (!trustedOrigin || !browserOrigin) {
    res.status(400).json({
      error: "通行密钥请求缺少有效的站点来源",
      code: "WEBAUTHN_ORIGIN_REQUIRED",
    });
    return null;
  }
  if (trustedOrigin !== browserOrigin) {
    res.status(403).json({
      error: "通行密钥请求来源与当前面板地址不匹配",
      code: "WEBAUTHN_ORIGIN_MISMATCH",
    });
    return null;
  }

  const url = new URL(trustedOrigin);
  const localHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]");
  if (url.protocol !== "https:" && !localHttp) {
    res.status(400).json({
      error: "通行密钥要求使用 HTTPS（localhost 除外）",
      code: "WEBAUTHN_SECURE_CONTEXT_REQUIRED",
    });
    return null;
  }
  return trustedOrigin;
}

function getRpID(origin: string): string {
  return new URL(origin).hostname;
}

function pruneChallenges(
  map: Map<string, ChallengeRecord>,
  now = Date.now(),
): void {
  const lastPrunedAt = lastChallengePrune.get(map) ?? 0;
  if (now - lastPrunedAt < challengePruneIntervalMs) return;
  lastChallengePrune.set(map, now);
  for (const [id, record] of map) {
    if (now - record.createdAt > challengeTtlMs) {
      map.delete(id);
    }
  }
}

function putChallenge(
  map: Map<string, ChallengeRecord>,
  record: Omit<ChallengeRecord, "createdAt">,
): string {
  const now = Date.now();
  pruneChallenges(map, now);
  while (map.size >= maxChallengesPerStore) {
    const oldestId = map.keys().next().value as string | undefined;
    if (!oldestId) break;
    map.delete(oldestId);
  }
  const challengeId = nanoid();
  map.set(challengeId, { ...record, createdAt: now });
  return challengeId;
}

function takeChallenge(
  map: Map<string, ChallengeRecord>,
  challengeId: unknown,
): ChallengeRecord | null {
  if (typeof challengeId !== "string") return null;
  const record = map.get(challengeId);
  if (!record) return null;
  map.delete(challengeId);
  if (Date.now() - record.createdAt > challengeTtlMs) return null;
  return record;
}

/** 只有原用户、原会话才能消费二次验证挑战，避免跨会话抢占或重放。 */
function takeChallengeForSession(
  map: Map<string, ChallengeRecord>,
  challengeId: unknown,
  userId: string,
  sessionId: string,
): ChallengeRecord | null {
  if (typeof challengeId !== "string") return null;
  const record = map.get(challengeId);
  if (
    !record ||
    Date.now() - record.createdAt > challengeTtlMs ||
    record.userId !== userId ||
    record.sessionId !== sessionId
  ) {
    if (record && Date.now() - record.createdAt > challengeTtlMs) {
      map.delete(challengeId);
    }
    return null;
  }
  map.delete(challengeId);
  return record;
}

function requireInteractiveSession(
  req: Request,
  res: Response,
): AuthenticatedRequest | null {
  const authReq = req as AuthenticatedRequest;
  if (
    !authReq.userId ||
    !authReq.sessionId ||
    authReq.apiKeyId ||
    authReq.pendingTOTP
  ) {
    res.status(401).json({
      error: "通行密钥管理仅允许已登录的交互式会话",
      code: "INTERACTIVE_SESSION_REQUIRED",
    });
    return null;
  }
  return authReq;
}

function consumeAuthenticationOptionQuota(req: Request): number | null {
  const now = Date.now();
  const client = req.ip || req.socket.remoteAddress || "unknown";
  const current = authenticationOptionRate.get(client);
  if (!current || current.resetAt <= now) {
    if (
      !current &&
      authenticationOptionRate.size >= maxAuthenticationRateClients
    ) {
      const oldestClient = authenticationOptionRate.keys().next().value as
        | string
        | undefined;
      if (oldestClient) authenticationOptionRate.delete(oldestClient);
    }
    authenticationOptionRate.set(client, {
      count: 1,
      resetAt: now + authenticationOptionRateWindowMs,
    });
    return null;
  }
  if (current.count >= authenticationOptionRateLimit) {
    return Math.max(1, Math.ceil((current.resetAt - now) / 1000));
  }
  current.count += 1;
  return null;
}

function credentialManagementMethods(
  totpEnabled: boolean,
  credentials: WebauthnCredentialRecord[],
): Array<"totp" | "webauthn"> {
  return [
    ...(totpEnabled ? (["totp"] as const) : []),
    ...(credentials.length > 0 ? (["webauthn"] as const) : []),
  ];
}

/**
 * 已有 MFA 时必须近期完成二次验证；首次注册通行密钥时没有可用二次因素，
 * 仅允许刚完成主登录的交互式会话继续，避免形成无法注册第一把密钥的死锁。
 */
function requireCredentialManagementVerification(
  authReq: AuthenticatedRequest,
  res: Response,
  methods: Array<"totp" | "webauthn">,
): boolean {
  if (methods.length === 0) {
    if (hasRecentVerification(authReq.authVerifiedAt)) return true;
    res.status(401).json({
      error: "首次添加通行密钥需要近期登录，请重新登录后再试",
      code: "RECENT_LOGIN_REQUIRED",
    });
    return false;
  }
  if (hasRecentVerification(authReq.mfaVerifiedAt)) return true;
  res.status(401).json({
    error: "请使用 TOTP 身份验证器或通行密钥完成二次验证",
    code: "MFA_STEP_UP_REQUIRED",
    methods,
  });
  return false;
}

function toBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function fromBase64Url(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64url"));
}

function parseTransports(value: string | null): AuthenticatorTransportFuture[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getCredentialForVerification(
  credential: WebauthnCredentialRecord,
): WebAuthnCredential {
  return {
    id: credential.credentialId as Base64URLString,
    publicKey: fromBase64Url(
      credential.publicKey,
    ) as WebAuthnCredential["publicKey"],
    counter: credential.counter,
    transports: parseTransports(credential.transports),
  };
}

export function registerUserWebAuthnRoutes(
  router: Router,
  { authenticateJWT, authManager, isNativeAppRequest }: WebAuthnRoutesDeps,
): void {
  /**
   * @openapi
   * /users/webauthn/credentials:
   *   get:
   *     summary: List passkeys
   *     description: Lists the authenticated user's registered passkeys.
   *     tags:
   *       - WebAuthn
   *     responses:
   *       200:
   *         description: List of passkeys.
   *       401:
   *         description: Authentication required.
   */
  router.get("/webauthn/credentials", authenticateJWT, async (req, res) => {
    const authReq = requireInteractiveSession(req, res);
    if (!authReq) return;
    const userId = authReq.userId;

    const credentials =
      await createCurrentWebauthnCredentialRepository().listByUserId(userId);

    res.json({
      credentials: credentials.map((credential) => ({
        id: credential.id,
        name: credential.name,
        deviceType: credential.deviceType,
        backedUp: credential.backedUp,
        transports: parseTransports(credential.transports),
        userVerification: credential.userVerification,
        createdAt: credential.createdAt,
        lastUsedAt: credential.lastUsedAt,
      })),
    });
  });

  /**
   * @openapi
   * /users/webauthn/register/options:
   *   post:
   *     summary: Start passkey registration
   *     description: Generates WebAuthn registration options for the authenticated user.
   *     tags:
   *       - WebAuthn
   *     responses:
   *       200:
   *         description: Registration options and challenge id.
   *       401:
   *         description: Authentication required.
   *       404:
   *         description: User not found.
   */
  router.post(
    "/webauthn/register/options",
    authenticateJWT,
    async (req, res) => {
      const authReq = requireInteractiveSession(req, res);
      if (!authReq) return;
      const userId = authReq.userId;

      if (!authManager.getUserDataKey(userId)) {
        return res.status(401).json({
          error: "User data is locked. Log in again before adding a passkey.",
        });
      }

      const user = await createCurrentUserRepository().findById(userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const existing =
        await createCurrentWebauthnCredentialRepository().listByUserId(userId);
      const methods = credentialManagementMethods(!!user.totpEnabled, existing);
      if (!requireCredentialManagementVerification(authReq, res, methods)) {
        return;
      }

      const origin = requireMatchingWebAuthnOrigin(req, res);
      if (!origin) return;
      const rpID = getRpID(origin);
      // 通行密钥会作为登录凭据和敏感操作的二次验证，注册策略必须由
      // 服务端固定为用户验证，不能接受客户端降级为仅触摸安全密钥。
      const userVerification: UserVerification = "required";

      const options = await generateRegistrationOptions({
        rpName: "Termix",
        rpID,
        userID: Buffer.from(userId, "utf8"),
        userName: user.username,
        userDisplayName: user.username,
        attestationType: "none",
        excludeCredentials: existing.map((credential) => ({
          id: credential.credentialId as Base64URLString,
          transports: parseTransports(credential.transports),
        })),
        authenticatorSelection: {
          residentKey: "required",
          userVerification,
        },
      });

      const challengeId = putChallenge(registrationChallenges, {
        challenge: options.challenge,
        userId,
        sessionId: authReq.sessionId,
        rpID,
        origin,
        userVerification,
      });

      res.json({ options, challengeId });
    },
  );

  /**
   * @openapi
   * /users/webauthn/register/verify:
   *   post:
   *     summary: Finish passkey registration
   *     description: Verifies the WebAuthn registration response and stores the passkey.
   *     tags:
   *       - WebAuthn
   *     responses:
   *       200:
   *         description: Passkey registered.
   *       400:
   *         description: Registration failed or challenge expired.
   *       401:
   *         description: Authentication required.
   */
  router.post(
    "/webauthn/register/verify",
    authenticateJWT,
    async (req, res) => {
      const authReq = requireInteractiveSession(req, res);
      if (!authReq) return;
      const userId = authReq.userId;
      const origin = requireMatchingWebAuthnOrigin(req, res);
      if (!origin) return;

      const challenge = takeChallengeForSession(
        registrationChallenges,
        req.body?.challengeId,
        userId,
        authReq.sessionId!,
      );
      if (!challenge || challenge.origin !== origin) {
        return res
          .status(400)
          .json({ error: "Registration challenge expired" });
      }

      try {
        const verification = await verifyRegistrationResponse({
          response: req.body?.response as RegistrationResponseJSON,
          expectedChallenge: challenge.challenge,
          expectedOrigin: challenge.origin,
          expectedRPID: challenge.rpID,
          requireUserVerification: challenge.userVerification === "required",
        });

        if (
          !verification.verified ||
          verification.registrationInfo.userVerified !== true
        ) {
          return res.status(400).json({ error: "Passkey registration failed" });
        }

        const { credential, credentialDeviceType, credentialBackedUp } =
          verification.registrationInfo;
        const transports =
          (req.body?.response as RegistrationResponseJSON | undefined)?.response
            ?.transports ?? [];

        const name =
          typeof req.body?.name === "string" && req.body.name.trim()
            ? req.body.name.trim().slice(0, 80)
            : "Passkey";

        await createCurrentWebauthnCredentialRepository().create({
          id: nanoid(),
          userId,
          name,
          credentialId: credential.id,
          publicKey: toBase64Url(credential.publicKey),
          counter: credential.counter,
          deviceType: credentialDeviceType,
          backedUp: credentialBackedUp,
          transports: JSON.stringify(transports),
          userVerification: challenge.userVerification,
          createdAt: new Date().toISOString(),
        });

        res.json({ success: true });
      } catch (error) {
        authLogger.warn("WebAuthn registration failed", {
          operation: "webauthn_register_verify",
          userId,
          error: error instanceof Error ? error.message : "Unknown",
        });
        res.status(400).json({ error: "Passkey registration failed" });
      }
    },
  );

  /**
   * 为当前登录会话生成通行密钥二次验证挑战。
   * 敏感操作要求验证器执行用户验证（生物识别、PIN 或系统解锁）。
   */
  router.post(
    "/webauthn/step-up/options",
    authenticateJWT,
    async (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.userId;
      if (!authReq.sessionId || authReq.apiKeyId || authReq.pendingTOTP) {
        return res.status(401).json({
          error: "二次验证仅允许已登录的交互式会话",
          code: "INTERACTIVE_SESSION_REQUIRED",
        });
      }

      // 旧版本允许以 preferred 策略注册通行密钥。这里不能在发起认证前
      // 排除这些凭据；认证本身仍强制 userVerification=required，并且只有
      // 验证器确认了本地用户验证后才会提升会话及升级凭据记录。
      const credentials =
        await createCurrentWebauthnCredentialRepository().listByUserId(userId);
      if (!credentials.length) {
        return res.status(409).json({
          error: "当前账号未添加支持指纹、PIN 或设备解锁的通行密钥",
          code: "WEBAUTHN_NOT_ENROLLED",
        });
      }

      const origin = requireMatchingWebAuthnOrigin(req, res);
      if (!origin) return;
      const rpID = getRpID(origin);
      const options = await generateAuthenticationOptions({
        rpID,
        allowCredentials: credentials.map((credential) => ({
          id: credential.credentialId as Base64URLString,
          transports: parseTransports(credential.transports),
        })),
        userVerification: "required",
      });
      const challengeId = putChallenge(stepUpChallenges, {
        challenge: options.challenge,
        userId,
        sessionId: authReq.sessionId,
        rpID,
        origin,
        userVerification: "required",
      });

      return res.json({ options, challengeId });
    },
  );

  /**
   * 使用通行密钥提升当前会话的 MFA 状态，不创建额外登录会话。
   */
  router.post("/webauthn/step-up/verify", authenticateJWT, async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.userId;
    const sessionId = authReq.sessionId;
    if (!sessionId || authReq.apiKeyId || authReq.pendingTOTP) {
      return res.status(401).json({
        error: "二次验证仅允许已登录的交互式会话",
        code: "INTERACTIVE_SESSION_REQUIRED",
      });
    }

    const origin = requireMatchingWebAuthnOrigin(req, res);
    if (!origin) return;

    const challenge = takeChallengeForSession(
      stepUpChallenges,
      req.body?.challengeId,
      userId,
      sessionId,
    );
    if (!challenge || challenge.origin !== origin) {
      return res.status(400).json({
        error: "通行密钥验证请求已过期，请重试",
        code: "WEBAUTHN_CHALLENGE_EXPIRED",
      });
    }

    const response = req.body?.response as
      | AuthenticationResponseJSON
      | undefined;
    if (!response?.id) {
      return res.status(400).json({ error: "通行密钥响应无效" });
    }

    const credential =
      await createCurrentWebauthnCredentialRepository().findByCredentialId(
        response.id,
      );
    if (!credential || credential.userId !== userId) {
      return res.status(401).json({
        error: "未识别此通行密钥",
        code: "WEBAUTHN_CREDENTIAL_NOT_RECOGNIZED",
      });
    }

    try {
      const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: challenge.origin,
        expectedRPID: challenge.rpID,
        credential: getCredentialForVerification(credential),
        requireUserVerification: true,
        advancedFIDOConfig: { userVerification: "required" },
      });
      if (
        !verification.verified ||
        verification.authenticationInfo.userVerified !== true
      ) {
        return res.status(401).json({ error: "通行密钥验证失败" });
      }

      await createCurrentWebauthnCredentialRepository().updateAuthState(
        credential.id,
        {
          counter: verification.authenticationInfo.newCounter,
          backedUp: verification.authenticationInfo.credentialBackedUp,
          deviceType: verification.authenticationInfo.credentialDeviceType,
          lastUsedAt: new Date().toISOString(),
          userVerification: "required",
        },
      );

      const verifiedAt = Math.floor(Date.now() / 1000);
      const refreshed = await authManager.refreshSessionToken(
        userId,
        sessionId,
        { mfaVerifiedAt: verifiedAt },
      );
      if (!refreshed) {
        return res.status(401).json({
          error: "当前会话已失效，请重新登录",
          code: "SESSION_EXPIRED",
        });
      }

      res.cookie(
        "jwt",
        refreshed.token,
        authManager.getSecureCookieOptions(req, refreshed.maxAge),
      );
      authLogger.success("WebAuthn step-up verification successful", {
        operation: "webauthn_step_up_success",
        userId,
        sessionId,
        credentialId: credential.id,
      });
      return res.json({
        success: true,
        method: "webauthn",
        mfa_verified_at: verifiedAt,
        ...(isNativeAppRequest(req) ? { token: refreshed.token } : {}),
      });
    } catch (error) {
      authLogger.warn("WebAuthn step-up verification failed", {
        operation: "webauthn_step_up_verify",
        userId,
        sessionId,
        credentialId: credential.id,
        error: error instanceof Error ? error.message : "Unknown",
      });
      return res.status(401).json({ error: "通行密钥验证失败" });
    }
  });

  /**
   * @openapi
   * /users/webauthn/authenticate/options:
   *   post:
   *     summary: Start passkey login
   *     description: Generates WebAuthn authentication options, optionally scoped to a username.
   *     tags:
   *       - WebAuthn
   *     responses:
   *       200:
   *         description: Authentication options and challenge id.
   *       404:
   *         description: No passkeys found for the user.
   */
  router.post("/webauthn/authenticate/options", async (req, res) => {
    const retryAfter = consumeAuthenticationOptionQuota(req);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({
        error: "通行密钥登录请求过于频繁，请稍后重试",
        code: "WEBAUTHN_RATE_LIMITED",
      });
    }
    const origin = requireMatchingWebAuthnOrigin(req, res);
    if (!origin) return;
    const rpID = getRpID(origin);
    // 密码无关登录必须执行本地用户验证。该策略由服务端决定，忽略任何
    // 客户端传入的降级值，避免绕过 PIN、生物识别或设备解锁。
    const userVerification: UserVerification = "required";
    const username =
      typeof req.body?.username === "string" ? req.body.username.trim() : "";

    let userId: string | undefined;
    let allowCredentials:
      | { id: Base64URLString; transports?: AuthenticatorTransportFuture[] }[]
      | undefined;

    if (username) {
      const user = await createCurrentUserRepository().findByUsername(username);
      if (!user) {
        return res.status(404).json({ error: "No passkeys found" });
      }

      userId = user.id;
      const credentials =
        await createCurrentWebauthnCredentialRepository().listByUserId(userId);

      if (!credentials.length) {
        return res.status(404).json({ error: "No passkeys found" });
      }

      allowCredentials = credentials.map((credential) => ({
        id: credential.credentialId as Base64URLString,
        transports: parseTransports(credential.transports),
      }));
    }

    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials,
      userVerification,
    });

    const challengeId = putChallenge(authenticationChallenges, {
      challenge: options.challenge,
      userId,
      rpID,
      origin,
      userVerification,
    });

    res.json({ options, challengeId });
  });

  /**
   * @openapi
   * /users/webauthn/authenticate/verify:
   *   post:
   *     summary: Finish passkey login
   *     description: Verifies the WebAuthn assertion with local user verification and issues a session token.
   *     tags:
   *       - WebAuthn
   *     responses:
   *       200:
   *         description: Login succeeded.
   *       400:
   *         description: Challenge expired or invalid response.
   *       401:
   *         description: Passkey not recognized or authentication failed.
   */
  router.post("/webauthn/authenticate/verify", async (req, res) => {
    const origin = requireMatchingWebAuthnOrigin(req, res);
    if (!origin) return;
    const challenge = takeChallenge(
      authenticationChallenges,
      req.body?.challengeId,
    );
    if (!challenge || challenge.origin !== origin) {
      return res
        .status(400)
        .json({ error: "Authentication challenge expired" });
    }

    const response = req.body?.response as
      | AuthenticationResponseJSON
      | undefined;
    if (!response?.id) {
      return res.status(400).json({ error: "Invalid passkey response" });
    }

    const credential =
      await createCurrentWebauthnCredentialRepository().findByCredentialId(
        response.id,
      );

    if (!credential) {
      return res.status(401).json({ error: "Passkey not recognized" });
    }

    if (challenge.userId && challenge.userId !== credential.userId) {
      return res.status(401).json({ error: "Passkey not recognized" });
    }

    try {
      const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: challenge.origin,
        expectedRPID: challenge.rpID,
        credential: getCredentialForVerification(credential),
        requireUserVerification: challenge.userVerification === "required",
        advancedFIDOConfig: {
          userVerification: challenge.userVerification,
        },
      });

      if (
        !verification.verified ||
        verification.authenticationInfo.userVerified !== true
      ) {
        return res.status(401).json({ error: "Passkey authentication failed" });
      }

      const userRecord = await createCurrentUserRepository().findById(
        credential.userId,
      );
      if (!userRecord) {
        return res.status(404).json({ error: "User not found" });
      }

      const deviceInfo = parseUserAgent(req);
      const authenticated = await authManager.authenticateWebAuthnUser(
        userRecord.id,
        deviceInfo.type,
      );

      if (!authenticated) {
        return res.status(401).json({
          error:
            "Passkey cannot unlock this account. Log in with password and register the passkey again.",
        });
      }

      await createCurrentWebauthnCredentialRepository().updateAuthState(
        credential.id,
        {
          counter: verification.authenticationInfo.newCounter,
          backedUp: verification.authenticationInfo.credentialBackedUp,
          deviceType: verification.authenticationInfo.credentialDeviceType,
          lastUsedAt: new Date().toISOString(),
          userVerification: "required",
        },
      );

      const token = await authManager.generateJWTToken(userRecord.id, {
        rememberMe: !!req.body?.rememberMe,
        deviceType: deviceInfo.type,
        deviceInfo: deviceInfo.deviceInfo,
        mfaVerifiedAt: Math.floor(Date.now() / 1000),
      });

      const timeoutSetting = getCurrentSettingValue("session_timeout_hours");
      const timeoutHours = timeoutSetting
        ? parseInt(timeoutSetting, 10) || 24
        : 24;
      const maxAge = req.body?.rememberMe
        ? 30 * 24 * 60 * 60 * 1000
        : timeoutHours * 60 * 60 * 1000;

      res.cookie("jwt", token, authManager.getSecureCookieOptions(req, maxAge));
      res.json({
        success: true,
        is_admin: !!userRecord.isAdmin,
        username: userRecord.username,
        userId: userRecord.id,
        is_oidc: !!userRecord.isOidc,
        totp_enabled: !!userRecord.totpEnabled,
        ...(isNativeAppRequest(req) ? { token } : {}),
      });
    } catch (error) {
      authLogger.warn("WebAuthn authentication failed", {
        operation: "webauthn_auth_verify",
        credentialId: credential.id,
        userId: credential.userId,
        error: error instanceof Error ? error.message : "Unknown",
      });
      res.status(401).json({ error: "Passkey authentication failed" });
    }
  });

  /**
   * @openapi
   * /users/webauthn/credentials/{credentialId}:
   *   delete:
   *     summary: Delete a passkey
   *     description: Removes one of the authenticated user's passkeys.
   *     tags:
   *       - WebAuthn
   *     parameters:
   *       - in: path
   *         name: credentialId
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: Passkey deleted.
   *       401:
   *         description: Authentication required.
   */
  router.delete(
    "/webauthn/credentials/:credentialId",
    authenticateJWT,
    async (req, res) => {
      const authReq = requireInteractiveSession(req, res);
      if (!authReq) return;
      const userId = authReq.userId;
      const user = await createCurrentUserRepository().findById(userId);
      if (!user) return res.status(404).json({ error: "User not found" });
      const credentials =
        await createCurrentWebauthnCredentialRepository().listByUserId(userId);
      const methods = credentialManagementMethods(
        !!user.totpEnabled,
        credentials,
      );
      if (!requireCredentialManagementVerification(authReq, res, methods)) {
        return;
      }

      const credentialId = String(req.params.credentialId);

      await createCurrentWebauthnCredentialRepository().deleteForUser(
        userId,
        credentialId,
      );

      res.json({ success: true });
    },
  );
}
