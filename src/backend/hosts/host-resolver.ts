import {
  createCurrentHostResolutionRepository,
  createCurrentVaultProfileRepository,
  createCurrentUserRepository,
} from "../database/repositories/factory.js";
import { logAuditOrThrow } from "../utils/audit-logger.js";
import { logger } from "../utils/logger.js";
import {
  pickResolvedPassword,
  pickResolvedUsername,
  expandOidcUsername,
} from "./credential-username.js";
import type { SSHHost } from "../../types/index.js";
import type { HostAction } from "../utils/permission-manager.js";
import { createCurrentProjectCredentialRepository } from "../control-plane/factory.js";
import { DatabaseSaveTrigger } from "../utils/database-save-trigger.js";
import { normalizePortKnockSequence } from "./port-knock-sequence.js";

const sshLogger = logger;

export interface ProjectHostCredentialInitialization {
  projectId: string;
  projectHostId: number;
  hostId: number;
  createdBy: string;
}

/**
 * 在项目主机关联建立时，把主机所有者的 SSH 凭据立即转存到项目凭据库。
 * 该流程不经过浏览器，也不要求项目成员持有主机所有者的数据密钥。
 */
async function prepareProjectHostCredential(
  input: ProjectHostCredentialInitialization,
): Promise<boolean> {
  const credentialRepository = await createCurrentProjectCredentialRepository();
  const reference = await credentialRepository.findProjectHostReference(
    input.projectHostId,
  );
  if (
    !reference ||
    reference.projectId !== input.projectId ||
    reference.hostId !== input.hostId
  ) {
    throw new Error("Project host reference does not match the requested host");
  }

  const assigned = await credentialRepository.resolveForProjectHost(
    input.projectHostId,
  );
  if (assigned) {
    if (
      assigned.projectId !== input.projectId ||
      assigned.hostId !== input.hostId
    ) {
      throw new Error("Project credential belongs to another host");
    }
    if (!assigned.managed) return false;
  }

  const repository = createCurrentHostResolutionRepository();
  const ownerId = await repository.findHostOwnerId(input.hostId);
  if (!ownerId) throw new Error("Host owner could not be resolved");
  const resolvedHost = await repository.findHostById(input.hostId, ownerId);
  if (!resolvedHost) throw new Error("Host credentials are locked");

  const host = resolvedHost as Record<string, unknown>;
  await resolveOwnerSshCredential(host, input.hostId, ownerId, repository);
  host.username = await expandOidcUsername(
    host.username as string | undefined,
    ownerId,
  );
  const authType = String(host.authType);
  if (!isProjectCredentialAuthType(authType)) {
    if (assigned?.managed) {
      return credentialRepository.removeManagedForProjectHost(
        input.projectId,
        input.projectHostId,
      );
    }
    throw new Error(`Unsupported project SSH authentication type: ${authType}`);
  }

  const result = await credentialRepository.ensureForProjectHost({
    projectId: input.projectId,
    projectHostId: input.projectHostId,
    hostName: String(host.name || host.ip || input.hostId),
    username: String(host.username || ""),
    authType,
    keyType: typeof host.keyType === "string" ? host.keyType : null,
    secret: {
      password: typeof host.password === "string" ? host.password : undefined,
      privateKey: typeof host.key === "string" ? host.key : undefined,
      passphrase:
        typeof host.keyPassword === "string" ? host.keyPassword : undefined,
      certificate:
        typeof host.certPublicKey === "string" ? host.certPublicKey : undefined,
    },
    createdBy: input.createdBy,
  });
  return result.changed;
}

export async function initializeProjectHostCredential(
  input: ProjectHostCredentialInitialization,
): Promise<void> {
  await prepareProjectHostCredential(input);
}

function isProjectCredentialAuthType(
  authType: string,
): authType is "password" | "key" | "none" {
  return authType === "password" || authType === "key" || authType === "none";
}

async function synchronizeProjectHostReferences(
  references: Array<{
    projectId: string;
    projectHostId: number;
    hostId: number;
  }>,
  createdBy: string,
): Promise<void> {
  let firstError: unknown;
  let changed = false;
  for (const reference of references) {
    try {
      changed =
        (await prepareProjectHostCredential({
          ...reference,
          createdBy,
        })) || changed;
    } catch (error) {
      firstError ??= error;
    }
  }
  if (changed) {
    await DatabaseSaveTrigger.forceSave("project_credential_resync");
  }
  if (firstError) throw firstError;
}

