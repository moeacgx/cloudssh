import { describe, expect, it } from "vitest";
import {
  isValidDockerSessionId,
  pendingTOTPSessions,
  sshSessions,
} from "../../hosts/docker/session-manager.js";

describe("Docker 会话隔离", () => {
  it("只接受受限格式并拒绝原型保留键", () => {
    expect(isValidDockerSessionId("docker:42:session-1")).toBe(true);
    for (const value of [
      "",
      "../session",
      "__proto__",
      "prototype",
      "constructor",
      "x".repeat(129),
    ]) {
      expect(isValidDockerSessionId(value)).toBe(false);
    }
  });

  it("会话存储不继承对象原型", () => {
    expect(Object.getPrototypeOf(sshSessions)).toBeNull();
    expect(Object.getPrototypeOf(pendingTOTPSessions)).toBeNull();
  });
});
