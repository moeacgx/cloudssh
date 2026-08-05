import { describe, expect, it } from "vitest";
import {
  createTerminalRecoveryTargetFingerprint,
  matchesTerminalRecoveryTarget,
} from "../../../hosts/terminal/recovery-target.js";

describe("固定窗口恢复目标指纹", () => {
  it("规范化地址和首尾空白，但保持 SSH 用户名大小写敏感", () => {
    const canonical = createTerminalRecoveryTargetFingerprint({
      ip: "example.com",
      port: 22,
      username: "root",
    });

    expect(
      createTerminalRecoveryTargetFingerprint({
        ip: " [EXAMPLE.COM] ",
        port: 22,
        username: " root ",
      }),
    ).toBe(canonical);
    expect(
      createTerminalRecoveryTargetFingerprint({
        ip: "example.com",
        port: 22,
        username: "Root",
      }),
    ).not.toBe(canonical);
  });

  it("端口或目标变化时拒绝自动恢复，缺少旧指纹也不会放行", () => {
    const target = { ip: "2001:db8::1", port: 22, username: "deploy" };
    const fingerprint = createTerminalRecoveryTargetFingerprint(target);

    expect(matchesTerminalRecoveryTarget(fingerprint, target)).toBe(true);
    expect(
      matchesTerminalRecoveryTarget(fingerprint, { ...target, port: 2222 }),
    ).toBe(false);
    expect(matchesTerminalRecoveryTarget(null, target)).toBe(false);
  });

  it("拒绝空目标和越界端口", () => {
    expect(() =>
      createTerminalRecoveryTargetFingerprint({
        ip: "",
        port: 22,
        username: "root",
      }),
    ).toThrow("Invalid terminal recovery target");
    expect(() =>
      createTerminalRecoveryTargetFingerprint({
        ip: "host",
        port: 65_536,
        username: "root",
      }),
    ).toThrow("Invalid terminal recovery target");
  });
});
