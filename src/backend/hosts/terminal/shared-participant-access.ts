export type SharedParticipantPermissionLevel = "read-only" | "read-write";

export interface SharedParticipantAccessSession {
  id: string;
  userId: string;
  hostId: number;
  projectHostId?: number;
}

export interface SharedParticipantAccessParticipant {
  userId: string | null;
  isOwner: boolean;
  joinedViaShareId?: string;
}

export interface ActiveSessionShare {
  id: string;
  hostId: number;
  ownerUserId: string;
  protocol: string;
  sessionId: string;
  shareType: string;
  targetUserId: string | null;
  permissionLevel: string;
}

export interface SharedParticipantAccessDependencies {
  findActiveShare: (shareId: string) => Promise<ActiveSessionShare | null>;
  canAccessHost: (
    userId: string,
    hostId: number,
    projectHostId?: number,
  ) => Promise<boolean>;
  isSharingEnabled: (hostId: number) => Promise<boolean>;
}

export type SharedParticipantAccessResult =
  | {
      allowed: true;
      permissionLevel: SharedParticipantPermissionLevel;
    }
  | { allowed: false };

export async function checkSharedParticipantAccess(
  session: SharedParticipantAccessSession,
  participant: SharedParticipantAccessParticipant,
  dependencies: SharedParticipantAccessDependencies,
): Promise<SharedParticipantAccessResult> {
  const shareId = participant.joinedViaShareId;
  if (participant.isOwner || !shareId) return { allowed: false };

  const share = await dependencies.findActiveShare(shareId);
  if (
    !share ||
    share.id !== shareId ||
    share.protocol !== "ssh" ||
    share.sessionId !== session.id ||
    share.hostId !== session.hostId ||
    share.ownerUserId !== session.userId ||
    (share.permissionLevel !== "read-only" &&
      share.permissionLevel !== "read-write")
  ) {
    return { allowed: false };
  }

  if (!(await dependencies.isSharingEnabled(session.hostId))) {
    return { allowed: false };
  }

  if (participant.userId === null) {
    if (share.shareType !== "link") return { allowed: false };
  } else if (
    share.shareType !== "user" ||
    share.targetUserId !== participant.userId
  ) {
    return { allowed: false };
  }

  const ownerAllowed = await dependencies.canAccessHost(
    session.userId,
    session.hostId,
    session.projectHostId,
  );
  if (!ownerAllowed) return { allowed: false };

  if (participant.userId !== null) {
    const participantAllowed = await dependencies.canAccessHost(
      participant.userId,
      session.hostId,
      session.projectHostId,
    );
    if (!participantAllowed) return { allowed: false };
  }

  return {
    allowed: true,
    permissionLevel: share.permissionLevel,
  };
}

export interface SharedParticipantAccessHeartbeatOptions {
  verifyAccess: () => Promise<boolean>;
  onAccessRevoked: () => void;
  intervalMs?: number;
}

export interface SharedParticipantAccessHeartbeat {
  stop: () => void;
}

const DEFAULT_ACCESS_CHECK_INTERVAL_MS = 30_000;

export function startSharedParticipantAccessHeartbeat(
  options: SharedParticipantAccessHeartbeatOptions,
): SharedParticipantAccessHeartbeat {
  const {
    verifyAccess,
    onAccessRevoked,
    intervalMs = DEFAULT_ACCESS_CHECK_INTERVAL_MS,
  } = options;
  let stopped = false;
  let checkInFlight: Promise<void> | null = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
  };

  const verify = () => {
    if (stopped || checkInFlight) return;
    const operation = verifyAccess()
      .catch(() => false)
      .then((allowed) => {
        if (stopped || allowed) return;
        stop();
        onAccessRevoked();
      })
      .catch(() => {})
      .finally(() => {
        if (checkInFlight === operation) checkInFlight = null;
      });
    checkInFlight = operation;
  };

  const interval = setInterval(verify, intervalMs);
  return { stop };
}
