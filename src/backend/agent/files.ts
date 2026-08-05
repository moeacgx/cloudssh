import crypto from "node:crypto";
import { posix as posixPath } from "node:path";
import { Readable, Transform, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { SFTPWrapper, FileEntryWithStats, Stats } from "ssh2";
import { AgentApiError } from "./errors.js";
import type { AgentPrincipal } from "./types.js";
import {
  findIdempotency,
  hasIdempotencyCapacity,
  type AgentStateStore,
} from "./store.js";

const MAX_REMOTE_PATH_LENGTH = 4_096;
const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_READ_CHUNK_BYTES = 64 * 1024;
const MAX_TRANSFER_BYTES = 64 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 2_000;
const MAX_CONCURRENT_FILE_OPERATIONS = 8;
const MAX_CONCURRENT_FILE_OPERATIONS_PER_PRINCIPAL = 2;
const MAX_CONCURRENT_UPLOADS = 2;
const MAX_CONCURRENT_UPLOADS_PER_DEVICE = 1;
const MAX_CONCURRENT_DOWNLOADS = 4;
const MAX_CONCURRENT_DOWNLOADS_PER_PRINCIPAL = 2;

export interface AgentFileEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "link";
  size: number;
  modifiedAt: string | null;
  permissions: number | null;
}

export interface AgentFileReadResult {
  path: string;
  content: string;
  encoding: "utf8";
  size: number;
  truncated: boolean;
}

export interface AgentFileTransferResult {
  serverId: string;
  path: string;
  size: number;
}

export interface AgentFileUploadSource {
  /** 鉴权前流式接收并核验过的实际字节数。 */
  size: number;
  /** 鉴权前流式计算并与设备签名头核对的 SHA-256。 */
  sha256: string;
  /** 仅在幂等请求确实需要执行时打开，避免重放请求泄漏文件句柄。 */
  openStream: () => Readable;
}

export interface AgentFileService {
  list(
    principal: AgentPrincipal,
    serverId: string,
    remotePath: string,
    signal?: AbortSignal,
  ): Promise<{ path: string; files: AgentFileEntry[] }>;
  read(
    principal: AgentPrincipal,
    serverId: string,
    remotePath: string,
    signal?: AbortSignal,
  ): Promise<AgentFileReadResult>;
  upload(
    principal: AgentPrincipal,
    serverId: string,
    remotePath: string,
    data: Buffer | AgentFileUploadSource,
    idempotencyKey: string,
    signal?: AbortSignal,
    onCommitted?: () => void,
    onDispatched?: () => void,
  ): Promise<AgentFileTransferResult>;
  download(
    principal: AgentPrincipal,
    serverId: string,
    remotePath: string,
    openDestination: (file: AgentFileTransferResult) => Writable,
    signal?: AbortSignal,
  ): Promise<AgentFileTransferResult>;
  mkdir(
    principal: AgentPrincipal,
    serverId: string,
    remotePath: string,
    recursive: boolean,
    idempotencyKey: string,
    signal?: AbortSignal,
    onCommitted?: () => void,
    onDispatched?: () => void,
  ): Promise<{ serverId: string; path: string }>;
  rename(
    principal: AgentPrincipal,
    serverId: string,
    sourcePath: string,
    destinationPath: string,
    idempotencyKey: string,
    signal?: AbortSignal,
    onCommitted?: () => void,
    onDispatched?: () => void,
  ): Promise<{ serverId: string; sourcePath: string; destinationPath: string }>;
  delete(
    principal: AgentPrincipal,
    serverId: string,
    remotePath: string,
    recursive: boolean,
    idempotencyKey: string,
    signal?: AbortSignal,
    onCommitted?: () => void,
    onDispatched?: () => void,
  ): Promise<{ serverId: string; path: string }>;
}

export interface AgentSftpConnector {
  /** 使用平台根密钥派生值生成不可离线猜测的正文证明。 */
  fileRequestProof(data: Buffer): string;
  /**
   * 以与 Buffer 版本完全相同的协议生成正文证明，同时核对流内容。
   * 该能力仅在流式上传时需要，保留可选以兼容只支持旧 Buffer 上传的连接器。
   */
  fileRequestProofStream?(
    data: Readable,
    maximumBytes: number,
    signal?: AbortSignal,
  ): Promise<{ contentProof: string; size: number; sha256: string }>;
  withSftp<T>(
    projectId: string,
    serverId: string,
    operation: (sftp: SFTPWrapper, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}

function requireScope(
  principal: AgentPrincipal,
  scope: "files:read" | "files:write",
) {
  if (!principal.scopes.includes(scope)) {
    throw new AgentApiError(403, "SCOPE_DENIED", `缺少权限：${scope}`);
  }
}

function resolveAccess(
  principal: AgentPrincipal,
  serverId: string,
): { projectId: string } {
  if (
    !principal.serverIds.includes("*") &&
    !principal.serverIds.includes(serverId)
  ) {
    throw new AgentApiError(403, "SERVER_DENIED", "当前设备无权访问该服务器");
  }
  const projectId =
    principal.serverProjectIds?.[serverId] ?? principal.projectId;
  if (!(principal.projectIds ?? [principal.projectId]).includes(projectId)) {
    throw new AgentApiError(403, "PROJECT_DENIED", "设备未获授权访问该项目");
  }
  return { projectId };
}

function normalizeRemotePath(value: unknown, field = "path"): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_REMOTE_PATH_LENGTH
  ) {
    throw new AgentApiError(400, "INVALID_INPUT", `${field} 无效`);
  }
  if (/\0/.test(value)) {
    throw new AgentApiError(400, "INVALID_INPUT", `${field} 无效`);
  }
  // SFTP 使用 POSIX 路径。保留根路径和相对路径语义，但折叠重复分隔符
  // 与当前目录，避免把未经校验的路径交给 shell。
  const normalized = posixPath.normalize(value.replace(/\\/g, "/"));
  // Node 会把带尾部分隔符的当前目录规范化为 "./"。统一为 "."，
  // 这样 delete 的当前目录保护不能被 "./" 或 "foo/../" 绕过。
  if (normalized === "." || normalized === "./") return ".";
  return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}

