import { AgentApiError } from "./errors.js";

export interface OutputCursor {
  sessionId: string;
  generation: number;
  sequence: number;
}

export function encodeCursor(cursor: OutputCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(value: string, sessionId: string): OutputCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<OutputCursor>;
    if (
      parsed.sessionId !== sessionId ||
      !Number.isSafeInteger(parsed.generation) ||
      !Number.isSafeInteger(parsed.sequence) ||
      Number(parsed.generation) < 1 ||
      Number(parsed.sequence) < 0
    ) {
      throw new Error("invalid cursor payload");
    }
    return parsed as OutputCursor;
  } catch {
    throw new AgentApiError(400, "INVALID_CURSOR", "输出游标无效");
  }
}
