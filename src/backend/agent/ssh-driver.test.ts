import { beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { AgentApiError } from "./errors.js";
import type { AgentSessionRecord } from "./types.js";

const mocks = vi.hoisted(() => ({
  resolveHostById: vi.fn(),
  forceSave: vi.fn(),
  performPortKnocking: vi.fn(),
  attachDedicatedKeyboardInteractive: vi.fn(),
  buildDedicatedTransferConnectConfig: vi.fn(),
  startDedicatedTransferConnect: vi.fn(),
  ownerRow: { userId: "owner-1" } as { userId: string } | undefined,
  sshClients: [] as Array<{
    connect: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    exec: ReturnType<typeof vi.fn>;
    shell: ReturnType<typeof vi.fn>;
    execChannel: {
      destroy: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
      pause: ReturnType<typeof vi.fn>;
      resume: ReturnType<typeof vi.fn>;
      setWindow: ReturnType<typeof vi.fn>;
      write: ReturnType<typeof vi.fn>;
      emit(event: string, value?: unknown): boolean;
      stderr: {
        pause(): unknown;
        resume(): unknown;
        emit(event: string, value?: unknown): boolean;
      };
    };
    shellChannel: {
      destroy: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
      pause: ReturnType<typeof vi.fn>;
      resume: ReturnType<typeof vi.fn>;
      setWindow: ReturnType<typeof vi.fn>;
      write: ReturnType<typeof vi.fn>;
      emit(event: string, value?: unknown): boolean;
      stderr: {
        pause(): unknown;
        resume(): unknown;
        emit(event: string, value?: unknown): boolean;
      };
    };
    sftp: ReturnType<typeof vi.fn>;
    sftpChannel: {
      end: ReturnType<typeof vi.fn>;
      emit(event: string, error?: Error): boolean;
    };
    emit(event: string, error?: Error): boolean;
  }>,
  loggerWarn: vi.fn(),
}));

vi.mock("ssh2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ssh2")>();
  const { EventEmitter } = await import("node:events");
  class FakeSftp extends EventEmitter {
    end = vi.fn();
  }
  class FakeDataStream extends EventEmitter {
    pause = vi.fn();
    resume = vi.fn();
  }
  class FakeExecChannel extends EventEmitter {
    stderr = new FakeDataStream();
    destroy = vi.fn();
    end = vi.fn();
    pause = vi.fn();
    resume = vi.fn();
    setWindow = vi.fn();
    write = vi.fn((_data: string, callback?: (error?: Error | null) => void) =>
      callback?.(),
    );
  }
  class FakeClient extends EventEmitter {
    connect = vi.fn(() => queueMicrotask(() => this.emit("ready")));
    destroy = vi.fn();
    end = vi.fn();
    execChannel = new FakeExecChannel();
    exec = vi.fn((...args: unknown[]) => {
      const callback = args.at(-1) as (
        error: Error | undefined,
        channel: FakeExecChannel,
      ) => void;
      queueMicrotask(() => callback(undefined, this.execChannel));
    });
    shellChannel = new FakeExecChannel();
    shell = vi.fn((...args: unknown[]) => {
      const callback = args.at(-1) as (
        error: Error | undefined,
        channel: FakeExecChannel,
      ) => void;
      queueMicrotask(() => callback(undefined, this.shellChannel));
    });
    sftpChannel = new FakeSftp();
    sftp = vi.fn(
      (callback: (error: Error | undefined, channel: FakeSftp) => void) =>
        queueMicrotask(() => callback(undefined, this.sftpChannel)),
    );

    constructor() {
      super();
      mocks.sshClients.push(this);
    }
  }
  return {
    ...actual,
    Client: FakeClient,
    default: { ...actual, Client: FakeClient },
  };
});

vi.mock("../hosts/host-resolver.js", () => ({
  resolveHostById: mocks.resolveHostById,
}));

vi.mock("../hosts/terminal-auth-helpers.js", () => ({
  performPortKnocking: mocks.performPortKnocking,
}));

vi.mock("../hosts/file-manager/ssh-connection.js", () => ({
  attachDedicatedKeyboardInteractive: mocks.attachDedicatedKeyboardInteractive,
  buildDedicatedTransferConnectConfig:
    mocks.buildDedicatedTransferConnectConfig,
  startDedicatedTransferConnect: mocks.startDedicatedTransferConnect,
}));

