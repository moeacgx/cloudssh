import crypto from "crypto";
import type Database from "better-sqlite3";
import type { Request, Response, NextFunction } from "express";
import { apiLogger } from "../utils/logger.js";
import type { AgentAuthenticatedRequest } from "./auth.js";
import type { AgentPrincipal } from "./types.js";

export interface AgentAuditSink {
  record(
    req: AgentAuthenticatedRequest,
    statusCode: number,
    responseCompleted?: boolean,
    stage?: "intent" | "pending" | "result",
  ): Promise<void>;
}

export interface AgentDurableAuditEvent {
  id: string;
  projectId: string;
  serviceAccountId: string;
  tokenId: string | null;
  deviceId: string | null;
  sessionId: string | null;
  projectHostId: number | null;
  requestId: string | null;
  action: string;
  success: number;
  errorCode: string | null;
  metadata: string;
  ipAddress: string | null;
  occurredAt: string;
}

export interface AgentDurableAuditStore {
  recordAudit(event: AgentDurableAuditEvent): Promise<void>;
}

export interface AgentAuditJobContext {
  id: string;
  projectId: string;
  serverId: string;
}

export type AgentAuditJobResolver = (
  jobId: string,
) => Promise<AgentAuditJobContext | null>;

const AGENT_OPERATION_COMMITTED = Symbol("agent-operation-committed");
const AGENT_OPERATION_DISPATCHED = Symbol("agent-operation-dispatched");
const AGENT_AUDIT_EVENT_IDS = Symbol("agent-audit-event-ids");

type AgentRequestWithAuditIds = AgentAuthenticatedRequest & {
  [AGENT_AUDIT_EVENT_IDS]?: Map<string, string>;
};

interface SensitiveInputSummary {
  byteLength: number;
}

export function markAgentOperationCommitted(req: Request): void {
  (req as AgentAuthenticatedRequest).agentOperationCommitted = true;
  req.emit(AGENT_OPERATION_COMMITTED);
}

export function markAgentOperationDispatched(req: Request): void {
  (req as AgentAuthenticatedRequest).agentOperationDispatched = true;
  req.emit(AGENT_OPERATION_DISPATCHED);
}

function summarizeSensitiveInput(
  value: unknown,
): SensitiveInputSummary | undefined {
  if (typeof value !== "string") return undefined;
  return {
    byteLength: Buffer.byteLength(value, "utf8"),
  };
}

