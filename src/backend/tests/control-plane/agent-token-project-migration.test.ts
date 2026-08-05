import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteAgentCredentialStore } from "../../agent/auth.js";
import { ensureControlPlaneSchema } from "../../control-plane/schema-migration.js";

const TOKEN_PREFIX = "cssh_legacy12";

function createLegacyDatabase(): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE ssh_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id),
      connection_type TEXT NOT NULL DEFAULT 'ssh',
      name TEXT,
      ip TEXT NOT NULL,
      port INTEGER NOT NULL,
      username TEXT NOT NULL,
      folder TEXT,
      tags TEXT,
      enable_terminal INTEGER NOT NULL DEFAULT 1,
      enable_file_manager INTEGER NOT NULL DEFAULT 1,
      enable_session_logging INTEGER NOT NULL DEFAULT 1,
      auth_type TEXT NOT NULL DEFAULT 'none'
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
      created_by TEXT REFERENCES users(id),
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(project_id, name),
      UNIQUE(project_id, id)
    );
    CREATE TABLE agent_access_tokens (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      service_account_id TEXT NOT NULL REFERENCES service_accounts(id),
      name TEXT NOT NULL,
      token_prefix TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      token_salt TEXT NOT NULL,
      scopes TEXT NOT NULL DEFAULT '[]',
      max_concurrent_sessions INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      expires_at TEXT,
      last_used_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at TEXT
    );

    INSERT INTO users (id, username, password_hash)
      VALUES ('creator', 'creator', 'hash');
    INSERT INTO projects (id, owner_user_id, kind, name, slug) VALUES
      ('legacy-project', 'creator', 'personal', 'Legacy', 'legacy'),
      ('new-project', 'creator', 'personal', 'New', 'new');
    INSERT INTO service_accounts (
      id, project_id, name, created_by, is_active
    ) VALUES (
      'legacy-account', 'legacy-project', 'Legacy Agent', 'creator', 1
    );
    INSERT INTO agent_access_tokens (
      id, project_id, service_account_id, name, token_prefix,
      token_hash, token_salt, scopes, max_concurrent_sessions, is_active
    ) VALUES (
      'legacy-token', 'legacy-project', 'legacy-account', 'Legacy Token',
      '${TOKEN_PREFIX}', 'hash', 'salt', '["sessions:read"]', 2, 1
    );
  `);
  return sqlite;
}

describe("Agent Token 项目授权迁移", () => {
  const databases: Database.Database[] = [];

  afterEach(() => {
    for (const sqlite of databases.splice(0)) sqlite.close();
  });

  it("为旧 Agent 会话补充 tmux 运行模式并保持重复迁移幂等", () => {
    const sqlite = createLegacyDatabase();
    databases.push(sqlite);
    sqlite.exec(`
      CREATE TABLE persistent_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        project_host_id INTEGER NOT NULL,
        owner_user_id TEXT,
        service_account_id TEXT,
        state TEXT NOT NULL DEFAULT 'CREATING',
        title TEXT,
        runtime_id TEXT,
        tmux_name TEXT NOT NULL,
        columns INTEGER NOT NULL DEFAULT 80,
        rows INTEGER NOT NULL DEFAULT 24,
        pinned INTEGER NOT NULL DEFAULT 0,
        stream_generation INTEGER NOT NULL DEFAULT 1,
        last_sequence INTEGER NOT NULL DEFAULT 0,
        idempotency_key TEXT,
        last_attached_at TEXT,
        retain_until TEXT,
        failure_reason TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        closed_at TEXT
      );
      INSERT INTO persistent_sessions (
        id, project_id, project_host_id, owner_user_id, state, tmux_name
      ) VALUES (
        'legacy-session', 'legacy-project', 999, 'creator', 'RUNNING',
        'cloudssh-legacy-session'
      );
    `);

    expect(() => ensureControlPlaneSchema(sqlite)).not.toThrow();
    expect(() => ensureControlPlaneSchema(sqlite)).not.toThrow();

    expect(
      sqlite
        .prepare(
          `SELECT id, runtime_mode AS runtimeMode, state, tmux_name AS tmuxName
             FROM persistent_sessions WHERE id = 'legacy-session'`,
        )
        .get(),
    ).toEqual({
      id: "legacy-session",
      runtimeMode: "tmux",
      state: "RUNNING",
      tmuxName: "cloudssh-legacy-session",
    });
  });

  it("迁移缺少新字段的旧 Token，并立即撤销旧认证方式", async () => {
    const sqlite = createLegacyDatabase();
    databases.push(sqlite);

    expect(() => ensureControlPlaneSchema(sqlite)).not.toThrow();
    expect(() => ensureControlPlaneSchema(sqlite)).not.toThrow();

    const columns = sqlite
      .prepare("PRAGMA table_info(agent_access_tokens)")
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["access_mode", "created_by_user_id"]),
    );
    expect(
      sqlite
        .prepare(
          `SELECT access_mode AS accessMode,
                  created_by_user_id AS createdByUserId,
                  is_active AS isActive,
                  revoked_at AS revokedAt
             FROM agent_access_tokens WHERE id = 'legacy-token'`,
        )
        .get(),
    ).toMatchObject({
      accessMode: "selected",
      createdByUserId: "creator",
      isActive: 0,
      revokedAt: expect.any(String),
    });
    expect(
      sqlite
        .prepare(
          `SELECT token_id AS tokenId, project_id AS projectId,
                  service_account_id AS serviceAccountId
             FROM agent_token_projects ORDER BY project_id`,
        )
        .all(),
    ).toEqual([
      {
        tokenId: "legacy-token",
        projectId: "legacy-project",
        serviceAccountId: "legacy-account",
      },
    ]);

    const store = new SqliteAgentCredentialStore(
      sqlite,
      undefined,
      async () => ["legacy-project", "new-project"],
    );
    const records = await store.findActiveByPrefix(TOKEN_PREFIX);
    expect(records).toHaveLength(0);
  });

  it("旧 Token 即使曾配置 all 模式也不会在再次迁移后恢复", async () => {
    const sqlite = createLegacyDatabase();
    databases.push(sqlite);
    ensureControlPlaneSchema(sqlite);
    sqlite.exec(`
      UPDATE agent_access_tokens
         SET access_mode = 'all', created_by_user_id = 'creator'
       WHERE id = 'legacy-token';
      INSERT INTO ssh_data (
        id, user_id, name, ip, port, username, auth_type
      ) VALUES
        (1, 'creator', 'Legacy host', '10.0.0.1', 22, 'root', 'none'),
        (2, 'creator', 'New host', '10.0.0.2', 22, 'root', 'none');
      INSERT INTO project_hosts (id, project_id, host_id, added_by) VALUES
        (11, 'legacy-project', 1, 'creator'),
        (22, 'new-project', 2, 'creator');
    `);

    const store = new SqliteAgentCredentialStore(
      sqlite,
      undefined,
      async () => ["legacy-project", "new-project"],
    );
    expect(await store.findActiveByPrefix(TOKEN_PREFIX)).toEqual([]);

    sqlite
      .prepare(
        `UPDATE agent_access_tokens
            SET is_active = 1, revoked_at = NULL
          WHERE id = 'legacy-token'`,
      )
      .run();
    ensureControlPlaneSchema(sqlite);

    expect(await store.findActiveByPrefix(TOKEN_PREFIX)).toEqual([]);
    expect(
      sqlite
        .prepare(
          `SELECT is_active AS isActive, revoked_at AS revokedAt
             FROM agent_access_tokens WHERE id = 'legacy-token'`,
        )
        .get(),
    ).toMatchObject({ isActive: 0, revokedAt: expect.any(String) });
  });
});
