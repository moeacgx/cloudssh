import type Database from "better-sqlite3";
import express, { type RequestHandler } from "express";
import type { AuthenticatedRequest } from "../../types/index.js";
import { AuthManager } from "../utils/auth-manager.js";
import {
  getRequestMeta,
  logAuditOrThrow,
  type AuditLogParams,
} from "../utils/audit-logger.js";
import { PermissionManager } from "../utils/permission-manager.js";
import { apiLogger } from "../utils/logger.js";
import type { AgentSessionBroker } from "./broker.js";
import { AgentApiError, isAgentApiError } from "./errors.js";
import { getAgentSessionBroker } from "./runtime-registry.js";
import type {
  AgentPrincipal,
  AgentSessionRuntimeMode,
  AgentSessionState,
} from "./types.js";

export interface AgentSessionAdminTarget {
  id: string;
  projectId: string;
  projectHostId: number;
  hostId: number;
  serviceAccountId: string;
  state: AgentSessionState;
  runtimeMode: AgentSessionRuntimeMode;
}

type AgentSessionCloser = Pick<AgentSessionBroker, "close">;

export interface AgentSessionAdminDependencies {
  sqlite: Database.Database;
  authenticate: RequestHandler;
  canAccessProjectHost(
    userId: string,
    hostId: number,
    projectHostId: number,
  ): Promise<boolean>;
  getBroker(): AgentSessionCloser | null;
  audit(entry: AuditLogParams): Promise<void>;
}

interface AgentSessionAdminRow {
  id: string;
  projectId: string;
  projectHostId: number;
  linkedProjectId: string | null;
  hostId: number | null;
  ownerUserId: string | null;
  serviceAccountId: string | null;
  state: AgentSessionState;
  runtimeMode: AgentSessionRuntimeMode;
}

function findAgentSessionTarget(
  sqlite: Database.Database,
  sessionId: string,
): AgentSessionAdminTarget | null {
  const row = sqlite
    .prepare(
      `SELECT session.id,
              session.project_id AS projectId,
              session.project_host_id AS projectHostId,
              project_host.project_id AS linkedProjectId,
              project_host.host_id AS hostId,
              session.owner_user_id AS ownerUserId,
              session.service_account_id AS serviceAccountId,
              session.state,
              session.runtime_mode AS runtimeMode
         FROM persistent_sessions session
         LEFT JOIN project_hosts project_host
           ON project_host.id = session.project_host_id
        WHERE session.id = ?
          AND session.owner_user_id IS NULL`,
    )
    .get(sessionId) as AgentSessionAdminRow | undefined;
  if (
    !row?.serviceAccountId ||
    row.ownerUserId !== null ||
    row.linkedProjectId !== row.projectId ||
    !Number.isSafeInteger(row.projectHostId) ||
    row.projectHostId <= 0 ||
    !Number.isSafeInteger(row.hostId) ||
    row.hostId! <= 0
  ) {
    return null;
  }
  return {
    id: row.id,
    projectId: row.projectId,
    projectHostId: row.projectHostId,
    hostId: row.hostId!,
    serviceAccountId: row.serviceAccountId,
    state: row.state,
    runtimeMode: row.runtimeMode,
  };
}

function authenticatedRequest(req: express.Request): AuthenticatedRequest {
  return req as AuthenticatedRequest;
}

function requestSessionId(req: express.Request): string {
  const raw = Array.isArray(req.params.sessionId)
    ? req.params.sessionId[0]
    : req.params.sessionId;
  if (typeof raw !== "string" || !raw.trim() || raw.length > 128) {
    throw new AgentApiError(400, "INVALID_SESSION_ID", "会话 ID 无效");
  }
  return raw.trim();
}

function requestSessionIdForAudit(req: express.Request): string | undefined {
  try {
    return requestSessionId(req);
  } catch {
    return undefined;
  }
}

function browserClosePrincipal(
  userId: string,
  username: string,
  target: AgentSessionAdminTarget,
): AgentPrincipal {
  const serverId = String(target.projectHostId);
  return {
    principalId: `web-user:${userId}:close`,
    serviceAccountId: target.serviceAccountId,
    serviceAccountIds: [target.serviceAccountId],
    projectId: target.projectId,
    projectIds: [target.projectId],
    projectServiceAccountIds: {
      [target.projectId]: target.serviceAccountId,
    },
    name: username,
    scopes: ["sessions:close"],
    serverIds: [serverId],
    serverProjectIds: { [serverId]: target.projectId },
    serverServiceAccountIds: {
      [serverId]: target.serviceAccountId,
    },
    maxConcurrentSessions: 1,
  };
}

const SAFE_SERVER_ERROR_CODES = new Set([
  "AGENT_BROKER_UNAVAILABLE",
  "SESSION_DRIVER_UNAVAILABLE",
  "AGENT_SHUTTING_DOWN",
  "AUDIT_UNAVAILABLE",
]);

function publicCloseError(error: unknown): AgentApiError {
  if (
    isAgentApiError(error) &&
    (error.status < 500 || SAFE_SERVER_ERROR_CODES.has(error.code))
  ) {
    return error;
  }
  return new AgentApiError(
    500,
    "AGENT_SESSION_CLOSE_FAILED",
    "Agent 会话关闭失败，请稍后重试",
  );
}

