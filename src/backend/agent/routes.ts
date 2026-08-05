import crypto from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  type Router,
} from "express";
import type { AgentAuthenticatedRequest } from "./auth.js";
import type { AgentSessionBroker } from "./broker.js";
import { AgentApiError, isAgentApiError } from "./errors.js";
import type { AgentJobManager } from "./jobs.js";
import {
  createAgentAuditMiddleware,
  markAgentOperationCommitted,
  markAgentOperationDispatched,
  type AgentAuditSink,
} from "./audit.js";
import type { AgentServerDirectory } from "./servers.js";
import {
  AGENT_FILE_LIMITS,
  type AgentFileService,
  type AgentFileTransferResult,
  type AgentFileUploadSource,
} from "./files.js";
import type {
  AgentProvisioningService,
  AgentServerCreateInput,
} from "./provisioning.js";
import type { AgentSessionRuntimeMode } from "./types.js";
import { rawBodySaver } from "./device-registration.js";
import { setAgentStreamedBodyHash } from "./device-auth.js";
import {
  isAdministrativeTransportAllowed,
  trustLoopbackProxy,
} from "../utils/trust-loopback-proxy.js";
import { createCorsMiddleware } from "../utils/cors-config.js";

function principal(req: Request) {
  const value = (req as AgentAuthenticatedRequest).agentPrincipal;
  if (!value) throw new Error("agent principal is missing");
  return value;
}

function requiredString(
  value: unknown,
  field: string,
  maxLength = 256,
): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw Object.assign(new Error(`${field} 无效`), {
      status: 400,
      code: "INVALID_INPUT",
    });
  }
  return value;
}

function requiredPayload(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    throw Object.assign(new Error(`${field} 无效`), {
      status: 400,
      code: "INVALID_INPUT",
    });
  }
  return value;
}

function integerInRange(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
  fallback?: number,
): number {
  const candidate = value === undefined ? fallback : value;
  if (
    !Number.isInteger(candidate) ||
    Number(candidate) < minimum ||
    Number(candidate) > maximum
  ) {
    throw Object.assign(
      new Error(`${field} 必须在 ${minimum}-${maximum} 之间`),
      {
        status: 400,
        code: "INVALID_INPUT",
      },
    );
  }
  return Number(candidate);
}

function idempotencyKey(req: Request): string {
  return req.get("idempotency-key")?.trim() ?? "";
}

function sessionRuntimeMode(
  value: unknown,
): AgentSessionRuntimeMode | undefined {
  if (value === undefined) return undefined;
  if (value === "platform" || value === "tmux") return value;
  throw Object.assign(new Error("runtimeMode 必须是 platform 或 tmux"), {
    status: 400,
    code: "INVALID_INPUT",
  });
}

const SERVER_CREATE_FIELDS = new Set([
  "projectId",
  "name",
  "address",
  "port",
  "username",
  "authType",
  "folder",
  "credentialId",
  "password",
  "key",
  "keyPassword",
  "keyType",
  "hostKeyFingerprint",
  "tags",
  "notes",
]);

function optionalString(
  value: unknown,
  field: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (
    typeof value !== "string" ||
    value.length > maxLength ||
    /[\0\r\n]/.test(value)
  ) {
    throw Object.assign(new Error(`${field} 无效`), {
      status: 400,
      code: "INVALID_INPUT",
    });
  }
  return value.trim() || null;
}

function secretString(
  value: unknown,
  field: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    throw Object.assign(new Error(`${field} 无效`), {
      status: 400,
      code: "INVALID_INPUT",
    });
  }
  return value;
}

