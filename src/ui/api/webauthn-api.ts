import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import { authApi, handleApiError, type AuthResponse } from "@/main-axios";

export type WebAuthnUserVerification = "discouraged" | "preferred" | "required";

export type WebAuthnClientErrorCode =
  | "WEBAUTHN_SECURE_CONTEXT_REQUIRED"
  | "WEBAUTHN_UNSUPPORTED"
  | "WEBAUTHN_CANCELED_OR_UNAVAILABLE"
  | "WEBAUTHN_SITE_MISMATCH"
  | "WEBAUTHN_USER_VERIFICATION_UNAVAILABLE"
  | "WEBAUTHN_ALREADY_REGISTERED";

export type WebAuthnErrorTranslationKey =
  | "auth.passkeySecureContextRequired"
  | "auth.passkeyUnsupported"
  | "auth.passkeyCanceledOrUnavailable"
  | "auth.passkeySiteMismatch"
  | "auth.passkeyUserVerificationUnavailable"
  | "auth.passkeyAlreadyRegistered";

class WebAuthnClientError extends Error {
  constructor(
    message: string,
    public code: WebAuthnClientErrorCode,
  ) {
    super(message);
    this.name = "WebAuthnClientError";
  }
}

const CLIENT_ERROR_TRANSLATIONS: Record<
  WebAuthnClientErrorCode,
  WebAuthnErrorTranslationKey
> = {
  WEBAUTHN_SECURE_CONTEXT_REQUIRED: "auth.passkeySecureContextRequired",
  WEBAUTHN_UNSUPPORTED: "auth.passkeyUnsupported",
  WEBAUTHN_CANCELED_OR_UNAVAILABLE: "auth.passkeyCanceledOrUnavailable",
  WEBAUTHN_SITE_MISMATCH: "auth.passkeySiteMismatch",
  WEBAUTHN_USER_VERIFICATION_UNAVAILABLE:
    "auth.passkeyUserVerificationUnavailable",
  WEBAUTHN_ALREADY_REGISTERED: "auth.passkeyAlreadyRegistered",
};

function isWebAuthnClientErrorCode(
  value: unknown,
): value is WebAuthnClientErrorCode {
  return typeof value === "string" && value in CLIENT_ERROR_TRANSLATIONS;
}

export function getWebAuthnErrorTranslationKey(
  error: unknown,
): WebAuthnErrorTranslationKey | null {
  const code = (error as { code?: unknown })?.code;
  return isWebAuthnClientErrorCode(code)
    ? CLIENT_ERROR_TRANSLATIONS[code]
    : null;
}

function assertWebAuthnAvailable(): void {
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    throw new WebAuthnClientError(
      "WebAuthn requires a secure context",
      "WEBAUTHN_SECURE_CONTEXT_REQUIRED",
    );
  }
  if (!browserSupportsWebAuthn()) {
    throw new WebAuthnClientError(
      "WebAuthn is not supported by this browser",
      "WEBAUTHN_UNSUPPORTED",
    );
  }
}

function normalizeWebAuthnBrowserError(
  error: unknown,
): WebAuthnClientError | null {
  if (error instanceof WebAuthnClientError) return error;

  const value = error as { code?: unknown; name?: unknown };
  const code = typeof value?.code === "string" ? value.code : "";
  const name = typeof value?.name === "string" ? value.name : "";

  if (
    code === "ERROR_CEREMONY_ABORTED" ||
    code === "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY" ||
    name === "NotAllowedError" ||
    name === "AbortError"
  ) {
    return new WebAuthnClientError(
      "No available passkey was selected",
      "WEBAUTHN_CANCELED_OR_UNAVAILABLE",
    );
  }
  if (
    code === "ERROR_INVALID_DOMAIN" ||
    code === "ERROR_INVALID_RP_ID" ||
    name === "SecurityError"
  ) {
    return new WebAuthnClientError(
      "The passkey does not match this site",
      "WEBAUTHN_SITE_MISMATCH",
    );
  }
  if (
    code === "ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT" ||
    code === "ERROR_AUTO_REGISTER_USER_VERIFICATION_FAILURE" ||
    name === "ConstraintError"
  ) {
    return new WebAuthnClientError(
      "The authenticator cannot complete user verification",
      "WEBAUTHN_USER_VERIFICATION_UNAVAILABLE",
    );
  }
  if (
    code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" ||
    name === "InvalidStateError"
  ) {
    return new WebAuthnClientError(
      "The passkey is already registered",
      "WEBAUTHN_ALREADY_REGISTERED",
    );
  }
  if (
    code === "ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT" ||
    code === "ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG" ||
    code === "ERROR_AUTHENTICATOR_GENERAL_ERROR" ||
    name === "NotSupportedError"
  ) {
    return new WebAuthnClientError(
      "The browser or authenticator does not support this passkey operation",
      "WEBAUTHN_UNSUPPORTED",
    );
  }

  return null;
}

