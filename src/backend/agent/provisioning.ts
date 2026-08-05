import crypto from "crypto";
import type Database from "better-sqlite3";
import { ManagementRepository } from "../control-plane/management-repository.js";
import { createCurrentProjectCredentialRepository } from "../control-plane/factory.js";
import { createCurrentRepositoryContext } from "../database/repositories/factory.js";
import type { HostRepository } from "../database/repositories/host-repository.js";
import { PermissionManager } from "../utils/permission-manager.js";
import { parseSSHKey } from "../utils/ssh-key-utils.js";
import { initializeProjectHostCredential } from "../hosts/host-resolver.js";
import { AgentApiError } from "./errors.js";
import type { AgentPrincipal, AgentScope } from "./types.js";

const QUICK_CONNECTION_TTL_MS = 30 * 60_000;
const PROVISIONING_IDEMPOTENCY_RETENTION_MS = 30 * 24 * 60 * 60_000;

export interface AgentProjectSummary {
  id: string;
  name: string;
  kind: "personal" | "team";
}

export interface AgentProjectFolderSummary {
  path: string;
  color: string | null;
  icon: string | null;
}

export interface AgentProjectCredentialSummary {
  id: string;
  name: string;
  username: string;
  authType: "password" | "key" | "none";
  keyType: string | null;
}

export interface AgentServerCreateInput {
  projectId: string;
  name: string;
  address: string;
  port: number;
  username: string;
  authType: "none" | "password" | "key" | "credential";
  folder: string | null;
  credentialId: string | null;
  password: string | null;
  key: string | null;
  keyPassword: string | null;
  keyType: string | null;
  hostKeyFingerprint: string | null;
  tags: string[];
  notes: string | null;
}

export interface AgentCreatedServer {
  serverId: string;
  hostId: number;
  projectId: string;
  name: string;
  address: string;
  port: number;
  folder: string | null;
  credentialId: string | null;
  temporary: boolean;
  expiresAt: string | null;
}

export interface AgentProvisioningService {
  listProjects(principal: AgentPrincipal): Promise<AgentProjectSummary[]>;
  listFolders(
    principal: AgentPrincipal,
    projectId: string,
  ): Promise<AgentProjectFolderSummary[]>;
  listCredentials(
    principal: AgentPrincipal,
    projectId: string,
  ): Promise<AgentProjectCredentialSummary[]>;
  createServer(
    principal: AgentPrincipal,
    input: AgentServerCreateInput,
    idempotencyKey: string,
  ): Promise<AgentCreatedServer>;
  createQuickConnection(
    principal: AgentPrincipal,
    input: AgentServerCreateInput,
    idempotencyKey: string,
  ): Promise<AgentCreatedServer>;
  cleanupExpiredQuickConnections(now?: Date): Promise<number>;
}

type ProvisioningKind = "server" | "quick-connection";

interface IdempotencyRow {
  requestHash: string;
  responseJson: string;
}

function requireScope(principal: AgentPrincipal, scope: AgentScope): void {
  if (!principal.scopes.includes(scope)) {
    throw new AgentApiError(403, "SCOPE_DENIED", `缺少权限：${scope}`);
  }
}

function requireProject(principal: AgentPrincipal, projectId: string): void {
  const allowed = new Set([
    principal.projectId,
    ...(principal.projectIds ?? []),
  ]);
  if (!allowed.has(projectId)) {
    throw new AgentApiError(403, "PROJECT_DENIED", "设备未获授权访问该项目");
  }
}

function requestHash(input: AgentServerCreateInput): string {
  // 幂等记录位于主数据库，不能把低熵密码或私钥正文放进普通 SHA-256
  // 输入，否则数据库泄露后会形成离线猜测校验器。认证类型已经约束秘密
  // 是否必填，因此这里只记录“是否提供”，不记录秘密内容或长度。
  const safeInput = {
    ...input,
    password: input.password !== null,
    key: input.key !== null,
    keyPassword: input.keyPassword !== null,
  };
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(safeInput))
    .digest("hex");
}

