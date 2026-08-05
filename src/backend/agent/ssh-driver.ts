import crypto from "crypto";
import { type Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Client, type ClientChannel, type ConnectConfig } from "ssh2";
import type { SFTPWrapper } from "ssh2";
import { createCurrentRepositoryContext } from "../database/repositories/factory.js";
import { ProjectCredentialRepository } from "../control-plane/credential-repository.js";
import {
  loadPlatformMasterKey,
  PlatformCredentialVault,
} from "../control-plane/credential-vault.js";
import { AgentApiError } from "./errors.js";
import type {
  AgentJobDriver,
  AgentSessionDriver,
  AgentSessionRecord,
  DriverOutputSink,
  DriverSessionHandle,
  RunJobInput,
  RunJobResult,
} from "./types.js";
import { resolveHostById } from "../hosts/host-resolver.js";
import { performPortKnocking } from "../hosts/terminal-auth-helpers.js";
import {
  attachDedicatedKeyboardInteractive,
  buildDedicatedTransferConnectConfig,
  startDedicatedTransferConnect,
} from "../hosts/file-manager/ssh-connection.js";
import type { SSHHost } from "../../types/index.js";
import { DatabaseSaveTrigger } from "../utils/database-save-trigger.js";
import { apiLogger } from "../utils/logger.js";

type ResolvedConnection = {
  projectId: string;
  hostId: number;
  hostName: string | null;
  address: string;
  port: number;
  hostKeyFingerprint: string | null;
  username: string;
  authType: "password" | "key" | "none";
  keyType?: string | null;
  secret: {
    password?: string;
    privateKey?: string;
    passphrase?: string;
  };
  portKnockSequence?: Array<{
    port: number;
    protocol?: "tcp" | "udp";
    delay?: number;
  }>;
};

type RuntimeMode = AgentSessionRecord["runtimeMode"];

type Runtime = {
  client: Client;
  stream: ClientChannel;
  runtimeMode: RuntimeMode;
  tmuxSessionName: string | null;
  detaching: boolean;
  pendingOutputs: Set<Promise<void>>;
};

const DEFAULT_JOB_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
const JOB_OUTPUT_TRUNCATED_MARKER = "\n[cloudssh: output truncated]\n";
const DEFAULT_SFTP_OPERATION_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_SFTP_ABORT_CLEANUP_TIMEOUT_MS = 30_000;

export class BoundedJobOutput {
  private readonly chunks: Buffer[] = [];
  private byteLength = 0;
  private truncated = false;

  constructor(
    private readonly maxBytes: number = DEFAULT_JOB_OUTPUT_LIMIT_BYTES,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("Job output limit must be a positive integer");
    }
  }

  append(data: Buffer): void {
    const remaining = this.maxBytes - this.byteLength;
    if (remaining <= 0) {
      this.truncated = true;
      return;
    }
    if (data.length <= remaining) {
      this.chunks.push(Buffer.from(data));
      this.byteLength += data.length;
      return;
    }
    this.chunks.push(Buffer.from(data.subarray(0, remaining)));
    this.byteLength += remaining;
    this.truncated = true;
  }

  toString(): string {
    const value = Buffer.concat(this.chunks, this.byteLength).toString("utf8");
    return this.truncated ? `${value}${JOB_OUTPUT_TRUNCATED_MARKER}` : value;
  }
}

function parsePortKnockSequence(
  value: unknown,
): ResolvedConnection["portKnockSequence"] {
  if (!value) return undefined;
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(parsed)) return undefined;
  return parsed.filter(
    (
      item,
    ): item is NonNullable<ResolvedConnection["portKnockSequence"]>[number] =>
      typeof item === "object" &&
      item !== null &&
      Number.isSafeInteger((item as { port?: unknown }).port),
  );
}

function validateTmuxName(name: string): string {
  if (!/^cloudssh-[a-z0-9-]{8,80}$/i.test(name)) {
    throw new AgentApiError(400, "INVALID_TMUX_NAME", "tmux 会话名称无效");
  }
  return name;
}

