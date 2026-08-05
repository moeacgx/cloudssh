import express, {
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import type { AuthenticatedRequest, GitHubRelease } from "../../types/index.js";
import { createCurrentUserRepository } from "../database/repositories/factory.js";
import { requireSecureRecentInteractiveMfa } from "../utils/admin-sensitive-access.js";
import {
  getRequestMeta,
  logAudit,
  logAuditOrThrow,
} from "../utils/audit-logger.js";
import { apiLogger } from "../utils/logger.js";
import {
  createIdempotencyKey,
  getUpdateMode,
  getUpdateModeDetails,
  getUpdateJob,
  getUpdaterHistory,
  getUpdaterStatus,
  isValidIdempotencyKey,
  rollbackUpdate,
  setUpdateMode,
  startUpdate,
  UpdaterClientError,
  type UpdaterOperation,
} from "./updater-client.js";
import { versionFromReleaseTag } from "./version.js";

export interface UpdateRouteDependencies {
  requireAdmin: RequestHandler;
  repositoryOwner: string;
  repositoryName: string;
  resolveLocalVersion: () => string | undefined;
  compareVersions: (
    left: string | undefined,
    right: string | undefined,
  ) => number | null;
  getLatestRelease: (options?: {
    forceRefresh?: boolean;
  }) => Promise<GitHubRelease>;
  getReleaseByTag: (tag: string) => Promise<GitHubRelease>;
}

function operationPhase(
  operation: UpdaterOperation,
):
  | "checking"
  | "backing_up"
  | "pulling"
  | "restarting"
  | "verifying"
  | "rolling_back"
  | "succeeded"
  | "failed" {
  if (operation.state === "failed" || operation.phase === "failed") {
    return "failed";
  }
  if (
    operation.state === "completed" ||
    operation.state === "rolled_back" ||
    operation.phase === "completed" ||
    operation.phase === "rolled_back"
  ) {
    return "succeeded";
  }
  switch (operation.phase) {
    case "backing_up":
    case "stopping":
      return "backing_up";
    case "pulling":
      return "pulling";
    case "starting":
      return "restarting";
    case "health_check":
      return "verifying";
    case "rolling_back":
      return "rolling_back";
    default:
      return "checking";
  }
}

function publicJob(
  operation: UpdaterOperation | null | undefined,
  previousVersion?: string | null,
) {
  if (!operation) return null;
  const backupName = operation.backupArchive
    ? operation.backupArchive.split(/[\\/]/).pop() || null
    : null;
  return {
    id: operation.id,
    targetVersion:
      operation.targetVersion || previousVersion || "previous-version",
    phase: operationPhase(operation),
    progress: Number.isFinite(operation.progress)
      ? Math.max(0, Math.min(100, Math.round(operation.progress)))
      : 0,
    startedAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    finishedAt: operation.completedAt,
    message: operation.message,
    backupName,
    previousVersion: previousVersion || null,
    errorCode: operation.failureCode,
  };
}

function updaterErrorResponse(error: unknown): {
  status: number;
  body: { error: string; code: string };
} {
  if (error instanceof UpdaterClientError) {
    const unavailable =
      error.code === "UPDATER_NOT_CONFIGURED" ||
      error.code === "UPDATER_UNREACHABLE";
    const status = unavailable
      ? 503
      : error.statusCode === 409
        ? 409
        : error.statusCode && error.statusCode >= 400 && error.statusCode < 500
          ? 400
          : 502;
    return {
      status,
      body: { error: error.message, code: error.code },
    };
  }
  return {
    status: 500,
    body: { error: "更新服务发生未知错误", code: "UPDATE_INTERNAL_ERROR" },
  };
}

async function actorUsername(userId: string): Promise<string> {
  try {
    const actor = await createCurrentUserRepository().findById(userId);
    return actor?.username || userId;
  } catch {
    return userId;
  }
}

function requireStepUp(req: Request, res: Response): boolean {
  return requireSecureRecentInteractiveMfa(req as AuthenticatedRequest, res);
}

function requestIdempotencyKey(req: Request, res: Response): string | null {
  const headerKey = req.get("idempotency-key");
  const bodyKey = req.body?.idempotencyKey;
  if (
    headerKey &&
    typeof bodyKey === "string" &&
    bodyKey.length > 0 &&
    headerKey !== bodyKey
  ) {
    res.status(400).json({
      error: "请求头和请求体的幂等键不一致",
      code: "IDEMPOTENCY_KEY_CONFLICT",
    });
    return null;
  }

  const supplied = headerKey || bodyKey;
  if (supplied !== undefined && !isValidIdempotencyKey(supplied)) {
    res.status(400).json({
      error: "幂等键格式无效",
      code: "INVALID_IDEMPOTENCY_KEY",
    });
    return null;
  }
  return createIdempotencyKey(supplied);
}

async function auditMutation(input: {
  req: Request;
  userId: string;
  username: string;
  action: string;
  resourceId?: string;
  details: Record<string, unknown>;
  success: boolean;
  errorMessage?: string;
  strict?: boolean;
}): Promise<void> {
  const { ipAddress, userAgent } = getRequestMeta(input.req);
  const writer = input.strict ? logAuditOrThrow : logAudit;
  await writer({
    userId: input.userId,
    username: input.username,
    action: input.action,
    resourceType: "system_update",
    resourceId: input.resourceId,
    details: JSON.stringify(input.details),
    ipAddress,
    userAgent,
    success: input.success,
    errorMessage: input.errorMessage,
  });
}

/**
 * 管理端在线更新接口。二进制模式由主进程把公开 Release 运行包切换到
 * 数据卷；镜像模式只给出外部重建提示，主进程不接触 Docker Socket。
 */
export function createUpdateRoutes(
  dependencies: UpdateRouteDependencies,
): express.Router {
  const router = express.Router();
  router.use(dependencies.requireAdmin);

  router.get("/status", async (req, res) => {
    const currentVersion = dependencies.resolveLocalVersion() || "unknown";
    const updater = await getUpdaterStatus();
    try {
      const latest = await dependencies.getLatestRelease({
        forceRefresh: req.query.refresh === "true",
      });
      const latestVersion = versionFromReleaseTag(latest.tag_name);
      const comparison = dependencies.compareVersions(
        currentVersion,
        latestVersion || undefined,
      );
      return res.json({
        currentVersion,
        latestVersion,
        status:
          comparison === null
            ? "unknown"
            : latest.prerelease
              ? "prerelease"
              : comparison < 0
                ? "update_available"
                : "up_to_date",
        releaseUrl: latest.html_url,
        releaseName: latest.name || latest.tag_name,
        publishedAt: latest.published_at,
        updater: {
          configured: updater.configured,
          enabled: updater.available && updater.enabled !== false,
          reachable: updater.available,
          version: updater.updaterVersion || null,
          canRollback: updater.canRollback === true,
          message: updater.message || null,
          mode: updater.updateMode || "auto",
          supportedModes: updater.supportedModes || ["auto", "image", "binary"],
          activeSource: updater.activeSource || "image",
          restartRequired: updater.restartRequired === true,
        },
        activeJob: publicJob(
          updater.operation,
          updater.previous?.version || null,
        ),
        checkedAt: new Date().toISOString(),
      });
    } catch (error) {
      apiLogger.warn("Failed to load CloudSSH release metadata", {
        operation: "cloudssh_update_status_release_failed",
        error: error instanceof Error ? error.message : "unknown",
      });
      return res.json({
        currentVersion,
        latestVersion: null,
        status: "unknown",
        releaseUrl: null,
        releaseName: null,
        publishedAt: null,
        updater: {
          configured: updater.configured,
          enabled: updater.available && updater.enabled !== false,
          reachable: updater.available,
          version: updater.updaterVersion || null,
          canRollback: updater.canRollback === true,
          message: updater.message || null,
          mode: updater.updateMode || "auto",
          supportedModes: updater.supportedModes || ["auto", "image", "binary"],
          activeSource: updater.activeSource || "image",
          restartRequired: updater.restartRequired === true,
        },
        activeJob: publicJob(
          updater.operation,
          updater.previous?.version || null,
        ),
        checkedAt: new Date().toISOString(),
      });
    }
  });

  router.get("/mode", async (_req, res) => {
    return res.json(await getUpdateModeDetails(await getUpdateMode()));
  });

  const changeMode: RequestHandler = async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!requireStepUp(req, res)) return;
    const userId = authReq.userId;
    const username = await actorUsername(userId);
    try {
      await auditMutation({
        req,
        userId,
        username,
        action: "cloudssh_update_mode_change_intent",
        details: { requestedMode: req.body?.mode },
        success: true,
        strict: true,
      });
      const mode = await setUpdateMode(req.body?.mode);
      const modeDetails = await getUpdateModeDetails(mode);
      await auditMutation({
        req,
        userId,
        username,
        action: "cloudssh_update_mode_changed",
        details: { mode },
        success: true,
      });
      return res.json(modeDetails);
    } catch (error) {
      const mapped = updaterErrorResponse(error);
      await auditMutation({
        req,
        userId,
        username,
        action: "cloudssh_update_mode_change_failed",
        details: { requestedMode: req.body?.mode },
        success: false,
        errorMessage: mapped.body.code,
      });
      return res.status(mapped.status).json(mapped.body);
    }
  };
  router.put("/mode", changeMode);
  router.post("/mode", changeMode);

  router.get("/history", async (_req, res) => {
    try {
      const operations = await getUpdaterHistory(50);
      return res.json({
        jobs: operations.map((operation) => publicJob(operation)),
      });
    } catch {
      // 状态历史损坏时至少返回当前任务，不让管理面板整体失效。
      const updater = await getUpdaterStatus();
      const operation = publicJob(
        updater.operation,
        updater.previous?.version || null,
      );
      return res.json({ jobs: operation ? [operation] : [] });
    }
  });

  router.post("/apply", async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!requireStepUp(req, res)) return;

    const requestedTag =
      typeof req.body?.targetVersion === "string"
        ? req.body.targetVersion.trim()
        : typeof req.body?.releaseTag === "string"
          ? req.body.releaseTag.trim()
          : "";
    if (requestedTag && !versionFromReleaseTag(requestedTag)) {
      return res.status(400).json({
        error: "发布版本格式无效",
        code: "INVALID_RELEASE_TAG",
      });
    }

    const idempotencyKey = requestIdempotencyKey(req, res);
    if (!idempotencyKey) return;
    const userId = authReq.userId;
    const username = await actorUsername(userId);

    let release: GitHubRelease | undefined;
    try {
      if (!requestedTag) {
        release = await dependencies.getLatestRelease();
      } else {
        const requestedVersion = versionFromReleaseTag(requestedTag)!;
        const candidates = requestedTag.startsWith("release-")
          ? [requestedTag]
          : [
              `release-${requestedVersion}-tag`,
              requestedTag,
              `v${requestedVersion}`,
            ];
        for (const candidate of candidates) {
          try {
            release = await dependencies.getReleaseByTag(candidate);
            break;
          } catch {
            // GitHub Release 标签可能带 v，也可能不带；继续尝试。
          }
        }
        if (!release) throw new Error("release not found");
      }
    } catch {
      return res.status(400).json({
        error: "找不到指定的已发布版本",
        code: "RELEASE_NOT_FOUND",
      });
    }

    const targetVersion = versionFromReleaseTag(release.tag_name);
    if (!targetVersion || release.draft) {
      return res.status(400).json({
        error: "该 GitHub Release 不能用于在线更新",
        code: "RELEASE_NOT_INSTALLABLE",
      });
    }
    if (release.prerelease) {
      return res.status(400).json({
        error: "在线更新只允许正式稳定版",
        code: "PRERELEASE_NOT_ALLOWED",
      });
    }

    const localVersion = dependencies.resolveLocalVersion();
    const comparison = dependencies.compareVersions(
      localVersion,
      targetVersion,
    );
    if (comparison === null) {
      return res.status(409).json({
        error: "无法确认当前版本，已停止在线更新",
        code: "CURRENT_VERSION_UNKNOWN",
      });
    }
    if (comparison > 0) {
      return res.status(400).json({
        error: "目标版本低于当前版本；降级请使用回退功能",
        code: "DOWNGRADE_NOT_ALLOWED",
      });
    }
    if (comparison === 0) {
      return res.status(409).json({
        error: "当前已经是该版本",
        code: "ALREADY_UP_TO_DATE",
      });
    }

    const auditDetails = {
      targetVersion,
      releaseTag: release.tag_name,
      currentVersion: localVersion || "unknown",
      idempotencyKey,
    };
    try {
      // 一键更新是高风险操作：若意图审计无法落盘，则不允许切换运行包。
      await auditMutation({
        req,
        userId,
        username,
        action: "cloudssh_update_intent",
        resourceId: release.tag_name,
        details: auditDetails,
        success: true,
        strict: true,
      });

      const job = await startUpdate({
        targetVersion,
        idempotencyKey,
      });
      await auditMutation({
        req,
        userId,
        username,
        action: "cloudssh_update_queued",
        resourceId: job.id,
        details: { ...auditDetails, jobId: job.id },
        success: true,
      });
      return res.status(202).json({
        job: publicJob(job),
        idempotencyKey,
      });
    } catch (error) {
      const mapped = updaterErrorResponse(error);
      await auditMutation({
        req,
        userId,
        username,
        action: "cloudssh_update_queue_failed",
        resourceId: release.tag_name,
        details: auditDetails,
        success: false,
        errorMessage: mapped.body.code,
      });
      return res.status(mapped.status).json(mapped.body);
    }
  });

  router.get("/jobs/:jobId", async (req, res) => {
    try {
      return res.json({ job: publicJob(await getUpdateJob(req.params.jobId)) });
    } catch (error) {
      const mapped = updaterErrorResponse(error);
      return res.status(mapped.status).json(mapped.body);
    }
  });

  router.post("/rollback", async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    if (!requireStepUp(req, res)) return;

    const idempotencyKey = requestIdempotencyKey(req, res);
    if (!idempotencyKey) return;
    const userId = authReq.userId;
    const username = await actorUsername(userId);
    const details = { idempotencyKey };

    try {
      await auditMutation({
        req,
        userId,
        username,
        action: "cloudssh_rollback_intent",
        details,
        success: true,
        strict: true,
      });
      const job = await rollbackUpdate({
        idempotencyKey,
      });
      await auditMutation({
        req,
        userId,
        username,
        action: "cloudssh_rollback_queued",
        resourceId: job.id,
        details: { ...details, rollbackJobId: job.id },
        success: true,
      });
      return res.status(202).json({
        job: publicJob(job),
        idempotencyKey,
      });
    } catch (error) {
      const mapped = updaterErrorResponse(error);
      await auditMutation({
        req,
        userId,
        username,
        action: "cloudssh_rollback_queue_failed",
        details,
        success: false,
        errorMessage: mapped.body.code,
      });
      return res.status(mapped.status).json(mapped.body);
    }
  });

  return router;
}
