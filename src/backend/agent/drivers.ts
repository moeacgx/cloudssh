import { AgentApiError } from "./errors.js";
import type {
  AgentJobDriver,
  AgentSessionDriver,
  DriverOutputSink,
  DriverSessionHandle,
  AgentSessionRecord,
  RunJobInput,
  RunJobResult,
} from "./types.js";

/**
 * 控制面可以独立启动，但只有接入 SSH/tmux 驱动后才允许创建真实会话。
 * 明确失败比返回一个实际不可用的“已连接”会话更安全。
 */
export class UnavailableSessionDriver implements AgentSessionDriver {
  private unavailable(): never {
    throw new AgentApiError(
      503,
      "SESSION_DRIVER_UNAVAILABLE",
      "SSH/tmux 会话驱动尚未配置",
    );
  }

  async create(
    _session: AgentSessionRecord,
    _sink: DriverOutputSink,
  ): Promise<DriverSessionHandle> {
    return this.unavailable();
  }

  async recover(
    _session: AgentSessionRecord,
    _sink: DriverOutputSink,
  ): Promise<DriverSessionHandle> {
    return this.unavailable();
  }

  async write(_runtimeId: string, _data: string): Promise<void> {
    this.unavailable();
  }

  async resize(
    _runtimeId: string,
    _cols: number,
    _rows: number,
  ): Promise<void> {
    this.unavailable();
  }

  async close(_runtimeId: string): Promise<void> {
    this.unavailable();
  }

  async closePersistent(_session: AgentSessionRecord): Promise<void> {
    this.unavailable();
  }
}

export class UnavailableJobDriver implements AgentJobDriver {
  async run(_input: RunJobInput, _signal: AbortSignal): Promise<RunJobResult> {
    throw new AgentApiError(
      503,
      "JOB_DRIVER_UNAVAILABLE",
      "SSH Job 驱动尚未配置",
    );
  }
}
