import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";
import type Database from "better-sqlite3";
import type { AgentPrincipal, AgentScope, AgentTokenRecord } from "./types.js";
import { PermissionManager } from "../utils/permission-manager.js";
import { createCurrentProjectRepository } from "../control-plane/factory.js";

const SCRYPT_KEY_LENGTH = 32;

export interface AgentAuthenticatedRequest extends Request {
  agentPrincipal?: AgentPrincipal;
  agentTokenId?: string;
  agentDeviceId?: string;
  rawBody?: Buffer;
  agentOperationDispatched?: boolean;
  agentOperationCommitted?: boolean;
}

export interface AgentCredentialStore {
  findActiveByPrefix(prefix: string): Promise<AgentTokenRecord[]>;
  touch(tokenId: string, timestamp: string): Promise<void>;
}

export async function hashAgentToken(
  token: string,
  salt = crypto.randomBytes(16).toString("base64url"),
): Promise<{ salt: string; hash: string }> {
  const key = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(token, salt, SCRYPT_KEY_LENGTH, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
  return { salt, hash: key.toString("base64url") };
}

async function verifyAgentToken(
  token: string,
  salt: string,
  expectedHash: string,
): Promise<boolean> {
  const actual = Buffer.from(
    (await hashAgentToken(token, salt)).hash,
    "base64url",
  );
  const expected = Buffer.from(expectedHash, "base64url");
  return (
    actual.length === expected.length &&
    crypto.timingSafeEqual(actual, expected)
  );
}

export class MemoryAgentCredentialStore implements AgentCredentialStore {
  constructor(public readonly records: AgentTokenRecord[] = []) {}

  async findActiveByPrefix(prefix: string): Promise<AgentTokenRecord[]> {
    return this.records.filter(
      (record) => record.active && record.tokenPrefix === prefix,
    );
  }

  async touch(tokenId: string, timestamp: string): Promise<void> {
    const record = this.records.find((candidate) => candidate.id === tokenId);
    if (record) record.lastUsedAt = timestamp;
  }
}

interface SqliteTokenRow {
  id: string;
  serviceAccountId: string;
  projectId: string;
  tokenName: string;
  accessMode: "all" | "selected";
  createdByUserId: string | null;
  tokenPrefix: string;
  tokenSalt: string;
  tokenHash: string;
  scopes: string;
  maxConcurrentSessions: number;
  expiresAt: string | null;
  lastUsedAt: string | null;
  projectGrants: string | null;
}

const KNOWN_SCOPES = new Set<AgentScope>([
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

export class SqliteAgentCredentialStore implements AgentCredentialStore {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly onWrite?: () => void | Promise<void>,
    private readonly resolveManageableProjectIds: (
      userId: string,
    ) => Promise<string[]> = async (userId) => {
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
        .map((project) => project.id);
    },
  ) {}

  async findActiveByPrefix(prefix: string): Promise<AgentTokenRecord[]> {
    const rows = this.sqlite
      .prepare(
        `SELECT
           token.id,
           token.service_account_id AS serviceAccountId,
           token.project_id AS projectId,
           token.name AS tokenName,
           token.access_mode AS accessMode,
           token.created_by_user_id AS createdByUserId,
           token.token_prefix AS tokenPrefix,
           token.token_salt AS tokenSalt,
           token.token_hash AS tokenHash,
           token.scopes,
           token.max_concurrent_sessions AS maxConcurrentSessions,
           token.expires_at AS expiresAt,
           token.last_used_at AS lastUsedAt,
           GROUP_CONCAT(DISTINCT token_project.project_id || '=' ||
             COALESCE(token_project.service_account_id, '')) AS projectGrants
         FROM agent_access_tokens token
         JOIN service_accounts account
           ON account.id = token.service_account_id
         LEFT JOIN agent_token_projects token_project
           ON token_project.token_id = token.id
         WHERE token.token_prefix = ?
           AND token.is_active = 1
           AND token.revoked_at IS NULL
           AND account.is_active = 1
         GROUP BY token.id`,
      )
      .all(prefix) as SqliteTokenRow[];

    return Promise.all(
      rows.map(async (row) => {
        let scopes: AgentScope[] = [];
        try {
          const parsed = JSON.parse(row.scopes) as unknown[];
          scopes = parsed.filter(
            (scope): scope is AgentScope =>
              typeof scope === "string" &&
              KNOWN_SCOPES.has(scope as AgentScope),
          );
        } catch {
          scopes = [];
        }
        const grants = new Map<string, string>();
        for (const encoded of row.projectGrants?.split(",") ?? []) {
          const separator = encoded.indexOf("=");
          if (separator > 0) {
            grants.set(
              encoded.slice(0, separator),
              encoded.slice(separator + 1),
            );
          }
        }
        if (!grants.has(row.projectId)) {
          grants.set(row.projectId, row.serviceAccountId);
        }
        const grantedProjectIds = [...grants.keys()];
        let manageableProjectIds = grantedProjectIds;
        if (row.createdByUserId) {
          manageableProjectIds = await this.resolveManageableProjectIds(
            row.createdByUserId,
          );
        }
        const projectIds =
          row.accessMode === "all"
            ? manageableProjectIds
            : grantedProjectIds.filter((id) =>
                manageableProjectIds.includes(id),
              );
        if (row.accessMode === "all" && row.createdByUserId) {
          let changed = false;
          this.sqlite.transaction(() => {
            for (const projectId of projectIds) {
              if (grants.get(projectId)) continue;
              const proposedServiceAccountId = crypto.randomUUID();
              const now = new Date().toISOString();
              const internalName = `__token__:${row.id}:${projectId}`;
              this.sqlite
                .prepare(
                  `INSERT OR IGNORE INTO service_accounts (
                   id, project_id, name, description, created_by,
                   is_active, created_at, updated_at
                 ) VALUES (?, ?, ?, NULL, ?, 1, ?, ?)`,
                )
                .run(
                  proposedServiceAccountId,
                  projectId,
                  internalName,
                  row.createdByUserId,
                  now,
                  now,
                );
              const identity = this.sqlite
                .prepare(
                  `SELECT id FROM service_accounts
                  WHERE project_id = ? AND name = ?`,
                )
                .get(projectId, internalName) as { id: string } | undefined;
              if (!identity)
                throw new Error("Agent internal identity is missing");
              this.sqlite
                .prepare(
                  `INSERT OR IGNORE INTO agent_token_projects
                   (token_id, project_id, service_account_id, granted_by)
                 VALUES (?, ?, ?, ?)`,
                )
                .run(row.id, projectId, identity.id, row.createdByUserId);
              grants.set(projectId, identity.id);
              changed = true;
            }
          })();
          if (changed) await this.onWrite?.();
        }
        const serverProjectIds: Record<string, string> = {};
        const serverServiceAccountIds: Record<string, string> = {};
        if (projectIds.length > 0) {
          const placeholders = projectIds.map(() => "?").join(",");
          const hosts = this.sqlite
            .prepare(
              `SELECT CAST(id AS TEXT) AS serverId, project_id AS projectId
               FROM project_hosts WHERE project_id IN (${placeholders})`,
            )
            .all(...projectIds) as Array<{
            serverId: string;
            projectId: string;
          }>;
          for (const host of hosts) {
            serverProjectIds[host.serverId] = host.projectId;
            serverServiceAccountIds[host.serverId] =
              grants.get(host.projectId) ?? row.serviceAccountId;
          }
        }
        return {
          id: row.id,
          principalId: `token:${row.id}`,
          serviceAccountId: row.serviceAccountId,
          serviceAccountIds: [
            ...new Set(
              [row.serviceAccountId, ...grants.values()].filter(Boolean),
            ),
          ],
          projectId: row.projectId,
          projectIds,
          projectServiceAccountIds: Object.fromEntries(
            projectIds.flatMap((id) => {
              const accountId = grants.get(id);
              return accountId ? [[id, accountId]] : [];
            }),
          ),
          name: row.tokenName,
          scopes,
          serverIds: Object.keys(serverProjectIds),
          serverProjectIds,
          serverServiceAccountIds,
          maxConcurrentSessions: row.maxConcurrentSessions,
          tokenPrefix: row.tokenPrefix,
          tokenSalt: row.tokenSalt,
          tokenHash: row.tokenHash,
          expiresAt: row.expiresAt,
          active: true,
          lastUsedAt: row.lastUsedAt,
        };
      }),
    );
  }

  async touch(tokenId: string, timestamp: string): Promise<void> {
    this.sqlite
      .prepare("UPDATE agent_access_tokens SET last_used_at = ? WHERE id = ?")
      .run(timestamp, tokenId);
    await this.onWrite?.();
  }
}

export function createAgentAuthMiddleware(store: AgentCredentialStore) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authorization = req.header("authorization");
    if (!authorization?.startsWith("Bearer ")) {
      res
        .status(401)
        .json({ error: "缺少 Agent Token", code: "MISSING_TOKEN" });
      return;
    }

    const token = authorization.slice(7).trim();
    if (!token.startsWith("cssh_") || token.length < 24) {
      res
        .status(401)
        .json({ error: "Agent Token 无效", code: "INVALID_TOKEN" });
      return;
    }

    try {
      const candidates = await store.findActiveByPrefix(token.slice(0, 13));
      let matched: AgentTokenRecord | undefined;
      for (const candidate of candidates) {
        if (
          await verifyAgentToken(
            token,
            candidate.tokenSalt,
            candidate.tokenHash,
          )
        ) {
          matched = candidate;
          break;
        }
      }
      if (!matched) {
        res
          .status(401)
          .json({ error: "Agent Token 无效", code: "INVALID_TOKEN" });
        return;
      }
      if (matched.expiresAt && Date.parse(matched.expiresAt) <= Date.now()) {
        res
          .status(401)
          .json({ error: "Agent Token 已过期", code: "TOKEN_EXPIRED" });
        return;
      }

      const authReq = req as AgentAuthenticatedRequest;
      authReq.agentTokenId = matched.id;
      authReq.agentPrincipal = {
        principalId: matched.principalId,
        serviceAccountId: matched.serviceAccountId,
        serviceAccountIds: matched.serviceAccountIds,
        projectId: matched.projectId,
        projectIds: matched.projectIds ?? [matched.projectId],
        projectServiceAccountIds: matched.projectServiceAccountIds,
        name: matched.name,
        scopes: matched.scopes,
        serverIds: matched.serverIds,
        serverProjectIds: matched.serverProjectIds,
        serverServiceAccountIds: matched.serverServiceAccountIds,
        maxConcurrentSessions: matched.maxConcurrentSessions,
      };
      void store
        .touch(matched.id, new Date().toISOString())
        .catch(() => undefined);
      next();
    } catch {
      res.status(500).json({ error: "Agent 鉴权失败", code: "AUTH_FAILED" });
    }
  };
}