function deterministicSyncId(
  principalId: string,
  kind: ProvisioningKind,
  idempotencyKey: string,
): string {
  const hex = crypto
    .createHash("sha256")
    .update(`cloudssh-agent:${principalId}:${kind}:${idempotencyKey}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  // 使用稳定 UUID 作为 ssh_data.sync_id，崩溃后仍能准确找回已创建资产。
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function sameCreationInput(
  host: Record<string, unknown>,
  link: { folder: string | null; credentialId: string | null },
  input: AgentServerCreateInput,
): boolean {
  const tags = String(host.tags ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  return (
    host.name === input.name &&
    host.ip === input.address &&
    Number(host.port) === input.port &&
    host.username === input.username &&
    (host.hostKeyFingerprint ?? null) === input.hostKeyFingerprint &&
    (host.notes ?? null) === input.notes &&
    link.folder === input.folder &&
    (link.credentialId === input.credentialId ||
      (input.credentialId === null &&
        link.credentialId?.startsWith("cloudssh-mirror:")) ||
      (link.credentialId === null && input.credentialId !== null)) &&
    host.authType ===
      (input.authType === "credential" ? "none" : input.authType) &&
    (host.password ?? null) === input.password &&
    (host.key ?? null) === input.key &&
    (host.keyPassword ?? null) === input.keyPassword &&
    JSON.stringify(tags) === JSON.stringify(input.tags)
  );
}

export class SqliteAgentProvisioningService implements AgentProvisioningService {
  private readonly writes = new Map<string, Promise<AgentCreatedServer>>();

  constructor(
    private readonly sqlite: Database.Database,
    private readonly hosts: HostRepository,
    private readonly onWrite?: () => void | Promise<void>,
    private readonly onHostCreated?: (
      hostId: number,
      address: string,
    ) => void | Promise<void>,
  ) {}

  async listProjects(
    principal: AgentPrincipal,
  ): Promise<AgentProjectSummary[]> {
    const projectIds = [
      ...new Set([principal.projectId, ...(principal.projectIds ?? [])]),
    ];
    if (projectIds.length === 0) return [];
    const placeholders = projectIds.map(() => "?").join(",");
    return this.sqlite
      .prepare(
        `SELECT id, name, kind FROM projects
          WHERE id IN (${placeholders})
          ORDER BY CASE kind WHEN 'personal' THEN 0 ELSE 1 END, name, id`,
      )
      .all(...projectIds) as AgentProjectSummary[];
  }

  async listFolders(
    principal: AgentPrincipal,
    projectId: string,
  ): Promise<AgentProjectFolderSummary[]> {
    requireProject(principal, projectId);
    return this.sqlite
      .prepare(
        `SELECT path, color, icon FROM project_folders
          WHERE project_id = ? ORDER BY path, id`,
      )
      .all(projectId) as AgentProjectFolderSummary[];
  }

  async listCredentials(
    principal: AgentPrincipal,
    projectId: string,
  ): Promise<AgentProjectCredentialSummary[]> {
    requireProject(principal, projectId);
    if (
      !principal.scopes.includes("servers:create") &&
      !principal.scopes.includes("quick-connections:create")
    ) {
      throw new AgentApiError(
        403,
        "SCOPE_DENIED",
        "缺少主机创建或快速连接权限",
      );
    }
    try {
      const credentials = await createCurrentProjectCredentialRepository();
      return (await credentials.list(
        projectId,
      )) as AgentProjectCredentialSummary[];
    } catch {
      throw new AgentApiError(
        503,
        "CREDENTIAL_VAULT_UNAVAILABLE",
        "项目凭据库当前不可用",
      );
    }
  }

  createServer(
    principal: AgentPrincipal,
    input: AgentServerCreateInput,
    idempotencyKey: string,
  ): Promise<AgentCreatedServer> {
    return this.create(principal, input, idempotencyKey, "server");
  }

  createQuickConnection(
    principal: AgentPrincipal,
    input: AgentServerCreateInput,
    idempotencyKey: string,
  ): Promise<AgentCreatedServer> {
    if (input.authType === "credential" && !input.credentialId) {
      throw new AgentApiError(
        400,
        "CREDENTIAL_REQUIRED",
        "credential 认证必须引用项目凭据",
      );
    }
    if (!input.hostKeyFingerprint) {
      throw new AgentApiError(
        400,
        "HOST_KEY_REQUIRED",
        "快速连接必须提供已核对的 SSH Host Key 指纹",
      );
    }
    return this.create(principal, input, idempotencyKey, "quick-connection");
  }

  private create(
    principal: AgentPrincipal,
    input: AgentServerCreateInput,
    idempotencyKey: string,
    kind: ProvisioningKind,
  ): Promise<AgentCreatedServer> {
    requireScope(
      principal,
      kind === "server" ? "servers:create" : "quick-connections:create",
    );
    requireProject(principal, input.projectId);
    if (!principal.approvedByUserId) {
      throw new AgentApiError(
        403,
        "DEVICE_OWNER_UNAVAILABLE",
        "设备授权主体不可用，请由管理员重新配置设备授权",
      );
    }
    if (!idempotencyKey) {
      throw new AgentApiError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "创建操作必须提供幂等键",
      );
    }
    const syncId = deterministicSyncId(
      principal.principalId,
      kind,
      idempotencyKey,
    );
    const previous = this.writes.get(syncId);
    if (previous) return previous;
    const operation = this.createLocked(
      principal,
      input,
      idempotencyKey,
      kind,
      syncId,
    );
    this.writes.set(syncId, operation);
    const releaseWriteLock = () => {
      if (this.writes.get(syncId) === operation) this.writes.delete(syncId);
    };
    // finally() 会创建一个新的拒绝 Promise；若调用方已处理原 Promise，
    // 派生 Promise 仍可能触发 unhandledRejection。双分支 then 可在成功或
    // 失败时释放锁，同时把派生链稳定收敛为 fulfilled。
    void operation.then(releaseWriteLock, releaseWriteLock);
    return operation;
  }

  private async createLocked(
    principal: AgentPrincipal,
    input: AgentServerCreateInput,
    idempotencyKey: string,
    kind: ProvisioningKind,
    syncId: string,
  ): Promise<AgentCreatedServer> {
    const hash = requestHash(input);
    const stored = this.sqlite
      .prepare(
        `SELECT request_hash AS requestHash, response_json AS responseJson
           FROM agent_provisioning_idempotency
          WHERE principal_id = ? AND operation = ? AND idempotency_key = ?`,
      )
      .get(principal.principalId, kind, idempotencyKey) as
      | IdempotencyRow
      | undefined;
    if (stored) {
      if (stored.requestHash !== hash) {
        throw new AgentApiError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "同一幂等键不能用于不同的创建参数",
        );
      }
      return JSON.parse(stored.responseJson) as AgentCreatedServer;
    }

    const actorUserId = principal.approvedByUserId!;
    const isInstanceAdmin =
      await PermissionManager.getInstance().isAdmin(actorUserId);
    try {
      new ManagementRepository(
        createCurrentRepositoryContext(),
      ).getProjectHostCreationTarget(
        input.projectId,
        actorUserId,
        isInstanceAdmin,
      );
    } catch {
      throw new AgentApiError(
        403,
        "PROJECT_WRITE_DENIED",
        "设备审批用户已不再拥有该项目的主机管理权限",
      );
    }

    let credentialUsername = input.username;
    if (input.credentialId) {
      const credentials = await this.listCredentials(
        principal,
        input.projectId,
      );
      const credential = credentials.find(
        (candidate) => candidate.id === input.credentialId,
      );
      if (!credential) {
        throw new AgentApiError(
          404,
          "PROJECT_CREDENTIAL_NOT_FOUND",
          "项目凭据不存在",
        );
      }
      credentialUsername ||= credential.username;
    }
    if (!credentialUsername) {
      throw new AgentApiError(400, "USERNAME_REQUIRED", "username 不能为空");
    }
    if (input.authType === "password" && !input.password) {
      throw new AgentApiError(
        400,
        "PASSWORD_REQUIRED",
        "password 认证缺少密码",
      );
    }
    if (input.authType === "key") {
      if (!input.key) {
        throw new AgentApiError(
          400,
          "PRIVATE_KEY_REQUIRED",
          "key 认证缺少私钥",
        );
      }
      const parsed = parseSSHKey(input.key, input.keyPassword ?? undefined);
      if (!parsed.success) {
        throw new AgentApiError(
          400,
          "INVALID_PRIVATE_KEY",
          `SSH 私钥无效：${parsed.error ?? "无法解析"}`,
        );
      }
    }

    const existingHost = this.sqlite
      .prepare("SELECT id FROM ssh_data WHERE sync_id = ?")
      .get(syncId) as { id: number } | undefined;
    let hostId: number;
    let projectHostId: number;
    if (existingHost) {
      hostId = existingHost.id;
      const link = this.sqlite
        .prepare(
          `SELECT id, folder, credential_id AS credentialId
             FROM project_hosts WHERE project_id = ? AND host_id = ?`,
        )
        .get(input.projectId, hostId) as
        | { id: number; folder: string | null; credentialId: string | null }
        | undefined;
      const decrypted = await this.hosts.findDecryptedByIdAs(
        actorUserId,
        hostId,
      );
      if (
        !link ||
        !decrypted ||
        !sameCreationInput(
          decrypted as unknown as Record<string, unknown>,
          link,
          { ...input, username: credentialUsername },
        )
      ) {
        throw new AgentApiError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "幂等键对应的主机已经存在，但参数不一致",
        );
      }
      projectHostId = link.id;
    } else {
      let created;
      try {
        created = await this.hosts.createEncryptedForUserWithProject(
          actorUserId,
          {
            syncId,
            userId: actorUserId,
            connectionType: "ssh",
            name: input.name,
            ip: input.address,
            port: input.port,
            sshPort: input.port,
            username: credentialUsername,
            folder: null,
            tags: input.tags.join(","),
            authType: input.authType === "credential" ? "none" : input.authType,
            password: input.authType === "password" ? input.password : null,
            key: input.authType === "key" ? input.key : null,
            keyPassword: input.authType === "key" ? input.keyPassword : null,
            keyType: input.authType === "key" ? input.keyType : null,
            hostKeyFingerprint: input.hostKeyFingerprint,
            hostKeyAlgorithm: input.hostKeyFingerprint ? "sha256" : null,
            notes: input.notes,
            enableTerminal: true,
            enableFileManager: true,
            enableTunnel: false,
            enableSsh: true,
            allowSessionSharing: true,
          },
          {
            projectId: input.projectId,
            alias: null,
            folder: input.folder,
            addedBy: actorUserId,
          },
        );
      } catch (error) {
        if (String(error).includes("User data is locked")) {
          throw new AgentApiError(
            423,
            "USER_DATA_LOCKED",
            "设备审批用户的数据已锁定，请先登录网页解锁后重试",
          );
        }
        throw error;
      }
      hostId = Number(created.host.id);
      projectHostId = created.projectHostId;
    }

    if (input.credentialId) {
      const credentials = await createCurrentProjectCredentialRepository();
      const assigned = await credentials.assignToProjectHost(
        input.projectId,
        projectHostId,
        input.credentialId,
      );
      if (!assigned) {
        if (!existingHost) await this.hosts.deleteForUser(actorUserId, hostId);
        throw new AgentApiError(
          409,
          "PROJECT_CREDENTIAL_UNAVAILABLE",
          "项目凭据无法分配给该主机",
        );
      }
    } else if (["password", "key", "none"].includes(input.authType)) {
      try {
        await initializeProjectHostCredential({
          projectId: input.projectId,
          projectHostId,
          hostId,
          createdBy: actorUserId,
        });
      } catch (error) {
        if (!existingHost) await this.hosts.deleteForUser(actorUserId, hostId);
        throw new AgentApiError(
          503,
          "PROJECT_CREDENTIAL_UNAVAILABLE",
          error instanceof Error
            ? `无法建立项目凭据：${error.message}`
            : "无法建立项目凭据",
        );
      }
    }

    const expiresAt =
      kind === "quick-connection"
        ? new Date(Date.now() + QUICK_CONNECTION_TTL_MS).toISOString()
        : null;
    if (expiresAt) {
      this.sqlite
        .prepare(
          `INSERT INTO agent_quick_connections
             (id, device_id, project_id, project_host_id, host_id, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_host_id) DO UPDATE SET expires_at = excluded.expires_at`,
        )
        .run(
          syncId,
          principal.principalId.replace(/^device:/, ""),
          input.projectId,
          projectHostId,
          hostId,
          expiresAt,
        );
    }

    const result: AgentCreatedServer = {
      serverId: String(projectHostId),
      hostId,
      projectId: input.projectId,
      name: input.name,
      address: input.address,
      port: input.port,
      folder: input.folder,
      credentialId: input.credentialId,
      temporary: kind === "quick-connection",
      expiresAt,
    };
    this.sqlite
      .prepare(
        `INSERT INTO agent_provisioning_idempotency
           (principal_id, operation, idempotency_key, request_hash,
            resource_sync_id, response_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        principal.principalId,
        kind,
        idempotencyKey,
        hash,
        syncId,
        JSON.stringify(result),
      );
    await this.onWrite?.();
    void Promise.resolve(this.onHostCreated?.(hostId, input.address)).catch(
      () => undefined,
    );
    return result;
  }

  async cleanupExpiredQuickConnections(now = new Date()): Promise<number> {
    const idempotencyCutoff = new Date(
      now.getTime() - PROVISIONING_IDEMPOTENCY_RETENTION_MS,
    ).toISOString();
    const expiredIdempotency = this.sqlite
      .prepare(
        `DELETE FROM agent_provisioning_idempotency
          WHERE datetime(created_at) < datetime(?)
            AND NOT EXISTS (
              SELECT 1 FROM agent_quick_connections quick
               WHERE quick.id = agent_provisioning_idempotency.resource_sync_id
            )`,
      )
      .run(idempotencyCutoff).changes;
    const expired = this.sqlite
      .prepare(
        `SELECT quick.id, quick.project_id AS projectId,
                quick.project_host_id AS projectHostId,
                quick.host_id AS hostId, host.user_id AS userId,
                host.sync_id AS syncId
           FROM agent_quick_connections quick
           JOIN ssh_data host ON host.id = quick.host_id
          WHERE quick.expires_at <= ?
            AND NOT EXISTS (
              SELECT 1 FROM persistent_sessions session
               WHERE session.project_host_id = quick.project_host_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM web_terminal_sessions terminal
               WHERE terminal.host_id = quick.host_id
            )`,
      )
      .all(now.toISOString()) as Array<{
      id: string;
      projectId: string;
      projectHostId: number;
      hostId: number;
      userId: string;
      syncId: string | null;
    }>;
    if (expired.length === 0) {
      if (expiredIdempotency > 0) await this.onWrite?.();
      return 0;
    }
    const credentials = await createCurrentProjectCredentialRepository();
    for (const item of expired) {
      await credentials.removeManagedForProjectHost(
        item.projectId,
        item.projectHostId,
      );
    }
    this.sqlite.transaction(() => {
      for (const item of expired) {
        this.sqlite
          .prepare("DELETE FROM agent_quick_connections WHERE id = ?")
          .run(item.id);
        this.sqlite
          .prepare(
            "DELETE FROM agent_provisioning_idempotency WHERE resource_sync_id = ?",
          )
          .run(item.id);
        this.sqlite
          .prepare("DELETE FROM project_hosts WHERE id = ?")
          .run(item.projectHostId);
        const remainingLinks = this.sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM project_hosts WHERE host_id = ?",
          )
          .get(item.hostId) as { count: number };
        // 临时主机可能在有效期内被管理员关联到其他项目。此时只移除
        // 快速连接入口，保留底层主机，避免清理任务误删正式资产。
        if (remainingLinks.count > 0) continue;
        this.sqlite
          .prepare("DELETE FROM ssh_data WHERE id = ?")
          .run(item.hostId);
        if (item.syncId) {
          this.sqlite
            .prepare(
              `INSERT OR IGNORE INTO sync_tombstones
                 (user_id, entity_type, sync_id)
               VALUES (?, 'hosts', ?)`,
            )
            .run(item.userId, item.syncId);
        }
      }
    })();
    await this.onWrite?.();
    return expired.length;
  }
}
