#!/usr/bin/env node
import {
  createHash,
  createHmac,
  createPublicKey,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SERVICE = "site.termix.cloudssh";
const DEFAULT_KEY_ID = "default-agent-device-key";
const MACOS_KEYCHAIN_PKCS8_DER_PREFIX = "pkcs8-der:";
const MACOS_KEYCHAIN_MAX_INTERACTIVE_SECRET_LENGTH = 128;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_JOB_STATES = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELED",
  "TIMED_OUT",
]);
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 502, 503, 504]);
const NETWORK_RETRY_DELAYS_MS = [100, 300];
const DEFAULT_PENDING_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_PENDING_REQUEST_MAX_ENTRIES = 256;
const FILE_TRANSFER_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_AGENT_TRANSFER_BYTES = 64 * 1024 * 1024;
const MAX_RESPONSE_CHUNK_BYTES = 64 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;

export function configDirectory(environment = process.env) {
  if (environment.CLOUDSSH_CONFIG_DIR) {
    return path.resolve(environment.CLOUDSSH_CONFIG_DIR);
  }
  if (process.platform === "win32") {
    return path.join(environment.LOCALAPPDATA ?? os.homedir(), "CloudSSH");
  }
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "CloudSSH",
    );
  }
  return path.join(
    environment.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
    "cloudssh",
  );
}

export function normalizeBaseUrl(input) {
  const parsed = new URL(String(input).trim());
  const local = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    throw new Error("平台地址必须使用 HTTPS；仅本机地址允许 HTTP");
  }
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  const cleanPath = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = cleanPath.endsWith("/agent/v1")
    ? cleanPath
    : `${cleanPath}/agent/v1`.replace(/\/+/g, "/");
  return parsed.toString().replace(/\/$/, "");
}

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
}

