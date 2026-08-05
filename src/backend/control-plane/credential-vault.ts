import crypto from "crypto";
import { promises as fs } from "fs";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;

export type PlatformCredentialSecret = {
  password?: string;
  privateKey?: string;
  passphrase?: string;
  certificate?: string;
};

type Envelope = {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
};

function parseKey(value: string): Buffer {
  const trimmed = value.trim();
  const key = /^[0-9a-f]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error("CLOUDSSH_MASTER_KEY 必须是 32 字节的 hex 或 base64 密钥");
  }
  return key;
}

export async function loadPlatformMasterKey(): Promise<Buffer> {
  if (process.env.CLOUDSSH_MASTER_KEY_FILE) {
    return parseKey(
      await fs.readFile(process.env.CLOUDSSH_MASTER_KEY_FILE, "utf8"),
    );
  }
  if (process.env.CLOUDSSH_MASTER_KEY) {
    return parseKey(process.env.CLOUDSSH_MASTER_KEY);
  }
  throw new Error(
    "未配置 CLOUDSSH_MASTER_KEY_FILE 或 CLOUDSSH_MASTER_KEY；平台凭据库保持锁定",
  );
}

export class PlatformCredentialVault {
  constructor(private readonly masterKey: Buffer) {}

  encrypt(
    credentialId: string,
    projectId: string,
    secret: PlatformCredentialSecret,
  ): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, this.masterKey, iv);
    cipher.setAAD(Buffer.from(`${projectId}:${credentialId}`, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(secret), "utf8"),
      cipher.final(),
    ]);
    const envelope: Envelope = {
      version: 1,
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    };
    return JSON.stringify(envelope);
  }

  decrypt(
    credentialId: string,
    projectId: string,
    encrypted: string,
  ): PlatformCredentialSecret {
    const envelope = JSON.parse(encrypted) as Envelope;
    if (envelope.version !== 1) throw new Error("不支持的凭据密文版本");
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      this.masterKey,
      Buffer.from(envelope.iv, "base64url"),
    );
    decipher.setAAD(Buffer.from(`${projectId}:${credentialId}`, "utf8"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8")) as PlatformCredentialSecret;
  }
}
