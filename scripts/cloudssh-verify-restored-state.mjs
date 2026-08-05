#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const STORAGE_KEY_PATTERN = /^agent\/recordings\/[a-f0-9]{64}\.jsonl$/;

export function requireIntegrity(database, label) {
  const rows = database.pragma("integrity_check");
  if (rows.length === 0 || rows.some((row) => row.integrity_check !== "ok")) {
    throw new Error(`${label} SQLite integrity_check failed`);
  }
}

export function requireRegularFile(filePath, label) {
  let stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch {
    throw new Error(`${label} file is missing`);
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw new Error(`${label} is not a regular file`);
  }
  return stats;
}

export function resolveStoredFile(root, relativePath, label) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    relativePath.includes("\\")
  ) {
    throw new Error(`${label} has an invalid relative path`);
  }
  const normalized = path.posix.normalize(relativePath);
  if (
    normalized !== relativePath ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  ) {
    throw new Error(`${label} escaped its recording root`);
  }

  const rootStats = fs.lstatSync(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`${label} recording root is not a regular directory`);
  }
  let current = root;
  for (const [index, segment] of normalized.split("/").entries()) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = fs.lstatSync(current);
    } catch {
      throw new Error(`${label} file is missing`);
    }
    const isLast = index === normalized.split("/").length - 1;
    if (stats.isSymbolicLink()) {
      throw new Error(`${label} traverses a symbolic link`);
    }
    if (!isLast && !stats.isDirectory()) {
      throw new Error(`${label} has a non-directory parent`);
    }
  }
  requireRegularFile(current, label);
  return current;
}

function tableExists(database, tableName) {
  return Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?")
      .get("table", tableName),
  );
}

function tableColumns(database, tableName) {
  return new Set(
    database
      .prepare(`PRAGMA table_info(${tableName})`)
      .all()
      .map((row) => row.name),
  );
}

function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function requireColumns(database, tableName, requiredColumns) {
  const columns = tableColumns(database, tableName);
  for (const required of requiredColumns) {
    if (!columns.has(required)) {
      throw new Error(`${tableName}.${required} is missing`);
    }
  }
  return columns;
}

export function validateSecurityDatabase(database) {
  const requiredSchema = {
    request_nonces: ["device_id", "nonce", "expires_at"],
    audit_events: [
      "id",
      "sync_sequence",
      "project_id",
      "service_account_id",
      "action",
      "success",
      "occurred_at",
    ],
    auth_events: ["id", "method", "path", "error_code", "occurred_at"],
    audit_event_sequence: ["id", "last_value"],
  };

  for (const [tableName, columns] of Object.entries(requiredSchema)) {
    if (!tableExists(database, tableName)) {
      throw new Error(`agent-security table ${tableName} is missing`);
    }
    requireColumns(database, tableName, columns);
  }
}