function reportSinkFailure(
  operation: string,
  runtimeId: string,
  error: unknown,
): void {
  apiLogger.error("CloudSSH runtime callback failed", {
    operation,
    runtimeId,
    error: error instanceof Error ? error.message : "Unknown error",
  });
}

function forwardRuntimeOutput(
  source: { pause(): unknown; resume(): unknown },
  data: Buffer,
  sink: DriverOutputSink,
  runtimeId: string,
  runtime: Runtime,
): void {
  source.pause();
  const pendingOutput = sink
    .onOutput(data.toString("utf8"))
    .catch((error) =>
      reportSinkFailure("agent_runtime_output_failed", runtimeId, error),
    )
    .finally(() => {
      runtime.pendingOutputs.delete(pendingOutput);
      if (!runtime.detaching) source.resume();
    });
  runtime.pendingOutputs.add(pendingOutput);
}

async function drainRuntimeOutputs(runtime: Runtime): Promise<void> {
  while (runtime.pendingOutputs.size > 0) {
    await Promise.allSettled([...runtime.pendingOutputs]);
  }
}

function buildConnectConfig(connection: ResolvedConnection): ConnectConfig {
  if (!connection.hostKeyFingerprint) {
    throw new AgentApiError(
      409,
      "HOST_KEY_NOT_PINNED",
      "目标服务器尚未固定 Host Key，请先通过网页终端验证一次",
    );
  }
  const expectedFingerprint = connection.hostKeyFingerprint;
  const config: ConnectConfig = {
    host: connection.address,
    port: connection.port,
    username: connection.username,
    readyTimeout: 30_000,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 4,
    hostVerifier: (key) => {
      const actual = Buffer.from(key.toString("hex"), "utf8");
      const expected = Buffer.from(expectedFingerprint, "utf8");
      return (
        actual.length === expected.length &&
        crypto.timingSafeEqual(actual, expected)
      );
    },
  };
  if (connection.authType === "password") {
    config.password = connection.secret.password;
  } else if (connection.authType === "key") {
    config.privateKey = connection.secret.privateKey;
    config.passphrase = connection.secret.passphrase;
  }
  return config;
}

function abortReason(signal: AbortSignal, message: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(message);
}

function raceWithSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  message: string,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal, message));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal, message));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

async function waitForSftpOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  cleanupTimeoutMs: number,
): Promise<T> {
  let cleanupTimer: NodeJS.Timeout | null = null;
  let cleanupReject!: (error: Error) => void;
  const cleanupDeadline = new Promise<never>((_resolve, reject) => {
    cleanupReject = reject;
  });
  const startCleanupDeadline = () => {
    if (cleanupTimer) return;
    cleanupTimer = setTimeout(() => {
      cleanupReject(
        new AgentApiError(
          504,
          "SFTP_CLEANUP_TIMEOUT",
          "SFTP 操作取消后未在清理宽限期内结束，已强制关闭连接",
        ),
      );
    }, cleanupTimeoutMs);
    cleanupTimer.unref();
  };
  signal.addEventListener("abort", startCleanupDeadline, { once: true });
  if (signal.aborted) startCleanupDeadline();
  try {
    return await Promise.race([operation, cleanupDeadline]);
  } finally {
    signal.removeEventListener("abort", startCleanupDeadline);
    if (cleanupTimer) clearTimeout(cleanupTimer);
  }
}

function retainSshErrorListener(client: Client): void {
  client.on("error", (error) => {
    apiLogger.warn("CloudSSH SSH connection failed", {
      operation: "agent_ssh_connection_error",
      error: error.message,
    });
  });
}

