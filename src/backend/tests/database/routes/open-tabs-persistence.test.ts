import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticate = vi.fn((_req: unknown, _res: unknown, next: () => void) =>
  next(),
);
const listRecentForUser = vi.fn();
const findByIdForUser = vi.fn();
const deleteForUser = vi.fn();
const listFixedSessions = vi.fn();
const findSharesTargetingUser = vi.fn();
const getUserSessions = vi.fn();
const getSession = vi.fn();
const terminateSession = vi.fn();
const terminatePinnedSession = vi.fn();
const logAudit = vi.fn().mockResolvedValue(undefined);
const canAccessHost = vi.fn().mockResolvedValue({ hasAccess: true });
const sqlitePrepare = vi.fn();
const sqliteAll = vi.fn();

vi.mock("../../../utils/auth-manager.js", () => ({
  AuthManager: {
    getInstance: () => ({
      createAuthMiddleware: () => authenticate,
    }),
  },
}));

vi.mock("../../../database/repositories/factory.js", () => ({
  getCurrentSettingValue: () => "1440",
  createCurrentOpenTabRepository: () => ({
    listRecentForUser,
    findByIdForUser,
    deleteForUser,
  }),
  createCurrentSessionShareRepository: () => ({
    findSharesTargetingUser,
  }),
  createCurrentWebTerminalSessionRepository: () => ({
    listOwned: listFixedSessions,
  }),
  getCurrentRepositorySqlite: () => ({
    prepare: sqlitePrepare,
  }),
}));

vi.mock("../../../hosts/terminal/session-manager.js", () => ({
  sessionManager: {
    getUserSessions,
    getSession,
    terminateSession,
    terminatePinnedSession,
  },
}));

vi.mock("../../../utils/logger.js", () => ({
  databaseLogger: { error: vi.fn(), warn: vi.fn() },
}));

vi.mock("../../../utils/audit-logger.js", () => ({
  getRequestMeta: () => ({ ipAddress: "127.0.0.1", userAgent: "test" }),
  logAudit,
}));

vi.mock("../../../utils/permission-manager.js", () => ({
  PermissionManager: {
    getInstance: () => ({
      canAccessHost,
    }),
  },
}));

const { default: router } =
  await import("../../../database/routes/open-tabs.js");

type RouteHandler = (
  request: Record<string, unknown>,
  response: Record<string, unknown>,
) => Promise<unknown>;

type RouterLayer = {
  route?: {
    path?: string;
    methods?: Record<string, boolean>;
    stack: Array<{ handle: RouteHandler }>;
  };
};

function routeHandler(method: "get" | "delete" | "post"): RouteHandler {
  const path =
    method === "get" ? "/" : method === "post" ? "/:id/detach" : "/:id";
  const layer = (router as unknown as { stack: RouterLayer[] }).stack.find(
    (candidate) =>
      candidate.route?.path === path && candidate.route?.methods?.[method],
  );
  const handler = layer?.route?.stack.at(-1)?.handle;
  if (!handler) throw new Error(`Missing ${method} open-tabs handler`);
  return handler;
}

function activeSessionsHandler(): RouteHandler {
  const layer = (router as unknown as { stack: RouterLayer[] }).stack.find(
    (candidate) =>
      candidate.route?.path === "/active-sessions" &&
      candidate.route?.methods?.get,
  );
  const handler = layer?.route?.stack.at(-1)?.handle;
  if (!handler) throw new Error("Missing active sessions handler");
  return handler;
}

function responseStub() {
  const response: Record<string, unknown> = {};
  response.status = vi.fn(() => response);
  response.json = vi.fn(() => response);
  return response;
}

const fixedSession = {
  id: "session-fixed",
  userId: "user-1",
  hostId: 7,
  projectHostId: 17,
  tabInstanceId: "tab-fixed",
  tmuxName: "cloudssh-web-session-fixed",
  columns: 120,
  rows: 40,
  createdAt: "2026-07-01T00:00:00.000Z",
  lastAttachedAt: "2026-07-01T00:00:00.000Z",
  lastDetachedAt: "2026-07-01T01:00:00.000Z",
  updatedAt: "2026-07-01T01:00:00.000Z",
};

const oldTab = {
  id: "tab-fixed",
  userId: "user-1",
  tabType: "terminal",
  hostId: 7,
  label: "production",
  tabOrder: 2,
  backendSessionId: "session-fixed",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T01:00:00.000Z",
};