vi.mock("../database/repositories/factory.js", () => ({
  createCurrentRepositoryContext: () => ({
    sqlite: {
      prepare: () => ({
        get: () => mocks.ownerRow,
      }),
    },
  }),
}));

vi.mock("../utils/database-save-trigger.js", () => ({
  DatabaseSaveTrigger: { forceSave: mocks.forceSave },
}));

vi.mock("../utils/logger.js", () => ({
  apiLogger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: mocks.loggerWarn,
  },
}));

import { BoundedJobOutput, PlatformSshDriver } from "./ssh-driver.js";

type ResolveConnection = (
  projectId: string,
  serverId: string,
) => Promise<{
  projectId: string;
  hostId: number;
  username: string;
  authType: string;
  secret: { password?: string; privateKey?: string };
}>;

function createCredentialRepository() {
  return {
    resolveForProjectHost: vi.fn().mockResolvedValue(null),
    findProjectHostReference: vi
      .fn()
      .mockResolvedValue({ projectId: "project-1", hostId: 42 }),
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({ id: "credential-1" }),
    assignToProjectHost: vi.fn().mockResolvedValue(true),
    remove: vi.fn().mockResolvedValue(true),
    ensureForProjectHost: vi.fn().mockResolvedValue({
      projectId: "project-1",
      hostId: 42,
      changed: true,
    }),
  };
}

function resolver(driver: PlatformSshDriver): ResolveConnection {
  return (
    driver as unknown as {
      resolveConnection: ResolveConnection;
    }
  ).resolveConnection.bind(driver);
}

function useDirectProjectCredential(
  credentials: ReturnType<typeof createCredentialRepository>,
  overrides: Record<string, unknown> = {},
) {
  credentials.resolveForProjectHost.mockResolvedValue({
    projectId: "project-1",
    hostId: 42,
    hostName: "生产主机",
    address: "192.0.2.42",
    port: 22,
    hostKeyFingerprint: "fingerprint",
    username: "root",
    authType: "password",
    keyType: null,
    secret: { password: "secret-password" },
    ...overrides,
  });
}

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const rejectAbort = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("operation canceled"),
      );
    if (signal.aborted) rejectAbort();
    else signal.addEventListener("abort", rejectAbort, { once: true });
  });
}

function resolvedPlatformHost(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    name: "生产主机",
    ip: "192.0.2.42",
    port: 22,
    username: "root",
    connectionType: "ssh",
    authType: "password",
    password: "secret-password",
    key: null,
    keyPassword: null,
    keyType: null,
    hostKeyFingerprint: "fingerprint",
    portKnockSequence: [{ port: 4000, protocol: "tcp", delay: 100 }],
    ...overrides,
  };
}

function agentSession(
  runtimeMode: "platform" | "tmux",
  overrides: Partial<AgentSessionRecord> = {},
): AgentSessionRecord {
  const now = new Date().toISOString();
  return {
    id: `session-${runtimeMode}`,
    projectId: "project-1",
    serverId: "9",
    serviceAccountId: "device-1",
    state: "CREATING",
    cols: 120,
    rows: 30,
    pinned: runtimeMode === "tmux",
    createdAt: now,
    updatedAt: now,
    lastDetachedAt: null,
    closedAt: null,
    failureReason: null,
    generation: 1,
    nextSequence: 1,
    output: [],
    attachments: [],
    writeLease: null,
    runtimeId: null,
    tmuxSessionName: `cloudssh-${runtimeMode}-session`,
    runtimeMode,
    ...overrides,
  } as AgentSessionRecord;
}

