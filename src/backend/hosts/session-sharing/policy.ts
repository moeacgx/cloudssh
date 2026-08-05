import {
  createCurrentHostResolutionRepository,
  createCurrentSettingsRepository,
} from "../../database/repositories/factory.js";

export async function getSessionSharingPolicy(hostId: number): Promise<{
  enabled: boolean;
  hostOwnerId: string | null;
}> {
  const globalEnabled = await createCurrentSettingsRepository().getBoolean(
    "session_sharing_globally_enabled",
    true,
  );
  if (!globalEnabled) return { enabled: false, hostOwnerId: null };

  const hostResolutionRepository = createCurrentHostResolutionRepository();
  const hostOwnerId = await hostResolutionRepository.findHostOwnerId(hostId);
  if (!hostOwnerId) return { enabled: false, hostOwnerId: null };

  const host = await hostResolutionRepository.findHostById(hostId, hostOwnerId);
  return {
    enabled: Boolean(host && host.allowSessionSharing !== false),
    hostOwnerId,
  };
}
