import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";

const state = vi.hoisted(() => ({
  actingAsAdmin: true,
  apiKeyId: null as string | null,
  sessionId: "admin-session" as string | null,
  mfaVerifiedAt: Math.floor(Date.now() / 1000) as number | null,
  transportAllowed: true,
  auditFailure: null as Error | null,
  auditEntries: [] as Record<string, unknown>[],
  fixedSessions: [] as Array<{ id: string }>,
  activeSessions: [] as Array<{ id: string }>,
  host: {
    id: 7,
    userId: "target-user",
    name: "Production host",
    password: "test-password",
    key: "test-private-key",
    keyPassword: "test-passphrase",
  } as Record<string, unknown> | null,
}));

vi.mock("../../../hosts/terminal/session-manager.js", () => ({
  sessionManager: {
    findSessions: () => state.activeSessions,
  },
}));

vi.mock("../../../utils/trust-loopback-proxy.js", () => ({
  isAdministrativeTransportAllowed: () => state.transportAllowed,
}));

vi.mock("../../../utils/auth-manager.js", () => ({
  AuthManager: {
    getInstance: () => ({
      createAuthMiddleware:
        () =>
        (
          req: express.Request & {
            userId?: string;
            actingAdminUserId?: string;
            apiKeyId?: string;
            sessionId?: string;
            mfaVerifiedAt?: number;
          },
          _res: express.Response,
          next: express.NextFunction,
        ) => {
          req.userId = "target-user";
          if (state.actingAsAdmin) req.actingAdminUserId = "instance-admin";
          if (state.apiKeyId) req.apiKeyId = state.apiKeyId;
          if (state.sessionId) req.sessionId = state.sessionId;
          if (state.mfaVerifiedAt) req.mfaVerifiedAt = state.mfaVerifiedAt;
          next();
        },
      createDataAccessMiddleware:
        () =>
        (
          _req: express.Request,
          _res: express.Response,
          next: express.NextFunction,
        ) =>
          next(),
    }),
  },
}));

vi.mock("../../../utils/permission-manager.js", () => ({
  PermissionManager: {
    getInstance: () => ({
      canAccessHost: vi.fn(),
      hasPermission: vi.fn(),
    }),
  },
}));

vi.mock("../../../utils/data-crypto.js", () => ({
  DataCrypto: {
    getUserDataKey: vi.fn(),
    decryptRecord: vi.fn(),
  },
}));

vi.mock("../../../utils/audit-logger.js", () => ({
  getAuditActorContext: () => ({ actorUserId: "instance-admin" }),
  getRequestMeta: () => ({ ipAddress: "127.0.0.1", userAgent: "test" }),
  logAudit: vi.fn(),
  logAuditOrThrow: async (entry: Record<string, unknown>) => {
    if (state.auditFailure) throw state.auditFailure;
    state.auditEntries.push(entry);
  },
}));

