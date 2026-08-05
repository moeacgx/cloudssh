import type { Server } from "http";
import Database from "better-sqlite3";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedRequest } from "../../types/index.js";
import type { AuditLogParams } from "../utils/audit-logger.js";
import { PermissionManager } from "../utils/permission-manager.js";
import type { AgentSessionBroker } from "./broker.js";
import {
  createAgentSessionAdminRouter,
  defaultAgentSessionAdminDependencies,
} from "./session-admin.js";
import type { AgentPrincipal, AgentSessionState } from "./types.js";

describe("网页 Agent 会话关闭", () => {
  let sqlite: Database.Database;
  let server: Server | undefined;
  let broker: Pick<AgentSessionBroker, "close"> | null;
  let closeSession: ReturnType<typeof vi.fn>;
  let canAccessProjectHost: ReturnType<typeof vi.fn>;
  let audit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE project_hosts (
        id INTEGER PRIMARY KEY,
        project_id TEXT NOT NULL,
        host_id INTEGER NOT NULL
      );
      CREATE TABLE persistent_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        project_host_id INTEGER NOT NULL,
        owner_user_id TEXT,
        service_account_id TEXT,
        state TEXT NOT NULL,
        runtime_mode TEXT NOT NULL
      );
      INSERT INTO project_hosts (id, project_id, host_id) VALUES
        (17, 'project-1', 7),
        (18, 'project-2', 7);
    `);
    closeSession = vi.fn(
      async (_principal: AgentPrincipal, sessionId: string) =>
        closedSession(sessionId),
    );
    broker = {
      close: closeSession as unknown as AgentSessionBroker["close"],
    };
    canAccessProjectHost = vi.fn(async () => true);
    audit = vi.fn(async (_entry: AuditLogParams) => undefined);
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
      server = undefined;
    }
    sqlite.close();
    vi.restoreAllMocks();
  });

  function insertSession(options: {
    id: string;
    projectId?: string;
    projectHostId?: number;
    ownerUserId?: string | null;
    serviceAccountId?: string | null;
    state?: AgentSessionState;
    runtimeMode?: "platform" | "tmux";
  }) {
    sqlite
      .prepare(
        `INSERT INTO persistent_sessions
           (id, project_id, project_host_id, owner_user_id, service_account_id, state, runtime_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        options.id,
        options.projectId ?? "project-1",
        options.projectHostId ?? 17,
        options.ownerUserId ?? null,
        options.serviceAccountId === undefined
          ? "service-account-1"
          : options.serviceAccountId,
        options.state ?? "RUNNING",
        options.runtimeMode ?? "platform",
      );
  }

  async function startRouter(options?: {
    apiKey?: boolean;
    interactive?: boolean;
    pendingTOTP?: boolean;
  }) {
    const app = express();
    app.use(
      "/agent/admin/v1",
      createAgentSessionAdminRouter({
        sqlite,
        authenticate: (req, _res, next) => {
          const auth = req as AuthenticatedRequest;
          auth.userId = "user-1";
          auth.user = {
            id: "user-1",
            username: "operator-1",
            isAdmin: false,
          };
          if (options?.apiKey) auth.apiKeyId = "api-key-1";
          if (options?.interactive !== false) auth.sessionId = "browser-1";
          auth.pendingTOTP = options?.pendingTOTP;
          next();
        },
        canAccessProjectHost,
        getBroker: () => broker,
        audit,
      }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("listen failed");
    return `http://127.0.0.1:${address.port}/agent/admin/v1`;
  }

  async function closeRequest(baseUrl: string, sessionId: string) {
    return fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/close`, {
      method: "POST",
    });
  }

  it("使用精确 projectHostId 校验 operator 权限并复用 Broker", async () => {
    insertSession({ id: "agent-running" });
    const baseUrl = await startRouter();

    const response = await closeRequest(baseUrl, "agent-running");

    expect(response.status).toBe(200);
    expect(canAccessProjectHost).toHaveBeenCalledWith("user-1", 7, 17);
    expect(closeSession).toHaveBeenCalledOnce();
    expect(closeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        principalId: "web-user:user-1:close",
        projectId: "project-1",
        projectIds: ["project-1"],
        serviceAccountId: "service-account-1",
        scopes: ["sessions:close"],
        serverIds: ["17"],
        serverProjectIds: { "17": "project-1" },
        serverServiceAccountIds: { "17": "service-account-1" },
      }),
      "agent-running",
    );
    expect(audit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        action: "web_agent_session_close_intent",
        resourceType: "agent_session",
        resourceId: "agent-running",
        success: true,
      }),
    );
    expect(audit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action: "web_agent_session_close",
        resourceType: "agent_session",
        resourceId: "agent-running",
        success: true,
      }),
    );
    expect(await response.json()).toEqual({
      success: true,
      sessionId: "agent-running",
      state: "CLOSED",
    });
  });

  it("同一主机的其它项目关联不能替代精确项目主机权限", async () => {
    insertSession({ id: "agent-project-1", projectHostId: 17 });
    canAccessProjectHost.mockResolvedValue(false);
    const baseUrl = await startRouter();

    const response = await closeRequest(baseUrl, "agent-project-1");

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "当前用户无权操作该项目主机",
      code: "AGENT_SESSION_ACCESS_DENIED",
    });
    expect(canAccessProjectHost).toHaveBeenCalledWith("user-1", 7, 17);
    expect(closeSession).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
  });

  it("service_account_id 为空的普通网页会话不能被误关", async () => {
    insertSession({ id: "ordinary-web-session", serviceAccountId: null });
    const baseUrl = await startRouter();

    const response = await closeRequest(baseUrl, "ordinary-web-session");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "Agent 会话不存在",
      code: "AGENT_SESSION_NOT_FOUND",
    });
    expect(canAccessProjectHost).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: "ordinary-web-session",
        success: false,
      }),
    );
  });

  it("owner_user_id 非空的畸形记录不能被当作 Agent 会话关闭", async () => {
    insertSession({
      id: "malformed-owned-session",
      ownerUserId: "user-1",
      serviceAccountId: "service-account-1",
    });
    const baseUrl = await startRouter();

    const response = await closeRequest(baseUrl, "malformed-owned-session");

    expect(response.status).toBe(404);
    expect(closeSession).not.toHaveBeenCalled();
    expect(canAccessProjectHost).not.toHaveBeenCalled();
  });

  it("Broker 未注册时返回可重试的 503 并记录失败审计", async () => {
    insertSession({ id: "agent-no-broker" });
    broker = null;
    const baseUrl = await startRouter();

    const response = await closeRequest(baseUrl, "agent-no-broker");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Agent Broker 暂不可用，请稍后重试",
      code: "AGENT_BROKER_UNAVAILABLE",
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorMessage: "Agent Broker 暂不可用，请稍后重试",
      }),
    );
  });

  it("CLOSED 会话仍交给 Broker 完成幂等同步", async () => {
    insertSession({ id: "agent-closed", state: "CLOSED" });
    closeSession.mockResolvedValue(closedSession("agent-closed"));
    const baseUrl = await startRouter();

    const response = await closeRequest(baseUrl, "agent-closed");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      success: true,
      sessionId: "agent-closed",
      state: "CLOSED",
    });
    expect(JSON.stringify(body)).not.toMatch(
      /tmuxSessionName|serviceAccountId|serverId|attachments/,
    );
    expect(closeSession).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });

  it("CLOSING 会话仍交给 Broker 重试关闭", async () => {
    insertSession({ id: "agent-closing", state: "CLOSING" });
    const baseUrl = await startRouter();

    const response = await closeRequest(baseUrl, "agent-closing");

    expect(response.status).toBe(200);
    expect(closeSession).toHaveBeenCalledOnce();
    expect(audit.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        success: true,
        details: expect.stringContaining('"previousState":"CLOSING"'),
      }),
    );
  });

  it("驱动关闭失败返回通用错误且失败审计不泄露远端详情", async () => {
    insertSession({ id: "agent-close-failed" });
    closeSession.mockRejectedValue(
      new Error("remote runtime contained super-secret-detail"),
    );
    const baseUrl = await startRouter();

    const response = await closeRequest(baseUrl, "agent-close-failed");
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "Agent 会话关闭失败，请稍后重试",
      code: "AGENT_SESSION_CLOSE_FAILED",
    });
    expect(JSON.stringify(body)).not.toContain("super-secret-detail");
    const entry = audit.mock.calls.at(-1)?.[0] as AuditLogParams;
    expect(entry).toEqual(
      expect.objectContaining({
        success: false,
        errorMessage: "Agent 会话关闭失败，请稍后重试",
      }),
    );
    expect(entry.details ?? "").not.toContain("super-secret-detail");
    expect(entry.details ?? "").not.toContain("runtimeId");
    expect(entry.details ?? "").not.toContain("tmuxName");
  });

  it("意图审计写入失败时不执行破坏性关闭", async () => {
    insertSession({ id: "agent-audit-unavailable" });
    audit.mockRejectedValue(new Error("audit storage offline"));
    const baseUrl = await startRouter();

    const response = await closeRequest(baseUrl, "agent-audit-unavailable");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "审计服务暂不可用，请稍后重试",
      code: "AUDIT_UNAVAILABLE",
    });
    expect(closeSession).not.toHaveBeenCalled();
  });

  it("关闭已经完成时结果审计失败不会把成功伪装成失败", async () => {
    insertSession({ id: "agent-result-audit-failed" });
    audit
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("audit result offline"));
    const baseUrl = await startRouter();

    const response = await closeRequest(baseUrl, "agent-result-audit-failed");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      sessionId: "agent-result-audit-failed",
      state: "CLOSED",
    });
    expect(closeSession).toHaveBeenCalledOnce();
  });

  it.each([
    ["API Key", { apiKey: true }],
    ["缺少交互式网页会话", { interactive: false }],
    ["TOTP 尚未完成", { pendingTOTP: true }],
  ])("%s 请求不能调用网页关闭接口且会记录拒绝审计", async (_label, options) => {
    insertSession({ id: "agent-interactive-only" });
    const baseUrl = await startRouter(options);

    const response = await closeRequest(baseUrl, "agent-interactive-only");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "Agent 会话管理仅允许已完成验证的网页会话访问",
      code: "INTERACTIVE_SESSION_REQUIRED",
    });
    expect(closeSession).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "web_agent_session_close",
        resourceId: "agent-interactive-only",
        success: false,
        errorMessage: "Agent 会话管理仅允许已完成验证的网页会话访问",
      }),
    );
  });

  it("默认权限依赖把 projectHostId 作为第四参数传入 connect 校验", async () => {
    const canAccessHost = vi
      .spyOn(PermissionManager.getInstance(), "canAccessHost")
      .mockResolvedValue({
        hasAccess: true,
        isOwner: false,
        isShared: true,
        projectId: "project-1",
        projectHostId: 17,
      });
    const dependencies = defaultAgentSessionAdminDependencies(sqlite);

    await expect(
      dependencies.canAccessProjectHost("user-1", 7, 17),
    ).resolves.toBe(true);
    expect(canAccessHost).toHaveBeenCalledWith("user-1", 7, "connect", 17);
  });
});

function closedSession(id: string) {
  return {
    id,
    projectId: "project-1",
    serverId: "17",
    serviceAccountId: "service-account-1",
    state: "CLOSED" as const,
    cols: 120,
    rows: 30,
    pinned: false,
    runtimeMode: "platform" as const,
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:01:00.000Z",
    lastDetachedAt: "2026-08-04T00:00:00.000Z",
    closedAt: "2026-08-04T00:01:00.000Z",
    failureReason: null,
    generation: 1,
    nextSequence: 0,
    attachments: [],
    writeLease: null,
    tmuxSessionName: `cloudssh-${id}`,
  };
}
