export function shouldDeletePinnedRecoveryRecord(
  probe: "found" | "missing" | "unknown",
): boolean {
  return probe === "missing";
}

export type SessionPinMode = "tmux" | "install_tmux" | "platform";

export type SessionPinModeValidation =
  | { ok: true; mode: SessionPinMode }
  | {
      ok: false;
      error: {
        type: "session_pin_error";
        code: "SESSION_PIN_MODE_REQUIRED";
        message: string;
      };
    };

export function validateSessionPinMode(
  value: unknown,
): SessionPinModeValidation {
  if (value === "tmux" || value === "install_tmux" || value === "platform") {
    return { ok: true, mode: value };
  }
  return {
    ok: false,
    error: {
      type: "session_pin_error",
      code: "SESSION_PIN_MODE_REQUIRED",
      message: "Choose platform keepalive or managed tmux first",
    },
  };
}

export function shouldBlockTerminalInputForPin(
  transitionActive: boolean,
  choicePending: boolean,
): boolean {
  return transitionActive || choicePending;
}

export function shouldDestroyUnconfirmedPinnedStartup(
  startupPending: boolean,
  pinOperationActive: boolean,
): boolean {
  return startupPending && !pinOperationActive;
}
