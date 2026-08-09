import http from "http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUpdaterStatus: vi.fn(),
  getUpdaterHistory: vi.fn(),
  getUpdateJob: vi.fn(),
  startUpdate: vi.fn(),
  rollbackUpdate: vi.fn(),
  getUpdateMode: vi.fn(),
  getUpdateModeDetails: vi.fn(),
  setUpdateMode: vi.fn(),
  logAudit: vi.fn(),
  logAuditOrThrow: vi.fn(),
}));

vi.mock("./updater-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./updater-client.js")>();
  return {
    ...original,
    getUpdaterStatus: mocks.getUpdaterStatus,
    getUpdaterHistory: mocks.getUpdaterHistory,
    getUpdateJob: mocks.getUpdateJob,
    startUpdate: mocks.startUpdate,
    rollbackUpdate: mocks.rollbackUpdate,
    getUpdateMode: mocks.getUpdateMode,
    getUpdateModeDetails: mocks.getUpdateModeDetails,
    setUpdateMode: mocks.setUpdateMode,
  };
});

vi.mock("../database/repositories/factory.js", () => ({
  createCurrentUserRepository: () => ({
    findById: async () => ({ id: "admin-1", username: "administrator" }),
  }),
}));

vi.mock("../utils/audit-logger.js", () => ({
  getRequestMeta: () => ({ ipAddress: "127.0.0.1", userAgent: "test" }),
  logAudit: mocks.logAudit,
  logAuditOrThrow: mocks.logAuditOrThrow,
}));

import { createUpdateRoutes } from "./routes.js";

let server: http.Server | undefined;

async function listen(options?: {
  recentMfa?: boolean;
  production?: boolean;
  interactive?: boolean;
  pendingTOTP?: boolean;
  apiKey?: boolean;
}) {
  const app = express();
  app.use(express.json());
  app.set("trust proxy", 1);
  app.use(
    "/admin/updates",
    createUpdateRoutes({
      requireAdmin: (req, _res, next) => {
        Object.assign(req, {
          userId: "admin-1",
          sessionId:
            options?.apiKey || options?.interactive === false
              ? undefined
              : "session-1",
          apiKeyId: options?.apiKey ? "api-key-1" : undefined,
          pendingTOTP: options?.pendingTOTP,
          mfaVerifiedAt: options?.recentMfa
            ? Math.floor(Date.now() / 1000)
            : undefined,
        });
        next();
      },
      repositoryOwner: "moeacgx",
      repositoryName: "cloudssh",
      resolveLocalVersion: () => "2.6.0-cloudssh.16",
      compareVersions: (left, right) =>
        left === right ? 0 : String(left) < String(right) ? -1 : 1,
      getLatestRelease: async () => ({
        id: 17,
        tag_name: "release-2.6.0-cloudssh.17-tag",
        name: "CloudSSH 17",
        body: "release",
        published_at: "2026-08-02T00:00:00.000Z",
        html_url:
          "https://github.com/moeacgx/cloudssh/releases/tag/release-2.6.0-cloudssh.17-tag",
        assets: [],
        prerelease: false,
        draft: false,
      }),
      getReleaseByTag: async (tag) => {
        if (tag !== "release-2.6.0-cloudssh.17-tag") {
          throw new Error("not found");
        }
        return {
          id: 17,
          tag_name: tag,
          name: "CloudSSH 17",
          body: "release",
          published_at: "2026-08-02T00:00:00.000Z",
          html_url: `https://github.com/moeacgx/cloudssh/releases/tag/${tag}`,
          assets: [],
          prerelease: false,
          draft: false,
        };
      },
    }),
  );
  if (options?.production) {
    vi.stubEnv("NODE_ENV", "production");
  }
  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listen failed");
  return `http://127.0.0.1:${address.port}`;
}

async function requestLocal(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{ status: number; json: () => Promise<unknown> }> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: `${parsed.pathname}${parsed.search}`,
        method: options.method || "GET",
        headers: options.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode || 0,
            json: async () => JSON.parse(body),
          });
        });
      },
    );
    request.once("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

function operation(action: "update" | "rollback" = "update") {
  return {
    id: `${action}-12345678`,
    action,
    targetVersion: action === "update" ? "2.6.0-cloudssh.17" : null,
    state: "queued",
    phase: "queued",
    progress: 0,
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    completedAt: null,
    backupArchive: null,
    failureCode: null,
    message: "已排队",
    rollback: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.logAudit.mockResolvedValue(undefined);
  mocks.logAuditOrThrow.mockResolvedValue(undefined);
  mocks.getUpdaterStatus.mockResolvedValue({
    available: true,
    configured: true,
    enabled: true,
    canRollback: true,
    updaterVersion: "1.0.0",
    operation: null,
    previous: null,
  });
  mocks.getUpdaterHistory.mockResolvedValue([]);
  mocks.startUpdate.mockResolvedValue(operation());
  mocks.rollbackUpdate.mockResolvedValue(operation("rollback"));
  mocks.getUpdateMode.mockResolvedValue("auto");
  mocks.getUpdateModeDetails.mockImplementation(async (mode = "auto") => ({
    mode,
    supportedModes: ["auto", "image", "binary"],
    activeSource: "image",
    restartRequired: mode === "binary",
  }));
  mocks.setUpdateMode.mockImplementation(async (mode) => mode);
});

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) =>
    server!.close((error) => (error ? reject(error) : resolve())),
  );
  server = undefined;
  vi.unstubAllEnvs();
});

