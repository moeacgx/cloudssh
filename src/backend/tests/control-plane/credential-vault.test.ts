import crypto from "crypto";
import { describe, expect, it } from "vitest";
import { PlatformCredentialVault } from "../../control-plane/credential-vault.js";

describe("CloudSSH 平台凭据库", () => {
  it("使用随机 AES-GCM 信封加密且密文不包含原始凭据", () => {
    const vault = new PlatformCredentialVault(crypto.randomBytes(32));
    const secret = {
      privateKey:
        "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----",
      passphrase: "correct horse battery staple",
    };

    const first = vault.encrypt("credential-1", "project-1", secret);
    const second = vault.encrypt("credential-1", "project-1", secret);

    expect(first).not.toBe(second);
    expect(first).not.toContain("private-material");
    expect(first).not.toContain(secret.passphrase);
    expect(vault.decrypt("credential-1", "project-1", first)).toEqual(secret);
  });

  it("拒绝跨项目、跨凭据和篡改后的密文", () => {
    const vault = new PlatformCredentialVault(crypto.randomBytes(32));
    const encrypted = vault.encrypt("credential-1", "project-1", {
      password: "not-logged-or-exported",
    });

    expect(() =>
      vault.decrypt("credential-1", "project-2", encrypted),
    ).toThrow();
    expect(() =>
      vault.decrypt("credential-2", "project-1", encrypted),
    ).toThrow();

    const envelope = JSON.parse(encrypted) as { ciphertext: string };
    const ciphertext = Buffer.from(envelope.ciphertext, "base64url");
    ciphertext[0] ^= 1;
    envelope.ciphertext = ciphertext.toString("base64url");
    expect(() =>
      vault.decrypt("credential-1", "project-1", JSON.stringify(envelope)),
    ).toThrow();
  });
});
