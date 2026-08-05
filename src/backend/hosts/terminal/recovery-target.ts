import { createHash } from "crypto";

export interface TerminalRecoveryTarget {
  ip: string;
  port: number;
  username: string;
}

export function createTerminalRecoveryTargetFingerprint(
  target: TerminalRecoveryTarget,
): string {
  const address = target.ip
    .trim()
    .toLowerCase()
    .replace(/^\[([^\]]+)\]$/, "$1");
  const username = target.username.trim();
  if (
    !address ||
    !username ||
    !Number.isSafeInteger(target.port) ||
    target.port < 1 ||
    target.port > 65_535
  ) {
    throw new Error("Invalid terminal recovery target");
  }

  const canonicalTarget = JSON.stringify([address, target.port, username]);
  return `sha256:${createHash("sha256").update(canonicalTarget).digest("hex")}`;
}

export function matchesTerminalRecoveryTarget(
  expectedFingerprint: string | null | undefined,
  target: TerminalRecoveryTarget,
): boolean {
  if (!expectedFingerprint) return false;
  return (
    expectedFingerprint === createTerminalRecoveryTargetFingerprint(target)
  );
}
