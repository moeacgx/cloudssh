export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;

const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_USERNAMES = new Set(["anonymous", "system"]);

export type UsernameValidationResult =
  | { valid: true; username: string }
  | {
      valid: false;
      code:
        | "USERNAME_REQUIRED"
        | "USERNAME_LENGTH"
        | "USERNAME_FORMAT"
        | "USERNAME_RESERVED";
    };

/**
 * 规范化并验证登录用户名。仅允许可安全用于登录、审计和 URL 展示的 ASCII 字符。
 */
export function validateUsername(value: unknown): UsernameValidationResult {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { valid: false, code: "USERNAME_REQUIRED" };
  }

  const username = value.trim();
  if (
    username.length < USERNAME_MIN_LENGTH ||
    username.length > USERNAME_MAX_LENGTH
  ) {
    return { valid: false, code: "USERNAME_LENGTH" };
  }
  if (!USERNAME_PATTERN.test(username)) {
    return { valid: false, code: "USERNAME_FORMAT" };
  }
  if (RESERVED_USERNAMES.has(username.toLowerCase())) {
    return { valid: false, code: "USERNAME_RESERVED" };
  }

  return { valid: true, username };
}
