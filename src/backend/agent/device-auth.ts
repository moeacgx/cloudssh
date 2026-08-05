import crypto from "crypto";
import type Database from "better-sqlite3";
import type { NextFunction, Request, Response } from "express";
import { createCurrentProjectRepository } from "../control-plane/factory.js";
import { PermissionManager } from "../utils/permission-manager.js";
import type { AgentAuthenticatedRequest } from "./auth.js";
import type { AgentDeviceRecord, AgentScope } from "./types.js";

const CLOCK_SKEW_MS = 5 * 60_000;
const NONCE_TTL_MS = 10 * 60_000;
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

export function sha256Hex(value: Buffer | string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function deviceFingerprint(publicKey: crypto.KeyObject): string {
  const der = publicKey.export({ type: "spki", format: "der" });
  return sha256Hex(der);
}

export function normalizeEd25519PublicKey(value: unknown): {
  pem: string;
  fingerprint: string;
} {
  if (typeof value !== "string" || value.length > 4096) {
    throw Object.assign(new Error("设备公钥无效"), { status: 400 });
  }
  let key: crypto.KeyObject;
  try {
    key = crypto.createPublicKey(value);
  } catch {
    throw Object.assign(new Error("设备公钥无效"), { status: 400 });
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw Object.assign(new Error("只支持 Ed25519 设备公钥"), { status: 400 });
  }
  return {
    pem: key.export({ type: "spki", format: "pem" }).toString(),
    fingerprint: deviceFingerprint(key),
  };
}

export function canonicalDeviceRequest(input: {
  method: string;
  pathAndQuery: string;
  timestamp: string;
  nonce: string;
  bodyHash: string;
  idempotencyKey?: string;
  requestId?: string;
}): string {
  return [
    "cloudssh-device-v2",
    input.method.toUpperCase(),
    input.pathAndQuery,
    input.timestamp,
    input.nonce,
    input.bodyHash,
    input.idempotencyKey ?? "",
    input.requestId ?? "",
  ].join("\n");
}

function parseScopes(raw: string): AgentScope[] {
  try {
    return (JSON.parse(raw) as unknown[]).filter(
      (scope): scope is AgentScope =>
        typeof scope === "string" && KNOWN_SCOPES.has(scope as AgentScope),
    );
  } catch {
    return [];
  }
}

interface DeviceRow {
  id: string;
  name: string;
  publicKey: string;
  fingerprint: string;
  accessMode: "all" | "selected";
  approvedByUserId: string | null;
  scopes: string;
  maxConcurrentSessions: number;
  expiresAt: string | null;
  lastUsedAt: string | null;
  projectGrants: string | null;
}

export interface AgentDeviceStore {
  findVerificationById(deviceId: string): Promise<{
    id: string;
    publicKey: string;
  } | null>;
  findActiveById(deviceId: string): Promise<AgentDeviceRecord | null>;
  consumeNonce(
    deviceId: string,
    nonce: string,
    expiresAt: string,
  ): Promise<boolean>;
  touch(deviceId: string, timestamp: string): Promise<void>;
}

export interface AgentNonceStore {
  consumeNonce(
    deviceId: string,
    nonce: string,
    expiresAt: string,
  ): Promise<boolean>;
}

export interface AgentAuthFailureEvent {
  deviceId: string | null;
  requestId: string | null;
  method: string;
  path: string;
  errorCode: string;
  ipAddress: string | null;
  occurredAt: string;
}

export interface AgentAuthFailureAuditStore {
  recordAuthFailure(event: AgentAuthFailureEvent): Promise<void>;
}

export class SqliteAgentDeviceStore implements AgentDeviceStore {
  private readonly projectGrantWrites = new Map<string, Promise<void>>();

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
    private readonly onSecurityWrite: () => void | Promise<void> = onWrite ??
      (() => undefined),
    private readonly nonceStore?: AgentNonceStore,
  ) {}

  async findVerificationById(
    deviceId: string,
  ): Promise<{ id: string; publicKey: string } | null> {
    const row = this.sqlite
      .prepare(
        `SELECT id, public_key AS publicKey, expires_at AS expiresAt
           FROM agent_devices
          WHERE id = ? AND status = 'active' AND revoked_at IS NULL`,
      )
      .get(deviceId) as
      | { id: string; publicKey: string; expiresAt: string | null }
      | undefined;
    if (!row) return null;
    if (row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) return null;
    return { id: row.id, publicKey: row.publicKey };
  }

  private readProjectGrants(deviceId: string): Map<string, string> {
    const rows = this.sqlite
      .prepare(
        `SELECT project_id AS projectId, service_account_id AS serviceAccountId
           FROM agent_device_projects WHERE device_id = ?`,
      )
      .all(deviceId) as Array<{
      projectId: string;
      serviceAccountId: string;
    }>;
    return new Map(rows.map((row) => [row.projectId, row.serviceAccountId]));
  }

  private async ensureAllProjectGrants(
    deviceId: string,
    approvedByUserId: string,
    projectIds: string[],
  ): Promise<Map<string, string>> {
    const previous = this.projectGrantWrites.get(deviceId);
    const existingGrants = this.readProjectGrants(deviceId);
    if (
      !previous &&
      projectIds.every((projectId) => existingGrants.has(projectId))
    ) {
      return existingGrants;
    }
    const write = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const currentGrants = this.readProjectGrants(deviceId);
        const missingProjectIds = projectIds.filter(
          (projectId) => !currentGrants.has(projectId),
        );
        if (missingProjectIds.length === 0) return;

        const createdGrants: Array<{
          projectId: string;
          serviceAccountId: string;
        }> = [];
        const createdServiceAccountIds: string[] = [];
        this.sqlite.transaction(() => {
          for (const projectId of missingProjectIds) {
            const serviceAccountId = crypto.randomUUID();
            const internalName = `__device__:${deviceId}:${projectId}`;
            const accountInsert = this.sqlite
              .prepare(
                `INSERT OR IGNORE INTO service_accounts
                   (id, project_id, name, created_by, is_active)
                 VALUES (?, ?, ?, ?, 1)`,
              )
              .run(serviceAccountId, projectId, internalName, approvedByUserId);
            const identity = this.sqlite
              .prepare(
                "SELECT id FROM service_accounts WHERE project_id = ? AND name = ?",
              )
              .get(projectId, internalName) as { id: string } | undefined;
            if (!identity) throw new Error("Agent device identity is missing");
            if (accountInsert.changes > 0) {
              createdServiceAccountIds.push(identity.id);
            }
            const grantInsert = this.sqlite
              .prepare(
                `INSERT OR IGNORE INTO agent_device_projects
                   (device_id, project_id, service_account_id, granted_by)
                 VALUES (?, ?, ?, ?)`,
              )
              .run(deviceId, projectId, identity.id, approvedByUserId);
            if (grantInsert.changes > 0) {
              createdGrants.push({
                projectId,
                serviceAccountId: identity.id,
              });
            }
          }
        })();

        if (
          createdGrants.length === 0 &&
          createdServiceAccountIds.length === 0
        ) {
          return;
        }

        try {
          await this.onSecurityWrite();
        } catch (writeError) {
          this.sqlite.transaction(() => {
            for (const grant of createdGrants) {
              this.sqlite
                .prepare(
                  `DELETE FROM agent_device_projects
                    WHERE device_id = ? AND project_id = ?
                      AND service_account_id = ?`,
                )
                .run(deviceId, grant.projectId, grant.serviceAccountId);
            }
            for (const serviceAccountId of createdServiceAccountIds) {
              this.sqlite
                .prepare("DELETE FROM service_accounts WHERE id = ?")
                .run(serviceAccountId);
            }
          })();
          try {
            await this.onSecurityWrite();
          } catch (rollbackError) {
            throw new AggregateError(
              [writeError, rollbackError],
              "Agent device grant rollback persistence failed",
            );
          }
          throw writeError;
        }
      });

    this.projectGrantWrites.set(deviceId, write);
    try {
      await write;
    } finally {
      if (this.projectGrantWrites.get(deviceId) === write) {
        this.projectGrantWrites.delete(deviceId);
      }
    }
    return this.readProjectGrants(deviceId);
  }

  async findActiveById(deviceId: string): Promise<AgentDeviceRecord | null> {
    const row = this.sqlite
      .prepare(
        `SELECT device.id, device.name, device.public_key AS publicKey,
                device.fingerprint, device.access_mode AS accessMode,
                device.approved_by_user_id AS approvedByUserId,
                device.scopes,
                device.max_concurrent_sessions AS maxConcurrentSessions,
                device.expires_at AS expiresAt,
                device.last_used_at AS lastUsedAt,
                GROUP_CONCAT(grant_row.project_id || '=' ||
                  grant_row.service_account_id) AS projectGrants
           FROM agent_devices device
           LEFT JOIN agent_device_projects grant_row
             ON grant_row.device_id = device.id
          WHERE device.id = ? AND device.status = 'active'
            AND device.revoked_at IS NULL
          GROUP BY device.id`,
      )
      .get(deviceId) as DeviceRow | undefined;
    if (!row) return null;
    if (row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) return null;

    let grants = new Map<string, string>();
    for (const encoded of row.projectGrants?.split(",") ?? []) {
      const separator = encoded.indexOf("=");
      if (separator > 0) {
        grants.set(encoded.slice(0, separator), encoded.slice(separator + 1));
      }
    }
    const grantedIds = [...grants.keys()];
    const manageableIds = row.approvedByUserId
      ? await this.resolveManageableProjectIds(row.approvedByUserId)
      : [];
    const projectIds =
      row.accessMode === "all"
        ? manageableIds
        : grantedIds.filter((id) => manageableIds.includes(id));

    if (row.accessMode === "all" && row.approvedByUserId) {
      grants = await this.ensureAllProjectGrants(
        row.id,
        row.approvedByUserId,
        projectIds,
      );
    }

    if (projectIds.length === 0) return null;
    const placeholders = projectIds.map(() => "?").join(",");
    const hosts = this.sqlite
      .prepare(
        `SELECT CAST(id AS TEXT) AS serverId, project_id AS projectId
           FROM project_hosts WHERE project_id IN (${placeholders})`,
      )
      .all(...projectIds) as Array<{ serverId: string; projectId: string }>;
    const serverProjectIds: Record<string, string> = {};
    const serverServiceAccountIds: Record<string, string> = {};
    for (const host of hosts) {
      const accountId = grants.get(host.projectId);
      if (!accountId) continue;
      serverProjectIds[host.serverId] = host.projectId;
      serverServiceAccountIds[host.serverId] = accountId;
    }
    const primaryProjectId = projectIds[0];
    const primaryServiceAccountId = grants.get(primaryProjectId);
    if (!primaryServiceAccountId) return null;
    return {
      id: row.id,
      principalId: `device:${row.id}`,
      serviceAccountId: primaryServiceAccountId,
      serviceAccountIds: [
        ...new Set(projectIds.map((id) => grants.get(id)).filter(Boolean)),
      ] as string[],
      projectId: primaryProjectId,
      projectIds,
      projectServiceAccountIds: Object.fromEntries(
        projectIds.flatMap((id) => {
          const accountId = grants.get(id);
          return accountId ? [[id, accountId]] : [];
        }),
      ),
      name: row.name,
      approvedByUserId: row.approvedByUserId ?? undefined,
      scopes: parseScopes(row.scopes),
      serverIds: Object.keys(serverProjectIds),
      serverProjectIds,
      serverServiceAccountIds,
      maxConcurrentSessions: row.maxConcurrentSessions,
      publicKey: row.publicKey,
      fingerprint: row.fingerprint,
      expiresAt: row.expiresAt,
      active: true,
      lastUsedAt: row.lastUsedAt,
    };
  }

  async consumeNonce(
    deviceId: string,
    nonce: string,
    expiresAt: string,
  ): Promise<boolean> {
    if (this.nonceStore) {
      return this.nonceStore.consumeNonce(deviceId, nonce, expiresAt);
    }
    const accepted = this.sqlite.transaction(() => {
      this.sqlite
        .prepare("DELETE FROM agent_request_nonces WHERE expires_at <= ?")
        .run(new Date().toISOString());
      return (
        this.sqlite
          .prepare(
            `INSERT OR IGNORE INTO agent_request_nonces
               (device_id, nonce, expires_at) VALUES (?, ?, ?)`,
          )
          .run(deviceId, nonce, expiresAt).changes > 0
      );
    })();
    if (accepted) await this.onSecurityWrite();
    return accepted;
  }

  async touch(deviceId: string, timestamp: string): Promise<void> {
    this.sqlite
      .prepare("UPDATE agent_devices SET last_used_at = ? WHERE id = ?")
      .run(timestamp, deviceId);
    await this.onWrite?.();
  }
}

