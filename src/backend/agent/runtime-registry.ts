import type { AgentSessionBroker } from "./broker.js";

let activeSessionBroker: AgentSessionBroker | null = null;

/** 注册当前进程正在工作的 Agent Broker，供受信任的网页终端入口复用租约。 */
export function registerAgentSessionBroker(broker: AgentSessionBroker): void {
  activeSessionBroker = broker;
}

/**
 * 返回当前 Agent Broker。
 *
 * 不在这里延迟创建 Broker，避免终端测试或工具进程仅导入模块时意外启动
 * Agent HTTP 服务、恢复远端会话或打开额外数据库。
 */
export function getAgentSessionBroker(): AgentSessionBroker | null {
  return activeSessionBroker;
}
