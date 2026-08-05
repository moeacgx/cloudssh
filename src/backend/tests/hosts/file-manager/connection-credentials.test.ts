import { describe, expect, it } from "vitest";
import {
  applyFileManagerCredentialOverride,
  isSavedFileManagerHost,
} from "../../../hosts/file-manager/connection-credentials.js";

describe("文件管理器连接凭据", () => {
  it("只把有效正整数 ID 识别为已保存主机", () => {
    expect(isSavedFileManagerHost(42)).toBe(true);
    expect(isSavedFileManagerHost("42")).toBe(true);
    expect(isSavedFileManagerHost(-42)).toBe(false);
    expect(isSavedFileManagerHost(undefined)).toBe(false);
  });

  it("普通重连保留服务端最新凭据", () => {
    const result = applyFileManagerCredentialOverride(
      { authType: "password", password: "latest-password" },
      { authType: "password", password: "stale-browser-password" },
    );

    expect(result).toEqual({
      authType: "password",
      password: "latest-password",
    });
  });

  it("显式密码覆盖只影响当前一次认证", () => {
    const authoritative = {
      authType: "password",
      password: "latest-password",
      sudoPassword: "sudo-secret",
    };
    const overridden = applyFileManagerCredentialOverride(
      authoritative,
      { password: "temporary-password" },
      "password",
    );
    const nextAttempt = applyFileManagerCredentialOverride(authoritative, {
      password: "stale-browser-password",
    });

    expect(overridden).toEqual({
      authType: "password",
      password: "temporary-password",
      sudoPassword: "sudo-secret",
    });
    expect(nextAttempt.password).toBe("latest-password");
  });

  it("口令覆盖与服务端最新私钥合并", () => {
    const result = applyFileManagerCredentialOverride(
      {
        authType: "key",
        sshKey: "latest-private-key",
        keyPassword: "old-passphrase",
      },
      { keyPassword: "new-passphrase", sshKey: "stale-private-key" },
      "passphrase",
    );

    expect(result).toEqual({
      authType: "key",
      sshKey: "latest-private-key",
      keyPassword: "new-passphrase",
    });
  });

  it("拒绝不完整的显式覆盖", () => {
    expect(() =>
      applyFileManagerCredentialOverride({}, {}, "password"),
    ).toThrow("missing a password");
    expect(() => applyFileManagerCredentialOverride({}, {}, "key")).toThrow(
      "missing a private key",
    );
    expect(() =>
      applyFileManagerCredentialOverride(
        {},
        { keyPassword: "secret" },
        "passphrase",
      ),
    ).toThrow("Saved SSH key is unavailable");
    expect(() =>
      applyFileManagerCredentialOverride({}, {}, "unsupported"),
    ).toThrow("Unsupported credential override mode");
  });
});
