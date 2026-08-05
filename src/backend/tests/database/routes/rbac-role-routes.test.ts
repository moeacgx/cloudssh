import http from "http";
import express, { type RequestHandler } from "express";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const state = vi.hoisted(() => ({
  auditFailure: null as Error | null,
  assignments: new Set<string>(),
  events: [] as string[],
  pinned: false,
  roleDeleted: false,
}));

vi.mock("../../../utils/logger.js", () => ({
  databaseLogger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("../../../utils/auth-manager.js", () => ({
  AuthManager: {
    getInstance: () => ({
      createAuthMiddleware: () =>
        ((req, _res, next) => {
          (req as unknown as { userId: string }).userId = "admin";
          next();
        }) as RequestHandler,
    }),
  },
}));

vi.mock("../../../utils/permission-manager.js", () => ({
  SHARE_PERMISSION_LEVELS: ["view", "connect", "edit", "manage"],
  PermissionManager: {
    getInstance: () => ({
      requireAdmin: () => ((_req, _res, next) => next()) as RequestHandler,
      invalidateUserPermissionCache: vi.fn(),
    }),
  },
}));

vi.mock("../../../utils/audit-logger.js", () => ({
  getRequestMeta: () => ({ ipAddress: "127.0.0.1", userAgent: "test" }),
  logAudit: async () => undefined,
  logAuditOrThrow: async (input: { action: string }) => {
    state.events.push(input.action);
    if (state.auditFailure) throw state.auditFailure;
  },
}));

vi.mock("../../../utils/shared-host-secrets-manager.js", () => ({
  SharedHostSecretsManager: {
    getInstance: () => ({ snapshotForRoleMember: async () => undefined }),
  },
}));

vi.mock("../../../hosts/terminal/session-manager.js", () => ({
  sessionManager: {
    findSessions: () => (state.pinned ? [{ id: "fixed-window" }] : []),
  },
}));

vi.mock("../../../hosts/terminal/session-lifecycle-coordinator.js", () => ({
  terminalSessionLifecycleCoordinator: {
    runDestructiveOperation: async (
      _scope: unknown,
      operation: () => unknown,
    ) => operation(),
  },
}));

vi.mock("../../../database/repositories/factory.js", () => ({
  createCurrentUserRepository: () => ({
    findById: async (id: string) =>
      id === "admin"
        ? { id, username: "admin" }
        : id === "target"
          ? { id, username: "target" }
          : null,
  }),
  createCurrentRoleRepository: () => ({
    findRoleById: async (id: number) =>
      id === 7
        ? { id, name: "operators", displayName: "Operators", isSystem: false }
        : null,
    findUserRole: async (userId: string, roleId: number) =>
      state.assignments.has(`${userId}:${roleId}`) ? { id: 1 } : null,
    assignRoleToUser: async (input: { userId: string; roleId: number }) => {
      state.events.push("assign");
      state.assignments.add(`${input.userId}:${input.roleId}`);
    },
    removeRoleFromUser: async (userId: string, roleId: number) => {
      state.events.push("remove");
      state.assignments.delete(`${userId}:${roleId}`);
    },
    getTerminalLifecycleTarget: (_roleId: number, userId?: string) => ({
      hostIds: [],
      projectHostIds: [31],
      userIds: userId ? [userId] : ["target"],
    }),
    deleteRole: async () => {
      state.events.push("delete_role");
      state.roleDeleted = true;
      return { deletedUserIds: ["target"] };
    },
  }),
  createCurrentSharedHostSecretsRepository: () => ({
    deleteForRoleMember: async () => undefined,
  }),
  createCurrentCredentialRepository: () => ({}),
  createCurrentHostFolderRepository: () => ({}),
  createCurrentHostResolutionRepository: () => ({}),
  createCurrentRbacAccessRepository: () => ({}),
  createCurrentSnippetRepository: () => ({}),
}));

const { default: router } = await import("../../../database/routes/rbac.js");

describe("RBAC 用户角色变更审计", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use("/rbac", router);
    server = http.createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("未绑定测试端口");
    baseUrl = `http://127.0.0.1:${address.port}/rbac`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  beforeEach(() => {
    state.auditFailure = null;
    state.assignments = new Set();
    state.events = [];
    state.pinned = false;
    state.roleDeleted = false;
  });

  it("分配角色前必须成功写入意图审计", async () => {
    state.auditFailure = new Error("audit unavailable");
    const failed = await fetch(`${baseUrl}/users/target/roles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roleId: 7 }),
    });
    expect(failed.status).toBe(503);
    expect(state.assignments.size).toBe(0);

    state.auditFailure = null;
    state.events = [];
    const succeeded = await fetch(`${baseUrl}/users/target/roles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roleId: 7 }),
    });
    expect(succeeded.status).toBe(200);
    expect(state.events).toEqual(["assign_user_role_intent", "assign"]);
  });

  it("移除角色前必须成功写入意图审计", async () => {
    state.assignments.add("target:7");
    state.auditFailure = new Error("audit unavailable");
    const failed = await fetch(`${baseUrl}/users/target/roles/7`, {
      method: "DELETE",
    });
    expect(failed.status).toBe(503);
    expect(state.assignments.has("target:7")).toBe(true);

    state.auditFailure = null;
    state.events = [];
    const succeeded = await fetch(`${baseUrl}/users/target/roles/7`, {
      method: "DELETE",
    });
    expect(succeeded.status).toBe(200);
    expect(state.events).toEqual(["remove_user_role_intent", "remove"]);
  });

  it("固定窗口存在时拒绝移除用户角色", async () => {
    state.assignments.add("target:7");
    state.pinned = true;

    const response = await fetch(`${baseUrl}/users/target/roles/7`, {
      method: "DELETE",
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "ROLE_HAS_PINNED_TERMINAL_SESSIONS",
    });
    expect(state.assignments.has("target:7")).toBe(true);
    expect(state.events).toEqual(["remove_user_role_intent"]);
  });

  it("固定窗口存在时拒绝删除全局角色", async () => {
    state.assignments.add("target:7");
    state.pinned = true;

    const response = await fetch(`${baseUrl}/roles/7`, { method: "DELETE" });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "ROLE_HAS_PINNED_TERMINAL_SESSIONS",
    });
    expect(state.roleDeleted).toBe(false);
  });
});
