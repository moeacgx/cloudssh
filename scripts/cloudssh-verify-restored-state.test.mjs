import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlatformCredentialVault } from "../src/backend/control-plane/credential-vault.ts";
import {
  formatValidationFailure,
  validateRecordingReferences,
  verifyRestoredState,
} from "./cloudssh-verify-restored-state.mjs";

const temporaryDirectories = [];
const agentStorageKey = `agent/recordings/${"a".repeat(64)}.jsonl`;
const agentContent = Buffer.from('{"direction":"output","data":"ok"}\n');
const agentChecksum = crypto
  .createHash("sha256")
  .update(agentContent)
  .digest("hex");

let database;
let dataRoot;
let recordingsRoot;

beforeEach(async () => {
  dataRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudssh-recording-verify-"),
  );
  temporaryDirectories.push(dataRoot);
  recordingsRoot = path.join(dataRoot, "dedicated-recordings");
  await Promise.all([
    fs.mkdir(path.join(dataRoot, "agent/recordings"), { recursive: true }),
    fs.mkdir(path.join(dataRoot, "session_logs/user-1"), { recursive: true }),
    fs.mkdir(recordingsRoot, { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(dataRoot, agentStorageKey), agentContent),
    fs.writeFile(
      path.join(dataRoot, "session_logs/user-1/session.cast"),
      "terminal recording",
    ),
    fs.writeFile(path.join(recordingsRoot, "desktop.guac"), "guacamole"),
  ]);

  database = new Database(":memory:");
  database.exec(`
    CREATE TABLE project_session_recordings (
      session_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      storage_key TEXT,
      size_bytes INTEGER NOT NULL,
      checksum TEXT
    );
    CREATE TABLE session_recordings (
      id INTEGER PRIMARY KEY,
      recording_path TEXT,
      format TEXT
    );
  `);
  database
    .prepare(
      `INSERT INTO project_session_recordings
         (session_id, mode, storage_key, size_bytes, checksum)
       VALUES (?, 'full', ?, ?, ?), (?, 'metadata', NULL, 0, NULL)`,
    )
    .run(
      "agent-session",
      agentStorageKey,
      agentContent.length,
      agentChecksum,
      "personal-session",
    );
  database
    .prepare(
      `INSERT INTO session_recordings (id, recording_path, format)
       VALUES (1, '/app/data/session_logs/user-1/session.cast', 'asciicast'),
              (2, '/app/data/session_recordings/guacamole/desktop.guac', 'guacamole')`,
    )
    .run();
});

afterEach(async () => {
  database?.close();
  database = undefined;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function validate() {
  return validateRecordingReferences(database, { dataRoot, recordingsRoot });
}

async function createRestoredStateFixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudssh-state-verify-"),
  );
  temporaryDirectories.push(root);
  const agentRoot = path.join(root, "agent");
  const restoredRecordingsRoot = path.join(root, "recordings");
  const temporaryRoot = path.join(root, "temporary");
  await Promise.all([
    fs.mkdir(agentRoot, { recursive: true }),
    fs.mkdir(restoredRecordingsRoot),
    fs.mkdir(temporaryRoot),
  ]);
  await Promise.all([
    fs.writeFile(
      path.join(agentRoot, "runtime-state.json"),
      JSON.stringify({ version: 1, sessions: [], jobs: [], idempotency: [] }),
    ),
    fs.writeFile(
      path.join(root, ".cloudssh-clean-shutdown"),
      JSON.stringify({ completedAt: new Date().toISOString() }),
    ),
  ]);

  const securityPath = path.join(agentRoot, "agent-security.sqlite");
  const security = new Database(securityPath);
  security.exec(`
    CREATE TABLE request_nonces (
      device_id TEXT NOT NULL,
      nonce TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (device_id, nonce)
    );
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY,
      sync_sequence INTEGER NOT NULL,
      project_id TEXT NOT NULL,
      service_account_id TEXT NOT NULL,
      action TEXT NOT NULL,
      success INTEGER NOT NULL,
      occurred_at TEXT NOT NULL
    );
    CREATE TABLE auth_events (
      id TEXT PRIMARY KEY,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      error_code TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );
    CREATE TABLE audit_event_sequence (
      id INTEGER PRIMARY KEY,
      last_value INTEGER NOT NULL
    );
  `);
  security.close();

  const masterKey = crypto.randomBytes(32);
  const secret = "restore-test-private-key-do-not-log";
  const encryptedSecret = new PlatformCredentialVault(masterKey).encrypt(
    "credential-1",
    "project-1",
    { privateKey: secret },
  );
  const encryptedDatabasePath = path.join(root, "db.sqlite.encrypted");
  const main = new Database(encryptedDatabasePath);
  main.exec(`
    CREATE TABLE project_credentials (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      encrypted_secret TEXT NOT NULL
    );
  `);
  main
    .prepare(
      `INSERT INTO project_credentials (id, project_id, encrypted_secret)
       VALUES (?, ?, ?)`,
    )
    .run("credential-1", "project-1", encryptedSecret);
  main.close();

  return {
    dataRoot: root,
    recordingsRoot: restoredRecordingsRoot,
    temporaryRoot,
    securityPath,
    encryptedDatabasePath,
    masterKey,
    secret,
  };
}

