import { describe, expect, it } from "vitest";
import { buildTerminalConnectionHostConfig } from "../../../features/terminal/terminal-connection-host-config";
import type { TerminalHostConfig } from "../../../features/terminal/terminal-types";

function createHostConfig(
  overrides: Partial<TerminalHostConfig> = {},
): TerminalHostConfig {
  return {
    id: 42,
    instanceId: "tab-42",
    ip: "192.0.2.42",
    port: 22,
    username: "tester",
    authType: "password",
    password: "old-password",
    key: "old-private-key",
    keyPassword: "old-passphrase",
    credentialId: 7,
    ...overrides,
  };
}

describe("buildTerminalConnectionHostConfig", () => {
  it("已保存主机不发送标签页中缓存的 SSH 凭据", () => {
    const hostConfig = createHostConfig();

    const result = buildTerminalConnectionHostConfig(hostConfig, false);

    expect(result).toEqual({
      id: 42,
      instanceId: "tab-42",
      ip: "192.0.2.42",
      port: 22,
      username: "tester",
      authType: "password",
      credentialId: 7,
    });
    expect(hostConfig).toMatchObject({
      password: "old-password",
      key: "old-private-key",
      keyPassword: "old-passphrase",
    });
  });

  it("快速连接保留本次输入的 SSH 凭据", () => {
    const hostConfig = createHostConfig();

    const result = buildTerminalConnectionHostConfig(hostConfig, true);

    expect(result).toBe(hostConfig);
    expect(result).toMatchObject({
      password: "old-password",
      key: "old-private-key",
      keyPassword: "old-passphrase",
    });
  });

  it("没有有效数字主机 ID 的临时连接保留 SSH 凭据", () => {
    const hostConfig = createHostConfig({ id: undefined });

    expect(buildTerminalConnectionHostConfig(hostConfig, false)).toBe(
      hostConfig,
    );
  });
});
