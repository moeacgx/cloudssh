import { authApi, handleApiError } from "@/main-axios";

export type MfaStepUpMethod = "totp" | "webauthn";

export function getMfaStepUpMethods(error: unknown): MfaStepUpMethod[] | null {
  const value = error as {
    code?: unknown;
    details?: { code?: unknown; methods?: unknown };
  };
  const code =
    typeof value.code === "string"
      ? value.code
      : typeof value.details?.code === "string"
        ? value.details.code
        : undefined;
  if (code !== "MFA_STEP_UP_REQUIRED") return null;

  const methods = Array.isArray(value.details?.methods)
    ? value.details.methods.filter(
        (method): method is MfaStepUpMethod =>
          method === "totp" || method === "webauthn",
      )
    : [];
  // 兼容尚未返回 methods 的旧服务端；不可用的方法会返回明确的未配置原因。
  return methods.length > 0 ? [...new Set(methods)] : ["webauthn", "totp"];
}

export type MfaStepUpResponse = {
  success: boolean;
  method: MfaStepUpMethod;
  mfa_verified_at?: number;
  token?: string;
};

/** 使用当前登录会话中的身份验证器验证码完成二次验证。 */
export async function verifyTotpStepUp(
  totpCode: string,
): Promise<MfaStepUpResponse> {
  try {
    const response = await authApi.post<MfaStepUpResponse>(
      "/users/totp/step-up",
      { totp_code: totpCode },
    );
    if (response.data.token) {
      localStorage.setItem("jwt", response.data.token);
    }
    return response.data;
  } catch (error) {
    throw handleApiError(error, "verify TOTP step-up", {
      preserveAuthErrorMessage: true,
      preserveResponseMessage: true,
    });
  }
}

// 与通行密钥 API 保持同样的命名风格，供 MFA 弹窗和后续调用方复用。
export const stepUpWithTotp = verifyTotpStepUp;