export function validateRecordingReferences(
  database,
  { dataRoot, recordingsRoot },
) {
  let agentRecordingCount = 0;
  if (tableExists(database, "project_session_recordings")) {
    requireColumns(database, "project_session_recordings", [
      "session_id",
      "mode",
      "storage_key",
      "size_bytes",
      "checksum",
    ]);
    const recordings = database
      .prepare(
        `SELECT session_id AS sessionId, mode,
                storage_key AS storageKey, size_bytes AS sizeBytes, checksum
           FROM project_session_recordings`,
      )
      .all();
    agentRecordingCount = recordings.length;

    for (const recording of recordings) {
      if (recording.storageKey === null) {
        if (
          recording.mode !== "metadata" ||
          recording.checksum !== null ||
          recording.sizeBytes !== 0
        ) {
          throw new Error(
            `agent recording ${recording.sessionId} has inconsistent empty storage metadata`,
          );
        }
        continue;
      }
      if (
        recording.mode !== "full" ||
        typeof recording.storageKey !== "string" ||
        !STORAGE_KEY_PATTERN.test(recording.storageKey)
      ) {
        throw new Error(
          `agent recording ${recording.sessionId} has an invalid storage key`,
        );
      }

      const label = `agent recording ${recording.sessionId}`;
      const recordingFile = resolveStoredFile(
        dataRoot,
        recording.storageKey,
        label,
      );
      const stats = requireRegularFile(recordingFile, label);
      if (
        !Number.isSafeInteger(recording.sizeBytes) ||
        recording.sizeBytes < 0 ||
        recording.sizeBytes !== stats.size
      ) {
        throw new Error(`${label} size does not match the database`);
      }
      if (
        typeof recording.checksum !== "string" ||
        !/^[a-f0-9]{64}$/.test(recording.checksum)
      ) {
        throw new Error(`${label} has an invalid checksum`);
      }
      if (hashFile(recordingFile) !== recording.checksum) {
        throw new Error(`${label} checksum does not match the database`);
      }
    }
  }

  let sessionRecordingCount = 0;
  if (tableExists(database, "session_recordings")) {
    const columns = requireColumns(database, "session_recordings", [
      "id",
      "recording_path",
    ]);
    const formatExpression = columns.has("format")
      ? "format"
      : "NULL AS format";
    const recordings = database
      .prepare(
        `SELECT id, recording_path AS recordingPath, ${formatExpression}
           FROM session_recordings
          WHERE recording_path IS NOT NULL`,
      )
      .all();
    sessionRecordingCount = recordings.length;

    for (const recording of recordings) {
      if (
        typeof recording.recordingPath !== "string" ||
        recording.recordingPath.includes("\\")
      ) {
        throw new Error(
          `session recording ${recording.id} has an invalid path`,
        );
      }
      const mappings = [
        ["/app/data/session_recordings/guacamole/", recordingsRoot],
        ["session_recordings/guacamole/", recordingsRoot],
        ["/app/data/session_logs/", path.join(dataRoot, "session_logs")],
        ["session_logs/", path.join(dataRoot, "session_logs")],
      ];
      const mapping = mappings.find(([prefix]) =>
        recording.recordingPath.startsWith(prefix),
      );
      if (!mapping) {
        throw new Error(
          `session recording ${recording.id} is outside supported recording roots`,
        );
      }
      const [prefix, root] = mapping;
      if (recording.format === "guacamole" && root !== recordingsRoot) {
        throw new Error(
          `guacamole recording ${recording.id} is outside the dedicated volume`,
        );
      }
      resolveStoredFile(
        root,
        recording.recordingPath.slice(prefix.length),
        `session recording ${recording.id}`,
      );
    }
  }

  return { agentRecordingCount, sessionRecordingCount };
}

export function validateRuntimeState(dataRoot) {
  const runtimeStatePath = path.join(dataRoot, "agent/runtime-state.json");
  requireRegularFile(runtimeStatePath, "agent runtime state");
  const state = JSON.parse(fs.readFileSync(runtimeStatePath, "utf8"));
  if (
    !state ||
    state.version !== 1 ||
    !Array.isArray(state.sessions) ||
    !Array.isArray(state.jobs) ||
    !Array.isArray(state.idempotency)
  ) {
    throw new Error("agent/runtime-state.json schema is invalid");
  }
  const shutdownMarkerPath = path.join(dataRoot, ".cloudssh-clean-shutdown");
  requireRegularFile(shutdownMarkerPath, "clean shutdown marker");
  const shutdownMarker = JSON.parse(
    fs.readFileSync(shutdownMarkerPath, "utf8"),
  );
  if (
    !shutdownMarker ||
    typeof shutdownMarker.completedAt !== "string" ||
    !Number.isFinite(Date.parse(shutdownMarker.completedAt))
  ) {
    throw new Error("clean shutdown marker is invalid");
  }
}

async function loadDefaultDependencies(appRoot) {
  const requireFromApp = createRequire(path.join(appRoot, "package.json"));
  const Database = requireFromApp("better-sqlite3");
  const { DatabaseFileEncryption } = await import(
    pathToFileURL(
      path.join(
        appRoot,
        "dist/backend/backend/utils/database-file-encryption.js",
      ),
    ).href
  );
  const { loadPlatformMasterKey, PlatformCredentialVault } = await import(
    pathToFileURL(
      path.join(
        appRoot,
        "dist/backend/backend/control-plane/credential-vault.js",
      ),
    ).href
  );

  return {
    Database,
    decryptDatabaseToBuffer:
      DatabaseFileEncryption.decryptDatabaseToBuffer.bind(
        DatabaseFileEncryption,
      ),
    loadPlatformMasterKey,
    PlatformCredentialVault,
  };
}

export function formatValidationFailure() {
  return "恢复状态校验失败：JSON、SQLite、录像引用或凭据解密检查未通过。";
}