function parseCreateServerInput(body: unknown): AgentServerCreateInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw Object.assign(new Error("请求正文无效"), {
      status: 400,
      code: "INVALID_INPUT",
    });
  }
  const input = body as Record<string, unknown>;
  const unknown = Object.keys(input).filter(
    (field) => !SERVER_CREATE_FIELDS.has(field),
  );
  if (unknown.length > 0) {
    throw Object.assign(new Error(`不支持的字段：${unknown.join("、")}`), {
      status: 400,
      code: "INVALID_INPUT",
    });
  }
  const projectId = requiredString(input.projectId, "projectId", 256);
  const address = requiredString(input.address, "address", 255);
  if (/\s|:\/\//.test(address)) {
    throw Object.assign(new Error("address 无效"), {
      status: 400,
      code: "INVALID_INPUT",
    });
  }
  const port = integerInRange(input.port, "port", 1, 65_535, 22);
  const username = requiredString(input.username, "username", 255);
  const authType = input.authType ?? "none";
  if (
    authType !== "none" &&
    authType !== "password" &&
    authType !== "key" &&
    authType !== "credential"
  ) {
    throw Object.assign(new Error("authType 无效"), {
      status: 400,
      code: "INVALID_INPUT",
    });
  }
  const credentialId =
    input.credentialId === undefined || input.credentialId === null
      ? null
      : requiredString(String(input.credentialId), "credentialId", 128);
  const password = secretString(input.password, "password", 16_384);
  const key = secretString(input.key, "key", 512 * 1024);
  const keyPassword = secretString(input.keyPassword, "keyPassword", 16_384);
  if (
    (authType === "credential") !== Boolean(credentialId) ||
    (authType === "password") !== Boolean(password) ||
    (authType === "key") !== Boolean(key) ||
    (authType !== "key" && keyPassword)
  ) {
    throw Object.assign(new Error("认证参数与 authType 不匹配"), {
      status: 400,
      code: "INVALID_AUTH_INPUT",
    });
  }
  const folder = optionalString(input.folder, "folder", 512);
  if (
    folder &&
    (folder.startsWith(" / ") ||
      folder.endsWith(" / ") ||
      folder.split(" / ").some((part) => !part.trim()))
  ) {
    throw Object.assign(new Error("folder 无效"), {
      status: 400,
      code: "INVALID_INPUT",
    });
  }
  const rawTags = input.tags ?? [];
  if (!Array.isArray(rawTags) || rawTags.length > 32) {
    throw Object.assign(new Error("tags 无效"), {
      status: 400,
      code: "INVALID_INPUT",
    });
  }
  const tags = [
    ...new Set(rawTags.map((tag) => requiredString(tag, "tag", 64).trim())),
  ];
  const hostKeyFingerprint = optionalString(
    input.hostKeyFingerprint,
    "hostKeyFingerprint",
    32_768,
  );
  if (
    hostKeyFingerprint &&
    !/^[a-fA-F0-9]{16,32768}$/.test(hostKeyFingerprint)
  ) {
    throw Object.assign(new Error("hostKeyFingerprint 无效"), {
      status: 400,
      code: "INVALID_INPUT",
    });
  }
  return {
    projectId,
    name:
      optionalString(input.name, "name", 128) ??
      `${username}@${address}:${port}`,
    address,
    port,
    username,
    authType,
    folder,
    credentialId,
    password,
    key,
    keyPassword,
    keyType: optionalString(input.keyType, "keyType", 64),
    hostKeyFingerprint: hostKeyFingerprint?.toLowerCase() ?? null,
    tags,
    notes: optionalString(input.notes, "notes", 4096),
  };
}

export interface AgentRouterDependencies {
  authenticate: RequestHandler;
  preAuthenticateUpload: RequestHandler;
  registration?: Router;
  servers: AgentServerDirectory;
  sessions: AgentSessionBroker;
  jobs: AgentJobManager;
  provisioning?: AgentProvisioningService;
  files?: AgentFileService;
  audit?: AgentAuditSink;
}

function requireFileService(
  dependencies: AgentRouterDependencies,
): AgentFileService {
  if (!dependencies.files) {
    throw Object.assign(new Error("文件服务当前不可用"), {
      status: 503,
      code: "FILE_SERVICE_UNAVAILABLE",
    });
  }
  return dependencies.files;
}

function queryString(
  req: Request,
  name: string,
  required = true,
): string | undefined {
  const value = req.query[name];
  if (value === undefined && !required) return undefined;
  return requiredString(value, name, 4_096);
}

function bodyString(
  body: unknown,
  name: string,
  required = true,
): string | undefined {
  if (body === undefined || body === null) {
    if (!required) return undefined;
    throw Object.assign(new Error(`${name} 无效`), {
      status: 400,
      code: "INVALID_INPUT",
    });
  }
  return requiredString(
    body && typeof body === "object" && !Buffer.isBuffer(body)
      ? (body as Record<string, unknown>)[name]
      : undefined,
    name,
    4_096,
  );
}

