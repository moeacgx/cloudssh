import crypto from "crypto";
import { createReadStream } from "fs";
import { promises as fs } from "fs";
import type { FileHandle } from "fs/promises";
import https from "https";
import path from "path";
import Database from "better-sqlite3";
import { DatabaseSaveTrigger } from "../utils/database-save-trigger.js";
import { databaseLogger } from "../utils/logger.js";
import { extractRuntimeArchive } from "./runtime-archive.js";
import { compareVersions, versionFromReleaseTag } from "./version.js";

const RELEASE_BASE_URL =
  "https://github.com/moeacgx/cloudssh/releases/download";
const RELEASE_MANIFEST_NAME = "cloudssh-release.json";
const MANIFEST_NAME = "cloudssh-self-update.json";
const MANIFEST_SCHEMA_VERSION = 1;
const RELEASE_MANIFEST_SCHEMA_VERSION = 3;
const ENTRYPOINT_PROTOCOL_VERSION = 2;
const RUNTIME_CONTRACT = "cloudssh-node-glibc-v1";
const DATABASE_CONTRACT = "cloudssh-sqlite-backward-v1";
const STATE_SCHEMA_VERSION = 1;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_RUNTIME_BYTES = 1536 * 1024 * 1024;
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
const MODE_VALUES = new Set<UpdateMode>(["auto", "image", "binary"]);
const POINTER_PATTERN = /^(?:builtin|releases\/[A-Za-z0-9._-]{1,160})$/;
const BOOT_ID = crypto.randomUUID();

export type UpdateMode = "auto" | "image" | "binary";
export type ActiveUpdateSource = "image" | "binary";

export interface UpdateModeDetails {
  mode: UpdateMode;
  supportedModes: UpdateMode[];
  activeSource: ActiveUpdateSource;
  restartRequired: boolean;
}

interface RuntimeCompatibility {
  nodeMajor: number;
  modulesAbi: string;
  libc: "glibc" | "musl";
  libcVersion: string;
}

export interface UpdaterOperation {
  id: string;
  action: "update" | "rollback";
  targetVersion: string | null;
  state: string;
  phase: string;
  progress: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  backupArchive: string | null;
  failureCode: string | null;
  message: string | null;
  rollback?: { attempted?: boolean; state?: string } | null;
}

interface PersistedOperation extends UpdaterOperation {
  idempotencyKey: string;
  runnerPid?: number;
  runnerBootId?: string;
}

interface UpdaterState {
  schemaVersion: 1;
  builtinVersion: string | null;
  activeJobId: string | null;
  jobs: PersistedOperation[];
  idempotency: Record<string, string>;
}

interface UpdateMarker {
  schemaVersion: 1;
  jobId: string;
  action: "update" | "rollback";
  targetVersion: string;
  previousPointer: string;
  priorPreviousPointer?: string;
  targetPointer: string;
  createdAt: string;
}

interface RuntimeAsset {
  os: "linux";
  arch: "amd64" | "arm64";
  name: string;
  sha256: string;
  size: number;
}

interface TestHooks {
  dataDir?: string;
  fetch?: typeof fetch;
  forceDatabaseSave?: () => Promise<void>;
  requestRestart?: () => void;
  now?: () => Date;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  runtimeCompatibility?: RuntimeCompatibility;
  runtimeHealthCheck?: () => Promise<void>;
}

export interface UpdaterStatus {
  available: boolean;
  configured: boolean;
  enabled?: boolean;
  canRollback?: boolean;
  updaterVersion?: string;
  protocolVersion?: number;
  currentVersion?: string | null;
  previous?: {
    version?: string | null;
    configuredImage?: string | null;
  } | null;
  operation?: UpdaterOperation | null;
  message?: string;
  updateMode?: UpdateMode;
  supportedModes?: UpdateMode[];
  activeSource?: ActiveUpdateSource;
  restartRequired?: boolean;
}

export class UpdaterClientError extends Error {
  readonly code: string;
  readonly statusCode?: number;

  constructor(message: string, code: string, statusCode?: number) {
    super(message);
    this.name = "UpdaterClientError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

let testHooks: TestHooks = {};
let stateLock: Promise<void> = Promise.resolve();

export function setSelfUpdaterTestHooks(hooks: TestHooks): void {
  testHooks = hooks;
}

export function resetSelfUpdaterTestHooks(): void {
  testHooks = {};
  stateLock = Promise.resolve();
}

function dataDir(): string {
  return path.resolve(testHooks.dataDir ?? process.env.DATA_DIR ?? "./db/data");
}

function updaterDir(): string {
  return path.join(dataDir(), "self-update");
}

function now(): Date {
  return testHooks.now?.() ?? new Date();
}

function nowIso(): string {
  return now().toISOString();
}

async function requireHealthyResponse(
  url: string,
  acceptedStatuses: Set<number>,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    throw new UpdaterClientError(
      `启动健康检查无法访问 ${url}：${error instanceof Error ? error.message : "未知错误"}`,
      "UPDATE_HEALTH_CHECK_FAILED",
      503,
    );
  }
  await response.body?.cancel().catch(() => undefined);
  if (!acceptedStatuses.has(response.status)) {
    throw new UpdaterClientError(
      `启动健康检查 ${url} 返回 HTTP ${response.status}`,
      "UPDATE_HEALTH_CHECK_FAILED",
      503,
    );
  }
}

async function requireHealthyHttps(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = https.get(
      url,
      { rejectUnauthorized: false, timeout: 5_000 },
      (response) => {
        response.resume();
        if (response.statusCode === 200) resolve();
        else {
          reject(
            new UpdaterClientError(
              `启动健康检查 ${url} 返回 HTTP ${response.statusCode ?? 0}`,
              "UPDATE_HEALTH_CHECK_FAILED",
              503,
            ),
          );
        }
      },
    );
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", (error) =>
      reject(
        new UpdaterClientError(
          `启动健康检查无法访问 ${url}：${error.message}`,
          "UPDATE_HEALTH_CHECK_FAILED",
          503,
        ),
      ),
    );
  });
}

async function verifyRuntimeHealth(): Promise<void> {
  if (testHooks.runtimeHealthCheck) {
    await testHooks.runtimeHealthCheck();
    return;
  }
  await requireHealthyResponse("http://127.0.0.1:30001/health", new Set([200]));
  const port = Number(process.env.PORT || 8080);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new UpdaterClientError(
      "对外 Web 端口无效，无法确认新运行包",
      "UPDATE_HEALTH_CHECK_FAILED",
      503,
    );
  }
  const acceptedStatuses =
    process.env.ENABLE_SSL === "true"
      ? new Set([200, 301, 302, 307, 308])
      : new Set([200]);
  await requireHealthyResponse(
    `http://127.0.0.1:${port}/health`,
    acceptedStatuses,
  );
  await requireHealthyResponse(`http://127.0.0.1:${port}/`, acceptedStatuses);
  if (process.env.ENABLE_SSL === "true") {
    const sslPort = Number(process.env.SSL_PORT || 8443);
    if (!Number.isSafeInteger(sslPort) || sslPort < 1 || sslPort > 65_535) {
      throw new UpdaterClientError(
        "HTTPS 端口无效，无法确认新运行包",
        "UPDATE_HEALTH_CHECK_FAILED",
        503,
      );
    }
    await requireHealthyHttps(`https://127.0.0.1:${sslPort}/health`);
    await requireHealthyHttps(`https://127.0.0.1:${sslPort}/`);
  }
}