async function syncDirectory(directory) {
  const handle = await open(directory, "r").catch(() => null);
  if (!handle) return false;
  try {
    await handle.sync();
    return true;
  } catch {
    return false;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function unlinkDurably(file) {
  try {
    await unlink(file);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  return syncDirectory(path.dirname(file));
}

async function writePrivateFile(file, value) {
  await ensurePrivateDirectory(path.dirname(file));
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  let writeError = null;
  try {
    await handle.writeFile(value, { encoding: "utf8" });
    await handle.sync();
  } catch (error) {
    writeError = error;
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (writeError) {
    await unlink(temporary).catch(() => undefined);
    throw writeError;
  }
  try {
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function writePrivateJson(file, value) {
  await writePrivateFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function normalizeKeyId(keyId = DEFAULT_KEY_ID) {
  if (keyId === DEFAULT_KEY_ID) return DEFAULT_KEY_ID;
  if (typeof keyId !== "string" || !UUID_PATTERN.test(keyId)) {
    throw new Error("设备密钥槽 ID 无效");
  }
  return keyId.toLowerCase();
}

function normalizeKeyIds(keyIds) {
  if (!Array.isArray(keyIds)) return [];
  return [...new Set(keyIds.map((keyId) => normalizeKeyId(keyId)))];
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function readLockOwner(file) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (
      value?.version !== 1 ||
      typeof value.owner !== "string" ||
      !Number.isSafeInteger(value.pid)
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

async function reclaimAbandonedLock(lockFile, observedOwner) {
  const quarantine = `${lockFile}.stale.${randomUUID()}`;
  try {
    await rename(lockFile, quarantine);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    return false;
  }
  const movedOwner = await readLockOwner(quarantine);
  if (observedOwner?.owner && movedOwner?.owner !== observedOwner.owner) {
    await rename(quarantine, lockFile).catch(() => undefined);
    return false;
  }
  await unlink(quarantine).catch(() => undefined);
  return true;
}

export async function withFileLock(file, operation, options = {}) {
  const lockFile = `${file}.lock`;
  await ensurePrivateDirectory(path.dirname(lockFile));
  const deadline = Date.now() + (options.timeoutMs ?? 5_000);
  const staleMs = options.staleMs ?? 120_000;
  const heartbeatMs = options.heartbeatMs ?? 10_000;
  const owner = {
    version: 1,
    owner: randomUUID(),
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
  let handle;
  while (!handle) {
    try {
      handle = await open(lockFile, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => undefined);
        handle = undefined;
        await unlink(lockFile).catch(() => undefined);
      }
      if (error?.code !== "EEXIST") throw error;
      const [lockOwner, lockAge] = await Promise.all([
        readLockOwner(lockFile),
        stat(lockFile)
          .then((value) => Date.now() - value.mtimeMs)
          .catch(() => 0),
      ]);
      const ownerExited = lockOwner ? !processIsAlive(lockOwner.pid) : false;
      const reclaimable = ownerExited ? lockAge > 1_000 : lockAge > staleMs;
      if (reclaimable && (ownerExited || !lockOwner)) {
        await reclaimAbandonedLock(lockFile, lockOwner);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("CloudSSH 会话状态正被其他进程占用，请稍后重试");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  const heartbeat = setInterval(() => {
    const now = new Date();
    void handle.utimes(now, now).catch(() => undefined);
  }, heartbeatMs);
  heartbeat.unref();
  try {
    return await operation();
  } finally {
    clearInterval(heartbeat);
    await handle.close().catch(() => undefined);
    const currentOwner = await readLockOwner(lockFile);
    if (currentOwner?.owner === owner.owner) {
      await unlinkDurably(lockFile).catch(() => undefined);
    }
  }
}

export class ProfileStore {
  constructor(directory = configDirectory()) {
    this.file = path.join(directory, "profile.json");
  }

  async read() {
    const value = await readJson(this.file, null);
    if (!value) return null;
    if (typeof value.baseUrl !== "string") {
      throw new Error("CloudSSH 配置文件格式无效");
    }
    return {
      baseUrl: normalizeBaseUrl(value.baseUrl),
      deviceId: typeof value.deviceId === "string" ? value.deviceId : null,
      publicKey: typeof value.publicKey === "string" ? value.publicKey : null,
      fingerprint:
        typeof value.fingerprint === "string" ? value.fingerprint : null,
      keyId: normalizeKeyId(value.keyId),
      retiredKeyIds: normalizeKeyIds(value.retiredKeyIds),
    };
  }

  async write(profile) {
    await writePrivateJson(this.file, {
      baseUrl: normalizeBaseUrl(profile.baseUrl),
      deviceId: profile.deviceId,
      publicKey: profile.publicKey,
      fingerprint: profile.fingerprint,
      keyId: normalizeKeyId(profile.keyId),
      retiredKeyIds: normalizeKeyIds(profile.retiredKeyIds).filter(
        (keyId) => keyId !== normalizeKeyId(profile.keyId),
      ),
    });
  }

  async delete() {
    return unlinkDurably(this.file);
  }
}

export class DeviceKeyCleanupStore {
  constructor(directory = configDirectory()) {
    this.file = path.join(directory, "device-key-cleanup.json");
  }

  async read() {
    const value = await readJson(this.file, { version: 1, keyIds: [] });
    if (value?.version !== 1) throw new Error("设备密钥清理记录格式无效");
    return normalizeKeyIds(value.keyIds);
  }

  async write(keyIds) {
    const normalized = normalizeKeyIds(keyIds);
    if (normalized.length === 0) {
      await unlinkDurably(this.file);
      return;
    }
    await writePrivateJson(this.file, { version: 1, keyIds: normalized });
  }
}

export class SessionStateStore {
  constructor(directory = configDirectory()) {
    this.file = path.join(directory, "skill-session-state.json");
  }

  async read() {
    const value = await readJson(this.file, { version: 1, sessions: {} });
    if (value?.version !== 1 || typeof value.sessions !== "object") {
      throw new Error("CloudSSH 会话状态文件格式无效");
    }
    return value;
  }

  async update(sessionId, patch) {
    await withFileLock(this.file, async () => {
      const state = await this.read();
      state.sessions[sessionId] = {
        ...(state.sessions[sessionId] ?? {}),
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      await writePrivateJson(this.file, state);
    });
  }

  async remove(sessionId) {
    await withFileLock(this.file, async () => {
      const state = await this.read();
      delete state.sessions[sessionId];
      await writePrivateJson(this.file, state);
    });
  }

  async clear() {
    await withFileLock(this.file, async () => {
      await unlinkDurably(this.file);
    });
  }
}

function pendingRequestStoreError(code, message) {
  return Object.assign(new Error(message), { code });
}

function assertPendingRequestState(value) {
  if (
    (value?.version !== 1 && value?.version !== 2) ||
    !value.requests ||
    typeof value.requests !== "object" ||
    Array.isArray(value.requests)
  ) {
    throw new Error("CloudSSH 待确认请求日志格式无效");
  }
  for (const [fingerprint, record] of Object.entries(value.requests)) {
    if (
      !/^[a-f0-9]{64}$/.test(fingerprint) ||
      !record ||
      typeof record !== "object" ||
      !UUID_PATTERN.test(record.requestId) ||
      !UUID_PATTERN.test(record.idempotencyKey) ||
      typeof record.deviceId !== "string" ||
      record.deviceId.length < 1 ||
      record.deviceId.length > 128 ||
      typeof record.method !== "string" ||
      !/^[A-Z]{3,10}$/.test(record.method) ||
      typeof record.resource !== "string" ||
      record.resource.length < 1 ||
      record.resource.length > 1024 ||
      (value.version === 1 &&
        (typeof record.requestHash !== "string" ||
          !/^[a-f0-9]{64}$/.test(record.requestHash))) ||
      (value.version === 2 &&
        (typeof record.requestProof !== "string" ||
          !/^[a-f0-9]{64}$/.test(record.requestProof))) ||
      !Number.isFinite(Date.parse(record.createdAt)) ||
      !Number.isFinite(Date.parse(record.expiresAt))
    ) {
      throw new Error("CloudSSH 待确认请求记录格式无效");
    }
  }
  return value;
}

export class PendingRequestStore {
  constructor(directory = configDirectory(), options = {}) {
    this.file = path.join(directory, "pending-requests.json");
    this.ttlMs = options.ttlMs ?? DEFAULT_PENDING_REQUEST_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_PENDING_REQUEST_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0) {
      throw new Error("待确认请求保留时间无效");
    }
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries <= 0) {
      throw new Error("待确认请求数量上限无效");
    }
  }

  async reserve(input) {
    if (
      !/^[a-f0-9]{64}$/.test(input.fingerprint ?? "") ||
      !/^[a-f0-9]{64}$/.test(input.requestProof ?? "")
    ) {
      throw new Error("CloudSSH 待确认请求校验值无效");
    }
    const proofKey = normalizePendingProofKey(input.proofKey);
    return withFileLock(this.file, async () => {
      let state = await this.load();
      const now = this.now();
      let changed = this.prune(state, now, input.deviceId) > 0;
      if (state.version === 1) {
        state = migratePendingRequestState(state, proofKey);
        changed = true;
      }
      const existing = state.requests[input.fingerprint];
      if (existing) {
        if (
          existing.deviceId !== input.deviceId ||
          existing.method !== input.method ||
          existing.resource !== input.resource ||
          existing.requestProof !== input.requestProof
        ) {
          throw new Error("CloudSSH 待确认请求指纹冲突");
        }
        if (changed) await this.save(state);
        return structuredClone(existing);
      }

      if (Object.keys(state.requests).length >= this.maxEntries) {
        if (changed) await this.save(state);
        throw pendingRequestStoreError(
          "PENDING_REQUEST_LIMIT_REACHED",
          "待确认请求数量已达到上限，请先重试或检查已有操作结果",
        );
      }

      const createdAt = new Date(now).toISOString();
      const record = {
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        deviceId: input.deviceId,
        method: input.method,
        resource: input.resource,
        requestProof: input.requestProof,
        createdAt,
        expiresAt: new Date(now + this.ttlMs).toISOString(),
      };
      state.requests[input.fingerprint] = record;
      await this.save(state);
      return structuredClone(record);
    });
  }

  async release(fingerprint, requestId) {
    return withFileLock(this.file, async () => {
      const state = await this.load();
      this.prune(state, this.now());
      const existing = state.requests[fingerprint];
      if (existing?.requestId === requestId) {
        delete state.requests[fingerprint];
      }
      await this.save(state);
    });
  }

  async cleanupExpired() {
    return withFileLock(this.file, async () => {
      const state = await this.load();
      const removed = this.prune(state, this.now());
      if (removed > 0) await this.save(state);
      return removed;
    });
  }

  async read() {
    return withFileLock(this.file, async () => {
      const state = await this.load();
      if (this.prune(state, this.now()) > 0) await this.save(state);
      return structuredClone(state);
    });
  }

  async clear() {
    await withFileLock(this.file, async () => {
      await unlinkDurably(this.file);
    });
  }

  async load() {
    return assertPendingRequestState(
      await readJson(this.file, { version: 2, requests: {} }),
    );
  }

  async save(state) {
    if (Object.keys(state.requests).length === 0) {
      await unlinkDurably(this.file);
      return;
    }
    await writePrivateJson(this.file, state);
  }

  prune(state, now, activeDeviceId) {
    let removed = 0;
    for (const [fingerprint, record] of Object.entries(state.requests)) {
      if (
        Date.parse(record.expiresAt) <= now ||
        (activeDeviceId && record.deviceId !== activeDeviceId)
      ) {
        delete state.requests[fingerprint];
        removed += 1;
      }
    }
    return removed;
  }
}

function normalizePendingProofKey(value) {
  const key = Buffer.isBuffer(value)
    ? value
    : typeof value === "string"
      ? Buffer.from(value, "base64url")
      : null;
  if (!key || key.length !== 32) {
    throw new Error("CloudSSH 待确认请求保护密钥无效");
  }
  return key;
}

function pendingRequestMac(proofKey, purpose, value) {
  return createHmac("sha256", normalizePendingProofKey(proofKey))
    .update(`cloudssh-pending-request-v2\0${purpose}\0`, "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function migratePendingRequestState(state, proofKey) {
  const requests = {};
  for (const [legacyFingerprint, record] of Object.entries(state.requests)) {
    const fingerprint = pendingRequestMac(
      proofKey,
      "fingerprint",
      legacyFingerprint,
    );
    if (requests[fingerprint]) {
      throw new Error("CloudSSH 待确认请求迁移冲突");
    }
    const { requestHash, ...rest } = record;
    requests[fingerprint] = {
      ...rest,
      requestProof: pendingRequestMac(proofKey, "body", requestHash),
    };
  }
  return { version: 2, requests };
}

function run(command, args, stdin = "", options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      detached: options.detached === true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    child.stdin.end(stdin);
  });
}

function encodedPowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}
function encodeMacOsKeychainSecret(secret) {
  let key;
  try {
    key = createPrivateKey(secret);
  } catch {
    throw new Error("设备私钥格式无效");
  }
  const der = key.export({ type: "pkcs8", format: "der" });
  const stored = `${MACOS_KEYCHAIN_PKCS8_DER_PREFIX}${Buffer.from(der).toString("base64")}`;
  if (stored.length > MACOS_KEYCHAIN_MAX_INTERACTIVE_SECRET_LENGTH) {
    throw new Error("macOS 钥匙串设备私钥编码超过安全写入长度");
  }
  return {
    stored,
    pem: key.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function decodeMacOsKeychainSecret(value) {
  const secret = value.replace(/[\r\n]+$/, "");
  if (!secret.startsWith(MACOS_KEYCHAIN_PKCS8_DER_PREFIX)) return secret;

  const payload = secret.slice(MACOS_KEYCHAIN_PKCS8_DER_PREFIX.length);
  const validBase64 =
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      payload,
    );
  if (!validBase64) {
    throw new Error("macOS 钥匙串中的设备私钥编码无效");
  }

  try {
    return createPrivateKey({
      key: Buffer.from(payload, "base64"),
      type: "pkcs8",
      format: "der",
    })
      .export({ type: "pkcs8", format: "pem" })
      .toString();
  } catch {
    throw new Error("macOS 钥匙串中的设备私钥编码无效");
  }
}

const PROTECT_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Security",
  "$plain=[Console]::In.ReadToEnd()",
  "$bytes=[Text.Encoding]::UTF8.GetBytes($plain)",
  "$cipher=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Convert]::ToBase64String($cipher))",
].join(";");

const UNPROTECT_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Security",
  "$cipher=[Convert]::FromBase64String([Console]::In.ReadToEnd())",
  "$bytes=[Security.Cryptography.ProtectedData]::Unprotect($cipher,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))",
].join(";");

export class WindowsDpapiSecretStore {
  constructor(directory = configDirectory()) {
    this.directory = directory;
    this.file = path.join(directory, "agent-device-key.dpapi");
  }

  fileFor(keyId) {
    const normalized = normalizeKeyId(keyId);
    return normalized === DEFAULT_KEY_ID
      ? this.file
      : path.join(this.directory, `agent-device-key.${normalized}.dpapi`);
  }

  async get(keyId = DEFAULT_KEY_ID) {
    const file = this.fileFor(keyId);
    let cipher;
    try {
      cipher = await readFile(file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    const result = await run(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encodedPowerShell(UNPROTECT_SCRIPT),
      ],
      cipher,
    );
    if (result.code !== 0) {
      throw new Error("无法使用当前 Windows 用户解密设备私钥");
    }
    return result.stdout;
  }

  async set(secret, keyId = DEFAULT_KEY_ID) {
    if (!secret.trim()) throw new Error("设备私钥不能为空");
    const file = this.fileFor(keyId);
    const result = await run(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encodedPowerShell(PROTECT_SCRIPT),
      ],
      secret,
    );
    if (result.code !== 0 || !result.stdout) {
      throw new Error("无法使用 Windows DPAPI 加密设备私钥");
    }
    await writePrivateFile(file, result.stdout);
  }

  async delete(keyId = DEFAULT_KEY_ID) {
    await unlinkDurably(this.fileFor(keyId));
  }
}

export class MacOsKeychainSecretStore {
  constructor(execute = run) {
    this.execute = execute;
  }

  async get(keyId = DEFAULT_KEY_ID) {
    const account = normalizeKeyId(keyId);
    const result = await this.execute("security", [
      "find-generic-password",
      "-a",
      account,
      "-s",
      SERVICE,
      "-w",
    ]);
    if (result.code === 44) return null;
    if (result.code !== 0) throw new Error("无法读取 macOS 钥匙串中的设备私钥");
    return decodeMacOsKeychainSecret(result.stdout);
  }

  async set(secret, keyId = DEFAULT_KEY_ID) {
    if (!secret.trim()) throw new Error("设备私钥不能为空");
    const account = normalizeKeyId(keyId);
    const encoded = encodeMacOsKeychainSecret(secret);
    const result = await this.execute(
      "security",
      ["add-generic-password", "-U", "-a", account, "-s", SERVICE, "-w"],
      `${encoded.stored}\n${encoded.stored}\n`,
      { detached: true },
    );
    if (result.code !== 0) throw new Error("无法写入 macOS 钥匙串");

    let recovered;
    try {
      recovered = await this.get(keyId);
    } catch (error) {
      await this.delete(keyId).catch(() => undefined);
      throw new Error(
        `macOS 钥匙串写入后校验失败：${error?.message ?? "无法回读设备私钥"}`,
      );
    }
    if (recovered !== encoded.pem) {
      await this.delete(keyId).catch(() => undefined);
      throw new Error("macOS 钥匙串写入后校验失败：回读内容与设备私钥不一致");
    }
  }

  async delete(keyId = DEFAULT_KEY_ID) {
    const account = normalizeKeyId(keyId);
    const result = await this.execute("security", [
      "delete-generic-password",
      "-a",
      account,
      "-s",
      SERVICE,
    ]);
    if (result.code !== 0 && result.code !== 44) {
      throw new Error("无法删除 macOS 钥匙串凭据");
    }
  }
}

export class LinuxSecretServiceStore {
  constructor(execute = run) {
    this.execute = execute;
  }

  async get(keyId = DEFAULT_KEY_ID) {
    const account = normalizeKeyId(keyId);
    const result = await this.execute("secret-tool", [
      "lookup",
      "service",
      SERVICE,
      "account",
      account,
    ]);
    if (result.code !== 0 || !result.stdout) return null;
    return result.stdout.replace(/[\r\n]+$/, "");
  }

  async set(secret, keyId = DEFAULT_KEY_ID) {
    if (!secret.trim()) throw new Error("设备私钥不能为空");
    const account = normalizeKeyId(keyId);
    const result = await this.execute(
      "secret-tool",
      [
        "store",
        "--label=CloudSSH Agent Device Key",
        "service",
        SERVICE,
        "account",
        account,
      ],
      secret,
    );
    if (result.code !== 0) {
      throw new Error(
        "无法写入 Secret Service；请确认 secret-tool 可用且钥匙串已解锁",
      );
    }
  }

  async delete(keyId = DEFAULT_KEY_ID) {
    const account = normalizeKeyId(keyId);
    const result = await this.execute("secret-tool", [
      "clear",
      "service",
      SERVICE,
      "account",
      account,
    ]);
    if (result.code !== 0) throw new Error("无法删除 Secret Service 凭据");
  }
}

export function createPlatformSecretStore(directory = configDirectory()) {
  if (process.platform === "win32")
    return new WindowsDpapiSecretStore(directory);
  if (process.platform === "darwin") return new MacOsKeychainSecretStore();
  return new LinuxSecretServiceStore();
}

async function deleteDeviceKeySlots(secrets, keyIds) {
  const failed = [];
  for (const keyId of normalizeKeyIds(keyIds)) {
    try {
      await secrets.delete(keyId);
    } catch {
      failed.push(keyId);
    }
  }
  return failed;
}

async function cleanupQueuedDeviceKeys(cleanups, secrets, activeKeyId) {
  const pending = (await cleanups.read()).filter(
    (keyId) => keyId !== activeKeyId,
  );
  const failed = await deleteDeviceKeySlots(secrets, pending);
  await cleanups.write(failed);
  return failed;
}

async function cleanupProfileDeviceKeys(profiles, secrets, profile) {
  const retired = normalizeKeyIds(profile.retiredKeyIds).filter(
    (keyId) => keyId !== profile.keyId,
  );
  if (retired.length === 0) return profile;
  const failed = await deleteDeviceKeySlots(secrets, retired);
  const updated = { ...profile, retiredKeyIds: failed };
  try {
    await profiles.write(updated);
    return updated;
  } catch {
    // 原 Profile 仍保留完整清理列表，下次命令会继续重试。
    return profile;
  }
}

export async function loadDeviceProfile(
  profiles,
  secrets,
  cleanups = new DeviceKeyCleanupStore(path.dirname(profiles.file)),
) {
  return withFileLock(profiles.file, async () => {
    let profile = await profiles.read();
    await cleanupQueuedDeviceKeys(cleanups, secrets, profile?.keyId ?? null);
    if (profile)
      profile = await cleanupProfileDeviceKeys(profiles, secrets, profile);
    return profile;
  });
}

export async function commitDeviceIdentity(
  profiles,
  secrets,
  cleanups,
  nextProfile,
  privateKey,
) {
  return withFileLock(profiles.file, async () => {
    let previous = await profiles.read();
    await cleanupQueuedDeviceKeys(cleanups, secrets, previous?.keyId ?? null);
    if (previous) {
      previous = await cleanupProfileDeviceKeys(profiles, secrets, previous);
    }
    const keyId = normalizeKeyId(nextProfile.keyId);
    const retiredKeyIds = normalizeKeyIds([
      ...(previous?.retiredKeyIds ?? []),
      ...(previous?.keyId && previous.keyId !== keyId ? [previous.keyId] : []),
    ]).filter((candidate) => candidate !== keyId);
    const committed = { ...nextProfile, keyId, retiredKeyIds };
    const queued = normalizeKeyIds([...(await cleanups.read()), keyId]);
    await cleanups.write(queued);
    let keyWriteStarted = false;
    let profileCommitted = false;
    try {
      keyWriteStarted = true;
      await secrets.set(privateKey, keyId);
      await profiles.write(committed);
      profileCommitted = true;
    } catch (error) {
      if (keyWriteStarted && !profileCommitted) {
        try {
          await secrets.delete(keyId);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            `${error?.message ?? "设备登录失败"}；临时设备私钥已加入待清理队列`,
          );
        }
      }
      throw error;
    }
    // 新密钥先保留在清理日志中，旧密钥也暂不删除。下一次进程启动读取
    // 已落盘的 Profile 后再决定清理哪一侧，避免断电后 Profile 回退却丢失旧密钥。
    return committed;
  });
}

export async function removeDeviceIdentity(
  profiles,
  secrets,
  cleanups = new DeviceKeyCleanupStore(path.dirname(profiles.file)),
) {
  return withFileLock(profiles.file, async () => {
    const profile = await profiles.read();
    const keyIds = normalizeKeyIds([
      ...(await cleanups.read()),
      ...(profile ? [profile.keyId, ...profile.retiredKeyIds] : []),
    ]);
    await cleanups.write(keyIds);
    const profileRemovalDurable = await profiles.delete();
    if (!profileRemovalDurable) return keyIds;
    const failed = await deleteDeviceKeySlots(secrets, keyIds);
    await cleanups.write(failed);
    return failed;
  });
}

export class CloudSshApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "CloudSshApiError";
    this.status = status;
    this.code = code;
  }
}

function projectServerSummary(value) {
  if (!value || typeof value !== "object") return null;
  const source = value;
  if (
    typeof source.serverId !== "string" ||
    typeof source.name !== "string" ||
    typeof source.connectionType !== "string"
  ) {
    return null;
  }
  const result = {
    serverId: source.serverId,
    name: source.name,
    connectionType: source.connectionType,
  };
  // hostId 是跨项目稳定的底层主机资产 ID；serverId 只是项目级访问入口。
  // 同一主机分享至多个项目时必须保留 hostId，避免 Agent 将多个入口误判为
  // 多台独立服务器。兼容尚未返回该字段的旧版服务端，因此仅在合法时输出。
  if (Number.isSafeInteger(source.hostId) && source.hostId > 0) {
    result.hostId = source.hostId;
  }
  for (const key of ["projectId", "projectName", "address"]) {
    if (typeof source[key] === "string") result[key] = source[key];
  }
  if (Number.isSafeInteger(source.port) && source.port >= 1) {
    result.port = source.port;
  }
  if (source.folder === null || typeof source.folder === "string") {
    result.folder = source.folder;
  }
  if (Array.isArray(source.tags)) {
    result.tags = source.tags.filter((tag) => typeof tag === "string");
  }
  return result;
}

function projectFileMutation(value) {
  if (!value || typeof value !== "object") return {};
  const result = {};
  for (const key of ["serverId", "path", "sourcePath", "destinationPath"]) {
    if (typeof value[key] === "string") result[key] = value[key];
  }
  if (Number.isSafeInteger(value.size) && value.size >= 0) {
    result.size = value.size;
  }
  return result;
}

export async function readLimitedResponseBuffer(
  response,
  maximumBytes,
  tooLargeMessage = "下载文件超过 64 MiB 限制",
  tooLargeCode = "FILE_TOO_LARGE",
) {
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null && /^\d+$/.test(rawLength.trim())) {
    const declaredLength = Number(rawLength);
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength > maximumBytes
    ) {
      throw new CloudSshApiError(tooLargeMessage, 413, tooLargeCode);
    }
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new CloudSshApiError(
          "平台返回了无效的文件数据",
          502,
          "INVALID_RESPONSE",
        );
      }
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new CloudSshApiError(tooLargeMessage, 413, tooLargeCode);
      }
      for (let offset = 0; offset < value.byteLength; ) {
        const end = Math.min(
          offset + MAX_RESPONSE_CHUNK_BYTES,
          value.byteLength,
        );
        chunks.push(Buffer.from(value.subarray(offset, end)));
        offset = end;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export class CloudSshClient {
  constructor(
    baseUrl,
    identities,
    fetcher = fetch,
    pendingRequests = new PendingRequestStore(),
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.identities = identities;
    this.fetcher = fetcher;
    this.pendingRequests = pendingRequests;
  }

  async listServers() {
    const servers = (await this.request("/servers")).servers;
    return Array.isArray(servers)
      ? servers.map(projectServerSummary).filter(Boolean)
      : [];
  }

  async listFiles(serverId, remotePath = ".") {
    return this.request("/files/list", {
      query: { serverId, path: remotePath },
    });
  }

  async readRemoteFile(serverId, remotePath) {
    return this.request("/files/read", {
      query: { serverId, path: remotePath },
    });
  }

  async uploadFile(serverId, remotePath, data) {
    const result = await this.request("/files/upload", {
      method: "POST",
      query: { serverId, path: remotePath },
      body: data,
      contentType: "application/octet-stream",
      binaryBody: true,
      idempotent: true,
      timeoutMs: FILE_TRANSFER_TIMEOUT_MS,
    });
    return projectFileMutation(result.file ?? result);
  }

  async downloadFile(serverId, remotePath) {
    return this.request("/files/download", {
      query: { serverId, path: remotePath },
      rawResponse: true,
      timeoutMs: FILE_TRANSFER_TIMEOUT_MS,
    });
  }

  async makeDirectory(serverId, remotePath, recursive = false) {
    const result = await this.request("/files/mkdir", {
      method: "POST",
      body: { serverId, path: remotePath, recursive },
      idempotent: true,
    });
    return projectFileMutation(result.directory ?? result);
  }

  async renameFile(serverId, sourcePath, destinationPath) {
    const result = await this.request("/files/rename", {
      method: "POST",
      body: { serverId, sourcePath, destinationPath },
      idempotent: true,
    });
    return projectFileMutation(result.file ?? result);
  }

  async deleteFile(serverId, remotePath, recursive = false) {
    const result = await this.request("/files/delete", {
      method: "POST",
      body: { serverId, path: remotePath, recursive },
      idempotent: true,
    });
    return projectFileMutation(result.file ?? result);
  }

  async listProjects() {
    return (await this.request("/projects")).projects ?? [];
  }

  async listProjectFolders(projectId) {
    return (
      (await this.request(`/projects/${segment(projectId)}/folders`)).folders ??
      []
    );
  }

  async listProjectCredentials(projectId) {
    return (
      (await this.request(`/projects/${segment(projectId)}/credentials`))
        .credentials ?? []
    );
  }

  async createServer(input) {
    return (
      await this.request("/servers", {
        method: "POST",
        body: input,
        idempotent: true,
      })
    ).server;
  }

  async createQuickConnection(input) {
    return (
      await this.request("/quick-connections", {
        method: "POST",
        body: input,
        idempotent: true,
      })
    ).connection;
  }

  async createSession(input) {
    return (
      await this.request("/sessions", {
        method: "POST",
        body: input,
        idempotent: true,
      })
    ).session;
  }

  async listSessions() {
    return (await this.request("/sessions")).sessions ?? [];
  }

  async sessionStatus(sessionId) {
    return (await this.request(`/sessions/${segment(sessionId)}/status`))
      .session;
  }

  async attachSession(sessionId, mode = "read-only", takeover = false) {
    return this.request(`/sessions/${segment(sessionId)}/attach`, {
      method: "POST",
      body: { mode, takeover },
      idempotent: true,
    });
  }

  async readSession(sessionId, cursor, limitBytes, attachmentId) {
    return this.request(`/sessions/${segment(sessionId)}/read`, {
      query: { cursor, limitBytes, attachmentId },
    });
  }

  async writeSession(sessionId, attachmentId, leaseId, data) {
    return this.request(`/sessions/${segment(sessionId)}/write`, {
      method: "POST",
      body: { attachmentId, leaseId, data },
      idempotent: true,
    });
  }

  async resizeSession(sessionId, attachmentId, leaseId, cols, rows) {
    return (
      await this.request(`/sessions/${segment(sessionId)}/resize`, {
        method: "POST",
        body: { attachmentId, leaseId, cols, rows },
      })
    ).session;
  }

  async detachSession(sessionId, attachmentId) {
    return this.request(`/sessions/${segment(sessionId)}/detach`, {
      method: "POST",
      body: { attachmentId },
    });
  }

  async closeSession(sessionId) {
    return (
      await this.request(`/sessions/${segment(sessionId)}/close`, {
        method: "POST",
      })
    ).session;
  }

  async createJob(input) {
    return (
      await this.request("/jobs", {
        method: "POST",
        body: input,
        idempotent: true,
      })
    ).job;
  }

  async listJobs() {
    return (await this.request("/jobs")).jobs ?? [];
  }

  async jobStatus(jobId) {
    return (await this.request(`/jobs/${segment(jobId)}`)).job;
  }

  async cancelJob(jobId) {
    return (
      await this.request(`/jobs/${segment(jobId)}/cancel`, { method: "POST" })
    ).job;
  }

  async request(resource, options = {}) {
    const identity = await this.identities.get();
    if (!identity?.deviceId || !identity?.privateKey) {
      throw new CloudSshApiError(
        "尚未登录 CloudSSH，请先执行 auth login",
        401,
        "NOT_AUTHENTICATED",
      );
    }
    const url = new URL(`${this.baseUrl.replace(/\/$/, "")}${resource}`);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    const method = options.method ?? "GET";
    const binaryBody = options.binaryBody === true;
    let body;
    if (options.body !== undefined) {
      if (binaryBody) {
        if (
          !Buffer.isBuffer(options.body) &&
          !(options.body instanceof Uint8Array)
        ) {
          throw new Error("二进制请求正文无效");
        }
        body = Buffer.isBuffer(options.body)
          ? options.body
          : Buffer.from(options.body);
      } else {
        body = JSON.stringify(options.body);
      }
    }
    const bodyHash = sha256(body ?? "");
    const resourceKey = `${url.pathname}${url.search}`;
    const proofKey = options.idempotent
      ? pendingRequestProofKey(identity.privateKey)
      : null;
    const legacyFingerprint = options.idempotent
      ? legacyPendingRequestFingerprint({
          baseUrl: this.baseUrl,
          deviceId: identity.deviceId,
          method,
          resource: resourceKey,
          requestHash: bodyHash,
        })
      : null;
    const fingerprint = legacyFingerprint
      ? pendingRequestMac(proofKey, "fingerprint", legacyFingerprint)
      : null;
    const requestProof = proofKey
      ? pendingRequestMac(proofKey, "body", bodyHash)
      : null;
    const pending = fingerprint
      ? await this.pendingRequests.reserve({
          fingerprint,
          deviceId: identity.deviceId,
          method,
          resource: resourceKey,
          requestProof,
          proofKey,
        })
      : null;
    const idempotencyKey = pending?.idempotencyKey ?? "";
    const requestId = pending?.requestId ?? randomUUID();
    const retryable =
      method === "GET" || method === "HEAD" || Boolean(idempotencyKey);
    const maximumAttempts = retryable ? NETWORK_RETRY_DELAYS_MS.length + 1 : 1;

    const timeoutMs =
      Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
        ? Math.min(options.timeoutMs, FILE_TRANSFER_TIMEOUT_MS)
        : 30_000;
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      const headers = signedHeaders({
        method,
        url,
        body: body ?? "",
        privateKey: identity.privateKey,
        deviceId: identity.deviceId,
        idempotencyKey,
        requestId,
      });
      headers.accept = options.rawResponse
        ? "application/octet-stream"
        : "application/json";
      if (options.body !== undefined) {
        headers["content-type"] =
          options.contentType ??
          (binaryBody ? "application/octet-stream" : "application/json");
      }

      let response;
      let raw;
      try {
        response = await this.fetcher(url, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (options.rawResponse) {
          raw = await readLimitedResponseBuffer(
            response,
            response.ok ? MAX_AGENT_TRANSFER_BYTES : MAX_ERROR_RESPONSE_BYTES,
            response.ok
              ? "下载文件超过 64 MiB 限制"
              : "平台错误响应超过安全读取上限",
            response.ok ? "FILE_TOO_LARGE" : "INVALID_RESPONSE",
          );
        } else {
          raw = await response.text();
        }
      } catch (error) {
        if (error instanceof CloudSshApiError) throw error;
        if (attempt + 1 < maximumAttempts) {
          await retryDelay(attempt);
          continue;
        }
        throw new CloudSshApiError(
          redact(error?.message ?? String(error)),
          0,
          "NETWORK_ERROR",
        );
      }

      const uncertainStatus = isUncertainHttpStatus(response.status);
      if (uncertainStatus && attempt + 1 < maximumAttempts) {
        await retryDelay(attempt);
        continue;
      }

      if (options.rawResponse) {
        if (response.ok) {
          if (pending) {
            await this.pendingRequests.release(fingerprint, pending.requestId);
          }
          return raw;
        }
        let errorPayload = null;
        try {
          errorPayload = JSON.parse(raw.toString("utf8"));
        } catch {
          errorPayload = null;
        }
        const message =
          typeof errorPayload?.error === "string"
            ? errorPayload.error
            : `平台请求失败（HTTP ${response.status}）`;
        if (
          pending &&
          !uncertainStatus &&
          errorPayload?.code !== "IDEMPOTENCY_OUTCOME_UNKNOWN"
        ) {
          await this.pendingRequests.release(fingerprint, pending.requestId);
        }
        throw new CloudSshApiError(
          redact(message),
          response.status,
          safeErrorCode(errorPayload?.code),
        );
      }

      let payload = null;
      let validJson = false;
      if (raw) {
        try {
          payload = JSON.parse(raw);
          validJson = payload !== null && typeof payload === "object";
        } catch {
          payload = null;
        }
      }
      if (response.ok && !validJson) {
        if (attempt + 1 < maximumAttempts) {
          await retryDelay(attempt);
          continue;
        }
        throw new CloudSshApiError(
          "平台返回内容无法确认操作结果，请使用相同命令重试",
          response.status,
          pending ? "RESPONSE_UNCERTAIN" : "INVALID_RESPONSE",
        );
      }
      if (!response.ok) {
        const message =
          typeof payload?.error === "string"
            ? payload.error
            : `平台请求失败（HTTP ${response.status}）`;
        const error = new CloudSshApiError(
          redact(message),
          response.status,
          safeErrorCode(payload?.code),
        );
        if (
          pending &&
          !uncertainStatus &&
          payload?.code !== "IDEMPOTENCY_OUTCOME_UNKNOWN"
        ) {
          await this.pendingRequests.release(fingerprint, pending.requestId);
        }
        throw error;
      }
      if (pending) {
        await this.pendingRequests.release(fingerprint, pending.requestId);
      }
      return payload;
    }

    throw new CloudSshApiError("平台请求失败", 0, "NETWORK_ERROR");
  }
}

function legacyPendingRequestFingerprint(input) {
  return sha256(
    JSON.stringify({
      version: 1,
      baseUrl: input.baseUrl,
      deviceId: input.deviceId,
      method: input.method,
      resource: input.resource,
      requestHash: input.requestHash,
    }),
  );
}

function pendingRequestProofKey(privateKey) {
  return createHmac("sha256", Buffer.from(privateKey, "utf8"))
    .update("cloudssh-pending-request-proof-key-v2", "utf8")
    .digest();
}

function isUncertainHttpStatus(status) {
  return status >= 500 || RETRYABLE_HTTP_STATUSES.has(status);
}

async function retryDelay(attempt) {
  await new Promise((resolve) =>
    setTimeout(resolve, NETWORK_RETRY_DELAYS_MS[attempt] ?? 0),
  );
}

function safeErrorCode(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)
    ? value
    : "HTTP_ERROR";
}

function redact(value) {
  return String(value).replace(
    /Bearer\s+cssh_[A-Za-z0-9_-]+/gi,
    "Bearer [REDACTED]",
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalRequest({
  method,
  url,
  timestamp,
  nonce,
  bodyHash,
  idempotencyKey,
  requestId,
}) {
  return [
    "cloudssh-device-v2",
    method.toUpperCase(),
    `${url.pathname}${url.search}`,
    timestamp,
    nonce,
    bodyHash,
    idempotencyKey,
    requestId,
  ].join("\n");
}

export function signedHeaders({
  method,
  url,
  body = "",
  privateKey,
  deviceId,
  idempotencyKey = "",
  requestId = randomUUID(),
}) {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)) {
    throw new Error("请求 ID 无效");
  }
  if (idempotencyKey && !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) {
    throw new Error("幂等键无效");
  }
  const timestamp = String(Date.now());
  const nonce = randomBytes(18).toString("base64url");
  const bodyHash = sha256(body);
  const signature = sign(
    null,
    Buffer.from(
      canonicalRequest({
        method,
        url,
        timestamp,
        nonce,
        bodyHash,
        idempotencyKey,
        requestId,
      }),
    ),
    privateKey,
  ).toString("base64url");
  const headers = {
    "x-cloudssh-timestamp": timestamp,
    "x-cloudssh-nonce": nonce,
    "x-cloudssh-body-sha256": bodyHash,
    "x-cloudssh-signature": signature,
    "x-request-id": requestId,
  };
  if (deviceId) headers["x-cloudssh-device-id"] = deviceId;
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  return headers;
}

function segment(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 256) {
    throw new Error("资源 ID 无效");
  }
  return encodeURIComponent(value);
}

function parseArguments(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const name = value.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[name] = true;
    } else {
      flags[name] = next;
      index += 1;
    }
  }
  return { positional, flags };
}

