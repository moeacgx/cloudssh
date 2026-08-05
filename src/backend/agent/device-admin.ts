import crypto from "crypto";
import type Database from "better-sqlite3";
import express, { type RequestHandler } from "express";
import type { AuthenticatedRequest } from "../../types/index.js";
import { createCurrentProjectRepository } from "../control-plane/factory.js";
import { AuthManager } from "../utils/auth-manager.js";
import {
  getRequestMeta,
  logAuditOrThrow,
  type AuditLogParams,
} from "../utils/audit-logger.js";
import { PermissionManager } from "../utils/permission-manager.js";
import {
  hashDeviceCode,
  setAgentDeviceRequestCommit,
} from "./device-registration.js";
import type { AgentScope } from "./types.js";

const ALLOWED_SCOPES = new Set<AgentScope>([
  "sessions:create",
  "sessions:read",
  "sessions:write",
  "sessions:close",
  "jobs:execute",
  "servers:create",
  "quick-connections:create",
  "files:read",
  "files:write",
]);
const MFA_STEP_UP_MAX_AGE_SECONDS = 5 * 60;
const MFA_CLOCK_SKEW_SECONDS = 30;

export interface AgentDeviceAdminDependencies {
  sqlite: Database.Database;
  authenticate: RequestHandler;
  listManageableProjects(
    userId: string,
  ): Promise<Array<{ id: string; name: string }>>;
  isInstanceAdmin(userId: string): Promise<boolean>;
  audit?: (entry: AuditLogParams) => Promise<void>;
  onWrite?: () => void | Promise<void>;
}

export function defaultAgentDeviceAdminDependencies(
  sqlite: Database.Database,
  onWrite?: () => void | Promise<void>,
): AgentDeviceAdminDependencies {
  return {
    sqlite,
    authenticate: AuthManager.getInstance().createAuthMiddleware(),
    listManageableProjects: async (userId) => {
      const instanceAdmin =
        await PermissionManager.getInstance().isAdmin(userId);
      const visible =
        await createCurrentProjectRepository().listVisibleProjects(
          userId,
          instanceAdmin,
        );
      return visible
        .filter(
          (project) =>
            instanceAdmin ||
            project.role === "instance_admin" ||
            project.role === "project_admin",
        )
        .map((project) => ({ id: project.id, name: project.name }));
    },
    isInstanceAdmin: (userId) =>
      PermissionManager.getInstance().isAdmin(userId),
    audit: logAuditOrThrow,
    onWrite,
  };
}

interface PendingRow {
  requestId: string;
  deviceName: string;
  publicKey: string;
  fingerprint: string;
  status: "pending" | "approved" | "denied";
  expiresAt: string;
}

interface DeviceConfigRow {
  id: string;
  name: string;
  status: "active" | "revoked";
  accessMode: "all" | "selected";
  scopes: string;
  maxConcurrentSessions: number;
  approvedByUserId: string | null;
  expiresAt: string | null;
}

interface DeviceGrantSnapshot {
  grantId: number;
  deviceId: string;
  projectId: string;
  serviceAccountId: string;
  grantedBy: string | null;
  createdAt: string;
  accountIsActive: number;
  accountUpdatedAt: string;
}

interface AccountStateSnapshot {
  id: string;
  isActive: number;
  updatedAt: string;
}