describe("open tabs - fixed terminal persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listRecentForUser.mockResolvedValue([]);
    findByIdForUser.mockResolvedValue(oldTab);
    listFixedSessions.mockResolvedValue([fixedSession]);
    findSharesTargetingUser.mockResolvedValue([]);
    getUserSessions.mockReturnValue([]);
    terminateSession.mockResolvedValue(true);
    deleteForUser.mockResolvedValue(true);
    canAccessHost.mockResolvedValue({ hasAccess: true });
    sqliteAll.mockReturnValue([]);
    sqlitePrepare.mockReturnValue({ all: sqliteAll });
  });

  it("returns a fixed tab even after the ordinary retention cutoff", async () => {
    const response = responseStub();

    await routeHandler("get")({ userId: "user-1" }, response);

    expect(findByIdForUser).toHaveBeenCalledWith("user-1", "tab-fixed");
    expect(response.json).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "tab-fixed",
        backendSessionId: "session-fixed",
        sessionPinned: true,
        tmuxSessionName: "cloudssh-web-session-fixed",
        retentionExpiresAt: null,
      }),
    ]);
  });

  it("returns the current live session id instead of a stale saved id", async () => {
    const response = responseStub();
    listFixedSessions.mockResolvedValue([]);
    listRecentForUser.mockResolvedValue([
      { ...oldTab, backendSessionId: "session-stale" },
    ]);
    getUserSessions.mockReturnValue([
      {
        id: "session-current",
        userId: "user-1",
        hostId: 7,
        projectHostId: 17,
        tabInstanceId: "tab-fixed",
        isConnected: true,
        createdAt: Date.now(),
        lastDetachedAt: null,
        retentionExpiresAt: null,
        pinned: false,
        tmuxSessionName: null,
      },
    ]);

    await routeHandler("get")({ userId: "user-1" }, response);

    expect(response.json).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "tab-fixed",
        backendSessionId: "session-current",
      }),
    ]);
  });

  it("hides recent and fixed tabs after project host access is revoked", async () => {
    const response = responseStub();
    listRecentForUser.mockResolvedValue([oldTab]);
    canAccessHost.mockResolvedValue({ hasAccess: false });

    await routeHandler("get")({ userId: "user-1" }, response);

    expect(response.json).toHaveBeenCalledWith([]);
    expect(canAccessHost).toHaveBeenCalledWith("user-1", 7, "connect", 17);
    expect(deleteForUser).not.toHaveBeenCalled();
  });

  it("uses the fixed session host when a legacy tab has no host id", async () => {
    const response = responseStub();
    listRecentForUser.mockResolvedValue([{ ...oldTab, hostId: null }]);
    canAccessHost.mockResolvedValue({ hasAccess: false });

    await routeHandler("get")({ userId: "user-1" }, response);

    expect(response.json).toHaveBeenCalledWith([]);
    expect(canAccessHost).toHaveBeenCalledWith("user-1", 7, "connect", 17);
  });

  it("keeps the tab record when the fixed session cannot be terminated", async () => {
    const response = responseStub();
    getSession.mockReturnValue({ id: fixedSession.id, pinned: false });
    terminatePinnedSession.mockResolvedValue(false);

    await routeHandler("delete")(
      { userId: "user-1", params: { id: "tab-fixed" } },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(409);
    expect(deleteForUser).not.toHaveBeenCalled();
  });

  it("audits a successful explicit fixed-window close", async () => {
    const response = responseStub();
    getSession.mockReturnValue({ id: fixedSession.id, pinned: true });
    terminatePinnedSession.mockResolvedValue(true);

    await routeHandler("delete")(
      {
        userId: "user-1",
        user: { username: "alice" },
        params: { id: "tab-fixed" },
      },
      response,
    );

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "web_terminal_close",
        resourceId: fixedSession.id,
        userId: "user-1",
        username: "alice",
      }),
    );
    expect(terminatePinnedSession).toHaveBeenCalledWith(
      fixedSession.id,
      "user-1",
    );
    expect(deleteForUser).toHaveBeenCalledWith("user-1", "tab-fixed");
  });

  it("关闭固定标签只脱离浏览器，不终止后台 SSH 或 tmux", async () => {
    const response = responseStub();
    const livePinnedSession = {
      id: "session-live-pinned",
      userId: "user-1",
      hostId: 7,
      projectHostId: 17,
      tabInstanceId: "tab-fixed",
      attachedTabInstanceId: "tab-fixed",
      pinned: true,
      managedTmux: true,
      tmuxSessionName: "cloudssh-web-session-live-pinned",
      lastDetachedAt: null,
    };
    getUserSessions.mockReturnValue([livePinnedSession]);

    await routeHandler("post")(
      {
        userId: "user-1",
        user: { username: "alice" },
        params: { id: "tab-fixed" },
      },
      response,
    );

    expect(findByIdForUser).toHaveBeenCalledWith("user-1", "tab-fixed");
    expect(deleteForUser).not.toHaveBeenCalled();
    expect(terminateSession).not.toHaveBeenCalled();
    expect(terminatePinnedSession).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith({
      success: true,
      sessionId: livePinnedSession.id,
      tab: {
        ...oldTab,
        backendSessionId: livePinnedSession.id,
        sessionPinned: true,
        tmuxSessionName: livePinnedSession.tmuxSessionName,
        lastDetachedAt: null,
        retentionExpiresAt: null,
      },
    });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "web_terminal_detach",
        resourceId: livePinnedSession.id,
        userId: "user-1",
        username: "alice",
      }),
    );
  });

  it("平台保活分离后不暴露当前 Shell 的外部 tmux 名称", async () => {
    const response = responseStub();
    getUserSessions.mockReturnValue([
      {
        id: "session-platform-pinned",
        userId: "user-1",
        hostId: 7,
        projectHostId: 17,
        tabInstanceId: "tab-fixed",
        attachedTabInstanceId: "tab-fixed",
        pinned: true,
        managedTmux: false,
        tmuxSessionName: "external-user-tmux",
        lastDetachedAt: null,
      },
    ]);

    await routeHandler("post")(
      { userId: "user-1", params: { id: "tab-fixed" } },
      response,
    );

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        tab: expect.objectContaining({
          sessionPinned: true,
          tmuxSessionName: null,
        }),
      }),
    );
    expect(deleteForUser).not.toHaveBeenCalled();
    expect(terminatePinnedSession).not.toHaveBeenCalled();
  });

  it("脱离接口找不到当前用户的标签时不修改任何状态", async () => {
    const response = responseStub();
    findByIdForUser.mockResolvedValue(null);

    await routeHandler("post")(
      { userId: "user-1", params: { id: "tab-missing" } },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith({
      error: "Open tab not found",
      code: "OPEN_TAB_NOT_FOUND",
    });
    expect(listFixedSessions).not.toHaveBeenCalled();
    expect(deleteForUser).not.toHaveBeenCalled();
    expect(terminateSession).not.toHaveBeenCalled();
    expect(terminatePinnedSession).not.toHaveBeenCalled();
  });

  it("脱离接口拒绝普通或已消失的会话且保留标签记录", async () => {
    const response = responseStub();
    listFixedSessions.mockResolvedValue([]);
    getUserSessions.mockReturnValue([
      {
        id: "session-regular",
        userId: "user-1",
        tabInstanceId: "tab-fixed",
        pinned: false,
      },
    ]);

    await routeHandler("post")(
      { userId: "user-1", params: { id: "tab-fixed" } },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "PINNED_SESSION_NOT_FOUND" }),
    );
    expect(deleteForUser).not.toHaveBeenCalled();
  });

  it("显式移除后台普通标签时同时终止对应 SSH 会话", async () => {
    const response = responseStub();
    const regularSession = {
      id: "session-regular",
      userId: "user-1",
      hostId: 8,
      projectHostId: 18,
      tabInstanceId: "tab-regular",
      attachedTabInstanceId: "tab-regular",
    };
    listFixedSessions.mockResolvedValue([]);
    getUserSessions.mockReturnValue([regularSession]);

    await routeHandler("delete")(
      {
        userId: "user-1",
        user: { username: "alice" },
        params: { id: "tab-regular" },
      },
      response,
    );

    expect(terminateSession).toHaveBeenCalledWith(regularSession.id, "user-1");
    expect(deleteForUser).toHaveBeenCalledWith("user-1", "tab-regular");
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "web_terminal_close",
        resourceId: regularSession.id,
      }),
    );
  });

  it("hides live sessions after host access is revoked", async () => {
    const response = responseStub();
    getUserSessions.mockReturnValue([
      {
        id: fixedSession.id,
        userId: "user-1",
        hostId: 7,
        projectHostId: 17,
        hostName: "production",
        tabInstanceId: "tab-fixed",
        attachedTabInstanceId: "tab-fixed",
        isConnected: true,
        createdAt: Date.now(),
        lastDetachedAt: null,
        retentionExpiresAt: null,
        pinned: true,
        tmuxSessionName: fixedSession.tmuxName,
      },
    ]);
    canAccessHost.mockResolvedValue({ hasAccess: false });

    await activeSessionsHandler()({ userId: "user-1" }, response);

    expect(response.json).toHaveBeenCalledWith([]);
    expect(canAccessHost).toHaveBeenCalledWith("user-1", 7, "connect", 17);
  });

  it("checks a shared session against its exact project host", async () => {
    const response = responseStub();
    const sharedSession = {
      id: "shared-session",
      userId: "owner-1",
      hostId: 7,
      projectHostId: 17,
      hostName: "production",
      tabInstanceId: "shared-tab",
      attachedTabInstanceId: "shared-tab",
      isConnected: true,
      createdAt: Date.now(),
      lastDetachedAt: null,
      retentionExpiresAt: null,
      pinned: false,
    };
    listFixedSessions.mockResolvedValue([]);
    findSharesTargetingUser.mockResolvedValue([
      {
        id: "share-1",
        protocol: "ssh",
        sessionId: sharedSession.id,
        ownerUsername: "owner",
        permissionLevel: "read-write",
      },
    ]);
    getSession.mockReturnValue(sharedSession);
    canAccessHost.mockImplementation(
      async (
        _userId: string,
        _hostId: number,
        _action: string,
        projectHostId?: number,
      ) => ({ hasAccess: projectHostId !== 17 }),
    );

    await activeSessionsHandler()({ userId: "user-1" }, response);

    expect(response.json).toHaveBeenCalledWith([]);
    expect(canAccessHost).toHaveBeenCalledWith("user-1", 7, "connect", 17);
  });

  it("lists visible Agent sessions without exposing their tmux identifier", async () => {
    const response = responseStub();
    listFixedSessions.mockResolvedValue([]);
    const visibleAgentRow = {
      id: "agent-session-123456",
      projectId: "project-1",
      projectHostId: 17,
      hostId: 7,
      hostName: "production",
      alias: null,
      state: "RUNNING",
      title: "Deploy",
      pinned: 1,
      runtimeMode: "tmux",
      serviceAccountId: "agent-account-1",
      agentActorName: "deploy-agent",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T01:00:00.000Z",
      lastDetachedAt: null,
      retainUntil: null,
    };
    // 历史授权数据可能让设备/Token LEFT JOIN 返回同一会话多次。
    sqliteAll.mockReturnValue([visibleAgentRow, { ...visibleAgentRow }]);

    await activeSessionsHandler()({ userId: "user-1" }, response);

    expect(response.json).toHaveBeenCalledWith([
      expect.objectContaining({
        sessionId: "agent-session-123456",
        sessionSource: "agent",
        agentSessionId: "agent-session-123456",
        agentActorName: "deploy-agent",
        projectId: "project-1",
        projectHostId: 17,
        tmuxSessionName: null,
        isConnected: true,
        runtimeMode: "tmux",
        sessionManagedTmux: true,
        recoverable: true,
      }),
    ]);
    expect(canAccessHost).toHaveBeenCalledWith("user-1", 7, "connect", 17);
    expect(sqlitePrepare).toHaveBeenCalledWith(
      expect.stringContaining("service_account.is_active = 1"),
    );
    expect(sqlitePrepare).toHaveBeenCalledWith(
      expect.stringContaining("agent_device.name"),
    );
  });

  it("关闭失败后 CLOSING Agent 会话仍在连接列表中供用户重试", async () => {
    const response = responseStub();
    listFixedSessions.mockResolvedValue([]);
    sqliteAll.mockReturnValue([
      {
        id: "agent-closing-123456",
        projectId: "project-1",
        projectHostId: 17,
        hostId: 7,
        hostName: "production",
        alias: null,
        state: "CLOSING",
        title: "Deploy",
        pinned: 0,
        runtimeMode: "platform",
        serviceAccountId: "agent-account-1",
        agentActorName: "deploy-agent",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T01:00:00.000Z",
        lastDetachedAt: null,
        retainUntil: null,
      },
    ]);

    await activeSessionsHandler()({ userId: "user-1" }, response);

    expect(response.json).toHaveBeenCalledWith([
      expect.objectContaining({
        sessionId: "agent-closing-123456",
        sessionSource: "agent",
        agentSessionId: "agent-closing-123456",
        isConnected: false,
      }),
    ]);
    expect(sqlitePrepare).toHaveBeenCalledWith(
      expect.stringContaining(
        "session.state IN ('CREATING', 'RUNNING', 'RECOVERING', 'CLOSING')",
      ),
    );
  });

  it("平台中转 Agent 会话不再伪装成可跨重启恢复的 tmux", async () => {
    const response = responseStub();
    listFixedSessions.mockResolvedValue([]);
    sqliteAll.mockReturnValue([
      {
        id: "agent-platform-123456",
        projectId: "project-1",
        projectHostId: 17,
        hostId: 7,
        hostName: "production",
        alias: null,
        state: "RUNNING",
        title: "Build",
        pinned: 1,
        runtimeMode: "platform",
        serviceAccountId: "agent-account-1",
        agentActorName: "build-agent",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T01:00:00.000Z",
        lastDetachedAt: null,
        retainUntil: null,
      },
    ]);

    await activeSessionsHandler()({ userId: "user-1" }, response);

    expect(response.json).toHaveBeenCalledWith([
      expect.objectContaining({
        sessionId: "agent-platform-123456",
        runtimeMode: "platform",
        sessionPinned: true,
        sessionManagedTmux: false,
        recoverable: false,
      }),
    ]);
  });
});
