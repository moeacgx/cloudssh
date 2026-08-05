export type AgentScope =
  | "sessions:create"
  | "sessions:read"
  | "sessions:write"
  | "sessions:close"
  | "jobs:execute"
  | "servers:create"
  | "quick-connections:create"
  /** 列出、读取和下载已授权项目中的远程文件。 */
  | "files:read"
  /** 上传、创建目录、移动或删除远程文件。 */
  | "files:write";

export type AgentSessionState =
  | "CREATING"
  | "RUNNING"
  | "RECOVERING"
  | "CLOSING"
  | "CLOSED"
  | "FAILED";

export type AgentSessionRuntimeMode = "platform" | "tmux";

export interface AgentPrincipal {
  principalId: string;
  serviceAccountId: string;
  serviceAccountIds?: string[];
  projectId: string;
  projectIds?: string[];
  projectServiceAccountIds?: Record<string, string>;
  name: string;
  /** 当前设备授权主体。新增资产时仍会再次校验此用户的项目管理权限。 */
  approvedByUserId?: string;
  scopes: AgentScope[];
  serverIds: string[];
  serverProjectIds?: Record<string, string>;
  serverServiceAccountIds?: Record<string, string>;
  maxConcurrentSessions: number;
}

export interface AgentTokenRecord extends AgentPrincipal {
  id: string;
  tokenPrefix: string;
  tokenSalt: string;
  tokenHash: string;
  expiresAt: string | null;
  active: boolean;
  lastUsedAt: string | null;
}

export interface AgentDeviceRecord extends AgentPrincipal {
  id: string;
  publicKey: string;
  fingerprint: string;
  expiresAt: string | null;
  active: boolean;
  lastUsedAt: string | null;
}

export interface OutputChunk {
  generation: number;
  sequence: number;
  data: string;
  timestamp: string;
}

export interface WriteLease {
  id: string;
  holderId: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface AgentAttachment {
  id: string;
  principalId: string;
  mode: "read-only" | "read-write";
  attachedAt: string;
  lastSeenAt: string;
}

export interface AgentSessionRecord {
  id: string;
  projectId: string;
  serverId: string;
  serviceAccountId: string;
  state: AgentSessionState;
  cols: number;
  rows: number;
  pinned: boolean;
  runtimeMode: AgentSessionRuntimeMode;
  createdAt: string;
  updatedAt: string;
  lastDetachedAt: string | null;
  closedAt: string | null;
  failureReason: string | null;
  generation: number;
  nextSequence: number;
  output: OutputChunk[];
  attachments: AgentAttachment[];
  writeLease: WriteLease | null;
  runtimeId: string | null;
  tmuxSessionName: string;
}

export type AgentJobState =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELED"
  | "TIMED_OUT";

export interface AgentJobRecord {
  id: string;
  projectId: string;
  serverId: string;
  serviceAccountId: string;
  command: string;
  state: AgentJobState;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timeoutMs: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  failureReason: string | null;
}

export interface IdempotencyRecord {
  key: string;
  requestHash: string;
  response: unknown;
  createdAt: string;
}

export interface AgentPersistentState {
  version: 1;
  sessions: AgentSessionRecord[];
  jobs: AgentJobRecord[];
  idempotency: IdempotencyRecord[];
}

export interface CreateSessionInput {
  serverId: string;
  cols: number;
  rows: number;
  pinned: boolean;
  runtimeMode?: AgentSessionRuntimeMode;
}

export interface DriverSessionHandle {
  runtimeId: string;
}

export interface DriverOutputSink {
  onOutput(data: string): Promise<void>;
  onExit(exitCode: number | null, reason?: string): Promise<void>;
}

export interface AgentSessionDriver {
  create(
    session: AgentSessionRecord,
    sink: DriverOutputSink,
  ): Promise<DriverSessionHandle>;
  recover(
    session: AgentSessionRecord,
    sink: DriverOutputSink,
  ): Promise<DriverSessionHandle>;
  write(runtimeId: string, data: string): Promise<void>;
  resize(runtimeId: string, cols: number, rows: number): Promise<void>;
  close(runtimeId: string): Promise<void>;
  /**
   * 服务重启后按持久会话定位并终止远端运行时，不依赖旧进程 runtimeId。
   */
  closePersistent(session: AgentSessionRecord): Promise<void>;
  /**
   * 关闭本进程持有的连接，但保留远端持久会话，供下次启动恢复。
   */
  shutdown?(): Promise<void>;
}

export interface RunJobInput {
  jobId: string;
  projectId: string;
  serverId: string;
  command: string;
  timeoutMs: number;
}

export interface RunJobResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface AgentJobDriver {
  run(input: RunJobInput, signal: AbortSignal): Promise<RunJobResult>;
}
