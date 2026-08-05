import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SFTPWrapper } from "ssh2";
import { Readable, Writable } from "node:stream";
import { AgentApiError } from "./errors.js";
import { AGENT_FILE_LIMITS, PlatformAgentFileService } from "./files.js";
import type { AgentPrincipal } from "./types.js";
import { MemoryAgentStateStore } from "./store.js";

function principal(scopes: AgentPrincipal["scopes"]): AgentPrincipal {
  return {
    principalId: "device:test",
    serviceAccountId: "service:test",
    projectId: "project:test",
    projectIds: ["project:test"],
    scopes,
    serverIds: ["42"],
    serverProjectIds: { "42": "project:test" },
    maxConcurrentSessions: 2,
    name: "test-device",
  };
}

function stats(overrides: Record<string, unknown> = {}) {
  return {
    mode: 0o100644,
    uid: 0,
    gid: 0,
    size: 5,
    atime: 0,
    mtime: 1_700_000_000,
    isDirectory: () => false,
    isFile: () => true,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    ...overrides,
  };
}

function fakeSftp(): SFTPWrapper {
  let directoryRead = false;
  let uploadedSize: number | null = null;
  const directoryEntries = [
    {
      filename: "config.ini",
      longname: "-rw-r--r-- 1 root root 5",
      attrs: stats(),
    },
  ];
  const sftp = {
    opendir: vi.fn(
      (_path: string, callback: (error?: Error, handle?: Buffer) => void) => {
        directoryRead = false;
        callback(undefined, Buffer.from("directory-handle"));
      },
    ),
    readdir: vi.fn(
      (
        location: string | Buffer,
        callback: (error?: Error, entries?: unknown[]) => void,
      ) => {
        if (Buffer.isBuffer(location)) {
          if (!directoryRead) {
            directoryRead = true;
            callback(undefined, directoryEntries);
          } else {
            callback(Object.assign(new Error("EOF"), { code: 1 }));
          }
          return;
        }
        callback(undefined, directoryEntries);
      },
    ),
    stat: vi.fn(
      (_path: string, callback: (error?: Error, value?: unknown) => void) =>
        callback(
          undefined,
          stats({ size: uploadedSize === null ? 5 : uploadedSize }),
        ),
    ),
    lstat: vi.fn(
      (_path: string, callback: (error?: Error, value?: unknown) => void) =>
        callback(undefined, stats()),
    ),
    readFile: vi.fn(
      (_path: string, callback: (error?: Error, value?: Buffer) => void) =>
        callback(undefined, Buffer.from("hello")),
    ),
    open: vi.fn(
      (
        _path: string,
        _flags: string,
        callback: (error?: Error, handle?: Buffer) => void,
      ) => callback(undefined, Buffer.from("handle")),
    ),
    read: vi.fn(
      (
        _handle: Buffer,
        buffer: Buffer,
        offset: number,
        _length: number,
        position: number,
        callback: (error?: Error, bytesRead?: number) => void,
      ) => {
        const data = position === 0 ? Buffer.from("hello") : Buffer.alloc(0);
        data.copy(buffer, offset);
        callback(undefined, data.length);
      },
    ),
    close: vi.fn((_handle: Buffer, callback: (error?: Error) => void) =>
      callback(),
    ),
    createReadStream: vi.fn(() => Readable.from([Buffer.from("hello")])),
    createWriteStream: vi.fn(() => {
      let bytes = 0;
      return new Writable({
        write(value, _encoding, callback) {
          bytes += Buffer.byteLength(value);
          callback();
        },
        final(callback) {
          uploadedSize = bytes;
          callback();
        },
      });
    }),
    writeFile: vi.fn(
      (
        _path: string,
        _data: Buffer,
        _options: unknown,
        callback: (error?: Error) => void,
      ) => {
        uploadedSize = _data.length;
        callback();
      },
    ),
    mkdir: vi.fn(
      (_path: string, _attrs: unknown, callback: (error?: Error) => void) =>
        callback(),
    ),
    rename: vi.fn(
      (
        _source: string,
        _destination: string,
        callback: (error?: Error) => void,
      ) => callback(),
    ),
    ext_openssh_rename: vi.fn(
      (
        _source: string,
        _destination: string,
        callback: (error?: Error) => void,
      ) => callback(),
    ),
    chmod: vi.fn(
      (_path: string, _mode: number, callback: (error?: Error) => void) =>
        callback(),
    ),
    unlink: vi.fn((_path: string, callback: (error?: Error) => void) =>
      callback(),
    ),
    rmdir: vi.fn((_path: string, callback: (error?: Error) => void) =>
      callback(),
    ),
  } as unknown as SFTPWrapper;
  return sftp;
}

function fileRequestProof(data: Buffer): string {
  return `test-proof:${data.toString("hex")}`;
}

