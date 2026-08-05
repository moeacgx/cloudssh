import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  host: null as Record<string, unknown> | null,
  hasAccess: true,
  isAdminBypass: false,
  overrideCredentialId: null as number | null,
  credentials: new Map<string, Record<string, unknown>>(),
  sharedSecret: null as Record<string, unknown> | null,
  auditCalls: [] as Record<string, unknown>[],
  auditFailure: null as Error | null,
  folderCredentialId: null as number | null,
  decryptedHostAvailable: true,
  projectId: null as string | null,
  projectHostId: null as number | null,
  projectCredential: null as Record<string, unknown> | null,
  projectCredentialError: null as Error | null,
  projectReference: null as { projectId: string; hostId: number } | null,
  ensureProjectCredentialCalls: [] as Record<string, unknown>[],
  saveReasons: [] as string[],
  warningCalls: [] as unknown[][],
  projectHostReferencesForHost: [] as Array<{
    projectId: string;
    projectHostId: number;
    hostId: number;
  }>,
  projectHostReferencesForOwner: [] as Array<{
    projectId: string;
    projectHostId: number;
    hostId: number;
  }>,
}));

vi.mock("../../database/repositories/factory.js", () => ({
  createCurrentHostResolutionRepository: () => ({
    findHostOwnerId: async () => (state.host?.userId as string) ?? null,
    findHostById: async () =>
      state.host && state.decryptedHostAvailable ? { ...state.host } : null,
    findHostByIdWithEncryptedFieldsRedacted: async () =>
      state.host
        ? {
            ...state.host,
            password: null,
            key: null,
            keyPassword: null,
            sudoPassword: null,
            autostartPassword: null,
            autostartKey: null,
            autostartKeyPassword: null,
            socks5Password: null,
          }
        : null,
    findOverrideCredentialId: async () => state.overrideCredentialId,
    findCredentialByIdForUser: async (credentialId: number, userId: string) =>
      state.credentials.get(`${credentialId}:${userId}`) ?? null,
    findFolderCredentialId: async () => state.folderCredentialId,
  }),
  createCurrentVaultProfileRepository: () => ({
    findById: async () => null,
  }),
  createCurrentUserRepository: () => ({
    findById: async (userId: string) => ({ id: userId, username: userId }),
  }),
}));

vi.mock("../../control-plane/factory.js", () => ({
  createCurrentProjectCredentialRepository: async () => ({
    findProjectHostReference: async () => state.projectReference,
    resolveForProjectHost: async () => {
      if (state.projectCredentialError) throw state.projectCredentialError;
      return state.projectCredential;
    },
    ensureForProjectHost: async (input: Record<string, unknown>) => {
      state.ensureProjectCredentialCalls.push(input);
      state.projectCredential = {
        projectId: input.projectId,
        hostId: state.projectReference?.hostId,
        address: state.host?.ip,
        port: state.host?.port,
        username: input.username,
        authType: input.authType,
        keyType: input.keyType,
        secret: input.secret,
        managed: true,
        changed: true,
      };
      return state.projectCredential;
    },
    removeManagedForProjectHost: async () => {
      state.projectCredential = null;
      return true;
    },
    listProjectHostReferencesForHost: async () =>
      state.projectHostReferencesForHost,
    listProjectHostReferencesForOwner: async () =>
      state.projectHostReferencesForOwner,
  }),
}));

vi.mock("../../utils/database-save-trigger.js", () => ({
  DatabaseSaveTrigger: {
    forceSave: async (reason: string) => {
      state.saveReasons.push(reason);
    },
  },
}));

vi.mock("../../utils/audit-logger.js", () => ({
  logAuditOrThrow: async (params: Record<string, unknown>) => {
    if (state.auditFailure) throw state.auditFailure;
    state.auditCalls.push(params);
  },
}));

vi.mock("../../utils/permission-manager.js", () => ({
  PermissionManager: {
    getInstance: () => ({
      canAccessHost: async () => ({
        hasAccess: state.hasAccess,
        isAdminBypass: state.isAdminBypass,
        projectId: state.projectId ?? undefined,
        projectHostId: state.projectHostId ?? undefined,
      }),
    }),
  },
}));