const requestAbortSignal = Symbol("cloudssh-request-abort-signal");
type AbortableRequest = Request & { [requestAbortSignal]?: AbortSignal };
const fileUploadRelease = Symbol("cloudssh-file-upload-release");
const stagedFileUpload = Symbol("cloudssh-staged-file-upload");
const stagedFileUploadCleanup = Symbol("cloudssh-staged-file-upload-cleanup");
const fileUploadOperationStarted = Symbol(
  "cloudssh-file-upload-operation-started",
);
type FileUploadRequest = Request & {
  [fileUploadRelease]?: () => void;
  [fileUploadOperationStarted]?: boolean;
  [stagedFileUpload]?: AgentFileUploadSource;
  [stagedFileUploadCleanup]?: () => Promise<void>;
};

const FILE_UPLOAD_RECEIVE_TIMEOUT_MS = 10 * 60_000;

function createStagedUploadLimiter(): {
  stream: Transform;
  size: () => number;
  sha256: () => string;
} {
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  let digest: string | null = null;
  const stream = new Transform({
    transform(value, _encoding, callback) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (bytes + chunk.length > AGENT_FILE_LIMITS.maxTransferBytes) {
        callback(
          new AgentApiError(413, "FILE_TOO_LARGE", "上传文件超过 64 MiB 限制"),
        );
        return;
      }
      bytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      digest = hash.digest("hex");
      callback();
    },
  });
  return {
    stream,
    size: () => bytes,
    sha256: () => {
      if (!digest) throw new Error("upload digest is not finalized");
      return digest;
    },
  };
}

async function stageFileUploadBody(req: Request, res: Response): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "cloudssh-agent-upload-"));
  const localPath = join(directory, "payload");
  let cleanupPromise: Promise<void> | undefined;
  const ignoreMissing = (error: unknown) => {
    if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error;
  };
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      await unlink(localPath).catch(ignoreMissing);
      await rmdir(directory).catch(ignoreMissing);
    })();
    return cleanupPromise;
  };
  const limiter = createStagedUploadLimiter();
  const timeout = AbortSignal.timeout(FILE_UPLOAD_RECEIVE_TIMEOUT_MS);
  try {
    await pipeline(
      req,
      limiter.stream,
      createWriteStream(localPath, { flags: "wx", mode: 0o600 }),
      { signal: timeout },
    );
  } catch (error) {
    await cleanup();
    if (timeout.aborted && !req.aborted) {
      throw new AgentApiError(408, "FILE_UPLOAD_TIMEOUT", "文件上传接收超时");
    }
    throw error;
  }

  const sha256 = limiter.sha256();
  setAgentStreamedBodyHash(req, sha256);
  const uploadRequest = req as FileUploadRequest;
  uploadRequest[stagedFileUpload] = {
    size: limiter.size(),
    sha256,
    openStream: () => createReadStream(localPath),
  };
  uploadRequest[stagedFileUploadCleanup] = cleanup;
  const cleanupBeforeOperation = () => {
    if (!uploadRequest[fileUploadOperationStarted]) {
      void cleanup().catch(() => undefined);
    }
  };
  res.once("finish", cleanupBeforeOperation);
  res.once("close", cleanupBeforeOperation);
}

function attachRequestAbortSignal(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const controller = new AbortController();
  const cleanup = () => {
    req.removeListener("aborted", onAborted);
    res.removeListener("finish", onFinished);
    res.removeListener("close", onClosed);
  };
  const onAborted = () => {
    controller.abort(new Error("客户端已断开"));
    cleanup();
  };
  const onFinished = () => cleanup();
  const onClosed = () => {
    if (!res.writableFinished) {
      controller.abort(new Error("客户端已断开"));
    }
    cleanup();
  };
  (req as AbortableRequest)[requestAbortSignal] = controller.signal;
  if (req.aborted || res.destroyed) {
    controller.abort(new Error("客户端已断开"));
  } else {
    req.once("aborted", onAborted);
    res.once("finish", onFinished);
    res.once("close", onClosed);
  }
  next();
}

function abortSignal(req: Request): AbortSignal | undefined {
  return (req as AbortableRequest)[requestAbortSignal];
}