function insertDeviceAudit(
  sqlite: Database.Database,
  entry: AuditLogParams | undefined,
  resourceId: string,
  resourceName?: string,
): number | null {
  if (!entry) return null;
  const result = sqlite
    .prepare(
      `INSERT INTO audit_logs (
         user_id, username, action, resource_type, resource_id, resource_name,
         details, ip_address, user_agent, success, error_message
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.userId,
      entry.username,
      entry.action,
      entry.resourceType,
      resourceId,
      resourceName ?? entry.resourceName ?? null,
      entry.details ?? null,
      entry.ipAddress ?? null,
      entry.userAgent ?? null,
      entry.success ? 1 : 0,
      entry.errorMessage ?? null,
    );
  return Number(result.lastInsertRowid);
}

function persistenceFailure(error: unknown, rollbackError: unknown): Error {
  const primary = error instanceof Error ? error : new Error(String(error));
  if (!rollbackError) return primary;
  return new AggregateError(
    [primary, rollbackError],
    "设备操作失败，回滚状态的持久化也失败",
  );
}

export class AgentDeviceAdminRepository {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly onWrite?: () => void | Promise<void>,
  ) {}

  resolve(code: string) {
    const codeHash = hashDeviceCode(code);
    if (!codeHash) return null;
    const row = this.sqlite
      .prepare(
        `SELECT request_id AS requestId, device_name AS deviceName,
                public_key AS publicKey, fingerprint, status,
                expires_at AS expiresAt
           FROM agent_device_codes WHERE code_hash = ?`,
      )
      .get(codeHash) as PendingRow | undefined;
    if (
      !row ||
      row.status !== "pending" ||
      Date.parse(row.expiresAt) <= Date.now()
    ) {
      return null;
    }
    return {
      requestId: row.requestId,
      deviceName: row.deviceName,
      fingerprint: row.fingerprint,
      expiresAt: row.expiresAt,
    };
  }

  async approve(input: {
    requestId: string;
    approvedBy: string;
    name?: string;
    accessMode: "all" | "selected";
    projectIds: string[];
    scopes: AgentScope[];
    maxConcurrentSessions: number;
    expiresAt: string | null;
    audit?: AuditLogParams;
  }) {
    const requestedName = input.name?.trim();
    if (requestedName && requestedName.length > 64) {
      throw Object.assign(new Error("name 无效"), { status: 400 });
    }
    const uniqueProjects = [...new Set(input.projectIds)];
    if (uniqueProjects.length === 0) return null;
    const deviceId = crypto.randomUUID();
    const now = new Date().toISOString();
    let committed: {
      id: string;
      name: string;
      accountIds: string[];
      auditId: number | null;
    } | null = null;
    setAgentDeviceRequestCommit(input.requestId, true);
    try {
      committed = this.sqlite.transaction(() => {
        const request = this.sqlite
          .prepare(
            `SELECT request_id AS requestId, device_name AS deviceName,
                    public_key AS publicKey, fingerprint, status,
                    expires_at AS expiresAt
               FROM agent_device_codes WHERE request_id = ?`,
          )
          .get(input.requestId) as PendingRow | undefined;
        if (
          !request ||
          request.status !== "pending" ||
          Date.parse(request.expiresAt) <= Date.now()
        ) {
          return null;
        }
        const name = requestedName || request.deviceName;
        this.sqlite
          .prepare(
            `INSERT INTO agent_devices
               (id, name, public_key, fingerprint, status, access_mode, scopes,
                max_concurrent_sessions, approved_by_user_id, owner_user_id, expires_at,
                created_at, approved_at)
             VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            deviceId,
            name,
            request.publicKey,
            request.fingerprint,
            input.accessMode,
            JSON.stringify(input.scopes),
            input.maxConcurrentSessions,
            input.approvedBy,
            input.approvedBy,
            input.expiresAt,
            now,
            now,
          );
        const accountIds: string[] = [];
        for (const projectId of uniqueProjects) {
          const accountId = crypto.randomUUID();
          accountIds.push(accountId);
          this.sqlite
            .prepare(
              `INSERT INTO service_accounts
                 (id, project_id, name, created_by, is_active)
               VALUES (?, ?, ?, ?, 1)`,
            )
            .run(
              accountId,
              projectId,
              `__device__:${deviceId}:${projectId}`,
              input.approvedBy,
            );
          this.sqlite
            .prepare(
              `INSERT INTO agent_device_projects
                 (device_id, project_id, service_account_id, granted_by)
               VALUES (?, ?, ?, ?)`,
            )
            .run(deviceId, projectId, accountId, input.approvedBy);
        }
        const updated = this.sqlite
          .prepare(
            `UPDATE agent_device_codes
                SET status = 'approved', device_id = ?, resolved_at = ?
              WHERE request_id = ? AND status = 'pending'`,
          )
          .run(deviceId, now, input.requestId);
        if (updated.changes !== 1) throw new Error("设备请求已被处理");
        const auditId = insertDeviceAudit(
          this.sqlite,
          input.audit,
          deviceId,
          name,
        );
        return { id: deviceId, name, accountIds, auditId };
      })();
      if (!committed) return null;
      await this.onWrite?.();
      return { id: committed.id, name: committed.name };
    } catch (error) {
      let rollbackError: unknown = null;
      if (committed) {
        this.sqlite.transaction(() => {
          this.sqlite
            .prepare("DELETE FROM agent_device_projects WHERE device_id = ?")
            .run(committed!.id);
          this.sqlite
            .prepare("DELETE FROM agent_devices WHERE id = ?")
            .run(committed!.id);
          const deleteAccount = this.sqlite.prepare(
            "DELETE FROM service_accounts WHERE id = ?",
          );
          for (const accountId of committed!.accountIds) {
            deleteAccount.run(accountId);
          }
          if (committed!.auditId !== null) {
            this.sqlite
              .prepare("DELETE FROM audit_logs WHERE id = ?")
              .run(committed!.auditId);
          }
          this.sqlite
            .prepare(
              `UPDATE agent_device_codes
                  SET status = 'pending', device_id = NULL, resolved_at = NULL
                WHERE request_id = ?`,
            )
            .run(input.requestId);
        })();
        try {
          await this.onWrite?.();
        } catch (rollbackSaveError) {
          rollbackError = rollbackSaveError;
        }
      }
      throw persistenceFailure(error, rollbackError);
    } finally {
      setAgentDeviceRequestCommit(input.requestId, false);
    }
  }

  async deny(requestId: string, audit?: AuditLogParams): Promise<boolean> {
    let auditId: number | null = null;
    let changed = false;
    setAgentDeviceRequestCommit(requestId, true);
    try {
      this.sqlite.transaction(() => {
        const result = this.sqlite
          .prepare(
            `UPDATE agent_device_codes
                SET status = 'denied', resolved_at = ?
              WHERE request_id = ? AND status = 'pending'`,
          )
          .run(new Date().toISOString(), requestId);
        changed = result.changes > 0;
        if (changed) {
          auditId = insertDeviceAudit(this.sqlite, audit, requestId);
        }
      })();
      if (changed) await this.onWrite?.();
      return changed;
    } catch (error) {
      let rollbackError: unknown = null;
      if (changed) {
        this.sqlite.transaction(() => {
          this.sqlite
            .prepare(
              `UPDATE agent_device_codes
                  SET status = 'pending', resolved_at = NULL
                WHERE request_id = ?`,
            )
            .run(requestId);
          if (auditId !== null) {
            this.sqlite
              .prepare("DELETE FROM audit_logs WHERE id = ?")
              .run(auditId);
          }
        })();
        try {
          await this.onWrite?.();
        } catch (rollbackSaveError) {
          rollbackError = rollbackSaveError;
        }
      }
      throw persistenceFailure(error, rollbackError);
    } finally {
      setAgentDeviceRequestCommit(requestId, false);
    }
  }

  list(input: {
    currentUserId: string;
    manageableProjectIds: string[];
    isInstanceAdmin: boolean;
  }) {
    const placeholders = input.manageableProjectIds.length
      ? input.manageableProjectIds.map(() => "?").join(",")
      : "NULL";
    const rows = this.sqlite
      .prepare(
        `SELECT device.id, device.name, device.fingerprint, device.status,
                device.access_mode AS accessMode, device.scopes,
                device.max_concurrent_sessions AS maxConcurrentSessions,
                device.expires_at AS expiresAt, device.last_used_at AS lastUsedAt,
                device.created_at AS createdAt, device.revoked_at AS revokedAt,
                device.owner_user_id AS ownerUserId,
                owner.username AS ownerUsername,
                GROUP_CONCAT(DISTINCT grant_row.project_id) AS projectIds
           FROM agent_devices device
           LEFT JOIN agent_device_projects grant_row ON grant_row.device_id = device.id
           LEFT JOIN users owner ON owner.id = device.owner_user_id
          WHERE (? = 1 OR
                 (? = 1 AND EXISTS (
                    SELECT 1 FROM agent_device_projects visible_grant
                     WHERE visible_grant.device_id = device.id
                 ) AND NOT EXISTS (
                    SELECT 1 FROM agent_device_projects outside_grant
                     WHERE outside_grant.device_id = device.id
                       AND outside_grant.project_id NOT IN (${placeholders})
                 )))
          GROUP BY device.id ORDER BY device.created_at DESC`,
      )
      .all(
        input.isInstanceAdmin ? 1 : 0,
        input.manageableProjectIds.length ? 1 : 0,
        ...input.manageableProjectIds,
      ) as Array<
      Record<string, unknown> & {
        scopes: string;
        projectIds: string | null;
        ownerUserId: string | null;
        ownerUsername: string | null;
      }
    >;
    return rows.map(({ ownerUserId, ownerUsername, ...row }) => ({
      ...row,
      scopes: JSON.parse(row.scopes) as AgentScope[],
      projectIds: row.projectIds ? row.projectIds.split(",") : [],
      owner: {
        userId: ownerUserId,
        username: ownerUsername,
        isCurrentUser:
          ownerUserId !== null && ownerUserId === input.currentUserId,
      },
    }));
  }

  async update(input: {
    deviceId: string;
    updatedBy: string;
    manageableProjectIds: string[];
    isInstanceAdmin: boolean;
    name?: string;
    accessMode?: "all" | "selected";
    projectIds?: string[];
    scopes?: AgentScope[];
    maxConcurrentSessions?: number;
    expiresAt?: string | null;
    audit?: AuditLogParams;
  }) {
    const manageable = new Set(input.manageableProjectIds);
    const requestedProjects = input.projectIds
      ? [...new Set(input.projectIds)]
      : undefined;
    if (requestedProjects?.some((projectId) => !manageable.has(projectId))) {
      throw Object.assign(new Error("projectIds 包含无权管理的项目"), {
        status: 400,
      });
    }

    let mutation: {
      device: DeviceConfigRow;
      removedGrants: DeviceGrantSnapshot[];
      addedGrantIds: number[];
      createdAccountIds: string[];
      accountStates: AccountStateSnapshot[];
      auditId: number | null;
    } | null = null;

    try {
      const result = this.sqlite.transaction(() => {
        const device = this.sqlite
          .prepare(
            `SELECT id, name, status, access_mode AS accessMode, scopes,
                    max_concurrent_sessions AS maxConcurrentSessions,
                    approved_by_user_id AS approvedByUserId,
                    expires_at AS expiresAt
               FROM agent_devices WHERE id = ? AND status = 'active'`,
          )
          .get(input.deviceId) as DeviceConfigRow | undefined;
        if (!device) return null;

        const grants = this.sqlite
          .prepare(
            `SELECT grant_row.id AS grantId, grant_row.device_id AS deviceId,
                    grant_row.project_id AS projectId,
                    grant_row.service_account_id AS serviceAccountId,
                    grant_row.granted_by AS grantedBy,
                    grant_row.created_at AS createdAt,
                    account.is_active AS accountIsActive,
                    account.updated_at AS accountUpdatedAt
               FROM agent_device_projects grant_row
               JOIN service_accounts account
                 ON account.id = grant_row.service_account_id
              WHERE grant_row.device_id = ?`,
          )
          .all(input.deviceId) as DeviceGrantSnapshot[];
        if (
          !input.isInstanceAdmin &&
          (grants.length === 0 ||
            grants.some((grant) => !manageable.has(grant.projectId)))
        ) {
          return null;
        }

        const accessMode = input.accessMode ?? device.accessMode;
        const currentProjectIds = grants.map((grant) => grant.projectId);
        const desiredProjectIds =
          accessMode === "all"
            ? [...manageable]
            : (requestedProjects ?? currentProjectIds);
        if (
          desiredProjectIds.length === 0 ||
          desiredProjectIds.some((projectId) => !manageable.has(projectId))
        ) {
          throw Object.assign(new Error("至少需要授权一个可管理项目"), {
            status: 400,
          });
        }

        const name = input.name ?? device.name;
        const scopes =
          input.scopes ?? (JSON.parse(device.scopes) as AgentScope[]);
        const maxConcurrentSessions =
          input.maxConcurrentSessions ?? device.maxConcurrentSessions;
        const expiresAt =
          input.expiresAt === undefined ? device.expiresAt : input.expiresAt;
        const approvedByUserId =
          device.accessMode !== "all" && accessMode === "all"
            ? input.updatedBy
            : device.approvedByUserId;
        const now = new Date().toISOString();

        this.sqlite
          .prepare(
            `UPDATE agent_devices
                SET name = ?, access_mode = ?, scopes = ?,
                    max_concurrent_sessions = ?, expires_at = ?,
                    approved_by_user_id = ?
              WHERE id = ? AND status = 'active'`,
          )
          .run(
            name,
            accessMode,
            JSON.stringify(scopes),
            maxConcurrentSessions,
            expiresAt,
            approvedByUserId,
            input.deviceId,
          );

        const desired = new Set(desiredProjectIds);
        const removedGrants = grants.filter(
          (grant) => !desired.has(grant.projectId),
        );
        const existingProjects = new Set(currentProjectIds);
        const addedGrantIds: number[] = [];
        const createdAccountIds: string[] = [];
        const accountStates = new Map<string, AccountStateSnapshot>();

        const rememberAccount = (grant: DeviceGrantSnapshot) => {
          if (!accountStates.has(grant.serviceAccountId)) {
            accountStates.set(grant.serviceAccountId, {
              id: grant.serviceAccountId,
              isActive: grant.accountIsActive,
              updatedAt: grant.accountUpdatedAt,
            });
          }
        };
        for (const grant of removedGrants) {
          rememberAccount(grant);
          this.sqlite
            .prepare("DELETE FROM agent_device_projects WHERE id = ?")
            .run(grant.grantId);
          this.sqlite
            .prepare(
              `UPDATE service_accounts
                  SET is_active = 0, updated_at = ? WHERE id = ?`,
            )
            .run(now, grant.serviceAccountId);
        }

        for (const projectId of desiredProjectIds) {
          if (existingProjects.has(projectId)) continue;
          const accountName = `__device__:${input.deviceId}:${projectId}`;
          const existingAccount = this.sqlite
            .prepare(
              `SELECT id, is_active AS isActive, updated_at AS updatedAt
                 FROM service_accounts
                WHERE project_id = ? AND name = ?`,
            )
            .get(projectId, accountName) as AccountStateSnapshot | undefined;
          let accountId: string;
          if (existingAccount) {
            accountId = existingAccount.id;
            accountStates.set(accountId, existingAccount);
            this.sqlite
              .prepare(
                `UPDATE service_accounts
                    SET is_active = 1, updated_at = ? WHERE id = ?`,
              )
              .run(now, accountId);
          } else {
            accountId = crypto.randomUUID();
            createdAccountIds.push(accountId);
            this.sqlite
              .prepare(
                `INSERT INTO service_accounts
                   (id, project_id, name, created_by, is_active)
                 VALUES (?, ?, ?, ?, 1)`,
              )
              .run(accountId, projectId, accountName, input.updatedBy);
          }
          const grantResult = this.sqlite
            .prepare(
              `INSERT INTO agent_device_projects
                 (device_id, project_id, service_account_id, granted_by)
               VALUES (?, ?, ?, ?)`,
            )
            .run(input.deviceId, projectId, accountId, input.updatedBy);
          addedGrantIds.push(Number(grantResult.lastInsertRowid));
        }

        const auditId = insertDeviceAudit(
          this.sqlite,
          input.audit,
          input.deviceId,
          name,
        );
        mutation = {
          device,
          removedGrants,
          addedGrantIds,
          createdAccountIds,
          accountStates: [...accountStates.values()],
          auditId,
        };
        return {
          id: input.deviceId,
          name,
          accessMode,
          projectIds: desiredProjectIds,
          scopes,
          maxConcurrentSessions,
          expiresAt,
        };
      })();

      if (!result) return null;
      await this.onWrite?.();
      return result;
    } catch (error) {
      let rollbackError: unknown = null;
      if (mutation) {
        this.sqlite.transaction(() => {
          const state = mutation!;
          const deleteGrant = this.sqlite.prepare(
            "DELETE FROM agent_device_projects WHERE id = ?",
          );
          for (const grantId of state.addedGrantIds) deleteGrant.run(grantId);

          const deleteAccount = this.sqlite.prepare(
            "DELETE FROM service_accounts WHERE id = ?",
          );
          for (const accountId of state.createdAccountIds) {
            deleteAccount.run(accountId);
          }
          const restoreAccount = this.sqlite.prepare(
            `UPDATE service_accounts
                SET is_active = ?, updated_at = ? WHERE id = ?`,
          );
          for (const account of state.accountStates) {
            restoreAccount.run(account.isActive, account.updatedAt, account.id);
          }
          const restoreGrant = this.sqlite.prepare(
            `INSERT INTO agent_device_projects
               (id, device_id, project_id, service_account_id, granted_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          );
          for (const grant of state.removedGrants) {
            restoreGrant.run(
              grant.grantId,
              grant.deviceId,
              grant.projectId,
              grant.serviceAccountId,
              grant.grantedBy,
              grant.createdAt,
            );
          }
          this.sqlite
            .prepare(
              `UPDATE agent_devices
                  SET name = ?, access_mode = ?, scopes = ?,
                      max_concurrent_sessions = ?, expires_at = ?,
                      approved_by_user_id = ?
                WHERE id = ?`,
            )
            .run(
              state.device.name,
              state.device.accessMode,
              state.device.scopes,
              state.device.maxConcurrentSessions,
              state.device.expiresAt,
              state.device.approvedByUserId,
              state.device.id,
            );
          if (state.auditId !== null) {
            this.sqlite
              .prepare("DELETE FROM audit_logs WHERE id = ?")
              .run(state.auditId);
          }
        })();
        try {
          await this.onWrite?.();
        } catch (rollbackSaveError) {
          rollbackError = rollbackSaveError;
        }
      }
      throw persistenceFailure(error, rollbackError);
    }
  }

  async revoke(input: {
    deviceId: string;
    manageableProjectIds: string[];
    isInstanceAdmin: boolean;
    audit?: AuditLogParams;
  }): Promise<boolean> {
    const placeholders = input.manageableProjectIds.length
      ? input.manageableProjectIds.map(() => "?").join(",")
      : "NULL";
    const allowed = this.sqlite
      .prepare(
        `SELECT 1
           FROM agent_devices device
          WHERE device.id = ?
            AND (? = 1 OR
                 (? = 1 AND EXISTS (
                    SELECT 1 FROM agent_device_projects visible_grant
                     WHERE visible_grant.device_id = device.id
                 ) AND NOT EXISTS (
                    SELECT 1 FROM agent_device_projects outside_grant
                     WHERE outside_grant.device_id = device.id
                       AND outside_grant.project_id NOT IN (${placeholders})
                 )))
          LIMIT 1`,
      )
      .get(
        input.deviceId,
        input.isInstanceAdmin ? 1 : 0,
        input.manageableProjectIds.length ? 1 : 0,
        ...input.manageableProjectIds,
      );
    if (!allowed) return false;
    let auditId: number | null = null;
    let changed = false;
    const disabledAccountIds: string[] = [];
    try {
      this.sqlite.transaction(() => {
        const result = this.sqlite
          .prepare(
            `UPDATE agent_devices SET status = 'revoked', revoked_at = ?
              WHERE id = ? AND status = 'active'`,
          )
          .run(new Date().toISOString(), input.deviceId);
        changed = result.changes > 0;
        if (changed) {
          const activeAccounts = this.sqlite
            .prepare(
              `SELECT grant_row.service_account_id AS id
                 FROM agent_device_projects grant_row
                 JOIN service_accounts account
                   ON account.id = grant_row.service_account_id
                WHERE grant_row.device_id = ? AND account.is_active = 1`,
            )
            .all(input.deviceId) as Array<{ id: string }>;
          disabledAccountIds.push(...activeAccounts.map((row) => row.id));
          this.sqlite
            .prepare(
              `UPDATE service_accounts SET is_active = 0
                WHERE id IN (
                  SELECT service_account_id FROM agent_device_projects
                   WHERE device_id = ?
                )`,
            )
            .run(input.deviceId);
          auditId = insertDeviceAudit(this.sqlite, input.audit, input.deviceId);
        }
      })();
      if (changed) await this.onWrite?.();
      return changed;
    } catch (error) {
      let rollbackError: unknown = null;
      if (changed) {
        this.sqlite.transaction(() => {
          this.sqlite
            .prepare(
              `UPDATE agent_devices
                  SET status = 'active', revoked_at = NULL
                WHERE id = ?`,
            )
            .run(input.deviceId);
          const restoreAccount = this.sqlite.prepare(
            "UPDATE service_accounts SET is_active = 1 WHERE id = ?",
          );
          for (const accountId of disabledAccountIds) {
            restoreAccount.run(accountId);
          }
          if (auditId !== null) {
            this.sqlite
              .prepare("DELETE FROM audit_logs WHERE id = ?")
              .run(auditId);
          }
        })();
        try {
          await this.onWrite?.();
        } catch (rollbackSaveError) {
          rollbackError = rollbackSaveError;
        }
      }
      throw persistenceFailure(error, rollbackError);
    }
  }
}

function authRequest(req: express.Request): AuthenticatedRequest {
  return req as unknown as AuthenticatedRequest;
}

function stringField(value: unknown, field: string, max = 128): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw Object.assign(new Error(`${field} 无效`), { status: 400 });
  }
  return value.trim();
}

function deviceAdminAuditEntry(
  req: express.Request,
  input: {
    action: string;
    resourceId?: string;
    resourceName?: string;
    details?: Record<string, unknown>;
    success?: boolean;
  },
): AuditLogParams {
  const auth = authRequest(req);
  return {
    userId: auth.userId,
    username: auth.user?.username ?? auth.userId,
    action: input.action,
    resourceType: "agent_device",
    resourceId: input.resourceId,
    resourceName: input.resourceName,
    details: input.details ? JSON.stringify(input.details) : undefined,
    ...getRequestMeta(req),
    success: input.success ?? true,
  };
}

async function auditDeviceAdminAction(
  dependencies: AgentDeviceAdminDependencies,
  req: express.Request,
  input: Parameters<typeof deviceAdminAuditEntry>[1],
) {
  if (!dependencies.audit) return;
  await dependencies.audit(deviceAdminAuditEntry(req, input));
}

async function deviceManagerContext(
  dependencies: AgentDeviceAdminDependencies,
  req: express.Request,
) {
  const auth = authRequest(req);
  const [projects, isInstanceAdmin] = await Promise.all([
    dependencies.listManageableProjects(auth.userId),
    dependencies.isInstanceAdmin(auth.userId),
  ]);
  if (!isInstanceAdmin && projects.length === 0) {
    throw Object.assign(new Error("没有可管理的项目"), { status: 403 });
  }
  return { auth, projects, isInstanceAdmin };
}

function requireRecentMfa(
  dependencies: AgentDeviceAdminDependencies,
  req: express.Request,
  res: express.Response,
): boolean {
  const auth = authRequest(req);
  const enrollment = dependencies.sqlite
    .prepare(
      `SELECT users.totp_enabled AS totpEnabled,
              EXISTS(
                SELECT 1 FROM webauthn_credentials credential
                 WHERE credential.user_id = users.id
              ) AS webauthnEnabled
         FROM users WHERE users.id = ?`,
    )
    .get(auth.userId) as
    | { totpEnabled: number; webauthnEnabled: number }
    | undefined;

  if (!enrollment?.totpEnabled && !enrollment?.webauthnEnabled) {
    res.status(403).json({
      error:
        "请先为账号启用 TOTP 身份验证器，或添加支持指纹、PIN 或设备解锁的通行密钥",
      code: "MFA_ENROLLMENT_REQUIRED",
    });
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  if (
    !Number.isSafeInteger(auth.mfaVerifiedAt) ||
    auth.mfaVerifiedAt! > now + MFA_CLOCK_SKEW_SECONDS ||
    now - auth.mfaVerifiedAt! > MFA_STEP_UP_MAX_AGE_SECONDS
  ) {
    res.status(401).json({
      error: "请使用 TOTP 身份验证器或通行密钥完成二次验证",
      code: "MFA_STEP_UP_REQUIRED",
      methods: [
        ...(enrollment.totpEnabled ? ["totp"] : []),
        ...(enrollment.webauthnEnabled ? ["webauthn"] : []),
      ],
    });
    return false;
  }

  return true;
}

export function createAgentDeviceAdminRouter(
  dependencies: AgentDeviceAdminDependencies,
) {
  const router = express.Router();
  const repository = new AgentDeviceAdminRepository(
    dependencies.sqlite,
    dependencies.onWrite,
  );
  router.use(dependencies.authenticate);
  router.use((req, res, next) => {
    const auth = authRequest(req);
    if (auth.apiKeyId || !auth.sessionId || auth.pendingTOTP) {
      return res.status(401).json({
        error: "设备管理仅允许已完成验证的网页会话访问",
        code: "INTERACTIVE_SESSION_REQUIRED",
      });
    }
    next();
  });
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    next();
  });

  router.get("/devices", async (req, res, next) => {
    try {
      const { auth, projects, isInstanceAdmin } = await deviceManagerContext(
        dependencies,
        req,
      );
      return res.json({
        projects,
        devices: repository.list({
          currentUserId: auth.userId,
          manageableProjectIds: projects.map((project) => project.id),
          isInstanceAdmin,
        }),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/device-requests/resolve", async (req, res, next) => {
    try {
      await deviceManagerContext(dependencies, req);
      const request = repository.resolve(String(req.body?.code || ""));
      await auditDeviceAdminAction(dependencies, req, {
        action: "resolve_agent_device_request",
        resourceId: request?.requestId,
        details: { found: Boolean(request) },
        success: Boolean(request),
      });
      return request
        ? res.json({ request })
        : res.status(404).json({ error: "设备码无效或已过期" });
    } catch (error) {
      next(error);
    }
  });

  router.post("/device-requests/:requestId/approve", async (req, res, next) => {
    try {
      const { auth, projects } = await deviceManagerContext(dependencies, req);
      if (!requireRecentMfa(dependencies, req, res)) return;
      const manageable = new Set(projects.map((project) => project.id));
      if (
        req.body?.accessMode !== "all" &&
        req.body?.accessMode !== "selected"
      ) {
        return res.status(400).json({ error: "accessMode 无效" });
      }
      const accessMode: "all" | "selected" = req.body.accessMode;
      const rawProjectIds = req.body?.projectIds;
      if (
        rawProjectIds !== undefined &&
        (!Array.isArray(rawProjectIds) ||
          rawProjectIds.some(
            (value: unknown) => typeof value !== "string" || !value.trim(),
          ))
      ) {
        return res.status(400).json({ error: "projectIds 无效" });
      }
      const requested = Array.isArray(rawProjectIds)
        ? [...new Set(rawProjectIds.map((value: string) => value.trim()))]
        : [];
      const projectIds: string[] =
        accessMode === "all" ? [...manageable] : requested;
      if (!projectIds.length || projectIds.some((id) => !manageable.has(id))) {
        return res.status(400).json({ error: "projectIds 包含无权管理的项目" });
      }
      const scopes = Array.isArray(req.body?.scopes)
        ? [...new Set(req.body.scopes)]
        : [];
      if (
        !scopes.length ||
        scopes.some(
          (scope) =>
            typeof scope !== "string" ||
            !ALLOWED_SCOPES.has(scope as AgentScope),
        )
      ) {
        return res.status(400).json({ error: "scopes 无效" });
      }
      const concurrency = Number(req.body?.maxConcurrentSessions ?? 1);
      if (
        !Number.isSafeInteger(concurrency) ||
        concurrency < 1 ||
        concurrency > 100
      ) {
        return res.status(400).json({ error: "maxConcurrentSessions 无效" });
      }
      let expiresAt: string | null = null;
      if (req.body?.expiresAt) {
        const expiration = new Date(req.body.expiresAt);
        if (
          !Number.isFinite(expiration.getTime()) ||
          expiration.getTime() <= Date.now()
        ) {
          return res.status(400).json({ error: "expiresAt 必须是未来时间" });
        }
        expiresAt = expiration.toISOString();
      }
      const auditDetails = {
        accessMode,
        projectIds,
        scopes,
        maxConcurrentSessions: concurrency,
        expiresAt,
      };
      const device = await repository.approve({
        requestId: stringField(req.params.requestId, "requestId"),
        approvedBy: auth.userId,
        name:
          req.body?.name === undefined
            ? undefined
            : stringField(req.body.name, "name", 64),
        accessMode,
        projectIds,
        scopes: scopes as AgentScope[],
        maxConcurrentSessions: concurrency,
        expiresAt,
        audit: deviceAdminAuditEntry(req, {
          action: "approve_agent_device",
          details: auditDetails,
        }),
      });
      if (!device) {
        return res.status(404).json({ error: "设备请求不存在或已处理" });
      }
      return res.status(201).json({ device });
    } catch (error) {
      next(error);
    }
  });

  router.post("/device-requests/:requestId/deny", async (req, res, next) => {
    try {
      await deviceManagerContext(dependencies, req);
      const requestId = stringField(req.params.requestId, "requestId");
      if (
        !(await repository.deny(
          requestId,
          deviceAdminAuditEntry(req, {
            action: "deny_agent_device",
            resourceId: requestId,
          }),
        ))
      ) {
        return res.status(404).json({ error: "设备请求不存在或已处理" });
      }
      return res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.patch("/devices/:deviceId", async (req, res, next) => {
    try {
      const { auth, projects, isInstanceAdmin } = await deviceManagerContext(
        dependencies,
        req,
      );
      if (!requireRecentMfa(dependencies, req, res)) return;
      const body = req.body as Record<string, unknown> | undefined;
      const has = (field: string) =>
        Boolean(body && Object.prototype.hasOwnProperty.call(body, field));
      const supportedFields = [
        "name",
        "accessMode",
        "projectIds",
        "scopes",
        "maxConcurrentSessions",
        "expiresAt",
      ];
      if (!supportedFields.some(has)) {
        return res.status(400).json({ error: "没有可更新的设备字段" });
      }

      let name: string | undefined;
      if (has("name")) name = stringField(body?.name, "name", 64);

      let accessMode: "all" | "selected" | undefined;
      if (has("accessMode")) {
        if (body?.accessMode !== "all" && body?.accessMode !== "selected") {
          return res.status(400).json({ error: "accessMode 无效" });
        }
        accessMode = body.accessMode;
      }

      let projectIds: string[] | undefined;
      if (has("projectIds")) {
        if (
          !Array.isArray(body?.projectIds) ||
          body.projectIds.some(
            (projectId) => typeof projectId !== "string" || !projectId.trim(),
          )
        ) {
          return res.status(400).json({ error: "projectIds 无效" });
        }
        projectIds = [
          ...new Set(body.projectIds.map((projectId) => projectId.trim())),
        ];
        const manageable = new Set(projects.map((project) => project.id));
        if (projectIds.some((projectId) => !manageable.has(projectId))) {
          return res
            .status(400)
            .json({ error: "projectIds 包含无权管理的项目" });
        }
      }

      let scopes: AgentScope[] | undefined;
      if (has("scopes")) {
        if (
          !Array.isArray(body?.scopes) ||
          body.scopes.length === 0 ||
          body.scopes.some(
            (scope) =>
              typeof scope !== "string" ||
              !ALLOWED_SCOPES.has(scope as AgentScope),
          )
        ) {
          return res.status(400).json({ error: "scopes 无效" });
        }
        scopes = [...new Set(body.scopes)] as AgentScope[];
      }

      let maxConcurrentSessions: number | undefined;
      if (has("maxConcurrentSessions")) {
        maxConcurrentSessions = Number(body?.maxConcurrentSessions);
        if (
          !Number.isSafeInteger(maxConcurrentSessions) ||
          maxConcurrentSessions < 1 ||
          maxConcurrentSessions > 100
        ) {
          return res.status(400).json({ error: "maxConcurrentSessions 无效" });
        }
      }

      let expiresAt: string | null | undefined;
      if (has("expiresAt")) {
        if (body?.expiresAt === null || body?.expiresAt === "") {
          expiresAt = null;
        } else if (typeof body?.expiresAt === "string") {
          const expiration = new Date(body.expiresAt);
          if (
            !Number.isFinite(expiration.getTime()) ||
            expiration.getTime() <= Date.now()
          ) {
            return res.status(400).json({ error: "expiresAt 必须是未来时间" });
          }
          expiresAt = expiration.toISOString();
        } else {
          return res.status(400).json({ error: "expiresAt 无效" });
        }
      }

      const deviceId = stringField(req.params.deviceId, "deviceId");
      const changes = {
        name,
        accessMode,
        projectIds,
        scopes,
        maxConcurrentSessions,
        expiresAt,
      };
      const device = await repository.update({
        deviceId,
        updatedBy: auth.userId,
        manageableProjectIds: projects.map((project) => project.id),
        isInstanceAdmin,
        ...changes,
        audit: deviceAdminAuditEntry(req, {
          action: "update_agent_device",
          resourceId: deviceId,
          details: changes,
        }),
      });
      if (!device) return res.status(404).json({ error: "设备不存在" });
      return res.json({ device });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/devices/:deviceId", async (req, res, next) => {
    try {
      const { projects, isInstanceAdmin } = await deviceManagerContext(
        dependencies,
        req,
      );
      if (!requireRecentMfa(dependencies, req, res)) return;
      const deviceId = stringField(req.params.deviceId, "deviceId");
      if (
        !(await repository.revoke({
          deviceId,
          manageableProjectIds: projects.map((project) => project.id),
          isInstanceAdmin,
          audit: deviceAdminAuditEntry(req, {
            action: "revoke_agent_device",
            resourceId: deviceId,
          }),
        }))
      ) {
        return res.status(404).json({ error: "设备不存在" });
      }
      return res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: unknown,
    ) => {
      void _next;
      const shaped = error as { status?: number; message?: string };
      res.status(shaped.status ?? 500).json({
        error: shaped.status ? shaped.message : "设备管理操作失败",
        code: "DEVICE_ADMIN_ERROR",
      });
    },
  );
  return router;
}