function stringFlag(flags, name, required = true) {
  const value = flags[name];
  if (typeof value === "string" && value.length > 0) return value;
  if (!required) return undefined;
  throw new Error(`缺少 --${name}`);
}

function localPathFlag(flags) {
  const value = stringFlag(flags, "local-path");
  if (value === "-") {
    throw new Error(
      "--local-path 必须是本地文件路径，不支持标准输入或标准输出",
    );
  }
  return value;
}

function integerFlag(flags, name, options = {}) {
  const raw = flags[name];
  if (raw === undefined && options.defaultValue !== undefined)
    return options.defaultValue;
  if (typeof raw !== "string") {
    if (options.required) throw new Error(`缺少 --${name}`);
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < options.min || value > options.max) {
    throw new Error(
      `--${name} 必须是 ${options.min}-${options.max} 之间的整数`,
    );
  }
  return value;
}

function boundedStringFlag(flags, name, options = {}) {
  const value = stringFlag(flags, name, options.required !== false);
  if (value === undefined) return undefined;
  if (value.length > options.maxLength || /[\0\r\n]/.test(value)) {
    throw new Error(`--${name} 无效`);
  }
  const normalized = options.trim === false ? value : value.trim();
  if (!normalized) throw new Error(`--${name} 无效`);
  return normalized;
}