describe("Agent 文件幂等证明", () => {
  it("空文件的流式证明与 Buffer 正文证明一致", async () => {
    const key = Buffer.alloc(32, 0x2a);
    const driver = new PlatformSshDriver(
      createCredentialRepository() as never,
      key,
    );

    const streamed = await driver.fileRequestProofStream(Readable.from([]), 0);

    expect(streamed).toEqual({
      contentProof: driver.fileRequestProof(Buffer.alloc(0)),
      size: 0,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("流式证明与升级前的 Buffer 正文证明完全一致", async () => {
    const key = Buffer.alloc(32, 0x5a);
    const payload = Buffer.from("legacy-idempotency-payload");
    const driver = new PlatformSshDriver(
      createCredentialRepository() as never,
      key,
    );

    const streamed = await driver.fileRequestProofStream(
      Readable.from([payload.subarray(0, 6), payload.subarray(6)]),
      payload.length,
    );

    expect(streamed).toEqual({
      contentProof: driver.fileRequestProof(payload),
      size: payload.length,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("流式证明在正文超过声明大小时立即拒绝", async () => {
    const payload = Buffer.from("changed-payload");
    const driver = new PlatformSshDriver(
      createCredentialRepository() as never,
      Buffer.alloc(32, 0x33),
    );

    await expect(
      driver.fileRequestProofStream(
        Readable.from([payload]),
        payload.length - 1,
      ),
    ).rejects.toMatchObject({ code: "UPLOAD_SOURCE_CHANGED" });
  });
});

describe("Agent SSH 凭据解析", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sshClients.length = 0;
    mocks.ownerRow = { userId: "owner-1" };
    mocks.forceSave.mockResolvedValue(undefined);
    mocks.resolveHostById.mockResolvedValue(resolvedPlatformHost());
  });

  it("优先使用项目凭据，不触碰原主机凭据", async () => {
    const credentials = createCredentialRepository();
    credentials.resolveForProjectHost.mockResolvedValue({
      projectId: "project-1",
      hostId: 42,
      hostName: "生产主机",
      address: "192.0.2.42",
      port: 22,
      hostKeyFingerprint: "fingerprint",
      username: "root",
      authType: "key",
      keyType: "ed25519",
      secret: { privateKey: "private-key" },
      portKnockSequence: [{ port: 4000, protocol: "tcp", delay: 100 }],
    });
    const driver = new PlatformSshDriver(credentials as never);

    const connection = await resolver(driver)("project-1", "9");

    expect(connection).toMatchObject({
      projectId: "project-1",
      hostId: 42,
      authType: "key",
      secret: { privateKey: "private-key" },
      portKnockSequence: [{ port: 4000, protocol: "tcp", delay: 100 }],
    });
    expect(credentials.findProjectHostReference).not.toHaveBeenCalled();
    expect(mocks.resolveHostById).not.toHaveBeenCalled();
  });

  it("缺少项目凭据时复用原主机凭据并加密镜像", async () => {
    const credentials = createCredentialRepository();
    const driver = new PlatformSshDriver(credentials as never);

    const connection = await resolver(driver)("project-1", "9");

    expect(mocks.resolveHostById).toHaveBeenCalledWith(42, "owner-1");
    expect(connection).toMatchObject({
      projectId: "project-1",
      hostId: 42,
      username: "root",
      authType: "password",
      secret: { password: "secret-password" },
      portKnockSequence: [{ port: 4000, protocol: "tcp", delay: 100 }],
    });
    expect(credentials.ensureForProjectHost).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        projectHostId: 9,
        username: "root",
        authType: "password",
        secret: expect.objectContaining({ password: "secret-password" }),
        createdBy: "owner-1",
      }),
    );
    expect(mocks.forceSave).toHaveBeenCalledWith(
      "agent_project_credential_mirror",
    );
  });

  it("拒绝跨项目 serverId，且不会解析底层凭据", async () => {
    const credentials = createCredentialRepository();
    credentials.findProjectHostReference.mockResolvedValue({
      projectId: "project-2",
      hostId: 42,
    });
    const driver = new PlatformSshDriver(credentials as never);

    await expect(resolver(driver)("project-1", "9")).rejects.toMatchObject({
      status: 404,
      code: "PROJECT_SERVER_NOT_FOUND",
    } satisfies Partial<AgentApiError>);
    expect(mocks.resolveHostById).not.toHaveBeenCalled();
    expect(credentials.create).not.toHaveBeenCalled();
  });

  it("原主机凭据不可解密时返回明确错误", async () => {
    const credentials = createCredentialRepository();
    mocks.resolveHostById.mockResolvedValue(null);
    const driver = new PlatformSshDriver(credentials as never);

    await expect(resolver(driver)("project-1", "9")).rejects.toMatchObject({
      status: 409,
      code: "PROJECT_CREDENTIAL_UNAVAILABLE",
    } satisfies Partial<AgentApiError>);
    expect(credentials.create).not.toHaveBeenCalled();
  });
});

describe("Agent Job 输出限制", () => {
  it("保留上限内输出", () => {
    const output = new BoundedJobOutput(16);
    output.append(Buffer.from("command output"));

    expect(output.toString()).toBe("command output");
  });

  it("超过上限时截断并附加明确标记", () => {
    const output = new BoundedJobOutput(5);
    output.append(Buffer.from("abcdefgh"));
    output.append(Buffer.from("ignored"));

    expect(output.toString()).toBe("abcde\n[cloudssh: output truncated]\n");
  });
});

describe("Agent SSH 驱动关闭", () => {
  it("已取消的 Job 不解析凭据或建立连接", async () => {
    const credentials = createCredentialRepository();
    const driver = new PlatformSshDriver(credentials as never);
    const controller = new AbortController();
    controller.abort();

    await expect(
      driver.run(
        {
          jobId: "job-1",
          projectId: "project-1",
          serverId: "9",
          command: "hostname",
          timeoutMs: 5_000,
        },
        controller.signal,
      ),
    ).rejects.toThrow("Job canceled");
    expect(credentials.resolveForProjectHost).not.toHaveBeenCalled();
  });

  it("关闭操作幂等且关闭后拒绝新 Job", async () => {
    const credentials = createCredentialRepository();
    const driver = new PlatformSshDriver(credentials as never);

    const first = driver.shutdown();
    const second = driver.shutdown();

    expect(first).toBe(second);
    await first;
    await expect(
      driver.run(
        {
          jobId: "job-2",
          projectId: "project-1",
          serverId: "9",
          command: "hostname",
          timeoutMs: 5_000,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: "AGENT_SHUTTING_DOWN",
    });
    expect(credentials.resolveForProjectHost).not.toHaveBeenCalled();
  });
});

describe("Agent SSH 运行时异常", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sshClients.length = 0;
    mocks.performPortKnocking.mockResolvedValue(undefined);
  });

  it("SSH ready 后连接中断会让 Job 立即失败", async () => {
    const credentials = createCredentialRepository();
    useDirectProjectCredential(credentials);
    const driver = new PlatformSshDriver(credentials as never);
    const running = driver.run(
      {
        jobId: "job-runtime-error",
        projectId: "project-1",
        serverId: "9",
        command: "sleep 300",
        timeoutMs: 300_000,
      },
      new AbortController().signal,
    );
    await vi.waitFor(() =>
      expect(mocks.sshClients[0]?.exec).toHaveBeenCalled(),
    );

    const client = mocks.sshClients[0]!;
    client.emit("error", new Error("connection reset"));

    await expect(running).rejects.toThrow("connection reset");
    expect(client.end).toHaveBeenCalled();
    expect(() => client.emit("error", new Error("late error"))).not.toThrow();
  });

  it("持久会话连接中断会退出为 255，迟到错误不会变成未处理异常", async () => {
    const credentials = createCredentialRepository();
    useDirectProjectCredential(credentials);
    const driver = new PlatformSshDriver(credentials as never);
    const sink = {
      onOutput: vi.fn().mockResolvedValue(undefined),
      onExit: vi.fn().mockResolvedValue(undefined),
    };
    const session = agentSession("tmux", {
      id: "session-runtime-error",
      tmuxSessionName: "cloudssh-runtime-error",
    });

    await driver.create(session, sink);
    const client = mocks.sshClients[0]!;
    client.emit("error", new Error("connection reset"));

    await vi.waitFor(() =>
      expect(sink.onExit).toHaveBeenCalledWith(255, "SSH 连接已中断"),
    );
    expect(client.execChannel.destroy).toHaveBeenCalled();
    expect(client.destroy).toHaveBeenCalled();
    expect(() =>
      client.emit("error", new Error("late client error")),
    ).not.toThrow();
    expect(() =>
      client.execChannel.emit("error", new Error("late channel error")),
    ).not.toThrow();
  });

  it("通道退出前提交最后一批异步输出", async () => {
    const credentials = createCredentialRepository();
    useDirectProjectCredential(credentials);
    const driver = new PlatformSshDriver(credentials as never);
    let releaseOutput!: () => void;
    const outputGate = new Promise<void>((resolve) => {
      releaseOutput = resolve;
    });
    let outputCommitted = false;
    const sink = {
      onOutput: vi.fn(async () => {
        await outputGate;
        outputCommitted = true;
      }),
      onExit: vi.fn(async () => {
        expect(outputCommitted).toBe(true);
      }),
    };

    await driver.create(agentSession("platform"), sink);
    const channel = mocks.sshClients[0]!.shellChannel;
    channel.emit("data", Buffer.from("tail output"));
    channel.emit("close", 0);

    await vi.waitFor(() => expect(sink.onOutput).toHaveBeenCalledTimes(1));
    expect(sink.onExit).not.toHaveBeenCalled();
    releaseOutput();
    await vi.waitFor(() =>
      expect(sink.onExit).toHaveBeenCalledWith(0, undefined),
    );
  });
});