function sensitiveInputProvided(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function actionFor(req: Request): string {
  const normalizedPath = req.path
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id")
    .replace(/\/sessions\/[^/]+/, "/sessions/:id")
    .replace(/\/jobs\/[^/]+/, "/jobs/:id");
  return `${req.method.toLowerCase()} ${normalizedPath}`;
}

function auditedInput(req: Request): Record<string, unknown> | undefined {
  if (req.method === "POST" && req.path === "/files/upload") {
    return {
      serverId: req.query?.serverId,
      path: req.query?.path,
      // 只记录长度，不记录文件内容或正文哈希。
      byteLength: Buffer.isBuffer(req.body)
        ? req.body.length
        : Number(req.get("content-length") ?? 0) || null,
    };
  }
  if (req.method === "POST" && req.path === "/files/mkdir") {
    return {
      serverId: req.body?.serverId,
      path: req.body?.path,
      recursive: req.body?.recursive === true,
    };
  }
  if (req.method === "POST" && req.path === "/files/rename") {
    return {
      serverId: req.body?.serverId,
      sourcePath: req.body?.sourcePath,
      destinationPath: req.body?.destinationPath,
    };
  }
  if (req.method === "POST" && req.path === "/files/delete") {
    return {
      serverId: req.body?.serverId,
      path: req.body?.path,
      recursive: req.body?.recursive === true,
    };
  }
  if (req.method === "POST" && req.path === "/sessions") {
    return {
      serverId: req.body?.serverId,
      cols: req.body?.cols,
      rows: req.body?.rows,
      pinned: req.body?.pinned,
    };
  }
  if (req.method === "POST" && req.path === "/jobs") {
    return {
      serverId: req.body?.serverId,
      commandSummary: summarizeSensitiveInput(req.body?.command),
      timeoutMs: req.body?.timeoutMs,
    };
  }
  if (
    req.method === "POST" &&
    (req.path === "/servers" || req.path === "/quick-connections")
  ) {
    return {
      projectId: req.body?.projectId,
      name: req.body?.name,
      address: req.body?.address,
      port: req.body?.port,
      username: req.body?.username,
      authType: req.body?.authType,
      folder: req.body?.folder,
      credentialId: req.body?.credentialId,
      passwordProvided: sensitiveInputProvided(req.body?.password),
      keyProvided: sensitiveInputProvided(req.body?.key),
      keyPasswordProvided: sensitiveInputProvided(req.body?.keyPassword),
    };
  }
  if (req.method === "POST" && /\/sessions\/[^/]+\/write$/.test(req.path)) {
    return {
      attachmentId: req.body?.attachmentId,
      leaseId: req.body?.leaseId,
      dataSummary: summarizeSensitiveInput(req.body?.data),
    };
  }
  if (req.method === "POST" && /\/sessions\/[^/]+\/attach$/.test(req.path)) {
    return { mode: req.body?.mode, takeover: req.body?.takeover };
  }
  if (req.method === "POST" && /\/sessions\/[^/]+\/resize$/.test(req.path)) {
    return {
      attachmentId: req.body?.attachmentId,
      leaseId: req.body?.leaseId,
      cols: req.body?.cols,
      rows: req.body?.rows,
    };
  }
  if (req.method === "POST" && /\/sessions\/[^/]+\/detach$/.test(req.path)) {
    return { attachmentId: req.body?.attachmentId };
  }
  return undefined;
}

function requiresIntentAudit(req: Request): boolean {
  if (req.method !== "POST") return false;
  return (
    req.path === "/sessions" ||
    req.path === "/jobs" ||
    req.path === "/servers" ||
    req.path === "/quick-connections" ||
    req.path === "/files/upload" ||
    req.path === "/files/mkdir" ||
    req.path === "/files/rename" ||
    req.path === "/files/delete" ||
    /\/sessions\/[^/]+\/(?:attach|write|resize|detach|close)$/.test(req.path) ||
    /\/jobs\/[^/]+\/cancel$/.test(req.path)
  );
}

function requestReference(req: Request): {
  requestId: string | null;
  idempotencyKey: string | null;
} {
  const requestId = req.get("x-request-id")?.trim() || null;
  const idempotencyKey = req.get("idempotency-key")?.trim() || null;
  return {
    requestId: requestId ?? idempotencyKey,
    idempotencyKey,
  };
}

function auditEventId(
  req: AgentAuthenticatedRequest,
  projectId: string,
  serviceAccountId: string,
  action: string,
): string {
  const actor = req.agentDeviceId
    ? `device:${req.agentDeviceId}`
    : req.agentTokenId
      ? `token:${req.agentTokenId}`
      : `service-account:${serviceAccountId}`;
  const identity = [
    "cloudssh-agent-audit-v2",
    actor,
    projectId,
    action,
    req.method,
    req.originalUrl,
  ].join("\n");
  const requestWithIds = req as AgentRequestWithAuditIds;
  requestWithIds[AGENT_AUDIT_EVENT_IDS] ??= new Map();
  const existing = requestWithIds[AGENT_AUDIT_EVENT_IDS].get(identity);
  if (existing) return existing;
  const generated = crypto.randomUUID();
  requestWithIds[AGENT_AUDIT_EVENT_IDS].set(identity, generated);
  return generated;
}

function serviceAccountForProject(
  principal: AgentPrincipal,
  projectId: string,
  serverId: string | null,
): string {
  const direct = principal.projectServiceAccountIds?.[projectId];
  if (direct) return direct;
  if (serverId) {
    const serverAccount = principal.serverServiceAccountIds?.[serverId];
    if (serverAccount) return serverAccount;
  }
  for (const [candidateServerId, candidateProjectId] of Object.entries(
    principal.serverProjectIds ?? {},
  )) {
    if (candidateProjectId !== projectId) continue;
    const account = principal.serverServiceAccountIds?.[candidateServerId];
    if (account) return account;
  }
  return principal.serviceAccountId;
}

export class SqliteAgentAuditSink implements AgentAuditSink {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly onWrite?: () => void | Promise<void>,
    private readonly resolveJob?: AgentAuditJobResolver,
    private readonly durableStore?: AgentDurableAuditStore,
  ) {}

  async record(
    req: AgentAuthenticatedRequest,
    statusCode: number,
    responseCompleted = true,
    stage: "intent" | "pending" | "result" = "result",
  ): Promise<void> {
    const principal = req.agentPrincipal;
    if (!principal) return;
    const sessionMatch = req.originalUrl.match(/\/sessions\/([^/?]+)/);
    const jobMatch = req.originalUrl.match(/\/jobs\/([^/?]+)/);
    const requestedSessionId = sessionMatch?.[1] ?? null;
    const requestedJobId = jobMatch?.[1] ?? null;
    const visibleProjectIds = [
      ...new Set([principal.projectId, ...(principal.projectIds ?? [])]),
    ];
    const projectPlaceholders = visibleProjectIds.map(() => "?").join(",");
    const existingSession = requestedSessionId
      ? (this.sqlite
          .prepare(
            `SELECT id, project_id AS projectId,
                    project_host_id AS projectHostId
               FROM persistent_sessions
              WHERE id = ? AND project_id IN (${projectPlaceholders})`,
          )
          .get(requestedSessionId, ...visibleProjectIds) as
          | { id: string; projectId: string; projectHostId: number }
          | undefined)
      : undefined;
    const resolvedJob =
      requestedJobId && this.resolveJob
        ? await this.resolveJob(requestedJobId)
        : null;
    const existingJob =
      resolvedJob && visibleProjectIds.includes(resolvedJob.projectId)
        ? resolvedJob
        : null;
    const bodyServerId =
      typeof req.body?.serverId === "string"
        ? req.body.serverId
        : req.path.startsWith("/files/") &&
            typeof req.query?.serverId === "string"
          ? req.query.serverId
          : null;
    const bodyProjectId =
      typeof req.body?.projectId === "string" &&
      visibleProjectIds.includes(req.body.projectId)
        ? req.body.projectId
        : null;
    const resourceServerId =
      (existingSession ? String(existingSession.projectHostId) : null) ??
      existingJob?.serverId ??
      bodyServerId;
    const projectHost = resourceServerId
      ? (this.sqlite
          .prepare(
            `SELECT id, project_id AS projectId FROM project_hosts
             WHERE project_id IN (${projectPlaceholders})
               AND CAST(id AS TEXT) = ?`,
          )
          .get(...visibleProjectIds, resourceServerId) as
          | { id: number; projectId: string }
          | undefined)
      : undefined;
    const effectiveProjectId =
      existingSession?.projectId ??
      existingJob?.projectId ??
      projectHost?.projectId ??
      bodyProjectId ??
      principal.projectId;
    const effectiveServiceAccountId = serviceAccountForProject(
      principal,
      effectiveProjectId,
      resourceServerId,
    );
    const reference = requestReference(req);
    const operationDispatched = req.agentOperationDispatched === true;
    const operationCommitted = req.agentOperationCommitted === true;
    const success =
      stage === "intent" ||
      (stage === "result" &&
        (operationCommitted ||
          (!operationDispatched && responseCompleted && statusCode < 400)));
    const outcome =
      stage === "intent"
        ? "intent"
        : stage === "pending"
          ? "pending"
          : operationCommitted
            ? "committed"
            : operationDispatched
              ? "unknown"
              : success
                ? "succeeded"
                : "failed";
    const action =
      stage === "intent" ? `${actionFor(req)}:intent` : actionFor(req);
    const event: AgentDurableAuditEvent = {
      id: auditEventId(
        req,
        effectiveProjectId,
        effectiveServiceAccountId,
        action,
      ),
      projectId: effectiveProjectId,
      serviceAccountId: effectiveServiceAccountId,
      tokenId: req.agentTokenId ?? null,
      deviceId: req.agentDeviceId ?? null,
      sessionId: existingSession?.id ?? null,
      projectHostId: projectHost?.id ?? existingSession?.projectHostId ?? null,
      requestId: reference.requestId,
      action,
      success: success ? 1 : 0,
      errorCode:
        stage === "pending"
          ? "PENDING"
          : success
            ? null
            : operationDispatched
              ? "OUTCOME_UNKNOWN"
              : responseCompleted
                ? `HTTP_${statusCode}`
                : "CLIENT_DISCONNECTED",
      metadata: JSON.stringify({
        stage,
        method: req.method,
        path: req.path,
        statusCode,
        responseCompleted,
        outcome,
        operationDispatched,
        operationCommitted,
        requestId: reference.requestId,
        idempotencyKey: reference.idempotencyKey,
        ...(stage === "intent" ? { input: auditedInput(req) } : {}),
      }),
      ipAddress: req.ip ?? null,
      occurredAt: new Date().toISOString(),
    };
    if (this.durableStore) {
      await this.durableStore.recordAudit(event);
      return;
    }
    this.sqlite
      .prepare(
        `INSERT INTO agent_audit_events (
           id, project_id, service_account_id, token_id, device_id, session_id,
           project_host_id, request_id, action, success, error_code,
           metadata, ip_address, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           success = MAX(agent_audit_events.success, excluded.success),
           error_code = CASE
             WHEN agent_audit_events.success = 1 OR excluded.success = 1
               THEN NULL
             ELSE excluded.error_code
           END,
           metadata = CASE
             WHEN excluded.success >= agent_audit_events.success
               THEN excluded.metadata
             ELSE agent_audit_events.metadata
           END,
           ip_address = CASE
             WHEN excluded.success >= agent_audit_events.success
               THEN excluded.ip_address
             ELSE agent_audit_events.ip_address
           END,
           occurred_at = CASE
             WHEN excluded.success >= agent_audit_events.success
               THEN excluded.occurred_at
             ELSE agent_audit_events.occurred_at
           END`,
      )
      .run(
        event.id,
        event.projectId,
        event.serviceAccountId,
        event.tokenId,
        event.deviceId,
        event.sessionId,
        event.projectHostId,
        event.requestId,
        event.action,
        event.success,
        event.errorCode,
        event.metadata,
        event.ipAddress,
        event.occurredAt,
      );
    await this.onWrite?.();
  }
}

