import crypto from "crypto";
import {
  getSelfUpdateHistory,
  getSelfUpdateJob,
  getSelfUpdaterStatus,
  startSelfRollback,
  startSelfUpdate,
} from "./self-updater.js";

export type {
  ActiveUpdateSource,
  UpdateMode,
  UpdaterOperation,
  UpdaterStatus,
} from "./self-updater.js";
export {
  confirmPendingSelfUpdate,
  getUpdateModeDetails,
  getUpdateMode,
  resetSelfUpdaterTestHooks,
  setSelfUpdaterTestHooks,
  setUpdateMode,
  UpdaterClientError,
} from "./self-updater.js";

export interface ApplyUpdateInput {
  targetVersion: string;
  idempotencyKey: string;
}

export interface RollbackInput {
  idempotencyKey: string;
}

/** 保留原有路由依赖的函数名，内部由数据卷运行包更新器实现。 */
export const getUpdaterStatus = getSelfUpdaterStatus;
export const startUpdate = startSelfUpdate;
export const getUpdateJob = getSelfUpdateJob;
export const getUpdaterHistory = getSelfUpdateHistory;
export const rollbackUpdate = startSelfRollback;

export function createIdempotencyKey(value: unknown): string {
  if (isValidIdempotencyKey(value)) return value;
  return crypto.randomUUID();
}

export function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(value);
}
