import type { Client, ConnectConfig } from "ssh2";
import { statsLogger } from "../../utils/logger.js";

export interface MetricsSession {
  client: Client;
  isConnected: boolean;
  lastActive: number;
  timeout?: NodeJS.Timeout;
  activeOperations: number;
  hostId: number;
  projectHostId?: number;
  userId: string;
}

export interface PendingTOTPSession {
  client: Client;
  finish: (responses: string[]) => void;
  config: ConnectConfig;
  createdAt: number;
  sessionId: string;
  hostId: number;
  projectHostId?: number;
  userId: string;
  prompts?: Array<{ prompt: string; echo: boolean }>;
  totpPromptIndex?: number;
  resolvedPassword?: string;
  totpAttempts: number;
}

export interface MetricsViewer {
  sessionId: string;
  userId: string;
  hostId: number;
  projectHostId?: number;
  lastHeartbeat: number;
}

export const metricsSessions: Record<string, MetricsSession> =
  Object.create(null);
export const pendingTOTPSessions: Record<string, PendingTOTPSession> =
  Object.create(null);

export function cleanupMetricsSession(sessionId: string): void {
  const session = metricsSessions[sessionId];
  if (session) {
    if (session.activeOperations > 0) {
      statsLogger.warn(
        `Deferring metrics session cleanup - ${session.activeOperations} active operations`,
        {
          operation: "cleanup_deferred",
          sessionId,
          activeOperations: session.activeOperations,
        },
      );
      scheduleMetricsSessionCleanup(sessionId);
      return;
    }

    try {
      session.client.end();
    } catch {
      // expected
    }
    clearTimeout(session.timeout);
    delete metricsSessions[sessionId];
  }
}

export function scheduleMetricsSessionCleanup(sessionId: string): void {
  const session = metricsSessions[sessionId];
  if (session) {
    if (session.timeout) clearTimeout(session.timeout);

    session.timeout = setTimeout(
      () => {
        cleanupMetricsSession(sessionId);
      },
      30 * 60 * 1000,
    );
  }
}

export function cleanupExpiredPendingTOTPSessions(
  maxAgeMs = 3 * 60 * 1000,
  now = Date.now(),
): number {
  let removed = 0;
  for (const [sessionId, session] of Object.entries(pendingTOTPSessions)) {
    if (now - session.createdAt <= maxAgeMs) continue;
    try {
      session.client.end();
    } catch {
      // expected
    }
    delete pendingTOTPSessions[sessionId];
    removed += 1;
  }
  return removed;
}

export function getSessionKey(
  hostId: number,
  userId: string,
  projectHostId?: number,
): string {
  return `${userId}:${projectHostId ?? "personal"}:${hostId}`;
}