function boundedValue(value: string | undefined, maximum: number) {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

async function authFailure(
  req: Request,
  res: Response,
  audit: AgentAuthFailureAuditStore,
  code: string,
  message: string,
  status = 401,
): Promise<void> {
  try {
    await audit.recordAuthFailure({
      deviceId: boundedValue(req.header("x-cloudssh-device-id"), 128),
      requestId: boundedValue(req.header("x-request-id"), 128),
      method: req.method.slice(0, 16),
      path: req.originalUrl.split("?", 1)[0].slice(0, 512),
      errorCode: code,
      ipAddress: boundedValue(req.ip, 128),
      occurredAt: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({
      error: "设备认证审计暂时不可用",
      code: "AUTH_AUDIT_UNAVAILABLE",
    });
    return;
  }
  res.status(status).json({ error: message, code });
}

interface DeviceAuthHeaders {
  deviceId: string;
  timestamp: string;
  nonce: string;
  bodyHash: string;
  signature: string;
  idempotencyKey: string;
  requestId: string;
  requestTime: number;
  canonical: string;
}

const uploadPreAuthState = Symbol("cloudssh-upload-pre-auth");
const streamedBodyHashState = Symbol("cloudssh-streamed-body-hash");
type PreAuthenticatedUploadRequest = AgentAuthenticatedRequest & {
  [uploadPreAuthState]?: {
    deviceId: string;
    canonical: string;
    signature: string;
  };
  [streamedBodyHashState]?: string;
};

/**
 * 上传正文由路由层以有界流方式接收时，保存实际计算出的摘要供完整鉴权使用。
 * 调用方不能传入签名头的声明值，必须传入对已接收字节计算得到的值。
 */
export function setAgentStreamedBodyHash(req: Request, sha256: string): void {
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error("streamed body hash is invalid");
  }
  (req as PreAuthenticatedUploadRequest)[streamedBodyHashState] = sha256;
}

async function readDeviceAuthHeaders(
  req: Request,
  res: Response,
  audit: AgentAuthFailureAuditStore,
): Promise<DeviceAuthHeaders | null> {
  if (req.header("authorization")?.startsWith("Bearer ")) {
    await authFailure(
      req,
      res,
      audit,
      "TOKEN_AUTH_REMOVED",
      "Agent Token 登录已停用，请升级 Skill 并重新进行设备审批",
    );
    return null;
  }
  const deviceId = req.header("x-cloudssh-device-id")?.trim() ?? "";
  const timestamp = req.header("x-cloudssh-timestamp")?.trim() ?? "";
  const nonce = req.header("x-cloudssh-nonce")?.trim() ?? "";
  const bodyHash = req.header("x-cloudssh-body-sha256")?.trim() ?? "";
  const signature = req.header("x-cloudssh-signature")?.trim() ?? "";
  const idempotencyKey = req.header("idempotency-key")?.trim() ?? "";
  const requestId = req.header("x-request-id")?.trim() ?? "";
  if (
    !deviceId ||
    !/^\d{13}$/.test(timestamp) ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) ||
    !/^[a-f0-9]{64}$/.test(bodyHash) ||
    !/^[A-Za-z0-9_-]{40,256}$/.test(signature) ||
    (idempotencyKey.length > 0 &&
      !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)
  ) {
    await authFailure(
      req,
      res,
      audit,
      "DEVICE_SIGNATURE_REQUIRED",
      "缺少有效的设备签名",
    );
    return null;
  }
  const requestTime = Number(timestamp);
  if (Math.abs(Date.now() - requestTime) > CLOCK_SKEW_MS) {
    await authFailure(
      req,
      res,
      audit,
      "DEVICE_TIMESTAMP_EXPIRED",
      "设备请求时间已过期",
    );
    return null;
  }
  return {
    deviceId,
    timestamp,
    nonce,
    bodyHash,
    signature,
    idempotencyKey,
    requestId,
    requestTime,
    canonical: canonicalDeviceRequest({
      method: req.method,
      pathAndQuery: req.originalUrl,
      timestamp,
      nonce,
      bodyHash,
      idempotencyKey,
      requestId,
    }),
  };
}

async function verifyDeviceSignature(
  req: Request,
  res: Response,
  store: AgentDeviceStore,
  audit: AgentAuthFailureAuditStore,
  headers: DeviceAuthHeaders,
): Promise<boolean> {
  const verification = await store.findVerificationById(headers.deviceId);
  if (!verification) {
    await authFailure(
      req,
      res,
      audit,
      "DEVICE_NOT_AUTHORIZED",
      "设备未授权或已撤销",
    );
    return false;
  }
  const verified = crypto.verify(
    null,
    Buffer.from(headers.canonical),
    verification.publicKey,
    Buffer.from(headers.signature, "base64url"),
  );
  if (!verified) {
    await authFailure(
      req,
      res,
      audit,
      "DEVICE_SIGNATURE_INVALID",
      "设备签名无效",
    );
    return false;
  }
  return true;
}

async function consumeDeviceNonce(
  req: Request,
  res: Response,
  store: AgentDeviceStore,
  audit: AgentAuthFailureAuditStore,
  headers: DeviceAuthHeaders,
): Promise<boolean> {
  const accepted = await store.consumeNonce(
    headers.deviceId,
    headers.nonce,
    new Date(headers.requestTime + NONCE_TTL_MS).toISOString(),
  );
  if (accepted) return true;
  await authFailure(
    req,
    res,
    audit,
    "DEVICE_REQUEST_REPLAYED",
    "设备请求已使用",
  );
  return false;
}

async function ensureDeviceActive(
  req: Request,
  res: Response,
  store: AgentDeviceStore,
  audit: AgentAuthFailureAuditStore,
  deviceId: string,
): Promise<AgentDeviceRecord | null> {
  const record = await store.findActiveById(deviceId);
  if (record) return record;
  await authFailure(
    req,
    res,
    audit,
    "DEVICE_NOT_AUTHORIZED",
    "设备未授权或已撤销",
  );
  return null;
}

async function authorizeUploadBeforeBody(
  req: Request,
  res: Response,
  audit: AgentAuthFailureAuditStore,
  record: AgentDeviceRecord,
): Promise<boolean> {
  if (!record.scopes.includes("files:write")) {
    await authFailure(
      req,
      res,
      audit,
      "SCOPE_DENIED",
      "当前设备没有文件写入权限",
      403,
    );
    return false;
  }
  const serverId =
    typeof req.query.serverId === "string" ? req.query.serverId.trim() : "";
  const remotePath =
    typeof req.query.path === "string" ? req.query.path.trim() : "";
  if (
    !serverId ||
    serverId.length > 128 ||
    !remotePath ||
    remotePath.length > 4_096 ||
    remotePath.includes("\0")
  ) {
    await authFailure(
      req,
      res,
      audit,
      "INVALID_INPUT",
      "文件上传参数无效",
      400,
    );
    return false;
  }
  if (!record.serverIds.includes("*") && !record.serverIds.includes(serverId)) {
    await authFailure(
      req,
      res,
      audit,
      "SERVER_DENIED",
      "当前设备无权访问该服务器",
      403,
    );
    return false;
  }
  return true;
}

/**
 * 仅用于大文件上传正文解析前。先验证设备签名并消费 nonce，避免未认证
 * 请求占用上传并发名额或让 raw parser 缓冲最多 64 MiB 正文。
 */
export function createAgentDevicePreAuthMiddleware(
  store: AgentDeviceStore,
  authFailureAudit: AgentAuthFailureAuditStore,
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const headers = await readDeviceAuthHeaders(req, res, authFailureAudit);
      if (!headers) return;
      if (
        !(await verifyDeviceSignature(
          req,
          res,
          store,
          authFailureAudit,
          headers,
        )) ||
        !(await consumeDeviceNonce(req, res, store, authFailureAudit, headers))
      ) {
        return;
      }
      const record = await ensureDeviceActive(
        req,
        res,
        store,
        authFailureAudit,
        headers.deviceId,
      );
      if (
        !record ||
        !(await authorizeUploadBeforeBody(req, res, authFailureAudit, record))
      ) {
        return;
      }
      (req as PreAuthenticatedUploadRequest)[uploadPreAuthState] = {
        deviceId: headers.deviceId,
        canonical: headers.canonical,
        signature: headers.signature,
      };
      next();
    } catch {
      await authFailure(
        req,
        res,
        authFailureAudit,
        "AUTH_FAILED",
        "设备鉴权失败",
        500,
      );
    }
  };
}

