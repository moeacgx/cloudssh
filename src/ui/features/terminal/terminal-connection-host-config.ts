import type { TerminalHostConfig } from "./terminal-types";

/**
 * 已保存主机由服务端按 ID 重新解析凭据，避免旧标签页覆盖刚更新的密码或密钥。
 */
export function buildTerminalConnectionHostConfig(
  hostConfig: TerminalHostConfig,
  isQuickConnect: boolean,
): TerminalHostConfig {
  const isSavedHost =
    !isQuickConnect &&
    Number.isSafeInteger(hostConfig.id) &&
    Number(hostConfig.id) > 0;

  if (!isSavedHost) return hostConfig;

  const resolvedByServer = { ...hostConfig };
  delete resolvedByServer.password;
  delete resolvedByServer.key;
  delete resolvedByServer.keyPassword;
  return resolvedByServer;
}
