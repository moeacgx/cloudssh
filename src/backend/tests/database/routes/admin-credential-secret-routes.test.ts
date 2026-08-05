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
  credential: {
    id: 7,
    name: "Production key",
    authType: "key",
    username: "deploy",
    password: "test-password",
    key: "test-private-key",
    keyPassword: "test-passphrase",
    publicKey: "ssh-ed25519 test-public-key",
  } as Record<string, unknown> | null,
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
  authLogger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("../../../database/repositories/factory.js", () => ({
  createCurrentCredentialRepository: () => ({
    findDecryptedByIdForUser: async () => state.credential,
  }),
  createCurrentUserRepository: () => ({
    findById: async (id: string) => ({ id, username: "instance-admin" }),
  }),
  createCurrentHostResolutionRepository: () => ({}),
  createCurrentHostRepository: () => ({}),
  createCurrentSyncTombstoneRepository: () => ({}),
}));

vi.mock("../../../database/routes/credential-key-routes.js", () => ({
  registerCredentialKeyRoutes: vi.fn(),
}));

vi.mock("../../../database/routes/credential-deploy-routes.js", () => ({
  registerCredentialDeployRoutes: vi.fn(),
}));

vi.mock("../../../hosts/host-resolver.js", () => ({
  synchronizeProjectHostCredentialsForHost: vi.fn(),
  synchronizeProjectHostCredentialsForOwner: vi.fn(),
}));

const { default: credentialRouter } =
  await import("../../../database/routes/credentials.js");

const app = express();
app.use(express.json());
app.use(credentialRouter);

let server: Server | null = null;
let baseUrl = "";

async function request(path: string) {
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
  return fetch(`${baseUrl}${path}`);
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
  state.credential = {
    id: 7,
    name: "Production key",
    authType: "key",
    username: "deploy",
    password: "test-password",
    key: "test-private-key",
    keyPassword: "test-passphrase",
    publicKey: "ssh-ed25519 test-public-key",
  };
});

describe("管理员明文凭据访问", () => {
  it("查看时返回明文并记录不含秘密值的专用审计", async () => {
    const response = await request("/7");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      password: "test-password",
      key: "test-private-key",
      keyPassword: "test-passphrase",
    });

    expect(state.auditEntries).toHaveLength(1);
    expect(state.auditEntries[0]).toMatchObject({
      userId: "instance-admin",
      action: "admin_view_user_credential_secret",
      resourceId: "7",
    });
    const auditText = JSON.stringify(state.auditEntries[0]);
    expect(auditText).not.toContain("test-password");
    expect(auditText).not.toContain("test-private-key");
    expect(auditText).not.toContain("test-passphrase");
  });

  it("复制时只返回请求字段并记录字段级审计", async () => {
    const response = await request("/7/admin-secret?field=key");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      value: "test-private-key",
    });
    expect(state.auditEntries[0]).toMatchObject({
      action: "admin_copy_user_credential_secret",
      details: JSON.stringify({
        dataOwnerUserId: "target-user",
        fields: ["key"],
      }),
    });
  });

  it("兼容数据库旧 privateKey 字段并规范化返回", async () => {
    state.credential = {
      id: 7,
      name: "Legacy key",
      authType: "key",
      username: "deploy",
      privateKey: "legacy-private-key",
    };

    const detailResponse = await request("/7");
    expect(detailResponse.status).toBe(200);
    await expect(detailResponse.json()).resolves.toMatchObject({
      hasKey: true,
      key: "legacy-private-key",
    });

    state.auditEntries = [];
    const copyResponse = await request("/7/admin-secret?field=key");
    expect(copyResponse.status).toBe(200);
    await expect(copyResponse.json()).resolves.toEqual({
      value: "legacy-private-key",
    });
    expect(JSON.stringify(state.auditEntries)).not.toContain(
      "legacy-private-key",
    );
  });

  it("普通请求不能调用管理员复制接口", async () => {
    state.actingAsAdmin = false;
    const response = await request("/7/admin-secret?field=password");
    expect(response.status).toBe(403);
    expect(state.auditEntries).toHaveLength(0);
  });

  it("拒绝 API Key 和过期 MFA 会话读取或复制凭据明文", async () => {
    state.apiKeyId = "api-key-1";
    state.sessionId = null;
    const apiKeyResponse = await request("/7");
    expect(apiKeyResponse.status).toBe(401);
    await expect(apiKeyResponse.json()).resolves.toMatchObject({
      code: "INTERACTIVE_SESSION_REQUIRED",
    });

    state.apiKeyId = null;
    state.sessionId = "admin-session";
    state.mfaVerifiedAt = Math.floor(Date.now() / 1000) - 10 * 60;
    const staleMfaResponse = await request("/7/admin-secret?field=key");
    expect(staleMfaResponse.status).toBe(401);
    await expect(staleMfaResponse.json()).resolves.toMatchObject({
      code: "MFA_STEP_UP_REQUIRED",
    });
    expect(state.auditEntries).toHaveLength(0);
  });

  it("拒绝通过不安全传输读取或复制管理员凭据明文", async () => {
    state.transportAllowed = false;
    const viewResponse = await request("/7");
    expect(viewResponse.status).toBe(426);
    await expect(viewResponse.json()).resolves.toMatchObject({
      code: "HTTPS_REQUIRED",
    });

    const copyResponse = await request("/7/admin-secret?field=key");
    expect(copyResponse.status).toBe(426);
    await expect(copyResponse.json()).resolves.toMatchObject({
      code: "HTTPS_REQUIRED",
    });
    expect(state.auditEntries).toHaveLength(0);
  });

  it("审计存储不可用时拒绝返回明文", async () => {
    state.auditFailure = new Error("audit database unavailable");
    const response = await request("/7/admin-secret?field=password");
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).not.toContain("test-password");
    expect(body).not.toContain("test-private-key");
  });
});
