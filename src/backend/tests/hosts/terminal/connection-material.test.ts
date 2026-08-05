import { describe, expect, it } from "vitest";
import {
  resolveTerminalConnectionMaterial,
  type TerminalConnectionMaterialSource,
} from "../../../hosts/terminal/connection-material.js";

function createClientHost(): TerminalConnectionMaterialSource {
  return {
    ip: "old.example.com",
    port: 2222,
    username: "old-user",
    authType: "password",
    password: "old-password",
    certPublicKey: "old-certificate",
    useSocks5: true,
    socks5Host: "old-proxy",
    jumpHosts: [{ hostId: 1 }],
    terminalConfig: { keepaliveInterval: 5 },
  };
}

function createAuthoritativeHost(): TerminalConnectionMaterialSource {
  return {
    ip: "[NEW.EXAMPLE.COM]",
    port: 22,
    username: "new-user",
    authType: "password",
    password: "new-password",
    useSocks5: false,
    jumpHosts: [{ hostId: 2 }],
    terminalConfig: { keepaliveInterval: 30 },
    enableSessionLogging: true,
  };
}

describe("终端连接材料解析", () => {
  it("服务端权威主机完全覆盖客户端的旧目标、密码和运行参数", () => {
    const material = resolveTerminalConnectionMaterial({
      connectionMode: "saved-host",
      clientHost: createClientHost(),
      authoritativeHost: createAuthoritativeHost(),
    });

    expect(material.target).toEqual({ ip: "NEW.EXAMPLE.COM", port: 22 });
    expect(material.auth).toMatchObject({
      username: "new-user",
      authType: "password",
      password: "new-password",
    });
    expect(material.auth.certPublicKey).toBeUndefined();
    expect(material.runtime).toMatchObject({
      useSocks5: false,
      jumpHosts: [{ hostId: 2 }],
      terminalConfig: { keepaliveInterval: 30 },
      enableSessionLogging: true,
    });
    expect(material.runtime.socks5Host).toBeUndefined();
  });

  it("严格解析数据库文本形式的键盘交互开关", () => {
    const disabled = resolveTerminalConnectionMaterial({
      connectionMode: "saved-host",
      clientHost: createClientHost(),
      authoritativeHost: {
        ...createAuthoritativeHost(),
        forceKeyboardInteractive: "false",
      },
    });
    const enabled = resolveTerminalConnectionMaterial({
      connectionMode: "saved-host",
      clientHost: createClientHost(),
      authoritativeHost: {
        ...createAuthoritativeHost(),
        forceKeyboardInteractive: "true",
      },
    });

    expect(disabled.auth.forceKeyboardInteractive).toBe(false);
    expect(enabled.auth.forceKeyboardInteractive).toBe(true);
    expect(disabled.auth.password).toBe("new-password");
  });

  it("连续解析没有状态残留，交互密码只覆盖当前一次", () => {
    const clientHost = createClientHost();
    const authoritativeHost = createAuthoritativeHost();

    const overridden = resolveTerminalConnectionMaterial({
      connectionMode: "saved-host",
      clientHost,
      authoritativeHost,
      credentialOverride: {
        kind: "password",
        password: "temporary-password",
      },
    });
    const nextAttempt = resolveTerminalConnectionMaterial({
      connectionMode: "saved-host",
      clientHost,
      authoritativeHost,
    });

    expect(overridden.auth.password).toBe("temporary-password");
    expect(nextAttempt.auth.password).toBe("new-password");
    expect(authoritativeHost.password).toBe("new-password");
  });

  it("交互私钥覆盖会清除密码和服务端证书", () => {
    const material = resolveTerminalConnectionMaterial({
      connectionMode: "saved-host",
      clientHost: createClientHost(),
      authoritativeHost: {
        ...createAuthoritativeHost(),
        certPublicKey: "server-certificate",
      },
      credentialOverride: {
        kind: "key",
        key: "temporary-private-key",
        keyPassword: "temporary-passphrase",
        keyType: "ed25519",
      },
    });

    expect(material.auth).toMatchObject({
      username: "new-user",
      authType: "key",
      key: "temporary-private-key",
      keyPassword: "temporary-passphrase",
      keyType: "ed25519",
    });
    expect(material.auth.password).toBeUndefined();
    expect(material.auth.certPublicKey).toBeUndefined();
  });

  it("仅覆盖口令时与服务端最新私钥合并，不采用客户端旧私钥", () => {
    const material = resolveTerminalConnectionMaterial({
      connectionMode: "saved-host",
      clientHost: {
        ...createClientHost(),
        authType: "key",
        key: "old-client-key",
      },
      authoritativeHost: {
        ...createAuthoritativeHost(),
        authType: "key",
        password: undefined,
        key: "latest-server-key",
        keyPassword: undefined,
        certPublicKey: "latest-server-certificate",
      },
      credentialOverride: {
        kind: "passphrase",
        keyPassword: "interactive-passphrase",
      },
    });

    expect(material.auth).toMatchObject({
      authType: "key",
      key: "latest-server-key",
      keyPassword: "interactive-passphrase",
      certPublicKey: "latest-server-certificate",
    });
  });

  it("没有权威主机时保留快速连接的内联目标和凭据", () => {
    const quickConnect = createClientHost();
    const material = resolveTerminalConnectionMaterial({
      connectionMode: "quick-connect",
      clientHost: quickConnect,
    });

    expect(material.target).toEqual({
      ip: "old.example.com",
      port: 2222,
    });
    expect(material.auth).toMatchObject({
      username: "old-user",
      authType: "password",
      password: "old-password",
      certPublicKey: "old-certificate",
    });
    expect(material.runtime.socks5Host).toBe("old-proxy");
  });

  it("将数据库中的 JSON 文本端口敲门配置转换为数组", () => {
    const material = resolveTerminalConnectionMaterial({
      connectionMode: "saved-host",
      clientHost: createClientHost(),
      authoritativeHost: {
        ...createAuthoritativeHost(),
        portKnockSequence: '[{"port":4000,"protocol":"udp","delay":150}]',
      },
    });

    expect(material.runtime.portKnockSequence).toEqual([
      { port: 4000, protocol: "udp", delay: 150 },
    ]);
  });

  it("忽略旧版异常端口敲门值而不阻断 SSH 连接", () => {
    for (const portKnockSequence of [
      null,
      "not-json",
      { port: 4000 },
    ] as unknown[]) {
      expect(() =>
        resolveTerminalConnectionMaterial({
          connectionMode: "quick-connect",
          clientHost: {
            ...createClientHost(),
            portKnockSequence,
          } as TerminalConnectionMaterialSource,
        }),
      ).not.toThrow();
    }
  });

  it("已保存主机缺少服务端权威数据时拒绝退回客户端旧凭据", () => {
    expect(() =>
      resolveTerminalConnectionMaterial({
        connectionMode: "saved-host",
        clientHost: createClientHost(),
        authoritativeHost: null,
      }),
    ).toThrow("Authoritative host data is required");
  });
});
