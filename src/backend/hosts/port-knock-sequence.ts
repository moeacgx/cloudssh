export interface PortKnockStep {
  port: number;
  protocol?: "tcp" | "udp";
  delay?: number;
}

/**
 * 将数据库 JSON、API 数组和旧版异常值统一转换为可执行的端口敲门序列。
 * 无效条目直接忽略，避免历史数据阻断正常 SSH 连接。
 */
export function normalizePortKnockSequence(value: unknown): PortKnockStep[] {
  let parsed = value;
  for (let depth = 0; depth < 2 && typeof parsed === "string"; depth += 1) {
    if (!parsed.trim()) return [];
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];

  return parsed.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];

    const raw = entry as Record<string, unknown>;
    const port =
      typeof raw.port === "number" ? raw.port : Number(String(raw.port ?? ""));
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return [];

    const rawProtocol =
      typeof raw.protocol === "string" ? raw.protocol.toLowerCase() : "";
    const protocol =
      rawProtocol === "tcp" || rawProtocol === "udp" ? rawProtocol : undefined;
    const rawDelay =
      typeof raw.delay === "number"
        ? raw.delay
        : raw.delay === undefined
          ? undefined
          : Number(String(raw.delay));
    const delay =
      rawDelay !== undefined && Number.isFinite(rawDelay) && rawDelay >= 0
        ? rawDelay
        : undefined;

    return [{ port, protocol, delay }];
  });
}

export function serializePortKnockSequence(value: unknown): string | null {
  const sequence = normalizePortKnockSequence(value);
  return sequence.length > 0 ? JSON.stringify(sequence) : null;
}