function verificationDependencies(masterKey, DatabaseConstructor = Database) {
  return {
    Database: DatabaseConstructor,
    decryptDatabaseToBuffer: (filePath) => fs.readFile(filePath),
    loadPlatformMasterKey: async () => Buffer.from(masterKey),
    PlatformCredentialVault,
  };
}

describe("恢复数据库录像引用校验", () => {
  it("使用真实 SQLite 校验 Agent、SSH 和 Guacamole 录像", () => {
    expect(validate()).toEqual({
      agentRecordingCount: 2,
      sessionRecordingCount: 2,
    });
  });

  it("录像文件缺失时拒绝恢复", async () => {
    await fs.rm(path.join(dataRoot, agentStorageKey));
    expect(validate).toThrow("agent recording agent-session file is missing");
  });

  it("Agent 录像大小不符时拒绝恢复", () => {
    database
      .prepare(
        "UPDATE project_session_recordings SET size_bytes = size_bytes + 1 WHERE session_id = ?",
      )
      .run("agent-session");
    expect(validate).toThrow("size does not match the database");
  });

  it("Agent 录像摘要不符时拒绝恢复", () => {
    database
      .prepare(
        "UPDATE project_session_recordings SET checksum = ? WHERE session_id = ?",
      )
      .run("b".repeat(64), "agent-session");
    expect(validate).toThrow("checksum does not match the database");
  });

  it.each([null, ""])("Agent 完整录像摘要为 %p 时拒绝恢复", (checksum) => {
    database
      .prepare(
        "UPDATE project_session_recordings SET checksum = ? WHERE session_id = ?",
      )
      .run(checksum, "agent-session");
    expect(validate).toThrow("has an invalid checksum");
  });

  it("Agent 完整录像的模式与存储键不一致时拒绝恢复", () => {
    database
      .prepare(
        "UPDATE project_session_recordings SET mode = 'metadata' WHERE session_id = ?",
      )
      .run("agent-session");
    expect(validate).toThrow("invalid storage key");
  });

  it("非法 Agent 存储键被拒绝", () => {
    database
      .prepare(
        "UPDATE project_session_recordings SET storage_key = ? WHERE session_id = ?",
      )
      .run("../outside.jsonl", "agent-session");
    expect(validate).toThrow("invalid storage key");
  });

  it("不一致的 Agent 元数据组合被拒绝", () => {
    database
      .prepare(
        `UPDATE project_session_recordings
            SET storage_key = NULL, size_bytes = 1
          WHERE session_id = ?`,
      )
      .run("personal-session");
    expect(validate).toThrow("inconsistent empty storage metadata");
  });

  it("会话录像路径越界或格式与卷不匹配时拒绝恢复", () => {
    database
      .prepare("UPDATE session_recordings SET recording_path = ? WHERE id = 1")
      .run("/etc/passwd");
    expect(validate).toThrow("outside supported recording roots");

    database
      .prepare(
        "UPDATE session_recordings SET recording_path = ?, format = ? WHERE id = 1",
      )
      .run("session_logs/user-1/session.cast", "guacamole");
    expect(validate).toThrow("outside the dedicated volume");
  });
});

