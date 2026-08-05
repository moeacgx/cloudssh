import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../../../database/db/schema.js";
import type { DatabaseContext } from "../../../database/repositories/database-context.js";
import {
  UserDataLifecycleRepository,
  UserMergeHasOwnedDataError,
  UserOwnsSharedResourcesError,
} from "../../../database/repositories/user-data-lifecycle-repository.js";

function createSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      is_oidc INTEGER NOT NULL DEFAULT 0,
      oidc_identifier TEXT,
      sso_provider_id INTEGER,
      client_id TEXT,
      client_secret TEXT,
      issuer_url TEXT,
      authorization_url TEXT,
      token_url TEXT,
      identifier_path TEXT,
      name_path TEXT,
      scopes TEXT DEFAULT 'openid email profile',
      totp_enabled INTEGER NOT NULL DEFAULT 0,
      totp_secret TEXT,
      totp_backup_codes TEXT
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE teams (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      kind TEXT NOT NULL
    );
    CREATE TABLE ssh_data (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE ssh_credentials (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE project_hosts (
      id INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      host_id INTEGER NOT NULL REFERENCES ssh_data(id) ON DELETE CASCADE
    );
    CREATE TABLE project_credentials (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE project_folders (
      id INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE service_accounts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE persistent_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      state TEXT NOT NULL
    );
    CREATE TABLE project_session_recordings (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES persistent_sessions(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      mode TEXT NOT NULL,
      storage_key TEXT
    );
    CREATE TABLE roles (id INTEGER PRIMARY KEY);
    CREATE TABLE user_roles (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, role_id)
    );
    CREATE TABLE team_members (
      id INTEGER PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(team_id, user_id)
    );
    CREATE TABLE project_members (
      id INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(project_id, user_id)
    );
    CREATE TABLE snippets (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE snippet_folders (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE vault_profiles (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE termix_identities (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE termix_identity_ca (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE alert_rules (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE notification_channels (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE homepage_items (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE dashboard_service_links (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE network_topology (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE c2s_tunnel_presets (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE host_access (
      id INTEGER PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE snippet_access (
      id INTEGER PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE shared_host_secrets (
      id INTEGER PRIMARY KEY,
      target_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE session_shares (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_user_id TEXT REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE vault_tokens (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE opkssh_tokens (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE dismissed_alerts (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
  `);
}

function insertUser(
  sqlite: Database.Database,
  input: {
    id: string;
    username?: string;
    isAdmin?: boolean;
    isOidc?: boolean;
    passwordHash?: string;
    oidcIdentifier?: string | null;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO users
         (id, username, password_hash, is_admin, is_oidc, oidc_identifier,
          client_id, client_secret, issuer_url, authorization_url, token_url,
          identifier_path, name_path, scopes, totp_enabled, totp_secret,
          totp_backup_codes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'openid', 1, 'secret', 'codes')`,
    )
    .run(
      input.id,
      input.username ?? input.id,
      input.passwordHash ?? "password-hash",
      input.isAdmin ? 1 : 0,
      input.isOidc ? 1 : 0,
      input.oidcIdentifier ?? null,
      input.isOidc ? "client" : null,
      input.isOidc ? "client-secret" : null,
      input.isOidc ? "https://issuer.example" : null,
      input.isOidc ? "https://issuer.example/auth" : null,
      input.isOidc ? "https://issuer.example/token" : null,
      input.isOidc ? "sub" : null,
      input.isOidc ? "name" : null,
    );
}

describe("UserDataLifecycleRepository", () => {
  let sqlite: Database.Database;
  let onWrite: ReturnType<typeof vi.fn>;
  let repository: UserDataLifecycleRepository;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    createSchema(sqlite);
    const context: DatabaseContext = {
      dialect: "sqlite",
      drizzle: drizzle(sqlite, { schema }),
      sqlite,
    };
    onWrite = vi.fn(async () => {});
    repository = new UserDataLifecycleRepository(context, onWrite);
  });

  afterEach(() => sqlite.close());

  it("原子删除用户、个人项目、会话和密钥设置", async () => {
    insertUser(sqlite, { id: "user-1", username: "alice" });
    sqlite
      .prepare(
        "INSERT INTO projects (id, owner_user_id, kind) VALUES ('personal-1', 'user-1', 'personal')",
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO sessions (id, user_id) VALUES ('session-1', 'user-1')",
      )
      .run();
    sqlite
      .prepare("INSERT INTO settings (key, value) VALUES (?, 'wrapped')")
      .run("user_dek_v3_user-1");
    sqlite
      .prepare("INSERT INTO settings (key, value) VALUES (?, 'code')")
      .run("reset_code_alice");

    await expect(repository.deleteUserAndRelatedData("user-1")).resolves.toBe(
      true,
    );

    expect(sqlite.prepare("SELECT COUNT(*) count FROM users").get()).toEqual({
      count: 0,
    });
    expect(sqlite.prepare("SELECT COUNT(*) count FROM projects").get()).toEqual(
      {
        count: 0,
      },
    );
    expect(sqlite.prepare("SELECT COUNT(*) count FROM sessions").get()).toEqual(
      {
        count: 0,
      },
    );
    expect(sqlite.prepare("SELECT COUNT(*) count FROM settings").get()).toEqual(
      {
        count: 0,
      },
    );
    expect(onWrite).toHaveBeenCalledTimes(1);
  });

  it("最终用户删除失败时回滚之前的个人项目和设置删除", async () => {
    insertUser(sqlite, { id: "user-1", username: "alice" });
    sqlite
      .prepare(
        "INSERT INTO projects (id, owner_user_id, kind) VALUES ('personal-1', 'user-1', 'personal')",
      )
      .run();
    sqlite
      .prepare("INSERT INTO settings (key, value) VALUES (?, 'wrapped')")
      .run("user_dek_v3_user-1");
    sqlite.exec(`
      CREATE TRIGGER reject_user_delete
      BEFORE DELETE ON users WHEN OLD.id = 'user-1'
      BEGIN SELECT RAISE(ABORT, 'forced delete failure'); END;
    `);

    await expect(repository.deleteUserAndRelatedData("user-1")).rejects.toThrow(
      "forced delete failure",
    );

    expect(sqlite.prepare("SELECT COUNT(*) count FROM users").get()).toEqual({
      count: 1,
    });
    expect(sqlite.prepare("SELECT COUNT(*) count FROM projects").get()).toEqual(
      {
        count: 1,
      },
    );
    expect(sqlite.prepare("SELECT COUNT(*) count FROM settings").get()).toEqual(
      {
        count: 1,
      },
    );
    expect(onWrite).not.toHaveBeenCalled();
  });

  it("用户仍拥有团队时拒绝删除且不修改任何数据", async () => {
    insertUser(sqlite, { id: "user-1" });
    sqlite
      .prepare(
        "INSERT INTO teams (id, owner_user_id) VALUES ('team-1', 'user-1')",
      )
      .run();
    sqlite
      .prepare("INSERT INTO settings (key, value) VALUES (?, 'wrapped')")
      .run("user_dek_v3_user-1");

    await expect(repository.deleteUserAndRelatedData("user-1")).rejects.toEqual(
      expect.objectContaining({
        code: "USER_OWNS_SHARED_RESOURCES",
        teamCount: 1,
      }),
    );
    await expect(
      repository.deleteUserAndRelatedData("user-1"),
    ).rejects.toBeInstanceOf(UserOwnsSharedResourcesError);

    expect(sqlite.prepare("SELECT COUNT(*) count FROM users").get()).toEqual({
      count: 1,
    });
    expect(sqlite.prepare("SELECT COUNT(*) count FROM settings").get()).toEqual(
      {
        count: 1,
      },
    );
    expect(onWrite).not.toHaveBeenCalled();
  });

  it("团队完整录像仍在保留时拒绝删除用户和录像索引", async () => {
    insertUser(sqlite, { id: "user-1" });
    insertUser(sqlite, { id: "team-owner" });
    sqlite.exec(`
      INSERT INTO teams (id, owner_user_id) VALUES ('team-1', 'team-owner');
      INSERT INTO projects (id, team_id, owner_user_id, kind)
      VALUES ('team-project', 'team-1', 'team-owner', 'team');
      INSERT INTO persistent_sessions (id, project_id, owner_user_id, state)
      VALUES ('closed-session', 'team-project', 'user-1', 'CLOSED');
      INSERT INTO project_session_recordings
        (id, session_id, project_id, mode, storage_key)
      VALUES (
        'recording-1', 'closed-session', 'team-project', 'full',
        'agent/recordings/recording.jsonl'
      );
    `);

    await expect(repository.deleteUserAndRelatedData("user-1")).rejects.toEqual(
      expect.objectContaining({
        code: "USER_OWNS_SHARED_RESOURCES",
        retainedTeamRecordingCount: 1,
      }),
    );

    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM project_session_recordings")
        .get(),
    ).toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM users").get()).toEqual(
      {
        count: 2,
      },
    );
    expect(onWrite).not.toHaveBeenCalled();
  });

  it("OIDC 合并原子迁移管理员标记、角色和项目成员关系", async () => {
    insertUser(sqlite, {
      id: "source",
      isAdmin: true,
      isOidc: true,
      oidcIdentifier: "subject-1",
    });
    insertUser(sqlite, { id: "target" });
    insertUser(sqlite, { id: "owner" });
    sqlite.prepare("INSERT INTO roles (id) VALUES (1)").run();
    sqlite
      .prepare("INSERT INTO user_roles (user_id, role_id) VALUES ('source', 1)")
      .run();
    sqlite
      .prepare(
        "INSERT INTO teams (id, owner_user_id) VALUES ('team-1', 'owner')",
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO team_members (team_id, user_id, role) VALUES ('team-1', 'source', 'team_admin')",
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO projects (id, team_id, owner_user_id, kind) VALUES ('project-1', 'team-1', 'owner', 'team')",
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO projects (id, owner_user_id, kind) VALUES ('personal-source', 'source', 'personal')",
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO project_members (project_id, user_id, role) VALUES ('project-1', 'source', 'operator')",
      )
      .run();

    await repository.mergeOidcUserIntoPasswordUser("source", "target");

    expect(sqlite.prepare("SELECT id FROM users ORDER BY id").all()).toEqual([
      { id: "owner" },
      { id: "target" },
    ]);
    expect(
      sqlite
        .prepare(
          "SELECT is_admin isAdmin, is_oidc isOidc, oidc_identifier oidcIdentifier FROM users WHERE id = 'target'",
        )
        .get(),
    ).toEqual({ isAdmin: 1, isOidc: 1, oidcIdentifier: "subject-1" });
    expect(
      sqlite.prepare("SELECT user_id userId FROM user_roles").all(),
    ).toEqual([{ userId: "target" }]);
    expect(
      sqlite.prepare("SELECT user_id userId, role FROM team_members").all(),
    ).toEqual([{ userId: "target", role: "team_admin" }]);
    expect(
      sqlite.prepare("SELECT user_id userId, role FROM project_members").all(),
    ).toEqual([{ userId: "target", role: "operator" }]);
    expect(onWrite).toHaveBeenCalledTimes(1);
  });

  it("OIDC 源账号有个人数据时拒绝合并", async () => {
    insertUser(sqlite, {
      id: "source",
      isOidc: true,
      oidcIdentifier: "subject-1",
    });
    insertUser(sqlite, { id: "target" });
    sqlite
      .prepare("INSERT INTO snippets (id, user_id) VALUES (1, 'source')")
      .run();

    await expect(
      repository.mergeOidcUserIntoPasswordUser("source", "target"),
    ).rejects.toBeInstanceOf(UserMergeHasOwnedDataError);
    expect(
      sqlite
        .prepare("SELECT is_oidc isOidc FROM users WHERE id = 'target'")
        .get(),
    ).toEqual({ isOidc: 0 });
  });

  it("OIDC 源账号仍拥有或收到终端分享时拒绝合并", async () => {
    insertUser(sqlite, {
      id: "source",
      isOidc: true,
      oidcIdentifier: "subject-1",
    });
    insertUser(sqlite, { id: "target" });
    insertUser(sqlite, { id: "share-owner" });
    sqlite
      .prepare(
        "INSERT INTO session_shares (id, owner_user_id, target_user_id) VALUES ('share-1', 'share-owner', 'source')",
      )
      .run();

    await expect(
      repository.mergeOidcUserIntoPasswordUser("source", "target"),
    ).rejects.toBeInstanceOf(UserMergeHasOwnedDataError);
    expect(
      sqlite.prepare("SELECT COUNT(*) count FROM session_shares").get(),
    ).toEqual({ count: 1 });
  });

  it("OIDC 源账号删除失败时回滚目标更新和成员迁移", async () => {
    insertUser(sqlite, {
      id: "source",
      isOidc: true,
      oidcIdentifier: "subject-1",
    });
    insertUser(sqlite, { id: "target" });
    sqlite.prepare("INSERT INTO roles (id) VALUES (1)").run();
    sqlite
      .prepare("INSERT INTO user_roles (user_id, role_id) VALUES ('source', 1)")
      .run();
    sqlite.exec(`
      CREATE TRIGGER reject_oidc_source_delete
      BEFORE DELETE ON users WHEN OLD.id = 'source'
      BEGIN SELECT RAISE(ABORT, 'forced merge failure'); END;
    `);

    await expect(
      repository.mergeOidcUserIntoPasswordUser("source", "target"),
    ).rejects.toThrow("forced merge failure");

    expect(
      sqlite
        .prepare("SELECT is_oidc isOidc FROM users WHERE id = 'target'")
        .get(),
    ).toEqual({ isOidc: 0 });
    expect(
      sqlite.prepare("SELECT user_id userId FROM user_roles").all(),
    ).toEqual([{ userId: "source" }]);
    expect(onWrite).not.toHaveBeenCalled();
  });

  it("保留数据的密码重置在令牌清理失败时回滚密码更新", async () => {
    insertUser(sqlite, { id: "user-1" });
    sqlite
      .prepare("INSERT INTO settings (key, value) VALUES (?, 'token')")
      .run("temp_reset_token_user-1");
    sqlite.exec(`
      CREATE TRIGGER reject_reset_token_delete
      BEFORE DELETE ON settings
      WHEN OLD.key = 'temp_reset_token_user-1'
      BEGIN SELECT RAISE(ABORT, 'forced token cleanup failure'); END;
    `);

    await expect(
      repository.resetPasswordPreservingData({
        userId: "user-1",
        username: "user-1",
        passwordHash: "new-password-hash",
      }),
    ).rejects.toThrow("forced token cleanup failure");

    expect(
      sqlite
        .prepare("SELECT password_hash passwordHash FROM users WHERE id = ?")
        .get("user-1"),
    ).toEqual({ passwordHash: "password-hash" });
    expect(
      sqlite
        .prepare("SELECT value FROM settings WHERE key = ?")
        .get("temp_reset_token_user-1"),
    ).toEqual({ value: "token" });
    expect(onWrite).not.toHaveBeenCalled();
  });

  it("密码重置擦除中途失败时回滚密码、数据和 DEK", async () => {
    insertUser(sqlite, { id: "user-1" });
    sqlite
      .prepare("INSERT INTO ssh_data (id, user_id) VALUES (1, 'user-1')")
      .run();
    sqlite
      .prepare("INSERT INTO ssh_credentials (id, user_id) VALUES (1, 'user-1')")
      .run();
    sqlite
      .prepare("INSERT INTO snippets (id, user_id) VALUES (1, 'user-1')")
      .run();
    sqlite
      .prepare("INSERT INTO settings (key, value) VALUES (?, 'old-wrapped')")
      .run("user_dek_v3_user-1");
    sqlite.exec(`
      CREATE TRIGGER reject_credential_delete
      BEFORE DELETE ON ssh_credentials
      BEGIN SELECT RAISE(ABORT, 'forced wipe failure'); END;
    `);

    await expect(
      repository.wipeEncryptedUserData({
        userId: "user-1",
        username: "user-1",
        passwordHash: "new-password-hash",
        wrappedDek: "new-wrapped",
      }),
    ).rejects.toThrow("forced wipe failure");

    expect(
      sqlite
        .prepare(
          "SELECT password_hash passwordHash, totp_enabled totpEnabled FROM users WHERE id = 'user-1'",
        )
        .get(),
    ).toEqual({ passwordHash: "password-hash", totpEnabled: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) count FROM ssh_data").get()).toEqual(
      {
        count: 1,
      },
    );
    expect(sqlite.prepare("SELECT COUNT(*) count FROM snippets").get()).toEqual(
      {
        count: 1,
      },
    );
    expect(
      sqlite
        .prepare("SELECT value FROM settings WHERE key = ?")
        .get("user_dek_v3_user-1"),
    ).toEqual({ value: "old-wrapped" });
    expect(onWrite).not.toHaveBeenCalled();
  });

  it("密码重置擦除成功后一次性提交密码、数据和 DEK", async () => {
    insertUser(sqlite, { id: "user-1" });
    sqlite
      .prepare("INSERT INTO ssh_data (id, user_id) VALUES (1, 'user-1')")
      .run();
    sqlite
      .prepare("INSERT INTO ssh_credentials (id, user_id) VALUES (1, 'user-1')")
      .run();
    sqlite
      .prepare("INSERT INTO snippets (id, user_id) VALUES (1, 'user-1')")
      .run();
    sqlite
      .prepare("INSERT INTO settings (key, value) VALUES (?, 'legacy')")
      .run("user_encrypted_dek_user-1");

    await repository.wipeEncryptedUserData({
      userId: "user-1",
      username: "user-1",
      passwordHash: "new-password-hash",
      wrappedDek: "new-wrapped",
    });

    expect(
      sqlite
        .prepare(
          "SELECT password_hash passwordHash, totp_enabled totpEnabled, totp_secret totpSecret FROM users WHERE id = 'user-1'",
        )
        .get(),
    ).toEqual({
      passwordHash: "new-password-hash",
      totpEnabled: 0,
      totpSecret: null,
    });
    expect(sqlite.prepare("SELECT COUNT(*) count FROM ssh_data").get()).toEqual(
      {
        count: 0,
      },
    );
    expect(sqlite.prepare("SELECT COUNT(*) count FROM snippets").get()).toEqual(
      {
        count: 0,
      },
    );
    expect(sqlite.prepare("SELECT key, value FROM settings").all()).toEqual([
      { key: "user_dek_v3_user-1", value: "new-wrapped" },
    ]);
    expect(onWrite).toHaveBeenCalledTimes(1);
  });
});