function validateIdempotencyKey(value: string): string {
  const key = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) {
    throw new AgentApiError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "文件写操作必须提供有效的 Idempotency-Key",
    );
  }
  return key;
}

function requestHash(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

interface LegacyStoredFileOperation<T> {
  version: 1;
  operation: string;
  status: "pending" | "succeeded";
  result?: T;
}

interface StoredFileOperation<T> {
  version: 2;
  operation: string;
  status: "reserved" | "dispatched" | "succeeded";
  result?: T;
}

type AnyStoredFileOperation<T> =
  | LegacyStoredFileOperation<T>
  | StoredFileOperation<T>;

interface IdempotentFileOperationInput<T> {
  principal: AgentPrincipal;
  projectId: string;
  operation: string;
  idempotencyKey: string;
  request: unknown;
  execute: (markDispatched: () => Promise<void>) => Promise<T>;
  onCommitted?: () => void;
  onDispatched?: () => void;
}

function storedFileOperation<T>(
  value: unknown,
): AnyStoredFileOperation<T> | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<AnyStoredFileOperation<T>>;
  if (typeof candidate.operation !== "string") return null;
  if (
    candidate.version === 1 &&
    (candidate.status === "pending" || candidate.status === "succeeded")
  )
    return candidate as LegacyStoredFileOperation<T>;
  if (
    candidate.version === 2 &&
    (candidate.status === "reserved" ||
      candidate.status === "dispatched" ||
      candidate.status === "succeeded")
  )
    return candidate as StoredFileOperation<T>;
  return null;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("SFTP operation canceled");
}

function sftpCall<T>(
  action: (callback: (error: Error | undefined, value: T) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    action((error, value) => (error ? reject(error) : resolve(value)));
  });
}

function sftpVoid(action: (callback: (error?: Error) => void) => void) {
  return new Promise<void>((resolve, reject) => {
    action((error) => (error ? reject(error) : resolve()));
  });
}

function isMissingSftpPath(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 2 || code === "ENOENT";
}

async function lstatIfExists(
  sftp: SFTPWrapper,
  remotePath: string,
): Promise<Stats | null> {
  try {
    return await sftpCall<Stats>((callback) =>
      sftp.lstat(remotePath, callback),
    );
  } catch (error) {
    if (isMissingSftpPath(error)) return null;
    throw error;
  }
}

function isUnsupportedSftpExtension(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  if (
    candidate?.code === 8 ||
    candidate?.code === "OP_UNSUPPORTED" ||
    candidate?.code === "SSH_FX_OP_UNSUPPORTED" ||
    candidate?.code === "ENOSYS"
  ) {
    return true;
  }
  return (
    typeof candidate?.message === "string" &&
    /(?:not supported|unsupported|not implemented|unknown extension)/i.test(
      candidate.message,
    )
  );
}

async function commitUploadedFile(
  sftp: SFTPWrapper,
  temporaryPath: string,
  destinationPath: string,
  existingTarget: Stats | null,
): Promise<void> {
  if (typeof sftp.ext_openssh_rename === "function") {
    try {
      await sftpVoid((callback) =>
        sftp.ext_openssh_rename(temporaryPath, destinationPath, callback),
      );
      return;
    } catch (error) {
      if (!isUnsupportedSftpExtension(error)) throw error;
    }
  }

  if (existingTarget) {
    throw new AgentApiError(
      409,
      "ATOMIC_RENAME_UNSUPPORTED",
      "目标 SFTP 服务不支持安全原子替换，已有文件未被覆盖",
    );
  }

  // SFTP v3 的标准 rename 要求目标不存在。扩展探测后再检查一次，
  // 避免在回退窗口内把另一个客户端刚创建的目标静默替换掉。
  if (await lstatIfExists(sftp, destinationPath)) {
    throw new AgentApiError(
      409,
      "UPLOAD_TARGET_CHANGED",
      "上传期间目标文件已出现，未执行非原子覆盖",
    );
  }
  await sftpVoid((callback) =>
    sftp.rename(temporaryPath, destinationPath, callback),
  );
}

