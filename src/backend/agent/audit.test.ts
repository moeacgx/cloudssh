import Database from "better-sqlite3";
import crypto from "crypto";
import { EventEmitter } from "events";
import { describe, expect, it, vi } from "vitest";
import type { AgentAuthenticatedRequest } from "./auth.js";
import {
  createAgentAuditMiddleware,
  markAgentOperationCommitted,
  markAgentOperationDispatched,
  SqliteAgentAuditSink,
} from "./audit.js";
import { AgentSecurityStore } from "./security-store.js";

function createDatabase() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE project_hosts (
      id INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL
    );
    CREATE TABLE persistent_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      project_host_id INTEGER NOT NULL,
      service_account_id TEXT NOT NULL
    );
    CREATE TABLE agent_audit_events (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      service_account_id TEXT NOT NULL,
      token_id TEXT,
      device_id TEXT,
      session_id TEXT,
      project_host_id INTEGER,
      request_id TEXT,
      action TEXT NOT NULL,
      success INTEGER NOT NULL,
      error_code TEXT,
      metadata TEXT,
      ip_address TEXT,
      occurred_at TEXT NOT NULL
    );
    INSERT INTO project_hosts VALUES
      (11, 'project-1'),
      (22, 'project-2');
    INSERT INTO persistent_sessions VALUES
      ('shared-session', 'project-2', 22, 'session-creator-account');
  `);
  return sqlite;
}

function request(
  originalUrl: string,
  path: string,
  method = "GET",
  headers: Record<string, string> = {},
): AgentAuthenticatedRequest {
  return Object.assign(new EventEmitter(), {
    method,
    path,
    originalUrl,
    body: {},
    ip: "127.0.0.1",
    agentDeviceId: "device-1",
    agentPrincipal: {
      principalId: "device:device-1",
      serviceAccountId: "device-project-1",
      serviceAccountIds: ["device-project-1", "device-project-2"],
      projectId: "project-1",
      projectIds: ["project-1", "project-2"],
      projectServiceAccountIds: {
        "project-1": "device-project-1",
        "project-2": "device-project-2",
      },
      name: "测试设备",
      scopes: ["sessions:read", "jobs:execute"],
      serverIds: ["11", "22"],
      serverProjectIds: { "11": "project-1", "22": "project-2" },
      serverServiceAccountIds: {
        "11": "device-project-1",
        "22": "device-project-2",
      },
      maxConcurrentSessions: 2,
    },
    get: (name: string) => headers[name.toLowerCase()],
  }) as unknown as AgentAuthenticatedRequest;
}

describe("Agent 审计归属", () => {
  it.each([
    {
      name: "Job 命令",
      originalUrl: "/agent/v1/jobs",
      path: "/jobs",
      body: {
        serverId: "11",
        command: "curl -H 'Authorization: Bearer audit-secret' example.test",
        timeoutMs: 30_000,
      },
      secret: "curl -H 'Authorization: Bearer audit-secret' example.test",
      summaryKey: "commandSummary",
    },
    {
      name: "终端写入",
      originalUrl: "/agent/v1/sessions/shared-session/write",
      path: "/sessions/shared-session/write",
      body: {
        attachmentId: "attachment-1",
        leaseId: "lease-1",
        data: "export PRIVATE_KEY='terminal-secret'\n",
      },
      secret: "export PRIVATE_KEY='terminal-secret'\n",
      summaryKey: "dataSummary",
    },
  ])("主库中的 $name 只保存输入长度", async (fixture) => {
    const sqlite = createDatabase();
    try {
      const auditedRequest = request(fixture.originalUrl, fixture.path, "POST");
      auditedRequest.body = fixture.body;

      await new SqliteAgentAuditSink(sqlite).record(
        auditedRequest,
        102,
        true,
        "intent",
      );

      const row = sqlite
        .prepare("SELECT metadata FROM agent_audit_events")
        .get() as { metadata: string };
      const metadata = JSON.parse(row.metadata) as {
        input: Record<string, unknown>;
      };
      expect(row.metadata).not.toContain(fixture.secret);
      expect(metadata.input).not.toHaveProperty("command");
      expect(metadata.input).not.toHaveProperty("data");
      expect(metadata.input[fixture.summaryKey]).toEqual({
        byteLength: Buffer.byteLength(fixture.secret, "utf8"),
      });
    } finally {
      sqlite.close();
    }
  });

  it("安全镜像及同步后的主库都不保存 Job 命令原文", async () => {
    const sqlite = createDatabase();
    const security = new AgentSecurityStore(":memory:");
    try {
      const secret = "printf '%s' 'mirror-database-secret'";
      const auditedRequest = request("/agent/v1/jobs", "/jobs", "POST");
      auditedRequest.body = {
        serverId: "11",
        command: secret,
        timeoutMs: 5_000,
      };
      const mirrorWrite = vi.spyOn(security, "recordAudit");

      await new SqliteAgentAuditSink(
        sqlite,
        undefined,
        undefined,
        security,
      ).record(auditedRequest, 102, true, "intent");

      expect(mirrorWrite).toHaveBeenCalledOnce();
      const mirroredMetadata = mirrorWrite.mock.calls[0]?.[0].metadata ?? "";
      expect(mirroredMetadata).not.toContain(secret);
      expect(JSON.parse(mirroredMetadata)).toMatchObject({
        input: {
          serverId: "11",
          commandSummary: {
            byteLength: Buffer.byteLength(secret, "utf8"),
          },
          timeoutMs: 5_000,
        },
      });

      expect(security.syncAuditEvents(sqlite)).toBe(1);
      const synced = sqlite
        .prepare("SELECT metadata FROM agent_audit_events")
        .get() as { metadata: string };
      expect(synced.metadata).toBe(mirroredMetadata);
      expect(synced.metadata).not.toContain(secret);
    } finally {
      security.close();
      sqlite.close();
    }
  });

  it("创建主机和快速连接的审计不保存密码或私钥正文", async () => {
    for (const path of ["/servers", "/quick-connections"] as const) {
      const sqlite = createDatabase();
      try {
        const password = "audit-password-secret";
        const key = "-----BEGIN OPENSSH PRIVATE KEY-----\naudit-key-secret";
        const keyPassword = "audit-key-passphrase";
        const auditedRequest = request(`/agent/v1${path}`, path, "POST", {
          "idempotency-key": "audit-secret-operation",
          "x-request-id": "audit-secret-request",
          "x-cloudssh-body-sha256": crypto
            .createHash("sha256")
            .update(`signed-body-containing-${password}`)
            .digest("hex"),
        });
        auditedRequest.body = {
          projectId: "project-1",
          name: "db-01",
          address: "203.0.113.10",
          port: 22,
          username: "root",
          authType: "key",
          folder: "生产 / 数据库",
          key,
          keyPassword,
          password,
        };

        await new SqliteAgentAuditSink(sqlite).record(
          auditedRequest,
          102,
          true,
          "intent",
        );

        const row = sqlite
          .prepare("SELECT id, metadata FROM agent_audit_events")
          .get() as { id: string; metadata: string };
        const metadata = JSON.parse(row.metadata) as {
          input: Record<string, unknown>;
        };
        expect(row.metadata).not.toContain(password);
        expect(row.metadata).not.toContain(key);
        expect(row.metadata).not.toContain(keyPassword);
        expect(metadata.input).not.toHaveProperty("password");
        expect(metadata.input).not.toHaveProperty("key");
        expect(metadata.input).not.toHaveProperty("keyPassword");
        expect(metadata.input).toMatchObject({
          passwordProvided: true,
          keyProvided: true,
          keyPasswordProvided: true,
        });
        expect(row.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
      } finally {
        sqlite.close();
      }
    }
  });

  it("文件上传按查询中的主机归属项目记账且不保存正文", async () => {
    const sqlite = createDatabase();
    try {
      const secret = Buffer.from("uploaded-file-secret");
      const auditedRequest = request(
        "/agent/v1/files/upload?serverId=22&path=%2Ftmp%2Fsecret.bin",
        "/files/upload",
        "POST",
        { "idempotency-key": "upload-file-1" },
      );
      auditedRequest.query = {
        serverId: "22",
        path: "/tmp/secret.bin",
      };
      auditedRequest.body = secret;

      await new SqliteAgentAuditSink(sqlite).record(
        auditedRequest,
        102,
        true,
        "intent",
      );

      const row = sqlite
        .prepare(
          `SELECT project_id AS projectId,
                  service_account_id AS serviceAccountId,
                  project_host_id AS projectHostId, metadata
             FROM agent_audit_events`,
        )
        .get() as {
        projectId: string;
        serviceAccountId: string;
        projectHostId: number;
        metadata: string;
      };
      expect(row).toMatchObject({
        projectId: "project-2",
        serviceAccountId: "device-project-2",
        projectHostId: 22,
      });
      expect(row.metadata).not.toContain(secret.toString("utf8"));
      expect(JSON.parse(row.metadata)).toMatchObject({
        input: {
          serverId: "22",
          path: "/tmp/secret.bin",
          byteLength: secret.length,
        },
      });
    } finally {
      sqlite.close();
    }
  });

  it("共享会话按当前设备在目标项目的账号记账", async () => {
    const sqlite = createDatabase();
    try {
      const sink = new SqliteAgentAuditSink(sqlite);
      await sink.record(
        request(
          "/agent/v1/sessions/shared-session/read",
          "/sessions/shared-session/read",
        ),
        200,
      );

      expect(
        sqlite
          .prepare(
            `SELECT project_id, service_account_id, session_id,
                    project_host_id, action
               FROM agent_audit_events`,
          )
          .get(),
      ).toEqual({
        project_id: "project-2",
        service_account_id: "device-project-2",
        session_id: "shared-session",
        project_host_id: 22,
        action: "get /sessions/:id/read",
      });
    } finally {
      sqlite.close();
    }
  });

  it("Job 查询和取消按 Job 的实际项目记账", async () => {
    const sqlite = createDatabase();
    try {
      const resolveJob = vi.fn(async () => ({
        id: "job-2",
        projectId: "project-2",
        serverId: "22",
      }));
      const sink = new SqliteAgentAuditSink(sqlite, undefined, resolveJob);
      await sink.record(
        request("/agent/v1/jobs/job-2/cancel", "/jobs/job-2/cancel", "POST"),
        200,
      );

      expect(resolveJob).toHaveBeenCalledWith("job-2");
      expect(
        sqlite
          .prepare(
            `SELECT project_id, service_account_id, project_host_id, action
               FROM agent_audit_events`,
          )
          .get(),
      ).toEqual({
        project_id: "project-2",
        service_account_id: "device-project-2",
        project_host_id: 22,
        action: "post /jobs/:id/cancel",
      });
    } finally {
      sqlite.close();
    }
  });

  it("审计持久化失败会向调用方抛出", async () => {
    const sqlite = createDatabase();
    try {
      const sink = new SqliteAgentAuditSink(sqlite, async () => {
        throw new Error("save failed");
      });
      await expect(
        sink.record(request("/agent/v1/servers", "/servers"), 200),
      ).rejects.toThrow("save failed");
    } finally {
      sqlite.close();
    }
  });

  it("设备重试相同幂等操作时为每次 HTTP 尝试保留独立审计", async () => {
    const sqlite = createDatabase();
    try {
      const sink = new SqliteAgentAuditSink(sqlite);
      const first = request("/agent/v1/jobs", "/jobs", "POST", {
        "idempotency-key": "same-operation",
        "x-request-id": "stable-request",
      });
      first.body = { serverId: "11", command: "hostname" };
      first.rawBody = Buffer.from('{"serverId":"11","command":"hostname"}');
      const retry = request("/agent/v1/jobs", "/jobs", "POST", {
        "idempotency-key": "same-operation",
        "x-request-id": "stable-request",
      });
      retry.body = { serverId: "11", command: "hostname" };
      retry.rawBody = Buffer.from('{"serverId":"11","command":"hostname"}');

      await sink.record(first, 202);
      await sink.record(retry, 409);

      expect(
        sqlite
          .prepare(
            `SELECT COUNT(*) AS count,
                    SUM(success) AS successes,
                    SUM(CASE WHEN error_code = 'HTTP_409' THEN 1 ELSE 0 END)
                      AS conflicts
               FROM agent_audit_events`,
          )
          .get(),
      ).toEqual({ count: 2, successes: 1, conflicts: 1 });
    } finally {
      sqlite.close();
    }
  });

  it("相同幂等键对应不同请求 ID 时分别保留冲突审计", async () => {
    const sqlite = createDatabase();
    try {
      const sink = new SqliteAgentAuditSink(sqlite);
      const first = request("/agent/v1/jobs", "/jobs", "POST", {
        "idempotency-key": "conflicting-operation",
        "x-request-id": "conflicting-request-1",
        "x-cloudssh-body-sha256": crypto
          .createHash("sha256")
          .update('{"serverId":"11","command":"hostname"}')
          .digest("hex"),
      });
      first.body = { serverId: "11", command: "hostname" };
      const conflicting = request("/agent/v1/jobs", "/jobs", "POST", {
        "idempotency-key": "conflicting-operation",
        "x-request-id": "conflicting-request-2",
        "x-cloudssh-body-sha256": crypto
          .createHash("sha256")
          .update('{"serverId":"11","command":"whoami"}')
          .digest("hex"),
      });
      conflicting.body = { serverId: "11", command: "whoami" };

      await sink.record(first, 202);
      await sink.record(conflicting, 409);

      expect(
        sqlite
          .prepare(
            `SELECT COUNT(*) AS count, SUM(success) AS successes
               FROM agent_audit_events`,
          )
          .get(),
      ).toEqual({ count: 2, successes: 1 });
    } finally {
      sqlite.close();
    }
  });

  it("不同设备复用同一幂等键不会互相覆盖审计", async () => {
    const sqlite = createDatabase();
    try {
      const sink = new SqliteAgentAuditSink(sqlite);
      const first = request("/agent/v1/jobs", "/jobs", "POST", {
        "idempotency-key": "shared-key",
        "x-request-id": "device-1-request",
      });
      const second = request("/agent/v1/jobs", "/jobs", "POST", {
        "idempotency-key": "shared-key",
        "x-request-id": "device-2-request",
      });
      second.agentDeviceId = "device-2";

      await sink.record(first, 202);
      await sink.record(second, 202);

      expect(
        sqlite
          .prepare("SELECT COUNT(*) AS count FROM agent_audit_events")
          .get(),
      ).toEqual({ count: 2 });
    } finally {
      sqlite.close();
    }
  });

  it("同一设备在不同会话复用幂等键时分别保留审计", async () => {
    const sqlite = createDatabase();
    try {
      const sink = new SqliteAgentAuditSink(sqlite);
      const first = request(
        "/agent/v1/sessions/session-1/write",
        "/sessions/session-1/write",
        "POST",
        { "idempotency-key": "shared-write-key" },
      );
      const second = request(
        "/agent/v1/sessions/session-2/write",
        "/sessions/session-2/write",
        "POST",
        { "idempotency-key": "shared-write-key" },
      );

      await sink.record(first, 202);
      await sink.record(second, 202);

      expect(
        sqlite
          .prepare("SELECT COUNT(*) AS count FROM agent_audit_events")
          .get(),
      ).toEqual({ count: 2 });
    } finally {
      sqlite.close();
    }
  });

  it.each([
    ["/agent/v1/sessions", "/sessions"],
    ["/agent/v1/sessions/s-1/attach", "/sessions/s-1/attach"],
    ["/agent/v1/sessions/s-1/resize", "/sessions/s-1/resize"],
    ["/agent/v1/sessions/s-1/detach", "/sessions/s-1/detach"],
    ["/agent/v1/sessions/s-1/close", "/sessions/s-1/close"],
    ["/agent/v1/jobs/j-1/cancel", "/jobs/j-1/cancel"],
    ["/agent/v1/files/upload", "/files/upload"],
    ["/agent/v1/files/mkdir", "/files/mkdir"],
    ["/agent/v1/files/rename", "/files/rename"],
    ["/agent/v1/files/delete", "/files/delete"],
  ])("副作用接口 %s 必须在执行前完成意图审计", async (url, path) => {
    const record = vi.fn(async () => undefined);
    const middleware = createAgentAuditMiddleware({ record });
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200,
      writableFinished: false,
      destroyed: false,
    });
    const next = vi.fn();

    middleware(request(url, path, "POST"), response as never, next);

    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
    expect(record).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      102,
      true,
      "intent",
    );
  });

  it("意图审计不可用时拒绝副作用且不进入业务处理", async () => {
    const middleware = createAgentAuditMiddleware({
      record: vi.fn(async () => {
        throw new Error("audit storage unavailable");
      }),
    });
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200,
      writableFinished: false,
      destroyed: false,
      body: undefined as unknown,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(body: unknown) {
        this.body = body;
        return this;
      },
    });
    const next = vi.fn();

    middleware(
      request("/agent/v1/sessions", "/sessions", "POST"),
      response as never,
      next,
    );

    await vi.waitFor(() => expect(response.statusCode).toBe(503));
    expect(response.body).toEqual({
      error: "Agent 审计暂时不可用，操作未执行",
      code: "AUDIT_UNAVAILABLE",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    [
      "终端输出",
      "/agent/v1/sessions/session-1/read",
      "/sessions/session-1/read",
    ],
    ["Job 列表输出", "/agent/v1/jobs", "/jobs"],
    ["Job 详情输出", "/agent/v1/jobs/job-1", "/jobs/job-1"],
  ])("预写审计不可用时拒绝读取%s", async (_name, url, path) => {
    const middleware = createAgentAuditMiddleware({
      record: vi.fn(async () => {
        throw new Error("audit storage unavailable");
      }),
    });
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200,
      writableFinished: false,
      destroyed: false,
      body: undefined as unknown,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(body: unknown) {
        this.body = body;
        return this;
      },
    });
    const next = vi.fn();

    middleware(request(url, path), response as never, next);

    await vi.waitFor(() => expect(response.statusCode).toBe(503));
    expect(response.body).toEqual({
      error: "Agent 审计暂时不可用，操作未执行",
      code: "AUDIT_UNAVAILABLE",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    [200, 1, null, "result", "succeeded"],
    [404, 0, "HTTP_404", "result", "failed"],
  ])(
    "结果占位在业务前落盘，并由 HTTP %s 结果原位更新",
    async (statusCode, success, errorCode, expectedStage, expectedOutcome) => {
      const sqlite = createDatabase();
      try {
        const middleware = createAgentAuditMiddleware(
          new SqliteAgentAuditSink(sqlite),
        );
        const response = Object.assign(new EventEmitter(), {
          statusCode,
          writableFinished: false,
          destroyed: false,
        });
        const next = vi.fn();

        middleware(request("/agent/v1/jobs", "/jobs"), response as never, next);

        await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
        const pending = sqlite
          .prepare(
            `SELECT success, error_code AS errorCode, metadata
               FROM agent_audit_events`,
          )
          .get() as { success: number; errorCode: string; metadata: string };
        expect(pending).toMatchObject({ success: 0, errorCode: "PENDING" });
        expect(JSON.parse(pending.metadata)).toMatchObject({
          stage: "pending",
          outcome: "pending",
        });

        response.writableFinished = true;
        response.emit("finish");
        await vi.waitFor(() => {
          const final = sqlite
            .prepare(
              `SELECT success, error_code AS errorCode, metadata
                 FROM agent_audit_events`,
            )
            .get() as {
            success: number;
            errorCode: string | null;
            metadata: string;
          };
          expect(final).toMatchObject({ success, errorCode });
          expect(JSON.parse(final.metadata)).toMatchObject({
            stage: expectedStage,
            outcome: expectedOutcome,
          });
        });
        expect(
          sqlite
            .prepare("SELECT COUNT(*) AS count FROM agent_audit_events")
            .get(),
        ).toEqual({ count: 1 });
      } finally {
        sqlite.close();
      }
    },
  );

  it.each([
    {
      name: "rename",
      path: "/files/rename",
      body: {
        serverId: "11",
        sourcePath: "/srv/source.txt",
        destinationPath: "/srv/destination.txt",
      },
    },
    {
      name: "delete",
      path: "/files/delete",
      body: {
        serverId: "11",
        path: "/srv/obsolete.txt",
        recursive: false,
      },
    },
  ])(
    "$name 已下发后请求失败时明确记录结果未知",
    async ({ name, path, body }) => {
      const sqlite = createDatabase();
      try {
        const middleware = createAgentAuditMiddleware(
          new SqliteAgentAuditSink(sqlite),
        );
        const auditedRequest = request(`/agent/v1${path}`, path, "POST", {
          "idempotency-key": `dispatched-${name}`,
        });
        auditedRequest.body = body;
        const response = Object.assign(new EventEmitter(), {
          statusCode: 200,
          writableFinished: false,
          destroyed: false,
        });
        const next = vi.fn();

        middleware(auditedRequest, response as never, next);
        await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());

        // 文件服务已把修改下发到远端，但 SFTP 回调随后报错。
        markAgentOperationDispatched(auditedRequest);
        response.statusCode = 500;
        response.writableFinished = true;
        response.emit("finish");

        await vi.waitFor(() => {
          const row = sqlite
            .prepare(
              `SELECT success, error_code AS errorCode, metadata
                 FROM agent_audit_events
                WHERE action = ?`,
            )
            .get(`post ${path}`) as {
            success: number;
            errorCode: string;
            metadata: string;
          };
          expect(row).toMatchObject({
            success: 0,
            errorCode: "OUTCOME_UNKNOWN",
          });
          expect(JSON.parse(row.metadata)).toMatchObject({
            stage: "result",
            statusCode: 500,
            responseCompleted: true,
            outcome: "unknown",
            operationDispatched: true,
            operationCommitted: false,
          });
        });
        expect(auditedRequest.agentOperationCommitted).not.toBe(true);
      } finally {
        sqlite.close();
      }
    },
  );

  it("最终结果连续写入失败时仍保留 PENDING 证据", async () => {
    const sqlite = createDatabase();
    const security = new AgentSecurityStore(":memory:");
    try {
      const durableWrite = security.recordAudit.bind(security);
      let finalAttempts = 0;
      vi.spyOn(security, "recordAudit").mockImplementation(async (event) => {
        const metadata = JSON.parse(event.metadata) as { stage: string };
        if (metadata.stage === "result") {
          finalAttempts += 1;
          throw new Error("result storage unavailable");
        }
        await durableWrite(event);
      });
      const middleware = createAgentAuditMiddleware(
        new SqliteAgentAuditSink(sqlite, undefined, undefined, security),
      );
      const response = Object.assign(new EventEmitter(), {
        statusCode: 200,
        writableFinished: true,
        destroyed: false,
      });
      const next = vi.fn();

      middleware(
        request(
          "/agent/v1/sessions/session-1/read",
          "/sessions/session-1/read",
        ),
        response as never,
        next,
      );

      await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
      response.emit("finish");
      await vi.waitFor(() => expect(finalAttempts).toBe(3));
      expect(security.syncAuditEvents(sqlite)).toBe(1);
      const evidence = sqlite
        .prepare(
          `SELECT success, error_code AS errorCode, metadata
             FROM agent_audit_events`,
        )
        .get() as { success: number; errorCode: string; metadata: string };
      expect(evidence).toMatchObject({ success: 0, errorCode: "PENDING" });
      expect(JSON.parse(evidence.metadata)).toMatchObject({ stage: "pending" });
    } finally {
      security.close();
      sqlite.close();
    }
  });

  it("客户端断开时补记失败审计且 finish 不会重复记录", async () => {
    const record = vi.fn(async () => undefined);
    const middleware = createAgentAuditMiddleware({ record });
    const response = Object.assign(new EventEmitter(), {
      statusCode: 202,
      writableFinished: false,
    });
    const next = vi.fn();
    middleware(
      request("/agent/v1/jobs", "/jobs", "POST"),
      response as never,
      next,
    );

    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
    expect(record).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      102,
      true,
      "intent",
    );
    response.emit("close");
    response.writableFinished = true;
    response.emit("finish");
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(3));
    expect(record).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      102,
      false,
      "pending",
    );
    expect(record).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      202,
      false,
      "result",
    );
  });

  it("意图审计尚未完成时断线不会继续执行远程操作", async () => {
    let releaseIntent!: () => void;
    const record = vi.fn(
      async (
        _request: AgentAuthenticatedRequest,
        _status: number,
        _completed?: boolean,
        stage?: "intent" | "pending" | "result",
      ) => {
        if (stage === "intent") {
          await new Promise<void>((resolve) => {
            releaseIntent = resolve;
          });
        }
      },
    );
    const middleware = createAgentAuditMiddleware({ record });
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200,
      writableFinished: false,
      destroyed: false,
    });
    const next = vi.fn();

    middleware(
      request(
        "/agent/v1/sessions/session-1/resize",
        "/sessions/session-1/resize",
        "POST",
      ),
      response as never,
      next,
    );
    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    response.destroyed = true;
    response.emit("close");
    releaseIntent();

    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(2));
    expect(next).not.toHaveBeenCalled();
    expect(record).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      200,
      false,
      "result",
    );
  });

  it("断线后的远端下发先标记结果未知，确认完成后原位升级为已提交", async () => {
    const sqlite = createDatabase();
    try {
      const sink = new SqliteAgentAuditSink(sqlite);
      const middleware = createAgentAuditMiddleware(sink);
      const auditedRequest = request(
        "/agent/v1/sessions/unknown/resize",
        "/sessions/unknown/resize",
        "POST",
        { "x-request-id": "disconnect-then-commit" },
      );
      const response = Object.assign(new EventEmitter(), {
        statusCode: 200,
        writableFinished: false,
        destroyed: false,
      });
      const next = vi.fn();

      middleware(auditedRequest, response as never, next);
      await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
      response.destroyed = true;
      response.emit("close");
      await vi.waitFor(() =>
        expect(
          sqlite
            .prepare(
              `SELECT success, error_code AS errorCode
                 FROM agent_audit_events
                WHERE action = 'post /sessions/:id/resize'`,
            )
            .get(),
        ).toEqual({ success: 0, errorCode: "CLIENT_DISCONNECTED" }),
      );

      markAgentOperationDispatched(auditedRequest);
      await vi.waitFor(() =>
        expect(
          sqlite
            .prepare(
              `SELECT success, error_code AS errorCode
                 FROM agent_audit_events
                WHERE action = 'post /sessions/:id/resize'`,
            )
            .get(),
        ).toEqual({ success: 0, errorCode: "OUTCOME_UNKNOWN" }),
      );

      markAgentOperationCommitted(auditedRequest);
      await vi.waitFor(() =>
        expect(
          sqlite
            .prepare(
              `SELECT success, error_code AS errorCode
                 FROM agent_audit_events
                WHERE action = 'post /sessions/:id/resize'`,
            )
            .get(),
        ).toEqual({ success: 1, errorCode: null }),
      );
      expect(
        sqlite
          .prepare("SELECT COUNT(*) AS count FROM agent_audit_events")
          .get(),
      ).toEqual({ count: 2 });
    } finally {
      sqlite.close();
    }
  });
});