vi.mock("../../../utils/logger.js", () => ({
  sshLogger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
  databaseLogger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("../../../database/repositories/factory.js", () => ({
  createCurrentCommandHistoryRepository: () => ({}),
  createCurrentCredentialRepository: () => ({}),
  createCurrentFileManagerBookmarkRepository: () => ({}),
  createCurrentOpksshTokenRepository: () => ({}),
  createCurrentRecentActivityRepository: () => ({}),
  createCurrentSessionRecordingRepository: () => ({}),
  createCurrentSshCredentialUsageRepository: () => ({}),
  createCurrentSyncTombstoneRepository: () => ({}),
  createCurrentTransferRecentRepository: () => ({}),
  createCurrentRbacAccessRepository: () => ({}),
  createCurrentRoleRepository: () => ({}),
  createCurrentHostRepository: () => ({}),
  createCurrentHostResolutionRepository: () => ({
    findHostById: async () => state.host,
    findHostByIdForUser: async (_hostId: number, userId: string) =>
      state.host?.userId === userId ? state.host : null,
  }),
  createCurrentWebTerminalSessionRepository: () => ({
    listForHost: async () => state.fixedSessions,
  }),
  createCurrentUserRepository: () => ({
    findById: async (id: string) => ({ id, username: "instance-admin" }),
  }),
}));

vi.mock("../../../hosts/host-resolver.js", () => ({
  synchronizeProjectHostCredentialsForHost: vi.fn(),
}));

vi.mock("../../../database/routes/host-opkssh-routes.js", () => ({
  registerHostOpksshRoutes: vi.fn(),
}));
vi.mock("../../../database/routes/host-folder-routes.js", () => ({
  registerHostFolderRoutes: vi.fn(),
}));
vi.mock(
  "../../../database/routes/host-file-manager-bookmark-routes.js",
  () => ({
    registerHostFileManagerBookmarkRoutes: vi.fn(),
  }),
);
vi.mock("../../../database/routes/host-command-history-routes.js", () => ({
  registerHostCommandHistoryRoutes: vi.fn(),
}));
vi.mock("../../../database/routes/host-autostart-routes.js", () => ({
  registerHostAutostartRoutes: vi.fn(),
}));
vi.mock("../../../database/routes/host-internal-routes.js", () => ({
  registerHostInternalRoutes: vi.fn(),
}));
vi.mock("../../../database/routes/host-network-routes.js", () => ({
  registerHostNetworkRoutes: vi.fn(),
}));
vi.mock("../../../database/routes/host-bulk-routes.js", () => ({
  registerHostBulkRoutes: vi.fn(),
}));
vi.mock("../../../database/routes/host-enrollment-auth.js", () => ({
  applyHostEnrollmentDefaults: (data: unknown) => data,
  requireHostEnrollmentAccessForPath: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));

const { default: hostRouter } =
  await import("../../../database/routes/host.js");

const app = express();
app.use(express.json());
app.use(hostRouter);

let server: Server | null = null;
let baseUrl = "";

async function request(path: string, init?: RequestInit) {
  if (!server) {
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not expose a TCP port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  }
  return fetch(`${baseUrl}${path}`, init);
}

afterAll(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server?.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  state.actingAsAdmin = true;
  state.apiKeyId = null;
  state.sessionId = "admin-session";
  state.mfaVerifiedAt = Math.floor(Date.now() / 1000);
  state.transportAllowed = true;
  state.auditFailure = null;
  state.auditEntries = [];
  state.fixedSessions = [];
  state.activeSessions = [];
  state.host = {
    id: 7,
    userId: "target-user",
    name: "Production host",
    password: "test-password",
    key: "test-private-key",
    keyPassword: "test-passphrase",
  };
});

describe("管理员主机明文访问", () => {
  it("查看时返回请求的明文字段并记录不含秘密值的专用审计", async () => {
    const response = await request(
      "/db/host/7/admin-secrets?fields=password,key,keyPassword",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      secrets: {
        password: "test-password",
        key: "test-private-key",
        keyPassword: "test-passphrase",
      },
    });

    expect(state.auditEntries).toHaveLength(1);
    expect(state.auditEntries[0]).toMatchObject({
      userId: "instance-admin",
      action: "admin_view_user_host_secret",
      resourceType: "host",
      resourceId: "7",
      details: JSON.stringify({
        dataOwnerUserId: "target-user",
        fields: ["password", "key", "keyPassword"],
      }),
    });
    const auditText = JSON.stringify(state.auditEntries[0]);
    expect(auditText).not.toContain("test-password");
    expect(auditText).not.toContain("test-private-key");
    expect(auditText).not.toContain("test-passphrase");
  });

  it("复制时只返回请求字段并记录字段级审计", async () => {
    const response = await request("/db/host/7/admin-secret?field=password");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      value: "test-password",
    });
    expect(state.auditEntries[0]).toMatchObject({
      action: "admin_copy_user_host_secret",
      details: JSON.stringify({
        dataOwnerUserId: "target-user",
        fields: ["password"],
      }),
    });
    expect(JSON.stringify(state.auditEntries[0])).not.toContain(
      "test-password",
    );
  });

  it("兼容旧 privateKey 字段并统一作为 key 返回", async () => {
    state.host = {
      id: 7,
      userId: "target-user",
      name: "Legacy host",
      privateKey: "legacy-private-key",
    };

    const viewResponse = await request("/db/host/7/admin-secrets?fields=key");
    expect(viewResponse.status).toBe(200);
    await expect(viewResponse.json()).resolves.toEqual({
      secrets: { key: "legacy-private-key" },
    });

    state.auditEntries = [];
    const copyResponse = await request("/db/host/7/admin-secret?field=key");
    expect(copyResponse.status).toBe(200);
    await expect(copyResponse.json()).resolves.toEqual({
      value: "legacy-private-key",
    });
    expect(JSON.stringify(state.auditEntries)).not.toContain(
      "legacy-private-key",
    );
  });

  it("普通用户不能调用管理员查看或复制接口", async () => {
    state.actingAsAdmin = false;
    const viewResponse = await request(
      "/db/host/7/admin-secrets?fields=password",
    );
    const copyResponse = await request(
      "/db/host/7/admin-secret?field=password",
    );
    expect(viewResponse.status).toBe(403);
    expect(copyResponse.status).toBe(403);
    expect(state.auditEntries).toHaveLength(0);
  });

  it("拒绝 API Key 和超过五分钟的管理员会话读取明文", async () => {
    state.apiKeyId = "api-key-1";
    state.sessionId = null;
    const apiKeyResponse = await request(
      "/db/host/7/admin-secrets?fields=password",
    );
    expect(apiKeyResponse.status).toBe(401);
    await expect(apiKeyResponse.json()).resolves.toMatchObject({
      code: "INTERACTIVE_SESSION_REQUIRED",
    });

    state.apiKeyId = null;
    state.sessionId = "admin-session";
    state.mfaVerifiedAt = Math.floor(Date.now() / 1000) - 10 * 60;
    const staleMfaResponse = await request(
      "/db/host/7/admin-secret?field=password",
    );
    expect(staleMfaResponse.status).toBe(401);
    await expect(staleMfaResponse.json()).resolves.toMatchObject({
      code: "MFA_STEP_UP_REQUIRED",
    });
    expect(state.auditEntries).toHaveLength(0);
  });

  it("拒绝通过不安全传输查看或复制管理员主机明文", async () => {
    state.transportAllowed = false;
    const viewResponse = await request(
      "/db/host/7/admin-secrets?fields=password",
    );
    expect(viewResponse.status).toBe(426);
    await expect(viewResponse.json()).resolves.toMatchObject({
      code: "HTTPS_REQUIRED",
    });

    const copyResponse = await request(
      "/db/host/7/admin-secret?field=password",
    );
    expect(copyResponse.status).toBe(426);
    await expect(copyResponse.json()).resolves.toMatchObject({
      code: "HTTPS_REQUIRED",
    });
    expect(state.auditEntries).toHaveLength(0);
  });

  it("混入未允许字段时拒绝整个查看请求", async () => {
    const response = await request(
      "/db/host/7/admin-secrets?fields=password,privateKey",
    );
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).not.toContain("test-password");
    expect(body).not.toContain("test-private-key");
    expect(state.auditEntries).toHaveLength(0);
  });

  it("审计不可用时查看和复制均不返回明文", async () => {
    state.auditFailure = new Error("audit database unavailable");
    const viewResponse = await request(
      "/db/host/7/admin-secrets?fields=password,key",
    );
    expect(viewResponse.status).toBe(503);
    const viewBody = await viewResponse.text();
    expect(viewBody).not.toContain("test-password");
    expect(viewBody).not.toContain("test-private-key");

    const copyResponse = await request(
      "/db/host/7/admin-secret?field=password",
    );
    expect(copyResponse.status).toBe(503);
    const copyBody = await copyResponse.text();
    expect(copyBody).not.toContain("test-password");
    expect(copyBody).not.toContain("test-private-key");
  });

  it("管理员不能通过旧通用接口绕过专用审计", async () => {
    const response = await request("/db/host/7/password?field=password");
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "ADMIN_SECRET_ENDPOINT_REQUIRED",
    });
  });

  it("普通用户不能通过旧通用接口读取其他用户的主机秘密", async () => {
    state.actingAsAdmin = false;
    state.host = {
      ...state.host,
      userId: "another-user",
      password: "other-user-password",
    };

    const response = await request("/db/host/7/password?field=password");

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("other-user-password");
    expect(state.auditEntries).toHaveLength(0);
  });

  it("管理员不能通过旧主机导出接口绕过用户级导出审计", async () => {
    const single = await request("/db/host/7/export");
    expect(single.status).toBe(403);
    await expect(single.json()).resolves.toMatchObject({
      code: "ADMIN_EXPORT_ENDPOINT_REQUIRED",
    });

    const bulk = await request("/db/hosts/export");
    expect(bulk.status).toBe(403);
    await expect(bulk.json()).resolves.toMatchObject({
      code: "ADMIN_EXPORT_ENDPOINT_REQUIRED",
    });
    expect(state.auditEntries).toHaveLength(0);
  });

  it("存在固定窗口时拒绝删除主机", async () => {
    state.fixedSessions = [{ id: "fixed-window" }];

    const response = await request("/db/host/7", { method: "DELETE" });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "HOST_HAS_PINNED_TERMINALS",
      count: 1,
    });
  });

  it("存在内存活动会话时拒绝删除主机", async () => {
    state.activeSessions = [{ id: "active-window" }];

    const response = await request("/db/host/7", { method: "DELETE" });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "HOST_HAS_ACTIVE_TERMINAL_SESSIONS",
      count: 1,
    });
  });

  it("普通用户新增主机时必须携带项目上下文", async () => {
    state.actingAsAdmin = false;

    const response = await request("/db/host", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Project host",
        ip: "192.0.2.30",
        port: 22,
        username: "root",
        authType: "password",
        password: "test-password",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "PROJECT_CONTEXT_REQUIRED",
    });
  });
});