export function createAgentDeviceAuthMiddleware(
  store: AgentDeviceStore,
  authFailureAudit: AgentAuthFailureAuditStore,
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const headers = await readDeviceAuthHeaders(req, res, authFailureAudit);
      if (!headers) return;
      const authReq = req as PreAuthenticatedUploadRequest;
      const actualBodyHash = authReq.rawBody
        ? sha256Hex(authReq.rawBody)
        : (authReq[streamedBodyHashState] ?? sha256Hex(Buffer.alloc(0)));
      if (actualBodyHash !== headers.bodyHash) {
        await authFailure(
          req,
          res,
          authFailureAudit,
          "DEVICE_BODY_TAMPERED",
          "请求正文校验失败",
        );
        return;
      }

      const preAuthenticated = (req as PreAuthenticatedUploadRequest)[
        uploadPreAuthState
      ];
      if (preAuthenticated) {
        if (
          preAuthenticated.deviceId !== headers.deviceId ||
          preAuthenticated.canonical !== headers.canonical ||
          preAuthenticated.signature !== headers.signature
        ) {
          await authFailure(
            req,
            res,
            authFailureAudit,
            "DEVICE_SIGNATURE_INVALID",
            "设备签名无效",
          );
          return;
        }
      } else if (
        !(await verifyDeviceSignature(
          req,
          res,
          store,
          authFailureAudit,
          headers,
        )) ||
        !(await consumeDeviceNonce(req, res, store, authFailureAudit, headers))
      ) {
        return;
      }

      // 上传正文解析期间设备可能被撤销，因此完整鉴权阶段再次确认状态。
      const record = await ensureDeviceActive(
        req,
        res,
        store,
        authFailureAudit,
        headers.deviceId,
      );
      if (!record) return;
      authReq.agentDeviceId = record.id;
      authReq.agentPrincipal = record;
      if (
        !record.lastUsedAt ||
        Date.parse(record.lastUsedAt) + 60_000 <= Date.now()
      ) {
        void store
          .touch(record.id, new Date().toISOString())
          .catch(() => undefined);
      }
      next();
    } catch {
      await authFailure(
        req,
        res,
        authFailureAudit,
        "AUTH_FAILED",
        "设备鉴权失败",
        500,
      );
    }
  };
}
