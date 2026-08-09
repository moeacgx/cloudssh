import type { TerminalConfig } from "@/types";

export interface TerminalHostConfig {
  id?: number;
  instanceId?: string;
  restoredSessionId?: string | null;
  /** Set when this tab joins someone else's live shared SSH session instead of connecting/attaching. */
  joinSharedSessionId?: string | null;
  joinShareId?: string | null;
  /** 从连接面板附着到 Agent 创建的同一远端 tmux 会话。 */
  agentSessionId?: string | null;
  ip: string;
  port: number;
  username: string;
  password?: string;
  key?: string;
  keyPassword?: string;
  keyType?: string;
  authType?: string;
  credentialId?: number;
  terminalConfig?: TerminalConfig;
  [key: string]: unknown;
}

export interface TerminalSessionPersistenceState {
  sessionId: string | null;
  agentSessionId?: string | null;
  sessionPinned: boolean;
  sessionManagedTmux?: boolean;
  tmuxSessionName: string | null;
  lastDetachedAt?: number | null;
  retentionExpiresAt?: number | null;
  recoverable?: boolean;
}

export interface TerminalHandle {
  /** 显式终止 SSH 或远端受管 tmux。 */
  disconnect: () => void;
  /** 只关闭当前浏览器附件，后台固定会话继续运行。 */
  detach: () => void;
  reconnect: () => void;
  isConnected: () => boolean;
  fit: () => void;
  focus: () => void;
  sendInput: (data: string) => void;
  paste: (text: string) => void;
  notifyResize: () => void;
  getRecentOutput: (maxLines?: number) => string;
  getSessionContext: () => {
    sessionId: string | null;
    agentSessionId?: string | null;
    hostId?: number | string | null;
    connected: boolean;
  };
  refresh: () => void;
  getApplicationCursorKeysMode: () => boolean;
  openShareModal: () => void;
  canShare: () => boolean;
  pinSession: () => Promise<boolean>;
  isSessionPinned: () => boolean;
}