export async function verifyRestoredState({
  appRoot = process.env.CLOUDSSH_APP_ROOT || "/app",
  dataRoot = process.env.DATA_DIR || "/restore",
  recordingsRoot = process.env.CLOUDSSH_RESTORE_RECORDINGS_DIR || "/recordings",
  temporaryRoot = os.tmpdir(),
  dependencies,
} = {}) {
  validateRuntimeState(dataRoot);
  const {
    Database,
    decryptDatabaseToBuffer,
    loadPlatformMasterKey,
    PlatformCredentialVault,
  } = dependencies || (await loadDefaultDependencies(appRoot));

  const securityPath = path.join(dataRoot, "agent/agent-security.sqlite");
  requireRegularFile(securityPath, "agent-security database");
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(`${securityPath}${suffix}`)) {
      throw new Error(
        `agent-security database has an unexpected ${suffix} sidecar`,
      );
    }
  }
  // SQLite 的 integrity_check 可能需要临时 journal；把安全库复制到临时可写目录，
  // 避免在只读恢复卷上产生写入，同时用摘要确认复制期间源文件没有变化。
  const securityTemporaryDirectory = fs.mkdtempSync(
    path.join(temporaryRoot, "cloudssh-security-"),
  );
  fs.chmodSync(securityTemporaryDirectory, 0o700);
  const securityCopyPath = path.join(
    securityTemporaryDirectory,
    "agent-security.sqlite",
  );
  let security;
  try {
    const securityHash = hashFile(securityPath);
    fs.copyFileSync(securityPath, securityCopyPath);
    fs.chmodSync(securityCopyPath, 0o600);
    if (
      hashFile(securityCopyPath) !== securityHash ||
      hashFile(securityPath) !== securityHash
    ) {
      throw new Error("agent-security database changed during validation copy");
    }
    security = new Database(securityCopyPath, {
      readonly: true,
      fileMustExist: true,
    });
    requireIntegrity(security, "agent-security");
    validateSecurityDatabase(security);
  } finally {
    security?.close();
    fs.rmSync(securityTemporaryDirectory, { recursive: true, force: true });
  }

  const encryptedDatabasePath = path.join(dataRoot, "db.sqlite.encrypted");
  requireRegularFile(encryptedDatabasePath, "encrypted main database");
  let decryptedDirectory;
  let decrypted;
  try {
    decryptedDirectory = fs.mkdtempSync(
      path.join(temporaryRoot, "cloudssh-restore-"),
    );
    fs.chmodSync(decryptedDirectory, 0o700);
    const decryptedPath = path.join(decryptedDirectory, "db.sqlite");
    decrypted = await decryptDatabaseToBuffer(encryptedDatabasePath);
    if (!Buffer.isBuffer(decrypted)) {
      throw new Error("database decryptor returned invalid data");
    }
    fs.writeFileSync(decryptedPath, decrypted, {
      flag: "wx",
      mode: 0o600,
    });
    fs.chmodSync(decryptedPath, 0o600);
    decrypted.fill(0);
    decrypted = undefined;

    const main = new Database(decryptedPath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      requireIntegrity(main, "main");
      if (!tableExists(main, "project_credentials")) {
        throw new Error("project_credentials table is missing");
      }
      requireColumns(main, "project_credentials", [
        "id",
        "project_id",
        "encrypted_secret",
      ]);
      const credentials = main
        .prepare(
          `SELECT id, project_id AS projectId,
                  encrypted_secret AS encryptedSecret
             FROM project_credentials`,
        )
        .all();
      const masterKey = await loadPlatformMasterKey();
      try {
        const vault = new PlatformCredentialVault(masterKey);
        for (const credential of credentials) {
          vault.decrypt(
            credential.id,
            credential.projectId,
            credential.encryptedSecret,
          );
        }
      } finally {
        if (Buffer.isBuffer(masterKey)) masterKey.fill(0);
      }
      const counts = validateRecordingReferences(main, {
        dataRoot,
        recordingsRoot,
      });
      return { credentialCount: credentials.length, ...counts };
    } finally {
      main.close();
    }
  } finally {
    if (Buffer.isBuffer(decrypted)) decrypted.fill(0);
    if (decryptedDirectory) {
      fs.rmSync(decryptedDirectory, { recursive: true, force: true });
    }
  }
}

function isMainModule() {
  return (
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  );
}

if (isMainModule()) {
  verifyRestoredState()
    .then((result) => {
      console.log(
        `结构校验通过；已验证 ${result.credentialCount} 条项目凭据密文、${result.agentRecordingCount} 条 Agent 录像和 ${result.sessionRecordingCount} 条会话录像。`,
      );
    })
    .catch(() => {
      console.error(formatValidationFailure());
      process.exitCode = 2;
    });
}
