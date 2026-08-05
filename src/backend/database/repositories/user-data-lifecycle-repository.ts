import type Database from "better-sqlite3";
import type { DatabaseContext } from "./database-context.js";

export const USER_OWNS_SHARED_RESOURCES_CODE =
  "USER_OWNS_SHARED_RESOURCES" as const;
export const USER_MERGE_HAS_OWNED_DATA_CODE =
  "USER_MERGE_HAS_OWNED_DATA" as const;

export class UserOwnsSharedResourcesError extends Error {
  readonly code = USER_OWNS_SHARED_RESOURCES_CODE;

  constructor(
    readonly teamCount: number,
    readonly teamProjectCount: number,
    readonly sharedHostCount: number,
    readonly activePersistentSessionCount: number,
    readonly retainedTeamRecordingCount: number,
  ) {
    super(
      "User still owns shared resources or active persistent sessions. Transfer or close them before deleting or merging the account.",
    );
    this.name = "UserOwnsSharedResourcesError";
  }
}

export class UserMergeHasOwnedDataError extends Error {
  readonly code = USER_MERGE_HAS_OWNED_DATA_CODE;

  constructor(readonly count: number) {
    super(
      "The OIDC account contains workspace data or direct shares. Move or remove that data before merging accounts.",
    );
    this.name = "UserMergeHasOwnedDataError";
  }
}

interface UserRow {
  id: string;
  username: string;
  isOidc: number;
  passwordHash: string;
  clientId: string | null;
  oidcIdentifier: string | null;
}

interface OwnershipCounts {
  teamCount: number;
  teamProjectCount: number;
  sharedHostCount: number;
  activePersistentSessionCount: number;
  retainedTeamRecordingCount: number;
}

export interface PasswordResetWipeInput {
  userId: string;
  username: string;
  passwordHash: string;
  wrappedDek: string;
}

export type PasswordResetPreserveInput = Omit<
  PasswordResetWipeInput,
  "wrappedDek"
>;

function escapeLike(value: string): string {
  return value.replace(/[~%_]/g, (character) => `~${character}`);
}

export class UserDataLifecycleRepository {
  constructor(
    private readonly context: DatabaseContext,
    private readonly onWrite?: () => void | Promise<void>,
  ) {}

  async deleteUserAndRelatedData(userId: string): Promise<boolean> {
    const deleted = this.sqlite.transaction(() => {
      const user = this.findUser(userId);
      if (!user) return false;

      this.assertNoSharedOwnership(userId);
      this.deleteClosedPersistentSessions(userId);
      this.deletePersonalProjects(userId);
      this.deleteUserSettings(userId, user.username);

      return (
        this.sqlite.prepare("DELETE FROM users WHERE id = ?").run(userId)
          .changes === 1
      );
    })();

    if (deleted) await this.afterWrite();
    return deleted;
  }

  async mergeOidcUserIntoPasswordUser(
    sourceUserId: string,
    targetUserId: string,
  ): Promise<void> {
    this.sqlite.transaction(() => {
      if (sourceUserId === targetUserId) {
        throw new Error("Source and target accounts must be different");
      }

      const source = this.findUser(sourceUserId);
      const target = this.findUser(targetUserId);
      if (!source || !target)
        throw new Error("Source or target user not found");
      if (!source.isOidc) throw new Error("Source user is not an OIDC user");
      if (target.isOidc || !target.passwordHash) {
        throw new Error("Target user must be a password-based account");
      }
      if (target.clientId && target.oidcIdentifier) {
        throw new Error(
          "Target user already has OIDC authentication configured",
        );
      }

      this.assertNoSharedOwnership(sourceUserId);
      this.assertMergeSourceHasNoOwnedData(sourceUserId);
      this.mergeMemberships(sourceUserId, targetUserId);

      const updated = this.sqlite
        .prepare(
          `UPDATE users AS target
              SET is_admin = CASE
                    WHEN target.is_admin = 1 OR source.is_admin = 1 THEN 1
                    ELSE 0
                  END,
                  is_oidc = 1,
                  oidc_identifier = source.oidc_identifier,
                  sso_provider_id = source.sso_provider_id,
                  client_id = source.client_id,
                  client_secret = source.client_secret,
                  issuer_url = source.issuer_url,
                  authorization_url = source.authorization_url,
                  token_url = source.token_url,
                  identifier_path = source.identifier_path,
                  name_path = source.name_path,
                  scopes = COALESCE(NULLIF(source.scopes, ''), 'openid email profile')
             FROM users AS source
            WHERE target.id = ? AND source.id = ?`,
        )
        .run(targetUserId, sourceUserId);
      if (updated.changes !== 1) {
        throw new Error("Failed to update the target account");
      }

      this.deletePersonalProjects(sourceUserId);
      this.deleteUserSettings(sourceUserId, source.username);
      const removed = this.sqlite
        .prepare("DELETE FROM users WHERE id = ?")
        .run(sourceUserId);
      if (removed.changes !== 1) {
        throw new Error("Failed to remove the source account");
      }
    })();

    await this.afterWrite();
  }