async function openSshClient(
  start: (client: Client) => Promise<void> | void,
  signal?: AbortSignal,
  onConnected?: (client: Client) => void,
): Promise<Client> {
  if (signal?.aborted) throw abortReason(signal, "SSH connection canceled");
  const client = new Client();
  retainSshErrorListener(client);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      client.removeListener("ready", onReady);
      client.removeListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      client.end();
      reject(error);
    };
    const onReady = () => {
      if (settled) return;
      try {
        onConnected?.(client);
      } catch (error) {
        settled = true;
        cleanup();
        client.end();
        reject(error);
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      if (settled || !signal) return;
      settled = true;
      cleanup();
      client.destroy();
      reject(abortReason(signal, "SSH connection canceled"));
    };
    client.once("error", onError);
    client.once("ready", onReady);
    signal?.addEventListener("abort", onAbort, { once: true });
    void Promise.resolve()
      .then(() => start(client))
      .catch(onError);
  });
  return client;
}

async function connectSsh(
  connection: ResolvedConnection,
  signal?: AbortSignal,
  onConnected?: (client: Client) => void,
): Promise<Client> {
  if (signal?.aborted) throw abortReason(signal, "SSH connection canceled");
  if (connection.portKnockSequence?.length) {
    await performPortKnocking(
      connection.address,
      connection.portKnockSequence,
      { signal },
    );
  }
  if (signal?.aborted) throw abortReason(signal, "SSH connection canceled");
  return openSshClient(
    (client) => {
      client.connect(buildConnectConfig(connection));
    },
    signal,
    onConnected,
  );
}

async function connectPlatformSftp(
  host: SSHHost,
  userId: string,
  signal?: AbortSignal,
  onConnected?: (client: Client) => void,
): Promise<Client> {
  if (signal?.aborted) throw abortReason(signal, "SFTP connection canceled");
  const portKnockSequence = parsePortKnockSequence(host.portKnockSequence);
  if (portKnockSequence?.length) {
    await performPortKnocking(host.ip, portKnockSequence, { signal });
  }
  if (signal?.aborted) throw abortReason(signal, "SFTP connection canceled");
  return openSshClient(
    async (client) => {
      attachDedicatedKeyboardInteractive(client, host);
      const config = await buildDedicatedTransferConnectConfig(
        host,
        userId,
        client,
      );
      await startDedicatedTransferConnect(client, config, host, userId, signal);
    },
    signal,
    onConnected,
  );
}

