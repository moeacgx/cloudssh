import { PermissionManager } from "../utils/permission-manager.js";

export async function validateJumpHostAccess(
  jumpHosts: unknown,
  userId: string,
): Promise<"INVALID_JUMP_HOSTS" | "JUMP_HOST_ACCESS_DENIED" | null> {
  if (jumpHosts === undefined || jumpHosts === null) return null;
  if (
    !Array.isArray(jumpHosts) ||
    jumpHosts.some(
      (hop) =>
        !hop ||
        typeof hop !== "object" ||
        !Number.isSafeInteger(hop.hostId) ||
        hop.hostId <= 0,
    )
  ) {
    return "INVALID_JUMP_HOSTS";
  }

  // 保存配置时检查连接授权；连接时仍需再次检查，防止共享权限撤销后继续使用。
  for (const hostId of new Set(jumpHosts.map((hop) => hop.hostId))) {
    const access = await PermissionManager.getInstance().canAccessHost(
      userId,
      hostId,
      "connect",
    );
    if (!access.hasAccess) return "JUMP_HOST_ACCESS_DENIED";
  }
  return null;
}
