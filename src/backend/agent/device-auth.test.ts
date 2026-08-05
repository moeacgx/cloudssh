import crypto from "crypto";
import type { Server } from "http";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedRequest } from "../../types/index.js";
import { ensureControlPlaneSchema } from "../control-plane/schema-migration.js";
import {
  AgentDeviceAdminRepository,
  createAgentDeviceAdminRouter,
} from "./device-admin.js";
import {
  canonicalDeviceRequest,
  createAgentDeviceAuthMiddleware,
  createAgentDevicePreAuthMiddleware,
  sha256Hex,
  SqliteAgentDeviceStore,
} from "./device-auth.js";
import {
  AgentDeviceRegistrationRepository,
  createAgentDeviceRegistrationRouter,
} from "./device-registration.js";
import { AgentSessionBroker } from "./broker.js";
import { AgentJobManager } from "./jobs.js";
import { createAgentApp } from "./routes.js";
import { AgentSecurityStore } from "./security-store.js";
import { MemoryAgentServerDirectory } from "./servers.js";
import { MemoryAgentStateStore } from "./store.js";
import { UnavailableJobDriver, UnavailableSessionDriver } from "./drivers.js";

describe("Ed25519 Agent 设备认证", () => {
  let sqlite: Database.Database;
  let server: Server;
  let baseUrl: string;
  let privateKey: crypto.KeyObject;
  let publicKeyPem: string;
  let deviceId: string;
  let deviceStore: SqliteAgentDeviceStore;
  let registration: AgentDeviceRegistrationRepository;
  let adminAudit: ReturnType<typeof vi.fn>;
  let adminPersist: ReturnType<typeof vi.fn>;
  let noncePersist: ReturnType<typeof vi.fn>;
  let security: AgentSecurityStore;
  let manageableProjects: Array<{ id: string; name: string }>;
  let instanceAdmin: boolean;

  beforeEach(async () => {
    sqlite = new Database(":memory:");
    security = new AgentSecurityStore(":memory:");
    sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL,
        password_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0,
        totp_enabled INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE webauthn_credentials (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
        user_verification TEXT NOT NULL DEFAULT 'preferred',
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      );
      CREATE TABLE ssh_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
        folder TEXT
      );
      CREATE TABLE audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL, username TEXT NOT NULL,
        action TEXT NOT NULL, resource_type TEXT NOT NULL,
        resource_id TEXT, resource_name TEXT, details TEXT,
        ip_address TEXT, user_agent TEXT, success INTEGER NOT NULL,
        error_message TEXT, timestamp TEXT DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO users VALUES ('admin', 'admin', 'hash', 1, 1);
    `);
    ensureControlPlaneSchema(sqlite);
    sqlite.exec(`
      INSERT INTO teams (id, name, slug, owner_user_id)
        VALUES ('team-1', 'Team', 'team', 'admin');
      INSERT INTO projects
        (id, team_id, owner_user_id, kind, name, slug)
        VALUES ('project-1', 'team-1', 'admin', 'team', 'Project', 'project');
      INSERT INTO ssh_data (id, user_id, folder) VALUES (1, 'admin', NULL);
      INSERT INTO project_hosts (id, project_id, host_id, added_by)
        VALUES (11, 'project-1', 1, 'admin');
    `);

    const pair = crypto.generateKeyPairSync("ed25519");
    privateKey = pair.privateKey;
    publicKeyPem = pair.publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    registration = new AgentDeviceRegistrationRepository(sqlite);
    const pending = await registration.create("Test device", publicKeyPem);
    const admin = new AgentDeviceAdminRepository(sqlite);
    const approved = await admin.approve({
      requestId: pending.requestId,
      approvedBy: "admin",
      accessMode: "selected",
      projectIds: ["project-1"],
      scopes: ["sessions:read"],
      maxConcurrentSessions: 2,
      expiresAt: null,
    });
    deviceId = approved!.id;

    const state = new MemoryAgentStateStore();
    noncePersist = vi.fn(async () => undefined);
    deviceStore = new SqliteAgentDeviceStore(
      sqlite,
      undefined,
      async () => ["project-1"],
      noncePersist,
    );
    const app = createAgentApp({
      authenticate: createAgentDeviceAuthMiddleware(deviceStore, security),
      preAuthenticateUpload: createAgentDevicePreAuthMiddleware(
        deviceStore,
        security,
      ),
      registration: createAgentDeviceRegistrationRouter(
        registration,
        undefined,
        undefined,
        security,
      ),
      servers: new MemoryAgentServerDirectory([
        {
          hostId: 1,
          serverId: "11",
          name: "Server",
          connectionType: "ssh",
        },
      ]),
      sessions: new AgentSessionBroker(state, new UnavailableSessionDriver()),
      jobs: new AgentJobManager(state, new UnavailableJobDriver()),
    });
    adminAudit = vi.fn(async () => undefined);
    adminPersist = vi.fn(async () => undefined);
    manageableProjects = [{ id: "project-1", name: "Project" }];
    instanceAdmin = true;
    app.use(
      "/agent/admin/v1",
      createAgentDeviceAdminRouter({
        sqlite,
        authenticate: (req, _res, next) => {
          const auth = req as AuthenticatedRequest;
          auth.userId = "admin";
          auth.user = { username: "admin" } as AuthenticatedRequest["user"];
          if (req.header("x-test-auth") === "api-key") {
            auth.apiKeyId = "api-key-1";
          } else {
            auth.sessionId = "session-1";
            auth.mfaVerifiedAt = Math.floor(Date.now() / 1000);
          }
          next();
        },
        listManageableProjects: async () => manageableProjects,
        isInstanceAdmin: async () => instanceAdmin,
        audit: adminAudit,
        onWrite: adminPersist,
      }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("listen failed");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    security.close();
    sqlite.close();
  });

  function signed(
    path: string,
    init: RequestInit = {},
    nonce?: string,
    signedBody?: Buffer,
  ) {
    const method = init.method ?? "GET";
    const body =
      typeof init.body === "string"
        ? Buffer.from(init.body)
        : Buffer.isBuffer(init.body)
          ? init.body
          : Buffer.alloc(0);
    const initialHeaders = new Headers(init.headers);
    const idempotencyKey = initialHeaders.get("idempotency-key") ?? "";
    const timestamp = String(Date.now());
    const requestNonce = nonce ?? crypto.randomBytes(18).toString("base64url");
    const requestId = crypto.randomUUID();
    const bodyHash = sha256Hex(signedBody ?? body);
    const signature = crypto
      .sign(
        null,
        Buffer.from(
          canonicalDeviceRequest({
            method,
            pathAndQuery: `/agent/v1${path}`,
            timestamp,
            nonce: requestNonce,
            bodyHash,
            idempotencyKey,
            requestId,
          }),
        ),
        privateKey,
      )
      .toString("base64url");
    return fetch(`${baseUrl}/agent/v1${path}`, {
      ...init,
      headers: {
        "x-cloudssh-device-id": deviceId,
        "x-cloudssh-timestamp": timestamp,
        "x-cloudssh-nonce": requestNonce,
        "x-cloudssh-body-sha256": bodyHash,
        "x-cloudssh-signature": signature,
        "x-request-id": requestId,
        ...Object.fromEntries(initialHeaders.entries()),
      },
    });
  }

  function pollDeviceRequest(requestId: string, key: crypto.KeyObject) {
    const pathAndQuery = `/agent/v1/auth/device-requests/${requestId}`;
    const timestamp = String(Date.now());
    const nonce = crypto.randomBytes(18).toString("base64url");
    const signedRequestId = crypto.randomUUID();
    const bodyHash = sha256Hex(Buffer.alloc(0));
    const signature = crypto
      .sign(
        null,
        Buffer.from(
          canonicalDeviceRequest({
            method: "GET",
            pathAndQuery,
            timestamp,
            nonce,
            bodyHash,
            requestId: signedRequestId,
          }),
        ),
        key,
      )
      .toString("base64url");
    return fetch(`${baseUrl}${pathAndQuery}`, {
      headers: {
        "x-cloudssh-timestamp": timestamp,
        "x-cloudssh-nonce": nonce,
        "x-cloudssh-body-sha256": bodyHash,
        "x-cloudssh-signature": signature,
        "x-request-id": signedRequestId,
      },
    });
  }

  it("首次审批后可持续签名访问且重复 nonce 被拒绝", async () => {
    const nonce = crypto.randomBytes(18).toString("base64url");
    const first = await signed("/servers", {}, nonce);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      servers: [
        {
          hostId: 1,
          serverId: "11",
          name: "Server",
          connectionType: "ssh",
        },
      ],
    });
    expect(noncePersist).toHaveBeenCalledTimes(1);

    const replay = await signed("/servers", {}, nonce);
    expect(replay.status).toBe(401);
    expect((await replay.json()).code).toBe("DEVICE_REQUEST_REPLAYED");
    expect(security.listAuthFailures(1)[0]).toMatchObject({
      deviceId,
      method: "GET",
      path: "/agent/v1/servers",
      errorCode: "DEVICE_REQUEST_REPLAYED",
    });

    const next = await signed("/servers");
    expect(next.status).toBe(200);
    expect(noncePersist).toHaveBeenCalledTimes(2);
  });

  it("文件上传在解析正文前预认证，完整鉴权不会重复消费 nonce", async () => {
    sqlite
      .prepare("UPDATE agent_devices SET scopes = ? WHERE id = ?")
      .run(JSON.stringify(["sessions:read", "files:write"]), deviceId);
    const body = Buffer.from("binary upload");
    const response = await signed(
      "/files/upload?serverId=11&path=%2Ftmp%2Fupload.bin",
      {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "idempotency-key": "pre-auth-upload",
        },
        body,
      },
    );

    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("FILE_SERVICE_UNAVAILABLE");
    expect(noncePersist).toHaveBeenCalledTimes(1);
  });

  it("流式上传的实际正文摘要与签名声明不一致时拒绝请求", async () => {
    sqlite
      .prepare("UPDATE agent_devices SET scopes = ? WHERE id = ?")
      .run(JSON.stringify(["sessions:read", "files:write"]), deviceId);
    const response = await signed(
      "/files/upload?serverId=11&path=%2Ftmp%2Ftampered.bin",
      {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "idempotency-key": "tampered-stream-upload",
        },
        body: Buffer.from("content changed in transit"),
      },
      undefined,
      Buffer.from("content signed by device"),
    );

    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("DEVICE_BODY_TAMPERED");
    expect(noncePersist).toHaveBeenCalledTimes(1);
  });

  it("上传预认证后被撤销的设备不能进入 SFTP 操作", async () => {
    sqlite
      .prepare("UPDATE agent_devices SET scopes = ? WHERE id = ?")
      .run(JSON.stringify(["sessions:read", "files:write"]), deviceId);
    const findActive = deviceStore.findActiveById.bind(deviceStore);
    let activeLookups = 0;
    vi.spyOn(deviceStore, "findActiveById").mockImplementation(async (id) => {
      const record = await findActive(id);
      activeLookups += 1;
      if (activeLookups === 1) {
        sqlite
          .prepare(
            "UPDATE agent_devices SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?",
          )
          .run(deviceId);
      }
      return record;
    });

    const response = await signed(
      "/files/upload?serverId=11&path=%2Ftmp%2Frevoked.bin",
      {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "idempotency-key": "revoked-stream-upload",
        },
        body: Buffer.from("must not reach SFTP"),
      },
    );

    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("DEVICE_NOT_AUTHORIZED");
    expect(activeLookups).toBe(2);
  });

  it("文件上传在读取正文前拒绝缺少写权限或服务器授权的设备", async () => {
    const deniedScope = await signed(
      "/files/upload?serverId=11&path=%2Ftmp%2Fdenied.bin",
      {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "idempotency-key": "scope-denied-upload",
        },
        body: Buffer.alloc(1024 * 1024),
      },
    );
    expect(deniedScope.status).toBe(403);
    expect((await deniedScope.json()).code).toBe("SCOPE_DENIED");

    sqlite
      .prepare("UPDATE agent_devices SET scopes = ? WHERE id = ?")
      .run(JSON.stringify(["sessions:read", "files:write"]), deviceId);
    const deniedServer = await signed(
      "/files/upload?serverId=999&path=%2Ftmp%2Fdenied.bin",
      {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "idempotency-key": "server-denied-upload",
        },
        body: Buffer.alloc(1024 * 1024),
      },
    );
    expect(deniedServer.status).toBe(403);
    expect((await deniedServer.json()).code).toBe("SERVER_DENIED");
    expect(noncePersist).toHaveBeenCalledTimes(2);
  });

  it("无效上传签名在占用正文解析资源前被拒绝", async () => {
    const loadPrincipal = vi.spyOn(deviceStore, "findActiveById");
    const response = await signed(
      "/files/upload?serverId=11&path=%2Ftmp%2Frejected.bin",
      {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "idempotency-key": "rejected-upload",
          "x-cloudssh-signature": "A".repeat(86),
        },
        body: Buffer.alloc(1024 * 1024),
      },
    );

    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("DEVICE_SIGNATURE_INVALID");
    expect(loadPrincipal).not.toHaveBeenCalled();
    expect(noncePersist).not.toHaveBeenCalled();
  });

  it("无效签名不会解析或补齐设备项目授权", async () => {
    const loadPrincipal = vi.spyOn(deviceStore, "findActiveById");
    const response = await signed("/servers", {
      headers: { "x-cloudssh-signature": "A".repeat(86) },
    });

    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("DEVICE_SIGNATURE_INVALID");
    expect(loadPrincipal).not.toHaveBeenCalled();
    expect(noncePersist).not.toHaveBeenCalled();
    const failure = security.listAuthFailures(1)[0];
    expect(failure).toMatchObject({
      deviceId,
      method: "GET",
      path: "/agent/v1/servers",
      errorCode: "DEVICE_SIGNATURE_INVALID",
    });
    expect(JSON.stringify(failure)).not.toContain("A".repeat(40));
  });

  it("认证失败审计不可用时保持拒绝并阻止请求进入业务路由", async () => {
    vi.spyOn(security, "recordAuthFailure").mockRejectedValueOnce(
      new Error("security store unavailable"),
    );
    const loadPrincipal = vi.spyOn(deviceStore, "findActiveById");
    const response = await signed("/servers", {
      headers: { "x-cloudssh-signature": "A".repeat(86) },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "设备认证审计暂时不可用",
      code: "AUTH_AUDIT_UNAVAILABLE",
    });
    expect(loadPrincipal).not.toHaveBeenCalled();
    expect(noncePersist).not.toHaveBeenCalled();
  });

  it("API Key 不能审批设备", async () => {
    const pair = crypto.generateKeyPairSync("ed25519");
    const pending = await registration.create(
      "Rejected API key approval",
      pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    );
    const response = await fetch(
      `${baseUrl}/agent/admin/v1/device-requests/${pending.requestId}/approve`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-auth": "api-key",
        },
        body: JSON.stringify({
          accessMode: "selected",
          projectIds: ["project-1"],
          scopes: ["sessions:read"],
          maxConcurrentSessions: 1,
        }),
      },
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "设备管理仅允许已完成验证的网页会话访问",
      code: "INTERACTIVE_SESSION_REQUIRED",
    });
    expect(
      sqlite
        .prepare("SELECT status FROM agent_device_codes WHERE request_id = ?")
        .get(pending.requestId),
    ).toEqual({ status: "pending" });
  });

  it("nonce 持久化完成前不放行设备请求", async () => {
    let releasePersist!: () => void;
    noncePersist.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releasePersist = resolve;
        }),
    );

    let responseReceived = false;
    const request = signed("/servers").then((response) => {
      responseReceived = true;
      return response;
    });
    await vi.waitFor(() => expect(noncePersist).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(responseReceived).toBe(false);

    releasePersist();
    expect((await request).status).toBe(200);
  });

  it("全部项目设备新增项目授权落盘后才允许并发请求继续", async () => {
    sqlite.exec(`
      INSERT INTO projects
        (id, team_id, owner_user_id, kind, name, slug)
        VALUES ('project-2', 'team-1', 'admin', 'team', 'Project 2', 'project-2');
      UPDATE agent_devices SET access_mode = 'all' WHERE id = '${deviceId}';
    `);
    let releasePersist!: () => void;
    const persist = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releasePersist = resolve;
        }),
    );
    const store = new SqliteAgentDeviceStore(
      sqlite,
      undefined,
      async () => ["project-1", "project-2"],
      persist,
    );

    let firstResolved = false;
    let secondResolved = false;
    const first = store.findActiveById(deviceId).then((record) => {
      firstResolved = true;
      return record;
    });
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    const second = store.findActiveById(deviceId).then((record) => {
      secondResolved = true;
      return record;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(firstResolved).toBe(false);
    expect(secondResolved).toBe(false);
    releasePersist();
    const [firstRecord, secondRecord] = await Promise.all([first, second]);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(firstRecord?.projectIds).toEqual(["project-1", "project-2"]);
    expect(secondRecord?.projectIds).toEqual(["project-1", "project-2"]);
    expect(firstRecord?.projectServiceAccountIds["project-2"]).toBeTruthy();
    expect(secondRecord?.projectServiceAccountIds).toEqual(
      firstRecord?.projectServiceAccountIds,
    );
  });

  it("动态项目授权落盘失败时回滚并允许后续重试", async () => {
    sqlite.exec(`
      INSERT INTO projects
        (id, team_id, owner_user_id, kind, name, slug)
        VALUES ('project-2', 'team-1', 'admin', 'team', 'Project 2', 'project-2');
      UPDATE agent_devices SET access_mode = 'all' WHERE id = '${deviceId}';
    `);
    const persist = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);
    const store = new SqliteAgentDeviceStore(
      sqlite,
      undefined,
      async () => ["project-1", "project-2"],
      persist,
    );

    await expect(store.findActiveById(deviceId)).rejects.toThrow("disk full");
    expect(persist).toHaveBeenCalledTimes(2);
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM agent_device_projects WHERE device_id = ? AND project_id = ?",
        )
        .get(deviceId, "project-2"),
    ).toEqual({ count: 0 });
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM service_accounts WHERE project_id = ? AND name = ?",
        )
        .get("project-2", `__device__:${deviceId}:project-2`),
    ).toEqual({ count: 0 });

    const retried = await store.findActiveById(deviceId);
    expect(persist).toHaveBeenCalledTimes(3);
    expect(retried?.projectIds).toEqual(["project-1", "project-2"]);
    expect(retried?.projectServiceAccountIds["project-2"]).toBeTruthy();
  });

  it("拒绝旧 Token、篡改正文和已撤销设备", async () => {
    const token = await fetch(`${baseUrl}/agent/v1/servers`, {
      headers: { authorization: "Bearer cssh_legacy_legacy_legacy" },
    });
    expect(token.status).toBe(401);
    expect((await token.json()).code).toBe("TOKEN_AUTH_REMOVED");

    const body = JSON.stringify({ serverId: "11" });
    const tampered = await signed("/sessions", {
      method: "POST",
      body: `${body} `,
      headers: {
        "content-type": "application/json",
        "x-cloudssh-body-sha256": sha256Hex(Buffer.from(body)),
      },
    });
    expect(tampered.status).toBeGreaterThanOrEqual(400);

    sqlite
      .prepare(
        "UPDATE agent_devices SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP WHERE id = ?",
      )
      .run(deviceId);
    const revoked = await signed("/servers");
    expect(revoked.status).toBe(401);
    expect((await revoked.json()).code).toBe("DEVICE_NOT_AUTHORIZED");
  });

  it("拒绝被篡改的方法、路径、查询参数和过期时间戳", async () => {
    const headersFor = (
      signedPath: string,
      method = "GET",
      timestamp = String(Date.now()),
    ) => {
      const nonce = crypto.randomBytes(18).toString("base64url");
      const requestId = crypto.randomUUID();
      const bodyHash = sha256Hex(Buffer.alloc(0));
      const signature = crypto
        .sign(
          null,
          Buffer.from(
            canonicalDeviceRequest({
              method,
              pathAndQuery: signedPath,
              timestamp,
              nonce,
              bodyHash,
              requestId,
            }),
          ),
          privateKey,
        )
        .toString("base64url");
      return {
        "x-cloudssh-device-id": deviceId,
        "x-cloudssh-timestamp": timestamp,
        "x-cloudssh-nonce": nonce,
        "x-cloudssh-body-sha256": bodyHash,
        "x-cloudssh-signature": signature,
        "x-request-id": requestId,
      };
    };

    const queryTampered = await fetch(`${baseUrl}/agent/v1/servers?view=two`, {
      headers: headersFor("/agent/v1/servers?view=one"),
    });
    expect((await queryTampered.json()).code).toBe("DEVICE_SIGNATURE_INVALID");

    const pathTampered = await fetch(`${baseUrl}/agent/v1/jobs`, {
      headers: headersFor("/agent/v1/servers"),
    });
    expect((await pathTampered.json()).code).toBe("DEVICE_SIGNATURE_INVALID");

    const methodTampered = await fetch(`${baseUrl}/agent/v1/servers`, {
      method: "POST",
      headers: headersFor("/agent/v1/servers", "GET"),
    });
    expect((await methodTampered.json()).code).toBe("DEVICE_SIGNATURE_INVALID");

    const expired = await fetch(`${baseUrl}/agent/v1/servers`, {
      headers: headersFor(
        "/agent/v1/servers",
        "GET",
        String(Date.now() - 6 * 60_000),
      ),
    });
    expect((await expired.json()).code).toBe("DEVICE_TIMESTAMP_EXPIRED");
  });

  it("项目管理员不能撤销包含其他项目授权的设备", async () => {
    sqlite.exec(`
      INSERT INTO users VALUES ('other-admin', 'other-admin', 'hash', 0, 0);
      INSERT INTO projects
        (id, team_id, owner_user_id, kind, name, slug)
        VALUES ('project-2', 'team-1', 'admin', 'team', 'Project 2', 'project-2');
    `);
    const pair = crypto.generateKeyPairSync("ed25519");
    const registration = new AgentDeviceRegistrationRepository(sqlite);
    const pending = await registration.create(
      "Shared device",
      pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    );
    const admin = new AgentDeviceAdminRepository(sqlite);
    const approved = await admin.approve({
      requestId: pending.requestId,
      approvedBy: "admin",
      accessMode: "selected",
      projectIds: ["project-1", "project-2"],
      scopes: ["sessions:read"],
      maxConcurrentSessions: 1,
      expiresAt: null,
    });

    expect(
      admin
        .list({
          manageableProjectIds: ["project-1"],
          isInstanceAdmin: false,
        })
        .map((device) => device.id),
    ).not.toContain(approved!.id);
    expect(
      admin
        .list({
          manageableProjectIds: [],
          isInstanceAdmin: false,
        })
        .map((device) => device.id),
    ).not.toContain(approved!.id);
    expect(
      await admin.revoke({
        deviceId: approved!.id,
        manageableProjectIds: [],
        isInstanceAdmin: false,
      }),
    ).toBe(false);
    expect(
      await admin.revoke({
        deviceId: approved!.id,
        manageableProjectIds: ["project-1"],
        isInstanceAdmin: false,
      }),
    ).toBe(false);
    expect(
      await admin.revoke({
        deviceId: approved!.id,
        manageableProjectIds: ["project-1", "project-2"],
        isInstanceAdmin: false,
      }),
    ).toBe(true);
    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS count
             FROM agent_device_projects grant_row
             JOIN service_accounts account
               ON account.id = grant_row.service_account_id
            WHERE grant_row.device_id = ? AND account.is_active = 1`,
        )
        .get(approved!.id),
    ).toEqual({ count: 0 });
  });

  it("网页审批与撤销设备均写入审计", async () => {
    const pair = crypto.generateKeyPairSync("ed25519");
    const pending = await registration.create(
      "Audited device",
      pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    );
    const approved = await fetch(
      `${baseUrl}/agent/admin/v1/device-requests/${pending.requestId}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accessMode: "selected",
          projectIds: ["project-1"],
          scopes: ["sessions:read"],
          maxConcurrentSessions: 1,
        }),
      },
    );
    expect(approved.status).toBe(201);
    const approvedBody = await approved.json();
    expect(adminPersist).toHaveBeenCalledTimes(1);
    expect(
      sqlite
        .prepare(
          "SELECT action, resource_id FROM audit_logs ORDER BY id DESC LIMIT 1",
        )
        .get(),
    ).toEqual({
      action: "approve_agent_device",
      resource_id: approvedBody.device.id,
    });

    const revoked = await fetch(
      `${baseUrl}/agent/admin/v1/devices/${approvedBody.device.id}`,
      { method: "DELETE" },
    );
    expect(revoked.status).toBe(204);
    expect(adminPersist).toHaveBeenCalledTimes(2);
    expect(
      sqlite
        .prepare(
          "SELECT action, resource_id FROM audit_logs ORDER BY id DESC LIMIT 1",
        )
        .get(),
    ).toEqual({
      action: "revoke_agent_device",
      resource_id: approvedBody.device.id,
    });

    const deniedRequest = await registration.create(
      "Denied device",
      crypto
        .generateKeyPairSync("ed25519")
        .publicKey.export({ type: "spki", format: "pem" })
        .toString(),
    );
    const denied = await fetch(
      `${baseUrl}/agent/admin/v1/device-requests/${deniedRequest.requestId}/deny`,
      { method: "POST" },
    );
    expect(denied.status).toBe(204);
    expect(adminPersist).toHaveBeenCalledTimes(3);
    expect(
      sqlite
        .prepare(
          "SELECT action, resource_id FROM audit_logs ORDER BY id DESC LIMIT 1",
        )
        .get(),
    ).toEqual({
      action: "deny_agent_device",
      resource_id: deniedRequest.requestId,
    });
  });

  it("审批持久化失败会回滚设备、项目身份和审计", async () => {
    const pair = crypto.generateKeyPairSync("ed25519");
    const pending = await registration.create(
      "Rollback device",
      pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    );
    adminPersist.mockRejectedValueOnce(new Error("disk full"));

    const response = await fetch(
      `${baseUrl}/agent/admin/v1/device-requests/${pending.requestId}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accessMode: "selected",
          projectIds: ["project-1"],
          scopes: ["sessions:read"],
          maxConcurrentSessions: 1,
        }),
      },
    );

    expect(response.status).toBe(500);
    expect(
      sqlite
        .prepare(
          `SELECT status, device_id AS deviceId
             FROM agent_device_codes WHERE request_id = ?`,
        )
        .get(pending.requestId),
    ).toEqual({ status: "pending", deviceId: null });
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM agent_devices WHERE name = ?")
        .get("Rollback device"),
    ).toEqual({ count: 0 });
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'approve_agent_device' AND resource_name = ?",
        )
        .get("Rollback device"),
    ).toEqual({ count: 0 });
  });

  it("审批持久化完成前轮询端看不到设备 ID", async () => {
    const pair = crypto.generateKeyPairSync("ed25519");
    const pending = await registration.create(
      "Delayed approval device",
      pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    );
    let releasePersist!: () => void;
    adminPersist.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releasePersist = resolve;
        }),
    );

    const approval = fetch(
      `${baseUrl}/agent/admin/v1/device-requests/${pending.requestId}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accessMode: "selected",
          projectIds: ["project-1"],
          scopes: ["sessions:read"],
          maxConcurrentSessions: 1,
        }),
      },
    );
    await vi.waitFor(() => expect(adminPersist).toHaveBeenCalledTimes(1));

    const duplicateApproval = await fetch(
      `${baseUrl}/agent/admin/v1/device-requests/${pending.requestId}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accessMode: "selected",
          projectIds: ["project-1"],
          scopes: ["sessions:read"],
          maxConcurrentSessions: 1,
        }),
      },
    );
    expect(duplicateApproval.status).toBe(404);

    const duringSave = await pollDeviceRequest(
      pending.requestId,
      pair.privateKey,
    );
    expect(duringSave.status).toBe(200);
    expect(await duringSave.json()).toEqual({ status: "pending" });

    releasePersist();
    expect((await approval).status).toBe(201);
    const afterSave = await pollDeviceRequest(
      pending.requestId,
      pair.privateKey,
    );
    expect(await afterSave.json()).toEqual(
      expect.objectContaining({ status: "approved" }),
    );
  });

  it("解析设备码写入审计且审计失败时不返回设备信息", async () => {
    const createPending = () => {
      const pair = crypto.generateKeyPairSync("ed25519");
      return registration.create(
        "Resolve audited device",
        pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      );
    };
    const pending = await createPending();
    const resolved = await fetch(
      `${baseUrl}/agent/admin/v1/device-requests/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: pending.code }),
      },
    );
    expect(resolved.status).toBe(200);
    expect(adminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "resolve_agent_device_request",
        resourceId: pending.requestId,
        success: true,
      }),
    );

    const blocked = await createPending();
    adminAudit.mockRejectedValueOnce(new Error("audit unavailable"));
    const failed = await fetch(
      `${baseUrl}/agent/admin/v1/device-requests/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: blocked.code }),
      },
    );
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({
      error: "设备管理操作失败",
      code: "DEVICE_ADMIN_ERROR",
    });
  });

  it("没有项目管理权时不能解析、拒绝或批准设备", async () => {
    const pair = crypto.generateKeyPairSync("ed25519");
    const pending = await registration.create(
      "Unauthorized device",
      pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    );
    manageableProjects = [];
    instanceAdmin = false;

    const resolved = await fetch(
      `${baseUrl}/agent/admin/v1/device-requests/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: pending.code }),
      },
    );
    expect(resolved.status).toBe(403);

    const denied = await fetch(
      `${baseUrl}/agent/admin/v1/device-requests/${pending.requestId}/deny`,
      { method: "POST" },
    );
    expect(denied.status).toBe(403);

    const approved = await fetch(
      `${baseUrl}/agent/admin/v1/device-requests/${pending.requestId}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accessMode: "all",
          projectIds: [],
          scopes: ["sessions:read"],
        }),
      },
    );
    expect(approved.status).toBe(403);
    expect(registration.get(pending.requestId)?.status).toBe("pending");
  });

  it("拒绝过长的设备显示名称", async () => {
    const pair = crypto.generateKeyPairSync("ed25519");
    const pending = await registration.create(
      "Named device",
      pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    );
    const response = await fetch(
      `${baseUrl}/agent/admin/v1/device-requests/${pending.requestId}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "x".repeat(65),
          accessMode: "selected",
          projectIds: ["project-1"],
          scopes: ["sessions:read"],
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(registration.get(pending.requestId)?.status).toBe("pending");
  });
});