function emptyState(): UpdaterState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    builtinVersion: null,
    activeJobId: null,
    jobs: [],
    idempotency: {},
  };
}

async function atomicWrite(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (process.platform === "win32") {
    // Windows 的 rename 不能覆盖现有文件；容器内更新只在 Linux 启用，
    // 此分支仅用于桌面端读取配置和跨平台单元测试。
    await fs.rm(filePath, { force: true });
  }
  await fs.rename(temporary, filePath);
  const directoryHandle = await fs
    .open(path.dirname(filePath), "r")
    .catch(() => null);
  try {
    await directoryHandle?.sync().catch(() => undefined);
  } finally {
    await directoryHandle?.close();
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeFully(
  handle: FileHandle,
  value: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < value.byteLength) {
    const { bytesWritten } = await handle.write(
      value,
      offset,
      value.byteLength - offset,
    );
    if (bytesWritten <= 0) {
      throw new UpdaterClientError(
        "运行包写入被意外中断",
        "ASSET_WRITE_FAILED",
        500,
      );
    }
    offset += bytesWritten;
  }
}

async function quarantineInvalidFile(filePath: string): Promise<string | null> {
  const quarantinePath = `${filePath}.invalid-${now()
    .toISOString()
    .replace(/[^0-9]/g, "")}-${crypto.randomUUID()}`;
  try {
    await fs.rename(filePath, quarantinePath);
    return quarantinePath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new UpdaterClientError(
      `在线更新状态文件损坏：${path.basename(filePath)}`,
      "UPDATE_STATE_INVALID",
      500,
    );
  }
}

async function loadState(): Promise<UpdaterState> {
  const statePath = path.join(updaterDir(), "state.json");
  let state: UpdaterState | null = null;
  try {
    state = await readJson<UpdaterState>(statePath);
  } catch (error) {
    const quarantined = await quarantineInvalidFile(statePath);
    databaseLogger.warn("Invalid self-update state was quarantined", {
      operation: "cloudssh_self_update_state_recovered",
      quarantined: quarantined ? path.basename(quarantined) : undefined,
      reason: error instanceof Error ? error.message : "unknown",
    });
    return emptyState();
  }
  if (!state) return emptyState();
  if (
    state.schemaVersion !== STATE_SCHEMA_VERSION ||
    !Array.isArray(state.jobs) ||
    !state.idempotency ||
    typeof state.idempotency !== "object"
  ) {
    const quarantined = await quarantineInvalidFile(statePath);
    databaseLogger.warn("Unsupported self-update state was quarantined", {
      operation: "cloudssh_self_update_state_recovered",
      quarantined: quarantined ? path.basename(quarantined) : undefined,
    });
    return emptyState();
  }
  return state;
}

async function saveState(state: UpdaterState): Promise<void> {
  state.jobs = state.jobs.slice(-50);
  const validIds = new Set(state.jobs.map((job) => job.id));
  state.idempotency = Object.fromEntries(
    Object.entries(state.idempotency)
      .filter(([, id]) => validIds.has(id))
      .slice(-200),
  );
  await writeJson(path.join(updaterDir(), "state.json"), state);
}

async function withStateLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = stateLock;
  let release!: () => void;
  stateLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
  }
}

function publicOperation(operation: PersistedOperation): UpdaterOperation {
  const {
    idempotencyKey: _idempotencyKey,
    runnerPid: _runnerPid,
    runnerBootId: _runnerBootId,
    ...result
  } = operation;
  return result;
}

async function updateJob(
  jobId: string,
  patch: Partial<PersistedOperation>,
): Promise<PersistedOperation> {
  return withStateLock(async () => {
    const state = await loadState();
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (!job)
      throw new UpdaterClientError(
        "更新任务不存在",
        "UPDATE_JOB_NOT_FOUND",
        404,
      );
    Object.assign(job, patch, { updatedAt: nowIso() });
    await saveState(state);
    return { ...job };
  });
}

function validateVersion(version: string): string {
  const normalized = versionFromReleaseTag(version);
  if (!normalized || normalized !== version) {
    throw new UpdaterClientError(
      "更新版本格式无效",
      "INVALID_RELEASE_TAG",
      400,
    );
  }
  return normalized;
}

function runtimeArch(
  arch = testHooks.arch ?? process.arch,
): RuntimeAsset["arch"] {
  if (arch === "x64") return "amd64";
  if (arch === "arm64") return "arm64";
  throw new UpdaterClientError(
    `当前 CPU 架构 ${arch} 不支持容器内二进制更新`,
    "UPDATE_ARCH_UNSUPPORTED",
    409,
  );
}

function assertBinaryRuntimeSupported(): RuntimeAsset["arch"] {
  const platform = testHooks.platform ?? process.platform;
  if (platform !== "linux") {
    throw new UpdaterClientError(
      "容器内二进制更新只支持 Linux；请使用镜像或桌面客户端更新方式",
      "UPDATE_PLATFORM_UNSUPPORTED",
      409,
    );
  }
  runtimeCompatibility();
  return runtimeArch();
}

function runtimeCompatibility(): RuntimeCompatibility {
  if (testHooks.runtimeCompatibility) return testHooks.runtimeCompatibility;
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  const modulesAbi = process.versions.modules;
  const report = process.report?.getReport() as unknown as {
    header?: { glibcVersionRuntime?: unknown };
  };
  const glibcVersion = report?.header?.glibcVersionRuntime;
  if (
    Number.isSafeInteger(nodeMajor) &&
    modulesAbi &&
    typeof glibcVersion === "string" &&
    /^\d+\.\d+(?:\.\d+)?$/.test(glibcVersion)
  ) {
    return {
      nodeMajor,
      modulesAbi,
      libc: "glibc",
      libcVersion: glibcVersion,
    };
  }

  const configuredLibc = process.env.CLOUDSSH_LIBC_KIND;
  const configuredVersion = process.env.CLOUDSSH_LIBC_VERSION;
  if (
    Number.isSafeInteger(nodeMajor) &&
    modulesAbi &&
    (configuredLibc === "glibc" || configuredLibc === "musl") &&
    typeof configuredVersion === "string" &&
    /^\d+\.\d+(?:\.\d+)?$/.test(configuredVersion)
  ) {
    return {
      nodeMajor,
      modulesAbi,
      libc: configuredLibc,
      libcVersion: configuredVersion,
    };
  }

  throw new UpdaterClientError(
    "无法确认当前 Node 原生模块 ABI 或 libc 版本，已停止二进制更新",
    "RUNTIME_COMPATIBILITY_UNKNOWN",
    409,
  );
}

function compareNumericVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (
    let index = 0;
    index < Math.max(leftParts.length, rightParts.length);
    index += 1
  ) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

export async function getUpdateMode(): Promise<UpdateMode> {
  const environmentMode =
    process.env.CLOUDSSH_UPDATE_MODE?.trim().toLowerCase();
  const fallbackMode = MODE_VALUES.has(environmentMode as UpdateMode)
    ? (environmentMode as UpdateMode)
    : "auto";
  try {
    const value = (
      await fs.readFile(path.join(dataDir(), "update-mode.txt"), "utf8")
    ).trim();
    return MODE_VALUES.has(value as UpdateMode)
      ? (value as UpdateMode)
      : fallbackMode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallbackMode;
    }
    throw error;
  }
}

export async function setUpdateMode(mode: unknown): Promise<UpdateMode> {
  if (typeof mode !== "string" || !MODE_VALUES.has(mode as UpdateMode)) {
    throw new UpdaterClientError("更新方式无效", "UPDATE_MODE_INVALID", 400);
  }
  await atomicWrite(path.join(dataDir(), "update-mode.txt"), `${mode}\n`);
  return mode as UpdateMode;
}

function modeBlockedError(): UpdaterClientError {
  return new UpdaterClientError(
    "当前选择了镜像更新。容器内不能替换自身镜像，请在宿主机拉取公开的 ghcr.io/moeacgx/cloudssh 镜像并重建容器。",
    "IMAGE_UPDATE_REQUIRES_EXTERNAL_REDEPLOY",
    409,
  );
}

function releaseAssetUrl(version: string, assetName: string): string {
  return `${RELEASE_BASE_URL}/release-${version}-tag/${encodeURIComponent(assetName)}`;
}

async function readResponseBytes(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new UpdaterClientError(
      `GitHub Release 返回 HTTP ${response.status}`,
      "RELEASE_ASSET_UNAVAILABLE",
      502,
    );
  }
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new UpdaterClientError(
      "发布清单超过大小限制",
      "MANIFEST_TOO_LARGE",
      502,
    );
  }
  const reader = response.body?.getReader();
  if (!reader)
    throw new UpdaterClientError("发布清单响应为空", "MANIFEST_EMPTY", 502);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new UpdaterClientError(
          "发布清单超过大小限制",
          "MANIFEST_TOO_LARGE",
          502,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function validateManifest(
  value: unknown,
  version: string,
  arch: RuntimeAsset["arch"],
  expectedRevision: string,
  compatibility: RuntimeCompatibility,
): RuntimeAsset {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UpdaterClientError("发布清单结构无效", "MANIFEST_INVALID", 502);
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new UpdaterClientError(
      "发布清单版本不受支持",
      "MANIFEST_SCHEMA_UNSUPPORTED",
      502,
    );
  }
  if (manifest.version !== version || manifest.channel !== "stable") {
    throw new UpdaterClientError(
      "发布清单版本或通道不匹配",
      "MANIFEST_VERSION_MISMATCH",
      502,
    );
  }
  if (
    manifest.revision !== expectedRevision ||
    !Number.isSafeInteger(manifest.entrypointProtocol) ||
    Number(manifest.entrypointProtocol) < 2 ||
    Number(manifest.entrypointProtocol) > 100
  ) {
    throw new UpdaterClientError(
      "发布清单源码版本或入口协议无效",
      "MANIFEST_PROTOCOL_INVALID",
      502,
    );
  }
  const requiredRuntime =
    manifest.runtimeCompatibility &&
    typeof manifest.runtimeCompatibility === "object" &&
    !Array.isArray(manifest.runtimeCompatibility)
      ? (manifest.runtimeCompatibility as Record<string, unknown>)
      : null;
  const requiredLibcVersion =
    typeof requiredRuntime?.libcVersion === "string"
      ? requiredRuntime.libcVersion
      : "";
  const databaseCompatibility =
    manifest.databaseCompatibility &&
    typeof manifest.databaseCompatibility === "object" &&
    !Array.isArray(manifest.databaseCompatibility)
      ? (manifest.databaseCompatibility as Record<string, unknown>)
      : null;
  if (
    requiredRuntime?.contract !== RUNTIME_CONTRACT ||
    requiredRuntime?.nodeMajor !== compatibility.nodeMajor ||
    requiredRuntime.modulesAbi !== compatibility.modulesAbi ||
    requiredRuntime.libc !== compatibility.libc ||
    !/^\d+\.\d+(?:\.\d+)?$/.test(requiredLibcVersion) ||
    compareNumericVersions(compatibility.libcVersion, requiredLibcVersion) < 0
  ) {
    throw new UpdaterClientError(
      "运行包的 Node 主版本、原生模块 ABI 或 libc 与当前容器不兼容",
      "RUNTIME_COMPATIBILITY_MISMATCH",
      409,
    );
  }
  if (
    databaseCompatibility?.contract !== DATABASE_CONTRACT ||
    databaseCompatibility.rollbackSafe !== true
  ) {
    throw new UpdaterClientError(
      "运行包未声明数据库向后兼容，必须改用镜像更新并人工验证迁移",
      "DATABASE_ROLLBACK_UNSAFE",
      409,
    );
  }
  if (
    !Array.isArray(manifest.assets) ||
    manifest.assets.length < 1 ||
    manifest.assets.length > 8
  ) {
    throw new UpdaterClientError(
      "发布清单缺少运行包",
      "MANIFEST_ASSET_INVALID",
      502,
    );
  }

  const candidates = manifest.assets.filter((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const asset = candidate as Record<string, unknown>;
    return asset.os === "linux" && asset.arch === arch;
  });
  if (candidates.length !== 1) {
    throw new UpdaterClientError(
      "发布清单没有唯一匹配当前架构的运行包",
      "MANIFEST_ARCH_MISMATCH",
      502,
    );
  }
  const asset = candidates[0] as Record<string, unknown>;
  const expectedName = `cloudssh-runtime-${version}-linux-${arch}.tar.gz`;
  if (asset.name !== expectedName) {
    throw new UpdaterClientError(
      "发布清单运行包名称无效",
      "MANIFEST_ASSET_INVALID",
      502,
    );
  }
  const sha256 =
    typeof asset.sha256 === "string" ? asset.sha256.toLowerCase() : "";
  const size = Number(asset.size);
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new UpdaterClientError(
      "发布清单运行包 SHA-256 无效",
      "MANIFEST_ASSET_INVALID",
      502,
    );
  }
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_RUNTIME_BYTES) {
    throw new UpdaterClientError(
      "发布清单运行包大小无效",
      "MANIFEST_ASSET_INVALID",
      502,
    );
  }
  return { os: "linux", arch, name: expectedName, sha256, size };
}

