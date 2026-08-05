export type FileManagerCredentialOverrideMode =
  | "password"
  | "key"
  | "passphrase";

export interface FileManagerConnectionCredentials {
  password?: string;
  sshKey?: string;
  keyPassword?: string;
  authType?: string;
  sudoPassword?: string;
}

export function isSavedFileManagerHost(hostId: unknown): boolean {
  const numericHostId = Number(hostId);
  return Number.isSafeInteger(numericHostId) && numericHostId > 0;
}

/**
 * 浏览器中的已保存主机凭据可能已经过期。只有认证弹窗显式标记的单次
 * 覆盖可以替换服务端刚解析出的凭据，普通重连始终使用最新保存值。
 */
export function applyFileManagerCredentialOverride(
  authoritative: Readonly<FileManagerConnectionCredentials>,
  provided: Readonly<FileManagerConnectionCredentials>,
  mode?: unknown,
): FileManagerConnectionCredentials {
  if (!mode) return { ...authoritative };

  if (mode === "password") {
    if (typeof provided.password !== "string") {
      throw new Error("Password override is missing a password");
    }
    return {
      authType: "password",
      password: provided.password,
      sudoPassword: authoritative.sudoPassword,
    };
  }

  if (mode === "key") {
    if (typeof provided.sshKey !== "string" || !provided.sshKey.trim()) {
      throw new Error("Key override is missing a private key");
    }
    return {
      authType: "key",
      sshKey: provided.sshKey,
      keyPassword: provided.keyPassword,
      sudoPassword: authoritative.sudoPassword,
    };
  }

  if (mode !== "passphrase") {
    throw new Error("Unsupported credential override mode");
  }
  if (!authoritative.sshKey) {
    throw new Error("Saved SSH key is unavailable for passphrase override");
  }
  if (typeof provided.keyPassword !== "string") {
    throw new Error("Passphrase override is missing a passphrase");
  }
  return {
    ...authoritative,
    keyPassword: provided.keyPassword,
  };
}
