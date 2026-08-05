import { describe, expect, it, vi } from "vitest";

const authenticate = vi.fn((_req: unknown, _res: unknown, next: () => void) =>
  next(),
);
const requireAdmin = vi.fn((_req: unknown, _res: unknown, next: () => void) =>
  next(),
);
const requireDataAccess = vi.fn(
  (_req: unknown, _res: unknown, next: () => void) => next(),
);

vi.mock("../../../utils/auth-manager.js", () => ({
  AuthManager: {
    getInstance: () => ({
      createAuthMiddleware: () => authenticate,
      createAdminMiddleware: () => requireAdmin,
      createDataAccessMiddleware: () => requireDataAccess,
    }),
  },
}));

vi.mock("../../../database/repositories/factory.js", () => ({
  createCurrentCommandHistoryRepository: vi.fn(),
  createCurrentHostResolutionRepository: vi.fn(),
  createCurrentSettingsRepository: vi.fn(),
}));

vi.mock("../../../utils/logger.js", () => ({
  authLogger: { error: vi.fn(), warn: vi.fn() },
  databaseLogger: { info: vi.fn(), error: vi.fn() },
}));

const { default: router, isValidTerminalSessionTimeoutMinutes } =
  await import("../../../database/routes/terminal.js");

type RouterLayer = {
  route?: {
    path?: string;
    methods?: Record<string, boolean>;
    stack: Array<{ handle: unknown }>;
  };
};

describe("terminal session settings", () => {
  it("accepts only integer retention values between 1 and 10080 minutes", () => {
    expect(isValidTerminalSessionTimeoutMinutes(1)).toBe(true);
    expect(isValidTerminalSessionTimeoutMinutes(1440)).toBe(true);
    expect(isValidTerminalSessionTimeoutMinutes(10080)).toBe(true);
    expect(isValidTerminalSessionTimeoutMinutes(0)).toBe(false);
    expect(isValidTerminalSessionTimeoutMinutes(10081)).toBe(false);
    expect(isValidTerminalSessionTimeoutMinutes(1.5)).toBe(false);
    expect(isValidTerminalSessionTimeoutMinutes("1440")).toBe(false);
  });

  it("uses the admin middleware for writes and normal authentication for reads", () => {
    const stack = (router as unknown as { stack: RouterLayer[] }).stack;
    const getRoute = stack.find(
      (layer) =>
        layer.route?.path === "/session_settings" && layer.route?.methods?.get,
    );
    const postRoute = stack.find(
      (layer) =>
        layer.route?.path === "/session_settings" && layer.route?.methods?.post,
    );

    expect(getRoute?.route.stack[0].handle).toBe(authenticate);
    expect(postRoute?.route.stack[0].handle).toBe(requireAdmin);
    expect(
      postRoute?.route.stack.some(
        (layer: { handle: unknown }) => layer.handle === authenticate,
      ),
    ).toBe(false);
  });
});