function throwWebAuthnError(error: unknown, operation: string): never {
  const clientError = normalizeWebAuthnBrowserError(error);
  if (clientError) throw clientError;
  throw handleApiError(error, operation, {
    preserveAuthErrorMessage: true,
    preserveResponseMessage: true,
  });
}

export type WebAuthnCredentialSummary = {
  id: string;
  name: string;
  deviceType?: string | null;
  backedUp: boolean;
  transports: string[];
  userVerification: WebAuthnUserVerification;
  createdAt: string;
  lastUsedAt?: string | null;
};

type RegistrationOptionsResponse = {
  options: PublicKeyCredentialCreationOptionsJSON;
  challengeId: string;
};

type AuthenticationOptionsResponse = {
  options: PublicKeyCredentialRequestOptionsJSON;
  challengeId: string;
};

export type WebAuthnStepUpResponse = {
  success: boolean;
  method: "webauthn";
  mfa_verified_at?: number;
  token?: string;
};

export async function listWebAuthnCredentials(): Promise<{
  credentials: WebAuthnCredentialSummary[];
}> {
  try {
    const response = await authApi.get("/users/webauthn/credentials");
    return response.data;
  } catch (error) {
    throw handleApiError(error, "list passkeys", {
      preserveResponseMessage: true,
    });
  }
}

export async function registerWebAuthnCredential(
  name: string,
): Promise<{ success: boolean }> {
  try {
    assertWebAuthnAvailable();
    const optionsResponse = await authApi.post<RegistrationOptionsResponse>(
      "/users/webauthn/register/options",
      { userVerification: "required" },
    );
    const credential = await startRegistration({
      optionsJSON: optionsResponse.data.options,
    });
    const verifyResponse = await authApi.post(
      "/users/webauthn/register/verify",
      {
        challengeId: optionsResponse.data.challengeId,
        name,
        response: credential as RegistrationResponseJSON,
      },
    );
    return verifyResponse.data;
  } catch (error) {
    throwWebAuthnError(error, "register passkey");
  }
}

export async function authenticateWithWebAuthn(
  username: string,
  rememberMe: boolean,
): Promise<AuthResponse> {
  try {
    assertWebAuthnAvailable();
    const optionsResponse = await authApi.post<AuthenticationOptionsResponse>(
      "/users/webauthn/authenticate/options",
      {
        username: username.trim() || undefined,
        userVerification: "required",
      },
    );
    const credential = await startAuthentication({
      optionsJSON: optionsResponse.data.options,
    });
    const verifyResponse = await authApi.post<AuthResponse>(
      "/users/webauthn/authenticate/verify",
      {
        challengeId: optionsResponse.data.challengeId,
        rememberMe,
        response: credential as AuthenticationResponseJSON,
      },
    );

    if (verifyResponse.data.token) {
      localStorage.setItem("jwt", verifyResponse.data.token);
    }

    return verifyResponse.data;
  } catch (error) {
    throwWebAuthnError(error, "authenticate with passkey");
  }
}

/** 使用已登录会话中的通行密钥完成敏感操作二次验证。 */
export async function authenticateWithWebAuthnStepUp(): Promise<WebAuthnStepUpResponse> {
  try {
    assertWebAuthnAvailable();
    const optionsResponse = await authApi.post<AuthenticationOptionsResponse>(
      "/users/webauthn/step-up/options",
      { userVerification: "required" },
    );
    const credential = await startAuthentication({
      optionsJSON: optionsResponse.data.options,
    });
    const verifyResponse = await authApi.post(
      "/users/webauthn/step-up/verify",
      {
        challengeId: optionsResponse.data.challengeId,
        response: credential as AuthenticationResponseJSON,
      },
    );
    if (verifyResponse.data.token) {
      localStorage.setItem("jwt", verifyResponse.data.token);
    }
    return verifyResponse.data;
  } catch (error) {
    throwWebAuthnError(error, "verify passkey step-up");
  }
}

// 兼容 MFA 弹窗及外部调用方的语义化别名。
export const stepUpWithWebAuthn = authenticateWithWebAuthnStepUp;

export async function deleteWebAuthnCredential(
  credentialId: string,
): Promise<{ success: boolean }> {
  try {
    const response = await authApi.delete(
      `/users/webauthn/credentials/${credentialId}`,
    );
    return response.data;
  } catch (error) {
    throw handleApiError(error, "delete passkey", {
      preserveResponseMessage: true,
    });
  }
}
