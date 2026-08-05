import type { Request } from "express";
import { createCurrentAuditLogRepository } from "../database/repositories/factory.js";
import { apiLogger } from "./logger.js";

export interface AuditLogParams {
  userId: string;
  username: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  resourceName?: string;
  details?: string;
  ipAddress?: string;
  userAgent?: string;
  success: boolean;
  errorMessage?: string;
}

export async function logAuditOrThrow(params: AuditLogParams): Promise<void> {
  await createCurrentAuditLogRepository().create({
    userId: params.userId,
    username: params.username,
    action: params.action,
    resourceType: params.resourceType,
    resourceId: params.resourceId ?? null,
    resourceName: params.resourceName ?? null,
    details: params.details ?? null,
    ipAddress: params.ipAddress ?? null,
    userAgent: params.userAgent ?? null,
    success: params.success,
    errorMessage: params.errorMessage ?? null,
  });
}

export async function logAudit(params: AuditLogParams): Promise<void> {
  try {
    await logAuditOrThrow(params);
  } catch (error) {
    apiLogger.error("Audit log write failed", {
      operation: "audit_log_write_failed",
      action: params.action,
      resourceType: params.resourceType,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

export function getAuditActorContext(
  req: Request,
  dataOwnerUserId: string,
): { actorUserId: string; dataOwnerDetails?: string } {
  const actingAdminUserId = (req as Request & { actingAdminUserId?: unknown })
    .actingAdminUserId;
  if (
    typeof actingAdminUserId !== "string" ||
    actingAdminUserId.length === 0 ||
    actingAdminUserId === dataOwnerUserId
  ) {
    return { actorUserId: dataOwnerUserId };
  }
  return {
    actorUserId: actingAdminUserId,
    dataOwnerDetails: JSON.stringify({ dataOwnerUserId }),
  };
}

export function getRequestMeta(req: Request): {
  ipAddress: string;
  userAgent: string;
} {
  const ipAddress = req.ip || req.socket?.remoteAddress || "";
  const userAgent = (req.headers["user-agent"] as string) || "";
  return { ipAddress, userAgent };
}
