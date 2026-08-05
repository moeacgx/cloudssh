import crypto from "crypto";
import type Database from "better-sqlite3";
import express, { type RequestHandler } from "express";
import type { AuthenticatedRequest } from "../../types/index.js";
import { createCurrentProjectRepository } from "../control-plane/factory.js";
import { AuthManager } from "../utils/auth-manager.js";
import { PermissionManager } from "../utils/permission-manager.js";
import { hashAgentToken } from "./auth.js";
import type { AgentScope } from "./types.js";

const ALLOWED_SCOPES = new Set<AgentScope>([
  "sessions:create",
  "sessions:read",
  "sessions:write",
  "sessions:close",
  "jobs:execute",
  "files:read",
  "files:write",
]);

export interface AgentTokenAdminDependencies {
  sqlite: Database.Database;
  authenticate: RequestHandler;
  listManageableProjects(
    userId: string,
  ): Promise<Array<{ id: string; name: string }>>;
  isInstanceAdmin(userId: string): Promise<boolean>;
  onWrite?: () => void | Promise<void>;
}

export function defaultAgentTokenAdminDependencies(
  sqlite: Database.Database,
  onWrite?: () => void | Promise<void>,
): AgentTokenAdminDependencies {
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
    onWrite,
  };
}

export class AgentTokenAdminRepository {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly onWrite?: () => void | Promise<void>,
  ) {}

  async listTokens(input: {
    userId: string;
    manageableProjectIds: string[];
    isInstanceAdmin: boolean;
  }) {
    const projectFilter = input.manageableProjectIds.length
      ? input.manageableProjectIds.map(() => "?").join(",")
      : "NULL";
    const tokens = this.sqlite
      .prepare(
        `SELECT token.id, token.name, token.token_prefix AS tokenPrefix,
                token.scopes, token.access_mode AS accessMode,
                token.max_concurrent_sessions AS maxConcurrentSessions,
                token.is_active AS isActive, token.expires_at AS expiresAt,
                token.last_used_at AS lastUsedAt, token.created_at AS createdAt,
                token.revoked_at AS revokedAt,
                GROUP_CONCAT(DISTINCT grant_row.project_id) AS projectIds
           FROM agent_access_tokens token
           LEFT JOIN agent_token_projects grant_row ON grant_row.token_id = token.id
          WHERE (? = 1 OR token.created_by_user_id = ?
                 OR grant_row.project_id IN (${projectFilter}))
          GROUP BY token.id
          ORDER BY token.created_at DESC`,
      )
      .all(
        input.isInstanceAdmin ? 1 : 0,
        input.userId,
        ...input.manageableProjectIds,
      ) as Array<
      Record<string, unknown> & {
        scopes: string;
        accessMode: "all" | "selected";
        projectIds: string | null;
      }
    >;
    return tokens.map((token) => ({
      ...token,
      scopes: JSON.parse(token.scopes) as AgentScope[],
      projectIds: token.projectIds ? token.projectIds.split(",") : [],
    }));
  }

  async createToken(input: {
    createdBy: string;
    name: string;
    scopes: AgentScope[];
    accessMode: "all" | "selected";
    projectIds: string[];
    maxConcurrentSessions: number;
    expiresAt: string | null;
  }) {
    const uniqueProjectIds = [...new Set(input.projectIds)];
    if (uniqueProjectIds.length === 0) return null;

    const rawToken = `cssh_${crypto.randomBytes(32).toString("base64url")}`;
    const hashed = await hashAgentToken(rawToken);
    const id = crypto.randomUUID();
    const originProjectId = uniqueProjectIds[0];
    const now = new Date().toISOString();
    this.sqlite.transaction(() => {
      // 会话和审计仍引用旧 service_account_id 外键，因此每个项目维护一个
      // 完全不可见的兼容身份。用户只创建、查看和撤销 Token。
      const serviceAccounts = new Map<string, string>();
      const createInternalIdentity = (projectId: string) => {
        const serviceAccountId = crypto.randomUUID();
        this.sqlite
          .prepare(
            `INSERT INTO service_accounts (
               id, project_id, name, description, created_by,
               is_active, created_at, updated_at
             ) VALUES (?, ?, ?, NULL, ?, 1, ?, ?)`,
          )
          .run(
            serviceAccountId,
            projectId,
            `__token__:${id}:${projectId}`,
            input.createdBy,
            now,
            now,
          );
        serviceAccounts.set(projectId, serviceAccountId);
        return serviceAccountId;
      };
      const originIdentity = createInternalIdentity(originProjectId);
      this.sqlite
        .prepare(
          `INSERT INTO agent_access_tokens (
             id, project_id, service_account_id, name, token_prefix,
             token_hash, token_salt, scopes, max_concurrent_sessions,
             access_mode, created_by_user_id, is_active, expires_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          id,
          originProjectId,
          originIdentity,
          input.name,
          rawToken.slice(0, 13),
          hashed.hash,
          hashed.salt,
          JSON.stringify(input.scopes),
          input.maxConcurrentSessions,
          input.accessMode,
          input.createdBy,
          input.expiresAt,
          now,
        );
      const grant = this.sqlite.prepare(
        `INSERT INTO agent_token_projects
           (token_id, project_id, service_account_id, granted_by)
         VALUES (?, ?, ?, ?)`,
      );
      for (const projectId of uniqueProjectIds) {
        grant.run(
          id,
          projectId,
          serviceAccounts.get(projectId) ?? createInternalIdentity(projectId),
          input.createdBy,
        );
      }
    })();
    await this.onWrite?.();
    return {
      id,
      name: input.name,
      tokenPrefix: rawToken.slice(0, 13),
      token: rawToken,
      scopes: input.scopes,
      accessMode: input.accessMode,
      projectIds: uniqueProjectIds,
      maxConcurrentSessions: input.maxConcurrentSessions,
      expiresAt: input.expiresAt,
      createdAt: now,
    };
  }

  async revokeToken(input: {
    tokenId: string;
    userId: string;
    manageableProjectIds: string[];
    isInstanceAdmin: boolean;
  }): Promise<boolean> {
    const manageable = new Set(input.manageableProjectIds);
    const token = this.sqlite
      .prepare(
        `SELECT token.created_by_user_id AS createdByUserId,
                GROUP_CONCAT(grant_row.project_id) AS projectIds
           FROM agent_access_tokens token
           LEFT JOIN agent_token_projects grant_row ON grant_row.token_id = token.id
          WHERE token.id = ?
          GROUP BY token.id`,
      )
      .get(input.tokenId) as
      | { createdByUserId: string | null; projectIds: string | null }
      | undefined;
    if (!token) return false;
    const allowed =
      input.isInstanceAdmin ||
      token.createdByUserId === input.userId ||
      (token.projectIds?.split(",").some((id) => manageable.has(id)) ?? false);
    if (!allowed) return false;

    const result = this.sqlite
      .prepare(
        `UPDATE agent_access_tokens
            SET is_active = 0, revoked_at = ?
          WHERE id = ? AND revoked_at IS NULL`,
      )
      .run(new Date().toISOString(), input.tokenId);
    if (result.changes > 0) await this.onWrite?.();
    return result.changes > 0;
  }
}

function bodyString(value: unknown, field: string, maximum = 128): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw Object.assign(new Error(`${field} 无效`), { status: 400 });
  }
  return value.trim();
}

function authenticatedRequest(req: express.Request): AuthenticatedRequest {
  return req as unknown as AuthenticatedRequest;
}

export function createAgentTokenAdminRouter(
  dependencies: AgentTokenAdminDependencies,
) {
  const router = express.Router();
  const repository = new AgentTokenAdminRepository(
    dependencies.sqlite,
    dependencies.onWrite,
  );
  router.use(dependencies.authenticate);
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    next();
  });

  const manageableProjects = (req: AuthenticatedRequest) =>
    dependencies.listManageableProjects(req.userId);

  router.get("/tokens", async (req, res, next) => {
    try {
      const authReq = authenticatedRequest(req);
      const projects = await manageableProjects(authReq);
      const tokens = await repository.listTokens({
        userId: authReq.userId,
        manageableProjectIds: projects.map((project) => project.id),
        isInstanceAdmin: await dependencies.isInstanceAdmin(authReq.userId),
      });
      return res.json({ projects, tokens });
    } catch (error) {
      next(error);
    }
  });

  router.post("/tokens", async (req, res, next) => {
    try {
      const authReq = authenticatedRequest(req);
      const projects = await manageableProjects(authReq);
      const manageableIds = new Set(projects.map((project) => project.id));
      if (manageableIds.size === 0) {
        return res.status(403).json({ error: "没有可授权的项目" });
      }
      const accessMode = req.body?.accessMode === "all" ? "all" : "selected";
      const requestedProjectIds: string[] = Array.isArray(req.body?.projectIds)
        ? req.body.projectIds.filter(
            (value: unknown): value is string =>
              typeof value === "string" && value.length > 0,
          )
        : [];
      const projectIds: string[] =
        accessMode === "all"
          ? [...manageableIds]
          : [...new Set(requestedProjectIds)];
      if (
        projectIds.length === 0 ||
        projectIds.some((id) => !manageableIds.has(id))
      ) {
        return res.status(400).json({ error: "projectIds 包含无权管理的项目" });
      }
      const scopes = Array.isArray(req.body?.scopes)
        ? [...new Set(req.body.scopes)]
        : [];
      if (
        scopes.length === 0 ||
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
      if (req.body?.expiresAt !== undefined && req.body.expiresAt !== null) {
        const expiration = new Date(req.body.expiresAt);
        if (
          !Number.isFinite(expiration.getTime()) ||
          expiration.getTime() <= Date.now()
        ) {
          return res.status(400).json({ error: "expiresAt 必须是未来时间" });
        }
        expiresAt = expiration.toISOString();
      }
      const token = await repository.createToken({
        createdBy: authReq.userId,
        name: bodyString(req.body?.name, "name"),
        scopes: scopes as AgentScope[],
        accessMode,
        projectIds,
        maxConcurrentSessions: concurrency,
        expiresAt,
      });
      if (!token) return res.status(400).json({ error: "无法创建 Token" });
      return res.status(201).json({ token });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/tokens/:tokenId", async (req, res, next) => {
    try {
      const authReq = authenticatedRequest(req);
      const projects = await manageableProjects(authReq);
      const revoked = await repository.revokeToken({
        tokenId: bodyString(req.params.tokenId, "tokenId"),
        userId: authReq.userId,
        manageableProjectIds: projects.map((project) => project.id),
        isInstanceAdmin: await dependencies.isInstanceAdmin(authReq.userId),
      });
      if (!revoked) return res.status(404).json({ error: "Token 不存在" });
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
      _next: express.NextFunction,
    ) => {
      void _next;
      const shaped = error as {
        status?: number;
        message?: string;
        code?: string;
      };
      res.status(shaped.status ?? 500).json({
        error: shaped.status ? shaped.message : "Token 管理操作失败",
        code: shaped.code ?? "TOKEN_ADMIN_ERROR",
      });
    },
  );
  return router;
}