async function fileRequestProofStream(
  data: Readable,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<{ contentProof: string; size: number; sha256: string }> {
  const chunks: Buffer[] = [];
  const hash = crypto.createHash("sha256");
  let size = 0;
  for await (const value of data) {
    if (signal?.aborted) throw signal.reason;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (size + chunk.length > maximumBytes) {
      throw new AgentApiError(
        409,
        "UPLOAD_SOURCE_CHANGED",
        "上传临时文件在鉴权后发生变化，未替换目标文件",
      );
    }
    chunks.push(chunk);
    hash.update(chunk);
    size += chunk.length;
  }
  return {
    contentProof: fileRequestProof(Buffer.concat(chunks, size)),
    size,
    sha256: hash.digest("hex"),
  };
}

const activeSignal = new AbortController().signal;

function downloadBuffer(
  service: PlatformAgentFileService,
  actor: AgentPrincipal,
  serverId: string,
  remotePath: string,
) {
  const chunks: Buffer[] = [];
  const destination = new Writable({
    write(value, _encoding, callback) {
      chunks.push(Buffer.from(value));
      callback();
    },
  });
  return service
    .download(actor, serverId, remotePath, () => destination)
    .then((result) => ({ result, data: Buffer.concat(chunks) }));
}

function invokeFileOperation(
  service: PlatformAgentFileService,
  actor: AgentPrincipal,
  operation:
    | "list"
    | "read"
    | "download"
    | "upload"
    | "mkdir"
    | "rename"
    | "delete",
  suffix: string,
): Promise<unknown> {
  switch (operation) {
    case "list":
      return service.list(actor, "42", `/tmp/${suffix}`);
    case "read":
      return service.read(actor, "42", `/tmp/${suffix}`);
    case "download":
      return downloadBuffer(service, actor, "42", `/tmp/${suffix}`);
    case "upload":
      return service.upload(
        actor,
        "42",
        `/tmp/${suffix}`,
        Buffer.from(suffix),
        `upload-${suffix}`,
      );
    case "mkdir":
      return service.mkdir(
        actor,
        "42",
        `/tmp/${suffix}`,
        false,
        `mkdir-${suffix}`,
      );
    case "rename":
      return service.rename(
        actor,
        "42",
        `/tmp/${suffix}-from`,
        `/tmp/${suffix}-to`,
        `rename-${suffix}`,
      );
    case "delete":
      return service.delete(
        actor,
        "42",
        `/tmp/${suffix}`,
        false,
        `delete-${suffix}`,
      );
  }
}

describe("Agent SFTP 文件服务", () => {
  it("按 files:read 列出和读取文件，且不允许写操作", async () => {
    const sftp = fakeSftp();
    const connector = {
      fileRequestProof,
      withSftp: vi.fn(
        async (
          _project: string,
          _server: string,
          operation: (
            value: SFTPWrapper,
            signal: AbortSignal,
          ) => Promise<unknown>,
        ) => operation(sftp, activeSignal),
      ),
    };
    const service = new PlatformAgentFileService(
      connector,
      new MemoryAgentStateStore(),
    );
    await expect(
      service.list(principal(["files:read"]), "42", "/etc//"),
    ).resolves.toMatchObject({
      path: "/etc",
      files: [{ name: "config.ini", path: "/etc/config.ini" }],
    });
    await expect(
      service.read(principal(["files:read"]), "42", "/etc/config.ini"),
    ).resolves.toMatchObject({ content: "hello", size: 5, truncated: false });
    await expect(
      downloadBuffer(
        service,
        principal(["files:read"]),
        "42",
        "/etc/config.ini",
      ),
    ).resolves.toMatchObject({
      result: { serverId: "42", path: "/etc/config.ini", size: 5 },
      data: Buffer.from("hello"),
    });
    await expect(
      service.mkdir(
        principal(["files:read"]),
        "42",
        "/tmp/new",
        false,
        "mkdir-read-denied",
      ),
    ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  });

  it("大型文本预览会循环读取到上限并标记截断", async () => {
    const half = AGENT_FILE_LIMITS.maxReadBytes / 2;
    let reads = 0;
    const requestedLengths: number[] = [];
    const sftp = {
      stat: (
        _path: string,
        callback: (error?: Error, value?: unknown) => void,
      ) =>
        callback(
          undefined,
          stats({ size: AGENT_FILE_LIMITS.maxReadBytes + 1 }),
        ),
      open: (
        _path: string,
        _flags: string,
        callback: (error?: Error, handle?: Buffer) => void,
      ) => callback(undefined, Buffer.from("handle")),
      read: (
        _handle: Buffer,
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
        callback: (
          error?: Error,
          bytesRead?: number,
          output?: Buffer,
          outputPosition?: number,
        ) => void,
      ) => {
        requestedLengths.push(length);
        const count = length;
        buffer.fill(position < half ? 0x61 : 0x62, offset, offset + count);
        reads += 1;
        callback(undefined, count, buffer, position);
      },
      close: (_handle: Buffer, callback: (error?: Error) => void) => callback(),
    } as unknown as SFTPWrapper;
    const service = new PlatformAgentFileService(
      {
        fileRequestProof,
        fileRequestProofStream,
        withSftp: async (_project, _server, operation) =>
          operation(sftp, activeSignal),
      },
      new MemoryAgentStateStore(),
    );

    const result = await service.read(
      principal(["files:read"]),
      "42",
      "/var/log/large.log",
    );

    expect(result).toMatchObject({
      path: "/var/log/large.log",
      size: AGENT_FILE_LIMITS.maxReadBytes + 1,
      truncated: true,
    });
    expect(Buffer.byteLength(result.content)).toBe(
      AGENT_FILE_LIMITS.maxReadBytes,
    );
    expect(result.content.startsWith("a")).toBe(true);
    expect(result.content.endsWith("b")).toBe(true);
    expect(reads).toBe(
      Math.ceil(
        (AGENT_FILE_LIMITS.maxReadBytes + 1) /
          AGENT_FILE_LIMITS.maxReadChunkBytes,
      ),
    );
    expect(Math.max(...requestedLengths)).toBeLessThanOrEqual(
      AGENT_FILE_LIMITS.maxReadChunkBytes,
    );
  });

  it("拒绝 SFTP 服务返回超过分块缓冲区的读取长度", async () => {
    const close = vi.fn((_handle: Buffer, callback: (error?: Error) => void) =>
      callback(),
    );
    const sftp = {
      stat: (
        _path: string,
        callback: (error?: Error, value?: unknown) => void,
      ) => callback(undefined, stats({ size: 1 })),
      open: (
        _path: string,
        _flags: string,
        callback: (error?: Error, handle?: Buffer) => void,
      ) => callback(undefined, Buffer.from("handle")),
      read: (
        _handle: Buffer,
        _buffer: Buffer,
        _offset: number,
        length: number,
        _position: number,
        callback: (error?: Error, bytesRead?: number) => void,
      ) => callback(undefined, length + 1),
      close,
    } as unknown as SFTPWrapper;
    const service = new PlatformAgentFileService(
      {
        fileRequestProof,
        withSftp: async (_project, _server, operation) =>
          operation(sftp, activeSignal),
      },
      new MemoryAgentStateStore(),
    );

    await expect(
      service.read(principal(["files:read"]), "42", "/tmp/invalid-read-length"),
    ).rejects.toMatchObject({ code: "INVALID_SFTP_RESPONSE" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("写入、移动和删除使用 files:write，并拒绝未授权服务器", async () => {
    const sftp = fakeSftp();
    const connector = {
      fileRequestProof,
      withSftp: vi.fn(
        async (
          _project: string,
          _server: string,
          operation: (
            value: SFTPWrapper,
            signal: AbortSignal,
          ) => Promise<unknown>,
        ) => operation(sftp, activeSignal),
      ),
    };
    const service = new PlatformAgentFileService(
      connector,
      new MemoryAgentStateStore(),
    );
    const writePrincipal = principal(["files:write"]);
    const uploadStages: string[] = [];
    await expect(
      service.upload(
        writePrincipal,
        "42",
        "/tmp/a",
        Buffer.from("data"),
        "upload-a",
        undefined,
        () => uploadStages.push("committed"),
        () => uploadStages.push("dispatched"),
      ),
    ).resolves.toMatchObject({ size: 4 });
    expect(uploadStages).toEqual(["dispatched", "committed"]);
    const temporaryPath = vi.mocked(sftp.writeFile).mock.calls[0]?.[0];
    expect(temporaryPath).toMatch(/^\/tmp\/\.cloudssh-upload-[0-9a-f-]+\.tmp$/);
    expect(sftp.writeFile).toHaveBeenCalledWith(
      temporaryPath,
      Buffer.from("data"),
      { flag: "wx", mode: 0o600 },
      expect.any(Function),
    );
    expect(sftp.ext_openssh_rename).toHaveBeenCalledWith(
      temporaryPath,
      "/tmp/a",
      expect.any(Function),
    );
    expect(sftp.chmod).toHaveBeenCalledWith(
      temporaryPath,
      0o644,
      expect.any(Function),
    );
    await expect(
      service.rename(writePrincipal, "42", "/tmp/a", "/tmp/b", "rename-a-b"),
    ).resolves.toMatchObject({ destinationPath: "/tmp/b" });
    await expect(
      service.delete(writePrincipal, "42", "/tmp/b", false, "delete-b"),
    ).resolves.toMatchObject({ path: "/tmp/b" });
    await expect(
      service.list(writePrincipal, "99", "/"),
    ).rejects.toBeInstanceOf(AgentApiError);
  });

  it("回放相同文件写请求并拒绝同一幂等键对应不同正文", async () => {
    const sftp = fakeSftp();
    const connector = {
      fileRequestProof,
      withSftp: vi.fn(
        async (
          _project: string,
          _server: string,
          operation: (
            value: SFTPWrapper,
            signal: AbortSignal,
          ) => Promise<unknown>,
        ) => operation(sftp, activeSignal),
      ),
    };
    const service = new PlatformAgentFileService(
      connector,
      new MemoryAgentStateStore(),
    );
    const actor = principal(["files:write"]);
    const first = await service.upload(
      actor,
      "42",
      "/tmp/replayed.bin",
      Buffer.from("first"),
      "same-upload",
    );
    const replayed = await service.upload(
      actor,
      "42",
      "/tmp/replayed.bin",
      Buffer.from("first"),
      "same-upload",
    );
    expect(replayed).toEqual(first);
    expect(connector.withSftp).toHaveBeenCalledTimes(1);
    await expect(
      service.upload(
        actor,
        "42",
        "/tmp/replayed.bin",
        Buffer.from("other"),
        "same-upload",
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("连接失败发生在远端修改下发前时允许同一幂等键安全重试", async () => {
    const sftp = fakeSftp();
    const connector = {
      fileRequestProof,
      withSftp: vi
        .fn()
        .mockRejectedValueOnce(new Error("connection refused"))
        .mockImplementationOnce(
          async (
            _project: string,
            _server: string,
            operation: (
              value: SFTPWrapper,
              signal: AbortSignal,
            ) => Promise<unknown>,
          ) => operation(sftp, activeSignal),
        ),
    };
    const service = new PlatformAgentFileService(
      connector,
      new MemoryAgentStateStore(),
    );
    const actor = principal(["files:write"]);
    await expect(
      service.rename(actor, "42", "/tmp/a", "/tmp/b", "retry-rename"),
    ).rejects.toThrow("connection refused");
    await expect(
      service.rename(actor, "42", "/tmp/a", "/tmp/b", "retry-rename"),
    ).resolves.toMatchObject({ destinationPath: "/tmp/b" });
    expect(connector.withSftp).toHaveBeenCalledTimes(2);
  });

  it("远端修改下发后结果不确定时拒绝自动重放", async () => {
    const sftp = fakeSftp();
    vi.mocked(sftp.rename).mockImplementation(
      (_source, _destination, callback) =>
        callback(new Error("connection closed after request")),
    );
    const connector = {
      fileRequestProof,
      withSftp: vi.fn(
        async (
          _project: string,
          _server: string,
          operation: (
            value: SFTPWrapper,
            signal: AbortSignal,
          ) => Promise<unknown>,
        ) => operation(sftp, activeSignal),
      ),
    };
    const service = new PlatformAgentFileService(
      connector,
      new MemoryAgentStateStore(),
    );
    const actor = principal(["files:write"]);
    const committed = vi.fn();
    const dispatched = vi.fn();
    await expect(
      service.rename(
        actor,
        "42",
        "/tmp/a",
        "/tmp/b",
        "uncertain-rename",
        undefined,
        committed,
        dispatched,
      ),
    ).rejects.toThrow("connection closed after request");
    expect(dispatched).toHaveBeenCalledOnce();
    expect(committed).not.toHaveBeenCalled();
    const replayDispatched = vi.fn();
    await expect(
      service.rename(
        actor,
        "42",
        "/tmp/a",
        "/tmp/b",
        "uncertain-rename",
        undefined,
        undefined,
        replayDispatched,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_OUTCOME_UNKNOWN" });
    expect(replayDispatched).toHaveBeenCalledOnce();
    expect(connector.withSftp).toHaveBeenCalledTimes(1);
  });

  it("防重状态落盘期间取消时不会下发远端修改", async () => {
    const sftp = fakeSftp();
    const backingStore = new MemoryAgentStateStore();
    const controller = new AbortController();
    let updates = 0;
    let releaseDispatch!: () => void;
    let notifyDispatch!: () => void;
    const dispatchEntered = new Promise<void>((resolve) => {
      notifyDispatch = resolve;
    });
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const state = {
      read: () => backingStore.read(),
      update: async <T>(
        mutator: Parameters<MemoryAgentStateStore["update"]>[0],
      ) => {
        updates += 1;
        const result = await backingStore.update(mutator);
        if (updates === 2) {
          notifyDispatch();
          await dispatchGate;
        }
        return result as T;
      },
    };
    const service = new PlatformAgentFileService(
      {
        fileRequestProof,
        withSftp: async (_project, _server, operation) =>
          operation(sftp, controller.signal),
      },
      state,
    );

    const renaming = service.rename(
      principal(["files:write"]),
      "42",
      "/tmp/a",
      "/tmp/b",
      "cancel-during-dispatch",
      controller.signal,
    );
    await dispatchEntered;
    controller.abort(new Error("request canceled"));
    releaseDispatch();

    await expect(renaming).rejects.toThrow("request canceled");
    expect(sftp.rename).not.toHaveBeenCalled();
  });

  it("远端提交后防重结果落盘失败时仍立即标记审计已提交", async () => {
    const sftp = fakeSftp();
    const backingStore = new MemoryAgentStateStore();
    let updates = 0;
    const state = {
      read: () => backingStore.read(),
      update: async <T>(
        mutator: Parameters<MemoryAgentStateStore["update"]>[0],
      ) => {
        updates += 1;
        if (updates === 3) throw new Error("result persistence failed");
        return backingStore.update(mutator) as Promise<T>;
      },
    };
    const service = new PlatformAgentFileService(
      {
        fileRequestProof,
        withSftp: async (_project, _server, operation) =>
          operation(sftp, activeSignal),
      },
      state,
    );
    const committed = vi.fn();

    await expect(
      service.rename(
        principal(["files:write"]),
        "42",
        "/tmp/a",
        "/tmp/b",
        "commit-before-persist",
        undefined,
        committed,
      ),
    ).rejects.toThrow("result persistence failed");
    expect(sftp.rename).toHaveBeenCalledOnce();
    expect(committed).toHaveBeenCalledOnce();
    await expect(
      service.rename(
        principal(["files:write"]),
        "42",
        "/tmp/a",
        "/tmp/b",
        "commit-before-persist",
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_OUTCOME_UNKNOWN" });
  });

  it("覆盖已有文件时在原子替换前保留原权限", async () => {
    const sftp = fakeSftp();
    vi.mocked(sftp.lstat).mockImplementation((remotePath, callback) => {
      expect(remotePath).toBe("/tmp/deploy.sh");
      callback(undefined, stats({ mode: 0o100755 }) as never);
    });
    const service = new PlatformAgentFileService(
      {
        fileRequestProof,
        withSftp: async (_project, _server, operation) =>
          operation(sftp, activeSignal),
      },
      new MemoryAgentStateStore(),
    );

    await service.upload(
      principal(["files:write"]),
      "42",
      "/tmp/deploy.sh",
      Buffer.from("#!/bin/sh\n"),
      "preserve-executable-mode",
    );

    const temporaryPath = vi.mocked(sftp.writeFile).mock.calls[0]?.[0];
    expect(sftp.chmod).toHaveBeenCalledWith(
      temporaryPath,
      0o755,
      expect.any(Function),
    );
    expect(vi.mocked(sftp.chmod).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sftp.ext_openssh_rename).mock.invocationCallOrder[0]!,
    );
  });

  it("新文件保持安全的 0600 默认权限", async () => {
    const sftp = fakeSftp();
    vi.mocked(sftp.lstat).mockImplementation((_remotePath, callback) =>
      callback(Object.assign(new Error("not found"), { code: 2 })),
    );
    const service = new PlatformAgentFileService(
      {
        fileRequestProof,
        withSftp: async (_project, _server, operation) =>
          operation(sftp, activeSignal),
      },
      new MemoryAgentStateStore(),
    );

    await service.upload(
      principal(["files:write"]),
      "42",
      "/tmp/new.txt",
      Buffer.from("new"),
      "new-file-mode",
    );

    expect(sftp.chmod).not.toHaveBeenCalled();
    expect(sftp.writeFile).toHaveBeenCalledWith(
      expect.any(String),
      Buffer.from("new"),
      { flag: "wx", mode: 0o600 },
      expect.any(Function),
    );
  });

  it("经鉴权的上传源以流方式写入 SFTP 且再次核对摘要", async () => {
    const sftp = fakeSftp();
    const payload = Buffer.from("streamed-upload-payload");
    const openStream = vi.fn(() =>
      Readable.from([payload.subarray(0, 7), payload.subarray(7)]),
    );
    const service = new PlatformAgentFileService(
      {
        fileRequestProof,
        fileRequestProofStream,
        withSftp: async (_project, _server, operation) =>
          operation(sftp, activeSignal),
      },
      new MemoryAgentStateStore(),
    );

    await expect(
      service.upload(
        principal(["files:write"]),
        "42",
        "/tmp/streamed.bin",
        {
          size: payload.length,
          sha256: crypto.createHash("sha256").update(payload).digest("hex"),
          openStream,
        },
        "streamed-upload",
      ),
    ).resolves.toMatchObject({ size: payload.length });

    expect(openStream).toHaveBeenCalledTimes(2);
    expect(sftp.writeFile).not.toHaveBeenCalled();
    expect(sftp.createWriteStream).toHaveBeenCalledWith(
      expect.stringMatching(/\.cloudssh-upload-[0-9a-f-]+\.tmp$/),
      { flags: "wx", mode: 0o600 },
    );
    expect(sftp.ext_openssh_rename).toHaveBeenCalledOnce();
  });

  it("流式上传源在鉴权后变化时于建立 SFTP 前拒绝提交", async () => {
    const sftp = fakeSftp();
    const authenticated = Buffer.from("authenticated-content");
    const changed = Buffer.from("changed-content");
    const connector = {
      fileRequestProof,
      fileRequestProofStream,
      withSftp: vi.fn(async (_project, _server, operation) =>
        operation(sftp, activeSignal),
      ),
    };
    const service = new PlatformAgentFileService(
      connector,
      new MemoryAgentStateStore(),
    );

    await expect(
      service.upload(
        principal(["files:write"]),
        "42",
        "/tmp/changed.bin",
        {
          size: changed.length,
          sha256: crypto
            .createHash("sha256")
            .update(authenticated)
            .digest("hex"),
          openStream: () => Readable.from([changed]),
        },
        "changed-stream-upload",
      ),
    ).rejects.toMatchObject({ code: "UPLOAD_SOURCE_CHANGED" });

    expect(connector.withSftp).not.toHaveBeenCalled();
    expect(sftp.ext_openssh_rename).not.toHaveBeenCalled();
    expect(sftp.unlink).not.toHaveBeenCalled();
  });

  it("流式上传幂等重放重新验证本地文件但不重复建立 SFTP 写流", async () => {
    const sftp = fakeSftp();
    const payload = Buffer.from("replay-stream");
    const openStream = vi.fn(() => Readable.from([payload]));
    const service = new PlatformAgentFileService(
      {
        fileRequestProof,
        fileRequestProofStream,
        withSftp: async (_project, _server, operation) =>
          operation(sftp, activeSignal),
      },
      new MemoryAgentStateStore(),
    );
    const source = {
      size: payload.length,
      sha256: crypto.createHash("sha256").update(payload).digest("hex"),
      openStream,
    };

    const first = await service.upload(
      principal(["files:write"]),
      "42",
      "/tmp/replayed-stream.bin",
      source,
      "replayed-stream-upload",
    );
    const replayed = await service.upload(
      principal(["files:write"]),
      "42",
      "/tmp/replayed-stream.bin",
      source,
      "replayed-stream-upload",
    );

    expect(replayed).toEqual(first);
    expect(openStream).toHaveBeenCalledTimes(3);
    expect(sftp.createWriteStream).toHaveBeenCalledOnce();
  });

  it("流式上传可重放升级前 Buffer 上传留下的幂等记录", async () => {
    const sftp = fakeSftp();
    const payload = Buffer.from("legacy-buffer-upload");
    const openStream = vi.fn(() => Readable.from([payload]));
    const connector = {
      fileRequestProof,
      fileRequestProofStream,
      withSftp: vi.fn(async (_project, _server, operation) =>
        operation(sftp, activeSignal),
      ),
    };
    const service = new PlatformAgentFileService(
      connector,
      new MemoryAgentStateStore(),
    );
    const actor = principal(["files:write"]);

    const legacy = await service.upload(
      actor,
      "42",
      "/tmp/legacy.bin",
      payload,
      "legacy-upload-replay",
    );
    const replayed = await service.upload(
      actor,
      "42",
      "/tmp/legacy.bin",
      {
        size: payload.length,
        sha256: crypto.createHash("sha256").update(payload).digest("hex"),
        openStream,
      },
      "legacy-upload-replay",
    );

    expect(replayed).toEqual(legacy);
    expect(openStream).toHaveBeenCalledOnce();
    expect(connector.withSftp).toHaveBeenCalledOnce();
    expect(sftp.writeFile).toHaveBeenCalledOnce();
    expect(sftp.createWriteStream).not.toHaveBeenCalled();
  });

  it("旧 Buffer 上传结果未知记录经流式重试仍返回结果未知", async () => {
    const sftp = fakeSftp();
    vi.mocked(sftp.ext_openssh_rename).mockImplementation(
      (_source, _destination, callback) =>
        callback(new Error("connection closed after upload dispatch")),
    );
    const payload = Buffer.from("legacy-dispatched-upload");
    const openStream = vi.fn(() => Readable.from([payload]));
    const connector = {
      fileRequestProof,
      fileRequestProofStream,
      withSftp: vi.fn(async (_project, _server, operation) =>
        operation(sftp, activeSignal),
      ),
    };
    const service = new PlatformAgentFileService(
      connector,
      new MemoryAgentStateStore(),
    );
    const actor = principal(["files:write"]);

    await expect(
      service.upload(
        actor,
        "42",
        "/tmp/uncertain.bin",
        payload,
        "legacy-dispatched-replay",
      ),
    ).rejects.toThrow("connection closed after upload dispatch");
    await expect(
      service.upload(
        actor,
        "42",
        "/tmp/uncertain.bin",
        {
          size: payload.length,
          sha256: crypto.createHash("sha256").update(payload).digest("hex"),
          openStream,
        },
        "legacy-dispatched-replay",
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_OUTCOME_UNKNOWN" });

    expect(openStream).toHaveBeenCalledOnce();
    expect(connector.withSftp).toHaveBeenCalledOnce();
    expect(sftp.createWriteStream).not.toHaveBeenCalled();
  });

  it("流式上传声明大小超过上限时不打开文件或建立 SFTP 连接", async () => {
    const openStream = vi.fn(() => Readable.from([]));
    const connector = {
      fileRequestProof,
      withSftp: vi.fn(),
    };
    const service = new PlatformAgentFileService(
      connector,
      new MemoryAgentStateStore(),
    );

    await expect(
      service.upload(
        principal(["files:write"]),
        "42",
        "/tmp/oversized.bin",
        {
          size: AGENT_FILE_LIMITS.maxTransferBytes + 1,
          sha256: crypto.createHash("sha256").digest("hex"),
          openStream,
        },
        "oversized-stream-upload",
      ),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });

    expect(openStream).not.toHaveBeenCalled();
    expect(connector.withSftp).not.toHaveBeenCalled();
  });

  it("SFTP 不支持原子扩展时仅为不存在的目标回退标准 rename", async () => {
    const sftp = fakeSftp();
    vi.mocked(sftp.lstat).mockImplementation((_remotePath, callback) =>
      callback(Object.assign(new Error("not found"), { code: 2 })),
    );
    vi.mocked(sftp.ext_openssh_rename).mockImplementation(
      (_source, _destination, callback) =>
        callback(
          Object.assign(new Error("operation unsupported"), { code: 8 }),
        ),
    );
    const service = new PlatformAgentFileService(
      {
        fileRequestProof,
        withSftp: async (_project, _server, operation) =>
          operation(sftp, activeSignal),
      },
      new MemoryAgentStateStore(),
    );

    await expect(
      service.upload(
        principal(["files:write"]),
        "42",
        "/tmp/new-standard-rename.txt",
        Buffer.from("new"),
        "fallback-standard-rename",
      ),
    ).resolves.toMatchObject({ path: "/tmp/new-standard-rename.txt" });

    const temporaryPath = vi.mocked(sftp.writeFile).mock.calls[0]?.[0];
    expect(sftp.ext_openssh_rename).toHaveBeenCalledOnce();
    expect(sftp.rename).toHaveBeenCalledWith(
      temporaryPath,
      "/tmp/new-standard-rename.txt",
      expect.any(Function),
    );
    expect(sftp.unlink).not.toHaveBeenCalled();
  });

  it("SFTP 不支持原子扩展时拒绝用标准 rename 覆盖已有目标", async () => {
    const sftp = fakeSftp();
    vi.mocked(sftp.ext_openssh_rename).mockImplementation(
      (_source, _destination, callback) =>
        callback(
          Object.assign(new Error("operation unsupported"), { code: 8 }),
        ),
    );
    const service = new PlatformAgentFileService(
      {
        fileRequestProof,
        withSftp: async (_project, _server, operation) =>
          operation(sftp, activeSignal),
      },
      new MemoryAgentStateStore(),
    );

    await expect(
      service.upload(
        principal(["files:write"]),
        "42",
        "/tmp/existing.txt",
        Buffer.from("replacement"),
        "reject-non-atomic-overwrite",
      ),
    ).rejects.toMatchObject({ code: "ATOMIC_RENAME_UNSUPPORTED" });

    const temporaryPath = vi.mocked(sftp.writeFile).mock.calls[0]?.[0];
    expect(sftp.rename).not.toHaveBeenCalled();
    expect(sftp.unlink).toHaveBeenCalledWith(
      temporaryPath,
      expect.any(Function),
    );
  });

  it("拒绝覆盖符号链接且清理上传临时文件", async () => {
    const sftp = fakeSftp();
    vi.mocked(sftp.lstat).mockImplementation((_remotePath, callback) =>
      callback(
        undefined,
        stats({
          mode: 0o120777,
          isFile: () => false,
          isSymbolicLink: () => true,
        }) as never,
      ),
    );
    const service = new PlatformAgentFileService(
      {
        fileRequestProof,
        withSftp: async (_project, _server, operation) =>
          operation(sftp, activeSignal),
      },
      new MemoryAgentStateStore(),
    );

    await expect(
      service.upload(
        principal(["files:write"]),
        "42",
        "/tmp/current",
        Buffer.from("replacement"),
        "reject-symlink-upload",
      ),
    ).rejects.toMatchObject({ code: "SYMLINK_UPLOAD_DENIED" });

    const temporaryPath = vi.mocked(sftp.writeFile).mock.calls[0]?.[0];
    expect(sftp.chmod).not.toHaveBeenCalled();
    expect(sftp.ext_openssh_rename).not.toHaveBeenCalled();
    expect(sftp.unlink).toHaveBeenCalledWith(
      temporaryPath,
      expect.any(Function),
    );
  });

  it("上传取消后先清理远端临时文件再返回", async () => {
    const sftp = fakeSftp();
    let finishStat!: () => void;
    vi.mocked(sftp.stat).mockImplementation((_remotePath, callback) => {
      finishStat = () => callback(undefined, stats({ size: 4 }) as never);
    });
    const controller = new AbortController();
    const service = new PlatformAgentFileService(
      {
        fileRequestProof,
        withSftp: async (_project, _server, operation, signal) =>
          operation(sftp, signal ?? activeSignal),
      },
      new MemoryAgentStateStore(),
    );
    const upload = service.upload(
      principal(["files:write"]),
      "42",
      "/tmp/canceled.bin",
      Buffer.from("data"),
      "cancel-upload-cleanup",
      controller.signal,
    );
    await vi.waitFor(() => expect(sftp.stat).toHaveBeenCalled());

    controller.abort(new Error("request disconnected"));
    finishStat();

    await expect(upload).rejects.toThrow("request disconnected");
    const temporaryPath = vi.mocked(sftp.writeFile).mock.calls[0]?.[0];
    expect(sftp.unlink).toHaveBeenCalledWith(
      temporaryPath,
      expect.any(Function),
    );
    expect(sftp.ext_openssh_rename).not.toHaveBeenCalled();
  });

  it("临时文件大小不一致时不替换目标文件并清理临时文件", async () => {
    const sftp = fakeSftp();
    vi.mocked(sftp.stat).mockImplementation((_path, callback) =>
      callback(undefined, stats({ size: 1 }) as never),
    );
    const connector = {
      fileRequestProof,
      withSftp: vi.fn(
        async (
          _project: string,
          _server: string,
          operation: (
            value: SFTPWrapper,
            signal: AbortSignal,
          ) => Promise<unknown>,
        ) => operation(sftp, activeSignal),
      ),
    };
    const service = new PlatformAgentFileService(
      connector,
      new MemoryAgentStateStore(),
    );

    await expect(
      service.upload(
        principal(["files:write"]),
        "42",
        "/tmp/verified.bin",
        Buffer.from("content"),
        "verify-upload-size",
      ),
    ).rejects.toMatchObject({ code: "UPLOAD_SIZE_MISMATCH" });
    expect(sftp.ext_openssh_rename).not.toHaveBeenCalled();
    expect(sftp.unlink).toHaveBeenCalled();
  });

  it("原子替换失败时清理同目录临时上传文件", async () => {
    const sftp = fakeSftp();
    vi.mocked(sftp.ext_openssh_rename).mockImplementation(
      (_source, _destination, callback) =>
        callback(new Error("atomic rename failed")),
    );
    const connector = {
      fileRequestProof,
      withSftp: vi.fn(
        async (
          _project: string,
          _server: string,
          operation: (
            value: SFTPWrapper,
            signal: AbortSignal,
          ) => Promise<unknown>,
        ) => operation(sftp, activeSignal),
      ),
    };
    const service = new PlatformAgentFileService(
      connector,
      new MemoryAgentStateStore(),
    );

    await expect(
      service.upload(
        principal(["files:write"]),
        "42",
        "/tmp/current.bin",
        Buffer.from("content"),
        "failed-atomic-upload",
      ),
    ).rejects.toThrow("atomic rename failed");

    const temporaryPath = vi.mocked(sftp.writeFile).mock.calls[0]?.[0];
    expect(sftp.unlink).toHaveBeenCalledWith(
      temporaryPath,
      expect.any(Function),
    );
  });

  it("目录分批读取超过 2000 项时返回明确上限错误", async () => {
    const entries = Array.from(
      { length: AGENT_FILE_LIMITS.maxDirectoryEntries + 1 },
      (_, index) => ({
        filename: `file-${index}`,
        longname: `file-${index}`,
        attrs: stats(),
      }),
    );
    let readCount = 0;
    const sftp = {
      opendir: (
        _path: string,
        callback: (error?: Error, handle?: Buffer) => void,
      ) => callback(undefined, Buffer.from("directory-handle")),
      readdir: (
        _handle: Buffer,
        callback: (error?: Error, values?: unknown[]) => void,
      ) => {
        readCount += 1;
        if (readCount === 1) callback(undefined, entries);
        else callback(Object.assign(new Error("EOF"), { code: 1 }));
      },
      close: (_handle: Buffer, callback: (error?: Error) => void) => callback(),
    } as unknown as SFTPWrapper;
    const service = new PlatformAgentFileService(
      {
        fileRequestProof,
        withSftp: async (_project, _server, operation) =>
          operation(sftp, activeSignal),
      },
      new MemoryAgentStateStore(),
    );

    await expect(
      service.list(principal(["files:read"]), "42", "/large"),
    ).rejects.toMatchObject({ code: "DIRECTORY_ENTRY_LIMIT_EXCEEDED" });
  });

  it("全局最多同时执行四个流式下载并在完成后释放名额", async () => {
    const sftp = fakeSftp();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connector = {
      fileRequestProof,
      withSftp: vi.fn(
        async (
          _project: string,
          _server: string,
          operation: (
            value: SFTPWrapper,
            signal: AbortSignal,
          ) => Promise<unknown>,
        ) => {
          await gate;
          return operation(sftp, activeSignal);
        },
      ),
    };
    const service = new PlatformAgentFileService(
      connector,
      new MemoryAgentStateStore(),
    );
    const downloads = Array.from(
      { length: AGENT_FILE_LIMITS.maxConcurrentDownloads },
      (_, index) =>
        downloadBuffer(
          service,
          {
            ...principal(["files:read"]),
            principalId: `device:download-${index}`,
          },
          "42",
          `/tmp/file-${index}`,
        ).then(({ result }) => result),
    );
    await vi.waitFor(() =>
      expect(connector.withSftp).toHaveBeenCalledTimes(
        AGENT_FILE_LIMITS.maxConcurrentDownloads,
      ),
    );

    await expect(
      downloadBuffer(
        service,
        { ...principal(["files:read"]), principalId: "device:overflow" },
        "42",
        "/tmp/too-many",
      ),
    ).rejects.toMatchObject({ code: "FILE_DOWNLOAD_CONCURRENCY_EXCEEDED" });

    release();
    await expect(Promise.all(downloads)).resolves.toHaveLength(
      AGENT_FILE_LIMITS.maxConcurrentDownloads,
    );
    await expect(
      downloadBuffer(
        service,
        { ...principal(["files:read"]), principalId: "device:after" },
        "42",
        "/tmp/after-release",
      ),
    ).resolves.toMatchObject({ result: { size: 5 } });
  });

  it("单个设备最多同时执行两个下载", async () => {
    const sftp = fakeSftp();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new PlatformAgentFileService(
      {
        fileRequestProof,
        withSftp: async (_project, _server, operation) => {
          await gate;
          return operation(sftp, activeSignal);
        },
      },
      new MemoryAgentStateStore(),
    );
    const actor = principal(["files:read"]);
    const first = downloadBuffer(service, actor, "42", "/tmp/first");
    const second = downloadBuffer(service, actor, "42", "/tmp/second");

    await expect(
      downloadBuffer(service, actor, "42", "/tmp/third"),
    ).rejects.toMatchObject({ code: "FILE_DOWNLOAD_CONCURRENCY_EXCEEDED" });
    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("所有设备合计的 SFTP 操作达到上限时立即拒绝新连接", async () => {
    const sftp = fakeSftp();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connector = {
      fileRequestProof,
      withSftp: vi.fn(
        async (
          _project: string,
          _server: string,
          operation: (
            value: SFTPWrapper,
            signal: AbortSignal,
          ) => Promise<unknown>,
        ) => {
          await gate;
          return operation(sftp, activeSignal);
        },
      ),
    };
    const service = new PlatformAgentFileService(
      connector,
      new MemoryAgentStateStore(),
    );
    const active = Array.from(
      { length: AGENT_FILE_LIMITS.maxConcurrentFileOperations },
      (_, index) =>
        service.read(
          {
            ...principal(["files:read"]),
            principalId: `device:global-${index}`,
          },
          "42",
          `/tmp/global-${index}`,
        ),
    );
    await vi.waitFor(() =>
      expect(connector.withSftp).toHaveBeenCalledTimes(
        AGENT_FILE_LIMITS.maxConcurrentFileOperations,
      ),
    );

    await expect(
      service.list(
        { ...principal(["files:read"]), principalId: "device:overflow" },
        "42",
        "/tmp/overflow",
      ),
    ).rejects.toMatchObject({ code: "FILE_OPERATION_CONCURRENCY_EXCEEDED" });

    release();
    await expect(Promise.all(active)).resolves.toHaveLength(
      AGENT_FILE_LIMITS.maxConcurrentFileOperations,
    );
  });

  it("SFTP 操作异常后释放全局及设备并发名额", async () => {
    const sftp = fakeSftp();
    let attempts = 0;
    const connector = {
      fileRequestProof,
      withSftp: vi.fn(
        async (
          _project: string,
          _server: string,
          operation: (
            value: SFTPWrapper,
            signal: AbortSignal,
          ) => Promise<unknown>,
        ) => {
          attempts += 1;
          if (attempts === 1) throw new Error("SFTP failed");
          return operation(sftp, activeSignal);
        },
      ),
    };
    const service = new PlatformAgentFileService(
      connector,
      new MemoryAgentStateStore(),
    );
    const actor = principal(["files:read"]);

    await expect(service.list(actor, "42", "/tmp/first")).rejects.toThrow(
      "SFTP failed",
    );
    await expect(
      service.read(actor, "42", "/tmp/second"),
    ).resolves.toMatchObject({ content: "hello" });
  });

  it.each([
    "list",
    "read",
    "download",
    "upload",
    "mkdir",
    "rename",
    "delete",
  ] as const)("单个设备的 %s 操作受统一并发上限保护", async (operation) => {
    const sftp = fakeSftp();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connector = {
      fileRequestProof,
      withSftp: vi.fn(
        async (
          _project: string,
          _server: string,
          execute: (
            value: SFTPWrapper,
            signal: AbortSignal,
          ) => Promise<unknown>,
        ) => {
          await gate;
          return execute(sftp, activeSignal);
        },
      ),
    };
    const service = new PlatformAgentFileService(
      connector,
      new MemoryAgentStateStore(),
    );
    const actor = principal(["files:read", "files:write"]);
    const first = service.list(actor, "42", "/tmp/held-list");
    const second = service.read(actor, "42", "/tmp/held-read");
    await vi.waitFor(() => expect(connector.withSftp).toHaveBeenCalledTimes(2));

    const limitedSuffix = `limited-${operation}`;
    await expect(
      invokeFileOperation(service, actor, operation, limitedSuffix),
    ).rejects.toMatchObject({ code: "FILE_OPERATION_CONCURRENCY_EXCEEDED" });

    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    await expect(
      invokeFileOperation(service, actor, operation, limitedSuffix),
    ).resolves.toBeDefined();
  });

  it("递归删除符号链接时只删除链接本身", async () => {
    const sftp = fakeSftp();
    vi.mocked(sftp.lstat).mockImplementation((_path, callback) =>
      callback(
        undefined,
        stats({
          isDirectory: () => false,
          isFile: () => false,
          isSymbolicLink: () => true,
        }) as never,
      ),
    );
    const connector = {
      fileRequestProof,
      withSftp: vi.fn(
        async (
          _project: string,
          _server: string,
          operation: (
            value: SFTPWrapper,
            signal: AbortSignal,
          ) => Promise<unknown>,
        ) => operation(sftp, activeSignal),
      ),
    };
    const service = new PlatformAgentFileService(
      connector,
      new MemoryAgentStateStore(),
    );

    await service.delete(
      principal(["files:write"]),
      "42",
      "/tmp/current-link",
      true,
      "delete-link",
    );

    expect(sftp.unlink).toHaveBeenCalledWith(
      "/tmp/current-link",
      expect.any(Function),
    );
    expect(sftp.readdir).not.toHaveBeenCalled();
  });

  it.each([
    ".",
    "./",
    ".//",
    "foo/../",
    "/",
    "//",
    "/foo/..",
    "..",
    "../",
    "./..",
    "foo/../..",
    "../../",
  ])("拒绝递归删除当前目录或根目录等价路径：%s", async (remotePath) => {
    const connector = {
      fileRequestProof,
      withSftp: vi.fn(),
    };
    const service = new PlatformAgentFileService(
      connector,
      new MemoryAgentStateStore(),
    );

    await expect(
      service.delete(
        principal(["files:write"]),
        "42",
        remotePath,
        true,
        `delete-protected-${Buffer.from(remotePath).toString("hex")}`,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(connector.withSftp).not.toHaveBeenCalled();
  });
});