async function auditClose(
  dependencies: AgentSessionAdminDependencies,
  req: express.Request,
  sessionId: string | undefined,
  target: AgentSessionAdminTarget | null,
  stage: "intent" | "result",
  success: boolean,
  error?: AgentApiError,
): Promise<void> {
  const auth = authenticatedRequest(req);
  await dependencies.audit({
    userId: auth.userId,
    username: auth.user?.username ?? auth.userId,
    action:
      stage === "intent"
        ? "web_agent_session_close_intent"
        : "web_agent_session_close",
    resourceType: "agent_session",
    resourceId: sessionId,
    details: JSON.stringify({
      stage,
      ...(target
        ? {
            projectId: target.projectId,
            projectHostId: target.projectHostId,
            hostId: target.hostId,
            runtimeMode: target.runtimeMode,
            previousState: target.state,
          }
        : {}),
      ...(error ? { errorCode: error.code } : {}),
    }),
    ...getRequestMeta(req),
    success,
    errorMessage: error?.message,
  });
}

async function auditCloseIntent(
  dependencies: AgentSessionAdminDependencies,
  req: express.Request,
  sessionId: string,
  target: AgentSessionAdminTarget,
): Promise<void> {
  try {
    await auditClose(dependencies, req, sessionId, target, "intent", true);
  } catch (error) {
    apiLogger.error("Agent session close intent audit failed", error, {
      operation: "web_agent_session_close_intent",
      userId: authenticatedRequest(req).userId,
      sessionId,
    });
    throw new AgentApiError(
      503,
      "AUDIT_UNAVAILABLE",
      "审计服务暂不可用，请稍后重试",
    );
  }
}

async function auditCloseResult(
  dependencies: AgentSessionAdminDependencies,
  req: express.Request,
  sessionId: string | undefined,
  target: AgentSessionAdminTarget | null,
  success: boolean,
  error?: AgentApiError,
): Promise<void> {
  try {
    await auditClose(
      dependencies,
      req,
      sessionId,
      target,
      "result",
      success,
      error,
    );
  } catch (auditError) {
    apiLogger.error("Agent session close result audit failed", auditError, {
      operation: "web_agent_session_close",
      userId: authenticatedRequest(req).userId,
      sessionId,
      success,
    });
  }
}

export function defaultAgentSessionAdminDependencies(
  sqlite: Database.Database,
): AgentSessionAdminDependencies {
  return {
    sqlite,
    authenticate: AuthManager.getInstance().createAuthMiddleware(),
    canAccessProjectHost: async (userId, hostId, projectHostId) => {
      const access = await PermissionManager.getInstance().canAccessHost(
        userId,
        hostId,
        "connect",
        projectHostId,
      );
      return access.hasAccess;
    },
    getBroker: getAgentSessionBroker,
    audit: logAuditOrThrow,
  };
}

export function createAgentSessionAdminRouter(
  dependencies: AgentSessionAdminDependencies,
) {
  const router = express.Router();

  router.post(
    "/sessions/:sessionId/close",
    dependencies.authenticate,
    async (req, res) => {
      const auth = authenticatedRequest(req);
      res.setHeader("Cache-Control", "private, no-store");
      if (auth.apiKeyId || !auth.sessionId || auth.pendingTOTP) {
        const rejected = new AgentApiError(
          401,
          "INTERACTIVE_SESSION_REQUIRED",
          "Agent 会话管理仅允许已完成验证的网页会话访问",
        );
        await auditCloseResult(
          dependencies,
          req,
          requestSessionIdForAudit(req),
          null,
          false,
          rejected,
        );
        return res.status(401).json({
          error: rejected.message,
          code: rejected.code,
        });
      }

      let sessionId: string | undefined;
      let target: AgentSessionAdminTarget | null = null;
      try {
        sessionId = requestSessionId(req);
        target = findAgentSessionTarget(dependencies.sqlite, sessionId);
        if (!target) {
          throw new AgentApiError(
            404,
            "AGENT_SESSION_NOT_FOUND",
            "Agent 会话不存在",
          );
        }
        const allowed = await dependencies.canAccessProjectHost(
          auth.userId,
          target.hostId,
          target.projectHostId,
        );
        if (!allowed) {
          throw new AgentApiError(
            403,
            "AGENT_SESSION_ACCESS_DENIED",
            "当前用户无权操作该项目主机",
          );
        }
        const broker = dependencies.getBroker();
        if (!broker) {
          throw new AgentApiError(
            503,
            "AGENT_BROKER_UNAVAILABLE",
            "Agent Broker 暂不可用，请稍后重试",
          );
        }
        await auditCloseIntent(dependencies, req, sessionId, target);
        await broker.close(
          browserClosePrincipal(
            auth.userId,
            auth.user?.username ?? auth.userId,
            target,
          ),
          sessionId,
        );
        await auditCloseResult(dependencies, req, sessionId, target, true);
        return res.json({ success: true, sessionId, state: "CLOSED" });
      } catch (error) {
        const shaped = publicCloseError(error);
        await auditCloseResult(
          dependencies,
          req,
          sessionId,
          target,
          false,
          shaped,
        );
        return res.status(shaped.status).json({
          error: shaped.message,
          code: shaped.code,
        });
      }
    },
  );

  return router;
}