function entryType(entry: FileEntryWithStats): AgentFileEntry["type"] {
  if (entry.attrs.isDirectory()) return "directory";
  if (entry.attrs.isSymbolicLink()) return "link";
  return "file";
}

function toEntry(basePath: string, entry: FileEntryWithStats): AgentFileEntry {
  const type = entryType(entry);
  const path = `${basePath === "/" ? "" : basePath}/${entry.filename}`;
  const attrs = entry.attrs as Stats;
  return {
    name: entry.filename,
    path,
    type,
    size: Number(attrs.size ?? 0),
    modifiedAt: Number.isFinite(attrs.mtime)
      ? new Date(attrs.mtime * 1_000).toISOString()
      : null,
    permissions: Number.isFinite(attrs.mode) ? attrs.mode : null,
  };
}

async function mkdirRecursive(
  sftp: SFTPWrapper,
  remotePath: string,
  signal?: AbortSignal,
): Promise<void> {
  if (remotePath === "." || remotePath === "/") return;
  const absolute = remotePath.startsWith("/");
  const parts = remotePath.split("/").filter(Boolean);
  let current = absolute ? "" : ".";
  for (const part of parts) {
    throwIfAborted(signal);
    current = absolute
      ? `${current}/${part}`
      : current === "."
        ? part
        : `${current}/${part}`;
    try {
      await sftpVoid((callback) =>
        sftp.mkdir(current, { mode: 0o755 }, callback),
      );
    } catch (error) {
      // 已存在的目录可继续；其他错误必须返回给调用方。
      const existing = await sftpCall<Stats>((callback) =>
        sftp.stat(current, callback),
      ).catch(() => null);
      if (!existing?.isDirectory()) throw error;
    }
  }
}

async function deleteRecursive(
  sftp: SFTPWrapper,
  remotePath: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  // lstat 避免递归删除跟随符号链接进入链接目标目录。
  const attrs = await sftpCall<Stats>((callback) =>
    sftp.lstat(remotePath, callback),
  );
  if (!attrs.isDirectory()) {
    await sftpVoid((callback) => sftp.unlink(remotePath, callback));
    return;
  }
  const entries = await readDirectoryEntries(
    sftp,
    remotePath,
    MAX_DIRECTORY_ENTRIES,
    signal,
  );
  for (const entry of entries) {
    if (entry.filename === "." || entry.filename === "..") continue;
    await deleteRecursive(
      sftp,
      `${remotePath === "/" ? "" : remotePath}/${entry.filename}`,
      signal,
    );
  }
  await sftpVoid((callback) => sftp.rmdir(remotePath, callback));
}

function isSftpEof(error: Error): boolean {
  const code = (error as Error & { code?: number | string }).code;
  return code === 1 || code === "EOF";
}

async function readDirectoryEntries(
  sftp: SFTPWrapper,
  remotePath: string,
  maximumEntries: number,
  signal?: AbortSignal,
): Promise<FileEntryWithStats[]> {
  throwIfAborted(signal);
  const handle = await sftpCall<Buffer>((callback) =>
    sftp.opendir(remotePath, callback),
  );
  const entries: FileEntryWithStats[] = [];
  try {
    while (true) {
      throwIfAborted(signal);
      const batch = await new Promise<FileEntryWithStats[] | null>(
        (resolve, reject) => {
          sftp.readdir(handle, (error, values) => {
            if (error) {
              if (isSftpEof(error)) resolve(null);
              else reject(error);
              return;
            }
            resolve(values);
          });
        },
      );
      if (!batch || batch.length === 0) break;
      for (const entry of batch) {
        if (entry.filename === "." || entry.filename === "..") continue;
        entries.push(entry);
        if (entries.length > maximumEntries) {
          throw new AgentApiError(
            413,
            "DIRECTORY_ENTRY_LIMIT_EXCEEDED",
            `目录项目超过 ${maximumEntries} 条，请缩小查询范围`,
          );
        }
      }
    }
    return entries;
  } finally {
    await sftpVoid((callback) => sftp.close(handle, callback)).catch(
      () => undefined,
    );
  }
}

async function readPrefix(
  sftp: SFTPWrapper,
  remotePath: string,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  throwIfAborted(signal);
  const handle = await sftpCall<Buffer>((callback) =>
    sftp.open(remotePath, "r", callback),
  );
  try {
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    while (bytesRead < maximumBytes) {
      throwIfAborted(signal);
      const requestedBytes = Math.min(
        MAX_READ_CHUNK_BYTES,
        maximumBytes - bytesRead,
      );
      const chunk = Buffer.allocUnsafe(requestedBytes);
      const count = await new Promise<number>((resolve, reject) => {
        sftp.read(handle, chunk, 0, requestedBytes, bytesRead, (error, read) =>
          error ? reject(error) : resolve(read),
        );
      });
      if (!Number.isInteger(count) || count < 0 || count > requestedBytes) {
        throw new AgentApiError(
          502,
          "INVALID_SFTP_RESPONSE",
          "SFTP 服务返回了无效的读取长度",
        );
      }
      if (count === 0) break;
      chunks.push(chunk.subarray(0, count));
      bytesRead += count;
    }
    return Buffer.concat(chunks, bytesRead);
  } finally {
    await sftpVoid((callback) => sftp.close(handle, callback)).catch(
      () => undefined,
    );
  }
}

