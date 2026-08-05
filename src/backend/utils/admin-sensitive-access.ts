import type { Response } from "express";
import type { AuthenticatedRequest } from "../../types/index.js";
import { isAdministrativeTransportAllowed } from "./trust-loopback-proxy.js";

const ADMIN_MFA_MAX_AGE_SECONDS = 5 * 60;
const ADMIN_MFA_CLOCK_SKEW_SECONDS = 30;

/**
 * 管理员读取用户明文或执行等价敏感操作时，必须使用近期完成 MFA 的网页会话。
 * API Key 和仍处于 MFA 登录流程中的临时令牌不能调用这些接口。
 */
export function requireRecentInteractiveMfa(
  req: AuthenticatedRequest,
  res: Response,
): boolean {
  if (req.apiKeyId || !req.sessionId || req.pendingTOTP) {
    res.status(401).json({
      error: "管理员敏感操作仅允许已完成验证的网页会话",
      code: "INTERACTIVE_SESSION_REQUIRED",
    });
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  if (
    !Number.isSafeInteger(req.mfaVerifiedAt) ||
    req.mfaVerifiedAt! > now + ADMIN_MFA_CLOCK_SKEW_SECONDS ||
    now - req.mfaVerifiedAt! > ADMIN_MFA_MAX_AGE_SECONDS
  ) {
    res.status(401).json({
      error: "请使用 TOTP 身份验证器或通行密钥完成二次验证",
      code: "MFA_STEP_UP_REQUIRED",
    });
    return false;
  }

  return true;
}

/**
 * 管理员读取明文凭据时同时强制安全传输和近期 MFA。
 */
export function requireSecureRecentInteractiveMfa(
  req: AuthenticatedRequest,
  res: Response,
): boolean {
  if (!isAdministrativeTransportAllowed(req)) {
    res.status(426).json({
      error: "管理员敏感操作必须使用 HTTPS",
      code: "HTTPS_REQUIRED",
    });
    return false;
  }
  return requireRecentInteractiveMfa(req, res);
}

export function hasRecentVerification(
  verifiedAt: number | undefined,
  now = Math.floor(Date.now() / 1000),
): boolean {
  return (
    Number.isSafeInteger(verifiedAt) &&
    verifiedAt! <= now + ADMIN_MFA_CLOCK_SKEW_SECONDS &&
    now - verifiedAt! <= ADMIN_MFA_MAX_AGE_SECONDS
  );
}

export const hasRecentMfaVerification = hasRecentVerification;
