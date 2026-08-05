import { AxiosError } from "axios";
import { authApi, handleApiError } from "@/main-axios";

export type UpdatePhase =
  | "idle"
  | "checking"
  | "backing_up"
  | "pulling"
  | "restarting"
  | "verifying"
  | "rolling_back"
  | "succeeded"
  | "failed";

export type UpdateMode = "auto" | "image" | "binary";

export interface UpdateJob {
  id: string;
  targetVersion: string;
  phase: UpdatePhase;
  progress: number;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string | null;
  message?: string | null;
  backupName?: string | null;
  previousVersion?: string | null;
  errorCode?: string | null;
}

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  status: "up_to_date" | "update_available" | "prerelease" | "unknown";
  releaseUrl: string | null;
  releaseName: string | null;
  publishedAt: string | null;
  updater: {
    configured: boolean;
    enabled: boolean;
    reachable: boolean;
    version: string | null;
    canRollback: boolean;
    message: string | null;
    mode: UpdateMode;
    supportedModes: UpdateMode[];
    activeSource: "image" | "binary";
    restartRequired: boolean;
  };
  activeJob: UpdateJob | null;
  checkedAt: string;
}

export interface UpdateHistoryResponse {
  jobs: UpdateJob[];
}

const updatePhases = new Set<UpdatePhase>([
  "idle",
  "checking",
  "backing_up",
  "pulling",
  "restarting",
  "verifying",
  "rolling_back",
  "succeeded",
  "failed",
]);

const updateStatuses = new Set<UpdateStatus["status"]>([
  "up_to_date",
  "update_available",
  "prerelease",
  "unknown",
]);

const updateModes = new Set<UpdateMode>(["auto", "image", "binary"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOr(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeUpdateJob(value: unknown): UpdateJob | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;

  const phase = updatePhases.has(value.phase as UpdatePhase)
    ? (value.phase as UpdatePhase)
    : "failed";
  const rawProgress =
    typeof value.progress === "number" && Number.isFinite(value.progress)
      ? value.progress
      : 0;

  return {
    id: value.id,
    targetVersion: stringOr(value.targetVersion),
    phase,
    progress: Math.min(100, Math.max(0, rawProgress)),
    startedAt: stringOr(value.startedAt),
    updatedAt: stringOr(value.updatedAt),
    finishedAt: nullableString(value.finishedAt),
    message: nullableString(value.message),
    backupName: nullableString(value.backupName),
    previousVersion: nullableString(value.previousVersion),
    errorCode: nullableString(value.errorCode),
  };
}

export function normalizeUpdateStatus(value: unknown): UpdateStatus {
  const source = isRecord(value) ? value : {};
  const updater = isRecord(source.updater) ? source.updater : {};
  const status = updateStatuses.has(source.status as UpdateStatus["status"])
    ? (source.status as UpdateStatus["status"])
    : "unknown";

  return {
    currentVersion: stringOr(source.currentVersion, "unknown"),
    latestVersion: nullableString(source.latestVersion),
    status,
    releaseUrl: nullableString(source.releaseUrl),
    releaseName: nullableString(source.releaseName),
    publishedAt: nullableString(source.publishedAt),
    updater: {
      configured: updater.configured === true,
      enabled: updater.enabled === true,
      reachable: updater.reachable === true,
      version: nullableString(updater.version),
      canRollback: updater.canRollback === true,
      message: nullableString(updater.message),
      mode: updateModes.has(updater.mode as UpdateMode)
        ? (updater.mode as UpdateMode)
        : "auto",
      supportedModes: Array.isArray(updater.supportedModes)
        ? updater.supportedModes.filter((mode): mode is UpdateMode =>
            updateModes.has(mode as UpdateMode),
          )
        : ["auto", "image", "binary"],
      activeSource: updater.activeSource === "binary" ? "binary" : "image",
      restartRequired: updater.restartRequired === true,
    },
    activeJob: normalizeUpdateJob(source.activeJob),
    checkedAt: stringOr(source.checkedAt),
  };
}

export async function setCloudsshUpdateMode(mode: UpdateMode): Promise<{
  mode: UpdateMode;
  supportedModes: UpdateMode[];
  activeSource: "image" | "binary";
  restartRequired: boolean;
}> {
  try {
    const response = await authApi.put("/admin/updates/mode", { mode });
    const data = isRecord(response.data) ? response.data : {};
    const normalizedMode = updateModes.has(data.mode as UpdateMode)
      ? (data.mode as UpdateMode)
      : mode;
    return {
      mode: normalizedMode,
      supportedModes: Array.isArray(data.supportedModes)
        ? data.supportedModes.filter((item): item is UpdateMode =>
            updateModes.has(item as UpdateMode),
          )
        : ["auto", "image", "binary"],
      activeSource: data.activeSource === "binary" ? "binary" : "image",
      restartRequired: data.restartRequired === true,
    };
  } catch (error) {
    return rethrow(error, "change CloudSSH update mode");
  }
}

export function normalizeUpdateHistory(value: unknown): UpdateHistoryResponse {
  const source = isRecord(value) ? value : {};
  const jobs = Array.isArray(source.jobs) ? source.jobs : [];
  return {
    jobs: jobs
      .map((job) => normalizeUpdateJob(job))
      .filter((job): job is UpdateJob => job !== null),
  };
}

function rethrow(error: unknown, operation: string): never {
  // 在线更新和回退要求近期 MFA。这里保留控制面返回的明确原因，避免把
  // “请重新完成二次验证”误报成“登录已失效”。
  handleApiError(error as AxiosError, operation, {
    preserveAuthErrorMessage: true,
  });
  throw error;
}

export async function getUpdateStatus(
  forceRefresh = false,
): Promise<UpdateStatus> {
  try {
    const response = await authApi.get("/admin/updates/status", {
      params: forceRefresh ? { refresh: "true" } : undefined,
    });
    return normalizeUpdateStatus(response.data);
  } catch (error) {
    return rethrow(error, "fetch update status");
  }
}

export async function getUpdateHistory(): Promise<UpdateHistoryResponse> {
  try {
    const response = await authApi.get("/admin/updates/history");
    return normalizeUpdateHistory(response.data);
  } catch (error) {
    return rethrow(error, "fetch update history");
  }
}

export async function startCloudsshUpdate(
  targetVersion: string,
  idempotencyKey: string,
): Promise<{ job: UpdateJob }> {
  try {
    const response = await authApi.post(
      "/admin/updates/apply",
      { targetVersion },
      { headers: { "Idempotency-Key": idempotencyKey } },
    );
    return response.data as { job: UpdateJob };
  } catch (error) {
    return rethrow(error, "start CloudSSH update");
  }
}

export async function rollbackCloudsshUpdate(
  idempotencyKey: string,
): Promise<{ job: UpdateJob }> {
  try {
    const response = await authApi.post(
      "/admin/updates/rollback",
      {},
      { headers: { "Idempotency-Key": idempotencyKey } },
    );
    return response.data as { job: UpdateJob };
  } catch (error) {
    return rethrow(error, "rollback CloudSSH update");
  }
}
