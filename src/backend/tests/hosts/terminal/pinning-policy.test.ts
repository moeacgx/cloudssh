import { describe, expect, it } from "vitest";
import {
  shouldBlockTerminalInputForPin,
  shouldDeletePinnedRecoveryRecord,
  shouldDestroyUnconfirmedPinnedStartup,
  validateSessionPinMode,
} from "../../../hosts/terminal/pinning-policy.js";

describe("固定窗口恢复记录清理策略", () => {
  it("只有远端明确确认窗口不存在时才删除恢复记录", () => {
    expect(shouldDeletePinnedRecoveryRecord("missing")).toBe(true);
    expect(shouldDeletePinnedRecoveryRecord("found")).toBe(false);
    expect(shouldDeletePinnedRecoveryRecord("unknown")).toBe(false);
  });
});

describe("固定窗口模式校验", () => {
  it.each(["tmux", "install_tmux", "platform"] as const)(
    "接受受支持的 %s 模式",
    (mode) => {
      expect(validateSessionPinMode(mode)).toEqual({ ok: true, mode });
    },
  );

  it.each([undefined, null, "", "TMUX", "unknown", {}, []])(
    "拒绝缺失或未知模式且绝不默认使用 tmux",
    (mode) => {
      expect(validateSessionPinMode(mode)).toEqual({
        ok: false,
        error: {
          type: "session_pin_error",
          code: "SESSION_PIN_MODE_REQUIRED",
          message: "Choose platform keepalive or managed tmux first",
        },
      });
    },
  );

  it("模式选择和固定切换期间都阻止终端输入", () => {
    expect(shouldBlockTerminalInputForPin(false, false)).toBe(false);
    expect(shouldBlockTerminalInputForPin(true, false)).toBe(true);
    expect(shouldBlockTerminalInputForPin(false, true)).toBe(true);
    expect(shouldBlockTerminalInputForPin(true, true)).toBe(true);
  });

  it("只回收尚未确认模式且没有固定操作在执行的启动连接", () => {
    expect(shouldDestroyUnconfirmedPinnedStartup(false, false)).toBe(false);
    expect(shouldDestroyUnconfirmedPinnedStartup(false, true)).toBe(false);
    expect(shouldDestroyUnconfirmedPinnedStartup(true, true)).toBe(false);
    expect(shouldDestroyUnconfirmedPinnedStartup(true, false)).toBe(true);
  });
});
