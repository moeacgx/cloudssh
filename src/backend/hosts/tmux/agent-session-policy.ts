import { getCurrentRepositorySqlite } from "../../database/repositories/factory.js";

const AGENT_TMUX_FALLBACK_PATTERN = /^cloudssh-(?!web-)[a-z0-9-]{8,120}$/i;

/** 普通终端路径不得复用带有 Agent 来源标识的本地观察会话。 */
export function isAgentControlledTerminalSession(
  session: { agentSessionId?: string | null } | null | undefined,
): boolean {
  return Boolean(session?.agentSessionId);
}

/**
 * 判断远端 tmux 名称是否由 Agent 持续会话保留。
 *
 * Agent 的 tmux 名称虽然不在 API 中直接返回，但当前命名规则可由会话 ID
 * 推导，因此不能把“隐藏名称”当作授权边界。所有普通 tmux 入口都必须再按
 * 数据库归属拦截，只有 attachAgentSession 可以附着这些窗口。
 */
export function isAgentManagedTmuxSession(
  tmuxName: string,
  _hostId?: number,
): boolean {
  if (!tmuxName || tmuxName.length > 160) return false;
  try {
    // persistent_sessions.tmux_name 具有全局唯一索引。按名称全局保护，
    // 可覆盖“同一物理服务器以不同 hostId 重复录入”的情况；若仍按
    // hostId 过滤，普通终端可能借另一条资产记录绕过 Agent 专用入口。
    const row = getCurrentRepositorySqlite()
      .prepare(
        `SELECT 1
           FROM persistent_sessions session
          WHERE session.tmux_name = ?
            AND session.service_account_id IS NOT NULL
          LIMIT 1`,
      )
      .get(tmuxName);
    return Boolean(row);
  } catch {
    // 数据库暂时不可用时，对 Agent 保留前缀按失败关闭处理；网页固定窗口
    // 使用 cloudssh-web-*，不会被这个回退规则误拦截。
    return AGENT_TMUX_FALLBACK_PATTERN.test(tmuxName);
  }
}

export function hideAgentManagedTmuxSessions<T extends { name: string }>(
  sessions: readonly T[],
  hostId?: number,
): T[] {
  return sessions.filter(
    (session) => !isAgentManagedTmuxSession(session.name, hostId),
  );
}
