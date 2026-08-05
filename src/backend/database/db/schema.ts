import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull(),
  passwordHash: text("password_hash").notNull(),
  isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),

  isOidc: integer("is_oidc", { mode: "boolean" }).notNull().default(false),
  oidcIdentifier: text("oidc_identifier"),
  ssoProviderId: integer("sso_provider_id"),
  clientId: text("client_id"),
  clientSecret: text("client_secret"),
  issuerUrl: text("issuer_url"),
  authorizationUrl: text("authorization_url"),
  tokenUrl: text("token_url"),
  identifierPath: text("identifier_path"),
  namePath: text("name_path"),
  scopes: text().default("openid email profile"),

  totpSecret: text("totp_secret"),
  totpEnabled: integer("totp_enabled", { mode: "boolean" })
    .notNull()
    .default(false),
  totpBackupCodes: text("totp_backup_codes"),

  registeredAt: text("registered_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  // 旧版本兼容列；捐赠功能已移除，保留映射避免破坏已有数据库。
  donationModalDismissed: integer("donation_modal_dismissed", {
    mode: "boolean",
  })
    .notNull()
    .default(false),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const ssoProviders = sqliteTable("sso_providers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  type: text("type").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  displayOrder: integer("display_order").notNull().default(0),
  config: text("config").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  jwtToken: text("jwt_token").notNull(),
  deviceType: text("device_type").notNull(),
  deviceInfo: text("device_info").notNull(),
  oidcSub: text("oidc_sub"),
  oidcSid: text("oidc_sid"),
  ssoProviderId: integer("sso_provider_id"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  expiresAt: text("expires_at").notNull(),
  lastActiveAt: text("last_active_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const trustedDevices = sqliteTable("trusted_devices", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  deviceFingerprint: text("device_fingerprint").notNull(),
  deviceType: text("device_type").notNull(),
  deviceInfo: text("device_info").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  expiresAt: text("expires_at").notNull(),
  lastUsedAt: text("last_used_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const webauthnCredentials = sqliteTable("webauthn_credentials", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  credentialId: text("credential_id").notNull(),
  publicKey: text("public_key").notNull(),
  counter: integer("counter").notNull().default(0),
  deviceType: text("device_type"),
  backedUp: integer("backed_up", { mode: "boolean" }).notNull().default(false),
  transports: text("transports"),
  userVerification: text("user_verification").notNull().default("preferred"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  lastUsedAt: text("last_used_at"),
});

export const hosts = sqliteTable("ssh_data", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  connectionType: text("connection_type").notNull().default("ssh"),
  name: text("name"),
  ip: text("ip").notNull(),
  port: integer("port").notNull(),
  username: text("username").notNull(),
  folder: text("folder"),
  tags: text("tags"),
  pin: integer("pin", { mode: "boolean" }).notNull().default(false),
  authType: text("auth_type").notNull(),
  useWarpgate: integer("use_warpgate", { mode: "boolean" }).notNull().default(false),
  forceKeyboardInteractive: text("force_keyboard_interactive"),

  password: text("password"),
  key: text("key", { length: 8192 }),
  keyPassword: text("key_password"),
  keyType: text("key_type"),
  sudoPassword: text("sudo_password"),

  autostartPassword: text("autostart_password"),
  autostartKey: text("autostart_key", { length: 8192 }),
  autostartKeyPassword: text("autostart_key_password"),

  credentialId: integer("credential_id").references(() => sshCredentials.id, { onDelete: "set null" }),
  overrideCredentialUsername: integer("override_credential_username", {
    mode: "boolean",
  }),
  // When authType is "vault", the host authenticates via a Vault SSH signer
  // profile (shared settings, no secrets). The signing certificate is obtained
  // per-user at connect time via an interactive Vault OIDC flow.
  vaultProfileId: integer("vault_profile_id").references(
    () => vaultProfiles.id,
    { onDelete: "set null" },
  ),
  enableTerminal: integer("enable_terminal", { mode: "boolean" })
    .notNull()
    .default(true),
  enableSessionLogging: integer("enable_session_logging", { mode: "boolean" })
    .notNull()
    .default(true),
  allowSessionSharing: integer("allow_session_sharing", { mode: "boolean" })
    .notNull()
    .default(true),
  enableCommandHistory: integer("enable_command_history", { mode: "boolean" })
    .notNull()
    .default(true),
  enableTunnel: integer("enable_tunnel", { mode: "boolean" })
    .notNull()
    .default(true),
  tunnelConnections: text("tunnel_connections"),
  jumpHosts: text("jump_hosts"),
  enableFileManager: integer("enable_file_manager", { mode: "boolean" })
    .notNull()
    .default(true),
  scpLegacy: integer("scp_legacy", { mode: "boolean" }).notNull().default(false),
  enableDocker: integer("enable_docker", { mode: "boolean" })
    .notNull()
    .default(false),
  enableTmuxMonitor: integer("enable_tmux_monitor", { mode: "boolean" })
    .notNull()
    .default(false),
  showTerminalInSidebar: integer("show_terminal_in_sidebar", { mode: "boolean" })
    .notNull()
    .default(true),
  showFileManagerInSidebar: integer("show_file_manager_in_sidebar", { mode: "boolean" })
    .notNull()
    .default(false),
  showTunnelInSidebar: integer("show_tunnel_in_sidebar", { mode: "boolean" })
    .notNull()
    .default(false),
  showDockerInSidebar: integer("show_docker_in_sidebar", { mode: "boolean" })
    .notNull()
    .default(false),
  showServerStatsInSidebar: integer("show_server_stats_in_sidebar", { mode: "boolean" })
    .notNull()
    .default(false),
  defaultPath: text("default_path"),
  statsConfig: text("stats_config"),
  dockerConfig: text("docker_config"),
  enableProxmox: integer("enable_proxmox", { mode: "boolean" })
    .notNull()
    .default(false),
  proxmoxConfig: text("proxmox_config"),
  terminalConfig: text("terminal_config"),
  quickActions: text("quick_actions"),
  notes: text("notes"),
  enableSsh: integer("enable_ssh", { mode: "boolean" }).notNull().default(true),
  enableRdp: integer("enable_rdp", { mode: "boolean" }).notNull().default(false),
  enableVnc: integer("enable_vnc", { mode: "boolean" }).notNull().default(false),
  enableTelnet: integer("enable_telnet", { mode: "boolean" }).notNull().default(false),

  sshPort: integer("ssh_port").default(22),
  rdpPort: integer("rdp_port").default(3389),
  vncPort: integer("vnc_port").default(5900),
  telnetPort: integer("telnet_port").default(23),

  rdpCredentialId: integer("rdp_credential_id").references(() => sshCredentials.id, { onDelete: "set null" }),
  rdpUser: text("rdp_user"),
  rdpPassword: text("rdp_password"),
  rdpDomain: text("rdp_domain"),
  rdpSecurity: text("rdp_security"),
  rdpIgnoreCert: integer("rdp_ignore_cert", { mode: "boolean" }).default(false),

  vncCredentialId: integer("vnc_credential_id").references(() => sshCredentials.id, { onDelete: "set null" }),
  vncPassword: text("vnc_password"),
  vncUser: text("vnc_user"),

  telnetUser: text("telnet_user"),
  telnetPassword: text("telnet_password"),
  telnetCredentialId: integer("telnet_credential_id").references(() => sshCredentials.id, { onDelete: "set null" }),

  rdpAuthType: text("rdp_auth_type"),
  vncAuthType: text("vnc_auth_type"),
  telnetAuthType: text("telnet_auth_type"),

  domain: text("domain"),
  security: text("security"),
  ignoreCert: integer("ignore_cert", { mode: "boolean" }).default(false),
  guacamoleConfig: text("guacamole_config"),

  useSocks5: integer("use_socks5", { mode: "boolean" }),
  socks5Host: text("socks5_host"),
  socks5Port: integer("socks5_port"),
  socks5Username: text("socks5_username"),
  socks5Password: text("socks5_password"),
  socks5ProxyChain: text("socks5_proxy_chain"),

  // null = use the desktop app's global default; "local" | "remote" pins
  // this specific host's SSH/Docker-console/Serial connections to originate
  // from the embedded local backend or a connected remote sync server.
  // Ignored for rdp/vnc/telnet, which always require the remote server.
  connectionOrigin: text("connection_origin"),

  macAddress: text("mac_address"),
  wolBroadcastAddress: text("wol_broadcast_address"),
  portKnockSequence: text("port_knock_sequence"),

  hostKeyFingerprint: text("host_key_fingerprint"),
  hostKeyType: text("host_key_type"),
  hostKeyAlgorithm: text("host_key_algorithm").default("sha256"),
  hostKeyFirstSeen: text("host_key_first_seen"),
  hostKeyLastVerified: text("host_key_last_verified"),
  hostKeyChangedCount: integer("host_key_changed_count").default(0),

  // 公网地址的地区与运营商缓存。查询失败不影响主机连接；状态字段
  // 让界面能够明确区分查询中、内网地址和查询失败。
  networkInfoStatus: text("network_info_status"),
  networkLookupSource: text("network_lookup_source"),
  networkResolvedIp: text("network_resolved_ip"),
  networkCountryCode: text("network_country_code"),
  networkCountry: text("network_country"),
  networkRegion: text("network_region"),
  networkCity: text("network_city"),
  networkIsp: text("network_isp"),
  networkAsn: text("network_asn"),
  networkInfoUpdatedAt: text("network_info_updated_at"),

  // Stable identity used to match this row across two independently-seeded
  // databases (the embedded backend and a connected remote server) during
  // sync -- local autoincrement ids collide across instances.
  syncId: text("sync_id").unique(),

  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const fileManagerRecent = sqliteTable("file_manager_recent", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  hostId: integer("host_id")
    .notNull()
    .references(() => hosts.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  path: text("path").notNull(),
  lastOpened: text("last_opened")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const fileManagerPinned = sqliteTable("file_manager_pinned", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  hostId: integer("host_id")
    .notNull()
    .references(() => hosts.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  path: text("path").notNull(),
  pinnedAt: text("pinned_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const fileManagerShortcuts = sqliteTable("file_manager_shortcuts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  hostId: integer("host_id")
    .notNull()
    .references(() => hosts.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  path: text("path").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const transferRecent = sqliteTable("transfer_recent", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  sourceHostId: integer("source_host_id")
    .notNull()
    .references(() => hosts.id, { onDelete: "cascade" }),
  destHostId: integer("dest_host_id")
    .notNull()
    .references(() => hosts.id, { onDelete: "cascade" }),
  destPath: text("dest_path").notNull(),
  destPathLabel: text("dest_path_label").notNull(),
  lastUsed: text("last_used")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const dismissedAlerts = sqliteTable("dismissed_alerts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  alertId: text("alert_id").notNull(),
  dismissedAt: text("dismissed_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const sshCredentials = sqliteTable("ssh_credentials", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  folder: text("folder"),
  tags: text("tags"),
  authType: text("auth_type").notNull(),
  username: text("username"),
  password: text("password"),
  key: text("key", { length: 16384 }),
  privateKey: text("private_key", { length: 16384 }),
  publicKey: text("public_key", { length: 4096 }),
  keyPassword: text("key_password"),
  keyType: text("key_type"),
  detectedKeyType: text("detected_key_type"),

  certPublicKey: text("cert_public_key", { length: 8192 }),


  usageCount: integer("usage_count").notNull().default(0),
  lastUsed: text("last_used"),
  syncId: text("sync_id").unique(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const sshCredentialUsage = sqliteTable("ssh_credential_usage", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  credentialId: integer("credential_id")
    .notNull()
    .references(() => sshCredentials.id, { onDelete: "cascade" }),
  hostId: integer("host_id")
    .notNull()
    .references(() => hosts.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  usedAt: text("used_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const snippets = sqliteTable("snippets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  content: text("content").notNull(),
  description: text("description"),
  folder: text("folder"),
  order: integer("order").notNull().default(0),
  syncId: text("sync_id").unique(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  hostFilter: text("host_filter"),
});

export const snippetFolders = sqliteTable("snippet_folders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  color: text("color"),
  icon: text("icon"),
  syncId: text("sync_id").unique(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const c2sTunnelPresets = sqliteTable("c2s_tunnel_presets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  config: text("config").notNull(),
  platform: text("platform"),
  computerName: text("computer_name"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const snippetAccess = sqliteTable("snippet_access", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  snippetId: integer("snippet_id")
    .notNull()
    .references(() => snippets.id, { onDelete: "cascade" }),

  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  roleId: integer("role_id").references(() => roles.id, {
    onDelete: "cascade",
  }),

  grantedBy: text("granted_by")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),

  permissionLevel: text("permission_level").notNull().default("view"),

  expiresAt: text("expires_at"),

  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const sshFolders = sqliteTable("ssh_folders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  color: text("color"),
  icon: text("icon"),
  credentialId: integer("credential_id").references(() => sshCredentials.id, {
    onDelete: "set null",
  }),
  syncId: text("sync_id").unique(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const recentActivity = sqliteTable("recent_activity", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  hostId: integer("host_id")
    .notNull()
    .references(() => hosts.id, { onDelete: "cascade" }),
  hostName: text("host_name"),
  timestamp: text("timestamp")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const commandHistory = sqliteTable("command_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  hostId: integer("host_id")
    .notNull()
    .references(() => hosts.id, { onDelete: "cascade" }),
  command: text("command").notNull(),
  executedAt: text("executed_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const networkTopology = sqliteTable("network_topology", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  topology: text("topology"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const hostAccess = sqliteTable("host_access", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hostId: integer("host_id")
    .notNull()
    .references(() => hosts.id, { onDelete: "cascade" }),

  userId: text("user_id")
    .references(() => users.id, { onDelete: "cascade" }),
  roleId: integer("role_id")
    .references(() => roles.id, { onDelete: "cascade" }),

  grantedBy: text("granted_by")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),

  permissionLevel: text("permission_level")
    .notNull()
    .default("connect"),

  expiresAt: text("expires_at"),

  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  lastAccessedAt: text("last_accessed_at"),
  accessCount: integer("access_count").notNull().default(0),
  overrideCredentialId: integer("override_credential_id").references(
    () => sshCredentials.id,
    { onDelete: "set null" },
  ),
});

export const sharedHostSecrets = sqliteTable("shared_host_secrets", {
  id: integer("id").primaryKey({ autoIncrement: true }),

  hostAccessId: integer("host_access_id")
    .notNull()
    .references(() => hostAccess.id, { onDelete: "cascade" }),

  targetUserId: text("target_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),

  protocol: text("protocol").notNull().default("ssh"),
  sourceType: text("source_type").notNull().default("credential"),

  originalCredentialId: integer("original_credential_id").references(
    () => sshCredentials.id,
    { onDelete: "cascade" },
  ),

  encryptedUsername: text("encrypted_username"),
  encryptedAuthType: text("encrypted_auth_type"),
  encryptedPassword: text("encrypted_password"),
  encryptedKey: text("encrypted_key", { length: 16384 }),
  encryptedKeyPassword: text("encrypted_key_password"),
  encryptedKeyType: text("encrypted_key_type"),
  encryptedDomain: text("encrypted_domain"),

  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const roles = sqliteTable("roles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  displayName: text("display_name").notNull(),
  description: text("description"),

  isSystem: integer("is_system", { mode: "boolean" })
    .notNull()
    .default(false),

  permissions: text("permissions"),

  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const userRoles = sqliteTable("user_roles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  roleId: integer("role_id")
    .notNull()
    .references(() => roles.id, { onDelete: "cascade" }),

  grantedBy: text("granted_by").references(() => users.id, {
    onDelete: "set null",
  }),
  grantedAt: text("granted_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const auditLogs = sqliteTable("audit_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),

  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  username: text("username").notNull(),

  action: text("action").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id"),
  resourceName: text("resource_name"),

  details: text("details"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),

  success: integer("success", { mode: "boolean" }).notNull(),
  errorMessage: text("error_message"),

  timestamp: text("timestamp")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const sessionRecordings = sqliteTable("session_recordings", {
  id: integer("id").primaryKey({ autoIncrement: true }),

  hostId: integer("host_id")
    .notNull()
    .references(() => hosts.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accessId: integer("access_id").references(() => hostAccess.id, {
    onDelete: "set null",
  }),

  startedAt: text("started_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  endedAt: text("ended_at"),
  duration: integer("duration"),

  commands: text("commands"),
  dangerousActions: text("dangerous_actions"),

  recordingPath: text("recording_path"),
  protocol: text("protocol").notNull().default("ssh"),
  format: text("format").notNull().default("text"),

  terminatedByOwner: integer("terminated_by_owner", { mode: "boolean" })
    .default(false),
  terminationReason: text("termination_reason"),
});

export const sessionShares = sqliteTable("session_shares", {
  id: text("id").primaryKey(),

  hostId: integer("host_id")
    .notNull()
    .references(() => hosts.id, { onDelete: "cascade" }),
  ownerUserId: text("owner_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),

  protocol: text("protocol").notNull(),

  // Live-session binding: TerminalSessionManager's session.id for SSH, or
  // guacd's own guacamoleConnectionId for rdp/vnc/telnet. Neither is a DB
  // row (process-local, in-memory) so this intentionally has no FK.
  sessionId: text("session_id").notNull(),
  tabInstanceId: text("tab_instance_id"),

  shareType: text("share_type").notNull(), // "link" | "user"
  targetUserId: text("target_user_id").references(() => users.id, {
    onDelete: "cascade",
  }),
  linkToken: text("link_token").unique(),

  permissionLevel: text("permission_level").notNull().default("read-only"),

  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"),

  lastJoinedAt: text("last_joined_at"),
  joinCount: integer("join_count").notNull().default(0),
});

export const sessionShareParticipants = sqliteTable(
  "session_share_participants",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    shareId: text("share_id")
      .notNull()
      .references(() => sessionShares.id, { onDelete: "cascade" }),

    userId: text("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    guestLabel: text("guest_label"),

    joinedAt: text("joined_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    leftAt: text("left_at"),
  },
);

export const opksshTokens = sqliteTable("opkssh_tokens", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  hostId: integer("host_id")
    .notNull()
    .references(() => hosts.id, { onDelete: "cascade" }),

  sshCert: text("ssh_cert", { length: 8192 }).notNull(),
  privateKey: text("private_key", { length: 8192 }).notNull(),

  email: text("email"),
  sub: text("sub"),
  issuer: text("issuer"),
  audience: text("audience"),

  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  expiresAt: text("expires_at").notNull(),
  lastUsed: text("last_used"),
});

// Vault SSH signer profiles. These hold ONLY non-secret connection settings and
// are intended to be shared across users (shared === true makes a profile
// visible to every user on the server). Each user authenticates to Vault via an
// interactive OIDC flow at connect time; no tokens or keys are stored here.
export const vaultProfiles = sqliteTable("vault_profiles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  folder: text("folder"),
  tags: text("tags"),
  // Vault server connection (non-secret)
  vaultAddr: text("vault_addr").notNull(),
  vaultNamespace: text("vault_namespace"),
  // OIDC auth method mount + role used to obtain a Vault token interactively
  oidcMount: text("oidc_mount"),
  oidcRole: text("oidc_role"),
  // SSH secrets engine mount + signer role used to sign the ephemeral key
  sshMount: text("ssh_mount"),
  sshRole: text("ssh_role").notNull(),
  validPrincipals: text("valid_principals"),
  // Ephemeral keypair algorithm to generate per connection
  keyType: text("key_type"),
  // When true the profile is visible/usable by all users on the server
  shared: integer("shared", { mode: "boolean" }).notNull().default(false),
  syncId: text("sync_id").unique(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

// Per-user cache of the ephemeral SSH private key + Vault-signed certificate.
// Transient: rows live only until the certificate expires. Secret fields are
// encrypted under the user's data-encryption key (see field-crypto.ts).
export const vaultTokens = sqliteTable("vault_tokens", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  profileId: integer("profile_id")
    .notNull()
    .references(() => vaultProfiles.id, { onDelete: "cascade" }),

  sshCert: text("ssh_cert", { length: 8192 }).notNull(),
  privateKey: text("private_key", { length: 8192 }).notNull(),

  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  expiresAt: text("expires_at").notNull(),
  lastUsed: text("last_used"),
});

export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull(),
  tokenPrefix: text("token_prefix").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  expiresAt: text("expires_at"),
  lastUsedAt: text("last_used_at"),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
});

export const userOpenTabs = sqliteTable("user_open_tabs", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tabType: text("tab_type").notNull(),
  hostId: integer("host_id").references(() => hosts.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  tabOrder: integer("tab_order").notNull().default(0),
  backendSessionId: text("backend_session_id"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

// 固定 Web SSH 窗口的恢复元数据。这里只保存定位远端 tmux 所需的信息，
// 不保存 SSH 密码、私钥或其他凭据。
export const webTerminalSessions = sqliteTable(
  "web_terminal_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    hostId: integer("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "restrict" }),
    projectHostId: integer("project_host_id"),
    tabInstanceId: text("tab_instance_id").notNull(),
    tmuxName: text("tmux_name").notNull(),
    targetFingerprint: text("target_fingerprint"),
    columns: integer("columns").notNull().default(80),
    rows: integer("rows").notNull().default(24),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    lastAttachedAt: text("last_attached_at"),
    lastDetachedAt: text("last_detached_at"),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("uq_web_terminal_sessions_user_tab").on(
      table.userId,
      table.tabInstanceId,
    ),
    uniqueIndex("uq_web_terminal_sessions_host_tmux").on(
      table.hostId,
      table.tmuxName,
    ),
    index("idx_web_terminal_sessions_user_updated").on(
      table.userId,
      table.updatedAt,
    ),
  ],
);

export const userPreferences = sqliteTable("user_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  reopenTabsOnLogin: integer("reopen_tabs_on_login", { mode: "boolean" })
    .notNull()
    .default(false),
  theme: text("theme"),
  fontSize: text("font_size"),
  accentColor: text("accent_color"),
  language: text("language"),
  storageMode: text("storage_mode"),
  commandAutocomplete: integer("command_autocomplete", { mode: "boolean" }),
  commandPaletteEnabled: integer("command_palette_enabled", { mode: "boolean" }),
  showHostTags: integer("show_host_tags", { mode: "boolean" }),
  hostTrayOnClick: integer("host_tray_on_click", { mode: "boolean" }),
  pinAppRail: integer("pin_app_rail", { mode: "boolean" }),
  expandAppRailOnHover: integer("expand_app_rail_on_hover", {
    mode: "boolean",
  }),
  foldersCollapsed: integer("folders_collapsed", { mode: "boolean" }),
  confirmSnippetExecution: integer("confirm_snippet_execution", { mode: "boolean" }),
  disableUpdateCheck: integer("disable_update_check", { mode: "boolean" }),
  confirmTabClose: integer("confirm_tab_close", { mode: "boolean" }),
  hiddenRailTabs: text("hidden_rail_tabs"),
  compactHostView: integer("compact_host_view", { mode: "boolean" }),
  statusColorScheme: text("status_color_scheme"),
  customThemes: text("custom_themes"),
  customKeybindings: text("custom_keybindings"),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const hostMetricsPreferences = sqliteTable("host_metrics_preferences", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  hostId: integer("host_id")
    .notNull()
    .references(() => hosts.id, { onDelete: "cascade" }),
  // JSON-encoded HostMetricsLayout. Layout has no secrets, so it is stored as
  // plain JSON (no field-level encryption).
  layout: text("layout").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const hostHealthChecks = sqliteTable("host_health_checks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  hostId: integer("host_id")
    .notNull()
    .references(() => hosts.id, { onDelete: "cascade" }),
  // JSON array of { id, name, type: "tcp"|"http", target, port, path }
  checks: text("checks").notNull(),
  intervalSeconds: integer("interval_seconds").notNull().default(300),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const hostHealthHistory = sqliteTable("host_health_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  hostId: integer("host_id")
    .notNull()
    .references(() => hosts.id, { onDelete: "cascade" }),
  checkId: text("check_id").notNull(),
  ts: text("ts").notNull().default(sql`CURRENT_TIMESTAMP`),
  ok: integer("ok", { mode: "boolean" }).notNull(),
  latencyMs: integer("latency_ms"),
  detail: text("detail"),
});

export const dashboardServiceLinks = sqliteTable("dashboard_service_links", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  url: text("url").notNull(),
  order: integer("order").notNull().default(0),
  syncId: text("sync_id").unique(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

// --- termix-id begin ---
// A user claims a unique public handle. Their published SSH public keys are
// served at an unauthenticated resolver endpoint in authorized_keys format,
// so any server can be provisioned with `curl <host>/termix-id/u/<handle> >> ~/.ssh/authorized_keys`.
export const termixIdentities = sqliteTable("termix_identities", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // One Termix ID per user — enforced in schema, not just in code.
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  handle: text("handle").notNull().unique(),
  description: text("description"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const termixIdentityKeys = sqliteTable("termix_identity_keys", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  identityId: integer("identity_id")
    .notNull()
    .references(() => termixIdentities.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // Public keys are non-secret, so they are stored in plaintext (no field-level
  // encryption). This is what lets the unauthenticated resolver serve them.
  publicKey: text("public_key", { length: 8192 }).notNull(),
  // Raw algorithm token (e.g. "ssh-ed25519"), and a normalized group used for
  // the /<ALGO> resolver filter (RSA / ED25519 / ECDSA / ...).
  keyType: text("key_type").notNull(),
  algorithm: text("algorithm").notNull(),
  label: text("label"),
  comment: text("comment"),
  // "manual" (pasted) or "credential" (imported from an ssh_credentials entry).
  source: text("source").notNull().default("manual"),
  credentialId: integer("credential_id").references(() => sshCredentials.id, {
    onDelete: "set null",
  }),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});
// Per-identity certificate authority. Servers that trust this CA (via
// TrustedUserCAKeys / @cert-authority) accept any user certificate it signs,
// giving central revocation (rotate the CA) and expiry (cert validity).
export const termixIdentityCa = sqliteTable("termix_identity_ca", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  identityId: integer("identity_id")
    .notNull()
    .unique()
    .references(() => termixIdentities.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // CA public key (plaintext — it is published); CA private key is field-encrypted.
  publicKey: text("public_key", { length: 4096 }).notNull(),
  privateKey: text("private_key", { length: 8192 }).notNull(),
  validityDays: integer("validity_days").notNull().default(90),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});
// --- termix-id end ---

// --- tmux-monitor begin ---
export const tmuxSessionTags = sqliteTable("tmux_session_tags", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  hostId: integer("host_id")
    .notNull()
    .references(() => hosts.id, { onDelete: "cascade" }),
  sessionName: text("session_name").notNull(),
  tag: text("tag").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});
// --- tmux-monitor end ---

// --- metrics-history begin ---
export const hostMetricsHistory = sqliteTable("host_metrics_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hostId: integer("host_id")
    .notNull()
    .references(() => hosts.id, { onDelete: "cascade" }),
  ts: text("ts")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  cpuPercent: real("cpu_percent"),
  memPercent: real("mem_percent"),
  diskPercent: real("disk_percent"),
  netRxBytes: integer("net_rx_bytes"),
  netTxBytes: integer("net_tx_bytes"),
});
// --- metrics-history end ---

// --- alerts begin ---
export const alertRules = sqliteTable("alert_rules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  hostId: integer("host_id").references(() => hosts.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  triggerType: text("trigger_type").notNull(),
  thresholdValue: real("threshold_value"),
  thresholdDurationSeconds: integer("threshold_duration_seconds"),
  cooldownMinutes: integer("cooldown_minutes").notNull().default(15),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const notificationChannels = sqliteTable("notification_channels", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type").notNull(),
  config: text("config").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const alertRuleChannels = sqliteTable("alert_rule_channels", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ruleId: integer("rule_id")
    .notNull()
    .references(() => alertRules.id, { onDelete: "cascade" }),
  channelId: integer("channel_id")
    .notNull()
    .references(() => notificationChannels.id, { onDelete: "cascade" }),
});

export const alertFirings = sqliteTable("alert_firings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  ruleId: integer("rule_id")
    .notNull()
    .references(() => alertRules.id, { onDelete: "cascade" }),
  hostId: integer("host_id").notNull(),
  hostName: text("host_name").notNull(),
  firedAt: text("fired_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  resolvedAt: text("resolved_at"),
  value: real("value"),
  message: text("message").notNull(),
  severity: text("severity").notNull().default("warning"),
  acknowledged: integer("acknowledged", { mode: "boolean" }).notNull().default(false),
});
// --- alerts end ---

// --- homepage begin ---
export const homepageItems = sqliteTable("homepage_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  typeId: text("type_id").notNull(),
  title: text("title"),
  config: text("config").notNull().default("{}"),
  folderId: integer("folder_id"),
  syncId: text("sync_id").unique(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const homepageLayouts = sqliteTable("homepage_layouts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  // JSON: { entries: HomepageLayoutEntry[], pan: {x,y}, zoom: number }
  layout: text("layout").notNull().default("{}"),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});
// --- homepage end ---

// --- sync begin ---
// Records a delete for a synced entity type so the other side of a sync
// pair (embedded desktop backend <-> connected remote server) learns about
// the deletion instead of re-creating the row on its next pull.
export const syncTombstones = sqliteTable("sync_tombstones", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  entityType: text("entity_type").notNull(),
  syncId: text("sync_id").notNull(),
  deletedAt: text("deleted_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});
// --- sync end ---

// --- 云 SSH 控制面开始 ---
export const teams = sqliteTable(
  "teams",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("uq_teams_slug").on(table.slug),
    index("idx_teams_owner").on(table.ownerUserId),
  ],
);

export const teamMembers = sqliteTable(
  "team_members",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    addedBy: text("added_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("uq_team_members_team_user").on(table.teamId, table.userId),
    index("idx_team_members_user").on(table.userId),
    check(
      "ck_team_members_role",
      sql`${table.role} IN ('team_admin', 'project_admin', 'operator', 'viewer')`,
    ),
  ],
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").references(() => teams.id, {
      onDelete: "cascade",
    }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("uq_projects_personal_slug")
      .on(table.ownerUserId, table.slug)
      .where(sql`${table.kind} = 'personal'`),
    uniqueIndex("uq_projects_team_slug")
      .on(table.teamId, table.slug)
      .where(sql`${table.kind} = 'team'`),
    index("idx_projects_team").on(table.teamId),
    index("idx_projects_owner").on(table.ownerUserId),
    check("ck_projects_kind", sql`${table.kind} IN ('personal', 'team')`),
    check(
      "ck_projects_scope",
      sql`(${table.kind} = 'personal' AND ${table.teamId} IS NULL) OR (${table.kind} = 'team' AND ${table.teamId} IS NOT NULL)`,
    ),
  ],
);

export const projectMembers = sqliteTable(
  "project_members",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    addedBy: text("added_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("uq_project_members_project_user").on(
      table.projectId,
      table.userId,
    ),
    index("idx_project_members_user").on(table.userId),
    check(
      "ck_project_members_role",
      sql`${table.role} IN ('project_admin', 'operator', 'viewer')`,
    ),
  ],
);

export const projectRoleGrants = sqliteTable(
  "project_role_grants",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    roleId: integer("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    projectRole: text("project_role").notNull(),
    addedBy: text("added_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("uq_project_role_grants_project_role").on(
      table.projectId,
      table.roleId,
    ),
    index("idx_project_role_grants_role").on(table.roleId),
    index("idx_project_role_grants_project").on(table.projectId),
    check(
      "ck_project_role_grants_project_role",
      sql`${table.projectRole} IN ('project_admin', 'operator', 'viewer')`,
    ),
  ],
);

export const projectCredentials = sqliteTable(
  "project_credentials",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    username: text("username").notNull(),
    authType: text("auth_type").notNull(),
    encryptedSecret: text("encrypted_secret").notNull(),
    keyType: text("key_type"),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("uq_project_credentials_project_name").on(
      table.projectId,
      table.name,
    ),
    index("idx_project_credentials_project").on(table.projectId),
    check(
      "ck_project_credentials_auth_type",
      sql`${table.authType} IN ('password', 'key', 'none')`,
    ),
  ],
);

export const projectHosts = sqliteTable(
  "project_hosts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    hostId: integer("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "cascade" }),
    credentialId: text("credential_id").references(
      () => projectCredentials.id,
      { onDelete: "set null" },
    ),
    alias: text("alias"),
    folder: text("folder"),
    addedBy: text("added_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("uq_project_hosts_project_host").on(
      table.projectId,
      table.hostId,
    ),
    uniqueIndex("uq_project_hosts_project_id").on(table.projectId, table.id),
    index("idx_project_hosts_host").on(table.hostId),
  ],
);

export const projectFolders = sqliteTable(
  "project_folders",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    color: text("color"),
    icon: text("icon"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("uq_project_folders_project_path").on(
      table.projectId,
      table.path,
    ),
    index("idx_project_folders_project").on(table.projectId),
  ],
);

export const serviceAccounts = sqliteTable(
  "service_accounts",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    isActive: integer("is_active", { mode: "boolean" })
      .notNull()
      .default(true),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("uq_service_accounts_project_name").on(
      table.projectId,
      table.name,
    ),
    uniqueIndex("uq_service_accounts_project_id").on(table.projectId, table.id),
    index("idx_service_accounts_project_active").on(
      table.projectId,
      table.isActive,
    ),
  ],
);

export const agentAccessTokens = sqliteTable(
  "agent_access_tokens",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    serviceAccountId: text("service_account_id")
      .notNull()
      .references(() => serviceAccounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenSalt: text("token_salt").notNull(),
    scopes: text("scopes").notNull().default("[]"),
    maxConcurrentSessions: integer("max_concurrent_sessions")
      .notNull()
      .default(1),
    accessMode: text("access_mode", { enum: ["all", "selected"] })
      .notNull()
      .default("selected"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    isActive: integer("is_active", { mode: "boolean" })
      .notNull()
      .default(true),
    expiresAt: text("expires_at"),
    lastUsedAt: text("last_used_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    uniqueIndex("uq_agent_access_tokens_hash").on(table.tokenHash),
    uniqueIndex("uq_agent_access_tokens_project_id").on(
      table.projectId,
      table.id,
    ),
    index("idx_agent_access_tokens_prefix").on(table.tokenPrefix),
    index("idx_agent_access_tokens_account_active").on(
      table.serviceAccountId,
      table.isActive,
    ),
    check(
      "ck_agent_access_tokens_concurrency",
      sql`${table.maxConcurrentSessions} BETWEEN 1 AND 100`,
    ),
    foreignKey({
      columns: [table.projectId, table.serviceAccountId],
      foreignColumns: [serviceAccounts.projectId, serviceAccounts.id],
      name: "fk_agent_access_tokens_project_account",
    }).onDelete("cascade"),
  ],
);

export const agentTokenProjects = sqliteTable(
  "agent_token_projects",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tokenId: text("token_id")
      .notNull()
      .references(() => agentAccessTokens.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    serviceAccountId: text("service_account_id").references(
      () => serviceAccounts.id,
      { onDelete: "cascade" },
    ),
    grantedBy: text("granted_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("uq_agent_token_projects").on(table.tokenId, table.projectId),
    index("idx_agent_token_projects_project").on(
      table.projectId,
      table.tokenId,
    ),
  ],
);

export const agentDevices = sqliteTable(
  "agent_devices",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    publicKey: text("public_key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    status: text("status", { enum: ["active", "revoked"] })
      .notNull()
      .default("active"),
    accessMode: text("access_mode", { enum: ["all", "selected"] })
      .notNull()
      .default("selected"),
    scopes: text("scopes").notNull().default("[]"),
    maxConcurrentSessions: integer("max_concurrent_sessions")
      .notNull()
      .default(1),
    approvedByUserId: text("approved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ownerUserId: text("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    expiresAt: text("expires_at"),
    lastUsedAt: text("last_used_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    approvedAt: text("approved_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    uniqueIndex("uq_agent_devices_fingerprint").on(table.fingerprint),
    index("idx_agent_devices_status").on(table.status, table.expiresAt),
  ],
);

export const agentDeviceProjects = sqliteTable(
  "agent_device_projects",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    deviceId: text("device_id")
      .notNull()
      .references(() => agentDevices.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    serviceAccountId: text("service_account_id")
      .notNull()
      .references(() => serviceAccounts.id, { onDelete: "cascade" }),
    grantedBy: text("granted_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("uq_agent_device_projects").on(
      table.deviceId,
      table.projectId,
    ),
    index("idx_agent_device_projects_project").on(
      table.projectId,
      table.deviceId,
    ),
  ],
);

export const agentDeviceCodes = sqliteTable(
  "agent_device_codes",
  {
    requestId: text("request_id").primaryKey(),
    codeHash: text("code_hash").notNull(),
    deviceName: text("device_name").notNull(),
    publicKey: text("public_key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    status: text("status", { enum: ["pending", "approved", "denied"] })
      .notNull()
      .default("pending"),
    deviceId: text("device_id").references(() => agentDevices.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    expiresAt: text("expires_at").notNull(),
    resolvedAt: text("resolved_at"),
  },
  (table) => [
    uniqueIndex("uq_agent_device_codes_hash").on(table.codeHash),
    index("idx_agent_device_codes_status_expiry").on(
      table.status,
      table.expiresAt,
    ),
  ],
);

export const agentRequestNonces = sqliteTable(
  "agent_request_nonces",
  {
    deviceId: text("device_id")
      .notNull()
      .references(() => agentDevices.id, { onDelete: "cascade" }),
    nonce: text("nonce").notNull(),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({ columns: [table.deviceId, table.nonce] }),
    index("idx_agent_request_nonces_expiry").on(table.expiresAt),
  ],
);

export const agentProvisioningIdempotency = sqliteTable(
  "agent_provisioning_idempotency",
  {
    principalId: text("principal_id").notNull(),
    operation: text("operation").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    resourceSyncId: text("resource_sync_id").notNull(),
    responseJson: text("response_json").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({
      columns: [table.principalId, table.operation, table.idempotencyKey],
      name: "pk_agent_provisioning_idempotency",
    }),
    index("idx_agent_provisioning_idempotency_expiry").on(table.createdAt),
    index("idx_agent_provisioning_idempotency_resource").on(
      table.resourceSyncId,
    ),
    check(
      "ck_agent_provisioning_operation",
      sql`${table.operation} IN ('server', 'quick-connection')`,
    ),
  ],
);

export const agentQuickConnections = sqliteTable(
  "agent_quick_connections",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id")
      .notNull()
      .references(() => agentDevices.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    projectHostId: integer("project_host_id")
      .notNull()
      .unique()
      .references(() => projectHosts.id, { onDelete: "cascade" }),
    hostId: integer("host_id")
      .notNull()
      .unique()
      .references(() => hosts.id, { onDelete: "cascade" }),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_agent_quick_connections_expiry").on(table.expiresAt),
    index("idx_agent_quick_connections_device").on(
      table.deviceId,
      table.projectId,
    ),
    foreignKey({
      columns: [table.projectId, table.projectHostId],
      foreignColumns: [projectHosts.projectId, projectHosts.id],
      name: "fk_agent_quick_connections_project_host",
    }).onDelete("cascade"),
  ],
);

export const agentTokenProjectHosts = sqliteTable(
  "agent_token_project_hosts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    tokenId: text("token_id")
      .notNull()
      .references(() => agentAccessTokens.id, { onDelete: "cascade" }),
    projectHostId: integer("project_host_id")
      .notNull()
      .references(() => projectHosts.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("uq_agent_token_project_hosts").on(
      table.tokenId,
      table.projectHostId,
    ),
    index("idx_agent_token_project_hosts_host").on(table.projectHostId),
    foreignKey({
      columns: [table.projectId, table.tokenId],
      foreignColumns: [agentAccessTokens.projectId, agentAccessTokens.id],
      name: "fk_agent_token_project_hosts_token",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId, table.projectHostId],
      foreignColumns: [projectHosts.projectId, projectHosts.id],
      name: "fk_agent_token_project_hosts_host",
    }).onDelete("cascade"),
  ],
);

export const persistentSessions = sqliteTable(
  "persistent_sessions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    projectHostId: integer("project_host_id")
      .notNull()
      .references(() => projectHosts.id, { onDelete: "restrict" }),
    ownerUserId: text("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    serviceAccountId: text("service_account_id").references(
      () => serviceAccounts.id,
      { onDelete: "set null" },
    ),
    state: text("state").notNull().default("CREATING"),
    title: text("title"),
    runtimeId: text("runtime_id"),
    runtimeMode: text("runtime_mode").notNull().default("tmux"),
    tmuxName: text("tmux_name").notNull(),
    columns: integer("columns").notNull().default(80),
    rows: integer("rows").notNull().default(24),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    streamGeneration: integer("stream_generation").notNull().default(1),
    lastSequence: integer("last_sequence").notNull().default(0),
    idempotencyKey: text("idempotency_key"),
    lastAttachedAt: text("last_attached_at"),
    retainUntil: text("retain_until"),
    failureReason: text("failure_reason"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    closedAt: text("closed_at"),
  },
  (table) => [
    uniqueIndex("uq_persistent_sessions_tmux_name").on(table.tmuxName),
    uniqueIndex("uq_persistent_sessions_project_id").on(
      table.projectId,
      table.id,
    ),
    uniqueIndex("uq_persistent_sessions_idempotency")
      .on(table.projectId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    index("idx_persistent_sessions_project_state").on(
      table.projectId,
      table.state,
    ),
    index("idx_persistent_sessions_host_state").on(
      table.projectHostId,
      table.state,
    ),
    index("idx_persistent_sessions_retention").on(
      table.pinned,
      table.retainUntil,
    ),
    check(
      "ck_persistent_sessions_state",
      sql`${table.state} IN ('CREATING', 'RUNNING', 'RECOVERING', 'CLOSING', 'CLOSED', 'FAILED')`,
    ),
    check(
      "ck_persistent_sessions_runtime_mode",
      sql`${table.runtimeMode} IN ('platform', 'tmux')`,
    ),
    check(
      "ck_persistent_sessions_owner",
      sql`(${table.ownerUserId} IS NOT NULL AND ${table.serviceAccountId} IS NULL) OR (${table.ownerUserId} IS NULL AND ${table.serviceAccountId} IS NOT NULL)`,
    ),
    check(
      "ck_persistent_sessions_size",
      sql`${table.columns} BETWEEN 1 AND 1000 AND ${table.rows} BETWEEN 1 AND 1000`,
    ),
    check(
      "ck_persistent_sessions_cursor",
      sql`${table.streamGeneration} >= 1 AND ${table.lastSequence} >= 0`,
    ),
    foreignKey({
      columns: [table.projectId, table.projectHostId],
      foreignColumns: [projectHosts.projectId, projectHosts.id],
      name: "fk_persistent_sessions_project_host",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.projectId, table.serviceAccountId],
      foreignColumns: [serviceAccounts.projectId, serviceAccounts.id],
      name: "fk_persistent_sessions_project_account",
    }),
  ],
);

export const sessionWriteLeases = sqliteTable(
  "session_write_leases",
  {
    sessionId: text("session_id")
      .primaryKey()
      .references(() => persistentSessions.id, { onDelete: "cascade" }),
    holderType: text("holder_type").notNull(),
    holderUserId: text("holder_user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    holderServiceAccountId: text("holder_service_account_id").references(
      () => serviceAccounts.id,
      { onDelete: "cascade" },
    ),
    leaseId: text("lease_id").notNull(),
    leaseTokenHash: text("lease_token_hash").notNull(),
    version: integer("version").notNull().default(1),
    acquiredAt: text("acquired_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    expiresAt: text("expires_at").notNull(),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("uq_session_write_leases_lease_id").on(table.leaseId),
    index("idx_session_write_leases_expiry").on(table.expiresAt),
    check(
      "ck_session_write_leases_holder_type",
      sql`${table.holderType} IN ('user', 'service_account')`,
    ),
    check(
      "ck_session_write_leases_holder",
      sql`(${table.holderType} = 'user' AND ${table.holderUserId} IS NOT NULL AND ${table.holderServiceAccountId} IS NULL) OR (${table.holderType} = 'service_account' AND ${table.holderUserId} IS NULL AND ${table.holderServiceAccountId} IS NOT NULL)`,
    ),
    check("ck_session_write_leases_version", sql`${table.version} >= 1`),
  ],
);

export const projectSessionRecordings = sqliteTable(
  "project_session_recordings",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => persistentSessions.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    mode: text("mode").notNull().default("metadata"),
    storageKey: text("storage_key"),
    sizeBytes: integer("size_bytes").notNull().default(0),
    checksum: text("checksum"),
    startedAt: text("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    endedAt: text("ended_at"),
    retainUntil: text("retain_until"),
  },
  (table) => [
    uniqueIndex("uq_project_session_recordings_session").on(table.sessionId),
    index("idx_project_session_recordings_retention").on(
      table.projectId,
      table.retainUntil,
    ),
    check(
      "ck_project_session_recordings_mode",
      sql`${table.mode} IN ('metadata', 'full')`,
    ),
    check(
      "ck_project_session_recordings_storage",
      sql`(${table.mode} = 'metadata' AND ${table.storageKey} IS NULL) OR ${table.mode} = 'full'`,
    ),
    check(
      "ck_project_session_recordings_size",
      sql`${table.sizeBytes} >= 0`,
    ),
  ],
);

export const agentAuditEvents = sqliteTable(
  "agent_audit_events",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    serviceAccountId: text("service_account_id")
      .notNull()
      .references(() => serviceAccounts.id, { onDelete: "cascade" }),
    tokenId: text("token_id").references(() => agentAccessTokens.id, {
      onDelete: "set null",
    }),
    deviceId: text("device_id").references(() => agentDevices.id, {
      onDelete: "set null",
    }),
    sessionId: text("session_id").references(() => persistentSessions.id, {
      onDelete: "set null",
    }),
    projectHostId: integer("project_host_id").references(
      () => projectHosts.id,
      { onDelete: "set null" },
    ),
    requestId: text("request_id"),
    action: text("action").notNull(),
    success: integer("success", { mode: "boolean" }).notNull(),
    errorCode: text("error_code"),
    metadata: text("metadata"),
    ipAddress: text("ip_address"),
    occurredAt: text("occurred_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_agent_audit_project_time").on(
      table.projectId,
      table.occurredAt,
    ),
    index("idx_agent_audit_account_time").on(
      table.serviceAccountId,
      table.occurredAt,
    ),
    index("idx_agent_audit_session_time").on(
      table.sessionId,
      table.occurredAt,
    ),
    index("idx_agent_audit_device_time").on(
      table.deviceId,
      table.occurredAt,
    ),
    uniqueIndex("uq_agent_audit_request")
      .on(table.tokenId, table.requestId, table.action)
      .where(sql`${table.requestId} IS NOT NULL`),
  ],
);
// --- 云 SSH 控制面结束 ---
