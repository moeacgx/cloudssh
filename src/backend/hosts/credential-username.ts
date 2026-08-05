/**
 * Decides which username to use when a host is backed by a saved credential.
 *
 * An explicitly-set host username always wins - if the user typed a username on
 * the host it should be honoured even when a credential is attached. The
 * credential's username is only used as a fallback when the host has none. The
 * `overrideCredentialUsername` flag forces the host username regardless.
 */
export function pickResolvedUsername(
  hostUsername: unknown,
  credentialUsername: unknown,
  overrideCredentialUsername?: unknown,
): string | undefined {
  const host = isNonEmptyString(hostUsername) ? hostUsername : undefined;
  const cred = isNonEmptyString(credentialUsername)
    ? credentialUsername
    : undefined;

  if (overrideCredentialUsername) return host;
  if (host) return host;
  return cred;
}

/**
 * 解析已保存主机关联的凭据密码。密码型凭据是权威来源，更新后不能再被
 * 主机记录中遗留的旧密码覆盖；私钥型凭据仍允许使用主机专属密码回退。
 */
export function pickResolvedPassword(
  hostPassword: unknown,
  credentialPassword: unknown,
  credentialAuthType: unknown,
  credentialKey: unknown,
): string | undefined {
  const credential = isNonEmptyString(credentialPassword)
    ? credentialPassword
    : undefined;
  const host = isNonEmptyString(hostPassword) ? hostPassword : undefined;

  if (credentialAuthType === "password") return credential;
  if (credentialAuthType === "key" || isNonEmptyString(credentialKey)) {
    return host ?? credential;
  }
  return credential ?? host;
}

/**
 * Expands the `$oidc.preferred_username` placeholder in an SSH username to the
 * connecting user's OIDC identifier. Returns the username unchanged if it does
 * not contain the placeholder or the user has no OIDC identifier.
 */
export async function expandOidcUsername(
  username: string | undefined,
  userId: string,
): Promise<string | undefined> {
  if (!username || !username.includes("$oidc.preferred_username")) {
    return username;
  }

  try {
    const { createCurrentUserRepository } =
      await import("../database/repositories/factory.js");
    const user = await createCurrentUserRepository().findById(userId);
    const oidcIdentifier = user?.oidcIdentifier;
    if (!oidcIdentifier) return username;

    return username.replace(/\$oidc\.preferred_username/g, oidcIdentifier);
  } catch {
    return username;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