export class PlatformSshDriver implements AgentSessionDriver, AgentJobDriver {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly credentialMirrors = new Map<number, Promise<void>>();
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    private readonly credentials: ProjectCredentialRepository,
    private readonly fileProofKey = crypto.randomBytes(32),
    private readonly sftpOperationTimeoutMs = DEFAULT_SFTP_OPERATION_TIMEOUT_MS,
    private readonly sftpAbortCleanupTimeoutMs = DEFAULT_SFTP_ABORT_CLEANUP_TIMEOUT_MS,
  ) {}

  fileRequestProof(data: Buffer): string {
    return crypto
      .createHmac("sha256", this.fileProofKey)
      .update("cloudssh-agent-file-idempotency-v1\0", "utf8")
      .update(data)
      .digest("hex");
  }

  async fileRequestProofStream(
    data: Readable,
    maximumBytes: number,
    signal?: AbortSignal,
  ): Promise<{ contentProof: string; size: number; sha256: string }> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
      throw new AgentApiError(400, "INVALID_INPUT", "上传文件大小无效");
    }
    const proof = crypto
      .createHmac("sha256", this.fileProofKey)
      .update("cloudssh-agent-file-idempotency-v1\0", "utf8");
    const hash = crypto.createHash("sha256");
    let size = 0;
    const sink = new Writable({
      write(value, _encoding, callback) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        if (size + chunk.length > maximumBytes) {
          callback(
            new AgentApiError(
              409,
              "UPLOAD_SOURCE_CHANGED",
              "上传临时文件在鉴权后发生变化，未替换目标文件",
            ),
          );
          return;
        }
        size += chunk.length;
        proof.update(chunk);
        hash.update(chunk);
        callback();
      },
    });
    await pipeline(data, sink, { signal });
    return {
      contentProof: proof.digest("hex"),
      size,
      sha256: hash.digest("hex"),
    };
  }

  async create(session: AgentSessionRecord, sink: DriverOutputSink) {
    return session.runtimeMode === "platform"
      ? this.openPlatform(session, sink)
      : this.openTmux(session, sink);
  }

  async recover(session: AgentSessionRecord, sink: DriverOutputSink) {
    this.requireAvailable();
    if (session.runtimeMode === "platform") {
      throw new AgentApiError(
        409,
        "PLATFORM_SESSION_NOT_RECOVERABLE",
        "平台持续会话依赖当前 CloudSSH 进程，服务重启后无法恢复",
      );
    }
    return this.openTmux(session, sink);
  }

  async write(runtimeId: string, data: string): Promise<void> {
    const runtime = this.requireRuntime(runtimeId);
    await new Promise<void>((resolve, reject) => {
      runtime.stream.write(data, (error?: Error | null) =>
        error ? reject(error) : resolve(),
      );
    });
  }

  async resize(runtimeId: string, cols: number, rows: number): Promise<void> {
    this.requireRuntime(runtimeId).stream.setWindow(rows, cols, 0, 0);
  }

  async close(runtimeId: string): Promise<void> {
    const runtime = this.requireRuntime(runtimeId);
    runtime.detaching = true;
    runtime.stream.pause();
    runtime.stream.stderr.pause();
    this.runtimes.delete(runtimeId);
    try {
      // 显式关闭也要先提交已接收的尾部输出，避免录像和输出游标缺最后一段。
      await drainRuntimeOutputs(runtime);
      if (runtime.runtimeMode === "tmux") {
        await new Promise<void>((resolve) => {
          runtime.client.exec(
            `tmux kill-session -t ${validateTmuxName(runtime.tmuxSessionName!)}`,
            (_error, stream) => {
              if (!stream) return resolve();
              stream.once("close", () => resolve());
              stream.resume();
            },
          );
          setTimeout(resolve, 2_000).unref();
        });
      }
    } finally {
      runtime.stream.end();
      runtime.client.end();
    }
  }

  async closePersistent(session: AgentSessionRecord): Promise<void> {
    this.requireAvailable();
    if (session.runtimeMode !== "tmux") return;
    const tmuxName = validateTmuxName(session.tmuxSessionName);
    const connection = await this.resolveConnection(
      session.projectId,
      session.serverId,
    );
    const client = await connectSsh(connection);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("远端 tmux 关闭超时")),
          5_000,
        );
        timer.unref();
        client.exec(
          `if command -v tmux >/dev/null 2>&1; then tmux kill-session -t ${tmuxName} >/dev/null 2>&1 || true; fi`,
          (error, stream) => {
            if (error || !stream) {
              clearTimeout(timer);
              reject(error ?? new Error("远端 tmux 关闭通道不可用"));
              return;
            }
            const finish = (failure?: Error) => {
              clearTimeout(timer);
              stream.removeListener("error", onError);
              if (failure) reject(failure);
              else resolve();
            };
            const onError = (streamError: Error) => finish(streamError);
            stream.on("error", (streamError: Error) => {
              apiLogger.warn("CloudSSH persistent tmux close failed", {
                operation: "agent_persistent_tmux_close_channel_error",
                error: streamError.message,
              });
            });
            stream.once("error", onError);
            stream.once("close", () => finish());
            stream.resume();
          },
        );
      });
    } finally {
      client.end();
    }
  }

  async run(input: RunJobInput, signal: AbortSignal): Promise<RunJobResult> {
    this.requireAvailable();
    if (signal.aborted) throw new Error("Job canceled");
    const connection = await this.resolveConnection(
      input.projectId,
      input.serverId,
    );
    const client = await connectSsh(connection, signal);
    if (signal.aborted || this.shuttingDown) {
      client.end();
      throw new Error("Job canceled");
    }
    return new Promise<RunJobResult>((resolve, reject) => {
      const stdout = new BoundedJobOutput();
      const stderr = new BoundedJobOutput();
      let settled = false;
      const finish = (result: RunJobResult | Error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        client.removeListener("error", onClientError);
        client.end();
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      const onAbort = () => {
        client.destroy();
        finish(new Error("Job canceled"));
      };
      const onClientError = (error: Error) => finish(error);
      signal.addEventListener("abort", onAbort, { once: true });
      client.once("error", onClientError);
      client.exec(input.command, (error, stream) => {
        if (error) return finish(error);
        stream.on("data", (data: Buffer) => {
          stdout.append(data);
        });
        stream.stderr.on("data", (data: Buffer) => {
          stderr.append(data);
        });
        stream.once("close", (code: number | null) =>
          finish({
            stdout: stdout.toString(),
            stderr: stderr.toString(),
            exitCode: code ?? 255,
          }),
        );
      });
    });
  }

  /**
   * 在平台后端使用与 Agent 终端/Job 相同的凭据解析链打开一次 SFTP
   * 通道。回调完成后立即关闭连接；凭据和连接对象不会离开后端进程。
   */
  async withSftp<T>(
    projectId: string,
    serverId: string,
    operation: (sftp: SFTPWrapper, signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    this.requireAvailable();
    const operationController = new AbortController();
    const abortFromCaller = () => {
      if (!callerSignal || operationController.signal.aborted) return;
      operationController.abort(
        abortReason(callerSignal, "SFTP operation canceled"),
      );
    };
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
    if (callerSignal?.aborted) abortFromCaller();
    const timeout = setTimeout(() => {
      operationController.abort(
        new AgentApiError(
          504,
          "SFTP_OPERATION_TIMEOUT",
          "SFTP 操作超过 15 分钟，已自动取消",
        ),
      );
    }, this.sftpOperationTimeoutMs);
    timeout.unref();

    const signal = operationController.signal;
    let client: Client | null = null;
    let sftp: SFTPWrapper | null = null;
    let lifecycleSettled = false;
    let rejectLifecycle!: (error: Error) => void;
    const lifecycleFailure = new Promise<never>((_resolve, reject) => {
      rejectLifecycle = reject;
    });
    const failLifecycle = (error: Error) => {
      if (lifecycleSettled) return;
      lifecycleSettled = true;
      if (!operationController.signal.aborted) {
        operationController.abort(error);
      }
      rejectLifecycle(error);
    };
    const onClientError = (error: Error) => failLifecycle(error);
    const onClientClose = () =>
      failLifecycle(
        new AgentApiError(
          502,
          "SFTP_CONNECTION_CLOSED",
          "SFTP 连接在操作完成前已关闭",
        ),
      );
    const onSftpError = (error: Error) => failLifecycle(error);
    const onSftpClose = () => onClientClose();
    try {
      const connection = await raceWithSignal(
        this.resolveSftpHost(projectId, serverId),
        signal,
        "SFTP operation canceled",
      );
      client = await connectPlatformSftp(
        connection.host,
        connection.ownerUserId,
        signal,
        (connectedClient) => {
          client = connectedClient;
          connectedClient.once("error", onClientError);
          connectedClient.once("close", onClientClose);
        },
      );
      sftp = await raceWithSignal(
        Promise.race([
          new Promise<SFTPWrapper>((resolve, reject) => {
            client!.sftp((error, channel) => {
              if (error) reject(error);
              else {
                channel.on("error", (channelError: Error) => {
                  apiLogger.warn("CloudSSH SFTP channel failed", {
                    operation: "agent_sftp_channel_error",
                    error: channelError.message,
                  });
                });
                channel.once("error", onSftpError);
                channel.once("close", onSftpClose);
                resolve(channel);
              }
            });
          }),
          lifecycleFailure,
        ]),
        signal,
        "SFTP operation canceled",
      );
      // 取消只通过 signal 通知文件操作。必须等待操作自己的 finally
      // 完成临时文件清理后才能关闭 SFTP，并在此之前保留并发名额。
      return await waitForSftpOperation(
        Promise.resolve().then(() => operation(sftp!, signal)),
        signal,
        this.sftpAbortCleanupTimeoutMs,
      );
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abortFromCaller);
      lifecycleSettled = true;
      sftp?.removeListener("error", onSftpError);
      sftp?.removeListener("close", onSftpClose);
      client?.removeListener("error", onClientError);
      client?.removeListener("close", onClientClose);
      try {
        sftp?.end();
      } finally {
        if (signal.aborted) client?.destroy();
        else client?.end();
      }
    }
  }

  private async openTmux(
    session: AgentSessionRecord,
    sink: DriverOutputSink,
  ): Promise<DriverSessionHandle> {
    this.requireAvailable();
    const tmuxName = validateTmuxName(session.tmuxSessionName);
    const connection = await this.resolveConnection(
      session.projectId,
      session.serverId,
    );
    const client = await connectSsh(connection);
    let stream: ClientChannel;
    try {
      stream = await new Promise<ClientChannel>((resolve, reject) => {
        client.exec(
          `if ! command -v tmux >/dev/null 2>&1; then echo 'CloudSSH requires tmux' >&2; exit 127; fi; exec tmux new-session -A -s ${tmuxName}`,
          {
            pty: {
              term: "xterm-256color",
              cols: session.cols,
              rows: session.rows,
            },
          },
          (error, channel) => (error ? reject(error) : resolve(channel)),
        );
      });
    } catch (error) {
      client.end();
      throw error;
    }
    return this.registerRuntime(client, stream, "tmux", tmuxName, sink);
  }

  private async openPlatform(
    session: AgentSessionRecord,
    sink: DriverOutputSink,
  ): Promise<DriverSessionHandle> {
    this.requireAvailable();
    const connection = await this.resolveConnection(
      session.projectId,
      session.serverId,
    );
    const client = await connectSsh(connection);
    let stream: ClientChannel;
    try {
      stream = await new Promise<ClientChannel>((resolve, reject) => {
        client.shell(
          {
            term: "xterm-256color",
            cols: session.cols,
            rows: session.rows,
          },
          (error, channel) => (error ? reject(error) : resolve(channel)),
        );
      });
    } catch (error) {
      client.end();
      throw error;
    }
    return this.registerRuntime(client, stream, "platform", null, sink);
  }

  private registerRuntime(
    client: Client,
    stream: ClientChannel,
    runtimeMode: RuntimeMode,
    tmuxSessionName: string | null,
    sink: DriverOutputSink,
  ): DriverSessionHandle {
    if (this.shuttingDown) {
      stream.end();
      client.end();
      throw new AgentApiError(503, "AGENT_SHUTTING_DOWN", "Agent 正在关闭");
    }
    const runtimeId = crypto.randomUUID();
    const runtime: Runtime = {
      client,
      stream,
      runtimeMode,
      tmuxSessionName,
      detaching: false,
      pendingOutputs: new Set(),
    };
    this.runtimes.set(runtimeId, runtime);
    let runtimeSettled = false;
    const finishRuntime = (code: number, reason?: string) => {
      if (runtimeSettled) return;
      runtimeSettled = true;
      const suppressExit = runtime.detaching;
      runtime.detaching = true;
      stream.pause();
      stream.stderr.pause();
      client.removeListener("error", onClientError);
      stream.removeListener("error", onStreamError);
      this.runtimes.delete(runtimeId);
      void (async () => {
        await drainRuntimeOutputs(runtime);
        client.end();
        if (suppressExit) return;
        await sink.onExit(code, reason);
      })().catch((error) =>
        reportSinkFailure("agent_runtime_exit_failed", runtimeId, error),
      );
    };
    const onClientError = () => {
      stream.destroy();
      client.destroy();
      finishRuntime(255, "SSH 连接已中断");
    };
    const onStreamError = () => finishRuntime(255, "SSH 通道已中断");
    client.once("error", onClientError);
    // 保留日志监听器，避免 finishRuntime 移除状态监听后迟到的通道错误
    // 变成未处理的 EventEmitter error。
    stream.on("error", (error: Error) => {
      apiLogger.warn("CloudSSH SSH channel failed", {
        operation: "agent_runtime_channel_error",
        runtimeId,
        error: error.message,
      });
    });
    stream.once("error", onStreamError);
    stream.on("data", (data: Buffer) => {
      forwardRuntimeOutput(stream, data, sink, runtimeId, runtime);
    });
    stream.stderr.on("data", (data: Buffer) => {
      forwardRuntimeOutput(stream.stderr, data, sink, runtimeId, runtime);
    });
    stream.once("close", (code: number | null) => {
      finishRuntime(
        code ?? 255,
        runtimeMode === "tmux" && code === 127 ? "远端未安装 tmux" : undefined,
      );
    });
    return { runtimeId };
  }

  shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.shuttingDown = true;
      this.shutdownPromise = (async () => {
        const runtimes = [...this.runtimes.entries()];
        for (const [runtimeId, runtime] of runtimes) {
          runtime.detaching = true;
          runtime.stream.pause();
          runtime.stream.stderr.pause();
          this.runtimes.delete(runtimeId);
          runtime.stream.end();
          runtime.client.end();
        }
        await Promise.allSettled(
          runtimes.flatMap(([, runtime]) => [...runtime.pendingOutputs]),
        );
      })();
    }
    return this.shutdownPromise;
  }

  private requireAvailable(): void {
    if (this.shuttingDown) {
      throw new AgentApiError(503, "AGENT_SHUTTING_DOWN", "Agent 正在关闭");
    }
  }

  private requireRuntime(runtimeId: string): Runtime {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) {
      throw new AgentApiError(
        409,
        "SESSION_RUNTIME_MISSING",
        "会话运行时不存在",
      );
    }
    return runtime;
  }

  private async resolveConnection(projectId: string, serverId: string) {
    const projectHostId = Number(serverId);
    if (!Number.isSafeInteger(projectHostId) || projectHostId <= 0) {
      throw new AgentApiError(
        400,
        "INVALID_SERVER_ID",
        "serverId 必须是项目服务器 ID",
      );
    }
    const connection =
      await this.credentials.resolveForProjectHost(projectHostId);
    if (connection) {
      if (connection.projectId !== projectId) {
        throw new AgentApiError(
          404,
          "PROJECT_SERVER_NOT_FOUND",
          "项目服务器不存在",
        );
      }
      if (!["password", "key", "none"].includes(connection.authType)) {
        throw new AgentApiError(
          409,
          "UNSUPPORTED_AUTH_TYPE",
          `Agent 暂不支持 ${connection.authType} 认证`,
        );
      }
      return {
        ...connection,
        authType: connection.authType as "password" | "key" | "none",
      };
    }
    const reference =
      await this.credentials.findProjectHostReference(projectHostId);
    if (!reference || reference.projectId !== projectId) {
      throw new AgentApiError(
        404,
        "PROJECT_SERVER_NOT_FOUND",
        "项目服务器不存在",
      );
    }

    // 未单独配置项目凭据时，安全复用 Termix 已有的服务端凭据解析链。
    // 凭据只在后端内存中进入 ssh2，绝不返回给 Agent 或浏览器。
    const ownerUserId = await this.hostOwner(reference.hostId);
    const host = await resolveHostById(reference.hostId, ownerUserId);
    if (!host) {
      throw new AgentApiError(
        409,
        "PROJECT_CREDENTIAL_UNAVAILABLE",
        "项目服务器凭据当前不可用，请确认主机所有者已登录并可通过网页终端连接",
      );
    }
    if ((host.connectionType ?? "ssh") !== "ssh") {
      throw new AgentApiError(
        400,
        "UNSUPPORTED_CONNECTION_TYPE",
        "Agent 仅支持 SSH 主机",
      );
    }
    if (!["password", "key", "none"].includes(host.authType)) {
      throw new AgentApiError(
        409,
        "UNSUPPORTED_AUTH_TYPE",
        `Agent 暂不支持 ${host.authType} 认证`,
      );
    }
    const raw = host as unknown as Record<string, unknown>;
    const resolved: ResolvedConnection = {
      projectId,
      hostId: reference.hostId,
      hostName: host.name,
      address: host.ip,
      port: host.port,
      hostKeyFingerprint:
        typeof raw.hostKeyFingerprint === "string"
          ? raw.hostKeyFingerprint
          : null,
      username: host.username,
      authType: host.authType as "password" | "key" | "none",
      keyType: host.keyType,
      secret: {
        password: host.password,
        privateKey: host.key,
        passphrase: host.keyPassword,
      },
      portKnockSequence: parsePortKnockSequence(host.portKnockSequence),
    };
    await this.mirrorLegacyCredential(projectHostId, resolved, ownerUserId);
    return resolved;
  }

  private async resolveSftpHost(projectId: string, serverId: string) {
    const projectHostId = Number(serverId);
    if (!Number.isSafeInteger(projectHostId) || projectHostId <= 0) {
      throw new AgentApiError(
        400,
        "INVALID_SERVER_ID",
        "serverId 必须是项目服务器 ID",
      );
    }
    const reference =
      await this.credentials.findProjectHostReference(projectHostId);
    if (!reference || reference.projectId !== projectId) {
      throw new AgentApiError(
        404,
        "PROJECT_SERVER_NOT_FOUND",
        "项目服务器不存在",
      );
    }
    const ownerUserId = await this.hostOwner(reference.hostId);
    const host = await resolveHostById(
      reference.hostId,
      ownerUserId,
      projectHostId,
    );
    if (!host) {
      throw new AgentApiError(
        409,
        "PROJECT_CREDENTIAL_UNAVAILABLE",
        "项目服务器凭据当前不可用，请确认主机可通过网页文件管理连接",
      );
    }
    if ((host.connectionType ?? "ssh") !== "ssh") {
      throw new AgentApiError(
        400,
        "UNSUPPORTED_CONNECTION_TYPE",
        "Agent 文件管理仅支持 SSH 主机",
      );
    }
    if (!["password", "key", "none", "tailscale"].includes(host.authType)) {
      throw new AgentApiError(
        409,
        "UNSUPPORTED_AUTH_TYPE",
        `Agent 文件管理暂不支持 ${host.authType} 认证`,
      );
    }
    const fingerprint = (host as unknown as Record<string, unknown>)
      .hostKeyFingerprint;
    if (typeof fingerprint !== "string" || !fingerprint) {
      throw new AgentApiError(
        409,
        "HOST_KEY_NOT_PINNED",
        "目标服务器尚未固定 Host Key，请先通过网页终端验证一次",
      );
    }
    return { host, ownerUserId };
  }

  private async mirrorLegacyCredential(
    projectHostId: number,
    connection: ResolvedConnection,
    createdBy: string,
  ): Promise<void> {
    const existing = this.credentialMirrors.get(projectHostId);
    if (existing) return existing;
    const mirror = (async () => {
      const result = await this.credentials.ensureForProjectHost({
        projectId: connection.projectId,
        projectHostId,
        hostName: connection.hostName || connection.address,
        username: connection.username,
        authType: connection.authType,
        keyType: connection.keyType,
        secret: connection.secret,
        createdBy,
      });
      if (result.changed) {
        await DatabaseSaveTrigger.forceSave("agent_project_credential_mirror");
      }
    })();
    this.credentialMirrors.set(projectHostId, mirror);
    try {
      await mirror;
    } finally {
      this.credentialMirrors.delete(projectHostId);
    }
  }

  private async hostOwner(hostId: number): Promise<string> {
    const context = createCurrentRepositoryContext();
    const row = context.sqlite
      ?.prepare("SELECT user_id AS userId FROM ssh_data WHERE id = ?")
      .get(hostId) as { userId: string } | undefined;
    if (!row?.userId) {
      throw new AgentApiError(404, "HOST_NOT_FOUND", "底层 SSH 主机不存在");
    }
    return row.userId;
  }
}

export async function createPlatformSshDriver() {
  const key = await loadPlatformMasterKey();
  const fileProofKey = crypto
    .createHmac("sha256", key)
    .update("cloudssh-agent-file-idempotency-key-v1", "utf8")
    .digest();
  return new PlatformSshDriver(
    new ProjectCredentialRepository(
      createCurrentRepositoryContext(),
      new PlatformCredentialVault(key),
    ),
    fileProofKey,
  );
}
