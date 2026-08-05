import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, RequestHandler, Response } from "express";

const state = vi.hoisted(() => ({
  currentUserId: "admin1",
  users: new Map<
    string,
    {
      id: string;
      username: string;
      isAdmin: boolean;
      isOidc: boolean;
      passwordHash: string | null;
      totpEnabled: boolean;
    }
  >(),
  unlockedUsers: new Set<string>(),
  updates: [] as { id: string; changes: Record<string, unknown> }[],
  auditCalls: [] as Record<string, unknown>[],
  auditFailure: null as Error | null,
  roleSyncs: [] as Array<{
    userId: string;
    isAdmin: boolean;
    grantedBy: string;
  }>,
}));

vi.mock("../../../database/db/index.js", () => ({ db: {} }));

vi.mock("../../../utils/logger.js", () => ({
  authLogger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("../../../utils/database-save-trigger.js", () => ({
  DatabaseSaveTrigger: { forceSave: vi.fn(async () => {}) },
}));

vi.mock("../../../utils/audit-logger.js", () => ({
  logAudit: async (params: Record<string, unknown>) => {
    state.auditCalls.push(params);
  },
  logAuditOrThrow: async (params: Record<string, unknown>) => {
    if (state.auditFailure) throw state.auditFailure;
    state.auditCalls.push(params);
  },
  getRequestMeta: () => ({ ipAddress: "", userAgent: "" }),
}));

vi.mock("../../../utils/data-crypto.js", () => ({
  DataCrypto: {
    canUserAccessData: (userId: string) => state.unlockedUsers.has(userId),
  },
}));

vi.mock("../../../utils/auth-manager.js", () => ({
  AuthManager: { getInstance: () => ({}) },
}));

vi.mock("../../../database/repositories/factory.js", () => ({
  createCurrentUserRepository: () => ({
    listAll: async () => [...state.users.values()],
    findById: async (id: string) => state.users.get(id) ?? null,
    findByUsername: async (username: string) =>
      [...state.users.values()].find((u) => u.username === username) ?? null,
    update: async (id: string, changes: Record<string, unknown>) => {
      state.updates.push({ id, changes });
      const user = state.users.get(id);
      if (user) Object.assign(user, changes);
    },
  }),
  createCurrentRoleRepository: () => ({
    switchUserRoleName: async () => {},
    assignRoleNameToUser: async () => {},
    setUserAdminStatus: async (input: {
      userId: string;
      isAdmin: boolean;
      grantedBy: string;
    }) => {
      state.roleSyncs.push(input);
      const user = state.users.get(input.userId);
      if (!user) return false;
      user.isAdmin = input.isAdmin;
      return true;
    },
  }),
}));

const { registerUserAdminRoutes } =
  await import("../../../database/routes/user-admin-routes.js");

// Capture the handlers registered on the router so we can invoke them directly
// without spinning up an HTTP server.
type Registered = { method: string; path: string; handler: RequestHandler };
const registered: Registered[] = [];

function fakeRouter() {
  const record =
    (method: string) =>
    (path: string, ...handlers: RequestHandler[]) => {
      registered.push({ method, path, handler: handlers[handlers.length - 1] });
    };
  return {
    get: record("get"),
    post: record("post"),
    put: record("put"),
    delete: record("delete"),
  } as unknown as import("express").Router;
}

registerUserAdminRoutes(fakeRouter(), (_req, _res, next) => next());

function findHandler(method: string, path: string): RequestHandler {
  const match = registered.find((r) => r.method === method && r.path === path);
  if (!match) throw new Error(`No handler for ${method} ${path}`);
  return match.handler;
}

function makeReqRes(overrides: {
  body?: Record<string, unknown>;
  params?: Record<string, unknown>;
  apiKeyId?: string;
  sessionId?: string | null;
  mfaVerifiedAt?: number | null;
}) {
  const req = {
    userId: state.currentUserId,
    apiKeyId: overrides.apiKeyId,
    sessionId:
      "sessionId" in overrides ? (overrides.sessionId ?? undefined) : "web-1",
    mfaVerifiedAt:
      "mfaVerifiedAt" in overrides
        ? (overrides.mfaVerifiedAt ?? undefined)
        : Math.floor(Date.now() / 1000),
    body: overrides.body ?? {},
    params: overrides.params ?? {},
    headers: {},
  } as unknown as Request;

  const res = {
    statusCode: 200,
    jsonBody: null as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      (this as unknown as { statusCode: number }).statusCode = code;
      return this;
    },
    json(payload: unknown) {
      (this as unknown as { jsonBody: unknown }).jsonBody = payload;
      return this;
    },
    setHeader(key: string, value: string) {
      (this as unknown as { headers: Record<string, string> }).headers[key] =
        value;
      return this;
    },
  } as unknown as Response & {
    statusCode: number;
    jsonBody: unknown;
    headers: Record<string, string>;
  };

  return { req, res };
}

async function invoke(
  method: string,
  path: string,
  overrides: {
    body?: Record<string, unknown>;
    params?: Record<string, unknown>;
    apiKeyId?: string;
    sessionId?: string | null;
    mfaVerifiedAt?: number | null;
  } = {},
) {
  const handler = findHandler(method, path);
  const { req, res } = makeReqRes(overrides);
  await handler(req, res as unknown as Response, () => {});
  return res as unknown as {
    statusCode: number;
    jsonBody: Record<string, unknown> | null;
    headers: Record<string, string>;
  };
}

beforeEach(() => {
  state.currentUserId = "admin1";
  state.users = new Map([
    [
      "admin1",
      {
        id: "admin1",
        username: "admin",
        isAdmin: true,
        isOidc: false,
        passwordHash: "hash",
        totpEnabled: false,
      },
    ],
    [
      "target1",
      {
        id: "target1",
        username: "target",
        isAdmin: false,
        isOidc: false,
        passwordHash: "hash",
        totpEnabled: true,
      },
    ],
    [
      "locked1",
      {
        id: "locked1",
        username: "locked",
        isAdmin: false,
        isOidc: false,
        passwordHash: "hash",
        totpEnabled: false,
      },
    ],
    [
      "admin2",
      {
        id: "admin2",
        username: "second-admin",
        isAdmin: true,
        isOidc: false,
        passwordHash: "hash",
        totpEnabled: true,
      },
    ],
  ]);
  state.unlockedUsers = new Set(["admin1", "target1"]);
  state.updates = [];
  state.auditCalls = [];
  state.auditFailure = null;
  state.roleSyncs = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("管理员权限变更", () => {
  it("先持久审计意图，再原子同步管理员角色", async () => {
    const promoted = await invoke("post", "/make-admin", {
      body: { userId: "target1" },
    });
    expect(promoted.statusCode).toBe(200);
    expect(state.auditCalls[0]?.action).toBe("make_admin_intent");
    expect(state.roleSyncs).toEqual([
      { userId: "target1", isAdmin: true, grantedBy: "admin1" },
    ]);

    const demoted = await invoke("post", "/remove-admin", {
      body: { userId: "admin2" },
    });
    expect(demoted.statusCode).toBe(200);
    expect(state.roleSyncs[1]).toEqual({
      userId: "admin2",
      isAdmin: false,
      grantedBy: "admin1",
    });
  });

  it("审计存储不可用时不变更管理员权限", async () => {
    state.auditFailure = new Error("audit unavailable");
    const response = await invoke("post", "/make-admin", {
      body: { userId: "target1" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.jsonBody?.code).toBe("AUDIT_UNAVAILABLE");
    expect(state.roleSyncs).toEqual([]);
    expect(state.users.get("target1")?.isAdmin).toBe(false);
  });
});

describe("GET /list", () => {
  it("includes data_unlocked and totp_enabled for admin callers", async () => {
    const res = await invoke("get", "/list");
    expect(res.statusCode).toBe(200);
    const users = (res.jsonBody as { users: Record<string, unknown>[] }).users;
    const target = users.find((u) => u.userId === "target1")!;
    expect(target.data_unlocked).toBe(true);
    expect(target.totp_enabled).toBe(true);
    const locked = users.find((u) => u.userId === "locked1")!;
    expect(locked.data_unlocked).toBe(false);
  });

  it("omits management fields for non-admin callers", async () => {
    state.currentUserId = "target1";
    const res = await invoke("get", "/list");
    const users = (res.jsonBody as { users: Record<string, unknown>[] }).users;
    expect(users[0].data_unlocked).toBeUndefined();
    expect(users[0].totp_enabled).toBeUndefined();
  });
});

describe("POST /admin/totp/disable", () => {
  it("clears TOTP fields for the target and audits", async () => {
    const res = await invoke("post", "/admin/totp/disable", {
      body: { userId: "target1" },
    });
    expect(res.statusCode).toBe(200);
    const update = state.updates.find((u) => u.id === "target1");
    expect(update?.changes).toMatchObject({
      totpSecret: null,
      totpEnabled: false,
      totpBackupCodes: null,
    });
    expect(
      state.auditCalls.some((c) => c.action === "admin_disable_totp"),
    ).toBe(true);
  });

  it("403s when the caller is not an admin", async () => {
    state.currentUserId = "target1";
    const res = await invoke("post", "/admin/totp/disable", {
      body: { userId: "locked1" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("400s when TOTP is not enabled for the target", async () => {
    const res = await invoke("post", "/admin/totp/disable", {
      body: { userId: "locked1" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("404s for an unknown target", async () => {
    const res = await invoke("post", "/admin/totp/disable", {
      body: { userId: "ghost" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /admin/export/:userId", () => {
  it("拒绝管理员 API Key 导出用户明文数据", async () => {
    const res = await invoke("get", "/admin/export/:userId", {
      params: { userId: "target1" },
      apiKeyId: "api-key-1",
      sessionId: null,
    });

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody?.code).toBe("INTERACTIVE_SESSION_REQUIRED");
    expect(state.auditCalls).toHaveLength(0);
  });

  it("拒绝缺少近期 MFA 的管理员网页会话", async () => {
    const res = await invoke("get", "/admin/export/:userId", {
      params: { userId: "target1" },
      mfaVerifiedAt: Math.floor(Date.now() / 1000) - 10 * 60,
    });

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody?.code).toBe("MFA_STEP_UP_REQUIRED");
    expect(state.auditCalls).toHaveLength(0);
  });

  it("生产环境拒绝通过公网 HTTP 导出明文数据", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await invoke("get", "/admin/export/:userId", {
      params: { userId: "target1" },
    });

    expect(res.statusCode).toBe(426);
    expect(res.jsonBody?.code).toBe("HTTPS_REQUIRED");
    expect(res.headers["Cache-Control"]).toBe("private, no-store");
    expect(state.auditCalls).toHaveLength(0);
  });

  it("423s when the target's data is locked", async () => {
    const res = await invoke("get", "/admin/export/:userId", {
      params: { userId: "locked1" },
    });
    expect(res.statusCode).toBe(423);
    expect((res.jsonBody as { code?: string }).code).toBe("TARGET_DATA_LOCKED");
  });

  it("403s when the caller is not an admin", async () => {
    state.currentUserId = "target1";
    const res = await invoke("get", "/admin/export/:userId", {
      params: { userId: "admin1" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("审计存储不可用时不生成或返回明文导出", async () => {
    state.auditFailure = new Error("audit unavailable");
    const res = await invoke("get", "/admin/export/:userId", {
      params: { userId: "target1" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.jsonBody).toEqual({
      error: "Audit storage is unavailable",
      code: "AUDIT_UNAVAILABLE",
    });
  });
});