describe("Agent SSH 持续会话模式", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sshClients.length = 0;
    mocks.performPortKnocking.mockResolvedValue(undefined);
  });

  it("platform 模式打开原生 PTY 且完全不执行 tmux 命令", async () => {
    const credentials = createCredentialRepository();
    useDirectProjectCredential(credentials);
    const driver = new PlatformSshDriver(credentials as never);
    const sink = {
      onOutput: vi.fn().mockResolvedValue(undefined),
      onExit: vi.fn().mockResolvedValue(undefined),
    };

    const handle = await driver.create(agentSession("platform"), sink);
    const client = mocks.sshClients[0]!;

    expect(client.shell).toHaveBeenCalledWith(
      { term: "xterm-256color", cols: 120, rows: 30 },
      expect.any(Function),
    );
    expect(client.exec).not.toHaveBeenCalled();

    await driver.write(handle.runtimeId, "hostname\n");
    await driver.resize(handle.runtimeId, 160, 48);
    expect(client.shellChannel.write).toHaveBeenCalledWith(
      "hostname\n",
      expect.any(Function),
    );
    expect(client.shellChannel.setWindow).toHaveBeenCalledWith(48, 160, 0, 0);
  });

  it("关闭 platform 会话只关闭 Shell 和 SSH，不执行 tmux kill-session", async () => {
    const credentials = createCredentialRepository();
    useDirectProjectCredential(credentials);
    const driver = new PlatformSshDriver(credentials as never);
    const sink = {
      onOutput: vi.fn().mockResolvedValue(undefined),
      onExit: vi.fn().mockResolvedValue(undefined),
    };
    const handle = await driver.create(agentSession("platform"), sink);
    const client = mocks.sshClients[0]!;

    await driver.close(handle.runtimeId);
    client.shellChannel.emit("close", 0);
    await Promise.resolve();

    expect(client.exec).not.toHaveBeenCalled();
    expect(client.shellChannel.end).toHaveBeenCalled();
    expect(client.end).toHaveBeenCalled();
    expect(sink.onExit).not.toHaveBeenCalled();
  });

  it("显式关闭会等待已接收的异步输出提交", async () => {
    const credentials = createCredentialRepository();
    useDirectProjectCredential(credentials);
    const driver = new PlatformSshDriver(credentials as never);
    let releaseOutput!: () => void;
    const outputGate = new Promise<void>((resolve) => {
      releaseOutput = resolve;
    });
    const sink = {
      onOutput: vi.fn(() => outputGate),
      onExit: vi.fn().mockResolvedValue(undefined),
    };
    const handle = await driver.create(agentSession("platform"), sink);
    const client = mocks.sshClients[0]!;
    client.shellChannel.emit("data", Buffer.from("tail output"));
    await vi.waitFor(() => expect(sink.onOutput).toHaveBeenCalledTimes(1));

    let closed = false;
    const closing = driver.close(handle.runtimeId).then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    releaseOutput();
    await closing;

    expect(client.shellChannel.end).toHaveBeenCalled();
    expect(client.end).toHaveBeenCalled();
    expect(sink.onExit).not.toHaveBeenCalled();
  });

  it("明确拒绝恢复 platform 会话且不解析凭据", async () => {
    const credentials = createCredentialRepository();
    const driver = new PlatformSshDriver(credentials as never);
    const sink = {
      onOutput: vi.fn().mockResolvedValue(undefined),
      onExit: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      driver.recover(agentSession("platform"), sink),
    ).rejects.toMatchObject({
      status: 409,
      code: "PLATFORM_SESSION_NOT_RECOVERABLE",
    });
    expect(credentials.resolveForProjectHost).not.toHaveBeenCalled();
    expect(mocks.sshClients).toHaveLength(0);
  });

  it("tmux 模式继续创建、恢复并仅在显式关闭时杀掉远端会话", async () => {
    const credentials = createCredentialRepository();
    useDirectProjectCredential(credentials);
    const driver = new PlatformSshDriver(credentials as never);
    const sink = {
      onOutput: vi.fn().mockResolvedValue(undefined),
      onExit: vi.fn().mockResolvedValue(undefined),
    };

    const created = await driver.create(agentSession("tmux"), sink);
    const createClient = mocks.sshClients[0]!;
    expect(createClient.shell).not.toHaveBeenCalled();
    expect(createClient.exec).toHaveBeenCalledWith(
      expect.stringContaining("exec tmux new-session -A"),
      expect.objectContaining({
        pty: { term: "xterm-256color", cols: 120, rows: 30 },
      }),
      expect.any(Function),
    );

    const closing = driver.close(created.runtimeId);
    await vi.waitFor(() => expect(createClient.exec).toHaveBeenCalledTimes(2));
    expect(createClient.exec.mock.calls[1]?.[0]).toBe(
      "tmux kill-session -t cloudssh-tmux-session",
    );
    createClient.execChannel.emit("close", 0);
    await closing;
    expect(sink.onExit).not.toHaveBeenCalled();

    await driver.recover(
      agentSession("tmux", { id: "session-tmux-recover" }),
      sink,
    );
    expect(mocks.sshClients[1]?.exec).toHaveBeenCalledWith(
      expect.stringContaining("exec tmux new-session -A"),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("重启后关闭 tmux 只终止既有窗口，不会重新创建窗口", async () => {
    const credentials = createCredentialRepository();
    useDirectProjectCredential(credentials);
    const driver = new PlatformSshDriver(credentials as never);

    const closing = driver.closePersistent(agentSession("tmux"));
    await vi.waitFor(() =>
      expect(mocks.sshClients[0]?.exec).toHaveBeenCalled(),
    );
    const [command] = mocks.sshClients[0]!.exec.mock.calls[0]!;
    expect(command).toContain("tmux kill-session -t cloudssh-tmux-session");
    expect(command).not.toContain("new-session");
    mocks.sshClients[0]!.execChannel.emit("close", 0);
    await closing;

    expect(mocks.sshClients[0]!.end).toHaveBeenCalled();
  });

  it("shutdown 终止 platform 连接但只分离 tmux，且都不回调退出", async () => {
    const credentials = createCredentialRepository();
    useDirectProjectCredential(credentials);
    const driver = new PlatformSshDriver(credentials as never);
    const platformSink = {
      onOutput: vi.fn().mockResolvedValue(undefined),
      onExit: vi.fn().mockResolvedValue(undefined),
    };
    const tmuxSink = {
      onOutput: vi.fn().mockResolvedValue(undefined),
      onExit: vi.fn().mockResolvedValue(undefined),
    };

    await driver.create(agentSession("platform"), platformSink);
    await driver.create(agentSession("tmux"), tmuxSink);
    const [platformClient, tmuxClient] = mocks.sshClients;
    await driver.shutdown();

    expect(platformClient!.shellChannel.end).toHaveBeenCalled();
    expect(platformClient!.end).toHaveBeenCalled();
    expect(platformClient!.exec).not.toHaveBeenCalled();
    expect(tmuxClient!.exec).toHaveBeenCalledTimes(1);
    expect(tmuxClient!.execChannel.end).toHaveBeenCalled();
    expect(tmuxClient!.end).toHaveBeenCalled();

    platformClient!.shellChannel.emit("close", 0);
    tmuxClient!.execChannel.emit("close", 0);
    await Promise.resolve();
    expect(platformSink.onExit).not.toHaveBeenCalled();
    expect(tmuxSink.onExit).not.toHaveBeenCalled();
  });
});

describe("Agent SFTP 连接生命周期", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sshClients.length = 0;
    mocks.performPortKnocking.mockResolvedValue(undefined);
    mocks.resolveHostById.mockResolvedValue(resolvedPlatformHost());
    mocks.buildDedicatedTransferConnectConfig.mockResolvedValue({
      host: "192.0.2.42",
      port: 22,
      username: "root",
    });
    mocks.startDedicatedTransferConnect.mockImplementation(
      async (client: { connect(config: unknown): void }, config: unknown) => {
        client.connect(config);
      },
    );
  });

  it("连接或通道关闭后迟到的 error 事件仍有安全监听", async () => {
    const credentials = createCredentialRepository();
    useDirectProjectCredential(credentials);
    const driver = new PlatformSshDriver(credentials as never);

    await expect(
      driver.withSftp("project-1", "9", async () => "completed"),
    ).resolves.toBe("completed");

    expect(credentials.findProjectHostReference).toHaveBeenCalledWith(9);
    expect(mocks.resolveHostById).toHaveBeenCalledWith(42, "owner-1", 9);
    expect(mocks.buildDedicatedTransferConnectConfig).toHaveBeenCalledWith(
      expect.objectContaining({ id: 42 }),
      "owner-1",
      expect.anything(),
    );

    const client = mocks.sshClients[0]!;
    expect(() =>
      client.emit("error", new Error("late client error")),
    ).not.toThrow();
    expect(() =>
      client.sftpChannel.emit("error", new Error("late channel error")),
    ).not.toThrow();
    expect(mocks.loggerWarn).toHaveBeenCalled();
  });

  it("拒绝跨项目主机且不会解析底层凭据", async () => {
    const credentials = createCredentialRepository();
    credentials.findProjectHostReference.mockResolvedValue({
      projectId: "project-2",
      hostId: 42,
    });
    const driver = new PlatformSshDriver(credentials as never);

    await expect(
      driver.withSftp("project-1", "9", async () => "unreachable"),
    ).rejects.toMatchObject({ code: "PROJECT_SERVER_NOT_FOUND" });
    expect(mocks.resolveHostById).not.toHaveBeenCalled();
    expect(mocks.sshClients).toHaveLength(0);
  });

  it("拒绝未固定 Host Key 的主机", async () => {
    const credentials = createCredentialRepository();
    mocks.resolveHostById.mockResolvedValueOnce(
      resolvedPlatformHost({ hostKeyFingerprint: null }),
    );
    const driver = new PlatformSshDriver(credentials as never);

    await expect(
      driver.withSftp("project-1", "9", async () => "unreachable"),
    ).rejects.toMatchObject({ code: "HOST_KEY_NOT_PINNED" });
    expect(mocks.sshClients).toHaveLength(0);
  });

  it("拒绝依赖浏览器的认证方式", async () => {
    const credentials = createCredentialRepository();
    mocks.resolveHostById.mockResolvedValueOnce(
      resolvedPlatformHost({ authType: "agent" }),
    );
    const driver = new PlatformSshDriver(credentials as never);

    await expect(
      driver.withSftp("project-1", "9", async () => "unreachable"),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_AUTH_TYPE" });
    expect(mocks.sshClients).toHaveLength(0);
  });

  it("允许复用平台的 Tailscale SSH 文件连接", async () => {
    const credentials = createCredentialRepository();
    mocks.resolveHostById.mockResolvedValueOnce(
      resolvedPlatformHost({ authType: "tailscale", password: null }),
    );
    const driver = new PlatformSshDriver(credentials as never);

    await expect(
      driver.withSftp("project-1", "9", async () => "completed"),
    ).resolves.toBe("completed");
    expect(mocks.buildDedicatedTransferConnectConfig).toHaveBeenCalledWith(
      expect.objectContaining({ authType: "tailscale" }),
      "owner-1",
      expect.anything(),
    );
  });

  it("活动 SFTP 操作在 SSH 连接重置时立即失败并关闭连接", async () => {
    const credentials = createCredentialRepository();
    useDirectProjectCredential(credentials);
    const driver = new PlatformSshDriver(credentials as never);
    const operation = driver.withSftp(
      "project-1",
      "9",
      async (_sftp, operationSignal) => rejectWhenAborted(operationSignal),
    );
    await vi.waitFor(() =>
      expect(mocks.sshClients[0]?.sftp).toHaveBeenCalled(),
    );

    const client = mocks.sshClients[0]!;
    client.emit("error", new Error("connection reset"));

    await expect(operation).rejects.toThrow("connection reset");
    expect(client.destroy).toHaveBeenCalled();
  });

  it("调用方取消后等待操作清理完成再关闭 SFTP 连接", async () => {
    const credentials = createCredentialRepository();
    useDirectProjectCredential(credentials);
    const driver = new PlatformSshDriver(credentials as never);
    const controller = new AbortController();
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let cleanupStarted = false;
    const operation = driver.withSftp(
      "project-1",
      "9",
      async (_sftp, operationSignal) => {
        try {
          await rejectWhenAborted(operationSignal);
        } finally {
          cleanupStarted = true;
          await cleanupGate;
        }
      },
      controller.signal,
    );
    await vi.waitFor(() =>
      expect(mocks.sshClients[0]?.sftp).toHaveBeenCalled(),
    );
    const client = mocks.sshClients[0]!;
    let settled = false;
    void operation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    controller.abort(new Error("request disconnected"));
    await vi.waitFor(() => expect(cleanupStarted).toBe(true));
    expect(settled).toBe(false);
    expect(client.destroy).not.toHaveBeenCalled();

    releaseCleanup();
    await expect(operation).rejects.toThrow("request disconnected");
    expect(client.destroy).toHaveBeenCalled();
  });

  it("操作忽略取消信号时在清理宽限期后强制关闭", async () => {
    const credentials = createCredentialRepository();
    useDirectProjectCredential(credentials);
    const driver = new PlatformSshDriver(
      credentials as never,
      Buffer.alloc(32),
      10,
      10,
    );

    await expect(
      driver.withSftp(
        "project-1",
        "9",
        async () => new Promise<never>(() => undefined),
      ),
    ).rejects.toMatchObject({ code: "SFTP_CLEANUP_TIMEOUT" });
    expect(mocks.sshClients[0]?.destroy).toHaveBeenCalled();
  });

  it("SFTP 截止时间和调用方取消都会终止活动连接", async () => {
    const timeoutCredentials = createCredentialRepository();
    useDirectProjectCredential(timeoutCredentials);
    const timeoutDriver = new PlatformSshDriver(
      timeoutCredentials as never,
      Buffer.alloc(32),
      10,
    );
    const timedOut = timeoutDriver.withSftp(
      "project-1",
      "9",
      async (_sftp, operationSignal) => rejectWhenAborted(operationSignal),
    );
    await expect(timedOut).rejects.toMatchObject({
      code: "SFTP_OPERATION_TIMEOUT",
    });
    expect(mocks.sshClients[0]?.destroy).toHaveBeenCalled();

    mocks.sshClients.length = 0;
    const cancelCredentials = createCredentialRepository();
    useDirectProjectCredential(cancelCredentials);
    const cancelDriver = new PlatformSshDriver(cancelCredentials as never);
    const controller = new AbortController();
    const canceled = cancelDriver.withSftp(
      "project-1",
      "9",
      async (_sftp, operationSignal) => rejectWhenAborted(operationSignal),
      controller.signal,
    );
    await vi.waitFor(() =>
      expect(mocks.sshClients[0]?.sftp).toHaveBeenCalled(),
    );
    controller.abort(new Error("request disconnected"));

    await expect(canceled).rejects.toThrow("request disconnected");
    expect(mocks.sshClients[0]?.destroy).toHaveBeenCalled();
  });

  it("端口敲门等待同样受 SFTP 截止时间约束", async () => {
    const credentials = createCredentialRepository();
    mocks.resolveHostById.mockResolvedValueOnce(
      resolvedPlatformHost({
        portKnockSequence: [{ port: 4000, protocol: "tcp", delay: 60_000 }],
      }),
    );
    mocks.performPortKnocking.mockImplementationOnce(
      (
        _host: string,
        _sequence: unknown,
        options?: { signal?: AbortSignal },
      ) =>
        options?.signal
          ? rejectWhenAborted(options.signal)
          : new Promise<void>(() => undefined),
    );
    const driver = new PlatformSshDriver(
      credentials as never,
      Buffer.alloc(32),
      10,
    );

    await expect(
      driver.withSftp("project-1", "9", async () => "unreachable"),
    ).rejects.toMatchObject({ code: "SFTP_OPERATION_TIMEOUT" });
    expect(mocks.performPortKnocking).toHaveBeenCalledWith(
      "192.0.2.42",
      [{ port: 4000, protocol: "tcp", delay: 60_000 }],
      { signal: expect.any(AbortSignal) },
    );
    expect(mocks.sshClients).toHaveLength(0);
  });
});
