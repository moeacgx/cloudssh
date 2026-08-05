import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, RequestHandler, Response } from "express";

const state = vi.hoisted(() => ({
  updates: [] as Array<{ id: string; changes: Record<string, unknown> }>,
  revokeCalls: [] as string[],
  logoutCalls: [] as string[],
}));

vi.mock("../../../utils/logger.js", () => ({
  authLogger: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("../../../utils/database-save-trigger.js", () => ({
  DatabaseSaveTrigger: { forceSave: vi.fn(async () => {}) },
}));

vi.mock("../../../utils/auth-manager.js", () => ({
  AuthManager: class {},
}));

vi.mock("../../../database/repositories/factory.js", () => ({
  createCurrentWebTerminalSessionRepository: () => ({
    listOwned: async (userId: string) =>
      userId === "oidc-user" ? [{ id: "fixed-window" }] : [],
  }),
  createCurrentUserRepository: () => ({
    findById: async (id: string) => {
      if (id === "admin") {
        return { id, username: "admin", isAdmin: true };
      }
      if (id === "oidc-user") {
        return {
          id,
          username: "oidc",
          isAdmin: false,
          isOidc: true,
          oidcIdentifier: "subject-1",
          clientId: "client",
          clientSecret: "secret",
          issuerUrl: "https://issuer.example",
          authorizationUrl: "https://issuer.example/auth",
          tokenUrl: "https://issuer.example/token",
          identifierPath: "sub",
          namePath: "name",
          scopes: "openid",
        };
      }
      return null;
    },
    findByUsername: async (username: string) =>
      username === "password-user"
        ? {
            id: "password-user",
            username,
            isOidc: false,
            passwordHash: "hash",
            clientId: "",
            oidcIdentifier: null,
          }
        : null,
    update: async (id: string, changes: Record<string, unknown>) => {
      state.updates.push({ id, changes });
    },
  }),
}));

const { registerUserOidcAccountRoutes } =
  await import("../../../database/routes/user-oidc-account-routes.js");

type Registered = { method: string; path: string; handler: RequestHandler };
const registered: Registered[] = [];
const router = {
  post: (path: string, ...handlers: RequestHandler[]) => {
    registered.push({
      method: "post",
      path,
      handler: handlers[handlers.length - 1],
    });
  },
} as unknown as import("express").Router;

registerUserOidcAccountRoutes(router, {
  authenticateJWT: (_req, _res, next) => next(),
  authManager: {
    revokeAllUserSessions: async (userId: string) => {
      state.revokeCalls.push(userId);
    },
    logoutUser: (userId: string) => {
      state.logoutCalls.push(userId);
    },
  } as never,
});

beforeEach(() => {
  state.updates = [];
  state.revokeCalls = [];
  state.logoutCalls = [];
});

describe("OIDC 账号合并固定窗口保护", () => {
  it("在修改目标账号和撤销源账号会话前返回 409", async () => {
    const handler = registered.find(
      (route) =>
        route.method === "post" && route.path === "/link-oidc-to-password",
    )?.handler;
    if (!handler) throw new Error("OIDC 账号合并路由未注册");

    const req = {
      userId: "admin",
      body: {
        oidcUserId: "oidc-user",
        targetUsername: "password-user",
      },
    } as unknown as Request;
    const res = {
      statusCode: 200,
      body: null as unknown,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(body: unknown) {
        this.body = body;
        return this;
      },
    } as unknown as Response & { statusCode: number; body: unknown };

    await handler(req, res, () => {});

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({
      code: "USER_HAS_PINNED_TERMINALS",
      count: 1,
    });
    expect(state.updates).toEqual([]);
    expect(state.revokeCalls).toEqual([]);
    expect(state.logoutCalls).toEqual([]);
  });
});