function beginFileUploadOperation(req: Request): {
  release: () => void;
  source: AgentFileUploadSource;
  cleanup: () => Promise<void>;
} {
  const uploadRequest = req as FileUploadRequest;
  uploadRequest[fileUploadOperationStarted] = true;
  const release = uploadRequest[fileUploadRelease] ?? (() => undefined);
  const source = uploadRequest[stagedFileUpload];
  const cleanup = uploadRequest[stagedFileUploadCleanup];
  if (!source || !cleanup) {
    release();
    throw new AgentApiError(400, "INVALID_INPUT", "上传正文必须是二进制文件");
  }
  return { release, source, cleanup };
}

export function createAgentRouter(dependencies: AgentRouterDependencies) {
  const router = express.Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok", version: "v1" });
  });
  if (dependencies.registration) {
    router.use("/auth", dependencies.registration);
  }
  router.use(dependencies.authenticate);
  if (dependencies.audit) {
    router.use(createAgentAuditMiddleware(dependencies.audit));
  }
  router.use(attachRequestAbortSignal);

  router.get("/servers", async (req, res, next) => {
    try {
      res.json({ servers: await dependencies.servers.list(principal(req)) });
    } catch (error) {
      next(error);
    }
  });

  // Agent 文件 API 使用平台后端的 SFTP 凭据链；本地 Skill 只负责将
  // --local-path 对应的字节流传输到这里，正文不会被写入 Agent 对话或审计。
  router.get("/files/list", async (req, res, next) => {
    try {
      const files = requireFileService(dependencies);
      res.json({
        ...(await files.list(
          principal(req),
          queryString(req, "serverId")!,
          queryString(req, "path", false) ?? ".",
          abortSignal(req),
        )),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/files/read", async (req, res, next) => {
    try {
      const files = requireFileService(dependencies);
      res.json(
        await files.read(
          principal(req),
          queryString(req, "serverId")!,
          queryString(req, "path")!,
          abortSignal(req),
        ),
      );
    } catch (error) {
      next(error);
    }
  });

  router.get("/files/download", async (req, res, next) => {
    try {
      const files = requireFileService(dependencies);
      await files.download(
        principal(req),
        queryString(req, "serverId")!,
        queryString(req, "path")!,
        () =>
          res
            .status(200)
            .setHeader("Content-Type", "application/octet-stream")
            .setHeader("Content-Disposition", "attachment"),
        abortSignal(req),
      );
    } catch (error) {
      next(error);
    }
  });

  router.post("/files/upload", async (req, res, next) => {
    let operation: ReturnType<typeof beginFileUploadOperation> | undefined;
    let result: AgentFileTransferResult | undefined;
    let failure: unknown = null;
    try {
      operation = beginFileUploadOperation(req);
      const files = requireFileService(dependencies);
      result = await files.upload(
        principal(req),
        queryString(req, "serverId")!,
        queryString(req, "path")!,
        operation.source,
        idempotencyKey(req),
        abortSignal(req),
        () => markAgentOperationCommitted(req),
        () => markAgentOperationDispatched(req),
      );
    } catch (error) {
      failure = error;
    } finally {
      if (operation) {
        try {
          await operation.cleanup();
        } catch (error) {
          failure ??= error;
        } finally {
          operation.release();
        }
      }
    }
    // 先完成 SFTP/临时文件清理并释放并发配额，再发送结果或进入错误
    // 中间件；客户端断开时也不能让异常响应流程延迟资源回收。
    if (failure) {
      next(failure);
      return;
    }
    if (!result) {
      next(new Error("file upload result is missing"));
      return;
    }
    res.status(201).json({ file: result });
  });

  router.post("/files/mkdir", async (req, res, next) => {
    try {
      const files = requireFileService(dependencies);
      const result = await files.mkdir(
        principal(req),
        bodyString(req.body, "serverId")!,
        bodyString(req.body, "path")!,
        req.body?.recursive === true,
        idempotencyKey(req),
        abortSignal(req),
        () => markAgentOperationCommitted(req),
        () => markAgentOperationDispatched(req),
      );
      res.status(201).json({ directory: result });
    } catch (error) {
      next(error);
    }
  });

  router.post("/files/rename", async (req, res, next) => {
    try {
      const files = requireFileService(dependencies);
      const result = await files.rename(
        principal(req),
        bodyString(req.body, "serverId")!,
        bodyString(req.body, "sourcePath")!,
        bodyString(req.body, "destinationPath")!,
        idempotencyKey(req),
        abortSignal(req),
        () => markAgentOperationCommitted(req),
        () => markAgentOperationDispatched(req),
      );
      res.json({ file: result });
    } catch (error) {
      next(error);
    }
  });

  router.post("/files/delete", async (req, res, next) => {
    try {
      const files = requireFileService(dependencies);
      const result = await files.delete(
        principal(req),
        bodyString(req.body, "serverId")!,
        bodyString(req.body, "path")!,
        req.body?.recursive === true,
        idempotencyKey(req),
        abortSignal(req),
        () => markAgentOperationCommitted(req),
        () => markAgentOperationDispatched(req),
      );
      res.json({ file: result });
    } catch (error) {
      next(error);
    }
  });

  router.get("/projects", async (req, res, next) => {
    try {
      if (!dependencies.provisioning) {
        throw Object.assign(new Error("主机创建服务不可用"), {
          status: 503,
          code: "PROVISIONING_UNAVAILABLE",
        });
      }
      res.json({
        projects: await dependencies.provisioning.listProjects(principal(req)),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/projects/:projectId/folders", async (req, res, next) => {
    try {
      if (!dependencies.provisioning) {
        throw Object.assign(new Error("主机创建服务不可用"), {
          status: 503,
          code: "PROVISIONING_UNAVAILABLE",
        });
      }
      res.json({
        folders: await dependencies.provisioning.listFolders(
          principal(req),
          requiredString(req.params.projectId, "projectId", 256),
        ),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/projects/:projectId/credentials", async (req, res, next) => {
    try {
      if (!dependencies.provisioning) {
        throw Object.assign(new Error("主机创建服务不可用"), {
          status: 503,
          code: "PROVISIONING_UNAVAILABLE",
        });
      }
      res.json({
        credentials: await dependencies.provisioning.listCredentials(
          principal(req),
          requiredString(req.params.projectId, "projectId", 256),
        ),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/servers", async (req, res, next) => {
    try {
      if (!dependencies.provisioning) {
        throw Object.assign(new Error("主机创建服务不可用"), {
          status: 503,
          code: "PROVISIONING_UNAVAILABLE",
        });
      }
      const server = await dependencies.provisioning.createServer(
        principal(req),
        parseCreateServerInput(req.body),
        idempotencyKey(req),
      );
      markAgentOperationCommitted(req);
      res.status(201).json({ server });
    } catch (error) {
      next(error);
    }
  });

  router.post("/quick-connections", async (req, res, next) => {
    try {
      if (!dependencies.provisioning) {
        throw Object.assign(new Error("主机创建服务不可用"), {
          status: 503,
          code: "PROVISIONING_UNAVAILABLE",
        });
      }
      const connection = await dependencies.provisioning.createQuickConnection(
        principal(req),
        parseCreateServerInput(req.body),
        idempotencyKey(req),
      );
      markAgentOperationCommitted(req);
      res.status(201).json({ connection });
    } catch (error) {
      next(error);
    }
  });

  router.post("/sessions", async (req, res, next) => {
    try {
      const pinned = req.body?.pinned === true;
      const result = await dependencies.sessions.create(
        principal(req),
        {
          serverId: requiredString(req.body?.serverId, "serverId", 128),
          cols: integerInRange(req.body?.cols, "cols", 20, 500, 120),
          rows: integerInRange(req.body?.rows, "rows", 5, 300, 30),
          pinned,
          runtimeMode: sessionRuntimeMode(req.body?.runtimeMode),
        },
        idempotencyKey(req),
      );
      markAgentOperationCommitted(req);
      res.status(201).json({ session: result });
    } catch (error) {
      next(error);
    }
  });

  router.get("/sessions", async (req, res, next) => {
    try {
      res.json({ sessions: await dependencies.sessions.list(principal(req)) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/sessions/:sessionId/status", async (req, res, next) => {
    try {
      res.json({
        session: await dependencies.sessions.status(
          principal(req),
          String(req.params.sessionId),
        ),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/sessions/:sessionId/attach", async (req, res, next) => {
    try {
      const mode = req.body?.mode ?? "read-only";
      if (mode !== "read-only" && mode !== "read-write") {
        throw Object.assign(new Error("mode 无效"), {
          status: 400,
          code: "INVALID_INPUT",
        });
      }
      const result = await dependencies.sessions.attach(
        principal(req),
        String(req.params.sessionId),
        mode,
        req.body?.takeover === true,
        idempotencyKey(req),
      );
      markAgentOperationCommitted(req);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get("/sessions/:sessionId/read", async (req, res, next) => {
    try {
      const cursor =
        typeof req.query.cursor === "string" ? req.query.cursor : undefined;
      const limit = req.query.limitBytes
        ? integerInRange(Number(req.query.limitBytes), "limitBytes", 1, 262_144)
        : undefined;
      const attachmentId =
        req.query.attachmentId === undefined
          ? undefined
          : requiredString(req.query.attachmentId, "attachmentId", 128);
      res.json(
        await dependencies.sessions.read(
          principal(req),
          String(req.params.sessionId),
          cursor,
          limit,
          attachmentId,
        ),
      );
    } catch (error) {
      next(error);
    }
  });

  router.post("/sessions/:sessionId/write", async (req, res, next) => {
    try {
      const result = await dependencies.sessions.write(
        principal(req),
        String(req.params.sessionId),
        requiredString(req.body?.attachmentId, "attachmentId", 128),
        requiredString(req.body?.leaseId, "leaseId", 128),
        requiredPayload(req.body?.data, "data", 1024 * 1024),
        idempotencyKey(req),
      );
      markAgentOperationCommitted(req);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/sessions/:sessionId/resize", async (req, res, next) => {
    try {
      const session = await dependencies.sessions.resize(
        principal(req),
        String(req.params.sessionId),
        requiredString(req.body?.attachmentId, "attachmentId", 128),
        requiredString(req.body?.leaseId, "leaseId", 128),
        integerInRange(req.body?.cols, "cols", 20, 500),
        integerInRange(req.body?.rows, "rows", 5, 300),
      );
      markAgentOperationCommitted(req);
      res.json({
        session,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/sessions/:sessionId/detach", async (req, res, next) => {
    try {
      const result = await dependencies.sessions.detach(
        principal(req),
        String(req.params.sessionId),
        requiredString(req.body?.attachmentId, "attachmentId", 128),
      );
      markAgentOperationCommitted(req);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/sessions/:sessionId/close", async (req, res, next) => {
    try {
      const session = await dependencies.sessions.close(
        principal(req),
        String(req.params.sessionId),
      );
      markAgentOperationCommitted(req);
      res.json({
        session,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/jobs", async (req, res, next) => {
    try {
      const job = await dependencies.jobs.create(
        principal(req),
        {
          serverId: requiredString(req.body?.serverId, "serverId", 128),
          command: requiredString(req.body?.command, "command", 64 * 1024),
          timeoutMs: integerInRange(
            req.body?.timeoutMs,
            "timeoutMs",
            1_000,
            15 * 60 * 1000,
            30_000,
          ),
        },
        idempotencyKey(req),
      );
      markAgentOperationCommitted(req);
      res.status(202).json({ job });
    } catch (error) {
      next(error);
    }
  });

  router.get("/jobs", async (req, res, next) => {
    try {
      res.json({ jobs: await dependencies.jobs.list(principal(req)) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/jobs/:jobId", async (req, res, next) => {
    try {
      res.json({
        job: await dependencies.jobs.status(
          principal(req),
          String(req.params.jobId),
        ),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/jobs/:jobId/cancel", async (req, res, next) => {
    try {
      const job = await dependencies.jobs.cancel(
        principal(req),
        String(req.params.jobId),
      );
      markAgentOperationCommitted(req);
      res.json({
        job,
      });
    } catch (error) {
      next(error);
    }
  });

  router.use(
    (error: unknown, _req: Request, res: Response, next: NextFunction) => {
      if (res.headersSent || res.destroyed) {
        next(error);
        return;
      }
      if (isAgentApiError(error)) {
        res
          .status(error.status)
          .json({ error: error.message, code: error.code });
        return;
      }
      const shaped = error as {
        status?: number;
        code?: string;
        message?: string;
      };
      res.status(shaped.status ?? 500).json({
        error: shaped.status ? shaped.message : "Agent API 内部错误",
        code: shaped.code ?? "INTERNAL_ERROR",
      });
    },
  );

  return router;
}

export function createAgentApp(dependencies: AgentRouterDependencies) {
  const app = express();
  const activeFileUploadsByDevice = new Map<string, number>();
  let activeFileUploads = 0;
  app.disable("x-powered-by");
  // Agent API 只接受本机反向代理提供的一跳客户端地址。
  app.set("trust proxy", trustLoopbackProxy);
  app.use(createCorsMiddleware());
  // 传输安全校验必须早于设备预认证和任何正文解析，避免在不安全连接上
  // 消费 nonce 或缓冲请求数据。
  app.use("/agent/v1", (req, res, next) => {
    if (req.path === "/health" || isAdministrativeTransportAllowed(req)) {
      next();
      return;
    }
    res.status(426).json({
      error: "Agent API 在生产环境中必须使用 HTTPS",
      code: "HTTPS_REQUIRED",
    });
  });
  // 大文件上传必须先完成设备签名预认证，之后才占并发名额并解析正文。
  // 完整鉴权仍会在路由内核对正文哈希，并再次确认设备未被撤销。
  app.post(
    "/agent/v1/files/upload",
    (req, res, next) => {
      if (!req.is("application/octet-stream")) {
        res.status(415).json({
          error: "文件上传必须使用 application/octet-stream",
          code: "UNSUPPORTED_MEDIA_TYPE",
        });
        return;
      }
      const contentLength = req.get("content-length")?.trim();
      if (contentLength && !/^\d+$/.test(contentLength)) {
        res.status(400).json({
          error: "Content-Length 无效",
          code: "INVALID_CONTENT_LENGTH",
        });
        return;
      }
      const declaredSize = contentLength ? Number(contentLength) : undefined;
      if (
        declaredSize !== undefined &&
        (!Number.isSafeInteger(declaredSize) ||
          declaredSize > AGENT_FILE_LIMITS.maxTransferBytes)
      ) {
        res.status(413).json({
          error: "上传文件超过 64 MiB 限制",
          code: "FILE_TOO_LARGE",
        });
        return;
      }
      next();
    },
    dependencies.preAuthenticateUpload,
    (req, res, next) => {
      const deviceId = req.get("x-cloudssh-device-id")?.trim() ?? "";
      const activeDeviceUploads = activeFileUploadsByDevice.get(deviceId) ?? 0;
      if (
        activeFileUploads >= AGENT_FILE_LIMITS.maxConcurrentUploads ||
        activeDeviceUploads >= AGENT_FILE_LIMITS.maxConcurrentUploadsPerDevice
      ) {
        res.status(429).json({
          error: "同时上传的文件过多，请稍后重试",
          code: "FILE_UPLOAD_CONCURRENCY_EXCEEDED",
        });
        return;
      }
      activeFileUploads += 1;
      activeFileUploadsByDevice.set(deviceId, activeDeviceUploads + 1);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        req.removeListener("aborted", releaseBeforeOperation);
        res.removeListener("close", releaseBeforeOperation);
        res.removeListener("finish", release);
        activeFileUploads = Math.max(0, activeFileUploads - 1);
        const remainingDeviceUploads =
          (activeFileUploadsByDevice.get(deviceId) ?? 1) - 1;
        if (remainingDeviceUploads > 0) {
          activeFileUploadsByDevice.set(deviceId, remainingDeviceUploads);
        } else {
          activeFileUploadsByDevice.delete(deviceId);
        }
      };
      const releaseBeforeOperation = () => {
        if (!(req as FileUploadRequest)[fileUploadOperationStarted]) release();
      };
      (req as FileUploadRequest)[fileUploadRelease] = release;
      req.once("aborted", releaseBeforeOperation);
      res.once("finish", release);
      res.once("close", releaseBeforeOperation);
      next();
    },
    async (req, res, next) => {
      try {
        await stageFileUploadBody(req, res);
        next();
      } catch (error) {
        next(error);
      }
    },
  );
  // 文件上传已流式落盘并计算签名摘要。其它端点最多解析 1 MiB JSON，
  // 避免在设备完整鉴权前缓冲任意二进制正文。
  app.use(express.json({ limit: "1mb", verify: rawBodySaver }));
  app.use("/agent/v1", createAgentRouter(dependencies));
  return app;
}
