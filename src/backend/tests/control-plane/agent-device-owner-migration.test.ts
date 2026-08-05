import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ensureControlPlaneSchema } from "../../control-plane/schema-migration.js";

function createLegacyDatabase(): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE ssh_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      folder TEXT
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      team_id TEXT,
      owner_user_id TEXT NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE service_accounts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL,
      description TEXT,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(project_id, name),
      UNIQUE(project_id, id)
    );
    CREATE TABLE agent_devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      public_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      access_mode TEXT NOT NULL DEFAULT 'selected',
      scopes TEXT NOT NULL DEFAULT '[]',
      max_concurrent_sessions INTEGER NOT NULL DEFAULT 1,
      approved_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      expires_at TEXT,
      last_used_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      approved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at TEXT
    );
    CREATE TABLE audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      success INTEGER NOT NULL,
      timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    INSERT INTO users (id, username, password_hash) VALUES
      ('original-admin', 'original-admin', 'hash'),
      ('later-admin', 'later-admin', 'hash');
    INSERT INTO projects (id, owner_user_id, kind, name, slug) VALUES
      ('project-1', 'original-admin', 'personal', 'One', 'one'),
      ('project-2', 'later-admin', 'personal', 'Two', 'two');
    INSERT INTO agent_devices (
      id, name, public_key, fingerprint, approved_by_user_id
    ) VALUES
      ('audit-device', 'Audit device', 'key-a', 'fingerprint-a', 'later-admin'),
      ('account-device', 'Account device', 'key-b', 'fingerprint-b', 'later-admin'),
      ('unknown-device', 'Unknown device', 'key-c', 'fingerprint-c', 'later-admin');
    INSERT INTO audit_logs (
      user_id, username, action, resource_type, resource_id, success, timestamp
    ) VALUES
      ('later-admin', 'later-admin', 'update_agent_device', 'agent_device',
       'audit-device', 1, '2026-02-01T00:00:00.000Z'),
      ('original-admin', 'original-admin', 'approve_agent_device', 'agent_device',
       'audit-device', 1, '2026-01-01T00:00:00.000Z'),
      ('later-admin', 'later-admin', 'approve_agent_device', 'other_resource',
       'audit-device', 1, '2025-01-01T00:00:00.000Z'),
      ('later-admin', 'later-admin', 'approve_agent_device', 'agent_device',
       'audit-device', 0, '2025-01-01T00:00:00.000Z');
    INSERT INTO service_accounts (
      id, project_id, name, created_by, created_at
    ) VALUES
      ('audit-original', 'project-1', '__device__:audit-device:project-1',
       'later-admin', '2025-12-01T00:00:00.000Z'),
      ('account-original', 'project-1', '__device__:account-device:project-1',
       'original-admin', '2026-01-01T00:00:00.000Z'),
      ('account-later', 'project-2', '__device__:account-device:project-2',
       'later-admin', '2026-02-01T00:00:00.000Z');
  `);
  return sqlite;
}

describe("Agent 设备所有者迁移", () => {
  const databases: Database.Database[] = [];

  afterEach(() => {
    for (const sqlite of databases.splice(0)) sqlite.close();
  });

  it("优先按首次审批恢复，缺少审计时使用最早内部账号且保持幂等", () => {
    const sqlite = createLegacyDatabase();
    databases.push(sqlite);

    expect(() => ensureControlPlaneSchema(sqlite)).not.toThrow();
    expect(() => ensureControlPlaneSchema(sqlite)).not.toThrow();

    expect(
      sqlite
        .prepare(
          `SELECT id, owner_user_id AS ownerUserId
             FROM agent_devices ORDER BY id`,
        )
        .all(),
    ).toEqual([
      { id: "account-device", ownerUserId: "original-admin" },
      { id: "audit-device", ownerUserId: "original-admin" },
      { id: "unknown-device", ownerUserId: null },
    ]);

    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO agent_devices
             (id, name, public_key, fingerprint, approved_by_user_id)
           VALUES ('missing-owner', 'Missing', 'key', 'fingerprint-d', 'later-admin')`,
        )
        .run(),
    ).toThrow("agent device owner is required");
    expect(() =>
      sqlite
        .prepare(
          "UPDATE agent_devices SET owner_user_id = 'later-admin' WHERE id = 'audit-device'",
        )
        .run(),
    ).toThrow("agent device owner is immutable");
  });
});
