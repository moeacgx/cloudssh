import crypto from "crypto";
import type Database from "better-sqlite3";
import express, { type Request } from "express";
import type { AgentAuthenticatedRequest } from "./auth.js";
import {
  canonicalDeviceRequest,
  normalizeEd25519PublicKey,
  sha256Hex,
} from "./device-auth.js";
import type { AgentNonceStore } from "./device-auth.js";

const CODE_TTL_MS = 10 * 60_000;
const POLL_CLOCK_SKEW_MS = 5 * 60_000;
const POLL_NONCE_TTL_MS = 10 * 60_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_MAX_BUCKETS = 10_000;
const POLL_RATE_LIMIT_MAX_ATTEMPTS = 120;
const RESOLVED_CODE_RETENTION_MS = 24 * 60 * 60 * 1000;
const deviceRequestCommits = new Map<string, number>();

export function setAgentDeviceRequestCommit(
  requestId: string,
  active: boolean,
): void {
  const current = deviceRequestCommits.get(requestId) ?? 0;
  if (active) {
    deviceRequestCommits.set(requestId, current + 1);
  } else if (current <= 1) {
    deviceRequestCommits.delete(requestId);
  } else {
    deviceRequestCommits.set(requestId, current - 1);
  }
}

function isAgentDeviceRequestCommitActive(requestId: string): boolean {
  return (deviceRequestCommits.get(requestId) ?? 0) > 0;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

export interface AgentDeviceRegistrationRateLimiterOptions {
  maxAttempts?: number;
  windowMs?: number;
  maxBuckets?: number;
  cleanupIntervalMs?: number;
}

export class AgentDeviceRegistrationRateLimiter {
  private readonly attempts = new Map<string, RateLimitBucket>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly maxBuckets: number;
  private readonly cleanupIntervalMs: number;
  private nextCleanupAt = 0;

  constructor(options: AgentDeviceRegistrationRateLimiterOptions = {}) {
    this.maxAttempts = Math.max(
      1,
      options.maxAttempts ?? RATE_LIMIT_MAX_ATTEMPTS,
    );
    this.windowMs = Math.max(1, options.windowMs ?? RATE_LIMIT_WINDOW_MS);
    this.maxBuckets = Math.max(1, options.maxBuckets ?? RATE_LIMIT_MAX_BUCKETS);
    this.cleanupIntervalMs = Math.max(
      1,
      options.cleanupIntervalMs ?? RATE_LIMIT_WINDOW_MS,
    );
  }

  get bucketCount(): number {
    return this.attempts.size;
  }

  consume(key: string, now = Date.now()): boolean {
    this.cleanupIfDue(now);
    const bucket = this.attempts.get(key);
    if (bucket && bucket.resetAt > now) {
      if (bucket.count >= this.maxAttempts) return false;
      bucket.count += 1;
      return true;
    }

    if (bucket) this.attempts.delete(key);
    this.ensureCapacity(now);
    this.attempts.set(key, { count: 1, resetAt: now + this.windowMs });
    return true;
  }

  private cleanupIfDue(now: number): void {
    if (now < this.nextCleanupAt) return;
    this.deleteExpired(now);
    this.nextCleanupAt = now + this.cleanupIntervalMs;
  }

  private ensureCapacity(now: number): void {
    if (this.attempts.size < this.maxBuckets) return;
    this.deleteExpired(now);
    while (this.attempts.size >= this.maxBuckets) {
      const oldest = this.attempts.keys().next().value as string | undefined;
      if (!oldest) break;
      this.attempts.delete(oldest);
    }
  }

  private deleteExpired(now: number): void {
    for (const [key, bucket] of this.attempts) {
      if (bucket.resetAt <= now) this.attempts.delete(key);
    }
  }
}

function normalizedCode(value: unknown): string {
  return typeof value === "string"
    ? value.toUpperCase().replace(/[^A-Z0-9]/g, "")
    : "";
}

export function hashDeviceCode(value: unknown): string {
  const normalized = normalizedCode(value);
  return normalized.length === 8 ? sha256Hex(normalized) : "";
}

function createDeviceCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(8);
  const raw = [...bytes]
    .map((byte) => alphabet[byte % alphabet.length])
    .join("");
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export class AgentDeviceRegistrationRepository {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly onWrite?: () => void | Promise<void>,
  ) {}

  async create(deviceName: string, publicKeyValue: unknown) {
    const key = normalizeEd25519PublicKey(publicKeyValue);
    const existing = this.sqlite
      .prepare(
        "SELECT id FROM agent_devices WHERE fingerprint = ? AND status = 'active'",
      )
      .get(key.fingerprint);
    if (existing) {
      throw Object.assign(new Error("该设备密钥已经获得授权"), { status: 409 });
    }
    const requestId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
    let code = "";
    for (let attempt = 0; attempt < 10; attempt += 1) {
      code = createDeviceCode();
      try {
        this.sqlite
          .prepare(
            `INSERT INTO agent_device_codes
               (request_id, code_hash, device_name, public_key, fingerprint,
                status, expires_at)
             VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
          )
          .run(
            requestId,
            hashDeviceCode(code),
            deviceName,
            key.pem,
            key.fingerprint,
            expiresAt,
          );
        await this.onWrite?.();
        return {
          requestId,
          code,
          deviceName,
          fingerprint: key.fingerprint,
          expiresAt,
          intervalSeconds: 2,
        };
      } catch (error) {
        if (!String(error).includes("UNIQUE")) throw error;
      }
    }
    throw new Error("无法生成设备码");
  }

  get(requestId: string) {
    return this.sqlite
      .prepare(
        `SELECT request_id AS requestId, public_key AS publicKey, fingerprint,
                status, device_id AS deviceId, expires_at AS expiresAt
           FROM agent_device_codes WHERE request_id = ?`,
      )
      .get(requestId) as
      | {
          requestId: string;
          publicKey: string;
          fingerprint: string;
          status: "pending" | "approving" | "approved" | "denying" | "denied";
          deviceId: string | null;
          expiresAt: string;
        }
      | undefined;
  }

  async cleanupExpired(now = Date.now()): Promise<number> {
    const result = this.sqlite
      .prepare(
        `DELETE FROM agent_device_codes
          WHERE (status = 'pending' AND expires_at <= ?)
             OR (status = 'denied'
                 AND resolved_at IS NOT NULL AND resolved_at <= ?)
             OR (status = 'approved'
                 AND resolved_at IS NOT NULL AND resolved_at <= ?)`,
      )
      .run(
        new Date(now).toISOString(),
        new Date(now - RESOLVED_CODE_RETENTION_MS).toISOString(),
        new Date(now - RESOLVED_CODE_RETENTION_MS).toISOString(),
      );
    if (result.changes > 0) await this.onWrite?.();
    return result.changes;
  }
}

function textField(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw Object.assign(new Error(`${field} 无效`), { status: 400 });
  }
  return value.trim();
}

interface VerifiedPollRequest {
  nonce: string;
  requestTime: number;
}

function verifyPollRequest(
  req: Request,
  publicKey: string,
): VerifiedPollRequest | null {
  const timestamp = req.header("x-cloudssh-timestamp")?.trim() ?? "";
  const nonce = req.header("x-cloudssh-nonce")?.trim() ?? "";
  const bodyHash = req.header("x-cloudssh-body-sha256")?.trim() ?? "";
  const signature = req.header("x-cloudssh-signature")?.trim() ?? "";
  const idempotencyKey = req.header("idempotency-key")?.trim() ?? "";
  const requestId = req.header("x-request-id")?.trim() ?? "";
  if (
    !/^\d{13}$/.test(timestamp) ||
    Math.abs(Date.now() - Number(timestamp)) > POLL_CLOCK_SKEW_MS ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) ||
    bodyHash !== sha256Hex(Buffer.alloc(0)) ||
    !/^[A-Za-z0-9_-]{40,256}$/.test(signature) ||
    idempotencyKey.length > 0 ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)
  ) {
    return null;
  }
  const verified = crypto.verify(
    null,
    Buffer.from(
      canonicalDeviceRequest({
        method: req.method,
        pathAndQuery: req.originalUrl,
        timestamp,
        nonce,
        bodyHash,
        idempotencyKey,
        requestId,
      }),
    ),
    publicKey,
    Buffer.from(signature, "base64url"),
  );
  return verified ? { nonce, requestTime: Number(timestamp) } : null;
}

export function createAgentDeviceRegistrationRouter(
  repository: AgentDeviceRegistrationRepository,
  rateLimiter = new AgentDeviceRegistrationRateLimiter(),
  pollRateLimiter = new AgentDeviceRegistrationRateLimiter({
    maxAttempts: POLL_RATE_LIMIT_MAX_ATTEMPTS,
  }),
  pollNonceStore: AgentNonceStore,
) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.post("/device-requests", async (req, res, next) => {
    try {
      const clientAddress = req.ip || req.socket.remoteAddress || "unknown";
      if (!rateLimiter.consume(`ip:${clientAddress}`)) {
        return res.status(429).json({ error: "设备注册请求过于频繁" });
      }
      const deviceName = textField(req.body?.deviceName, "deviceName", 64);
      const normalizedKey = normalizeEd25519PublicKey(req.body?.publicKey);
      if (!rateLimiter.consume(`fingerprint:${normalizedKey.fingerprint}`)) {
        return res.status(429).json({ error: "设备注册请求过于频繁" });
      }
      const request = await repository.create(deviceName, normalizedKey.pem);
      return res.status(201).json({ request });
    } catch (error) {
      next(error);
    }
  });

  router.get("/device-requests/:requestId", async (req, res, next) => {
    try {
      const requestId = String(req.params.requestId || "");
      const clientAddress = req.ip || req.socket.remoteAddress || "unknown";
      if (!pollRateLimiter.consume(`ip:${clientAddress}`)) {
        return res.status(429).json({ error: "设备状态查询过于频繁" });
      }
      if (!/^[0-9a-f-]{36}$/i.test(requestId)) {
        return res.status(404).json({ error: "设备请求不存在" });
      }
      const pending = repository.get(requestId);
      if (!pending) {
        return res.status(404).json({ error: "设备请求不存在" });
      }
      if (
        !pollRateLimiter.consume(`request:${requestId}:${pending.fingerprint}`)
      ) {
        return res.status(429).json({ error: "设备状态查询过于频繁" });
      }
      const verified = verifyPollRequest(req, pending.publicKey);
      if (!verified) {
        return res.status(404).json({ error: "设备请求不存在" });
      }
      if (!pollNonceStore) {
        throw new Error("设备状态轮询安全存储不可用");
      }
      const nonceAccepted = await pollNonceStore.consumeNonce(
        `registration:${pending.fingerprint}`,
        verified.nonce,
        new Date(verified.requestTime + POLL_NONCE_TTL_MS).toISOString(),
      );
      if (!nonceAccepted) {
        return res.status(401).json({
          error: "设备状态查询请求已使用",
          code: "DEVICE_REQUEST_REPLAYED",
        });
      }
      if (
        Date.parse(pending.expiresAt) <= Date.now() &&
        pending.status === "pending"
      ) {
        return res.json({ status: "expired" });
      }
      if (
        isAgentDeviceRequestCommitActive(requestId) ||
        pending.status === "approving" ||
        pending.status === "denying"
      ) {
        return res.json({ status: "pending" });
      }
      return res.json({
        status: pending.status,
        deviceId: pending.status === "approved" ? pending.deviceId : undefined,
      });
    } catch (error) {
      next(error);
    }
  });

  router.use(
    (error: unknown, _req: Request, res: express.Response, _next: unknown) => {
      void _next;
      const shaped = error as { status?: number; message?: string };
      res.status(shaped.status ?? 500).json({
        error: shaped.status ? shaped.message : "设备注册失败",
        code: shaped.status
          ? "DEVICE_REQUEST_INVALID"
          : "DEVICE_REQUEST_FAILED",
      });
    },
  );
  return router;
}

export function rawBodySaver(
  req: Request,
  _res: express.Response,
  buffer: Buffer,
) {
  // body-parser 在请求生命周期内保留该缓冲区；直接引用可避免大文件上传
  // 为设备签名校验额外复制一份完整正文。
  (req as AgentAuthenticatedRequest).rawBody = buffer;
}