vi.mock("../../utils/shared-host-secrets-manager.js", () => ({
  SharedHostSecretsManager: {
    getInstance: () => ({
      getSecretForUser: async () => state.sharedSecret,
    }),
  },
}));

vi.mock("../../utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => state.warningCalls.push(args),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import {
  initializeProjectHostCredential,
  resolveHostById,
  synchronizeProjectHostCredentialsForHost,
} from "../../hosts/host-resolver.js";

function baseHost(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    userId: "owner",
    name: "prod",
    ip: "10.0.0.42",
    port: 22,
    username: "root",
    authType: "password",
    password: "owner-secret",
    key: null,
    keyPassword: null,
    keyType: null,
    credentialId: null,
    vaultProfileId: null,
    sudoPassword: "owner-sudo",
    autostartPassword: "auto-pass",
    autostartKey: null,
    autostartKeyPassword: null,
    jumpHosts: null,
    tunnelConnections: null,
    statsConfig: null,
    terminalConfig: null,
    socks5ProxyChain: null,
    quickActions: null,
    portKnockSequence: null,
    overrideCredentialUsername: false,
    ...overrides,
  };
}

beforeEach(() => {
  state.host = baseHost();
  state.hasAccess = true;
  state.isAdminBypass = false;
  state.overrideCredentialId = null;
  state.credentials.clear();
  state.sharedSecret = null;
  state.auditCalls = [];
  state.auditFailure = null;
  state.folderCredentialId = null;
  state.decryptedHostAvailable = true;
  state.projectId = null;
  state.projectHostId = null;
  state.projectCredential = null;
  state.projectCredentialError = null;
  state.projectReference = null;
  state.ensureProjectCredentialCalls = [];
  state.saveReasons = [];
  state.warningCalls = [];
  state.projectHostReferencesForHost = [];
  state.projectHostReferencesForOwner = [];
});