function assertOnlyFlags(flags, allowed) {
  const unknown = Object.keys(flags).filter((name) => !allowed.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `存在未识别参数：${unknown.map((name) => `--${name}`).join("、")}`,
    );
  }
}

async function readSensitiveFile(file, label, options = {}) {
  const resolved = path.resolve(file);
  let handle;
  try {
    handle = await open(resolved, "r");
  } catch {
    throw new Error(`${label}文件无法读取`);
  }
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size === 0 ||
      metadata.size > 512 * 1024
    ) {
      throw new Error(`${label}文件必须是 512 KiB 以内的非空普通文件`);
    }
    let value = await handle.readFile({ encoding: "utf8" });
    if (Buffer.byteLength(value, "utf8") > 512 * 1024) {
      throw new Error(`${label}文件必须是 512 KiB 以内的非空普通文件`);
    }
    if (options.trimFinalLine === true) {
      value = value.replace(/\r?\n$/, "");
    }
    if (!value) throw new Error(`${label}文件不能为空`);
    return value;
  } catch (error) {
    if (error?.message?.startsWith(label)) throw error;
    throw new Error(`${label}文件无法读取`);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * 读取用户明确指定的本地传输文件。内容只在 Skill 进程内存和 HTTPS
 * 请求之间流转，不会打印到标准输出，也不会写入待确认请求状态。
 */
export async function readTransferFile(file) {
  const resolved = path.resolve(file);
  let pathMetadata;
  try {
    pathMetadata = await lstat(resolved);
  } catch {
    throw new Error("本地文件无法读取");
  }
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
    throw new Error("本地文件必须是 64 MiB 以内的普通文件");
  }
  let handle;
  try {
    handle = await open(resolved, "r");
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size > MAX_AGENT_TRANSFER_BYTES ||
      metadata.dev !== pathMetadata.dev ||
      metadata.ino !== pathMetadata.ino
    ) {
      throw new Error("本地文件必须是 64 MiB 以内的普通文件");
    }

    const chunks = [];
    let total = 0;
    while (true) {
      const requested = Math.min(
        MAX_RESPONSE_CHUNK_BYTES,
        MAX_AGENT_TRANSFER_BYTES + 1 - total,
      );
      const chunk = Buffer.allocUnsafe(requested);
      const { bytesRead } = await handle.read(chunk, 0, requested, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_AGENT_TRANSFER_BYTES) {
        throw new Error("本地文件必须是 64 MiB 以内的普通文件");
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return { path: resolved, data: Buffer.concat(chunks, total) };
  } catch (error) {
    if (error?.message?.startsWith("本地文件必须")) throw error;
    throw new Error("本地文件无法读取");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function writeTransferFile(file, data, force = false) {
  const resolved = path.resolve(file);
  const temporary = `${resolved}.${randomUUID()}.cloudssh.tmp`;
  try {
    await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
    if (force) {
      await rename(temporary, resolved);
    } else {
      // 同目录硬链接提供原子“不覆盖”提交语义。即使两个下载同时完成，
      // 也只有一个能创建目标路径，另一个会稳定得到 EEXIST。
      await link(temporary, resolved);
      await unlink(temporary).catch(() => undefined);
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if (error?.code === "EEXIST") {
      throw new Error("本地目标文件已存在；如需覆盖请使用 --force");
    }
    if (error?.code === "ENOENT") {
      throw new Error("本地目标目录不存在");
    }
    throw new Error("下载文件写入本地失败");
  }
  return resolved;
}

function remotePathFlag(flags, required = true) {
  const pathValue = stringFlag(flags, "path", false);
  const remoteValue = stringFlag(flags, "remote-path", false);
  if (pathValue && remoteValue) {
    throw new Error("--path 与 --remote-path 不能同时使用");
  }
  if (pathValue || remoteValue) return pathValue ?? remoteValue;
  if (!required) return ".";
  throw new Error("缺少 --path");
}

async function connectionInput(flags, options = {}) {
  for (const forbidden of ["password", "key", "key-password"]) {
    if (flags[forbidden] !== undefined) {
      throw new Error(
        `--${forbidden} 不允许直接传入敏感内容，请改用对应的 --${forbidden}-file`,
      );
    }
  }

  const credentialId = boundedStringFlag(flags, "credential-id", {
    required: false,
    maxLength: 128,
  });
  const authType =
    boundedStringFlag(flags, "auth-type", {
      required: false,
      maxLength: 32,
    }) ?? (credentialId ? "credential" : "none");
  if (!["none", "password", "key", "credential"].includes(authType)) {
    throw new Error("--auth-type 必须是 none、password、key 或 credential");
  }

  const passwordFile = stringFlag(flags, "password-file", false);
  const keyFile = stringFlag(flags, "key-file", false);
  const keyPasswordFile = stringFlag(flags, "key-password-file", false);
  if (authType === "password" && !passwordFile) {
    throw new Error("password 认证需要 --password-file");
  }
  if (authType === "key" && !keyFile) {
    throw new Error("key 认证需要 --key-file");
  }
  if (authType === "credential" && !credentialId) {
    throw new Error("credential 认证需要 --credential-id");
  }
  if (authType !== "password" && passwordFile) {
    throw new Error("--password-file 仅可用于 password 认证");
  }
  if (authType !== "key" && (keyFile || keyPasswordFile)) {
    throw new Error("--key-file 和 --key-password-file 仅可用于 key 认证");
  }
  if (authType !== "credential" && credentialId) {
    throw new Error("--credential-id 仅可用于 credential 认证");
  }

  const projectId = boundedStringFlag(flags, "project", {
    maxLength: 256,
  });
  const folder = options.allowFolder
    ? boundedStringFlag(flags, "folder", {
        required: false,
        maxLength: 512,
      })
    : undefined;
  const tags = options.allowFolder
    ? boundedStringFlag(flags, "tags", {
        required: false,
        maxLength: 1024,
      })
        ?.split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
    : undefined;
  const input = {
    projectId,
    address: boundedStringFlag(flags, "address", { maxLength: 255 }),
    port: integerFlag(flags, "port", {
      min: 1,
      max: 65_535,
      defaultValue: 22,
    }),
    username: boundedStringFlag(flags, "username", { maxLength: 255 }),
    authType,
  };
  const name = boundedStringFlag(flags, "name", {
    required: false,
    maxLength: 128,
  });
  if (name !== undefined) input.name = name;
  if (folder !== undefined) input.folder = folder;
  if (tags?.length) input.tags = [...new Set(tags)];
  if (credentialId !== undefined) input.credentialId = credentialId;
  const hostKeyFingerprint = boundedStringFlag(flags, "host-key-fingerprint", {
    required: options.requireHostKey === true,
    maxLength: 32_768,
  });
  if (
    hostKeyFingerprint !== undefined &&
    !/^[a-fA-F0-9]{16,32768}$/.test(hostKeyFingerprint)
  ) {
    throw new Error(
      "--host-key-fingerprint 必须是 SSH Host Key 的十六进制指纹",
    );
  }
  if (hostKeyFingerprint !== undefined) {
    input.hostKeyFingerprint = hostKeyFingerprint.toLowerCase();
  }
  if (passwordFile) {
    input.password = await readSensitiveFile(passwordFile, "密码", {
      trimFinalLine: true,
    });
  }
  if (keyFile) input.key = await readSensitiveFile(keyFile, "私钥");
  if (keyPasswordFile) {
    input.keyPassword = await readSensitiveFile(keyPasswordFile, "私钥口令", {
      trimFinalLine: true,
    });
  }
  return input;
}

async function configuredRuntime() {
  const profiles = new ProfileStore();
  const secrets = createPlatformSecretStore();
  const profile = await loadDeviceProfile(profiles, secrets);
  if (!profile)
    throw new Error("尚未配置 CloudSSH，请先执行 auth login --url <地址>");
  return {
    client: new CloudSshClient(profile.baseUrl, {
      get: async () => ({
        deviceId: profile.deviceId,
        privateKey: await secrets.get(profile.keyId),
      }),
    }),
    state: new SessionStateStore(),
  };
}

async function authCommand(action, flags) {
  const secrets = createPlatformSecretStore();
  const profiles = new ProfileStore();
  const cleanups = new DeviceKeyCleanupStore();
  const state = new SessionStateStore();
  if (action === "login") {
    const baseUrl = normalizeBaseUrl(stringFlag(flags, "url"));
    if (flags.token !== undefined) {
      throw new Error("--token 已移除，请使用设备码审批登录");
    }
    const deviceName =
      stringFlag(flags, "name", false) ??
      `${os.hostname()} (${process.platform})`;
    const keyId = randomUUID();
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    const privateKeyPem = privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    const fingerprint = sha256(
      createPublicKey(publicKeyPem).export({ type: "spki", format: "der" }),
    );
    const response = await fetch(`${baseUrl}/auth/device-requests`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ deviceName, publicKey: publicKeyPem }),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.request) {
      throw new CloudSshApiError(
        payload?.error ?? `设备注册失败（HTTP ${response.status}）`,
        response.status,
        safeErrorCode(payload?.code),
      );
    }
    const pending = payload.request;
    let approved = null;
    process.stderr.write(
      `\nCloudSSH 新设备等待审批\n设备：${deviceName}\n设备码：${pending.code}\n指纹：${fingerprint}\n\n请在网页“Agent 接入”中输入设备码并批准。\n`,
    );
    const deadline = Date.parse(pending.expiresAt);
    while (true) {
      const pollUrl = new URL(
        `${baseUrl}/auth/device-requests/${encodeURIComponent(pending.requestId)}`,
      );
      const pollResponse = await fetch(pollUrl, {
        headers: signedHeaders({
          method: "GET",
          url: pollUrl,
          privateKey: privateKeyPem,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const status = await pollResponse.json().catch(() => null);
      if (pollResponse.ok && status?.status === "approved" && status.deviceId) {
        approved = status;
        break;
      }
      if (["denied", "expired"].includes(status?.status)) {
        throw new Error(
          status.status === "denied" ? "设备审批已拒绝" : "设备码已过期",
        );
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(Number(pending.intervalSeconds ?? 2) * 1000, remainingMs),
        ),
      );
    }
    if (!approved) throw new Error("设备码已过期，请重新登录");
    await commitDeviceIdentity(
      profiles,
      secrets,
      cleanups,
      {
        baseUrl,
        deviceId: approved.deviceId,
        publicKey: publicKeyPem,
        fingerprint,
        keyId,
      },
      privateKeyPem,
    );
    print({
      authenticated: true,
      baseUrl,
      deviceId: approved.deviceId,
      deviceName,
      fingerprint,
    });
    return;
  }
  if (action === "status") {
    const profile = await loadDeviceProfile(profiles, secrets, cleanups);
    print({
      configured: Boolean(profile),
      authenticated: Boolean(
        profile?.deviceId && (await secrets.get(profile.keyId)),
      ),
      baseUrl: profile?.baseUrl ?? null,
      deviceId: profile?.deviceId ?? null,
      fingerprint: profile?.fingerprint ?? null,
    });
    return;
  }
  if (action === "logout") {
    const cleanupPending = await removeDeviceIdentity(
      profiles,
      secrets,
      cleanups,
    );
    await state.clear();
    print({ authenticated: false, cleanupPending: cleanupPending.length });
    return;
  }
  throw new Error("auth 仅支持 login、status、logout");
}

async function projectsCommand(action, flags, client) {
  if (action !== "list") throw new Error("projects 仅支持 list");
  if (Object.keys(flags).length > 0) {
    throw new Error("projects list 不接受额外参数");
  }
  print({ projects: await client.listProjects() });
}

async function foldersCommand(action, flags, client) {
  if (action !== "list") throw new Error("folders 仅支持 list");
  assertOnlyFlags(flags, new Set(["project"]));
  print({
    folders: await client.listProjectFolders(stringFlag(flags, "project")),
  });
}

async function credentialsCommand(action, flags, client) {
  if (action !== "list") throw new Error("credentials 仅支持 list");
  assertOnlyFlags(flags, new Set(["project"]));
  print({
    credentials: await client.listProjectCredentials(
      stringFlag(flags, "project"),
    ),
  });
}

async function serversCommand(action, flags, client) {
  if (action === "list") {
    print({ servers: await client.listServers() });
    return;
  }
  if (action === "create") {
    assertOnlyFlags(
      flags,
      new Set([
        "project",
        "folder",
        "tags",
        "name",
        "address",
        "port",
        "username",
        "auth-type",
        "credential-id",
        "password-file",
        "key-file",
        "key-password-file",
        "host-key-fingerprint",
        "password",
        "key",
        "key-password",
      ]),
    );
    print({
      server: await client.createServer(
        await connectionInput(flags, { allowFolder: true }),
      ),
    });
    return;
  }
  throw new Error("servers 仅支持 list、create");
}

async function quickConnectCommand(action, flags, client) {
  if (action !== "create") throw new Error("quick-connect 仅支持 create");
  assertOnlyFlags(
    flags,
    new Set([
      "project",
      "name",
      "address",
      "port",
      "username",
      "auth-type",
      "credential-id",
      "password-file",
      "key-file",
      "key-password-file",
      "host-key-fingerprint",
      "password",
      "key",
      "key-password",
    ]),
  );
  print({
    connection: await client.createQuickConnection(
      await connectionInput(flags, { requireHostKey: true }),
    ),
  });
}

async function filesCommand(action, flags, client) {
  if (action === "list") {
    assertOnlyFlags(flags, new Set(["server", "path", "remote-path"]));
    print(
      await client.listFiles(
        stringFlag(flags, "server"),
        remotePathFlag(flags, false),
      ),
    );
    return;
  }
  if (action === "read") {
    assertOnlyFlags(flags, new Set(["server", "path", "remote-path"]));
    print(
      await client.readRemoteFile(
        stringFlag(flags, "server"),
        remotePathFlag(flags),
      ),
    );
    return;
  }
  if (action === "upload") {
    assertOnlyFlags(
      flags,
      new Set(["server", "path", "remote-path", "local-path"]),
    );
    const local = localPathFlag(flags);
    const transfer = await readTransferFile(local);
    const remotePath = remotePathFlag(flags);
    const file = await client.uploadFile(
      stringFlag(flags, "server"),
      remotePath,
      transfer.data,
    );
    // 只返回路径和大小，避免把本地文件内容带入 Agent 对话。
    print({ file, localPath: transfer.path, size: transfer.data.length });
    return;
  }
  if (action === "download") {
    assertOnlyFlags(
      flags,
      new Set(["server", "path", "remote-path", "local-path", "force"]),
    );
    const local = localPathFlag(flags);
    const remotePath = remotePathFlag(flags);
    const downloaded = await client.downloadFile(
      stringFlag(flags, "server"),
      remotePath,
    );
    const localPath = await writeTransferFile(
      local,
      downloaded,
      flags.force === true,
    );
    print({
      download: {
        serverId: stringFlag(flags, "server"),
        path: remotePath,
        localPath,
        size: downloaded.length,
      },
    });
    return;
  }
  if (action === "mkdir") {
    assertOnlyFlags(
      flags,
      new Set(["server", "path", "remote-path", "recursive"]),
    );
    print({
      directory: await client.makeDirectory(
        stringFlag(flags, "server"),
        remotePathFlag(flags),
        flags.recursive === true,
      ),
    });
    return;
  }
  if (action === "rename") {
    assertOnlyFlags(
      flags,
      new Set(["server", "source-path", "destination-path"]),
    );
    print({
      file: await client.renameFile(
        stringFlag(flags, "server"),
        stringFlag(flags, "source-path"),
        stringFlag(flags, "destination-path"),
      ),
    });
    return;
  }
  if (action === "delete") {
    assertOnlyFlags(
      flags,
      new Set(["server", "path", "remote-path", "recursive"]),
    );
    print({
      file: await client.deleteFile(
        stringFlag(flags, "server"),
        remotePathFlag(flags),
        flags.recursive === true,
      ),
    });
    return;
  }
  throw new Error(
    "files 支持 list、read、upload、download、mkdir、rename、delete",
  );
}

async function jobsCommand(action, flags, client) {
  if (action === "list") {
    print({ jobs: await client.listJobs() });
    return;
  }
  if (action === "status") {
    print({ job: await client.jobStatus(stringFlag(flags, "job")) });
    return;
  }
  if (action === "cancel") {
    print({ job: await client.cancelJob(stringFlag(flags, "job")) });
    return;
  }
  if (action === "create" || action === "run") {
    const timeoutMs = integerFlag(flags, "timeout-ms", {
      min: 1_000,
      max: 900_000,
      defaultValue: 30_000,
    });
    let job = await client.createJob({
      serverId: stringFlag(flags, "server"),
      command: stringFlag(flags, "command"),
      timeoutMs,
    });
    if (action === "run") {
      const deadline = Date.now() + timeoutMs + 30_000;
      while (!TERMINAL_JOB_STATES.has(job.state) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        job = await client.jobStatus(job.id);
      }
      if (!TERMINAL_JOB_STATES.has(job.state)) {
        throw new CloudSshApiError(
          `等待任务 ${job.id} 进入终态超时，请继续使用 jobs status 查询`,
          0,
          "JOB_WAIT_TIMEOUT",
        );
      }
    }
    print({ job });
    return;
  }
  throw new Error("jobs 支持 create、run、list、status、cancel");
}

async function sessionsCommand(action, flags, client, stateStore) {
  if (action === "list") {
    print({ sessions: await client.listSessions() });
    return;
  }
  const sessionId =
    action === "create" ? undefined : stringFlag(flags, "session");
  if (action === "create") {
    const pinned = flags.pinned === true;
    const session = await client.createSession({
      serverId: stringFlag(flags, "server"),
      cols: integerFlag(flags, "cols", {
        min: 20,
        max: 500,
        defaultValue: 120,
      }),
      rows: integerFlag(flags, "rows", { min: 5, max: 300, defaultValue: 30 }),
      pinned,
      runtimeMode: resolveSessionRuntimeMode(flags, pinned),
    });
    print({ session });
    return;
  }
  if (action === "status") {
    print({ session: await client.sessionStatus(sessionId) });
    return;
  }
  if (action === "attach") {
    const mode = stringFlag(flags, "mode", false) ?? "read-only";
    if (mode !== "read-only" && mode !== "read-write") {
      throw new Error("--mode 必须是 read-only 或 read-write");
    }
    const attachment = await client.attachSession(
      sessionId,
      mode,
      flags.takeover === true,
    );
    await stateStore.update(sessionId, {
      attachmentId: attachment.attachmentId,
      leaseId: attachment.lease?.id ?? null,
      mode: attachment.mode,
    });
    print({ attachment });
    return;
  }
  const state = (await stateStore.read()).sessions[sessionId] ?? {};
  if (action === "read") {
    const cursor =
      flags["from-start"] === true
        ? undefined
        : (stringFlag(flags, "cursor", false) ?? state.cursor);
    const output = await client.readSession(
      sessionId,
      cursor,
      integerFlag(flags, "limit-bytes", { min: 1, max: 262_144 }),
      state.attachmentId ?? undefined,
    );
    await stateStore.update(sessionId, { cursor: output.nextCursor });
    print({ output });
    return;
  }
  if (action === "write" || action === "send") {
    if (!state.attachmentId || !state.leaseId || state.mode !== "read-write") {
      throw new Error("缺少写入租约，请先以 read-write 模式附着会话");
    }
    const data =
      action === "send"
        ? `${stringFlag(flags, "command")}\n`
        : stringFlag(flags, "data");
    print({
      result: await client.writeSession(
        sessionId,
        state.attachmentId,
        state.leaseId,
        data,
      ),
    });
    return;
  }
  if (action === "resize") {
    if (!state.attachmentId || !state.leaseId || state.mode !== "read-write") {
      throw new Error("缺少写入租约，请先以 read-write 模式附着会话");
    }
    print({
      session: await client.resizeSession(
        sessionId,
        state.attachmentId,
        state.leaseId,
        integerFlag(flags, "cols", { min: 20, max: 500, required: true }),
        integerFlag(flags, "rows", { min: 5, max: 300, required: true }),
      ),
    });
    return;
  }
  if (action === "detach") {
    if (!state.attachmentId) throw new Error("缺少附件，请先附着会话");
    const result = await client.detachSession(sessionId, state.attachmentId);
    await stateStore.update(sessionId, {
      attachmentId: null,
      leaseId: null,
      mode: null,
    });
    print({ result });
    return;
  }
  if (action === "close") {
    const session = await client.closeSession(sessionId);
    await stateStore.remove(sessionId);
    print({ session });
    return;
  }
  throw new Error(
    "sessions 支持 create、list、status、attach、read、write、send、resize、detach、close",
  );
}

export function resolveSessionRuntimeMode(flags, pinned = false) {
  const explicitMode = stringFlag(flags, "mode", false);
  if (
    explicitMode !== undefined &&
    explicitMode !== "platform" &&
    explicitMode !== "tmux"
  ) {
    throw new Error("sessions create 的 --mode 必须是 platform 或 tmux");
  }
  return explicitMode ?? (pinned ? "tmux" : "platform");
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const HELP = `CloudSSH Skill CLI（无需 MCP 或仓库构建）

auth login --url <https-url> [--name <设备名称>]
                                    生成设备私钥并等待网页审批
auth status | logout
projects list
folders list --project <项目 ID>
credentials list --project <项目 ID>
servers list
servers create --project <项目 ID> --address <主机名或 IP> --username <用户>
               [--name <名称>] [--folder <分类路径>] [--tags <标签,标签>]
               [--port 22]
               --auth-type none|credential|password|key
               [--credential-id <ID> | --password-file <文件> |
                --key-file <文件> [--key-password-file <文件>]]
               [--host-key-fingerprint <十六进制指纹>]
quick-connect create --project <项目 ID> --address <主机名或 IP>
                     --username <用户> [--port 22] <同上认证参数>
                     --host-key-fingerprint <十六进制指纹>
jobs run --server <id> --command "<完整命令>" [--timeout-ms 30000]
jobs create|list|status|cancel
sessions create --server <id> [--mode platform|tmux] [--pinned]
sessions list|status|attach|read|write|send|resize|detach|close
files list --server <id> [--path <远程目录>]
files read --server <id> --path <远程文件>
files upload --server <id> --path <远程文件> --local-path <本地文件>
files download --server <id> --path <远程文件> --local-path <本地文件> [--force]
files mkdir --server <id> --path <远程目录> [--recursive]
files rename --server <id> --source-path <原路径> --destination-path <新路径>
files delete --server <id> --path <远程路径> [--recursive]
`;

export async function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArguments(argv);
  const [group, action] = positional;
  if (!group || group === "help" || flags.help) {
    process.stdout.write(HELP);
    return;
  }
  if (positional.length > 2) {
    throw new Error(
      "存在未识别参数；多词命令必须作为 --command 后的一个带引号参数传入",
    );
  }
  if (group === "auth") {
    await authCommand(action, flags);
    return;
  }
  const { client, state } = await configuredRuntime();
  if (group === "projects") return projectsCommand(action, flags, client);
  if (group === "folders") return foldersCommand(action, flags, client);
  if (group === "credentials") return credentialsCommand(action, flags, client);
  if (group === "servers") return serversCommand(action, flags, client);
  if (group === "quick-connect")
    return quickConnectCommand(action, flags, client);
  if (group === "jobs") return jobsCommand(action, flags, client);
  if (group === "sessions")
    return sessionsCommand(action, flags, client, state);
  if (group === "files") return filesCommand(action, flags, client);
  throw new Error(`未知命令组：${group}`);
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((error) => {
    const payload = {
      error: redact(error?.message ?? String(error)),
      code: error?.code ?? "SKILL_ERROR",
      status: error?.status ?? 0,
    };
    process.stderr.write(`${JSON.stringify(payload)}\n`);
    process.exitCode = 1;
  });
}
