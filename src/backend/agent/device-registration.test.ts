import crypto from "crypto";
import type { Server } from "http";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionBroker } from "./broker.js";
import {
  AgentDeviceRegistrationRateLimiter,
  AgentDeviceRegistrationRepository,
  createAgentDeviceRegistrationRouter,
} from "./device-registration.js";
import { canonicalDeviceRequest, sha256Hex } from "./device-auth.js";
import { UnavailableJobDriver, UnavailableSessionDriver } from "./drivers.js";
import { AgentJobManager } from "./jobs.js";
import { createAgentApp } from "./routes.js";
import { AgentSecurityStore } from "./security-store.js";
import { MemoryAgentServerDirectory } from "./servers.js";
import { MemoryAgentStateStore } from "./store.js";

describe("Agent 设备注册保护", () => {
  let sqlite: Database.Database;
  let server: Server | undefined;
  let baseUrl = "";
  let publicKey: string;
  let privateKey: crypto.KeyObject;
  let security: AgentSecurityStore;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE agent_devices (
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE TABLE agent_device_codes (
        request_id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        device_name TEXT NOT NULL,
        public_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        device_id TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TEXT NOT NULL,
        resolved_at TEXT
      );
    `);
    security = new AgentSecurityStore(":memory:");
    const pair = crypto.generateKeyPairSync("ed25519");
    privateKey = pair.privateKey;
    publicKey = pair.publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
      server = undefined;
    }
    security.close();
    sqlite.close();
  });

  async function startApp(
    rateLimiter: AgentDeviceRegistrationRateLimiter,
    pollRateLimiter?: AgentDeviceRegistrationRateLimiter,
  ) {
    const state = new MemoryAgentStateStore();
    const app = createAgentApp({
      authenticate: (_req, _res, next) => next(),
      preAuthenticateUpload: (_req, _res, next) => next(),
      registration: createAgentDeviceRegistrationRouter(
        new AgentDeviceRegistrationRepository(sqlite),
        rateLimiter,
        pollRateLimiter,
        security,
      ),
      servers: new MemoryAgentServerDirectory(),
      sessions: new AgentSessionBroker(state, new UnavailableSessionDriver()),
      jobs: new AgentJobManager(state, new UnavailableJobDriver()),
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("listen failed");
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  function poll(
    requestId: string,
    forwardedFor = "198.51.100.20",
    options: {
      nonce?: string;
      signedRequestId?: string;
      timestamp?: string;
      signingKey?: crypto.KeyObject;
    } = {},
  ) {
    const pathAndQuery = `/agent/v1/auth/device-requests/${requestId}`;
    const timestamp = options.timestamp ?? String(Date.now());
    const nonce = options.nonce ?? crypto.randomBytes(18).toString("base64url");
    const signedRequestId = options.signedRequestId ?? crypto.randomUUID();
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
        options.signingKey ?? privateKey,
      )
      .toString("base64url");
    return fetch(`${baseUrl}${pathAndQuery}`, {
      headers: {
        "x-forwarded-for": forwardedFor,
        "x-cloudssh-timestamp": timestamp,
        "x-cloudssh-nonce": nonce,
        "x-cloudssh-body-sha256": bodyHash,
        "x-cloudssh-signature": signature,
        "x-request-id": signedRequestId,
      },
    });
  }

  function register(forwardedFor: string, body: Record<string, unknown>) {
    return fetch(`${baseUrl}/agent/v1/auth/device-requests`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": forwardedFor,
      },
      body: JSON.stringify(body),
    });
  }

  it("字段或公钥无效时也会提前消耗来源 IP 注册额度", async () => {
    await startApp(new AgentDeviceRegistrationRateLimiter({ maxAttempts: 2 }));
    const invalidField = await register("198.51.100.10", {
      deviceName: "",
      publicKey,
    });
    const invalidKey = await register("198.51.100.10", {
      deviceName: "Test device",
      publicKey: "not-a-public-key",
    });
    const limited = await register("198.51.100.10", {
      deviceName: "Valid device",
      publicKey,
    });

    expect(invalidField.status).toBe(400);
    expect(invalidKey.status).toBe(400);
    expect(limited.status).toBe(429);
  });

  it("只信任本机一跳代理并按最近的真实客户端地址限流", async () => {
    await startApp(new AgentDeviceRegistrationRateLimiter({ maxAttempts: 1 }));
    const nextPublicKey = () =>
      crypto
        .generateKeyPairSync("ed25519")
        .publicKey.export({ type: "spki", format: "pem" })
        .toString();
    const first = await register("192.0.2.1, 198.51.100.20", {
      deviceName: "First device",
      publicKey: nextPublicKey(),
    });
    const spoofed = await register("192.0.2.2, 198.51.100.20", {
      deviceName: "Spoofed device",
      publicKey: nextPublicKey(),
    });
    const otherClient = await register("192.0.2.2, 198.51.100.21", {
      deviceName: "Other device",
      publicKey: nextPublicKey(),
    });
    expect(first.status).toBe(201);
    expect(spoofed.status).toBe(429);
    expect(otherClient.status).toBe(201);
  });

  it("限流桶会清理过期记录且容量有上限", () => {
    const limiter = new AgentDeviceRegistrationRateLimiter({
      maxAttempts: 1,
      windowMs: 100,
      cleanupIntervalMs: 50,
      maxBuckets: 2,
    });
    expect(limiter.consume("client-1", 1_000)).toBe(true);
    expect(limiter.consume("client-2", 1_000)).toBe(true);
    expect(limiter.consume("client-3", 1_000)).toBe(true);
    expect(limiter.bucketCount).toBe(2);

    expect(limiter.consume("client-4", 1_101)).toBe(true);
    expect(limiter.bucketCount).toBe(1);
  });

  it("设备状态轮询按来源和请求指纹限制验签次数", async () => {
    await startApp(
      new AgentDeviceRegistrationRateLimiter({ maxAttempts: 5 }),
      new AgentDeviceRegistrationRateLimiter({ maxAttempts: 1 }),
    );
    const created = await register("198.51.100.20", {
      deviceName: "Polling device",
      publicKey,
    });
    const requestId = (await created.json()).request.requestId as string;

    expect((await poll(requestId)).status).toBe(200);
    expect((await poll(requestId)).status).toBe(429);
  });

  it("设备状态轮询会持久消费 nonce 并明确拒绝重放", async () => {
    await startApp(new AgentDeviceRegistrationRateLimiter());
    const created = await register("198.51.100.20", {
      deviceName: "Replay protected device",
      publicKey,
    });
    const requestId = (await created.json()).request.requestId as string;
    const signed = {
      nonce: crypto.randomBytes(18).toString("base64url"),
      signedRequestId: crypto.randomUUID(),
      timestamp: String(Date.now()),
    };

    expect((await poll(requestId, "198.51.100.20", signed)).status).toBe(200);
    const replay = await poll(requestId, "198.51.100.20", signed);
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({
      code: "DEVICE_REQUEST_REPLAYED",
    });
  });

  it("无效签名不会提前占用设备状态轮询 nonce", async () => {
    await startApp(new AgentDeviceRegistrationRateLimiter());
    const created = await register("198.51.100.20", {
      deviceName: "Signature checked device",
      publicKey,
    });
    const requestId = (await created.json()).request.requestId as string;
    const signed = {
      nonce: crypto.randomBytes(18).toString("base64url"),
      signedRequestId: crypto.randomUUID(),
      timestamp: String(Date.now()),
    };
    const impostor = crypto.generateKeyPairSync("ed25519").privateKey;

    expect(
      (
        await poll(requestId, "198.51.100.20", {
          ...signed,
          signingKey: impostor,
        })
      ).status,
    ).toBe(404);
    expect((await poll(requestId, "198.51.100.20", signed)).status).toBe(200);
  });

  it("随机或不存在的请求 ID 在数据库查询前按来源限流", async () => {
    await startApp(
      new AgentDeviceRegistrationRateLimiter({ maxAttempts: 5 }),
      new AgentDeviceRegistrationRateLimiter({ maxAttempts: 2 }),
    );

    expect((await poll("not-a-request")).status).toBe(404);
    expect((await poll(crypto.randomUUID())).status).toBe(404);
    expect((await poll(crypto.randomUUID())).status).toBe(429);
  });

  it("清理过期设备码并在发生删除时触发持久化", async () => {
    const onWrite = vi.fn(async () => undefined);
    const repository = new AgentDeviceRegistrationRepository(sqlite, onWrite);
    const expired = await repository.create("Expired device", publicKey);
    const active = await repository.create("Active device", publicKey);
    sqlite
      .prepare(
        "UPDATE agent_device_codes SET expires_at = ? WHERE request_id = ?",
      )
      .run(new Date(1_000).toISOString(), expired.requestId);
    sqlite
      .prepare(
        "UPDATE agent_device_codes SET expires_at = ? WHERE request_id = ?",
      )
      .run(new Date(3_000).toISOString(), active.requestId);
    onWrite.mockClear();

    await expect(repository.cleanupExpired(2_000)).resolves.toBe(1);
    expect(onWrite).toHaveBeenCalledTimes(1);
    expect(
      sqlite
        .prepare(
          "SELECT request_id FROM agent_device_codes ORDER BY request_id",
        )
        .all(),
    ).toEqual([{ request_id: active.requestId }]);

    onWrite.mockClear();
    await expect(repository.cleanupExpired(2_000)).resolves.toBe(0);
    expect(onWrite).not.toHaveBeenCalled();
  });

  it("已批准设备码按解决时间固定过期，不依赖首次鉴权", async () => {
    const onWrite = vi.fn(async () => undefined);
    const repository = new AgentDeviceRegistrationRepository(sqlite, onWrite);
    const approved = await repository.create("Approved device", publicKey);
    const deviceId = crypto.randomUUID();
    sqlite
      .prepare(
        `INSERT INTO agent_devices (id, fingerprint, status, last_used_at)
         SELECT ?, fingerprint, 'active', NULL
           FROM agent_device_codes WHERE request_id = ?`,
      )
      .run(deviceId, approved.requestId);
    sqlite
      .prepare(
        `UPDATE agent_device_codes
            SET status = 'approved', device_id = ?, resolved_at = ?
          WHERE request_id = ?`,
      )
      .run(deviceId, new Date(1_000).toISOString(), approved.requestId);
    onWrite.mockClear();

    const beforeRetention = 12 * 60 * 60 * 1000;
    await expect(repository.cleanupExpired(beforeRetention)).resolves.toBe(0);
    expect(onWrite).not.toHaveBeenCalled();
    expect(
      sqlite
        .prepare(
          "SELECT request_id FROM agent_device_codes WHERE request_id = ?",
        )
        .get(approved.requestId),
    ).toEqual({ request_id: approved.requestId });

    const cleanupAt = 2 * 24 * 60 * 60 * 1000;
    await expect(repository.cleanupExpired(cleanupAt)).resolves.toBe(1);
    expect(onWrite).toHaveBeenCalledTimes(1);
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM agent_device_codes").get(),
    ).toEqual({ count: 0 });
    expect(
      sqlite
        .prepare("SELECT status FROM agent_devices WHERE id = ?")
        .get(deviceId),
    ).toEqual({ status: "active" });
  });
});
