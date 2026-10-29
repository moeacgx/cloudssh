export type HostId = number | string | null | undefined;

export function getPersistedHostId(hostId: HostId): string | null {
  const value = String(hostId ?? "");
  // 快速连接使用临时字符串 ID，不属于已保存的主机。
  return /^\d+$/.test(value) &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) > 0
    ? value
    : null;
}

export function formatHostLabel(name: string, hostId: HostId): string {
  const id = getPersistedHostId(hostId);
  return id ? `${name} · #${id}` : name;
}