describe("恢复状态端到端结构校验", () => {
  it("校验两个数据库与凭据，并使用 0600 临时明文文件后完整清理", async () => {
    const fixture = await createRestoredStateFixture();
    let decryptedMode;
    let securityCopyPath;
    let securityCopyMode;
    class InspectingDatabase {
      constructor(filePath, options) {
        if (path.basename(filePath) === "db.sqlite" && options?.readonly) {
          decryptedMode = fsSync.statSync(filePath).mode & 0o777;
        }
        if (
          path.basename(filePath) === "agent-security.sqlite" &&
          options?.readonly
        ) {
          securityCopyPath = filePath;
          securityCopyMode = fsSync.statSync(filePath).mode & 0o777;
        }
        return new Database(filePath, options);
      }
    }

    await expect(
      verifyRestoredState({
        ...fixture,
        dependencies: verificationDependencies(
          fixture.masterKey,
          InspectingDatabase,
        ),
      }),
    ).resolves.toEqual({
      credentialCount: 1,
      agentRecordingCount: 0,
      sessionRecordingCount: 0,
    });
    if (process.platform !== "win32") expect(decryptedMode).toBe(0o600);
    expect(securityCopyPath).not.toBe(fixture.securityPath);
    if (process.platform !== "win32") expect(securityCopyMode).toBe(0o600);
    await expect(fs.readdir(fixture.temporaryRoot)).resolves.toEqual([]);
  });

  it.each(["-wal", "-shm"])(
    "安全库存在 %s 侧车文件时拒绝只备份主文件",
    async (suffix) => {
      const fixture = await createRestoredStateFixture();
      await fs.writeFile(`${fixture.securityPath}${suffix}`, "stale-sidecar");

      await expect(
        verifyRestoredState({
          ...fixture,
          dependencies: verificationDependencies(fixture.masterKey),
        }),
      ).rejects.toThrow(`unexpected ${suffix} sidecar`);
      await expect(fs.readdir(fixture.temporaryRoot)).resolves.toEqual([]);
    },
  );

  it("错误根密钥会失败，不泄露凭据，并清理临时明文库", async () => {
    const fixture = await createRestoredStateFixture();
    const error = await verifyRestoredState({
      ...fixture,
      dependencies: verificationDependencies(crypto.randomBytes(32)),
    }).then(
      () => null,
      (reason) => reason,
    );

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(fixture.secret);
    expect(formatValidationFailure(error)).not.toContain(fixture.secret);
    await expect(fs.readdir(fixture.temporaryRoot)).resolves.toEqual([]);
  });

  it("损坏的主库会失败并清理临时明文文件", async () => {
    const fixture = await createRestoredStateFixture();
    await fs.writeFile(
      fixture.encryptedDatabasePath,
      Buffer.from("not-a-sqlite-database"),
    );

    await expect(
      verifyRestoredState({
        ...fixture,
        dependencies: verificationDependencies(fixture.masterKey),
      }),
    ).rejects.toThrow();
    await expect(fs.readdir(fixture.temporaryRoot)).resolves.toEqual([]);
  });

  it("安全库缺失或只有空 SQLite 外壳时拒绝恢复", async () => {
    const fixture = await createRestoredStateFixture();
    await fs.rm(fixture.securityPath);
    await expect(
      verifyRestoredState({
        ...fixture,
        dependencies: verificationDependencies(fixture.masterKey),
      }),
    ).rejects.toThrow("agent-security database file is missing");

    const emptySecurity = new Database(fixture.securityPath);
    emptySecurity.close();
    await expect(
      verifyRestoredState({
        ...fixture,
        dependencies: verificationDependencies(fixture.masterKey),
      }),
    ).rejects.toThrow("agent-security table request_nonces is missing");
  });
});
