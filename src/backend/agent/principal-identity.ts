const WEB_USER_PRINCIPAL_PREFIX = "web-user:";

/** 从网页终端内部主体或租约 holderId 中提取真实用户 ID。 */
export function webUserIdFromPrincipal(value: string): string | null {
  if (!value.startsWith(WEB_USER_PRINCIPAL_PREFIX)) return null;
  const remainder = value.slice(WEB_USER_PRINCIPAL_PREFIX.length);
  const separator = remainder.indexOf(":");
  if (separator <= 0) return null;
  const userId = remainder.slice(0, separator);
  return userId.length <= 128 ? userId : null;
}
