import { afterEach, describe, expect, it, vi } from "vitest";
import { TestSqliteDatabase } from "./test-support.js";
import { CredentialRepository } from "../../../database/repositories/credential-repository.js";
import { HostRepository } from "../../../database/repositories/host-repository.js";
import { DataCrypto } from "../../../utils/data-crypto.js";

describe("HostRepository and CredentialRepository", () => {
  let adapter: TestSqliteDatabase | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (adapter) {
      await adapter.close();
      adapter = null;
    }
  });

  async function createRepositories(
    onCredentialWrite?: () => void,
    onHostWrite?: () => void,
  ): Promise<{
    credentials: CredentialRepository;
    hosts: HostRepository;
    sqlite: NonNullable<
      Awaited<ReturnType<TestSqliteDatabase["connect"]>>["sqlite"]
    >;
  }> {
    adapter = new TestSqliteDatabase();
    const context = await adapter.connect();
    context.sqlite?.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0,
        is_oidc INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE ssh_credentials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        folder TEXT,
        tags TEXT,
        auth_type TEXT NOT NULL,
        username TEXT,
        password TEXT,
        key TEXT,
        private_key TEXT,
        public_key TEXT,
        key_password TEXT,
        key_type TEXT,
        detected_key_type TEXT,
        cert_public_key TEXT,
        usage_count INTEGER NOT NULL DEFAULT 0,
        last_used TEXT,
        sync_id TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE ssh_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        connection_type TEXT NOT NULL DEFAULT 'ssh',
        name TEXT,
        ip TEXT NOT NULL,
        port INTEGER NOT NULL,
        username TEXT NOT NULL,
        folder TEXT,
        tags TEXT,
        pin INTEGER NOT NULL DEFAULT 0,
        auth_type TEXT NOT NULL,
        use_warpgate INTEGER NOT NULL DEFAULT 0,
        force_keyboard_interactive TEXT,
        password TEXT,
        key TEXT,
        key_password TEXT,
        key_type TEXT,
        sudo_password TEXT,
        autostart_password TEXT,
        autostart_key TEXT,
        autostart_key_password TEXT,
        credential_id INTEGER,
        override_credential_username INTEGER,
        vault_profile_id INTEGER,
        enable_terminal INTEGER NOT NULL DEFAULT 1,
        enable_session_logging INTEGER NOT NULL DEFAULT 1,
        allow_session_sharing INTEGER NOT NULL DEFAULT 1,
        enable_command_history INTEGER NOT NULL DEFAULT 1,
        enable_tunnel INTEGER NOT NULL DEFAULT 1,
        tunnel_connections TEXT,
        jump_hosts TEXT,
        enable_file_manager INTEGER NOT NULL DEFAULT 1,
        scp_legacy INTEGER NOT NULL DEFAULT 0,
        enable_docker INTEGER NOT NULL DEFAULT 0,
        enable_tmux_monitor INTEGER NOT NULL DEFAULT 0,
        show_terminal_in_sidebar INTEGER NOT NULL DEFAULT 1,
        show_file_manager_in_sidebar INTEGER NOT NULL DEFAULT 0,
        show_tunnel_in_sidebar INTEGER NOT NULL DEFAULT 0,
        show_docker_in_sidebar INTEGER NOT NULL DEFAULT 0,
        show_server_stats_in_sidebar INTEGER NOT NULL DEFAULT 0,
        default_path TEXT,
        stats_config TEXT,
        docker_config TEXT,
        enable_proxmox INTEGER NOT NULL DEFAULT 0,
        proxmox_config TEXT,
        terminal_config TEXT,
        quick_actions TEXT,
        notes TEXT,
        enable_ssh INTEGER NOT NULL DEFAULT 1,
        enable_rdp INTEGER NOT NULL DEFAULT 0,
        enable_vnc INTEGER NOT NULL DEFAULT 0,
        enable_telnet INTEGER NOT NULL DEFAULT 0,
        ssh_port INTEGER DEFAULT 22,
        rdp_port INTEGER DEFAULT 3389,
        vnc_port INTEGER DEFAULT 5900,
        telnet_port INTEGER DEFAULT 23,
        rdp_credential_id INTEGER,
        rdp_user TEXT,
        rdp_password TEXT,
        rdp_domain TEXT,
        rdp_security TEXT,
        rdp_ignore_cert INTEGER DEFAULT 0,
        vnc_credential_id INTEGER,
        vnc_password TEXT,
        vnc_user TEXT,
        telnet_user TEXT,
        telnet_password TEXT,
        telnet_credential_id INTEGER,
        rdp_auth_type TEXT,
        vnc_auth_type TEXT,
        telnet_auth_type TEXT,
        domain TEXT,
        security TEXT,
        ignore_cert INTEGER DEFAULT 0,
        guacamole_config TEXT,
        use_socks5 INTEGER,
        socks5_host TEXT,
        socks5_port INTEGER,
        socks5_username TEXT,
        socks5_password TEXT,
        socks5_proxy_chain TEXT,
        mac_address TEXT,
        wol_broadcast_address TEXT,
        port_knock_sequence TEXT,
        host_key_fingerprint TEXT,
        host_key_type TEXT,
        host_key_algorithm TEXT DEFAULT 'sha256',
        host_key_first_seen TEXT,
        host_key_last_verified TEXT,
        host_key_changed_count INTEGER DEFAULT 0,
        network_info_status TEXT,
        network_lookup_source TEXT,
        network_resolved_ip TEXT,
        network_country_code TEXT,
        network_country TEXT,
        network_region TEXT,
        network_city TEXT,
        network_isp TEXT,
        network_asn TEXT,
        network_info_updated_at TEXT,
        connection_origin TEXT,
        sync_id TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (credential_id) REFERENCES ssh_credentials(id) ON DELETE SET NULL
      );

      CREATE TABLE host_access (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        host_id INTEGER NOT NULL,
        user_id TEXT,
        role_id INTEGER,
        granted_by TEXT NOT NULL,
        permission_level TEXT NOT NULL DEFAULT 'view',
        expires_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_accessed_at TEXT,
        access_count INTEGER NOT NULL DEFAULT 0,
        override_credential_id INTEGER,
        FOREIGN KEY (host_id) REFERENCES ssh_data(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (override_credential_id) REFERENCES ssh_credentials(id) ON DELETE SET NULL
      );

      CREATE TABLE ssh_credential_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        credential_id INTEGER NOT NULL,
        host_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (credential_id) REFERENCES ssh_credentials(id) ON DELETE CASCADE,
        FOREIGN KEY (host_id) REFERENCES ssh_data(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        team_id TEXT,
        owner_user_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT
      );

      CREATE TABLE project_hosts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        host_id INTEGER NOT NULL,
        credential_id TEXT,
        alias TEXT,
        folder TEXT,
        tags TEXT,
        added_by TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (project_id, host_id),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (host_id) REFERENCES ssh_data(id) ON DELETE CASCADE
      );

      CREATE TABLE project_folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        path TEXT NOT NULL,
        color TEXT,
        icon TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (project_id, path),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      INSERT INTO users (id, username, password_hash) VALUES
        ('user-1', 'user', 'hash'),
        ('user-2', 'other', 'hash');
    `);

    return {
      credentials: new CredentialRepository(context, onCredentialWrite),
      hosts: new HostRepository(context, onHostWrite),
      sqlite: context.sqlite!,
    };
  }

  it("creates, finds, updates, lists, and deletes credentials", async () => {
    const repo = await createRepositories();

    const created = await repo.credentials.create({
      userId: "user-1",
      name: "primary",
      authType: "password",
      username: "root",
      password: "secret",
      folder: "prod",
    });

    expect(created.id).toBeGreaterThan(0);
    expect(await repo.credentials.listFolders("user-1")).toEqual(["prod"]);
    expect(
      (await repo.credentials.findByIdForUser("user-1", created.id))?.name,
    ).toBe("primary");
    expect((await repo.credentials.findById(created.id))?.name).toBe("primary");

    // Backdate updated_at so the update's CURRENT_TIMESTAMP bump is
    // deterministically observable regardless of clock resolution --
    // the sync engine's last-write-wins conflict resolution depends on
    // every mutating update actually advancing this column.
    repo.sqlite
      .prepare("UPDATE ssh_credentials SET updated_at = ? WHERE id = ?")
      .run("2000-01-01 00:00:00", created.id);

    const updated = await repo.credentials.updateForUser("user-1", created.id, {
      folder: "ops",
      tags: "linux,admin",
    });
    expect(updated?.folder).toBe("ops");
    expect(updated?.updatedAt).not.toBe("2000-01-01 00:00:00");

    expect(
      await repo.credentials.findByIdForUser("user-2", created.id),
    ).toBeNull();
    expect(await repo.credentials.deleteForUser("user-1", created.id)).toEqual({
      syncId: expect.any(String),
    });
    expect(
      await repo.credentials.findByIdForUser("user-1", created.id),
    ).toBeNull();
  });

  it("deletes user credentials through the cleanup boundary", async () => {
    const onWrite = vi.fn();
    const repo = await createRepositories(onWrite);

    await repo.credentials.create({
      userId: "user-1",
      name: "primary",
      authType: "password",
    });
    await repo.credentials.create({
      userId: "user-1",
      name: "secondary",
      authType: "key",
    });
    await repo.credentials.create({
      userId: "user-2",
      name: "other",
      authType: "password",
    });
    onWrite.mockClear();

    await expect(repo.credentials.deleteByUserId("user-1")).resolves.toBe(2);

    expect(await repo.credentials.listByUserId("user-1")).toEqual([]);
    expect((await repo.credentials.listByUserId("user-2")).length).toBe(1);
    expect(onWrite).toHaveBeenCalledTimes(1);
  });

  it("loads credentials through the decryption boundary", async () => {
    const repo = await createRepositories();
    vi.spyOn(DataCrypto, "getUserDataKey").mockReturnValue(
      Buffer.from("user-key"),
    );
    vi.spyOn(DataCrypto, "decryptRecords").mockImplementation(
      (_tableName, records) => records,
    );
    vi.spyOn(DataCrypto, "decryptRecord").mockImplementation(
      (_tableName, record) => record,
    );

    const created = await repo.credentials.create({
      userId: "user-1",
      name: "primary",
      authType: "password",
      username: "root",
      password: "secret",
      folder: "prod",
    });

    await expect(
      repo.credentials.listDecryptedByUserId("user-1"),
    ).resolves.toMatchObject([{ id: created.id, password: "secret" }]);
    await expect(
      repo.credentials.findDecryptedByIdForUser("user-1", created.id),
    ).resolves.toMatchObject({ id: created.id, password: "secret" });
    expect(DataCrypto.decryptRecords).toHaveBeenCalledWith(
      "ssh_credentials",
      expect.arrayContaining([expect.objectContaining({ id: created.id })]),
      "user-1",
      Buffer.from("user-key"),
    );
    expect(DataCrypto.decryptRecord).toHaveBeenCalledWith(
      "ssh_credentials",
      expect.objectContaining({ id: created.id }),
      "user-1",
      Buffer.from("user-key"),
    );
  });

  it("encrypts credential writes with the user key", async () => {
    const repo = await createRepositories();
    vi.spyOn(DataCrypto, "validateUserAccess").mockReturnValue(
      Buffer.from("user-key"),
    );
    vi.spyOn(DataCrypto, "getUserDataKey").mockReturnValue(
      Buffer.from("user-key"),
    );
    vi.spyOn(DataCrypto, "encryptRecord").mockImplementation(
      (_tableName, record) =>
        ({
          ...record,
          password: "user-encrypted-password",
        }) as typeof record,
    );
    vi.spyOn(DataCrypto, "decryptRecord").mockImplementation(
      (_tableName, record) => record,
    );

    const created = await repo.credentials.createEncryptedForUser("user-1", {
      userId: "user-1",
      name: "primary",
      authType: "password",
      username: "root",
      password: "secret",
    });

    const raw = repo.sqlite
      .prepare("SELECT password FROM ssh_credentials WHERE id = ?")
      .get(created.id) as { password: string };

    expect(raw.password).toBe("user-encrypted-password");

    repo.sqlite
      .prepare("UPDATE ssh_credentials SET updated_at = ? WHERE id = ?")
      .run("2000-01-01 00:00:00", created.id);

    await repo.credentials.updateEncryptedForUser("user-1", created.id, {
      password: "updated-secret",
    });

    const updatedRaw = repo.sqlite
      .prepare("SELECT password, updated_at FROM ssh_credentials WHERE id = ?")
      .get(created.id) as { password: string; updated_at: string };

    expect(updatedRaw.password).toBe("user-encrypted-password");
    expect(updatedRaw.updated_at).not.toBe("2000-01-01 00:00:00");
    expect(DataCrypto.encryptRecord).toHaveBeenCalledWith(
      "ssh_credentials",
      expect.objectContaining({ password: "updated-secret" }),
      "user-1",
      Buffer.from("user-key"),
    );
  });

  it("checks credential import identity", async () => {
    const repo = await createRepositories();

    await repo.credentials.create({
      userId: "user-1",
      name: "primary",
      authType: "password",
      username: "root",
    });

    await expect(
      repo.credentials.existsForImportIdentity("user-1", "primary", "root"),
    ).resolves.toBe(true);
    await expect(
      repo.credentials.existsForImportIdentity("user-1", "primary", "admin"),
    ).resolves.toBe(false);
  });

  it("renames credential folders through the write boundary", async () => {
    const onWrite = vi.fn();
    const repo = await createRepositories(onWrite);

    const primary = await repo.credentials.create({
      userId: "user-1",
      name: "primary",
      authType: "password",
      folder: "prod",
    });
    await repo.credentials.create({
      userId: "user-1",
      name: "secondary",
      authType: "key",
      folder: "prod",
    });
    await repo.credentials.create({
      userId: "user-2",
      name: "other",
      authType: "password",
      folder: "prod",
    });
    repo.sqlite
      .prepare("UPDATE ssh_credentials SET updated_at = ? WHERE id = ?")
      .run("2000-01-01 00:00:00", primary.id);
    onWrite.mockClear();

    await expect(
      repo.credentials.renameFolder("user-1", "prod", "ops"),
    ).resolves.toBe(2);

    expect(await repo.credentials.listFolders("user-1")).toEqual(["ops"]);
    expect(await repo.credentials.listFolders("user-2")).toEqual(["prod"]);
    expect(onWrite).toHaveBeenCalledTimes(1);

    const renamedRow = repo.sqlite
      .prepare("SELECT updated_at FROM ssh_credentials WHERE id = ?")
      .get(primary.id) as { updated_at: string };
    expect(renamedRow.updated_at).not.toBe("2000-01-01 00:00:00");
  });

  it("returns empty credential reads when user data is locked", async () => {
    const repo = await createRepositories();
    vi.spyOn(DataCrypto, "getUserDataKey").mockReturnValue(null);

    const created = await repo.credentials.create({
      userId: "user-1",
      name: "primary",
      authType: "password",
      username: "root",
      password: "secret",
    });

    await expect(
      repo.credentials.listDecryptedByUserId("user-1"),
    ).resolves.toEqual([]);
    await expect(
      repo.credentials.findDecryptedByIdForUser("user-1", created.id),
    ).resolves.toBeNull();
  });

  it("creates, finds, updates, lists, and deletes hosts", async () => {
    const repo = await createRepositories();

    const host = await repo.hosts.create({
      userId: "user-1",
      name: "web-1",
      ip: "10.0.0.10",
      port: 22,
      username: "root",
      authType: "password",
    });

    expect(host.id).toBeGreaterThan(0);
    expect((await repo.hosts.findById(host.id))?.name).toBe("web-1");
    expect(
      (await repo.hosts.listByUserId("user-1")).map((item) => item.id),
    ).toEqual([host.id]);

    repo.sqlite
      .prepare("UPDATE ssh_data SET updated_at = ? WHERE id = ?")
      .run("2000-01-01 00:00:00", host.id);

    const updated = await repo.hosts.updateForUser("user-1", host.id, {
      name: "web-1-renamed",
      folder: "prod",
    });
    expect(updated?.name).toBe("web-1-renamed");
    expect(updated?.updatedAt).not.toBe("2000-01-01 00:00:00");
    expect(await repo.hosts.findByIdForUser("user-2", host.id)).toBeNull();

    expect(await repo.hosts.deleteForUser("user-1", host.id)).toEqual({
      syncId: expect.any(String),
    });
    expect(await repo.hosts.findById(host.id)).toBeNull();
  });

  it("encrypts host writes through the repository boundary", async () => {
    const repo = await createRepositories();
    vi.spyOn(DataCrypto, "validateUserAccess").mockReturnValue(
      Buffer.from("user-key"),
    );
    vi.spyOn(DataCrypto, "encryptRecord").mockImplementation(
      (_tableName, record) =>
        ({
          ...record,
          password: "encrypted-host-password",
        }) as typeof record,
    );
    vi.spyOn(DataCrypto, "decryptRecord").mockImplementation(
      (_tableName, record) => record,
    );

    const created = await repo.hosts.createEncryptedForUser("user-1", {
      userId: "user-1",
      name: "web-1",
      ip: "10.0.0.10",
      port: 22,
      username: "root",
      authType: "password",
      password: "secret",
    });

    const raw = repo.sqlite
      .prepare("SELECT password FROM ssh_data WHERE id = ?")
      .get(created.id) as { password: string };

    expect(raw.password).toBe("encrypted-host-password");

    repo.sqlite
      .prepare("UPDATE ssh_data SET updated_at = ? WHERE id = ?")
      .run("2000-01-01 00:00:00", created.id);

    await repo.hosts.updateEncryptedForUser("user-1", created.id, {
      password: "updated-secret",
    });

    const updatedRaw = repo.sqlite
      .prepare("SELECT password, updated_at FROM ssh_data WHERE id = ?")
      .get(created.id) as { password: string; updated_at: string };

    expect(updatedRaw.password).toBe("encrypted-host-password");
    expect(updatedRaw.updated_at).not.toBe("2000-01-01 00:00:00");
    expect(DataCrypto.encryptRecord).toHaveBeenCalledWith(
      "ssh_data",
      expect.objectContaining({ password: "updated-secret" }),
      "user-1",
      Buffer.from("user-key"),
    );
  });

  it("creates an administrator-managed host and personal project link atomically", async () => {
    const onWrite = vi.fn();
    const repo = await createRepositories(undefined, onWrite);
    vi.spyOn(DataCrypto, "validateUserAccess").mockReturnValue(
      Buffer.from("user-key"),
    );
    vi.spyOn(DataCrypto, "encryptRecord").mockImplementation(
      (_tableName, record) => record,
    );
    vi.spyOn(DataCrypto, "decryptRecord").mockImplementation(
      (_tableName, record) => record,
    );
    repo.sqlite
      .prepare(
        `INSERT INTO projects
           (id, owner_user_id, kind, name, slug)
         VALUES ('personal-1', 'user-1', 'personal', 'Personal', 'personal')`,
      )
      .run();

    const created = await repo.hosts.createEncryptedForUserWithPersonalProject(
      "user-1",
      {
        userId: "user-1",
        name: "web-1",
        ip: "10.0.0.10",
        port: 22,
        username: "root",
        authType: "password",
        password: "secret",
      },
      {
        alias: null,
        folder: "Production / Web",
        addedBy: "admin-1",
      },
    );

    expect(created.host).toMatchObject({
      userId: "user-1",
      name: "web-1",
    });
    expect(
      repo.sqlite
        .prepare(
          `SELECT project_id AS projectId, host_id AS hostId, folder, added_by AS addedBy
             FROM project_hosts WHERE id = ?`,
        )
        .get(created.projectHostId),
    ).toEqual({
      projectId: "personal-1",
      hostId: created.host.id,
      folder: "Production / Web",
      addedBy: "admin-1",
    });
    expect(
      repo.sqlite
        .prepare("SELECT path FROM project_folders WHERE project_id = ?")
        .all("personal-1"),
    ).toEqual([{ path: "Production / Web" }]);
    expect(onWrite).toHaveBeenCalledTimes(1);
  });

  it("creates a password host in the selected team project without losing its secret", async () => {
    const repo = await createRepositories();
    vi.spyOn(DataCrypto, "validateUserAccess").mockReturnValue(
      Buffer.from("user-key"),
    );
    vi.spyOn(DataCrypto, "encryptRecord").mockImplementation(
      (_tableName, record) => record,
    );
    vi.spyOn(DataCrypto, "decryptRecord").mockImplementation(
      (_tableName, record) => record,
    );
    repo.sqlite
      .prepare(
        `INSERT INTO projects
           (id, owner_user_id, kind, name, slug)
         VALUES ('team-project-1', 'user-1', 'team', 'Team project', 'team-project')`,
      )
      .run();

    const created = await repo.hosts.createEncryptedForUserWithProject(
      "user-1",
      {
        userId: "user-1",
        name: "team-password-host",
        ip: "192.0.2.40",
        port: 22,
        username: "root",
        authType: "password",
        password: "stored-secret",
      },
      {
        projectId: "team-project-1",
        alias: null,
        folder: "Production",
        addedBy: "user-1",
      },
    );

    expect(created.host.password).toBe("stored-secret");
    expect(
      repo.sqlite
        .prepare(
          "SELECT project_id AS projectId, host_id AS hostId FROM project_hosts WHERE id = ?",
        )
        .get(created.projectHostId),
    ).toEqual({
      projectId: "team-project-1",
      hostId: created.host.id,
    });
  });

  it("rolls back administrator host creation when the personal link fails", async () => {
    const onWrite = vi.fn();
    const repo = await createRepositories(undefined, onWrite);
    vi.spyOn(DataCrypto, "validateUserAccess").mockReturnValue(
      Buffer.from("user-key"),
    );
    vi.spyOn(DataCrypto, "encryptRecord").mockImplementation(
      (_tableName, record) => record,
    );
    repo.sqlite.exec(`
      INSERT INTO projects
        (id, owner_user_id, kind, name, slug)
      VALUES ('personal-1', 'user-1', 'personal', 'Personal', 'personal');
      CREATE TRIGGER reject_project_host_insert
      BEFORE INSERT ON project_hosts
      BEGIN
        SELECT RAISE(ABORT, 'link write rejected');
      END;
    `);

    await expect(
      repo.hosts.createEncryptedForUserWithPersonalProject(
        "user-1",
        {
          userId: "user-1",
          name: "must-not-exist",
          ip: "10.0.0.11",
          port: 22,
          username: "root",
          authType: "password",
        },
        { alias: null, folder: null, addedBy: "admin-1" },
      ),
    ).rejects.toThrow("link write rejected");

    expect(
      repo.sqlite
        .prepare("SELECT id FROM ssh_data WHERE name = 'must-not-exist'")
        .get(),
    ).toBeUndefined();
    expect(onWrite).not.toHaveBeenCalled();
  });

  it("updates a shared host and personal project metadata atomically", async () => {
    const onWrite = vi.fn();
    const repo = await createRepositories(undefined, onWrite);
    vi.spyOn(DataCrypto, "validateUserAccess").mockReturnValue(
      Buffer.from("user-key"),
    );
    vi.spyOn(DataCrypto, "encryptRecord").mockImplementation(
      (_tableName, record) => record,
    );
    vi.spyOn(DataCrypto, "decryptRecord").mockImplementation(
      (_tableName, record) => record,
    );

    const host = await repo.hosts.create({
      userId: "user-2",
      name: "old-name",
      ip: "10.0.0.10",
      port: 22,
      username: "root",
      authType: "password",
    });
    repo.sqlite
      .prepare(
        `INSERT INTO projects
           (id, owner_user_id, kind, name, slug)
         VALUES ('personal-1', 'user-1', 'personal', 'Personal', 'personal')`,
      )
      .run();
    const projectHostId = Number(
      repo.sqlite
        .prepare(
          `INSERT INTO project_hosts (project_id, host_id, added_by)
           VALUES ('personal-1', ?, 'user-1')`,
        )
        .run(host.id).lastInsertRowid,
    );
    onWrite.mockClear();

    await repo.hosts.updateEncryptedForUserWithPersonalProjectMetadata(
      "user-2",
      "user-1",
      host.id,
      { name: "new-name", folder: "Production" },
      {
        projectHostId,
        alias: "Personal alias",
        folder: "Production / Web",
        tags: "personal-tag",
      },
    );

    expect(
      repo.sqlite
        .prepare("SELECT name, folder FROM ssh_data WHERE id = ?")
        .get(host.id),
    ).toEqual({ name: "new-name", folder: "Production" });
    expect(
      repo.sqlite
        .prepare("SELECT alias, folder, tags FROM project_hosts WHERE id = ?")
        .get(projectHostId),
    ).toEqual({
      alias: "Personal alias",
      folder: "Production / Web",
      tags: "personal-tag",
    });
    expect(
      repo.sqlite
        .prepare(
          "SELECT path FROM project_folders WHERE project_id = 'personal-1'",
        )
        .all(),
    ).toEqual([{ path: "Production / Web" }]);
    expect(onWrite).toHaveBeenCalledTimes(1);
  });

  it("rolls back the host update when personal project metadata cannot be saved", async () => {
    const onWrite = vi.fn();
    const repo = await createRepositories(undefined, onWrite);
    vi.spyOn(DataCrypto, "validateUserAccess").mockReturnValue(
      Buffer.from("user-key"),
    );
    vi.spyOn(DataCrypto, "encryptRecord").mockImplementation(
      (_tableName, record) => record,
    );

    const host = await repo.hosts.create({
      userId: "user-1",
      name: "stable-name",
      ip: "10.0.0.10",
      port: 22,
      username: "root",
      authType: "password",
    });
    repo.sqlite.exec(`
      INSERT INTO projects
        (id, owner_user_id, kind, name, slug)
      VALUES ('personal-1', 'user-1', 'personal', 'Personal', 'personal');
      INSERT INTO project_hosts (project_id, host_id, added_by)
      VALUES ('personal-1', ${host.id}, 'user-1');
      CREATE TRIGGER reject_project_host_update
      BEFORE UPDATE ON project_hosts
      BEGIN
        SELECT RAISE(ABORT, 'metadata write rejected');
      END;
    `);
    const projectHost = repo.sqlite
      .prepare("SELECT id FROM project_hosts WHERE host_id = ?")
      .get(host.id) as { id: number };
    onWrite.mockClear();

    await expect(
      repo.hosts.updateEncryptedForUserWithPersonalProjectMetadata(
        "user-1",
        "user-1",
        host.id,
        { name: "must-not-stick" },
        { projectHostId: projectHost.id, alias: "Alias", folder: null },
      ),
    ).rejects.toThrow("metadata write rejected");

    expect(
      repo.sqlite
        .prepare("SELECT name FROM ssh_data WHERE id = ?")
        .get(host.id),
    ).toEqual({ name: "stable-name" });
    expect(onWrite).not.toHaveBeenCalled();
  });

  it("updates a team project host and its project metadata atomically", async () => {
    const onWrite = vi.fn();
    const repo = await createRepositories(undefined, onWrite);
    vi.spyOn(DataCrypto, "validateUserAccess").mockReturnValue(
      Buffer.from("user-key"),
    );
    vi.spyOn(DataCrypto, "encryptRecord").mockImplementation(
      (_tableName, record) => record,
    );
    vi.spyOn(DataCrypto, "decryptRecord").mockImplementation(
      (_tableName, record) => record,
    );

    const host = await repo.hosts.create({
      userId: "user-1",
      name: "old-team-name",
      ip: "10.0.0.20",
      port: 22,
      username: "root",
      authType: "password",
    });
    repo.sqlite.exec(`
      INSERT INTO projects
        (id, team_id, owner_user_id, kind, name, slug)
      VALUES ('team-project-1', 'team-1', 'user-1', 'team', 'Project', 'project');
    `);
    const projectHostId = Number(
      repo.sqlite
        .prepare(
          `INSERT INTO project_hosts (project_id, host_id, added_by)
           VALUES ('team-project-1', ?, 'user-1')`,
        )
        .run(host.id).lastInsertRowid,
    );
    onWrite.mockClear();

    await repo.hosts.updateEncryptedForUserWithProjectMetadata(
      "user-1",
      host.id,
      { name: "stable-global-name", folder: "global-folder" },
      {
        projectId: "team-project-1",
        projectHostId,
        alias: "团队入口",
        folder: "生产 / Web",
        tags: "team-tag",
      },
    );

    expect(
      repo.sqlite
        .prepare("SELECT name, folder FROM ssh_data WHERE id = ?")
        .get(host.id),
    ).toEqual({ name: "stable-global-name", folder: "global-folder" });
    expect(
      repo.sqlite
        .prepare("SELECT alias, folder, tags FROM project_hosts WHERE id = ?")
        .get(projectHostId),
    ).toEqual({ alias: "团队入口", folder: "生产 / Web", tags: "team-tag" });
    expect(
      repo.sqlite
        .prepare(
          "SELECT path FROM project_folders WHERE project_id = 'team-project-1'",
        )
        .all(),
    ).toEqual([{ path: "生产 / Web" }]);
    expect(onWrite).toHaveBeenCalledTimes(1);
  });

  it("rolls back a team host update when project metadata cannot be saved", async () => {
    const onWrite = vi.fn();
    const repo = await createRepositories(undefined, onWrite);
    vi.spyOn(DataCrypto, "validateUserAccess").mockReturnValue(
      Buffer.from("user-key"),
    );
    vi.spyOn(DataCrypto, "encryptRecord").mockImplementation(
      (_tableName, record) => record,
    );

    const host = await repo.hosts.create({
      userId: "user-1",
      name: "stable-team-name",
      ip: "10.0.0.21",
      port: 22,
      username: "root",
      authType: "password",
    });
    repo.sqlite.exec(`
      INSERT INTO projects
        (id, team_id, owner_user_id, kind, name, slug)
      VALUES ('team-project-2', 'team-2', 'user-1', 'team', 'Project 2', 'project-2');
      INSERT INTO project_hosts (project_id, host_id, added_by)
      VALUES ('team-project-2', ${host.id}, 'user-1');
      CREATE TRIGGER reject_team_project_host_update
      BEFORE UPDATE ON project_hosts
      BEGIN
        SELECT RAISE(ABORT, 'team metadata write rejected');
      END;
    `);
    const projectHost = repo.sqlite
      .prepare("SELECT id FROM project_hosts WHERE host_id = ?")
      .get(host.id) as { id: number };
    onWrite.mockClear();

    await expect(
      repo.hosts.updateEncryptedForUserWithProjectMetadata(
        "user-1",
        host.id,
        { name: "must-not-stick" },
        {
          projectId: "team-project-2",
          projectHostId: projectHost.id,
          alias: "Alias",
          folder: null,
        },
      ),
    ).rejects.toThrow("team metadata write rejected");

    expect(
      repo.sqlite
        .prepare("SELECT name FROM ssh_data WHERE id = ?")
        .get(host.id),
    ).toEqual({ name: "stable-team-name" });
    expect(onWrite).not.toHaveBeenCalled();
  });

  it("loads hosts through the decryption boundary", async () => {
    const repo = await createRepositories();
    vi.spyOn(DataCrypto, "getUserDataKey").mockReturnValue(
      Buffer.from("user-key"),
    );
    vi.spyOn(DataCrypto, "decryptRecords").mockImplementation(
      (_tableName, records) => records,
    );

    const host = await repo.hosts.create({
      userId: "user-1",
      name: "web-1",
      ip: "10.0.0.10",
      port: 22,
      username: "root",
      authType: "password",
      password: "secret",
    });

    await expect(
      repo.hosts.listDecryptedByUserId("user-1"),
    ).resolves.toMatchObject([{ id: host.id, password: "secret" }]);
    expect(DataCrypto.decryptRecords).toHaveBeenCalledWith(
      "ssh_data",
      expect.arrayContaining([expect.objectContaining({ id: host.id })]),
      "user-1",
      Buffer.from("user-key"),
    );
  });

  it("checks host import identity", async () => {
    const repo = await createRepositories();

    await repo.hosts.create({
      userId: "user-1",
      name: "web-1",
      ip: "10.0.0.10",
      port: 22,
      username: "root",
      authType: "password",
    });

    await expect(
      repo.hosts.existsForImportIdentity("user-1", "10.0.0.10", 22, "root"),
    ).resolves.toBe(true);
    await expect(
      repo.hosts.existsForImportIdentity("user-1", "10.0.0.10", 2222, "root"),
    ).resolves.toBe(false);
  });

  it("deletes user hosts through the cleanup boundary", async () => {
    const onWrite = vi.fn();
    const repo = await createRepositories(undefined, onWrite);

    await repo.hosts.create({
      userId: "user-1",
      name: "web-1",
      ip: "10.0.0.10",
      port: 22,
      username: "root",
      authType: "password",
    });
    await repo.hosts.create({
      userId: "user-1",
      name: "web-2",
      ip: "10.0.0.11",
      port: 22,
      username: "root",
      authType: "password",
    });
    await repo.hosts.create({
      userId: "user-2",
      name: "other",
      ip: "10.0.0.12",
      port: 22,
      username: "root",
      authType: "password",
    });
    onWrite.mockClear();

    await expect(repo.hosts.deleteByUserId("user-1")).resolves.toBe(2);

    expect(await repo.hosts.listByUserId("user-1")).toEqual([]);
    expect((await repo.hosts.listByUserId("user-2")).length).toBe(1);
    expect(onWrite).toHaveBeenCalledTimes(1);
  });

  it("lists bulk update state and updates multiple owned hosts", async () => {
    const onWrite = vi.fn();
    const repo = await createRepositories(undefined, onWrite);

    const first = await repo.hosts.create({
      userId: "user-1",
      name: "web-1",
      ip: "10.0.0.10",
      port: 22,
      username: "root",
      authType: "password",
      statsConfig: JSON.stringify({ cpu: true }),
    });
    const second = await repo.hosts.create({
      userId: "user-1",
      name: "web-2",
      ip: "10.0.0.11",
      port: 22,
      username: "root",
      authType: "password",
    });
    const other = await repo.hosts.create({
      userId: "user-2",
      name: "other",
      ip: "10.0.0.12",
      port: 22,
      username: "root",
      authType: "password",
    });
    repo.sqlite
      .prepare("UPDATE ssh_data SET updated_at = ? WHERE id IN (?, ?)")
      .run("2000-01-01 00:00:00", first.id, second.id);
    onWrite.mockClear();

    const states = await repo.hosts.listBulkUpdateState("user-1", [
      first.id,
      second.id,
      other.id,
    ]);
    expect(states.map((state) => state.id)).toEqual([first.id, second.id]);

    await expect(
      repo.hosts.updateManyForUser("user-1", [first.id, second.id, other.id], {
        folder: "ops",
      }),
    ).resolves.toBe(2);
    expect((await repo.hosts.findById(first.id))?.folder).toBe("ops");
    expect((await repo.hosts.findById(other.id))?.folder).toBeNull();
    expect(onWrite).toHaveBeenCalledTimes(1);
    expect((await repo.hosts.findById(first.id))?.updatedAt).not.toBe(
      "2000-01-01 00:00:00",
    );
    expect((await repo.hosts.findById(second.id))?.updatedAt).not.toBe(
      "2000-01-01 00:00:00",
    );
  });

  it("records credential usage and increments usage counters", async () => {
    const repo = await createRepositories();
    const credential = await repo.credentials.create({
      userId: "user-1",
      name: "primary",
      authType: "password",
    });
    const host = await repo.hosts.create({
      userId: "user-1",
      name: "web-1",
      ip: "10.0.0.10",
      port: 22,
      username: "root",
      authType: "credential",
      credentialId: credential.id,
    });

    await repo.credentials.recordUsage(
      "user-1",
      credential.id,
      host.id,
      "2026-06-26T00:00:00.000Z",
    );

    const updated = await repo.credentials.findByIdForUser(
      "user-1",
      credential.id,
    );
    expect(updated?.usageCount).toBe(1);
    expect(updated?.lastUsed).toBe("2026-06-26T00:00:00.000Z");
  });

  it("cleans host access before deleting a host", async () => {
    const repo = await createRepositories();
    const host = await repo.hosts.create({
      userId: "user-1",
      name: "shared-host",
      ip: "10.0.0.20",
      port: 22,
      username: "root",
      authType: "password",
    });

    repo.sqlite
      .prepare(
        "INSERT INTO host_access (host_id, user_id, granted_by) VALUES (?, ?, ?)",
      )
      .run(host.id, "user-2", "user-1");

    expect(await repo.hosts.deleteAccessForHost(host.id)).toBe(1);
    expect(await repo.hosts.deleteForUser("user-1", host.id)).toEqual({
      syncId: expect.any(String),
    });
  });
});