function validateReleaseManifest(
  value: unknown,
  version: string,
): { runtimeSha256: string; revision: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UpdaterClientError(
      "顶层发布清单结构无效",
      "RELEASE_MANIFEST_INVALID",
      502,
    );
  }
  const manifest = value as Record<string, unknown>;
  const runtime =
    manifest.runtime &&
    typeof manifest.runtime === "object" &&
    !Array.isArray(manifest.runtime)
      ? (manifest.runtime as Record<string, unknown>)
      : null;
  const runtimeSha256 =
    typeof runtime?.sha256 === "string" ? runtime.sha256.toLowerCase() : "";
  const revision =
    typeof manifest.revision === "string"
      ? manifest.revision.toLowerCase()
      : "";
  if (
    manifest.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION ||
    manifest.channel !== "stable" ||
    manifest.version !== version ||
    manifest.image !== "ghcr.io/moeacgx/cloudssh" ||
    typeof manifest.digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(manifest.digest) ||
    !/^[0-9a-f]{40,64}$/.test(revision) ||
    runtime?.manifest !== MANIFEST_NAME ||
    !/^[0-9a-f]{64}$/.test(runtimeSha256) ||
    !Number.isSafeInteger(manifest.minEntrypointProtocol) ||
    Number(manifest.minEntrypointProtocol) < 1 ||
    Number(manifest.minEntrypointProtocol) > ENTRYPOINT_PROTOCOL_VERSION ||
    manifest.deploymentContract !== "cloudssh-self-update-v1"
  ) {
    throw new UpdaterClientError(
      "顶层发布清单与当前自更新协议不兼容",
      "RELEASE_MANIFEST_INVALID",
      502,
    );
  }
  return { runtimeSha256, revision };
}

async function fetchJsonReleaseAsset(
  version: string,
  name: string,
): Promise<Buffer> {
  const response = await (testHooks.fetch ?? fetch)(
    releaseAssetUrl(version, name),
    {
      headers: {
        Accept: "application/json",
        "User-Agent": "CloudSSH-Self-Updater",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    },
  );
  validateDownloadResponseUrl(response);
  return readResponseBytes(response, MAX_MANIFEST_BYTES);
}

function parseManifestJson(body: Buffer, label: string): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new UpdaterClientError(
      `${label}不是有效 JSON`,
      "MANIFEST_INVALID_JSON",
      502,
    );
  }
}

async function fetchRuntimeAsset(
  version: string,
  arch: RuntimeAsset["arch"],
): Promise<RuntimeAsset> {
  const releaseBody = await fetchJsonReleaseAsset(
    version,
    RELEASE_MANIFEST_NAME,
  );
  const binding = validateReleaseManifest(
    parseManifestJson(releaseBody, "顶层发布清单"),
    version,
  );
  const runtimeBody = await fetchJsonReleaseAsset(version, MANIFEST_NAME);
  const actualRuntimeSha256 = crypto
    .createHash("sha256")
    .update(runtimeBody)
    .digest("hex");
  if (actualRuntimeSha256 !== binding.runtimeSha256) {
    throw new UpdaterClientError(
      "运行包清单 SHA-256 与顶层发布清单不一致",
      "RUNTIME_MANIFEST_HASH_MISMATCH",
      502,
    );
  }
  return validateManifest(
    parseManifestJson(runtimeBody, "运行包清单"),
    version,
    arch,
    binding.revision,
    runtimeCompatibility(),
  );
}

function validateDownloadResponseUrl(response: Response): void {
  const url = new URL(response.url || "https://github.com/");
  if (url.protocol !== "https:" || !ALLOWED_DOWNLOAD_HOSTS.has(url.hostname)) {
    throw new UpdaterClientError(
      "运行包重定向到了不受信任的地址",
      "ASSET_REDIRECT_INVALID",
      502,
    );
  }
}

function destinationPath(root: string, relative: string): string {
  const destination = path.resolve(root, ...relative.split("/"));
  if (!destination.startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw new UpdaterClientError(
      "运行包校验路径越界",
      "RUNTIME_PACKAGE_INVALID",
      502,
    );
  }
  return destination;
}