function createTransferLimiter(maximumBytes: number): {
  stream: Transform;
  transferredBytes: () => number;
} {
  let transferredBytes = 0;
  const stream = new Transform({
    transform(value, _encoding, callback) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (transferredBytes + chunk.length > maximumBytes) {
        callback(
          new AgentApiError(413, "FILE_TOO_LARGE", "下载文件超过 64 MiB 限制"),
        );
        return;
      }
      transferredBytes += chunk.length;
      callback(null, chunk);
    },
  });
  return { stream, transferredBytes: () => transferredBytes };
}

interface NormalizedUploadSource {
  size: number;
  contentProof: string;
  buffer?: Buffer;
  openStream?: () => Readable;
  sha256?: string;
}

async function normalizeUploadSource(
  connector: AgentSftpConnector,
  value: Buffer | AgentFileUploadSource,
  signal?: AbortSignal,
): Promise<NormalizedUploadSource> {
  if (Buffer.isBuffer(value)) {
    if (value.length > MAX_TRANSFER_BYTES) {
      throw new AgentApiError(
        413,
        "FILE_TOO_LARGE",
        "上传文件超过 64 MiB 限制",
      );
    }
    return {
      size: value.length,
      contentProof: connector.fileRequestProof(value),
      buffer: value,
    };
  }
  if (
    !value ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    typeof value.openStream !== "function"
  ) {
    throw new AgentApiError(400, "INVALID_INPUT", "上传文件源无效");
  }
  if (value.size > MAX_TRANSFER_BYTES) {
    throw new AgentApiError(413, "FILE_TOO_LARGE", "上传文件超过 64 MiB 限制");
  }
  if (typeof connector.fileRequestProofStream !== "function") {
    throw new AgentApiError(
      503,
      "STREAM_UPLOAD_UNAVAILABLE",
      "当前 SFTP 连接器不支持流式上传",
    );
  }
  throwIfAborted(signal);
  const source = value.openStream();
  if (!(source instanceof Readable)) {
    throw new AgentApiError(400, "INVALID_INPUT", "上传文件源无效");
  }
  const streamedProof = await connector.fileRequestProofStream(
    source,
    value.size,
    signal,
  );
  if (
    streamedProof.size !== value.size ||
    streamedProof.sha256 !== value.sha256
  ) {
    throw new AgentApiError(
      409,
      "UPLOAD_SOURCE_CHANGED",
      "上传临时文件在鉴权后发生变化，未替换目标文件",
    );
  }
  return {
    size: value.size,
    sha256: value.sha256,
    // 必须沿用 .21 的 HMAC(原始正文) 证明，确保升级前留下的
    // 幂等记录在升级后仍可安全重放。
    contentProof: streamedProof.contentProof,
    openStream: value.openStream,
  };
}

function createUploadVerifier(input: {
  expectedBytes: number;
  expectedSha256: string;
}): { stream: Transform; transferredBytes: () => number } {
  const hash = crypto.createHash("sha256");
  let transferredBytes = 0;
  const stream = new Transform({
    transform(value, _encoding, callback) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (transferredBytes + chunk.length > MAX_TRANSFER_BYTES) {
        callback(
          new AgentApiError(413, "FILE_TOO_LARGE", "上传文件超过 64 MiB 限制"),
        );
        return;
      }
      transferredBytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      const actualSha256 = hash.digest("hex");
      if (
        transferredBytes !== input.expectedBytes ||
        actualSha256 !== input.expectedSha256
      ) {
        callback(
          new AgentApiError(
            409,
            "UPLOAD_SOURCE_CHANGED",
            "上传临时文件在鉴权后发生变化，未替换目标文件",
          ),
        );
        return;
      }
      callback();
    },
  });
  return { stream, transferredBytes: () => transferredBytes };
}

export class PlatformAgentFileService implements AgentFileService {
  private readonly operationTails = new Map<string, Promise<void>>();
  private readonly activeOperationsByPrincipal = new Map<string, number>();
  private readonly activeDownloadsByPrincipal = new Map<string, number>();
  private activeOperations = 0;
  private activeDownloads = 0;

  constructor(
    private readonly connector: AgentSftpConnector,
    private readonly state: AgentStateStore,
  ) {}