  async resetPasswordPreservingData(
    input: PasswordResetPreserveInput,
  ): Promise<void> {
    const { userId, username, passwordHash } = input;

    this.sqlite.transaction(() => {
      const updated = this.sqlite
        .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
        .run(passwordHash, userId);
      if (updated.changes !== 1) throw new Error("User not found");

      this.sqlite
        .prepare("DELETE FROM settings WHERE key IN (?, ?)")
        .run(`reset_code_${username}`, `temp_reset_token_${username}`);
    })();

    await this.afterWrite();
  }

  async wipeEncryptedUserData(input: PasswordResetWipeInput): Promise<void> {
    const { userId, username, passwordHash, wrappedDek } = input;

    this.sqlite.transaction(() => {
      if (!this.findUser(userId)) throw new Error("User not found");

      // 这些记录包含用户 DEK 加密的数据，必须与新密码和新 DEK 一起提交。
      this.sqlite
        .prepare("DELETE FROM shared_host_secrets WHERE target_user_id = ?")
        .run(userId);
      this.sqlite
        .prepare("DELETE FROM vault_tokens WHERE user_id = ?")
        .run(userId);
      this.sqlite
        .prepare("DELETE FROM opkssh_tokens WHERE user_id = ?")
        .run(userId);
      this.sqlite
        .prepare("DELETE FROM termix_identity_ca WHERE user_id = ?")
        .run(userId);
      this.sqlite
        .prepare("DELETE FROM dismissed_alerts WHERE user_id = ?")
        .run(userId);
      this.sqlite.prepare("DELETE FROM snippets WHERE user_id = ?").run(userId);
      this.sqlite
        .prepare("DELETE FROM snippet_folders WHERE user_id = ?")
        .run(userId);
      this.sqlite.prepare("DELETE FROM ssh_data WHERE user_id = ?").run(userId);
      this.sqlite
        .prepare("DELETE FROM ssh_credentials WHERE user_id = ?")
        .run(userId);

      this.sqlite
        .prepare(
          `INSERT INTO settings (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(`user_dek_v3_${userId}`, wrappedDek);
      this.deleteLegacyWraps(userId);
      this.sqlite
        .prepare("DELETE FROM settings WHERE key IN (?, ?)")
        .run(`reset_code_${username}`, `temp_reset_token_${username}`);

      const updated = this.sqlite
        .prepare(
          `UPDATE users
              SET password_hash = ?, totp_enabled = 0,
                  totp_secret = NULL, totp_backup_codes = NULL
            WHERE id = ?`,
        )
        .run(passwordHash, userId);
      if (updated.changes !== 1) throw new Error("User not found");
    })();

    await this.afterWrite();
  }

  private get sqlite(): Database.Database {
    if (!this.context.sqlite) throw new Error("SQLite context is required");
    return this.context.sqlite;
  }

  private findUser(userId: string): UserRow | undefined {
    return this.sqlite
      .prepare(
        `SELECT id, username, is_oidc AS isOidc,
                password_hash AS passwordHash, client_id AS clientId,
                oidc_identifier AS oidcIdentifier
           FROM users WHERE id = ?`,
      )
      .get(userId) as UserRow | undefined;
  }

  private assertNoSharedOwnership(userId: string): void {
    const counts = this.sqlite
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM teams WHERE owner_user_id = ?) AS teamCount,
           (SELECT COUNT(*) FROM projects
             WHERE owner_user_id = ? AND kind = 'team') AS teamProjectCount,
           (SELECT COUNT(DISTINCT host.id)
              FROM ssh_data host
              JOIN project_hosts project_host ON project_host.host_id = host.id
              JOIN projects project ON project.id = project_host.project_id
             WHERE host.user_id = ? AND project.kind = 'team') AS sharedHostCount,
           (SELECT COUNT(*)
              FROM persistent_sessions session
             WHERE session.state NOT IN ('CLOSED', 'FAILED')
               AND (
                 session.owner_user_id = ? OR session.project_id IN (
                   SELECT id FROM projects
                    WHERE owner_user_id = ? AND kind = 'personal'
                 )
               )) AS activePersistentSessionCount,
           (SELECT COUNT(*)
              FROM project_session_recordings recording
              JOIN persistent_sessions session
                ON session.id = recording.session_id
              JOIN projects project ON project.id = session.project_id
             WHERE session.owner_user_id = ?
               AND project.kind = 'team'
               AND recording.mode = 'full') AS retainedTeamRecordingCount`,
      )
      .get(userId, userId, userId, userId, userId, userId) as OwnershipCounts;

    if (
      counts.teamCount > 0 ||
      counts.teamProjectCount > 0 ||
      counts.sharedHostCount > 0 ||
      counts.activePersistentSessionCount > 0 ||
      counts.retainedTeamRecordingCount > 0
    ) {
      throw new UserOwnsSharedResourcesError(
        counts.teamCount,
        counts.teamProjectCount,
        counts.sharedHostCount,
        counts.activePersistentSessionCount,
        counts.retainedTeamRecordingCount,
      );
    }
  }

  private assertMergeSourceHasNoOwnedData(userId: string): void {
    const row = this.sqlite
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM ssh_data WHERE user_id = ?) +
           (SELECT COUNT(*) FROM ssh_credentials WHERE user_id = ?) +
           (SELECT COUNT(*) FROM snippets WHERE user_id = ?) +
           (SELECT COUNT(*) FROM snippet_folders WHERE user_id = ?) +
           (SELECT COUNT(*) FROM vault_profiles WHERE user_id = ?) +
           (SELECT COUNT(*) FROM termix_identities WHERE user_id = ?) +
           (SELECT COUNT(*) FROM termix_identity_ca WHERE user_id = ?) +
           (SELECT COUNT(*) FROM alert_rules WHERE user_id = ?) +
           (SELECT COUNT(*) FROM notification_channels WHERE user_id = ?) +
           (SELECT COUNT(*) FROM homepage_items WHERE user_id = ?) +
           (SELECT COUNT(*) FROM dashboard_service_links WHERE user_id = ?) +
           (SELECT COUNT(*) FROM network_topology WHERE user_id = ?) +
           (SELECT COUNT(*) FROM c2s_tunnel_presets WHERE user_id = ?) +
           (SELECT COUNT(*) FROM host_access WHERE user_id = ?) +
           (SELECT COUNT(*) FROM snippet_access WHERE user_id = ?) +
           (SELECT COUNT(*) FROM shared_host_secrets WHERE target_user_id = ?) +
           (SELECT COUNT(*) FROM session_shares
             WHERE owner_user_id = ? OR target_user_id = ?) +
           (SELECT COUNT(*) FROM vault_tokens WHERE user_id = ?) +
           (SELECT COUNT(*) FROM opkssh_tokens WHERE user_id = ?) +
           (SELECT COUNT(*) FROM persistent_sessions WHERE owner_user_id = ?) +
           (SELECT COUNT(*)
              FROM project_hosts project_host
              JOIN projects project ON project.id = project_host.project_id
             WHERE project.owner_user_id = ? AND project.kind = 'personal') +
           (SELECT COUNT(*)
              FROM project_credentials credential
              JOIN projects project ON project.id = credential.project_id
             WHERE project.owner_user_id = ? AND project.kind = 'personal') +
           (SELECT COUNT(*)
              FROM project_folders folder
              JOIN projects project ON project.id = folder.project_id
             WHERE project.owner_user_id = ? AND project.kind = 'personal') +
           (SELECT COUNT(*)
              FROM service_accounts account
              JOIN projects project ON project.id = account.project_id
             WHERE project.owner_user_id = ? AND project.kind = 'personal')
           AS count`,
      )
      .get(
        userId,
        userId,
        userId,
        userId,
        userId,
        userId,
        userId,
        userId,
        userId,
        userId,
        userId,
        userId,
        userId,
        userId,
        userId,
        userId,
        userId,
        userId,
        userId,
        userId,
        userId,
        userId,
        userId,
        userId,
        userId,
      ) as { count: number };

    if (row.count > 0) throw new UserMergeHasOwnedDataError(row.count);
  }

  private mergeMemberships(sourceUserId: string, targetUserId: string): void {
    this.sqlite
      .prepare(
        `INSERT INTO user_roles (user_id, role_id, granted_by, granted_at)
         SELECT ?, role_id, granted_by, granted_at
           FROM user_roles WHERE user_id = ?
         ON CONFLICT(user_id, role_id) DO NOTHING`,
      )
      .run(targetUserId, sourceUserId);

    this.sqlite
      .prepare(
        `INSERT INTO team_members (team_id, user_id, role, added_by, created_at)
         SELECT team_id, ?, role, added_by, created_at
           FROM team_members WHERE user_id = ?
         ON CONFLICT(team_id, user_id) DO UPDATE SET role =
           CASE
             WHEN (CASE excluded.role
                     WHEN 'team_admin' THEN 4 WHEN 'project_admin' THEN 3
                     WHEN 'operator' THEN 2 ELSE 1 END) >
                  (CASE team_members.role
                     WHEN 'team_admin' THEN 4 WHEN 'project_admin' THEN 3
                     WHEN 'operator' THEN 2 ELSE 1 END)
             THEN excluded.role ELSE team_members.role
           END`,
      )
      .run(targetUserId, sourceUserId);

    this.sqlite
      .prepare(
        `INSERT INTO project_members
           (project_id, user_id, role, added_by, created_at)
         SELECT project_id, ?, role, added_by, created_at
           FROM project_members WHERE user_id = ?
         ON CONFLICT(project_id, user_id) DO UPDATE SET role =
           CASE
             WHEN (CASE excluded.role
                     WHEN 'project_admin' THEN 3 WHEN 'operator' THEN 2
                     ELSE 1 END) >
                  (CASE project_members.role
                     WHEN 'project_admin' THEN 3 WHEN 'operator' THEN 2
                     ELSE 1 END)
             THEN excluded.role ELSE project_members.role
           END`,
      )
      .run(targetUserId, sourceUserId);
  }

  private deleteClosedPersistentSessions(userId: string): void {
    this.sqlite
      .prepare(
        `DELETE FROM persistent_sessions
          WHERE owner_user_id = ? AND state IN ('CLOSED', 'FAILED')`,
      )
      .run(userId);
  }

  private deletePersonalProjects(userId: string): void {
    this.sqlite
      .prepare(
        "DELETE FROM projects WHERE owner_user_id = ? AND kind = 'personal'",
      )
      .run(userId);
  }

  private deleteUserSettings(userId: string, username: string): void {
    this.sqlite
      .prepare(
        "DELETE FROM settings WHERE key IN (?, ?) OR key LIKE ? ESCAPE '~'",
      )
      .run(
        `reset_code_${username}`,
        `temp_reset_token_${username}`,
        `user~_%~_${escapeLike(userId)}`,
      );
  }

  private deleteLegacyWraps(userId: string): void {
    this.sqlite
      .prepare(`DELETE FROM settings WHERE key IN (?, ?, ?, ?)`)
      .run(
        `user_encrypted_dek_${userId}`,
        `user_kek_salt_${userId}`,
        `user_encrypted_dek_oidc_${userId}`,
        `user_encrypted_dek_webauthn_${userId}`,
      );
  }

  private async afterWrite(): Promise<void> {
    await this.onWrite?.();
  }
}