export async function synchronizeProjectHostCredentialsForHost(
  hostId: number,
  ownerId: string,
): Promise<void> {
  const credentialRepository = await createCurrentProjectCredentialRepository();
  const references =
    await credentialRepository.listProjectHostReferencesForHost(hostId);
  await synchronizeProjectHostReferences(references, ownerId);
}

export async function synchronizeProjectHostCredentialsForOwner(
  ownerId: string,
): Promise<void> {
  const credentialRepository = await createCurrentProjectCredentialRepository();
  const references =
    await credentialRepository.listProjectHostReferencesForOwner(ownerId);
  await synchronizeProjectHostReferences(references, ownerId);
}

/**
 * Resolve a host with its credentials server-side by hostId.
 * This avoids passing credentials through the frontend.
 */
export async function resolveHostById(
  hostId: number,
  userId: string,
  projectHostId?: number,
): Promise<SSHHost | null> {
  const { PermissionManager } = await import("../utils/permission-manager.js");
  const access = await PermissionManager.getInstance().canAccessHost(
    userId,
    hostId,
    "connect",
    projectHostId,
  );
  if (!access.hasAccess) return null;

  const repository = createCurrentHostResolutionRepository();

  // Decrypt under the owner's DEK: shared hosts carry owner-encrypted fields
  // (socks5Password, inline auth, ...) that the requester's key cannot open.
  const ownerId = (await repository.findHostOwnerId(hostId)) ?? userId;
  let projectCredential: Awaited<
    ReturnType<
      Awaited<
        ReturnType<typeof createCurrentProjectCredentialRepository>
      >["resolveForProjectHost"]
    >
  > | null = null;
  if (access.projectHostId && access.projectId) {
    try {
      const candidate = await (
        await createCurrentProjectCredentialRepository()
      ).resolveForProjectHost(access.projectHostId);
      if (candidate) {
        if (
          candidate.projectId !== access.projectId ||
          candidate.hostId !== hostId
        ) {
          sshLogger.warn("Rejected mismatched project credential", {
            operation: "host_resolver_project_credential_mismatch",
            hostId,
            projectHostId: access.projectHostId,
          });
          return null;
        }
        projectCredential = candidate;
      }
    } catch (error) {
      sshLogger.warn("Failed to resolve project credential", {
        operation: "host_resolver_project_credential",
        hostId,
        projectHostId: access.projectHostId,
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      return null;
    }
  }

  const decryptedHost = await repository.findHostById(hostId, ownerId);
  const resolvedHost =
    decryptedHost ??
    (projectCredential
      ? await repository.findHostByIdWithEncryptedFieldsRedacted(hostId)
      : null);
  if (!resolvedHost) return null;

  const host = resolvedHost as Record<string, unknown>;

  // 连接阶段只读取项目凭据，不反向写回。主机或个人凭据的新增、编辑、
  // 删除路径会显式同步托管镜像；在这里刷新会让旧主机快照覆盖已轮换的凭据。

  if (projectCredential) {
    host.ip = projectCredential.address;
    host.port = projectCredential.port;
    host.username = projectCredential.username;
    host.authType = projectCredential.authType;
    host.password = projectCredential.secret.password ?? null;
    host.key = projectCredential.secret.privateKey ?? null;
    host.keyPassword = projectCredential.secret.passphrase ?? null;
    host.keyType = projectCredential.keyType ?? null;
    host.certPublicKey = projectCredential.secret.certificate ?? null;
    host.credentialId = null;
  }

  // Admin bypass resolves like the owner would; every such access is audited.
  const ownerEquivalent = userId === ownerId || access.isAdminBypass === true;

  if (access.isAdminBypass && userId !== ownerId) {
    try {
      const admin = await createCurrentUserRepository().findById(userId);
      await logAuditOrThrow({
        userId,
        username: admin?.username ?? "unknown",
        action: "admin_connect_host",
        resourceType: "host",
        resourceId: String(hostId),
        resourceName: (host.name as string) || (host.ip as string) || "",
        details: JSON.stringify({ ownerId }),
        success: true,
      });
    } catch (error) {
      sshLogger.error("Admin host access audit failed", error, {
        operation: "admin_connect_host_audit_failed",
        hostId,
        userId,
      });
      return null;
    }
  }

  if (!ownerEquivalent) {
    // Owner-only operational secrets are never shared.
    host.sudoPassword = null;
    host.autostartPassword = null;
    host.autostartKey = null;
    host.autostartKeyPassword = null;
  }

  // Parse JSON fields
  if (typeof host.jumpHosts === "string" && host.jumpHosts) {
    try {
      host.jumpHosts = JSON.parse(host.jumpHosts as string);
    } catch {
      host.jumpHosts = [];
    }
  }
  if (typeof host.tunnelConnections === "string") {
    try {
      host.tunnelConnections = JSON.parse(host.tunnelConnections as string);
    } catch {
      host.tunnelConnections = [];
    }
  }
  if (typeof host.statsConfig === "string" && host.statsConfig) {
    try {
      host.statsConfig = JSON.parse(host.statsConfig as string);
    } catch {
      host.statsConfig = undefined;
    }
  }
  if (typeof host.terminalConfig === "string" && host.terminalConfig) {
    try {
      host.terminalConfig = JSON.parse(host.terminalConfig as string);
    } catch {
      host.terminalConfig = undefined;
    }
  }
  if (typeof host.socks5ProxyChain === "string" && host.socks5ProxyChain) {
    try {
      host.socks5ProxyChain = JSON.parse(host.socks5ProxyChain as string);
    } catch {
      host.socks5ProxyChain = [];
    }
  }
  if (typeof host.quickActions === "string" && host.quickActions) {
    try {
      host.quickActions = JSON.parse(host.quickActions as string);
    } catch {
      host.quickActions = [];
    }
  }
  // 旧版数据库将布尔开关保存为文本。解析主机时统一转成真正的布尔值，
  // 避免字符串 "false" 在终端认证分支中被当成 true。
  if ("forceKeyboardInteractive" in host) {
    host.forceKeyboardInteractive =
      host.forceKeyboardInteractive === true ||
      host.forceKeyboardInteractive === "true" ||
      host.forceKeyboardInteractive === 1;
  }
  host.portKnockSequence = normalizePortKnockSequence(host.portKnockSequence);

  if (projectCredential) {
    // 项目凭据已在平台凭据库中解析，无需访问用户个人凭据快照。
  } else if (access.projectHostId) {
    await resolveOwnerSshCredential(host, hostId, ownerId, repository);
  } else if (!ownerEquivalent) {
    const resolved = await resolveSharedSshSecrets(
      host,
      hostId,
      userId,
      repository,
    );
    if (!resolved) return null;
  } else {
    await resolveOwnerSshCredential(host, hostId, ownerId, repository);
  }

  if (
    access.projectHostId &&
    access.projectId &&
    !projectCredential &&
    isProjectCredentialAuthType(String(host.authType))
  ) {
    try {
      const changed = await prepareProjectHostCredential({
        projectId: access.projectId,
        projectHostId: access.projectHostId,
        hostId,
        createdBy: ownerId,
      });
      if (changed) {
        await DatabaseSaveTrigger.forceSave("project_credential_mirror");
      }
    } catch (error) {
      sshLogger.warn("Failed to mirror project credential", {
        operation: "host_resolver_project_credential_mirror",
        hostId,
        projectHostId: access.projectHostId,
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  host.username = await expandOidcUsername(
    host.username as string | undefined,
    ownerEquivalent || access.projectHostId ? ownerId : userId,
  );

  // Resolve a Vault SSH signer profile (shared settings, no secrets). The
  // certificate itself is obtained per-user at connect time via Vault OIDC.
  if (host.vaultProfileId) {
    try {
      const profile = await createCurrentVaultProfileRepository().findById(
        host.vaultProfileId as number,
      );
      if (profile) {
        (host as Record<string, unknown>).vaultProfile = profile;
        host.authType = "vault";
      }
    } catch (e) {
      sshLogger.warn("Failed to resolve vault profile for host", {
        operation: "host_resolver_vault_profile",
        hostId,
        error: e instanceof Error ? e.message : "Unknown",
      });
    }
  }

  return host as unknown as SSHHost;
}

async function resolveOwnerSshCredential(
  host: Record<string, unknown>,
  hostId: number,
  ownerId: string,
  repository: ReturnType<typeof createCurrentHostResolutionRepository>,
): Promise<void> {
  let effectiveCredentialId = host.credentialId as number | null | undefined;
  if (!effectiveCredentialId && host.authType === "credential" && host.folder) {
    try {
      effectiveCredentialId = await repository.findFolderCredentialId(
        ownerId,
        host.folder as string,
      );
    } catch (error) {
      sshLogger.warn("Failed to resolve folder credential for host", {
        operation: "host_resolver_folder_credential",
        hostId,
        error: error instanceof Error ? error.message : "Unknown",
      });
    }
  }

  if (!effectiveCredentialId) return;
  try {
    const credential = (await repository.findCredentialByIdForUser(
      effectiveCredentialId,
      ownerId,
    )) as Record<string, unknown> | null;
    if (!credential) return;

    const credentialKey = credential.privateKey || credential.key;
    host.password = pickResolvedPassword(
      host.password,
      credential.password,
      credential.authType,
      credentialKey,
    );
    host.key = credentialKey as string | null;
    host.keyPassword = credential.keyPassword;
    host.keyType = credential.keyType;
    host.certPublicKey = credential.certPublicKey || null;
    host.username = pickResolvedUsername(
      host.username,
      credential.username,
      host.overrideCredentialUsername,
    );
    host.authType = host.key ? "key" : host.password ? "password" : "none";
  } catch (error) {
    sshLogger.warn("Failed to resolve credential for host", {
      operation: "host_resolver_credential",
      hostId,
      error: error instanceof Error ? error.message : "Unknown",
    });
  }
}

/**
 * Fill in SSH auth secrets for a shared (non-owner) requester. Order:
 * the recipient's own override credential, then their re-encrypted share
 * snapshot. Secret-less auth types (opkssh, vault, agent, none) pass through
 * untouched. Returns false when a secret-bearing host has no usable source.
 */
async function resolveSharedSshSecrets(
  host: Record<string, unknown>,
  hostId: number,
  userId: string,
  repository: ReturnType<typeof createCurrentHostResolutionRepository>,
): Promise<boolean> {
  try {
    const overrideCredId = await repository.findOverrideCredentialId(
      hostId,
      userId,
    );
    if (overrideCredId) {
      const cred = (await repository.findCredentialByIdForUser(
        overrideCredId,
        userId,
      )) as Record<string, unknown> | null;
      if (cred) {
        host.password = cred.password;
        host.key = (cred.privateKey || cred.key) as string | null;
        host.keyPassword = cred.keyPassword;
        host.keyType = cred.keyType;
        host.username = pickResolvedUsername(
          host.username,
          cred.username,
          host.overrideCredentialUsername,
        );
        host.authType = host.key ? "key" : host.password ? "password" : "none";
        return true;
      }
    }
  } catch {
    // fall through to the share snapshot
  }

  try {
    const { SharedHostSecretsManager } =
      await import("../utils/shared-host-secrets-manager.js");
    const secret =
      await SharedHostSecretsManager.getInstance().getSecretForUser(
        hostId,
        userId,
        "ssh",
      );
    if (secret) {
      host.password = secret.password;
      host.key = secret.key;
      host.keyPassword = secret.keyPassword;
      host.keyType = secret.keyType;
      host.username = pickResolvedUsername(
        host.username,
        secret.username,
        host.overrideCredentialUsername,
      );
      host.authType = secret.key
        ? "key"
        : secret.password
          ? "password"
          : "none";
      return true;
    }
  } catch (e) {
    sshLogger.warn("Failed to get shared host secret", {
      operation: "host_resolver_shared_secret",
      hostId,
      error: e instanceof Error ? e.message : "Unknown",
    });
  }

  const needsSecrets =
    !!host.credentialId ||
    host.authType === "password" ||
    host.authType === "key" ||
    host.authType === "credential";
  if (!needsSecrets) return true;

  return false;
}

/**
 * Check if a user has access to a host (owner or shared access).
 */
export async function checkHostAccess(
  hostId: number,
  userId: string,
  hostUserId: string,
  requiredPermission: HostAction = "connect",
): Promise<boolean> {
  if (userId === hostUserId) return true;

  try {
    const { PermissionManager } =
      await import("../utils/permission-manager.js");
    const permissionManager = PermissionManager.getInstance();
    const accessInfo = await permissionManager.canAccessHost(
      userId,
      hostId,
      requiredPermission,
    );
    return accessInfo.hasAccess;
  } catch {
    return false;
  }
}