export function createAgentAuditMiddleware(sink: AgentAuditSink) {
  return (req: Request, res: Response, next: NextFunction) => {
    const agentRequest = req as AgentAuthenticatedRequest;
    let resultState: "none" | "disconnected" | "dispatched" | "final" = "none";
    let responseClosed = false;
    let releasePreparation!: () => void;
    const preparation = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    let resultWrites = preparation;
    const persistResult = async (responseCompleted: boolean) => {
      let lastError: unknown;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await sink.record(
            agentRequest,
            res.statusCode,
            responseCompleted,
            "result",
          );
          return;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    };
    const record = (responseCompleted: boolean) => {
      const final = responseCompleted || agentRequest.agentOperationCommitted;
      const nextState = final
        ? "final"
        : agentRequest.agentOperationDispatched
          ? "dispatched"
          : "disconnected";
      if (resultState === "final") return;
      if (resultState === "dispatched" && nextState !== "final") return;
      if (resultState === "disconnected") {
        if (nextState === "disconnected") return;
        // close 已确认响应未完成时，迟到的 finish 不能把普通断线误记为
        // 成功响应；只有远端已下发或已提交才能升级该结果。
        if (
          responseCompleted &&
          !agentRequest.agentOperationDispatched &&
          !agentRequest.agentOperationCommitted
        )
          return;
      }
      resultState = nextState;
      if (final) {
        req.removeListener(AGENT_OPERATION_COMMITTED, onCommitted);
        req.removeListener(AGENT_OPERATION_DISPATCHED, onDispatched);
      }
      resultWrites = resultWrites
        .then(() => persistResult(responseCompleted))
        .catch((error) => {
          apiLogger.error("Agent audit write failed", {
            operation: "agent_audit_write_failed",
            requestId:
              req.get("x-request-id") ?? req.get("idempotency-key") ?? null,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        });
    };
    const onCommitted = () => {
      if (responseClosed) record(false);
    };
    const onDispatched = () => {
      if (responseClosed) record(false);
    };
    req.once(AGENT_OPERATION_COMMITTED, onCommitted);
    req.once(AGENT_OPERATION_DISPATCHED, onDispatched);
    res.once("finish", () => record(true));
    res.once("close", () => {
      responseClosed = true;
      record(res.writableFinished);
    });
    const begin = async () => {
      let auditReady = false;
      try {
        if (requiresIntentAudit(req)) {
          await sink.record(agentRequest, 102, true, "intent");
        }
        if (responseClosed || res.destroyed) return;
        await sink.record(agentRequest, 102, false, "pending");
        auditReady = true;
      } catch (error) {
        apiLogger.error("Agent preflight audit write failed", {
          operation: "agent_preflight_audit_write_failed",
          requestId:
            req.get("x-request-id") ?? req.get("idempotency-key") ?? null,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        if (!responseClosed && !res.destroyed) {
          res.status(503).json({
            error: "Agent 审计暂时不可用，操作未执行",
            code: "AUDIT_UNAVAILABLE",
          });
        }
      } finally {
        releasePreparation();
      }
      if (!auditReady) return;
      if (responseClosed || res.destroyed) return;
      next();
    };
    void begin();
  };
}
