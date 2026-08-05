import type Database from "better-sqlite3";

/**
 * 为新旧数据库幂等创建控制面结构。
 * 此处只保存令牌摘要、租约摘要和录像索引，不保存任何 SSH 明文凭据。
 */
export function ensureControlPlaneSchema(sqlite: Database.Database): void {
  sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_teams_slug ON teams(slug);
      CREATE INDEX IF NOT EXISTS idx_teams_owner ON teams(owner_user_id);

      CREATE TABLE IF NOT EXISTS team_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('team_admin', 'project_admin', 'operator', 'viewer')),
        added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_team_members_team_user
        ON team_members(team_id, user_id);
      CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK (kind IN ('personal', 'team')),
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK (
          (kind = 'personal' AND team_id IS NULL) OR
          (kind = 'team' AND team_id IS NOT NULL)
        )
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_personal_slug
        ON projects(owner_user_id, slug) WHERE kind = 'personal';
      CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_team_slug
        ON projects(team_id, slug) WHERE kind = 'team';
      CREATE INDEX IF NOT EXISTS idx_projects_team ON projects(team_id);
      CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_user_id);

      CREATE TABLE IF NOT EXISTS project_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('project_admin', 'operator', 'viewer')),
        added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_project_members_project_user
        ON project_members(project_id, user_id);
      CREATE INDEX IF NOT EXISTS idx_project_members_user
        ON project_members(user_id);

      CREATE TABLE IF NOT EXISTS roles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        description TEXT,
        is_system INTEGER NOT NULL DEFAULT 0,
        permissions TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS user_roles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, role_id)
      );
      CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role_id);

      CREATE TABLE IF NOT EXISTS project_role_grants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        project_role TEXT NOT NULL CHECK (project_role IN ('project_admin', 'operator', 'viewer')),
        added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_project_role_grants_project_role
        ON project_role_grants(project_id, role_id);
      CREATE INDEX IF NOT EXISTS idx_project_role_grants_role
        ON project_role_grants(role_id);
      CREATE INDEX IF NOT EXISTS idx_project_role_grants_project
        ON project_role_grants(project_id);

      CREATE TABLE IF NOT EXISTS project_credentials (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        username TEXT NOT NULL,
        auth_type TEXT NOT NULL CHECK (auth_type IN ('password', 'key', 'none')),
        encrypted_secret TEXT NOT NULL,
        key_type TEXT,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_project_credentials_project_name
        ON project_credentials(project_id, name);
      CREATE INDEX IF NOT EXISTS idx_project_credentials_project
        ON project_credentials(project_id);

      CREATE TABLE IF NOT EXISTS project_hosts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        host_id INTEGER NOT NULL REFERENCES ssh_data(id) ON DELETE CASCADE,
        credential_id TEXT REFERENCES project_credentials(id) ON DELETE SET NULL,
        alias TEXT,
        folder TEXT,
        added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_project_hosts_project_host
        ON project_hosts(project_id, host_id);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_project_hosts_project_id
        ON project_hosts(project_id, id);
      CREATE INDEX IF NOT EXISTS idx_project_hosts_host ON project_hosts(host_id);

      CREATE TABLE IF NOT EXISTS project_folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        color TEXT,
        icon TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_project_folders_project_path
        ON project_folders(project_id, path);
      CREATE INDEX IF NOT EXISTS idx_project_folders_project
        ON project_folders(project_id);

      CREATE TABLE IF NOT EXISTS service_accounts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_service_accounts_project_name
        ON service_accounts(project_id, name);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_service_accounts_project_id
        ON service_accounts(project_id, id);
      CREATE INDEX IF NOT EXISTS idx_service_accounts_project_active
        ON service_accounts(project_id, is_active);

      CREATE TABLE IF NOT EXISTS agent_access_tokens (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        service_account_id TEXT NOT NULL REFERENCES service_accounts(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        token_prefix TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        token_salt TEXT NOT NULL,
        scopes TEXT NOT NULL DEFAULT '[]',
        max_concurrent_sessions INTEGER NOT NULL DEFAULT 1
          CHECK (max_concurrent_sessions BETWEEN 1 AND 100),
        is_active INTEGER NOT NULL DEFAULT 1,
        expires_at TEXT,
        last_used_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        revoked_at TEXT,
        FOREIGN KEY (project_id, service_account_id)
          REFERENCES service_accounts(project_id, id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_access_tokens_hash
        ON agent_access_tokens(token_hash);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_access_tokens_project_id
        ON agent_access_tokens(project_id, id);
      CREATE INDEX IF NOT EXISTS idx_agent_access_tokens_prefix
        ON agent_access_tokens(token_prefix);
      CREATE INDEX IF NOT EXISTS idx_agent_access_tokens_account_active
        ON agent_access_tokens(service_account_id, is_active);

      CREATE TABLE IF NOT EXISTS agent_token_projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_id TEXT NOT NULL REFERENCES agent_access_tokens(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        service_account_id TEXT REFERENCES service_accounts(id) ON DELETE CASCADE,
        granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_token_projects
        ON agent_token_projects(token_id, project_id);
      CREATE INDEX IF NOT EXISTS idx_agent_token_projects_project
        ON agent_token_projects(project_id, token_id);

      CREATE TABLE IF NOT EXISTS agent_devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        public_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'revoked')),
        access_mode TEXT NOT NULL DEFAULT 'selected'
          CHECK (access_mode IN ('all', 'selected')),
        scopes TEXT NOT NULL DEFAULT '[]',
        max_concurrent_sessions INTEGER NOT NULL DEFAULT 1
          CHECK (max_concurrent_sessions BETWEEN 1 AND 100),
        approved_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        expires_at TEXT,
        last_used_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        approved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_devices_status
        ON agent_devices(status, expires_at);

      CREATE TABLE IF NOT EXISTS agent_device_projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL REFERENCES agent_devices(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        service_account_id TEXT NOT NULL REFERENCES service_accounts(id) ON DELETE CASCADE,
        granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_device_projects
        ON agent_device_projects(device_id, project_id);
      CREATE INDEX IF NOT EXISTS idx_agent_device_projects_project
        ON agent_device_projects(project_id, device_id);

      CREATE TABLE IF NOT EXISTS agent_device_codes (
        request_id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        device_name TEXT NOT NULL,
        public_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'approved', 'denied')),
        device_id TEXT REFERENCES agent_devices(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_device_codes_status_expiry
        ON agent_device_codes(status, expires_at);

      CREATE TABLE IF NOT EXISTS agent_request_nonces (
        device_id TEXT NOT NULL REFERENCES agent_devices(id) ON DELETE CASCADE,
        nonce TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (device_id, nonce)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_request_nonces_expiry
        ON agent_request_nonces(expires_at);

      CREATE TABLE IF NOT EXISTS agent_provisioning_idempotency (
        principal_id TEXT NOT NULL,
        operation TEXT NOT NULL
          CHECK (operation IN ('server', 'quick-connection')),
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        resource_sync_id TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (principal_id, operation, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_provisioning_idempotency_expiry
        ON agent_provisioning_idempotency(created_at);
      CREATE INDEX IF NOT EXISTS idx_agent_provisioning_idempotency_resource
        ON agent_provisioning_idempotency(resource_sync_id);

      CREATE TABLE IF NOT EXISTS agent_quick_connections (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES agent_devices(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        project_host_id INTEGER NOT NULL UNIQUE
          REFERENCES project_hosts(id) ON DELETE CASCADE,
        host_id INTEGER NOT NULL UNIQUE REFERENCES ssh_data(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (project_id, project_host_id)
          REFERENCES project_hosts(project_id, id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_agent_quick_connections_expiry
        ON agent_quick_connections(expires_at);
      CREATE INDEX IF NOT EXISTS idx_agent_quick_connections_device
        ON agent_quick_connections(device_id, project_id);

      CREATE TABLE IF NOT EXISTS agent_token_project_hosts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        token_id TEXT NOT NULL REFERENCES agent_access_tokens(id) ON DELETE CASCADE,
        project_host_id INTEGER NOT NULL REFERENCES project_hosts(id) ON DELETE CASCADE,
        FOREIGN KEY (project_id, token_id)
          REFERENCES agent_access_tokens(project_id, id) ON DELETE CASCADE,
        FOREIGN KEY (project_id, project_host_id)
          REFERENCES project_hosts(project_id, id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_token_project_hosts
        ON agent_token_project_hosts(token_id, project_host_id);
      CREATE INDEX IF NOT EXISTS idx_agent_token_project_hosts_host
        ON agent_token_project_hosts(project_host_id);

      CREATE TABLE IF NOT EXISTS persistent_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        project_host_id INTEGER NOT NULL REFERENCES project_hosts(id) ON DELETE RESTRICT,
        owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        service_account_id TEXT REFERENCES service_accounts(id) ON DELETE SET NULL,
        state TEXT NOT NULL DEFAULT 'CREATING'
          CHECK (state IN ('CREATING', 'RUNNING', 'RECOVERING', 'CLOSING', 'CLOSED', 'FAILED')),
        title TEXT,
        runtime_id TEXT,
        runtime_mode TEXT NOT NULL DEFAULT 'tmux'
          CHECK (runtime_mode IN ('platform', 'tmux')),
        tmux_name TEXT NOT NULL,
        columns INTEGER NOT NULL DEFAULT 80 CHECK (columns BETWEEN 1 AND 1000),
        rows INTEGER NOT NULL DEFAULT 24 CHECK (rows BETWEEN 1 AND 1000),
        pinned INTEGER NOT NULL DEFAULT 0,
        stream_generation INTEGER NOT NULL DEFAULT 1 CHECK (stream_generation >= 1),
        last_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
        idempotency_key TEXT,
        last_attached_at TEXT,
        retain_until TEXT,
        failure_reason TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        closed_at TEXT,
        CHECK (
          (owner_user_id IS NOT NULL AND service_account_id IS NULL) OR
          (owner_user_id IS NULL AND service_account_id IS NOT NULL)
        ),
        FOREIGN KEY (project_id, project_host_id)
          REFERENCES project_hosts(project_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (project_id, service_account_id)
          REFERENCES service_accounts(project_id, id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_persistent_sessions_tmux_name
        ON persistent_sessions(tmux_name);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_persistent_sessions_project_id
        ON persistent_sessions(project_id, id);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_persistent_sessions_idempotency
        ON persistent_sessions(project_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_persistent_sessions_project_state
        ON persistent_sessions(project_id, state);
      CREATE INDEX IF NOT EXISTS idx_persistent_sessions_host_state
        ON persistent_sessions(project_host_id, state);
      CREATE INDEX IF NOT EXISTS idx_persistent_sessions_retention
        ON persistent_sessions(pinned, retain_until);

      CREATE TABLE IF NOT EXISTS session_write_leases (
        session_id TEXT PRIMARY KEY REFERENCES persistent_sessions(id) ON DELETE CASCADE,
        holder_type TEXT NOT NULL CHECK (holder_type IN ('user', 'service_account')),
        holder_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        holder_service_account_id TEXT REFERENCES service_accounts(id) ON DELETE CASCADE,
        lease_id TEXT NOT NULL,
        lease_token_hash TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
        acquired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK (
          (holder_type = 'user' AND holder_user_id IS NOT NULL AND holder_service_account_id IS NULL) OR
          (holder_type = 'service_account' AND holder_user_id IS NULL AND holder_service_account_id IS NOT NULL)
        )
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_session_write_leases_lease_id
        ON session_write_leases(lease_id);
      CREATE INDEX IF NOT EXISTS idx_session_write_leases_expiry
        ON session_write_leases(expires_at);

      CREATE TABLE IF NOT EXISTS project_session_recordings (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES persistent_sessions(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        mode TEXT NOT NULL DEFAULT 'metadata' CHECK (mode IN ('metadata', 'full')),
        storage_key TEXT,
        size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
        checksum TEXT,
        started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ended_at TEXT,
        retain_until TEXT,
        CHECK ((mode = 'metadata' AND storage_key IS NULL) OR mode = 'full')
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_project_session_recordings_session
        ON project_session_recordings(session_id);
      CREATE INDEX IF NOT EXISTS idx_project_session_recordings_retention
        ON project_session_recordings(project_id, retain_until);

      CREATE TABLE IF NOT EXISTS agent_audit_events (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        service_account_id TEXT NOT NULL REFERENCES service_accounts(id) ON DELETE CASCADE,
        token_id TEXT REFERENCES agent_access_tokens(id) ON DELETE SET NULL,
        session_id TEXT REFERENCES persistent_sessions(id) ON DELETE SET NULL,
        project_host_id INTEGER REFERENCES project_hosts(id) ON DELETE SET NULL,
        request_id TEXT,
        action TEXT NOT NULL,
        success INTEGER NOT NULL,
        error_code TEXT,
        metadata TEXT,
        ip_address TEXT,
        occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_agent_audit_project_time
        ON agent_audit_events(project_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_audit_account_time
        ON agent_audit_events(service_account_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_audit_session_time
        ON agent_audit_events(session_id, occurred_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_audit_request
        ON agent_audit_events(token_id, request_id, action)
        WHERE request_id IS NOT NULL;
    `);

    const projectHostColumns = sqlite
      .prepare("PRAGMA table_info(project_hosts)")
      .all() as Array<{ name: string }>;
    if (!projectHostColumns.some((column) => column.name === "credential_id")) {
      sqlite.exec(
        "ALTER TABLE project_hosts ADD COLUMN credential_id TEXT REFERENCES project_credentials(id) ON DELETE SET NULL",
      );
    }
    if (!projectHostColumns.some((column) => column.name === "folder")) {
      sqlite.exec("ALTER TABLE project_hosts ADD COLUMN folder TEXT");

      // 仅在首次增加项目文件夹字段时复制旧值。后续用户主动移到根目录后，
      // 绝不能再次被全局 ssh_data.folder 覆盖。
      sqlite.exec(`
        UPDATE project_hosts
           SET folder = (
             SELECT legacy_host.folder
               FROM ssh_data legacy_host
              WHERE legacy_host.id = project_hosts.host_id
           )
         WHERE folder IS NULL;

      `);
      const hasLegacyFolders = sqlite
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ssh_folders'",
        )
        .get();
      if (hasLegacyFolders) {
        sqlite.exec(`
          INSERT OR IGNORE INTO project_folders
            (project_id, path, color, icon)
          SELECT DISTINCT ph.project_id, ph.folder, legacy_folder.color,
                          legacy_folder.icon
            FROM project_hosts ph
            JOIN ssh_data legacy_host ON legacy_host.id = ph.host_id
            LEFT JOIN ssh_folders legacy_folder
              ON legacy_folder.user_id = legacy_host.user_id
             AND legacy_folder.name = ph.folder
           WHERE ph.folder IS NOT NULL AND trim(ph.folder) <> '';
        `);
      } else {
        sqlite.exec(`
          INSERT OR IGNORE INTO project_folders (project_id, path)
          SELECT DISTINCT project_id, folder FROM project_hosts
           WHERE folder IS NOT NULL AND trim(folder) <> '';
        `);
      }
    }

    const tokenColumns = sqlite
      .prepare("PRAGMA table_info(agent_access_tokens)")
      .all() as Array<{ name: string }>;
    const deviceColumns = sqlite
      .prepare("PRAGMA table_info(agent_devices)")
      .all() as Array<{ name: string }>;
    if (!deviceColumns.some((column) => column.name === "owner_user_id")) {
      sqlite.exec(
        "ALTER TABLE agent_devices ADD COLUMN owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL",
      );

      // 优先按首次审批审计恢复原始设备所有者，不能使用后来变化的授权主体。
      const hasAuditLogs = sqlite
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit_logs'",
        )
        .get();
      if (hasAuditLogs) {
        sqlite.exec(`
          UPDATE agent_devices
             SET owner_user_id = (
               SELECT approval.user_id
                 FROM audit_logs approval
                 JOIN users approval_user ON approval_user.id = approval.user_id
                WHERE approval.action = 'approve_agent_device'
                  AND approval.resource_type = 'agent_device'
                  AND approval.resource_id = agent_devices.id
                  AND approval.success = 1
                ORDER BY approval.id ASC
                LIMIT 1
             )
           WHERE owner_user_id IS NULL;
        `);
      }

      // 旧审批缺少审计时，以该设备最早创建的内部服务账号作为保守回退。
      sqlite.exec(`
        UPDATE agent_devices
           SET owner_user_id = (
             SELECT account.created_by
               FROM service_accounts account
              WHERE substr(
                      account.name,
                      1,
                      length('__device__:' || agent_devices.id || ':')
                    ) = '__device__:' || agent_devices.id || ':'
                AND account.created_by IS NOT NULL
              ORDER BY account.created_at ASC, account.rowid ASC
              LIMIT 1
           )
         WHERE owner_user_id IS NULL;
      `);
    }

    sqlite.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_agent_devices_owner_required
      BEFORE INSERT ON agent_devices
      WHEN NEW.owner_user_id IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'agent device owner is required');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_agent_devices_owner_immutable
      BEFORE UPDATE OF owner_user_id ON agent_devices
      WHEN NEW.owner_user_id IS NOT OLD.owner_user_id
       AND NEW.owner_user_id IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'agent device owner is immutable');
      END;
    `);

    const persistentSessionColumns = sqlite
      .prepare("PRAGMA table_info(persistent_sessions)")
      .all() as Array<{ name: string }>;
    if (
      !persistentSessionColumns.some((column) => column.name === "runtime_mode")
    ) {
      // 升级前的 Agent 会话全部由远端 tmux 承载，不能误判成平台模式。
      sqlite.exec(
        "ALTER TABLE persistent_sessions ADD COLUMN runtime_mode TEXT NOT NULL DEFAULT 'tmux' CHECK (runtime_mode IN ('platform', 'tmux'))",
      );
    }

    if (!tokenColumns.some((column) => column.name === "access_mode")) {
      sqlite.exec(
        "ALTER TABLE agent_access_tokens ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'selected' CHECK (access_mode IN ('all', 'selected'))",
      );
    }
    if (!tokenColumns.some((column) => column.name === "created_by_user_id")) {
      sqlite.exec(
        "ALTER TABLE agent_access_tokens ADD COLUMN created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL",
      );
    }

    const tokenProjectColumns = sqlite
      .prepare("PRAGMA table_info(agent_token_projects)")
      .all() as Array<{ name: string }>;
    if (
      !tokenProjectColumns.some(
        (column) => column.name === "service_account_id",
      )
    ) {
      sqlite.exec(
        "ALTER TABLE agent_token_projects ADD COLUMN service_account_id TEXT REFERENCES service_accounts(id) ON DELETE CASCADE",
      );
    }

    // 旧 Token 保持仅能访问原项目，迁移不能扩大已有授权范围。
    sqlite.exec(`
      UPDATE agent_access_tokens
         SET created_by_user_id = (
           SELECT account.created_by
             FROM service_accounts account
            WHERE account.id = agent_access_tokens.service_account_id
         )
       WHERE created_by_user_id IS NULL;

      INSERT OR IGNORE INTO agent_token_projects
        (token_id, project_id, service_account_id, granted_by)
      SELECT token.id, token.project_id, token.service_account_id,
             token.created_by_user_id
        FROM agent_access_tokens token;

      UPDATE agent_token_projects
         SET service_account_id = (
           SELECT token.service_account_id
             FROM agent_access_tokens token
            WHERE token.id = agent_token_projects.token_id
              AND token.project_id = agent_token_projects.project_id
         )
       WHERE service_account_id IS NULL;

      UPDATE agent_access_tokens
         SET is_active = 0,
             revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
       WHERE is_active <> 0 OR revoked_at IS NULL;
    `);

    const auditColumns = sqlite
      .prepare("PRAGMA table_info(agent_audit_events)")
      .all() as Array<{ name: string }>;
    if (!auditColumns.some((column) => column.name === "device_id")) {
      sqlite.exec(
        "ALTER TABLE agent_audit_events ADD COLUMN device_id TEXT REFERENCES agent_devices(id) ON DELETE SET NULL",
      );
      sqlite.exec(
        "CREATE INDEX IF NOT EXISTS idx_agent_audit_device_time ON agent_audit_events(device_id, occurred_at DESC)",
      );
    }

    // 控制面测试、恢复工具和旧版数据库可能只初始化最小 ssh_data 表。
    // 在此处也幂等补齐网络信息缓存列，避免项目主机列表依赖启动顺序。
    const hostColumns = sqlite
      .prepare("PRAGMA table_info(ssh_data)")
      .all() as Array<{
      name: string;
    }>;
    const hostColumnNames = new Set(hostColumns.map((column) => column.name));
    const networkInfoColumns = [
      ["network_info_status", "TEXT"],
      ["network_lookup_source", "TEXT"],
      ["network_resolved_ip", "TEXT"],
      ["network_country_code", "TEXT"],
      ["network_country", "TEXT"],
      ["network_region", "TEXT"],
      ["network_city", "TEXT"],
      ["network_isp", "TEXT"],
      ["network_asn", "TEXT"],
      ["network_info_updated_at", "TEXT"],
    ] as const;
    for (const [column, definition] of networkInfoColumns) {
      if (!hostColumnNames.has(column)) {
        sqlite.exec(`ALTER TABLE ssh_data ADD COLUMN ${column} ${definition}`);
      }
    }
  })();
}