describe("管理员在线更新路由", () => {
  it("返回管理界面所需的版本和更新器状态", async () => {
    const base = await listen();
    const response = await requestLocal(`${base}/admin/updates/status`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      currentVersion: "2.6.0-cloudssh.16",
      latestVersion: "2.6.0-cloudssh.17",
      status: "update_available",
      updater: {
        configured: true,
        enabled: true,
        reachable: true,
        version: "1.0.0",
        canRollback: true,
        message: null,
        mode: "auto",
        activeSource: "image",
        restartRequired: false,
      },
      activeJob: null,
    });
  });

  it("读取并切换持久化更新方式", async () => {
    const base = await listen({ recentMfa: true });
    const current = await requestLocal(`${base}/admin/updates/mode`);
    expect(current.status).toBe(200);
    await expect(current.json()).resolves.toEqual({
      mode: "auto",
      supportedModes: ["auto", "image", "binary"],
      activeSource: "image",
      restartRequired: false,
    });

    const changed = await requestLocal(`${base}/admin/updates/mode`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "binary" }),
    });
    expect(changed.status).toBe(200);
    expect(mocks.setUpdateMode).toHaveBeenCalledWith("binary");
    await expect(changed.json()).resolves.toMatchObject({
      mode: "binary",
      activeSource: "image",
      restartRequired: true,
    });
    expect(mocks.logAuditOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cloudssh_update_mode_change_intent" }),
    );
  });

  it("没有近期 MFA 的管理员网页会话可以发起更新", async () => {
    const base = await listen({ recentMfa: false });
    const response = await requestLocal(`${base}/admin/updates/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetVersion: "2.6.0-cloudssh.17" }),
    });
    expect(response.status).toBe(202);
    expect(mocks.startUpdate).toHaveBeenCalledWith({
      targetVersion: "2.6.0-cloudssh.17",
      idempotencyKey: expect.any(String),
    });
  });

  it("非交互式凭据不得执行更新写操作", async () => {
    for (const options of [
      { apiKey: true },
      { interactive: false },
      { pendingTOTP: true },
    ]) {
      const base = await listen(options);
      const response = await requestLocal(`${base}/admin/updates/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetVersion: "2.6.0-cloudssh.17" }),
      });
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({
        code: "INTERACTIVE_SESSION_REQUIRED",
      });
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
      server = undefined;
    }
    expect(mocks.startUpdate).not.toHaveBeenCalled();
  });

  it("生产环境的明文 HTTP 不得执行更新写操作", async () => {
    const base = await listen({ recentMfa: true, production: true });
    const response = await requestLocal(`${base}/admin/updates/apply`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "198.51.100.10",
        "x-forwarded-proto": "http",
      },
      body: JSON.stringify({ targetVersion: "2.6.0-cloudssh.17" }),
    });
    expect(response.status).toBe(426);
    await expect(response.json()).resolves.toMatchObject({
      code: "HTTPS_REQUIRED",
    });
    expect(mocks.startUpdate).not.toHaveBeenCalled();
  });

  it("校验 GitHub Release 后才向容器内更新器提交精确版本", async () => {
    const base = await listen({ recentMfa: true });
    const response = await requestLocal(`${base}/admin/updates/apply`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "update:12345678",
      },
      body: JSON.stringify({ targetVersion: "2.6.0-cloudssh.17" }),
    });
    expect(response.status).toBe(202);
    expect(mocks.startUpdate).toHaveBeenCalledWith({
      targetVersion: "2.6.0-cloudssh.17",
      idempotencyKey: "update:12345678",
    });
    await expect(response.json()).resolves.toMatchObject({
      job: { id: "update-12345678", phase: "checking", progress: 0 },
    });
  });

  it("拒绝冲突的幂等键，避免同一次点击创建两个任务", async () => {
    const base = await listen({ recentMfa: true });
    const response = await requestLocal(`${base}/admin/updates/apply`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "update:12345678",
      },
      body: JSON.stringify({
        targetVersion: "2.6.0-cloudssh.17",
        idempotencyKey: "update:87654321",
      }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "IDEMPOTENCY_KEY_CONFLICT",
    });
    expect(mocks.startUpdate).not.toHaveBeenCalled();
  });

  it("回退目标完全由受控运行目录历史决定", async () => {
    const base = await listen({ recentMfa: true });
    const response = await requestLocal(`${base}/admin/updates/rollback`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "rollback:12345678",
      },
      body: JSON.stringify({ backupPath: "/tmp/untrusted" }),
    });
    expect(response.status).toBe(202);
    expect(mocks.rollbackUpdate).toHaveBeenCalledWith({
      idempotencyKey: "rollback:12345678",
    });
  });
});