async function downloadRuntimeAsset(
  version: string,
  asset: RuntimeAsset,
  destination: string,
  jobId: string,
): Promise<void> {
  const response = await (testHooks.fetch ?? fetch)(
    releaseAssetUrl(version, asset.name),
    {
      headers: {
        Accept: "application/octet-stream",
        "User-Agent": "CloudSSH-Self-Updater",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(30 * 60_000),
    },
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new UpdaterClientError(
      `运行包下载失败（HTTP ${response.status}）`,
      "ASSET_DOWNLOAD_FAILED",
      502,
    );
  }
  validateDownloadResponseUrl(response);
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength !== asset.size
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new UpdaterClientError(
        "运行包响应大小与发布清单不一致",
        "ASSET_SIZE_MISMATCH",
        502,
      );
    }
  }

  const reader = response.body?.getReader();
  if (!reader)
    throw new UpdaterClientError(
      "运行包响应为空",
      "ASSET_DOWNLOAD_FAILED",
      502,
    );
  const hash = crypto.createHash("sha256");
  const handle = await fs.open(destination, "wx", 0o600);
  let downloaded = 0;
  let nextProgressAt = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      downloaded += value.byteLength;
      if (downloaded > asset.size || downloaded > MAX_RUNTIME_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new UpdaterClientError(
          "运行包超过发布清单声明的大小",
          "ASSET_SIZE_MISMATCH",
          502,
        );
      }
      hash.update(value);
      await writeFully(handle, value);
      const progress = 25 + Math.floor((downloaded / asset.size) * 35);
      if (progress >= nextProgressAt) {
        nextProgressAt = progress + 2;
        await updateJob(jobId, {
          progress,
          message: `正在下载运行包（${progress}%）`,
        });
      }
    }
    await handle.sync();
  } finally {
    reader.releaseLock();
    await handle.close();
  }
  if (downloaded !== asset.size) {
    throw new UpdaterClientError(
      "运行包实际大小与发布清单不一致",
      "ASSET_SIZE_MISMATCH",
      502,
    );
  }
  if (hash.digest("hex") !== asset.sha256) {
    throw new UpdaterClientError(
      "运行包 SHA-256 校验失败",
      "ASSET_HASH_MISMATCH",
      502,
    );
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function copyRegularFile(
  source: string,
  destination: string,
): Promise<boolean> {
  try {
    const stat = await fs.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("数据库源文件不是普通文件");
    await fs.copyFile(source, destination);
    await fs.chmod(destination, 0o600);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function createDatabaseSnapshot(jobId: string): Promise<string> {
  await (
    testHooks.forceDatabaseSave ??
    (() => DatabaseSaveTrigger.forceSave("self_update_snapshot"))
  )();
  const snapshotDir = path.join(
    dataDir(),
    "backups",
    `self-update-${now().toISOString().replace(/[:.]/g, "-")}-${jobId.slice(0, 8)}`,
  );
  await fs.mkdir(snapshotDir, { recursive: true, mode: 0o700 });

  const files: Array<{ name: string; size: number; sha256: string }> = [];
  for (const name of [
    "db.sqlite.encrypted",
    "db.sqlite.encrypted.meta",
    "db.sqlite",
  ]) {
    const destination = path.join(snapshotDir, name);
    if (await copyRegularFile(path.join(dataDir(), name), destination)) {
      const stat = await fs.stat(destination);
      files.push({
        name,
        size: stat.size,
        sha256: await hashFile(destination),
      });
    }
  }

  const agentDatabase = path.join(dataDir(), "agent", "agent-security.sqlite");
  try {
    const stat = await fs.lstat(agentDatabase);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("Agent 数据库不是普通文件");
    const destination = path.join(snapshotDir, "agent-security.sqlite");
    const source = new Database(agentDatabase, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      await source.backup(destination);
    } finally {
      source.close();
    }
    await fs.chmod(destination, 0o600);
    const copied = await fs.stat(destination);
    files.push({
      name: "agent-security.sqlite",
      size: copied.size,
      sha256: await hashFile(destination),
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (files.length === 0) {
    throw new UpdaterClientError(
      "没有找到可快照的数据库文件",
      "DATABASE_SNAPSHOT_EMPTY",
      500,
    );
  }
  const names = new Set(files.map((file) => file.name));
  if (
    names.has("db.sqlite.encrypted") &&
    !names.has("db.sqlite.encrypted.meta")
  ) {
    throw new UpdaterClientError(
      "加密数据库快照缺少元数据文件",
      "DATABASE_SNAPSHOT_INCOMPLETE",
      500,
    );
  }
  await writeJson(path.join(snapshotDir, "manifest.json"), {
    schemaVersion: 1,
    reason: "cloudssh-self-update",
    createdAt: nowIso(),
    files,
    excludes: [".env", "system.key", "database.key", "encryption.key"],
  });
  return snapshotDir;
}

async function requirePath(
  root: string,
  relative: string,
  kind: "file" | "directory",
): Promise<void> {
  const target = destinationPath(root, relative);
  const stat = await fs.lstat(target).catch(() => null);
  const valid =
    stat &&
    !stat.isSymbolicLink() &&
    (kind === "file" ? stat.isFile() : stat.isDirectory());
  if (!valid)
    throw new UpdaterClientError(
      `运行包缺少 ${relative}`,
      "RUNTIME_PACKAGE_INCOMPLETE",
      502,
    );
}

async function validateExtractedRuntime(
  root: string,
  version: string,
): Promise<void> {
  const rootStat = await fs.lstat(root).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new UpdaterClientError(
      "运行包根目录无效",
      "RUNTIME_PACKAGE_INVALID",
      502,
    );
  }
  const packagePath = destinationPath(root, "package.json");
  await requirePath(root, "package.json", "file");
  let packageJson: Record<string, unknown>;
  try {
    packageJson = JSON.parse(await fs.readFile(packagePath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    throw new UpdaterClientError(
      "运行包 package.json 无效",
      "RUNTIME_PACKAGE_INVALID",
      502,
    );
  }
  if (packageJson.version !== version) {
    throw new UpdaterClientError(
      "运行包版本与发布清单不一致",
      "RUNTIME_VERSION_MISMATCH",
      502,
    );
  }
  for (const [relative, kind] of [
    ["html", "directory"],
    ["html/index.html", "file"],
    ["dist/backend", "directory"],
    ["dist/backend/backend/starter.js", "file"],
    ["node_modules", "directory"],
    ["nginx", "directory"],
    ["nginx/nginx.conf.template", "file"],
    ["nginx/nginx-https.conf.template", "file"],
    ["self-update/entrypoint.sh", "file"],
  ] as const) {
    await requirePath(root, relative, kind);
  }
  const entrypoint = destinationPath(root, "self-update/entrypoint.sh");
  const entrypointPrefix = (await fs.readFile(entrypoint, "utf8")).slice(
    0,
    128,
  );
  if (!entrypointPrefix.startsWith("#!/bin/sh")) {
    throw new UpdaterClientError(
      "运行包自更新入口无效",
      "RUNTIME_PACKAGE_INVALID",
      502,
    );
  }
  await fs.chmod(entrypoint, 0o755);
}

async function readPointer(
  name: "app-current" | "app-previous",
): Promise<string | null> {
  try {
    const value = (
      await fs.readFile(path.join(updaterDir(), name), "utf8")
    ).trim();
    if (!POINTER_PATTERN.test(value)) throw new Error("invalid pointer");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    const pointerPath = path.join(updaterDir(), name);
    const quarantined = await quarantineInvalidFile(pointerPath);
    databaseLogger.warn("Invalid self-update pointer was quarantined", {
      operation: "cloudssh_self_update_pointer_recovered",
      pointer: name,
      quarantined: quarantined ? path.basename(quarantined) : undefined,
    });
    return null;
  }
}

async function writePointer(
  name: "app-current" | "app-previous",
  value: string,
): Promise<void> {
  if (!POINTER_PATTERN.test(value)) throw new Error("invalid update pointer");
  await atomicWrite(path.join(updaterDir(), name), `${value}\n`);
}

async function versionForPointer(
  pointer: string,
  state: UpdaterState,
): Promise<string | null> {
  if (pointer === "builtin") return state.builtinVersion;
  try {
    const packageJson = JSON.parse(
      await fs.readFile(
        path.join(updaterDir(), pointer, "package.json"),
        "utf8",
      ),
    ) as { version?: unknown };
    return typeof packageJson.version === "string" ? packageJson.version : null;
  } catch {
    return null;
  }
}

export async function getUpdateModeDetails(
  selectedMode?: UpdateMode,
): Promise<UpdateModeDetails> {
  const mode = selectedMode ?? (await getUpdateMode());
  const state = await withStateLock(() => loadState());
  const activeSource: ActiveUpdateSource =
    process.env.CLOUDSSH_ACTIVE_APP_SOURCE === "binary" ? "binary" : "image";
  const currentPointer = (await readPointer("app-current")) ?? "builtin";
  const binaryVersion =
    currentPointer === "builtin"
      ? null
      : await versionForPointer(currentPointer, state);
  const imageVersion =
    process.env.CLOUDSSH_IMAGE_VERSION ||
    state.builtinVersion ||
    (activeSource === "image" ? process.env.VERSION : null);

  let desiredSource: ActiveUpdateSource = "image";
  if (mode === "binary" && binaryVersion) {
    desiredSource = "binary";
  } else if (mode === "auto" && binaryVersion) {
    const comparison = compareVersions(
      imageVersion || undefined,
      binaryVersion,
    );
    desiredSource = comparison !== null && comparison > 0 ? "image" : "binary";
  }
  return {
    mode,
    supportedModes: ["auto", "image", "binary"],
    activeSource,
    restartRequired: desiredSource !== activeSource,
  };
}

function requestRestart(): void {
  if (testHooks.requestRestart) {
    testHooks.requestRestart();
    return;
  }
  const timer = setTimeout(() => process.kill(process.pid, "SIGTERM"), 750);
  timer.unref();
}

async function failJob(jobId: string, error: unknown): Promise<void> {
  const code =
    error instanceof UpdaterClientError ? error.code : "UPDATE_INTERNAL_ERROR";
  const message = error instanceof Error ? error.message : "容器内更新失败";
  await withStateLock(async () => {
    const state = await loadState();
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (!job)
      throw new UpdaterClientError(
        "更新任务不存在",
        "UPDATE_JOB_NOT_FOUND",
        404,
      );
    Object.assign(job, {
      state: "failed",
      phase: "failed",
      progress: 100,
      completedAt: nowIso(),
      updatedAt: nowIso(),
      failureCode: code,
      message,
    });
    if (state.activeJobId === jobId) state.activeJobId = null;
    await saveState(state);
  });
  databaseLogger.error("CloudSSH self update failed", error, {
    operation: "cloudssh_self_update_failed",
    jobId,
    code,
  });
}

async function restorePointersAfterFailedActivation(
  marker: UpdateMarker,
): Promise<void> {
  await writePointer("app-current", marker.previousPointer);
  if (
    marker.priorPreviousPointer &&
    POINTER_PATTERN.test(marker.priorPreviousPointer)
  ) {
    await writePointer("app-previous", marker.priorPreviousPointer);
  }
  await fs.rm(path.join(updaterDir(), "pending.json"), { force: true });
  await fs.rm(path.join(updaterDir(), "boot-attempted"), { force: true });
}

async function runUpdate(jobId: string, version: string): Promise<void> {
  let staging = "";
  let archive = "";
  let activationMarker: UpdateMarker | null = null;
  try {
    const arch = assertBinaryRuntimeSupported();
    await updateJob(jobId, {
      state: "running",
      phase: "checking",
      progress: 5,
      runnerPid: process.pid,
      message: "正在校验 GitHub Release 运行包",
    });
    const asset = await fetchRuntimeAsset(version, arch);

    const stagingRoot = path.join(updaterDir(), "staging");
    await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    staging = path.join(stagingRoot, `${version}-${crypto.randomUUID()}`);
    await fs.mkdir(staging, { mode: 0o700 });
    archive = path.join(stagingRoot, `${jobId}.tar.gz.part`);
    await updateJob(jobId, {
      phase: "pulling",
      progress: 25,
      message: "正在从公开 GitHub Release 下载运行包",
    });
    await downloadRuntimeAsset(version, asset, archive, jobId);

    await updateJob(jobId, {
      progress: 65,
      message: "正在安全解包并核验运行时文件",
    });
    await extractRuntimeArchive(archive, staging);
    await validateExtractedRuntime(staging, version);

    await updateJob(jobId, {
      phase: "backing_up",
      progress: 72,
      message: "正在保存数据库并创建更新前快照",
    });
    const backupArchive = await createDatabaseSnapshot(jobId);
    await updateJob(jobId, { backupArchive, progress: 78 });

    const releaseName = `${version}-${asset.sha256.slice(0, 12)}-${jobId.slice(0, 8)}`;
    const releaseRelative = `releases/${releaseName}`;
    const releaseDirectory = path.join(updaterDir(), "releases", releaseName);
    await fs.mkdir(path.dirname(releaseDirectory), {
      recursive: true,
      mode: 0o700,
    });
    await fs.rename(staging, releaseDirectory);
    staging = "";

    const currentPointer =
      process.env.CLOUDSSH_ACTIVE_APP_SOURCE === "image"
        ? "builtin"
        : ((await readPointer("app-current")) ?? "builtin");
    const priorPreviousPointer =
      (await readPointer("app-previous")) ?? currentPointer;
    await withStateLock(async () => {
      const state = await loadState();
      if (!state.builtinVersion)
        state.builtinVersion = process.env.VERSION || null;
      await saveState(state);
    });
    const marker: UpdateMarker = {
      schemaVersion: 1,
      jobId,
      action: "update",
      targetVersion: version,
      previousPointer: currentPointer,
      priorPreviousPointer,
      targetPointer: releaseRelative,
      createdAt: nowIso(),
    };
    activationMarker = marker;
    await writeJson(path.join(updaterDir(), "pending.json"), marker);
    await writePointer("app-previous", currentPointer);
    await writePointer("app-current", releaseRelative);
    await updateJob(jobId, {
      state: "restarting",
      phase: "starting",
      progress: 92,
      message: "运行包已切换，正在优雅重启容器",
    });
    requestRestart();
  } catch (error) {
    if (activationMarker) {
      await restorePointersAfterFailedActivation(activationMarker).catch(
        () => undefined,
      );
    }
    await failJob(jobId, error);
  } finally {
    if (archive) await fs.rm(archive, { force: true }).catch(() => undefined);
    if (staging)
      await fs
        .rm(staging, { recursive: true, force: true })
        .catch(() => undefined);
  }
}

async function runRollback(jobId: string): Promise<void> {
  let activationMarker: UpdateMarker | null = null;
  try {
    assertBinaryRuntimeSupported();
    await updateJob(jobId, {
      state: "running",
      phase: "backing_up",
      progress: 20,
      runnerPid: process.pid,
      message: "正在保存数据库并创建回退前快照",
    });
    const backupArchive = await createDatabaseSnapshot(jobId);
    const state = await withStateLock(() => loadState());
    const currentPointer =
      process.env.CLOUDSSH_ACTIVE_APP_SOURCE === "image"
        ? "builtin"
        : ((await readPointer("app-current")) ?? "builtin");
    const previousPointer = await readPointer("app-previous");
    if (!previousPointer || previousPointer === currentPointer) {
      throw new UpdaterClientError(
        "没有可回退的上一运行版本",
        "ROLLBACK_NOT_AVAILABLE",
        409,
      );
    }
    const targetVersion = await versionForPointer(previousPointer, state);
    if (!targetVersion)
      throw new UpdaterClientError(
        "上一运行版本无法验证",
        "ROLLBACK_TARGET_INVALID",
        409,
      );
    const marker: UpdateMarker = {
      schemaVersion: 1,
      jobId,
      action: "rollback",
      targetVersion,
      previousPointer: currentPointer,
      priorPreviousPointer: previousPointer,
      targetPointer: previousPointer,
      createdAt: nowIso(),
    };
    activationMarker = marker;
    await writeJson(path.join(updaterDir(), "pending.json"), marker);
    await writePointer("app-previous", currentPointer);
    await writePointer("app-current", previousPointer);
    await updateJob(jobId, {
      targetVersion,
      backupArchive,
      state: "restarting",
      phase: "rolling_back",
      progress: 92,
      message: `已切换到 ${targetVersion}，正在优雅重启容器`,
    });
    requestRestart();
  } catch (error) {
    if (activationMarker) {
      await restorePointersAfterFailedActivation(activationMarker).catch(
        () => undefined,
      );
    }
    await failJob(jobId, error);
  }
}

async function createJob(
  action: "update" | "rollback",
  targetVersion: string | null,
  idempotencyKey: string,
): Promise<{ job: PersistedOperation; created: boolean }> {
  return withStateLock(async () => {
    const state = await loadState();
    const existingId = state.idempotency[idempotencyKey];
    const existing = existingId
      ? state.jobs.find((job) => job.id === existingId)
      : null;
    if (existing) return { job: { ...existing }, created: false };
    const active = state.activeJobId
      ? state.jobs.find((job) => job.id === state.activeJobId)
      : null;
    if (
      active &&
      !["completed", "failed", "rolled_back"].includes(active.state)
    ) {
      throw new UpdaterClientError(
        "已有更新或回退任务正在执行",
        "UPDATE_ALREADY_RUNNING",
        409,
      );
    }
    const timestamp = nowIso();
    const job: PersistedOperation = {
      id: crypto.randomUUID(),
      action,
      targetVersion,
      state: "queued",
      phase: action === "rollback" ? "rolling_back" : "queued",
      progress: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
      backupArchive: null,
      failureCode: null,
      message: "任务已排队",
      rollback: null,
      idempotencyKey,
      runnerPid: process.pid,
      runnerBootId: BOOT_ID,
    };
    state.jobs.push(job);
    state.activeJobId = job.id;
    state.idempotency[idempotencyKey] = job.id;
    await saveState(state);
    return { job: { ...job }, created: true };
  });
}

export async function startSelfUpdate(input: {
  targetVersion: string;
  idempotencyKey: string;
}): Promise<UpdaterOperation> {
  if ((await getUpdateMode()) === "image") throw modeBlockedError();
  assertBinaryRuntimeSupported();
  const version = validateVersion(input.targetVersion);
  const { job, created } = await createJob(
    "update",
    version,
    input.idempotencyKey,
  );
  if (created) setImmediate(() => void runUpdate(job.id, version));
  return publicOperation(job);
}

export async function startSelfRollback(input: {
  idempotencyKey: string;
}): Promise<UpdaterOperation> {
  if ((await getUpdateMode()) === "image") throw modeBlockedError();
  assertBinaryRuntimeSupported();
  const previous = await readPointer("app-previous");
  if (!previous)
    throw new UpdaterClientError(
      "没有可回退的上一运行版本",
      "ROLLBACK_NOT_AVAILABLE",
      409,
    );
  const { job, created } = await createJob(
    "rollback",
    null,
    input.idempotencyKey,
  );
  if (created) setImmediate(() => void runRollback(job.id));
  return publicOperation(job);
}

export async function getSelfUpdateJob(
  jobId: string,
): Promise<UpdaterOperation> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(jobId)) {
    throw new UpdaterClientError("无效的更新任务编号", "INVALID_JOB_ID", 400);
  }
  const state = await withStateLock(() => loadState());
  const job = state.jobs.find((candidate) => candidate.id === jobId);
  if (!job)
    throw new UpdaterClientError("更新任务不存在", "UPDATE_JOB_NOT_FOUND", 404);
  return publicOperation(job);
}

export async function getSelfUpdateHistory(
  limit = 20,
): Promise<UpdaterOperation[]> {
  const state = await withStateLock(() => loadState());
  const bounded = Math.max(1, Math.min(Math.floor(limit), 100));
  return state.jobs.slice(-bounded).reverse().map(publicOperation);
}

export async function getSelfUpdaterStatus(): Promise<UpdaterStatus> {
  const modeDetails = await getUpdateModeDetails();
  const mode = modeDetails.mode;
  const state = await withStateLock(() => loadState());
  const operation = state.activeJobId
    ? (state.jobs.find((job) => job.id === state.activeJobId) ?? null)
    : null;
  let supported = true;
  let supportMessage: string | undefined;
  try {
    assertBinaryRuntimeSupported();
  } catch (error) {
    supported = false;
    supportMessage =
      error instanceof Error ? error.message : "当前平台不支持容器内更新";
  }
  const previousPointer = await readPointer("app-previous");
  const previousVersion = previousPointer
    ? await versionForPointer(previousPointer, state)
    : null;
  const enabled = mode !== "image" && supported;
  return {
    available: true,
    configured: true,
    enabled,
    canRollback: enabled && Boolean(previousPointer && previousVersion),
    updaterVersion: process.env.VERSION || "builtin",
    protocolVersion: 2,
    currentVersion: process.env.VERSION || null,
    previous: previousVersion ? { version: previousVersion } : null,
    operation: operation ? publicOperation(operation) : null,
    updateMode: mode,
    supportedModes: modeDetails.supportedModes,
    activeSource: modeDetails.activeSource,
    restartRequired: modeDetails.restartRequired,
    message:
      mode === "image"
        ? modeBlockedError().message
        : supportMessage || "容器内自更新已就绪；运行包来自公开 GitHub Release",
  };
}

function isValidUpdateMarker(value: unknown): value is UpdateMarker {
  if (!value || typeof value !== "object") return false;
  const marker = value as Partial<UpdateMarker>;
  return (
    marker.schemaVersion === 1 &&
    typeof marker.jobId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(marker.jobId) &&
    (marker.action === "update" || marker.action === "rollback") &&
    typeof marker.targetVersion === "string" &&
    versionFromReleaseTag(marker.targetVersion) === marker.targetVersion &&
    typeof marker.previousPointer === "string" &&
    POINTER_PATTERN.test(marker.previousPointer) &&
    (marker.priorPreviousPointer === undefined ||
      (typeof marker.priorPreviousPointer === "string" &&
        POINTER_PATTERN.test(marker.priorPreviousPointer))) &&
    typeof marker.targetPointer === "string" &&
    POINTER_PATTERN.test(marker.targetPointer) &&
    typeof marker.createdAt === "string"
  );
}

async function recoverInvalidPendingMarker(markerPath: string): Promise<void> {
  const previousPointer = (await readPointer("app-previous")) ?? "builtin";
  await writePointer("app-current", previousPointer);
  const quarantined = await quarantineInvalidFile(markerPath);
  await fs.rm(path.join(updaterDir(), "boot-attempted"), { force: true });
  await withStateLock(async () => {
    const state = await loadState();
    const active = state.activeJobId
      ? state.jobs.find((job) => job.id === state.activeJobId)
      : null;
    if (!active) return;
    Object.assign(active, {
      state: "failed",
      phase: "failed",
      progress: 100,
      completedAt: nowIso(),
      updatedAt: nowIso(),
      failureCode: "UPDATE_MARKER_INVALID",
      message: "待确认更新标记损坏，已恢复上一运行目录指针",
    });
    state.activeJobId = null;
    await saveState(state);
  });
  databaseLogger.warn("Invalid self-update marker was quarantined", {
    operation: "cloudssh_self_update_marker_recovered",
    quarantined: quarantined ? path.basename(quarantined) : undefined,
    restoredPointer: previousPointer,
  });
}

function recoveredJobFromMarker(marker: UpdateMarker): PersistedOperation {
  const timestamp = nowIso();
  return {
    id: marker.jobId,
    action: marker.action,
    targetVersion: marker.targetVersion,
    state: "restarting",
    phase: "starting",
    progress: 92,
    createdAt: marker.createdAt,
    updatedAt: timestamp,
    completedAt: null,
    backupArchive: null,
    failureCode: null,
    message: "已从待确认标记恢复更新任务",
    rollback: null,
    idempotencyKey: `recovered:${marker.jobId}`,
    runnerBootId: BOOT_ID,
    runnerPid: process.pid,
  };
}

async function cleanupObsoleteRuntimeFiles(): Promise<void> {
  const pointers = await Promise.all([
    readPointer("app-current"),
    readPointer("app-previous"),
  ]);
  const keep = new Set(
    pointers
      .filter((pointer): pointer is string => Boolean(pointer))
      .filter((pointer) => pointer.startsWith("releases/"))
      .map((pointer) => pointer.slice("releases/".length)),
  );
  const releasesRoot = path.join(updaterDir(), "releases");
  const entries = await fs
    .readdir(releasesRoot, { withFileTypes: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      /^[A-Za-z0-9._-]{1,160}$/.test(entry.name) &&
      !keep.has(entry.name)
    ) {
      await fs.rm(path.join(releasesRoot, entry.name), {
        recursive: true,
        force: true,
      });
    }
  }
  await fs.rm(path.join(updaterDir(), "staging"), {
    recursive: true,
    force: true,
  });
}

/**
 * 后端所有服务启动成功后确认新版本。若容器入口没有执行已切换的运行包，
 * 则恢复上一指针并把任务标记为失败，避免把一次无效重启显示成更新成功。
 */
export async function confirmPendingSelfUpdate(
  currentVersion: string,
): Promise<void> {
  const markerPath = path.join(updaterDir(), "pending.json");
  let markerValue: unknown;
  try {
    markerValue = await readJson<unknown>(markerPath);
  } catch {
    await recoverInvalidPendingMarker(markerPath);
    return;
  }
  const marker = isValidUpdateMarker(markerValue) ? markerValue : null;
  if (markerValue !== null && !marker) {
    await recoverInvalidPendingMarker(markerPath);
    return;
  }
  if (!marker) {
    await withStateLock(async () => {
      const state = await loadState();
      const active = state.activeJobId
        ? state.jobs.find((job) => job.id === state.activeJobId)
        : null;
      if (
        active &&
        active.runnerBootId &&
        active.runnerBootId !== BOOT_ID &&
        !["completed", "failed", "rolled_back"].includes(active.state)
      ) {
        Object.assign(active, {
          state: "failed",
          phase: "failed",
          progress: 100,
          completedAt: nowIso(),
          updatedAt: nowIso(),
          failureCode: "UPDATE_INTERRUPTED",
          message: "更新任务在切换运行目录前被进程重启中断",
        });
        state.activeJobId = null;
        await saveState(state);
      }
    });
    return;
  }
  if (currentVersion === marker.targetVersion) {
    await verifyRuntimeHealth();
    // 状态文件损坏时从已验证的待确认标记重建任务，核心服务仍可启动。
    await withStateLock(async () => {
      const state = await loadState();
      if (!state.jobs.some((candidate) => candidate.id === marker.jobId)) {
        state.jobs.push(recoveredJobFromMarker(marker));
        state.activeJobId = marker.jobId;
        state.idempotency[`recovered:${marker.jobId}`] = marker.jobId;
        await saveState(state);
      }
    });
    // 先移除 attempted：此后若进程中断，下次启动会再次尝试当前运行包，
    // 而不是把已经通过健康检查的运行包误判成启动失败。
    await fs.rm(path.join(updaterDir(), "boot-attempted"), { force: true });
    await withStateLock(async () => {
      const state = await loadState();
      const job = state.jobs.find((candidate) => candidate.id === marker.jobId);
      if (!job)
        throw new UpdaterClientError(
          "更新任务不存在",
          "UPDATE_JOB_NOT_FOUND",
          404,
        );
      Object.assign(job, {
        state: marker.action === "rollback" ? "rolled_back" : "completed",
        phase: marker.action === "rollback" ? "rolled_back" : "completed",
        progress: 100,
        completedAt: nowIso(),
        updatedAt: nowIso(),
        failureCode: null,
        message: `${currentVersion} 已启动并确认`,
      });
      if (state.activeJobId === marker.jobId) state.activeJobId = null;
      await saveState(state);
    });
    await writeJson(path.join(updaterDir(), "confirmed.json"), {
      ...marker,
      confirmedAt: nowIso(),
      runningVersion: currentVersion,
    });
    await fs.rm(markerPath, { force: true });
    await cleanupObsoleteRuntimeFiles().catch((error) =>
      databaseLogger.warn("Failed to clean obsolete self-update runtimes", {
        operation: "cloudssh_self_update_cleanup_failed",
        reason: error instanceof Error ? error.message : "unknown",
      }),
    );
    return;
  }

  await writePointer("app-current", marker.previousPointer);
  if (
    marker.priorPreviousPointer &&
    POINTER_PATTERN.test(marker.priorPreviousPointer)
  ) {
    await writePointer("app-previous", marker.priorPreviousPointer);
  }
  await fs.rm(markerPath, { force: true });
  await withStateLock(async () => {
    const state = await loadState();
    let job = state.jobs.find((candidate) => candidate.id === marker.jobId);
    if (!job) {
      job = recoveredJobFromMarker(marker);
      state.jobs.push(job);
      state.idempotency[`recovered:${marker.jobId}`] = marker.jobId;
    }
    Object.assign(job, {
      state: "failed",
      phase: "failed",
      progress: 100,
      completedAt: nowIso(),
      updatedAt: nowIso(),
      failureCode: "UPDATE_RUNTIME_NOT_STARTED",
      message: `容器重启后仍运行 ${currentVersion}，已恢复上一运行目录指针`,
    });
    if (state.activeJobId === marker.jobId) state.activeJobId = null;
    await saveState(state);
  });
}