describe("resolveHostById", () => {
  it("returns null when access is denied", async () => {
    state.hasAccess = false;
    expect(await resolveHostById(42, "stranger")).toBeNull();
  });

  it("解析数据库中的端口敲门 JSON 并兼容异常旧值", async () => {
    state.host = baseHost({
      portKnockSequence:
        '[{"port":4000,"protocol":"TCP","delay":"120"},{"port":70000}]',
    });

    const host = (await resolveHostById(42, "owner")) as Record<
      string,
      unknown
    >;
    expect(host.portKnockSequence).toEqual([
      { port: 4000, protocol: "tcp", delay: 120 },
    ]);

    state.host = baseHost({ portKnockSequence: { port: 4000 } });
    const legacyHost = (await resolveHostById(42, "owner")) as Record<
      string,
      unknown
    >;
    expect(legacyHost.portKnockSequence).toEqual([]);
  });

  it("resolves the owner's credential on the owner path", async () => {
    // Empty host username so the credential's username is used as fallback.
    state.host = baseHost({
      authType: "credential",
      credentialId: 9,
      username: "",
    });
    state.credentials.set("9:owner", {
      id: 9,
      username: "cred-user",
      authType: "key",
      password: null,
      privateKey: "PRIVATE-KEY",
      key: null,
      keyPassword: "kp",
      keyType: "ssh-ed25519",
      certPublicKey: null,
    });

    const host = (await resolveHostById(42, "owner")) as Record<
      string,
      unknown
    >;
    expect(host.key).toBe("PRIVATE-KEY");
    expect(host.username).toBe("cred-user");
    expect(host.authType).toBe("key");
    expect(host.sudoPassword).toBe("owner-sudo");
  });

  it("falls back to the host's folder-assigned credential when none is set on the host", async () => {
    state.host = baseHost({
      authType: "credential",
      credentialId: null,
      folder: "switches",
      username: "",
      password: null,
    });
    state.folderCredentialId = 11;
    state.credentials.set("11:owner", {
      id: 11,
      username: "folder-user",
      authType: "password",
      password: "folder-pass",
      privateKey: null,
      key: null,
      keyPassword: null,
      keyType: null,
    });

    const host = (await resolveHostById(42, "owner")) as Record<
      string,
      unknown
    >;
    expect(host.password).toBe("folder-pass");
    expect(host.username).toBe("folder-user");
    expect(host.authType).toBe("password");
  });

  it("prefers the host's own credential over its folder's credential", async () => {
    state.host = baseHost({
      authType: "credential",
      credentialId: 9,
      folder: "switches",
      username: "",
      password: null,
    });
    state.folderCredentialId = 11;
    state.credentials.set("9:owner", {
      id: 9,
      username: "host-user",
      authType: "password",
      password: "host-pass",
      privateKey: null,
      key: null,
      keyPassword: null,
      keyType: null,
    });

    const host = (await resolveHostById(42, "owner")) as Record<
      string,
      unknown
    >;
    expect(host.username).toBe("host-user");
    expect(host.password).toBe("host-pass");
  });

  it("uses an updated password credential instead of a stale inline host password", async () => {
    state.host = baseHost({
      authType: "credential",
      credentialId: 9,
      password: "stale-inline-password",
    });
    state.credentials.set("9:owner", {
      id: 9,
      username: "root",
      authType: "password",
      password: "latest-credential-password",
      privateKey: null,
      key: null,
      keyPassword: null,
      keyType: null,
    });

    const host = (await resolveHostById(42, "owner")) as Record<
      string,
      unknown
    >;

    expect(host.password).toBe("latest-credential-password");
    expect(host.authType).toBe("password");
  });

  it("keeps the host password fallback when the linked credential uses a key", async () => {
    state.host = baseHost({
      authType: "credential",
      credentialId: 9,
      password: "host-fallback-password",
    });
    state.credentials.set("9:owner", {
      id: 9,
      username: "root",
      authType: "key",
      password: null,
      privateKey: "PRIVATE-KEY",
      key: null,
      keyPassword: null,
      keyType: "ssh-ed25519",
    });

    const host = (await resolveHostById(42, "owner")) as Record<
      string,
      unknown
    >;

    expect(host.password).toBe("host-fallback-password");
    expect(host.key).toBe("PRIVATE-KEY");
    expect(host.authType).toBe("key");
  });

  it("uses the share snapshot for a non-owner and strips owner-only secrets", async () => {
    state.host = baseHost({ username: "" });
    state.sharedSecret = {
      username: "shared-user",
      authType: "password",
      password: "shared-pass",
    };

    const host = (await resolveHostById(42, "recipient")) as Record<
      string,
      unknown
    >;
    expect(host.password).toBe("shared-pass");
    expect(host.username).toBe("shared-user");
    expect(host.sudoPassword).toBeNull();
    expect(host.autostartPassword).toBeNull();
  });

  it("prefers the recipient's override credential over the snapshot", async () => {
    state.host = baseHost({ username: "" });
    state.overrideCredentialId = 5;
    state.credentials.set("5:recipient", {
      id: 5,
      username: "my-user",
      authType: "password",
      password: "my-pass",
      privateKey: null,
      key: null,
      keyPassword: null,
      keyType: null,
    });
    state.sharedSecret = {
      username: "shared-user",
      authType: "password",
      password: "shared-pass",
    };

    const host = (await resolveHostById(42, "recipient")) as Record<
      string,
      unknown
    >;
    expect(host.password).toBe("my-pass");
    expect(host.username).toBe("my-user");
  });

  it("denies a non-owner when a secret-bearing host has no snapshot", async () => {
    expect(await resolveHostById(42, "recipient")).toBeNull();
  });

  it("lets a non-owner through on secret-less auth types without a snapshot", async () => {
    state.host = baseHost({ authType: "none", password: null });
    const host = await resolveHostById(42, "recipient");
    expect(host).not.toBeNull();
  });

  it("resolves an admin bypass like the owner, keeping owner-only secrets", async () => {
    state.isAdminBypass = true;
    state.host = baseHost({
      authType: "credential",
      credentialId: 9,
      username: "",
      password: null,
    });
    state.credentials.set("9:owner", {
      id: 9,
      username: "cred-user",
      authType: "key",
      password: null,
      privateKey: "OWNER-PRIVATE-KEY",
      key: null,
      keyPassword: "kp",
      keyType: "ssh-ed25519",
      certPublicKey: null,
    });

    const host = (await resolveHostById(42, "adminUser")) as Record<
      string,
      unknown
    >;
    // Owner credential resolved (not the share snapshot path).
    expect(host.key).toBe("OWNER-PRIVATE-KEY");
    expect(host.username).toBe("cred-user");
    // Owner-only operational secrets are NOT stripped for the admin.
    expect(host.sudoPassword).toBe("owner-sudo");
    expect(host.autostartPassword).toBe("auto-pass");
  });

  it("将旧数据库的键盘交互文本开关规范为布尔值", async () => {
    state.host = baseHost({ forceKeyboardInteractive: "false" });

    const host = (await resolveHostById(42, "owner")) as Record<
      string,
      unknown
    >;

    expect(host.forceKeyboardInteractive).toBe(false);
  });

  it("audits every admin-bypass host resolution", async () => {
    state.isAdminBypass = true;
    await resolveHostById(42, "adminUser");
    expect(state.auditCalls).toHaveLength(1);
    expect(state.auditCalls[0]).toMatchObject({
      action: "admin_connect_host",
      resourceType: "host",
      resourceId: "42",
      userId: "adminUser",
    });
  });

  it("审计存储不可用时拒绝管理员越权解析主机凭据", async () => {
    state.isAdminBypass = true;
    state.auditFailure = new Error("audit unavailable");

    await expect(resolveHostById(42, "adminUser")).resolves.toBeNull();
    expect(state.auditCalls).toHaveLength(0);
  });

  it("does not audit an ordinary owner resolution", async () => {
    await resolveHostById(42, "owner");
    expect(state.auditCalls).toHaveLength(0);
  });

  it("uses an existing project credential without unlocking the host owner's data key", async () => {
    state.projectId = "project-1";
    state.projectHostId = 9;
    state.projectReference = { projectId: "project-1", hostId: 42 };
    state.decryptedHostAvailable = false;
    state.host = baseHost({
      useSocks5: true,
      socks5Password: "ENCRYPTED-SOCKS-PASSWORD",
      jumpHosts: '[{"hostId":7}]',
      terminalConfig: '{"fontSize":14}',
    });
    state.projectCredential = {
      projectId: "project-1",
      hostId: 42,
      address: "10.0.0.42",
      port: 22,
      username: "project-user",
      authType: "key",
      keyType: "ssh-ed25519",
      secret: {
        privateKey: "PROJECT-PRIVATE-KEY",
        passphrase: "project-passphrase",
        certificate: "ssh-ed25519-cert-v01@openssh.com CERTIFICATE",
      },
    };

    const host = (await resolveHostById(42, "operator", 9)) as Record<
      string,
      unknown
    >;
    expect(host.username).toBe("project-user");
    expect(host.key).toBe("PROJECT-PRIVATE-KEY");
    expect(host.keyPassword).toBe("project-passphrase");
    expect(host.certPublicKey).toContain("CERTIFICATE");
    expect(host.socks5Password).toBeNull();
    expect(host.jumpHosts).toEqual([{ hostId: 7 }]);
    expect(host.terminalConfig).toEqual({ fontSize: 14 });
    expect(state.ensureProjectCredentialCalls).toHaveLength(0);
  });

  it("keeps a managed project credential authoritative during connection", async () => {
    state.projectId = "project-1";
    state.projectHostId = 9;
    state.projectReference = { projectId: "project-1", hostId: 42 };
    state.host = baseHost({
      // 密码轮换后旧主机行可能仍有过期快照。项目连接必须以项目凭据库为准，
      // 不能因为打开一次终端就反向改写项目凭据。
      username: "stale-user",
      authType: "password",
      password: "stale-password",
    });
    state.projectCredential = {
      projectId: "project-1",
      hostId: 42,
      address: "10.0.0.42",
      port: 22,
      username: "old-user",
      authType: "password",
      keyType: null,
      secret: { password: "old-password" },
      managed: true,
    };

    const host = (await resolveHostById(42, "operator", 9)) as Record<
      string,
      unknown
    >;

    expect(state.ensureProjectCredentialCalls).toHaveLength(0);
    expect(host.username).toBe("old-user");
    expect(host.password).toBe("old-password");
    expect(state.saveReasons).not.toContain("project_credential_refresh");
  });

  it("rejects a project credential whose project or host does not match", async () => {
    state.projectId = "project-1";
    state.projectHostId = 9;
    state.projectReference = { projectId: "project-1", hostId: 42 };
    state.projectCredential = {
      projectId: "another-project",
      hostId: 42,
      secret: { password: "MUST-NOT-LEAK" },
    };

    await expect(resolveHostById(42, "operator", 9)).resolves.toBeNull();
    expect(JSON.stringify(state.warningCalls)).not.toContain("MUST-NOT-LEAK");
    expect(state.ensureProjectCredentialCalls).toHaveLength(0);
  });

  it("fails closed when the project credential vault cannot be decrypted", async () => {
    state.projectId = "project-1";
    state.projectHostId = 9;
    state.projectReference = { projectId: "project-1", hostId: 42 };
    state.projectCredentialError = new Error(
      "vault failed while handling PRIVATE-KEY-MATERIAL",
    );

    await expect(resolveHostById(42, "operator", 9)).resolves.toBeNull();
    expect(JSON.stringify(state.warningCalls)).not.toContain(
      "PRIVATE-KEY-MATERIAL",
    );
  });

  it("mirrors a legacy owner credential into the project vault once", async () => {
    state.projectId = "project-1";
    state.projectHostId = 9;
    state.projectReference = { projectId: "project-1", hostId: 42 };
    state.host = baseHost({
      authType: "credential",
      credentialId: 15,
      username: "",
      password: null,
    });
    state.credentials.set("15:owner", {
      id: 15,
      username: "legacy-user",
      authType: "password",
      password: "legacy-password",
      privateKey: null,
      key: null,
      keyPassword: null,
      keyType: null,
    });

    const host = (await resolveHostById(42, "operator", 9)) as Record<
      string,
      unknown
    >;
    expect(host.password).toBe("legacy-password");
    expect(state.ensureProjectCredentialCalls).toHaveLength(1);
    expect(state.ensureProjectCredentialCalls[0]).toMatchObject({
      projectId: "project-1",
      projectHostId: 9,
      username: "legacy-user",
      authType: "password",
      secret: { password: "legacy-password" },
    });
    expect(state.saveReasons).toEqual(["project_credential_mirror"]);
  });

  it("refuses association-time mirroring while the owner's credentials are locked", async () => {
    state.projectReference = { projectId: "project-1", hostId: 42 };
    state.decryptedHostAvailable = false;

    await expect(
      initializeProjectHostCredential({
        projectId: "project-1",
        projectHostId: 9,
        hostId: 42,
        createdBy: "owner",
      }),
    ).rejects.toThrow("Host credentials are locked");
    expect(state.ensureProjectCredentialCalls).toHaveLength(0);
  });

  it("resynchronizes project mirrors after an owner updates a source credential", async () => {
    state.projectReference = { projectId: "project-1", hostId: 42 };
    state.projectHostReferencesForHost = [
      { projectId: "project-1", projectHostId: 9, hostId: 42 },
    ];
    state.host = baseHost({
      authType: "password",
      username: "rotated-user",
      password: "rotated-password",
    });
    state.projectCredential = {
      projectId: "project-1",
      hostId: 42,
      managed: true,
      username: "old-user",
      authType: "password",
      secret: { password: "old-password" },
    };

    await synchronizeProjectHostCredentialsForHost(42, "owner");

    expect(state.ensureProjectCredentialCalls).toHaveLength(1);
    expect(state.ensureProjectCredentialCalls[0]).toMatchObject({
      projectId: "project-1",
      projectHostId: 9,
      username: "rotated-user",
      secret: { password: "rotated-password" },
    });
    expect(state.saveReasons).toContain("project_credential_resync");
  });
});