  private async withFileOperation<T>(
    principal: AgentPrincipal,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    throwIfAborted(signal);
    const principalOperations =
      this.activeOperationsByPrincipal.get(principal.principalId) ?? 0;
    if (
      this.activeOperations >= MAX_CONCURRENT_FILE_OPERATIONS ||
      principalOperations >= MAX_CONCURRENT_FILE_OPERATIONS_PER_PRINCIPAL
    ) {
      throw new AgentApiError(
        429,
        "FILE_OPERATION_CONCURRENCY_EXCEEDED",
        "同时执行的文件操作过多，请稍后重试",
      );
    }
    this.activeOperations += 1;
    this.activeOperationsByPrincipal.set(
      principal.principalId,
      principalOperations + 1,
    );
    try {
      return await operation();
    } finally {
      this.activeOperations = Math.max(0, this.activeOperations - 1);
      const remaining =
        (this.activeOperationsByPrincipal.get(principal.principalId) ?? 1) - 1;
      if (remaining > 0) {
        this.activeOperationsByPrincipal.set(principal.principalId, remaining);
      } else {
        this.activeOperationsByPrincipal.delete(principal.principalId);
      }
    }
  }

  private withSftpOperation<T>(
    principal: AgentPrincipal,
    projectId: string,
    serverId: string,
    operation: (sftp: SFTPWrapper, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.withFileOperation(
      principal,
      () => this.connector.withSftp(projectId, serverId, operation, signal),
      signal,
    );
  }

  private idempotentWithinLimit<T>(
    principal: AgentPrincipal,
    signal: AbortSignal | undefined,
    input: IdempotentFileOperationInput<T>,
  ): Promise<T> {
    return this.withFileOperation(
      principal,
      () => this.idempotent(input),
      signal,
    );
  }

  private async serialize<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.operationTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const current = previous.catch(() => undefined).then(() => gate);
    this.operationTails.set(key, current);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.operationTails.get(key) === current) {
        this.operationTails.delete(key);
      }
    }
  }

  private async idempotent<T>(
    input: IdempotentFileOperationInput<T>,
  ): Promise<T> {
    const clientKey = validateIdempotencyKey(input.idempotencyKey);
    const scopedKey = `${input.principal.principalId}:project:${input.projectId}:file:${input.operation}:${clientKey}`;
    const hash = requestHash(input.request);
    return this.serialize(scopedKey, async () => {
      const reservation = await this.state.update((state) => {
        const existing = findIdempotency(state, scopedKey);
        if (existing) {
          if (existing.requestHash !== hash) {
            throw new AgentApiError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "同一个幂等键不能用于不同文件请求",
            );
          }
          const stored = storedFileOperation<T>(existing.response);
          if (!stored || stored.operation !== input.operation) {
            throw new AgentApiError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "幂等记录与当前文件操作不匹配",
            );
          }
          if (
            (stored.version === 1 && stored.status === "pending") ||
            (stored.version === 2 && stored.status === "dispatched")
          ) {
            return { execute: false as const, outcomeUnknown: true as const };
          }
          if (stored.status === "succeeded") {
            return { execute: false as const, result: stored.result as T };
          }
          // version 2 的 reserved 尚未向目标路径下发任何修改，连接失败、
          // 超时或进程重启后均可使用同一幂等键安全重试。
          return { execute: true as const };
        }
        if (!hasIdempotencyCapacity(state)) {
          throw new AgentApiError(
            429,
            "IDEMPOTENCY_CAPACITY_EXCEEDED",
            "防重记录已达到容量上限，请等待历史记录过期后重试",
          );
        }
        state.idempotency.push({
          key: scopedKey,
          requestHash: hash,
          response: {
            version: 2,
            operation: input.operation,
            status: "reserved",
          } satisfies StoredFileOperation<T>,
          createdAt: new Date().toISOString(),
        });
        return { execute: true as const };
      });
      if (!reservation.execute) {
        if ("outcomeUnknown" in reservation && reservation.outcomeUnknown) {
          input.onDispatched?.();
          throw new AgentApiError(
            409,
            "IDEMPOTENCY_OUTCOME_UNKNOWN",
            "上一次文件操作结果无法确认，请先检查远端状态",
          );
        }
        return structuredClone(reservation.result);
      }

      let dispatched = false;
      const markDispatched = async () => {
        if (dispatched) return;
        await this.state.update((state) => {
          const record = findIdempotency(state, scopedKey);
          const stored = record
            ? storedFileOperation<T>(record.response)
            : null;
          if (
            !record ||
            record.requestHash !== hash ||
            !stored ||
            stored.version !== 2 ||
            stored.operation !== input.operation
          ) {
            throw new AgentApiError(
              409,
              "IDEMPOTENCY_RECORD_MISSING",
              "文件操作尚未下发，但防重记录无法持久化",
            );
          }
          if (stored.status === "succeeded") {
            throw new AgentApiError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "文件操作已经完成",
            );
          }
          if (stored.status === "reserved") {
            record.response = {
              version: 2,
              operation: input.operation,
              status: "dispatched",
            } satisfies StoredFileOperation<T>;
          }
        });
        dispatched = true;
        input.onDispatched?.();
      };

      // 只有在远端修改即将下发时才进入 dispatched。此后失败保留该状态，
      // 同一幂等键会返回 OUTCOME_UNKNOWN，避免重复移动或删除远端数据。
      const result = await input.execute(markDispatched);
      if (!dispatched) {
        throw new AgentApiError(
          500,
          "IDEMPOTENCY_DISPATCH_MISSING",
          "文件操作未声明远端修改状态",
        );
      }
      // 远端副作用已经确认完成。即使随后防重结果落盘失败，审计也必须
      // 记录“已提交”，不能把实际发生的文件变更误记为失败。
      input.onCommitted?.();
      await this.state.update((state) => {
        const record = findIdempotency(state, scopedKey);
        const stored = record ? storedFileOperation<T>(record.response) : null;
        if (
          !record ||
          record.requestHash !== hash ||
          !stored ||
          stored.version !== 2 ||
          stored.status !== "dispatched"
        ) {
          throw new AgentApiError(
            409,
            "IDEMPOTENCY_RECORD_MISSING",
            "文件操作已完成，但防重结果无法持久化",
          );
        }
        record.response = {
          version: 2,
          operation: input.operation,
          status: "succeeded",
          result: structuredClone(result),
        } satisfies StoredFileOperation<T>;
      });
      return result;
    });
  }

  async list(
    principal: AgentPrincipal,
    serverId: string,
    remotePath: string,
    signal?: AbortSignal,
  ) {
    requireScope(principal, "files:read");
    const access = resolveAccess(principal, serverId);
    const path = normalizeRemotePath(remotePath);
    return this.withSftpOperation(
      principal,
      access.projectId,
      serverId,
      async (sftp, operationSignal) => {
        const entries = await readDirectoryEntries(
          sftp,
          path,
          MAX_DIRECTORY_ENTRIES,
          operationSignal,
        );
        return {
          path,
          files: entries.map((entry) => toEntry(path, entry)),
        };
      },
      signal,
    );
  }

  async read(
    principal: AgentPrincipal,
    serverId: string,
    remotePath: string,
    signal?: AbortSignal,
  ) {
    requireScope(principal, "files:read");
    const access = resolveAccess(principal, serverId);
    const path = normalizeRemotePath(remotePath);
    return this.withSftpOperation(
      principal,
      access.projectId,
      serverId,
      async (sftp, operationSignal) => {
        const attrs = await sftpCall<Stats>((callback) =>
          sftp.stat(path, callback),
        );
        if (attrs.isDirectory()) {
          throw new AgentApiError(400, "NOT_A_FILE", "目标路径是目录");
        }
        const reportedSize = Math.max(0, Number(attrs.size ?? 0));
        // 始终按上限读取，避免远端文件在 stat 后快速增长时由 readFile
        // 无界载入内存。多读一个字节用于识别过期或不准确的 stat 结果。
        const data = await readPrefix(
          sftp,
          path,
          MAX_READ_BYTES + 1,
          operationSignal,
        );
        const truncated =
          reportedSize > MAX_READ_BYTES || data.length > MAX_READ_BYTES;
        const content = data.subarray(0, MAX_READ_BYTES).toString("utf8");
        return {
          path,
          content,
          encoding: "utf8" as const,
          size: Math.max(reportedSize, data.length),
          truncated,
        };
      },
      signal,
    );
  }

  async upload(
    principal: AgentPrincipal,
    serverId: string,
    remotePath: string,
    data: Buffer | AgentFileUploadSource,
    idempotencyKey: string,
    signal?: AbortSignal,
    onCommitted?: () => void,
    onDispatched?: () => void,
  ) {
    requireScope(principal, "files:write");
    const access = resolveAccess(principal, serverId);
    const path = normalizeRemotePath(remotePath, "remotePath");
    const temporaryPath = posixPath.join(
      posixPath.dirname(path),
      `.cloudssh-upload-${crypto.randomUUID()}.tmp`,
    );
    if (temporaryPath.length > MAX_REMOTE_PATH_LENGTH) {
      throw new AgentApiError(
        400,
        "INVALID_INPUT",
        "remotePath 所在目录路径过长，无法安全创建临时文件",
      );
    }
    return this.withFileOperation(
      principal,
      async () => {
        const uploadSource = await normalizeUploadSource(
          this.connector,
          data,
          signal,
        );
        return this.idempotent({
          principal,
          projectId: access.projectId,
          operation: "upload",
          idempotencyKey,
          request: {
            serverId,
            path,
            size: uploadSource.size,
            contentProof: uploadSource.contentProof,
          },
          onCommitted,
          onDispatched,
          execute: (markDispatched) =>
            this.connector.withSftp(
              access.projectId,
              serverId,
              async (sftp, operationSignal) => {
                let renamed = false;
                try {
                  throwIfAborted(operationSignal);
                  if (uploadSource.buffer) {
                    await sftpVoid((callback) =>
                      sftp.writeFile(
                        temporaryPath,
                        uploadSource.buffer!,
                        { flag: "wx", mode: 0o600 },
                        callback,
                      ),
                    );
                  } else {
                    const source = uploadSource.openStream?.();
                    if (!(source instanceof Readable) || !uploadSource.sha256) {
                      throw new AgentApiError(
                        400,
                        "INVALID_INPUT",
                        "上传文件源无效",
                      );
                    }
                    const verifier = createUploadVerifier({
                      expectedBytes: uploadSource.size,
                      expectedSha256: uploadSource.sha256,
                    });
                    const destination = sftp.createWriteStream(temporaryPath, {
                      flags: "wx",
                      mode: 0o600,
                    });
                    await pipeline(source, verifier.stream, destination, {
                      signal: operationSignal,
                    });
                    if (verifier.transferredBytes() !== uploadSource.size) {
                      throw new AgentApiError(
                        409,
                        "UPLOAD_SOURCE_CHANGED",
                        "上传临时文件在鉴权后发生变化，未替换目标文件",
                      );
                    }
                  }
                  const temporaryAttrs = await sftpCall<Stats>((callback) =>
                    sftp.stat(temporaryPath, callback),
                  );
                  if (Number(temporaryAttrs.size) !== uploadSource.size) {
                    throw new AgentApiError(
                      502,
                      "UPLOAD_SIZE_MISMATCH",
                      "远端临时文件大小校验失败，未替换目标文件",
                    );
                  }
                  throwIfAborted(operationSignal);
                  const existingTarget = await lstatIfExists(sftp, path);
                  if (existingTarget?.isSymbolicLink()) {
                    throw new AgentApiError(
                      409,
                      "SYMLINK_UPLOAD_DENIED",
                      "不能通过 Agent 上传覆盖符号链接",
                    );
                  }
                  if (existingTarget && !existingTarget.isFile()) {
                    throw new AgentApiError(
                      400,
                      "NOT_A_FILE",
                      "上传目标不是普通文件",
                    );
                  }
                  if (existingTarget && Number.isFinite(existingTarget.mode)) {
                    const preservedMode = Number(existingTarget.mode) & 0o7777;
                    await sftpVoid((callback) =>
                      sftp.chmod(temporaryPath, preservedMode, callback),
                    );
                  }
                  throwIfAborted(operationSignal);
                  await markDispatched();
                  throwIfAborted(operationSignal);
                  await commitUploadedFile(
                    sftp,
                    temporaryPath,
                    path,
                    existingTarget,
                  );
                  renamed = true;
                  return { serverId, path, size: uploadSource.size };
                } finally {
                  if (!renamed) {
                    await sftpVoid((callback) =>
                      sftp.unlink(temporaryPath, callback),
                    ).catch(() => undefined);
                  }
                }
              },
              signal,
            ),
        });
      },
      signal,
    );
  }

  async download(
    principal: AgentPrincipal,
    serverId: string,
    remotePath: string,
    openDestination: (file: AgentFileTransferResult) => Writable,
    signal?: AbortSignal,
  ) {
    requireScope(principal, "files:read");
    const access = resolveAccess(principal, serverId);
    const path = normalizeRemotePath(remotePath, "remotePath");
    throwIfAborted(signal);
    const principalDownloads =
      this.activeDownloadsByPrincipal.get(principal.principalId) ?? 0;
    if (
      this.activeDownloads >= MAX_CONCURRENT_DOWNLOADS ||
      principalDownloads >= MAX_CONCURRENT_DOWNLOADS_PER_PRINCIPAL
    ) {
      throw new AgentApiError(
        429,
        "FILE_DOWNLOAD_CONCURRENCY_EXCEEDED",
        "同时下载的文件过多，请稍后重试",
      );
    }
    this.activeDownloads += 1;
    this.activeDownloadsByPrincipal.set(
      principal.principalId,
      principalDownloads + 1,
    );
    try {
      return await this.withSftpOperation(
        principal,
        access.projectId,
        serverId,
        async (sftp, operationSignal) => {
          const attrs = await sftpCall<Stats>((callback) =>
            sftp.stat(path, callback),
          );
          if (attrs.isDirectory()) {
            throw new AgentApiError(400, "NOT_A_FILE", "目标路径是目录");
          }
          const reportedSize = Math.max(0, Number(attrs.size ?? 0));
          if (reportedSize > MAX_TRANSFER_BYTES) {
            throw new AgentApiError(
              413,
              "FILE_TOO_LARGE",
              "下载文件超过 64 MiB 限制",
            );
          }
          const destination = openDestination({
            serverId,
            path,
            size: reportedSize,
          });
          const source = sftp.createReadStream(path);
          const limiter = createTransferLimiter(MAX_TRANSFER_BYTES);
          await pipeline(source, limiter.stream, destination, {
            signal: operationSignal,
          });
          return {
            serverId,
            path,
            size: limiter.transferredBytes(),
          };
        },
        signal,
      );
    } finally {
      this.activeDownloads = Math.max(0, this.activeDownloads - 1);
      const remaining =
        (this.activeDownloadsByPrincipal.get(principal.principalId) ?? 1) - 1;
      if (remaining > 0) {
        this.activeDownloadsByPrincipal.set(principal.principalId, remaining);
      } else {
        this.activeDownloadsByPrincipal.delete(principal.principalId);
      }
    }
  }

  async mkdir(
    principal: AgentPrincipal,
    serverId: string,
    remotePath: string,
    recursive: boolean,
    idempotencyKey: string,
    signal?: AbortSignal,
    onCommitted?: () => void,
    onDispatched?: () => void,
  ) {
    requireScope(principal, "files:write");
    const access = resolveAccess(principal, serverId);
    const path = normalizeRemotePath(remotePath, "path");
    return this.idempotentWithinLimit(principal, signal, {
      principal,
      projectId: access.projectId,
      operation: "mkdir",
      idempotencyKey,
      request: { serverId, path, recursive },
      onCommitted,
      onDispatched,
      execute: (markDispatched) =>
        this.connector.withSftp(
          access.projectId,
          serverId,
          async (sftp, operationSignal) => {
            throwIfAborted(operationSignal);
            await markDispatched();
            throwIfAborted(operationSignal);
            if (recursive) await mkdirRecursive(sftp, path, operationSignal);
            else
              await sftpVoid((callback) =>
                sftp.mkdir(path, { mode: 0o755 }, callback),
              );
            return { serverId, path };
          },
          signal,
        ),
    });
  }

  async rename(
    principal: AgentPrincipal,
    serverId: string,
    sourcePath: string,
    destinationPath: string,
    idempotencyKey: string,
    signal?: AbortSignal,
    onCommitted?: () => void,
    onDispatched?: () => void,
  ) {
    requireScope(principal, "files:write");
    const access = resolveAccess(principal, serverId);
    const source = normalizeRemotePath(sourcePath, "sourcePath");
    const destination = normalizeRemotePath(destinationPath, "destinationPath");
    return this.idempotentWithinLimit(principal, signal, {
      principal,
      projectId: access.projectId,
      operation: "rename",
      idempotencyKey,
      request: {
        serverId,
        sourcePath: source,
        destinationPath: destination,
      },
      onCommitted,
      onDispatched,
      execute: (markDispatched) =>
        this.connector.withSftp(
          access.projectId,
          serverId,
          async (sftp, operationSignal) => {
            throwIfAborted(operationSignal);
            await markDispatched();
            throwIfAborted(operationSignal);
            await sftpVoid((callback) =>
              sftp.rename(source, destination, callback),
            );
            return {
              serverId,
              sourcePath: source,
              destinationPath: destination,
            };
          },
          signal,
        ),
    });
  }

  async delete(
    principal: AgentPrincipal,
    serverId: string,
    remotePath: string,
    recursive: boolean,
    idempotencyKey: string,
    signal?: AbortSignal,
    onCommitted?: () => void,
    onDispatched?: () => void,
  ) {
    requireScope(principal, "files:write");
    const access = resolveAccess(principal, serverId);
    const path = normalizeRemotePath(remotePath, "path");
    if (
      path === "/" ||
      path === "." ||
      path === ".." ||
      path.startsWith("../")
    ) {
      throw new AgentApiError(400, "INVALID_INPUT", "不能删除远程根目录");
    }
    return this.idempotentWithinLimit(principal, signal, {
      principal,
      projectId: access.projectId,
      operation: "delete",
      idempotencyKey,
      request: { serverId, path, recursive },
      onCommitted,
      onDispatched,
      execute: (markDispatched) =>
        this.connector.withSftp(
          access.projectId,
          serverId,
          async (sftp, operationSignal) => {
            const attrs = await sftpCall<Stats>((callback) =>
              sftp.lstat(path, callback),
            );
            throwIfAborted(operationSignal);
            await markDispatched();
            throwIfAborted(operationSignal);
            if (attrs.isDirectory()) {
              if (!recursive) {
                await sftpVoid((callback) => sftp.rmdir(path, callback));
              } else {
                await deleteRecursive(sftp, path, operationSignal);
              }
            } else {
              await sftpVoid((callback) => sftp.unlink(path, callback));
            }
            return { serverId, path };
          },
          signal,
        ),
    });
  }
}

export const AGENT_FILE_LIMITS = {
  maxReadBytes: MAX_READ_BYTES,
  maxReadChunkBytes: MAX_READ_CHUNK_BYTES,
  maxTransferBytes: MAX_TRANSFER_BYTES,
  maxDirectoryEntries: MAX_DIRECTORY_ENTRIES,
  maxConcurrentFileOperations: MAX_CONCURRENT_FILE_OPERATIONS,
  maxConcurrentFileOperationsPerPrincipal:
    MAX_CONCURRENT_FILE_OPERATIONS_PER_PRINCIPAL,
  maxConcurrentUploads: MAX_CONCURRENT_UPLOADS,
  maxConcurrentUploadsPerDevice: MAX_CONCURRENT_UPLOADS_PER_DEVICE,
  maxConcurrentDownloads: MAX_CONCURRENT_DOWNLOADS,
  maxConcurrentDownloadsPerPrincipal: MAX_CONCURRENT_DOWNLOADS_PER_PRINCIPAL,
};
