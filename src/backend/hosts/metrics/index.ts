import express from "express";
import net from "net";
import crypto from "crypto";
import { createCorsMiddleware } from "../../utils/cors-config.js";
import cookieParser from "cookie-parser";
import { Client, type ConnectConfig } from "ssh2";
import { SSH_ALGORITHMS } from "../../utils/ssh-algorithms.js";
import {
  pickResolvedPassword,
  pickResolvedUsername,
} from "../credential-username.js";
import {
  getCurrentSettingValue,
  createCurrentHostMetricsHistoryRepository,
  createCurrentHostResolutionRepository,
} from "../../database/repositories/factory.js";
import { statsLogger } from "../../utils/logger.js";
import { DataCrypto } from "../../utils/data-crypto.js";
import { AuthManager } from "../../utils/auth-manager.js";
import { PermissionManager } from "../../utils/permission-manager.js";
import type { AuthenticatedRequest, ProxyNode } from "../../../types/index.js";
import type {
  LogEntry,
  ConnectionStage,
} from "../../../types/connection-log.js";
import { collectCpuMetrics } from "./widgets/cpu-collector.js";
import { collectMemoryMetrics } from "./widgets/memory-collector.js";
import { collectDiskMetrics } from "./widgets/disk-collector.js";
import { collectNetworkMetrics } from "./widgets/network-collector.js";
import { collectUptimeMetrics } from "./widgets/uptime-collector.js";
import { collectProcessesMetrics } from "./widgets/processes-collector.js";
import { collectSystemMetrics } from "./widgets/system-collector.js";
import { collectLoginStats } from "./widgets/login-stats-collector.js";
import { collectPortsMetrics } from "./widgets/ports-collector.js";
import { collectFirewallMetrics } from "./widgets/firewall-collector.js";
import { collectTemperatureMetrics } from "./widgets/temperature-collector.js";
import {
  createSocks5Connection,
  type SOCKS5Config,
} from "../../utils/socks5-helper.js";
import { preparePrivateKeyForSSH2 } from "../../utils/ssh-key-utils.js";
import { SSHHostKeyVerifier } from "../host-key-verifier.js";
import { connectionPool, withConnection } from "../ssh-connection-pool.js";
import { registerHostMetricsSettingsRoutes } from "./settings-routes.js";
import { registerHostMetricsViewerRoutes } from "./viewer-routes.js";
import { registerHostMetricsPreferencesRoutes } from "./preferences-routes.js";
import { registerHostMetricsHistoryRoutes } from "./history-routes.js";
import { AlertEngine } from "./alert-engine.js";
import { registerManagerRoutes } from "./managers/index.js";
import { resolveSshConnectConfigHost } from "../ssh-dns.js";
import { AccessDeniedError } from "./managers/route-helpers.js";
import type { ManagerHost } from "./managers/types.js";
import { createJumpHostChain } from "../jump-host-chain.js";
import {
  isTcpPingEnabled,
  supportsMetrics,
  tcpPingThroughJumpHost,
} from "./helpers.js";
import { createConnectionLog } from "../connection-log.js";
import {
  cleanupExpiredPendingTOTPSessions,
  cleanupMetricsSession,
  getSessionKey,
  metricsSessions,
  pendingTOTPSessions,
  scheduleMetricsSessionCleanup,
  type MetricsViewer,
} from "./sessions.js";
import {
  authFailureTracker,
  hostPollCache,
  metricsCache,
  metricsPollLimiter,
  pollingBackoff,
  requestQueue,
  statusPollLimiter,
} from "./state.js";
import {
  closeHttpServer,
  shutdownCleanupRegistry,
} from "../../utils/shutdown-coordinator.js";
import { resolveHostById } from "../host-resolver.js";
import { parseProjectHostId } from "./project-context.js";

const authManager = AuthManager.getInstance();
const permissionManager = PermissionManager.getInstance();

type HostStatus = "online" | "offline";

interface SSHHostWithCredentials {
  id: number;
  projectHostId?: number;
  accessUserId?: string;
  name: string;
  ip: string;
  port: number;
  username: string;
  folder: string;
  tags: string[];
  pin: boolean;
  authType: string;
  password?: string;
  key?: string;
  keyPassword?: string;
  keyType?: string;
  sudoPassword?: string;
  credentialId?: number;
  enableTerminal: boolean;
  enableTunnel: boolean;
  enableFileManager: boolean;
  defaultPath: string;
  tunnelConnections: unknown[];
  jumpHosts?: Array<{ hostId: number }>;
  statsConfig?: string | StatsConfig;
  createdAt: string;
  updatedAt: string;
  userId: string;

  useSocks5?: boolean;
  socks5Host?: string;
  socks5Port?: number;
  socks5Username?: string;
  socks5Password?: string;
  socks5ProxyChain?: ProxyNode[];
  connectionType?: "ssh" | "rdp" | "vnc" | "telnet";
  rdpPort?: number;
  vncPort?: number;
  telnetPort?: number;
  vaultProfile?: { id?: number | null } | null;
}

type StatusEntry = {
  status: HostStatus;
  lastChecked: string;
};

interface StatsConfig {
  enabledWidgets: string[];
  statusCheckEnabled: boolean;
  statusCheckInterval: number;
  useGlobalStatusInterval?: boolean;
  metricsEnabled: boolean;
  metricsInterval: number;
  useGlobalMetricsInterval?: boolean;
  disableTcpPing?: boolean;
}

const DEFAULT_STATS_CONFIG: StatsConfig = {
  enabledWidgets: [
    "cpu",
    "memory",
    "disk",
    "network",
    "uptime",
    "system",
    "login_stats",
    "processes",
    "ports",
    "firewall",
    "temperature",
  ],
  statusCheckEnabled: true,
  statusCheckInterval: 60,
  metricsEnabled: true,
  metricsInterval: 30,
};

type PollingScopeKey = string;

function getPollingScopeKey(
  hostId: number,
  userId: string,
  projectHostId?: number,
): PollingScopeKey {
  return `${userId}:${projectHostId ?? "personal"}:${hostId}`;
}

function getHostAccessUserId(
  host: SSHHostWithCredentials,
  viewerUserId?: string,
): string {
  return viewerUserId ?? host.accessUserId ?? host.userId;
}

function getHostPollingScopeKey(
  host: SSHHostWithCredentials,
  viewerUserId?: string,
): PollingScopeKey {
  return getPollingScopeKey(
    host.id,
    getHostAccessUserId(host, viewerUserId),
    host.projectHostId,
  );
}

interface HostPollingConfig {
  host: SSHHostWithCredentials;
  statsConfig: StatsConfig;
  statusTimer?: NodeJS.Timeout;
  metricsTimer?: NodeJS.Timeout;
  viewerUserId?: string;
}

class PollingManager {
  private pollingConfigs = new Map<PollingScopeKey, HostPollingConfig>();
  private statusStore = new Map<PollingScopeKey, StatusEntry>();
  private metricsStore = new Map<
    PollingScopeKey,
    {
      data: Awaited<ReturnType<typeof collectMetrics>>;
      timestamp: number;
    }
  >();
  private activeViewers = new Map<PollingScopeKey, Set<string>>();
  private viewerDetails = new Map<string, MetricsViewer>();
  private viewerCleanupInterval: NodeJS.Timeout;
  /** Skip stacking another status/metrics poll while one is already running. */
  private statusInFlight = new Set<PollingScopeKey>();
  private metricsInFlight = new Set<PollingScopeKey>();

  constructor() {
    this.viewerCleanupInterval = setInterval(() => {
      this.cleanupInactiveViewers();
      cleanupExpiredPendingTOTPSessions();
    }, 60000);
  }

  /** Spread timers so N hosts do not fire on the same wall-clock second. */
  private intervalWithJitter(intervalMs: number, hostId: number): number {
    const spread = Math.min(intervalMs * 0.2, 15_000);
    const jitter = (hostId * 1103515245) % Math.max(1, Math.floor(spread));
    return intervalMs + jitter;
  }

  private async resolveHostForPoll(
    host: SSHHostWithCredentials,
    userId: string,
  ): Promise<SSHHostWithCredentials | null> {
    const cacheScope = `${userId}:${host.projectHostId ?? "personal"}`;
    const cached = hostPollCache.get(
      host.id,
      cacheScope,
    ) as SSHHostWithCredentials | null;
    if (cached) {
      return cached;
    }

    const refreshed = await fetchHostById(host.id, userId, host.projectHostId);
    if (!refreshed) {
      return null;
    }

    hostPollCache.set(host.id, cacheScope, refreshed);
    const scopeKey = getPollingScopeKey(host.id, userId, host.projectHostId);
    const config = this.pollingConfigs.get(scopeKey);
    if (config) {
      config.host = refreshed;
      config.statsConfig = this.parseStatsConfig(refreshed.statsConfig);
    }
    return refreshed;
  }

  private scheduleStatusPoll(
    host: SSHHostWithCredentials,
    viewerUserId?: string,
  ): void {
    const scopeKey = getHostPollingScopeKey(host, viewerUserId);
    if (this.statusInFlight.has(scopeKey)) {
      return;
    }
    this.statusInFlight.add(scopeKey);
    void statusPollLimiter
      .run(() => this.pollHostStatus(host, viewerUserId))
      .catch((err) => {
        statsLogger.error("Status polling failed", err, {
          operation: "status_poll_unhandled",
          hostId: host.id,
        });
      })
      .finally(() => {
        this.statusInFlight.delete(scopeKey);
      });
  }

  private scheduleMetricsPoll(
    host: SSHHostWithCredentials,
    viewerUserId?: string,
  ): void {
    const scopeKey = getHostPollingScopeKey(host, viewerUserId);
    if (this.metricsInFlight.has(scopeKey)) {
      return;
    }
    this.metricsInFlight.add(scopeKey);
    void metricsPollLimiter
      .run(() => this.pollHostMetrics(host, viewerUserId))
      .catch((err) => {
        statsLogger.error("Metrics polling failed", err, {
          operation: "metrics_poll_unhandled",
          hostId: host.id,
        });
      })
      .finally(() => {
        this.metricsInFlight.delete(scopeKey);
      });
  }

  private getGlobalDefaults(): {
    statusCheckInterval: number;
    metricsInterval: number;
  } {
    try {
      const statusValue = getCurrentSettingValue(
        "global_status_check_interval",
      );
      const metricsValue = getCurrentSettingValue("global_metrics_interval");

      return {
        statusCheckInterval: statusValue
          ? parseInt(statusValue, 10) ||
            DEFAULT_STATS_CONFIG.statusCheckInterval
          : DEFAULT_STATS_CONFIG.statusCheckInterval,
        metricsInterval: metricsValue
          ? parseInt(metricsValue, 10) || DEFAULT_STATS_CONFIG.metricsInterval
          : DEFAULT_STATS_CONFIG.metricsInterval,
      };
    } catch {
      return {
        statusCheckInterval: DEFAULT_STATS_CONFIG.statusCheckInterval,
        metricsInterval: DEFAULT_STATS_CONFIG.metricsInterval,
      };
    }
  }

  parseStatsConfig(statsConfigStr?: string | StatsConfig): StatsConfig {
    if (!statsConfigStr) {
      return DEFAULT_STATS_CONFIG;
    }

    let parsed: StatsConfig;

    if (typeof statsConfigStr === "object") {
      parsed = statsConfigStr;
    } else {
      try {
        let temp: unknown = JSON.parse(statsConfigStr);

        if (typeof temp === "string") {
          temp = JSON.parse(temp);
        }

        parsed = temp as StatsConfig;
      } catch (error) {
        statsLogger.warn(
          `Failed to parse statsConfig: ${error instanceof Error ? error.message : "Unknown error"}`,
          {
            operation: "parse_stats_config_error",
            statsConfigStr,
          },
        );
        return DEFAULT_STATS_CONFIG;
      }
    }

    const result = { ...DEFAULT_STATS_CONFIG, ...parsed };

    const globalDefaults = this.getGlobalDefaults();
    if (result.useGlobalStatusInterval !== false) {
      result.statusCheckInterval = globalDefaults.statusCheckInterval;
    }
    if (result.useGlobalMetricsInterval !== false) {
      result.metricsInterval = globalDefaults.metricsInterval;
    }

    return result;
  }

  async startPollingForHost(
    host: SSHHostWithCredentials,
    options?: { statusOnly?: boolean; viewerUserId?: string },
  ): Promise<void> {
    const statsConfig = this.parseStatsConfig(host.statsConfig);
    const statusOnly = options?.statusOnly ?? false;
    const viewerUserId = options?.viewerUserId;
    const scopeKey = getHostPollingScopeKey(host, viewerUserId);

    const canCollectMetrics = supportsMetrics(host);

    const enabledCollectors: string[] = [];
    if (isTcpPingEnabled(statsConfig)) {
      enabledCollectors.push("status");
    }
    if (!statusOnly && statsConfig.metricsEnabled && canCollectMetrics) {
      enabledCollectors.push(
        "cpu",
        "memory",
        "disk",
        "network",
        "uptime",
        "processes",
        "system",
      );
    }

    const existingConfig = this.pollingConfigs.get(scopeKey);

    if (existingConfig) {
      if (existingConfig.statusTimer) {
        clearInterval(existingConfig.statusTimer);
        existingConfig.statusTimer = undefined;
      }
      if (existingConfig.metricsTimer) {
        clearInterval(existingConfig.metricsTimer);
        existingConfig.metricsTimer = undefined;
      }
    }

    if (!isTcpPingEnabled(statsConfig) && !statsConfig.metricsEnabled) {
      this.pollingConfigs.delete(scopeKey);
      this.statusStore.delete(scopeKey);
      this.metricsStore.delete(scopeKey);
      return;
    }

    const config: HostPollingConfig = {
      host,
      statsConfig,
      viewerUserId,
    };
    this.pollingConfigs.set(scopeKey, config);

    if (isTcpPingEnabled(statsConfig)) {
      const intervalMs = this.intervalWithJitter(
        statsConfig.statusCheckInterval * 1000,
        host.id,
      );

      this.scheduleStatusPoll(host, viewerUserId);

      config.statusTimer = setInterval(() => {
        const latestConfig = this.pollingConfigs.get(scopeKey);
        if (latestConfig && isTcpPingEnabled(latestConfig.statsConfig)) {
          this.scheduleStatusPoll(latestConfig.host, latestConfig.viewerUserId);
        }
      }, intervalMs);
    } else {
      this.statusStore.delete(scopeKey);
    }

    if (!statusOnly && statsConfig.metricsEnabled && canCollectMetrics) {
      const intervalMs = this.intervalWithJitter(
        statsConfig.metricsInterval * 1000,
        host.id,
      );

      // First sample still awaited (gated) so callers can rely on a warm cache.
      if (!this.metricsInFlight.has(scopeKey)) {
        this.metricsInFlight.add(scopeKey);
        try {
          await metricsPollLimiter.run(() =>
            this.pollHostMetrics(host, viewerUserId),
          );
        } catch (err) {
          statsLogger.error("Metrics polling failed", err, {
            operation: "metrics_poll_unhandled",
            hostId: host.id,
          });
        } finally {
          this.metricsInFlight.delete(scopeKey);
        }
      }

      config.metricsTimer = setInterval(() => {
        const latestConfig = this.pollingConfigs.get(scopeKey);
        if (
          latestConfig &&
          latestConfig.statsConfig.metricsEnabled &&
          supportsMetrics(latestConfig.host)
        ) {
          this.scheduleMetricsPoll(
            latestConfig.host,
            latestConfig.viewerUserId,
          );
        }
      }, intervalMs);
    } else {
      this.metricsStore.delete(scopeKey);
    }
  }

  private async pollHostStatus(
    host: SSHHostWithCredentials,
    viewerUserId?: string,
  ): Promise<void> {
    const userId = viewerUserId || host.userId;
    const scopeKey = getPollingScopeKey(host.id, userId, host.projectHostId);
    const refreshedHost = await this.resolveHostForPoll(host, userId);
    if (!refreshedHost) {
      this.stopPollingScope(scopeKey);
      return;
    }

    try {
      const ct = refreshedHost.connectionType || "ssh";
      let pingPort: number;
      if (ct === "rdp") pingPort = refreshedHost.rdpPort ?? 3389;
      else if (ct === "vnc") pingPort = refreshedHost.vncPort ?? 5900;
      else if (ct === "telnet") pingPort = refreshedHost.telnetPort ?? 23;
      else pingPort = refreshedHost.port;

      let isOnline: boolean;
      if (refreshedHost.jumpHosts && refreshedHost.jumpHosts.length > 0) {
        const proxyConfig: SOCKS5Config | null =
          refreshedHost.useSocks5 &&
          (refreshedHost.socks5Host ||
            (refreshedHost.socks5ProxyChain &&
              refreshedHost.socks5ProxyChain.length > 0))
            ? {
                useSocks5: true,
                socks5Host: refreshedHost.socks5Host,
                socks5Port: refreshedHost.socks5Port,
                socks5Username: refreshedHost.socks5Username,
                socks5Password: refreshedHost.socks5Password,
                socks5ProxyChain: refreshedHost.socks5ProxyChain,
              }
            : null;
        const jumpClient = await createJumpHostChain(
          refreshedHost.jumpHosts,
          userId,
          proxyConfig,
        );
        isOnline = jumpClient
          ? await tcpPingThroughJumpHost(
              jumpClient,
              refreshedHost.ip,
              pingPort,
              5000,
            )
          : false;
      } else {
        isOnline = await tcpPing(refreshedHost.ip, pingPort, 5000);
      }
      const statusEntry: StatusEntry = {
        status: isOnline ? "online" : "offline",
        lastChecked: new Date().toISOString(),
      };
      this.statusStore.set(scopeKey, statusEntry);
      AlertEngine.getInstance()
        .evaluateStatus(refreshedHost.id, userId, isOnline)
        .catch(() => {});
    } catch {
      const statusEntry: StatusEntry = {
        status: "offline",
        lastChecked: new Date().toISOString(),
      };
      this.statusStore.set(scopeKey, statusEntry);
      AlertEngine.getInstance()
        .evaluateStatus(refreshedHost.id, userId, false)
        .catch(() => {});
    }
  }

  private async pollHostMetrics(
    host: SSHHostWithCredentials,
    viewerUserId?: string,
  ): Promise<void> {
    const userId = viewerUserId || host.userId;
    const scopeKey = getPollingScopeKey(host.id, userId, host.projectHostId);
    const refreshedHost = await this.resolveHostForPoll(host, userId);
    if (!refreshedHost) {
      this.stopPollingScope(scopeKey);
      return;
    }

    if (!supportsMetrics(refreshedHost)) {
      statsLogger.debug("Skipping metrics collection for non-SSH host", {
        operation: "poll_host_metrics_skipped",
        hostId: refreshedHost.id,
        connectionType: refreshedHost.connectionType || "ssh",
      });
      return;
    }

    const config = this.pollingConfigs.get(scopeKey);
    if (!config || !config.statsConfig.metricsEnabled) {
      return;
    }

    if (authFailureTracker.shouldSkip(scopeKey)) {
      return;
    }

    if (pollingBackoff.shouldSkip(scopeKey)) {
      return;
    }

    try {
      const metrics = await collectMetrics(refreshedHost);
      this.metricsStore.set(scopeKey, {
        data: metrics,
        timestamp: Date.now(),
      });
      await this.insertMetricsHistory(refreshedHost.id, metrics);
      AlertEngine.getInstance()
        .evaluateMetrics(refreshedHost.id, userId, metrics)
        .catch(() => {});
      pollingBackoff.reset(scopeKey);
      authFailureTracker.reset(scopeKey);
    } catch (error) {
      const isAuthError =
        error instanceof Error &&
        (error.message.includes("authentication") ||
          error.message.includes("Authentication") ||
          error.message.includes("permission denied") ||
          error.message.includes("Permission denied"));

      if (isAuthError) {
        // authFailureTracker already handles auth errors inside collectMetrics;
        // only log on the first occurrence to avoid repeated spam
        const alreadyTracked = authFailureTracker.shouldSkip(scopeKey);
        if (!alreadyTracked) {
          statsLogger.error("Stats collector connection failed", error, {
            operation: "stats_connect_failed",
            hostId: refreshedHost.id,
          });
        }
        return;
      }

      pollingBackoff.recordFailure(scopeKey);

      // Only log when a new retry window opens, not on every skipped poll
      const backoff = pollingBackoff.getBackoffInfo(scopeKey);
      const isNewFailure =
        backoff !== null && !backoff.includes("polling suspended");
      if (isNewFailure) {
        statsLogger.error("Stats collector connection failed", error, {
          operation: "stats_connect_failed",
          hostId: refreshedHost.id,
        });
      }
    }
  }

  private getRetentionDays(): number {
    try {
      const value = getCurrentSettingValue("metrics_history_retention_days");
      const days = value ? parseInt(value, 10) : 7;
      return isNaN(days) || days < 1 ? 7 : Math.min(days, 90);
    } catch {
      return 7;
    }
  }

  private async insertMetricsHistory(
    hostId: number,
    metrics: {
      cpu: { percent: number | null };
      memory: { percent: number | null };
      disk: { percent: number | null };
      network: {
        interfaces: Array<{ rxBytes: string | null; txBytes: string | null }>;
      };
    },
  ): Promise<void> {
    try {
      const iface = metrics.network?.interfaces?.[0];
      const rxRaw = iface?.rxBytes ? parseInt(iface.rxBytes, 10) : null;
      const txRaw = iface?.txBytes ? parseInt(iface.txBytes, 10) : null;

      const repository = createCurrentHostMetricsHistoryRepository();
      await repository.create({
        hostId,
        cpuPercent: metrics.cpu?.percent ?? null,
        memPercent: metrics.memory?.percent ?? null,
        diskPercent: metrics.disk?.percent ?? null,
        netRxBytes: isNaN(rxRaw as number) ? null : rxRaw,
        netTxBytes: isNaN(txRaw as number) ? null : txRaw,
      });

      const retentionDays = this.getRetentionDays();
      repository.pruneOlderThan(hostId, retentionDays);
    } catch (err) {
      statsLogger.warn("Failed to write metrics history", {
        operation: "insert_metrics_history",
        hostId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private stopPollingScope(scopeKey: PollingScopeKey, clearData = true): void {
    const config = this.pollingConfigs.get(scopeKey);
    if (config) {
      if (config.statusTimer) {
        clearInterval(config.statusTimer);
        config.statusTimer = undefined;
      }
      if (config.metricsTimer) {
        clearInterval(config.metricsTimer);
        config.metricsTimer = undefined;
      }

      this.pollingConfigs.delete(scopeKey);
      if (clearData) {
        this.statusStore.delete(scopeKey);
        this.metricsStore.delete(scopeKey);
      }
      hostPollCache.invalidate(config.host.id);
    }
    this.statusInFlight.delete(scopeKey);
    this.metricsInFlight.delete(scopeKey);
  }

  stopPollingForUserHost(hostId: number, userId: string): void {
    const scopeKeys = Array.from(this.pollingConfigs.entries())
      .filter(
        ([, config]) =>
          config.host.id === hostId &&
          getHostAccessUserId(config.host, config.viewerUserId) === userId,
      )
      .map(([scopeKey]) => scopeKey);
    for (const scopeKey of scopeKeys) {
      this.stopPollingScope(scopeKey);
      this.activeViewers.delete(scopeKey);
    }

    for (const [sessionId, viewer] of this.viewerDetails.entries()) {
      if (viewer.hostId === hostId && viewer.userId === userId) {
        this.viewerDetails.delete(sessionId);
      }
    }
    for (const [sessionKey, session] of Object.entries(metricsSessions)) {
      if (session.hostId === hostId && session.userId === userId) {
        cleanupMetricsSession(sessionKey);
      }
    }
    for (const [sessionId, session] of Object.entries(pendingTOTPSessions)) {
      if (session.hostId !== hostId || session.userId !== userId) continue;
      try {
        session.client.end();
      } catch {
        // expected
      }
      delete pendingTOTPSessions[sessionId];
    }
    hostPollCache.invalidate(hostId);
  }

  private stopMetricsScope(scopeKey: PollingScopeKey): void {
    const config = this.pollingConfigs.get(scopeKey);
    if (config?.metricsTimer) {
      clearInterval(config.metricsTimer);
      config.metricsTimer = undefined;
    }
  }

  getStatus(
    hostId: number,
    userId: string,
    projectHostId?: number,
  ): StatusEntry | undefined {
    return this.statusStore.get(
      getPollingScopeKey(hostId, userId, projectHostId),
    );
  }

  getAllStatuses(userId: string): Map<number, StatusEntry> {
    const result = new Map<number, StatusEntry>();
    for (const [scopeKey, entry] of this.statusStore.entries()) {
      const config = this.pollingConfigs.get(scopeKey);
      if (
        !config ||
        config.host.projectHostId !== undefined ||
        getHostAccessUserId(config.host, config.viewerUserId) !== userId
      ) {
        continue;
      }
      result.set(config.host.id, entry);
    }
    return result;
  }

  getMetrics(
    hostId: number,
    userId: string,
    projectHostId?: number,
  ):
    | { data: Awaited<ReturnType<typeof collectMetrics>>; timestamp: number }
    | undefined {
    return this.metricsStore.get(
      getPollingScopeKey(hostId, userId, projectHostId),
    );
  }

  async initializePolling(userId: string): Promise<void> {
    const hosts = await fetchAllHosts(userId);

    for (const host of hosts) {
      await this.startPollingForHost(host, { statusOnly: true });
    }
  }

  async initializeHostPolling(
    hostId: number,
    userId: string,
    projectHostId?: number,
  ): Promise<void> {
    const host = await fetchHostById(hostId, userId, projectHostId);
    if (host) {
      await this.startPollingForHost(host, {
        statusOnly: true,
        viewerUserId: userId,
      });
    }
  }

  async refreshHostPolling(userId: string): Promise<void> {
    const hosts = await fetchAllHosts(userId);
    const currentHostIds = new Set(hosts.map((h) => h.id));
    const personalScopes = Array.from(this.pollingConfigs.entries()).filter(
      ([, config]) =>
        config.host.projectHostId === undefined &&
        getHostAccessUserId(config.host, config.viewerUserId) === userId,
    );

    for (const [scopeKey, config] of personalScopes) {
      const keepData = currentHostIds.has(config.host.id);
      this.stopPollingScope(scopeKey, !keepData);
    }

    for (const host of hosts) {
      await this.startPollingForHost(host, { statusOnly: true });
    }
  }

  async refreshAllPolling(): Promise<void> {
    const hostsToRefresh: Array<{
      host: SSHHostWithCredentials;
      viewerUserId?: string;
      statusOnly: boolean;
    }> = [];

    for (const [scopeKey, config] of this.pollingConfigs.entries()) {
      const status = this.statusStore.get(scopeKey);

      if (!status || status.status === "online") {
        hostsToRefresh.push({
          host: config.host,
          viewerUserId: config.viewerUserId,
          statusOnly: config.metricsTimer === undefined,
        });
      }
    }

    for (const scopeKey of Array.from(this.pollingConfigs.keys())) {
      this.stopPollingScope(scopeKey, false);
    }

    for (const { host, viewerUserId, statusOnly } of hostsToRefresh) {
      await this.startPollingForHost(host, { statusOnly, viewerUserId });
    }
  }

  registerViewer(
    hostId: number,
    sessionId: string,
    userId: string,
    projectHostId?: number,
  ): void {
    const scopeKey = getPollingScopeKey(hostId, userId, projectHostId);
    if (!this.activeViewers.has(scopeKey)) {
      this.activeViewers.set(scopeKey, new Set());
    }
    this.activeViewers.get(scopeKey)!.add(sessionId);

    this.viewerDetails.set(sessionId, {
      sessionId,
      userId,
      hostId,
      projectHostId,
      lastHeartbeat: Date.now(),
    });

    if (this.activeViewers.get(scopeKey)!.size === 1) {
      // Fire-and-forget: never let background metrics start-up failures
      // propagate up to the HTTP handler that registered the viewer.
      Promise.resolve()
        .then(() => this.startMetricsForHost(hostId, userId, projectHostId))
        .catch((err) => {
          statsLogger.warn("startMetricsForHost rejected (non-fatal)", {
            operation: "start_metrics_unhandled",
            hostId,
            userId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }
  }

  updateHeartbeat(sessionId: string, userId?: string): boolean {
    const viewer = this.viewerDetails.get(sessionId);
    if (viewer && (!userId || viewer.userId === userId)) {
      viewer.lastHeartbeat = Date.now();
      return true;
    }
    return false;
  }

  hasActiveViewers(
    hostId: number,
    userId: string,
    projectHostId?: number,
  ): boolean {
    const scopeKey = getPollingScopeKey(hostId, userId, projectHostId);
    return (this.activeViewers.get(scopeKey)?.size ?? 0) > 0;
  }

  unregisterViewer(
    hostId: number,
    sessionId: string,
    userId?: string,
    projectHostId?: number,
  ): boolean {
    const viewer = this.viewerDetails.get(sessionId);
    if (
      !viewer ||
      viewer.hostId !== hostId ||
      (userId !== undefined && viewer.userId !== userId) ||
      (userId !== undefined && viewer.projectHostId !== projectHostId)
    ) {
      return false;
    }
    const scopeKey = getPollingScopeKey(
      viewer.hostId,
      viewer.userId,
      viewer.projectHostId,
    );
    const viewers = this.activeViewers.get(scopeKey);
    if (viewers) {
      viewers.delete(sessionId);

      if (viewers.size === 0) {
        this.activeViewers.delete(scopeKey);
        this.stopMetricsScope(scopeKey);
      }
    }
    this.viewerDetails.delete(sessionId);
    return true;
  }

  private async startMetricsForHost(
    hostId: number,
    userId: string,
    projectHostId?: number,
  ): Promise<void> {
    try {
      const host = await fetchHostById(hostId, userId, projectHostId);
      if (host) {
        await this.startPollingForHost(host, { viewerUserId: userId });
      }
    } catch (error) {
      statsLogger.error("Failed to start metrics polling", {
        operation: "start_metrics_error",
        hostId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private cleanupInactiveViewers(): void {
    const now = Date.now();
    const maxInactivity = 120000;

    for (const [sessionId, viewer] of this.viewerDetails.entries()) {
      if (now - viewer.lastHeartbeat > maxInactivity) {
        this.unregisterViewer(viewer.hostId, sessionId);
      }
    }
  }

  destroy(): void {
    clearInterval(this.viewerCleanupInterval);
    for (const scopeKey of Array.from(this.pollingConfigs.keys())) {
      this.stopPollingScope(scopeKey);
    }
  }
}

const pollingManager = new PollingManager();

function validateHostId(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const id = Number(req.params.id);
  if (!id || !Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid host ID" });
  }
  next();
}

const app = express();
app.use(createCorsMiddleware());
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));
app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

app.use(authManager.createAuthMiddleware());
const requireAdmin = authManager.createAdminMiddleware();

async function fetchAllHosts(
  userId: string,
): Promise<SSHHostWithCredentials[]> {
  try {
    const repository = createCurrentHostResolutionRepository();
    const hostResults = await repository.findHostsByUserId(userId);

    const hostsWithCredentials: SSHHostWithCredentials[] = [];
    for (const host of hostResults) {
      try {
        const hostWithCreds = await resolveHostCredentials(host, userId);
        if (hostWithCreds) {
          hostsWithCredentials.push(hostWithCreds);
        }
      } catch (err) {
        statsLogger.warn(
          `Failed to resolve credentials for host ${host.id}: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    }

    return hostsWithCredentials.filter((h) => !!h.id && !!h.ip && !!h.port);
  } catch (err) {
    statsLogger.error("Failed to fetch hosts from database", err);
    return [];
  }
}

async function fetchHostById(
  id: number,
  userId: string,
  projectHostId?: number,
): Promise<SSHHostWithCredentials | undefined> {
  try {
    if (DataCrypto.getUserDataKey(userId) === null) {
      return undefined;
    }

    const host = await resolveHostById(id, userId, projectHostId);
    return host
      ? ({
          ...host,
          projectHostId,
          accessUserId: userId,
        } as unknown as SSHHostWithCredentials)
      : undefined;
  } catch (err) {
    statsLogger.error(`Failed to fetch host ${id}`, err);
    return undefined;
  }
}

async function resolveHostCredentials(
  host: Record<string, unknown>,
  userId: string,
): Promise<SSHHostWithCredentials | undefined> {
  try {
    const baseHost: Record<string, unknown> = {
      id: host.id,
      name: host.name,
      ip: host.ip,
      port: host.port,
      username: host.username,
      folder: host.folder || "",
      tags:
        typeof host.tags === "string"
          ? host.tags
            ? host.tags.split(",").filter(Boolean)
            : []
          : [],
      pin: !!host.pin,
      authType: host.authType,
      enableTerminal: !!host.enableTerminal,
      enableTunnel: !!host.enableTunnel,
      enableFileManager: !!host.enableFileManager,
      defaultPath: host.defaultPath || "/",
      tunnelConnections: host.tunnelConnections
        ? JSON.parse(host.tunnelConnections as string)
        : [],
      jumpHosts: host.jumpHosts ? JSON.parse(host.jumpHosts as string) : [],
      statsConfig: host.statsConfig || undefined,
      sudoPassword: (() => {
        const top = host.sudoPassword as string | null | undefined;
        if (top) return top;
        try {
          const tc =
            typeof host.terminalConfig === "string"
              ? JSON.parse(host.terminalConfig as string)
              : host.terminalConfig;
          return (tc?.sudoPassword as string) || undefined;
        } catch {
          return undefined;
        }
      })(),
      createdAt: host.createdAt,
      updatedAt: host.updatedAt,
      userId: host.userId,
      useSocks5: !!host.useSocks5,
      socks5Host: host.socks5Host || undefined,
      socks5Port: host.socks5Port || undefined,
      socks5Username: host.socks5Username || undefined,
      socks5Password: host.socks5Password || undefined,
      socks5ProxyChain: host.socks5ProxyChain
        ? JSON.parse(host.socks5ProxyChain as string)
        : undefined,
      connectionType:
        (host.connectionType as SSHHostWithCredentials["connectionType"]) ||
        "ssh",
      rdpPort: (host.rdpPort as number | undefined) ?? undefined,
      vncPort: (host.vncPort as number | undefined) ?? undefined,
      telnetPort: (host.telnetPort as number | undefined) ?? undefined,
    };

    if (host.credentialId) {
      try {
        const ownerId = host.userId;
        const isSharedHost = userId !== ownerId;

        if (isSharedHost) {
          const { SharedHostSecretsManager } =
            await import("../../utils/shared-host-secrets-manager.js");
          const sharedCred =
            await SharedHostSecretsManager.getInstance().getSecretForUser(
              host.id as number,
              userId,
              "ssh",
            );

          if (sharedCred) {
            baseHost.credentialId = host.credentialId;
            baseHost.authType = sharedCred.authType;

            baseHost.username = pickResolvedUsername(
              host.username,
              sharedCred.username,
              host.overrideCredentialUsername,
            );

            if (sharedCred.password) {
              baseHost.password = sharedCred.password;
            }
            if (sharedCred.key) {
              baseHost.key = sharedCred.key;
            }
            if (sharedCred.keyPassword) {
              baseHost.keyPassword = sharedCred.keyPassword;
            }
            if (sharedCred.keyType) {
              baseHost.keyType = sharedCred.keyType;
            }
          }
        } else {
          const credential =
            await createCurrentHostResolutionRepository().findCredentialByIdForUser(
              host.credentialId as number,
              userId,
            );

          if (credential) {
            baseHost.credentialId = credential.id;
            baseHost.authType =
              credential.authType ||
              (credential.password
                ? "password"
                : credential.key ||
                    (credential as Record<string, unknown>).privateKey
                  ? "key"
                  : "none");

            baseHost.username = pickResolvedUsername(
              host.username,
              credential.username,
              host.overrideCredentialUsername,
            );

            const credentialKey =
              credential.key ||
              (credential as Record<string, unknown>).privateKey;
            baseHost.password = pickResolvedPassword(
              host.password,
              credential.password,
              credential.authType,
              credentialKey,
            );
            if (credentialKey) {
              baseHost.key = credentialKey as string;
            }
            if (credential.keyPassword) {
              baseHost.keyPassword = credential.keyPassword;
            }
            if (credential.keyType) {
              baseHost.keyType = credential.keyType;
            }
          } else {
            addLegacyCredentials(baseHost, host);
            if (baseHost.authType === "credential") {
              baseHost.authType = baseHost.password
                ? "password"
                : baseHost.key
                  ? "key"
                  : "none";
            }
          }
        }
      } catch (error) {
        statsLogger.warn(
          `Failed to resolve credential ${host.credentialId} for host ${host.id}: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
        addLegacyCredentials(baseHost, host);
        if (baseHost.authType === "credential") {
          baseHost.authType = baseHost.password
            ? "password"
            : baseHost.key
              ? "key"
              : "none";
        }
      }
    } else {
      addLegacyCredentials(baseHost, host);
    }

    return baseHost as unknown as SSHHostWithCredentials;
  } catch (error) {
    statsLogger.error(
      `Failed to resolve host credentials for host ${host.id}: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
    return undefined;
  }
}

function addLegacyCredentials(
  baseHost: Record<string, unknown>,
  host: Record<string, unknown>,
): void {
  baseHost.password = host.password || null;
  baseHost.key = host.key || null;
  baseHost.keyPassword = host.keyPassword || null;
  baseHost.keyType = host.keyType;
}

async function buildSshConfig(
  host: SSHHostWithCredentials,
): Promise<ConnectConfig> {
  const base: ConnectConfig = {
    host: host.ip?.replace(/^\[|\]$/g, "") || host.ip,
    port: host.port,
    username: host.username,
    tryKeyboard: true,
    keepaliveInterval: 30000,
    keepaliveCountMax: 3,
    readyTimeout: 60000,
    tcpKeepAlive: true,
    tcpKeepAliveInitialDelay: 30000,
    hostVerifier: await SSHHostKeyVerifier.createHostVerifier(
      host.id,
      host.ip,
      host.port,
      null,
      host.userId || "",
      false,
    ),
    env: {
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      LC_CTYPE: "en_US.UTF-8",
      LC_MESSAGES: "en_US.UTF-8",
      LC_MONETARY: "en_US.UTF-8",
      LC_NUMERIC: "en_US.UTF-8",
      LC_TIME: "en_US.UTF-8",
      LC_COLLATE: "en_US.UTF-8",
      COLORTERM: "truecolor",
    },
    algorithms: {
      kex: [
        "curve25519-sha256",
        "curve25519-sha256@libssh.org",
        "ecdh-sha2-nistp521",
        "ecdh-sha2-nistp384",
        "ecdh-sha2-nistp256",
        "diffie-hellman-group-exchange-sha256",
        "diffie-hellman-group14-sha256",
        "diffie-hellman-group14-sha1",
        "diffie-hellman-group-exchange-sha1",
        "diffie-hellman-group1-sha1",
      ],
      serverHostKey: [
        "ssh-ed25519",
        "ecdsa-sha2-nistp521",
        "ecdsa-sha2-nistp384",
        "ecdsa-sha2-nistp256",
        "rsa-sha2-512",
        "rsa-sha2-256",
        "ssh-rsa",
        "ssh-dss",
      ],
      cipher: SSH_ALGORITHMS.cipher,
      hmac: [
        "hmac-sha2-512-etm@openssh.com",
        "hmac-sha2-256-etm@openssh.com",
        "hmac-sha2-512",
        "hmac-sha2-256",
        "hmac-sha1",
        "hmac-md5",
      ],
      compress: ["none", "zlib@openssh.com", "zlib"],
    },
  } as ConnectConfig;

  if (host.authType === "password") {
    if (!host.password) {
      throw new Error(`No password available for host ${host.ip}`);
    }
    base.password = host.password;
  } else if (host.authType === "key") {
    if (!host.key) {
      throw new Error(`No SSH key available for host ${host.ip}`);
    }

    try {
      (base as Record<string, unknown>).privateKey = preparePrivateKeyForSSH2(
        host.key,
        host.keyPassword,
      );

      if (host.keyPassword) {
        (base as Record<string, unknown>).passphrase = host.keyPassword;
      }
    } catch (keyError) {
      statsLogger.error(
        `SSH key format error for host ${host.ip}: ${keyError instanceof Error ? keyError.message : "Unknown error"}`,
      );
      throw new Error(`Invalid SSH key format for host ${host.ip}`, {
        cause: keyError,
      });
    }
  } else if (
    host.authType === "none" ||
    host.authType === "tailscale" ||
    host.authType === "warpgate"
  ) {
    // no credentials needed
  } else if (host.authType === "opkssh") {
    // cert auth setup happens in createSshFactory (needs client instance)
  } else if (host.authType === "vault") {
    // cert auth setup happens in createSshFactory (needs client instance)
  } else if (host.authType === "credential") {
    if (host.password) {
      base.password = host.password;
    } else if (host.key) {
      const cleanKey = host.key
        .trim()
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n");
      (base as Record<string, unknown>).privateKey = Buffer.from(
        cleanKey,
        "utf8",
      );
      if (host.keyPassword) {
        (base as Record<string, unknown>).passphrase = host.keyPassword;
      }
    } else {
      throw new Error(`Credential for host ${host.ip} could not be resolved`);
    }
  } else {
    throw new Error(
      `Unsupported authentication type '${host.authType}' for host ${host.ip}`,
    );
  }

  return base;
}

function getPoolKey(host: SSHHostWithCredentials): string {
  const socks5Key = host.useSocks5
    ? `:socks5:${host.socks5Host}:${host.socks5Port}`
    : "";
  return `stats:${host.accessUserId ?? host.userId}:${host.projectHostId ?? "personal"}:${host.ip}:${host.port}:${host.username}${socks5Key}`;
}

function createSshFactory(host: SSHHostWithCredentials): () => Promise<Client> {
  return async () => {
    const config = await buildSshConfig(host);
    const client = new Client();

    // Set up OPKSSH cert auth if needed (requires client instance)
    if (host.authType === "opkssh" && host.userId) {
      const { getOPKSSHToken } = await import("../opkssh-auth.js");
      const token = await getOPKSSHToken(host.userId, host.id);
      if (!token) {
        throw new Error(
          "OPKSSH authentication required. Please open a Terminal connection first.",
        );
      }
      const { setupOPKSSHCertAuth } = await import("../opkssh-cert-auth.js");
      await setupOPKSSHCertAuth(config, client, token, host.username);
    } else if (host.authType === "vault") {
      const { setupVaultSshSignerAuth } =
        await import("../vault-ssh-connect.js");
      await setupVaultSshSignerAuth(config, client, host);
    }

    const proxyConfig: SOCKS5Config | null =
      host.useSocks5 &&
      (host.socks5Host ||
        (host.socks5ProxyChain && host.socks5ProxyChain.length > 0))
        ? {
            useSocks5: host.useSocks5,
            socks5Host: host.socks5Host,
            socks5Port: host.socks5Port,
            socks5Username: host.socks5Username,
            socks5Password: host.socks5Password,
            socks5ProxyChain: host.socks5ProxyChain,
          }
        : null;

    const hasJumpHosts =
      host.jumpHosts && host.jumpHosts.length > 0 && host.userId;

    let jumpClient: Client | null = null;
    if (hasJumpHosts) {
      jumpClient = await createJumpHostChain(
        host.jumpHosts!,
        host.userId!,
        proxyConfig,
      );

      if (!jumpClient) {
        throw new Error("Failed to establish jump host chain");
      }
    } else if (proxyConfig) {
      try {
        const proxySocket = await createSocks5Connection(
          host.ip,
          host.port,
          proxyConfig,
        );
        if (proxySocket) {
          config.sock = proxySocket;
        }
      } catch (proxyError) {
        throw new Error(
          "Proxy connection failed: " +
            (proxyError instanceof Error
              ? proxyError.message
              : "Unknown error"),
          { cause: proxyError },
        );
      }
    }

    return new Promise<Client>((resolve, reject) => {
      const timeout = setTimeout(() => {
        client.end();
        jumpClient?.end();
        reject(new Error("SSH connection timeout"));
      }, 30000);

      client.on("ready", () => {
        clearTimeout(timeout);
        resolve(client);
      });

      client.on("close", () => {
        jumpClient?.end();
      });

      client.on("error", (err) => {
        clearTimeout(timeout);
        jumpClient?.end();
        reject(err);
      });

      client.on(
        "keyboard-interactive",
        (
          _name: string,
          _instructions: string,
          _instructionsLang: string,
          prompts: Array<{ prompt: string; echo: boolean }>,
          finish: (responses: string[]) => void,
        ) => {
          const totpPromptIndex = prompts.findIndex((p) =>
            /verification code|verification_code|token|otp|2fa|authenticator|google.*auth/i.test(
              p.prompt,
            ),
          );

          if (totpPromptIndex !== -1) {
            const sessionId = `totp-${crypto.randomUUID()}`;

            pendingTOTPSessions[sessionId] = {
              client,
              finish,
              config,
              createdAt: Date.now(),
              sessionId,
              hostId: host.id,
              userId: host.userId!,
              prompts: prompts.map((p) => ({
                prompt: p.prompt,
                echo: p.echo ?? false,
              })),
              totpPromptIndex,
              resolvedPassword: host.password,
              totpAttempts: 0,
            };

            return;
          } else if (host.password) {
            const responses = prompts.map((p) => {
              if (/password/i.test(p.prompt)) {
                return host.password || "";
              }
              return "";
            });
            finish(responses);
          } else {
            finish(prompts.map(() => ""));
          }
        },
      );

      if (jumpClient) {
        jumpClient.forwardOut(
          "127.0.0.1",
          0,
          host.ip,
          host.port,
          (err, stream) => {
            if (err) {
              clearTimeout(timeout);
              jumpClient!.end();
              reject(
                new Error(
                  "Failed to forward through jump host: " + err.message,
                ),
              );
              return;
            }

            config.sock = stream;
            client.connect(config);
          },
        );
      } else if (config.sock) {
        client.connect(config);
      } else {
        resolveSshConnectConfigHost(config)
          .then(() => {
            client.connect(config);
          })
          .catch((error) => {
            clearTimeout(timeout);
            reject(error);
          });
        return;
      }
    });
  };
}

async function withSshConnection<T>(
  host: SSHHostWithCredentials,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const key = getPoolKey(host);
  const factory = createSshFactory(host);
  return withConnection(key, factory, fn);
}

async function collectMetrics(host: SSHHostWithCredentials): Promise<{
  cpu: {
    percent: number | null;
    cores: number | null;
    load: [number, number, number] | null;
  };
  memory: {
    percent: number | null;
    usedGiB: number | null;
    totalGiB: number | null;
  };
  disk: {
    percent: number | null;
    usedHuman: string | null;
    totalHuman: string | null;
    availableHuman: string | null;
  };
  network: {
    interfaces: Array<{
      name: string;
      ip: string;
      state: string;
      rxBytes: string | null;
      txBytes: string | null;
    }>;
  };
  uptime: {
    seconds: number | null;
    formatted: string | null;
  };
  processes: {
    total: number | null;
    running: number | null;
    top: Array<{
      pid: string;
      user: string;
      cpu: string;
      mem: string;
      command: string;
    }>;
  };
  system: {
    hostname: string | null;
    kernel: string | null;
    os: string | null;
  };
}> {
  if (!supportsMetrics(host)) {
    throw new Error("Metrics collection only supported for SSH hosts");
  }

  const hostScopeKey = getHostPollingScopeKey(host);

  if (authFailureTracker.shouldSkip(hostScopeKey)) {
    const reason = authFailureTracker.getSkipReason(hostScopeKey);
    throw new Error(reason || "Authentication failed");
  }

  const cached = metricsCache.get(hostScopeKey);
  if (cached) {
    return cached as ReturnType<typeof collectMetrics> extends Promise<infer T>
      ? T
      : never;
  }

  return requestQueue.queueRequest(hostScopeKey, async () => {
    const sessionKey = getSessionKey(
      host.id,
      host.accessUserId ?? host.userId!,
      host.projectHostId,
    );
    const existingSession = metricsSessions[sessionKey];

    try {
      const collectFn = async (client: Client) => {
        const cpu = await collectCpuMetrics(client);
        const memory = await collectMemoryMetrics(client);
        const disk = await collectDiskMetrics(client);
        const network = await collectNetworkMetrics(client);
        const uptime = await collectUptimeMetrics(client);
        const processes = await collectProcessesMetrics(client);
        const system = await collectSystemMetrics(client);

        let login_stats = {
          recentLogins: [],
          failedLogins: [],
          totalLogins: 0,
          uniqueIPs: 0,
        };
        try {
          login_stats = await collectLoginStats(client);
        } catch {
          // expected
        }

        let ports: {
          source: "ss" | "netstat" | "none";
          ports: Array<{
            protocol: "tcp" | "udp";
            localAddress: string;
            localPort: number;
            state?: string;
            pid?: number;
            process?: string;
          }>;
        } = {
          source: "none",
          ports: [],
        };
        try {
          ports = await collectPortsMetrics(client);
        } catch {
          // expected
        }

        let firewall: {
          type: "iptables" | "nftables" | "none";
          status: "active" | "inactive" | "unknown";
          chains: Array<{
            name: string;
            policy: string;
            rules: Array<{
              chain: string;
              target: string;
              protocol: string;
              source: string;
              destination: string;
              dport?: string;
              sport?: string;
              state?: string;
              interface?: string;
              extra?: string;
            }>;
          }>;
        } = {
          type: "none",
          status: "unknown",
          chains: [],
        };
        try {
          firewall = await collectFirewallMetrics(client);
        } catch {
          // expected
        }

        let temperature: {
          source: "sysfs" | "sensors" | "none";
          highestCelsius: number | null;
          sensors: Array<{ label: string; celsius: number }>;
        } = {
          source: "none",
          highestCelsius: null,
          sensors: [],
        };
        try {
          temperature = await collectTemperatureMetrics(client);
        } catch {
          // expected
        }

        const result = {
          cpu,
          memory,
          disk,
          network,
          uptime,
          processes,
          system,
          login_stats,
          ports,
          firewall,
          temperature,
        };

        metricsCache.set(hostScopeKey, result);
        return result;
      };

      if (existingSession && existingSession.isConnected) {
        existingSession.activeOperations++;
        try {
          const result = await collectFn(existingSession.client);
          existingSession.lastActive = Date.now();
          return result;
        } finally {
          existingSession.activeOperations--;
        }
      } else {
        return await withSshConnection(host, collectFn);
      }
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("TOTP authentication required")) {
          throw error;
        } else if (
          error.message.includes("No password available") ||
          error.message.includes("Unsupported authentication type") ||
          error.message.includes("No SSH key available") ||
          error.message.includes("Invalid SSH key format")
        ) {
          authFailureTracker.recordFailure(hostScopeKey, "AUTH", true);
        } else if (
          error.message.includes("authentication") ||
          error.message.includes("Permission denied") ||
          error.message.includes("All configured authentication methods failed")
        ) {
          authFailureTracker.recordFailure(hostScopeKey, "AUTH");
        } else if (
          error.message.includes("timeout") ||
          error.message.includes("ETIMEDOUT")
        ) {
          authFailureTracker.recordFailure(hostScopeKey, "TIMEOUT");
        }
      }
      throw error;
    }
  });
}

function tcpPing(
  host: string,
  port: number,
  timeoutMs = 5000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const cleanup = () => {
      try {
        socket.destroy();
      } catch {
        // expected
      }
    };

    socket.setTimeout(timeoutMs);

    socket.once("connect", () => {
      const dataTimeout = setTimeout(() => {
        cleanup();
        finish(true);
      }, 2000);

      socket.once("data", (data) => {
        clearTimeout(dataTimeout);
        const dataStr = data.toString("utf8");
        if (dataStr.startsWith("SSH-")) {
          try {
            socket.end("SSH-2.0-TermixHealthCheck\r\n");
          } catch {
            // expected
          }
          setTimeout(cleanup, 200);
        } else {
          cleanup();
        }
        finish(true);
      });
    });

    socket.once("timeout", () => {
      cleanup();
      finish(false);
    });
    socket.once("error", () => {
      cleanup();
      finish(false);
    });
    socket.connect(port, host);
  });
}

/**
 * @openapi
 * /status:
 *   get:
 *     summary: Get all host statuses
 *     description: Retrieves the status of all hosts for the authenticated user.
 *     tags:
 *       - Host Metrics
 *     responses:
 *       200:
 *         description: A map of host IDs to their status entries.
 *       401:
 *         description: Session expired - please log in again.
 */
app.get("/status", async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;

  if (DataCrypto.getUserDataKey(userId) === null) {
    return res.status(401).json({
      error: "Session expired - please log in again",
      code: "SESSION_EXPIRED",
    });
  }

  const statuses = pollingManager.getAllStatuses(userId);
  if (statuses.size === 0) {
    await pollingManager.initializePolling(userId);
  }

  const result: Record<number, StatusEntry> = {};
  for (const [id, entry] of pollingManager.getAllStatuses(userId).entries()) {
    const access = await permissionManager.canAccessHost(userId, id, "connect");
    if (access.hasAccess) {
      result[id] = entry;
    }
  }
  res.json(result);
});

/**
 * @openapi
 * /status/{id}:
 *   get:
 *     summary: Get host status by ID
 *     description: Retrieves the status of a specific host by its ID.
 *     tags:
 *       - Host Metrics
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Host status entry.
 *       401:
 *         description: Session expired - please log in again.
 *       404:
 *         description: Status not available.
 */
app.get("/status/:id", validateHostId, async (req, res) => {
  const id = Number(req.params.id);
  const userId = (req as AuthenticatedRequest).userId;
  const projectHostId = parseProjectHostId(req.query.projectHostId);
  if (projectHostId === null) {
    return res.status(400).json({ error: "Invalid projectHostId" });
  }

  if (DataCrypto.getUserDataKey(userId) === null) {
    return res.status(401).json({
      error: "Session expired - please log in again",
      code: "SESSION_EXPIRED",
    });
  }

  const access = await permissionManager.canAccessHost(
    userId,
    id,
    "connect",
    projectHostId,
  );
  if (!access.hasAccess) {
    return res.status(404).json({ error: "Status not available" });
  }

  let statusEntry = pollingManager.getStatus(id, userId, projectHostId);
  if (!statusEntry) {
    await pollingManager.initializeHostPolling(id, userId, projectHostId);
    statusEntry = pollingManager.getStatus(id, userId, projectHostId);
  }
  if (!statusEntry) {
    return res.status(404).json({ error: "Status not available" });
  }

  res.json(statusEntry);
});

/**
 * @openapi
 * /clear-connections:
 *   post:
 *     summary: Clear all SSH connections
 *     description: Clears all SSH connections from the connection pool.
 *     tags:
 *       - Host Metrics
 *     responses:
 *       200:
 *         description: All SSH connections cleared.
 *       401:
 *         description: Session expired - please log in again.
 */
app.post("/clear-connections", requireAdmin, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;

  if (DataCrypto.getUserDataKey(userId) === null) {
    return res.status(401).json({
      error: "Session expired - please log in again",
      code: "SESSION_EXPIRED",
    });
  }

  connectionPool.clearAllConnections();
  res.json({ message: "All SSH connections cleared" });
});

/**
 * @openapi
 * /refresh:
 *   post:
 *     summary: Refresh polling
 *     description: Refreshes host polling for the authenticated user.
 *     tags:
 *       - Host Metrics
 *     responses:
 *       200:
 *         description: Polling refreshed.
 *       401:
 *         description: Session expired - please log in again.
 */
app.post("/refresh", async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;

  if (DataCrypto.getUserDataKey(userId) === null) {
    return res.status(401).json({
      error: "Session expired - please log in again",
      code: "SESSION_EXPIRED",
    });
  }

  await pollingManager.refreshHostPolling(userId);
  res.json({ message: "Polling refreshed" });
});

/**
 * @openapi
 * /host-updated:
 *   post:
 *     summary: Start polling for updated host
 *     description: Starts polling for a specific host after it has been updated.
 *     tags:
 *       - Host Metrics
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               hostId:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Host polling started.
 *       400:
 *         description: Invalid hostId.
 *       401:
 *         description: Session expired - please log in again.
 *       404:
 *         description: Host not found.
 *       500:
 *         description: Failed to start polling.
 */
app.post("/host-updated", async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { hostId } = req.body;

  if (DataCrypto.getUserDataKey(userId) === null) {
    return res.status(401).json({
      error: "Session expired - please log in again",
      code: "SESSION_EXPIRED",
    });
  }

  if (!hostId || typeof hostId !== "number") {
    return res.status(400).json({ error: "Invalid hostId" });
  }

  try {
    hostPollCache.invalidate(hostId);
    const host = await fetchHostById(hostId, userId);
    if (host) {
      connectionPool.clearKeyConnections(getPoolKey(host));

      await pollingManager.startPollingForHost(host);
      res.json({ message: "Host polling started" });
    } else {
      res.status(404).json({ error: "Host not found" });
    }
  } catch (error) {
    statsLogger.error("Failed to start polling for host", error, {
      operation: "host_updated",
      hostId,
      userId,
    });
    res.status(500).json({ error: "Failed to start polling" });
  }
});

/**
 * @openapi
 * /host-deleted:
 *   post:
 *     summary: Stop polling for deleted host
 *     description: Stops polling for a specific host after it has been deleted.
 *     tags:
 *       - Host Metrics
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               hostId:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Host polling stopped.
 *       400:
 *         description: Invalid hostId.
 *       401:
 *         description: Session expired - please log in again.
 *       500:
 *         description: Failed to stop polling.
 */
app.post("/host-deleted", async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  const { hostId, scopeUserId } = req.body;

  if (DataCrypto.getUserDataKey(userId) === null) {
    return res.status(401).json({
      error: "Session expired - please log in again",
      code: "SESSION_EXPIRED",
    });
  }

  if (!hostId || typeof hostId !== "number") {
    return res.status(400).json({ error: "Invalid hostId" });
  }
  if (
    scopeUserId !== undefined &&
    (typeof scopeUserId !== "string" || !scopeUserId.trim())
  ) {
    return res.status(400).json({ error: "Invalid scopeUserId" });
  }

  try {
    const targetUserId = scopeUserId || userId;
    if (targetUserId !== userId && !(await permissionManager.isAdmin(userId))) {
      return res.status(403).json({ error: "Admin access required" });
    }
    pollingManager.stopPollingForUserHost(hostId, targetUserId);
    res.json({ message: "Host polling stopped" });
  } catch (error) {
    statsLogger.error("Failed to stop polling for host", error, {
      operation: "host_deleted",
      hostId,
      userId,
      scopeUserId: scopeUserId || userId,
    });
    res.status(500).json({ error: "Failed to stop polling" });
  }
});

/**
 * @openapi
 * /metrics/{id}:
 *   get:
 *     summary: Get host metrics
 *     description: Retrieves current metrics for a specific host including CPU, memory, disk, network, processes, and system information.
 *     tags:
 *       - Host Metrics
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Host metrics data.
 *       401:
 *         description: Session expired - please log in again.
 *       404:
 *         description: Metrics not available.
 */
app.get("/metrics/:id", validateHostId, async (req, res) => {
  const id = Number(req.params.id);
  const userId = (req as AuthenticatedRequest).userId;
  const projectHostId = parseProjectHostId(req.query.projectHostId);
  if (projectHostId === null) {
    return res.status(400).json({ error: "Invalid projectHostId" });
  }

  if (DataCrypto.getUserDataKey(userId) === null) {
    return res.status(401).json({
      error: "Session expired - please log in again",
      code: "SESSION_EXPIRED",
    });
  }

  const access = await permissionManager.canAccessHost(
    userId,
    id,
    "connect",
    projectHostId,
  );
  if (!access.hasAccess) {
    return res.status(404).json({ error: "Metrics not available" });
  }

  const metricsData = pollingManager.getMetrics(id, userId, projectHostId);
  if (!metricsData) {
    return res.status(404).json({
      error: "Metrics not available",
      cpu: { percent: null, cores: null, load: null },
      memory: { percent: null, usedGiB: null, totalGiB: null },
      disk: {
        percent: null,
        usedHuman: null,
        totalHuman: null,
        availableHuman: null,
      },
      network: { interfaces: [] },
      uptime: { seconds: null, formatted: null },
      processes: { total: null, running: null, top: [] },
      system: { hostname: null, kernel: null, os: null },
      lastChecked: new Date().toISOString(),
    });
  }

  res.json({
    ...metricsData.data,
    lastChecked: new Date(metricsData.timestamp).toISOString(),
  });
});

/**
 * @openapi
 * /metrics/start/{id}:
 *   post:
 *     summary: Start metrics collection
 *     description: Establishes an SSH connection and starts collecting metrics for a specific host.
 *     tags:
 *       - Host Metrics
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Metrics collection started successfully, or TOTP required.
 *       401:
 *         description: Session expired - please log in again.
 *       404:
 *         description: Host not found.
 *       500:
 *         description: Failed to start metrics collection.
 */
app.post("/metrics/start/:id", validateHostId, async (req, res) => {
  const id = Number(req.params.id);
  const userId = (req as AuthenticatedRequest).userId;
  const projectHostId = parseProjectHostId(req.body?.projectHostId);

  const connectionLogs: Array<Omit<LogEntry, "id" | "timestamp">> = [];

  if (projectHostId === null) {
    return res.status(400).json({
      error: "Invalid projectHostId",
      connectionLogs,
    });
  }

  if (DataCrypto.getUserDataKey(userId) === null) {
    connectionLogs.push(
      createConnectionLog("error", "stats_connecting", "Session expired"),
    );
    return res.status(401).json({
      error: "Session expired - please log in again",
      code: "SESSION_EXPIRED",
      connectionLogs,
    });
  }

  try {
    const host = await fetchHostById(id, userId, projectHostId);
    if (!host) {
      connectionLogs.push(
        createConnectionLog("error", "stats_connecting", "Host not found"),
      );
      return res.status(404).json({ error: "Host not found", connectionLogs });
    }

    connectionLogs.push(
      createConnectionLog(
        "info",
        "stats_connecting",
        "Starting metrics collection",
      ),
    );

    connectionLogs.push(
      createConnectionLog("info", "dns", `Resolving DNS for ${host.ip}`),
    );

    connectionLogs.push(
      createConnectionLog(
        "info",
        "tcp",
        `Connecting to ${host.ip}:${host.port}`,
      ),
    );

    connectionLogs.push(
      createConnectionLog("info", "handshake", "Initiating SSH handshake"),
    );

    if (host.authType === "password") {
      connectionLogs.push(
        createConnectionLog("info", "auth", "Authenticating with password"),
      );
    } else if (host.authType === "key") {
      connectionLogs.push(
        createConnectionLog("info", "auth", "Authenticating with SSH key"),
      );
    }

    const sessionKey = getSessionKey(host.id, userId, projectHostId);

    const existingSession = metricsSessions[sessionKey];
    if (existingSession && existingSession.isConnected) {
      const viewerSessionId = `viewer-${crypto.randomUUID()}`;
      pollingManager.registerViewer(
        host.id,
        viewerSessionId,
        userId,
        projectHostId,
      );
      connectionLogs.push(
        createConnectionLog(
          "success",
          "stats_polling",
          "Using existing metrics session",
        ),
      );
      return res.json({ success: true, viewerSessionId, connectionLogs });
    }

    const config = await buildSshConfig(host);
    const client = new Client();

    if (host.authType === "opkssh" && host.userId) {
      const { getOPKSSHToken } = await import("../opkssh-auth.js");
      const token = await getOPKSSHToken(host.userId, host.id);
      if (!token) {
        connectionLogs.push(
          createConnectionLog(
            "error",
            "auth",
            "OPKSSH authentication required. Please open a Terminal connection first.",
          ),
        );
        return res.status(401).json({
          error: "OPKSSH authentication required",
          requiresOPKSSHAuth: true,
          connectionLogs,
        });
      }
      const { setupOPKSSHCertAuth } = await import("../opkssh-cert-auth.js");
      await setupOPKSSHCertAuth(config, client, token, host.username);
    } else if (host.authType === "vault") {
      const { setupVaultSshSignerAuth } =
        await import("../vault-ssh-connect.js");
      await setupVaultSshSignerAuth(config, client, host);
    }

    const connectionPromise = new Promise<{
      success: boolean;
      requires_totp?: boolean;
      sessionId?: string;
      prompt?: string;
      viewerSessionId?: string;
    }>((resolve, reject) => {
      let isResolved = false;

      const timeout = setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          client.end();
          reject(new Error("Connection timeout"));
        }
      }, 60000);

      client.on(
        "keyboard-interactive",
        (name, instructions, instructionsLang, prompts, finish) => {
          const totpPromptIndex = prompts.findIndex((p) =>
            /verification code|verification_code|token|otp|2fa|authenticator|google.*auth/i.test(
              p.prompt,
            ),
          );

          if (totpPromptIndex !== -1) {
            const sessionId = `totp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

            pendingTOTPSessions[sessionId] = {
              client,
              finish,
              config,
              createdAt: Date.now(),
              sessionId,
              hostId: host.id,
              projectHostId,
              userId,
              prompts: prompts.map((p) => ({
                prompt: p.prompt,
                echo: p.echo ?? false,
              })),
              totpPromptIndex,
              resolvedPassword: host.password,
              totpAttempts: 0,
            };

            connectionLogs.push(
              createConnectionLog(
                "info",
                "stats_totp",
                "TOTP verification required",
              ),
            );

            clearTimeout(timeout);
            if (!isResolved) {
              isResolved = true;
              resolve({
                success: false,
                requires_totp: true,
                sessionId,
                prompt: prompts[totpPromptIndex].prompt,
              });
            }
            return;
          } else {
            const responses = prompts.map((p) => {
              if (/password/i.test(p.prompt) && host.password) {
                return host.password;
              }
              return "";
            });
            finish(responses);
          }
        },
      );

      client.on("ready", () => {
        clearTimeout(timeout);
        if (!isResolved) {
          isResolved = true;

          connectionLogs.push(
            createConnectionLog(
              "success",
              "connected",
              "SSH connection established successfully",
            ),
          );

          connectionLogs.push(
            createConnectionLog(
              "success",
              "stats_polling",
              "Metrics session established",
            ),
          );

          metricsSessions[sessionKey] = {
            client,
            isConnected: true,
            lastActive: Date.now(),
            activeOperations: 0,
            hostId: host.id,
            projectHostId,
            userId,
          };
          scheduleMetricsSessionCleanup(sessionKey);

          const viewerSessionId = `viewer-${crypto.randomUUID()}`;
          pollingManager.registerViewer(
            host.id,
            viewerSessionId,
            userId,
            projectHostId,
          );

          resolve({ success: true, viewerSessionId });
        }
      });

      client.on("error", (error) => {
        clearTimeout(timeout);
        if (!isResolved) {
          isResolved = true;

          const errorMessage =
            error instanceof Error ? error.message : String(error);
          let errorStage: ConnectionStage;

          if (
            errorMessage.includes("ENOTFOUND") ||
            errorMessage.includes("getaddrinfo")
          ) {
            errorStage = "dns";
            connectionLogs.push(
              createConnectionLog(
                "error",
                errorStage,
                `DNS resolution failed: ${errorMessage}`,
              ),
            );
          } else if (
            errorMessage.includes("ECONNREFUSED") ||
            errorMessage.includes("ETIMEDOUT")
          ) {
            errorStage = "tcp";
            connectionLogs.push(
              createConnectionLog(
                "error",
                errorStage,
                `TCP connection failed: ${errorMessage}`,
              ),
            );
          } else if (
            errorMessage.includes("handshake") ||
            errorMessage.includes("key exchange")
          ) {
            errorStage = "handshake";
            connectionLogs.push(
              createConnectionLog(
                "error",
                errorStage,
                `SSH handshake failed: ${errorMessage}`,
              ),
            );
          } else if (
            errorMessage.includes("authentication") ||
            errorMessage.includes("Authentication")
          ) {
            errorStage = "auth";
            connectionLogs.push(
              createConnectionLog(
                "error",
                errorStage,
                `Authentication failed: ${errorMessage}`,
              ),
            );
          } else if (errorMessage.includes("verification failed")) {
            errorStage = "handshake";
            connectionLogs.push(
              createConnectionLog(
                "error",
                errorStage,
                `SSH host key has changed. For security, please open a Terminal connection to this host first to verify and accept the new key fingerprint.`,
              ),
            );
          } else {
            connectionLogs.push(
              createConnectionLog(
                "error",
                "error",
                `SSH connection failed: ${errorMessage}`,
              ),
            );
          }

          statsLogger.error("SSH connection error in metrics/start", {
            operation: "metrics_start_ssh_error",
            hostId: host.id,
            error: errorMessage,
          });
          reject(error);
        }
      });

      const hasJumpHosts =
        host.jumpHosts && host.jumpHosts.length > 0 && host.userId;

      if (hasJumpHosts) {
        connectionLogs.push(
          createConnectionLog(
            "info",
            "proxy",
            "Connecting via jump host chain",
          ),
        );
        createJumpHostChain(host.jumpHosts!, host.userId!)
          .then((jumpClient) => {
            jumpClient.forwardOut(
              "127.0.0.1",
              0,
              host.ip,
              host.port,
              (err, stream) => {
                if (err || !stream) {
                  if (!isResolved) {
                    isResolved = true;
                    clearTimeout(timeout);
                    reject(err || new Error("Jump host forward failed"));
                  }
                  return;
                }
                config.sock = stream;
                delete config.host;
                delete config.port;
                client.connect(config);
              },
            );
          })
          .catch((error) => {
            if (!isResolved) {
              isResolved = true;
              clearTimeout(timeout);
              connectionLogs.push(
                createConnectionLog(
                  "error",
                  "proxy",
                  `Jump host connection failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                ),
              );
              reject(error);
            }
          });
      } else if (
        host.useSocks5 &&
        (host.socks5Host ||
          (host.socks5ProxyChain && host.socks5ProxyChain.length > 0))
      ) {
        connectionLogs.push(
          createConnectionLog("info", "proxy", "Connecting via SOCKS5 proxy"),
        );
        createSocks5Connection(host.ip, host.port, {
          useSocks5: host.useSocks5,
          socks5Host: host.socks5Host,
          socks5Port: host.socks5Port,
          socks5Username: host.socks5Username,
          socks5Password: host.socks5Password,
          socks5ProxyChain: host.socks5ProxyChain,
        })
          .then((socks5Socket) => {
            if (socks5Socket) {
              config.sock = socks5Socket;
            }
            client.connect(config);
          })
          .catch((error) => {
            if (!isResolved) {
              isResolved = true;
              clearTimeout(timeout);
              connectionLogs.push(
                createConnectionLog(
                  "error",
                  "proxy",
                  `SOCKS5 proxy connection failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                ),
              );
              reject(error);
            }
          });
      } else {
        resolveSshConnectConfigHost(config)
          .then(() => {
            client.connect(config);
          })
          .catch((error) => {
            if (!isResolved) {
              isResolved = true;
              clearTimeout(timeout);
              reject(error);
            }
          });
      }
    });

    const result = await connectionPromise;
    res.json({ ...result, connectionLogs });
  } catch (error) {
    statsLogger.error("Failed to start metrics collection", {
      operation: "metrics_start_error",
      hostId: id,
      error: error instanceof Error ? error.message : String(error),
    });
    connectionLogs.push(
      createConnectionLog(
        "error",
        "stats_connecting",
        `Failed to start metrics: ${error instanceof Error ? error.message : "Unknown error"}`,
      ),
    );
    res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : "Failed to start metrics collection",
      connectionLogs,
    });
  }
});

/**
 * @openapi
 * /metrics/stop/{id}:
 *   post:
 *     summary: Stop metrics collection
 *     description: Stops metrics collection for a specific host and cleans up the SSH session.
 *     tags:
 *       - Host Metrics
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               viewerSessionId:
 *                 type: string
 *               totpSessionId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Metrics collection stopped successfully.
 *       401:
 *         description: Session expired - please log in again.
 *       500:
 *         description: Failed to stop metrics collection.
 */
app.post("/metrics/stop/:id", validateHostId, async (req, res) => {
  const id = Number(req.params.id);
  const userId = (req as AuthenticatedRequest).userId;
  const { viewerSessionId, totpSessionId } = req.body;
  const projectHostId = parseProjectHostId(req.body?.projectHostId);

  if (projectHostId === null) {
    return res.status(400).json({ error: "Invalid projectHostId" });
  }
  if (viewerSessionId !== undefined && typeof viewerSessionId !== "string") {
    return res.status(400).json({ error: "Invalid viewerSessionId" });
  }
  if (totpSessionId !== undefined && typeof totpSessionId !== "string") {
    return res.status(400).json({ error: "Invalid totpSessionId" });
  }

  if (DataCrypto.getUserDataKey(userId) === null) {
    return res.status(401).json({
      error: "Session expired - please log in again",
      code: "SESSION_EXPIRED",
    });
  }

  try {
    const access = await permissionManager.canAccessHost(
      userId,
      id,
      "connect",
      projectHostId,
    );
    if (!access.hasAccess) {
      return res.status(404).json({ error: "Metrics session not found" });
    }

    if (totpSessionId) {
      const pendingSession = pendingTOTPSessions[totpSessionId];
      if (
        !pendingSession ||
        pendingSession.userId !== userId ||
        pendingSession.hostId !== id ||
        pendingSession.projectHostId !== projectHostId
      ) {
        return res.status(404).json({ error: "Metrics session not found" });
      }
      try {
        pendingSession.client.end();
      } catch {
        // expected
      }
      delete pendingTOTPSessions[totpSessionId];
    }

    if (viewerSessionId) {
      const unregistered = pollingManager.unregisterViewer(
        id,
        viewerSessionId,
        userId,
        projectHostId,
      );
      if (!unregistered) {
        return res.status(404).json({ error: "Metrics session not found" });
      }
    }

    if (!pollingManager.hasActiveViewers(id, userId, projectHostId)) {
      const sessionKey = getSessionKey(id, userId, projectHostId);
      if (metricsSessions[sessionKey]) {
        cleanupMetricsSession(sessionKey);
      }
    }

    res.json({ success: true });
  } catch (error) {
    statsLogger.error("Failed to stop metrics collection", {
      operation: "metrics_stop_error",
      hostId: id,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : "Failed to stop metrics collection",
    });
  }
});

/**
 * @openapi
 * /metrics/connect-totp:
 *   post:
 *     summary: Complete TOTP verification for metrics
 *     description: Verifies the TOTP code and completes the metrics SSH connection.
 *     tags:
 *       - Host Metrics
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               sessionId:
 *                 type: string
 *               totpCode:
 *                 type: string
 *     responses:
 *       200:
 *         description: TOTP verified, metrics connection established.
 *       400:
 *         description: Missing sessionId or totpCode.
 *       401:
 *         description: Session expired or invalid TOTP code.
 *       404:
 *         description: TOTP session not found or expired.
 *       500:
 *         description: Failed to verify TOTP.
 */
app.post("/metrics/connect-totp", async (req, res) => {
  const { sessionId, totpCode } = req.body;
  const userId = (req as AuthenticatedRequest).userId;

  if (DataCrypto.getUserDataKey(userId) === null) {
    return res.status(401).json({
      error: "Session expired - please log in again",
      code: "SESSION_EXPIRED",
    });
  }

  if (!sessionId || !totpCode) {
    return res.status(400).json({ error: "Missing sessionId or totpCode" });
  }

  const session = pendingTOTPSessions[sessionId];
  if (!session) {
    return res.status(404).json({ error: "TOTP session not found or expired" });
  }

  if (Date.now() - session.createdAt > 180000) {
    delete pendingTOTPSessions[sessionId];
    try {
      session.client.end();
    } catch {
      // 资源可能已经关闭
    }
    return res.status(408).json({ error: "TOTP session timeout" });
  }

  if (session.userId !== userId) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  session.totpAttempts++;
  if (session.totpAttempts > 3) {
    delete pendingTOTPSessions[sessionId];
    try {
      session.client.end();
    } catch {
      // 资源可能已经关闭
    }
    return res.status(429).json({ error: "Too many TOTP attempts" });
  }

  try {
    const responses = (session.prompts || []).map((p, idx) => {
      if (idx === session.totpPromptIndex) {
        return totpCode.trim();
      } else if (/password/i.test(p.prompt) && session.resolvedPassword) {
        return session.resolvedPassword;
      }
      return "";
    });

    const connectionPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("TOTP verification timeout"));
      }, 30000);

      session.client.once(
        "keyboard-interactive",
        (name, instructions, instructionsLang, prompts, finish) => {
          statsLogger.warn("Second keyboard-interactive received after TOTP", {
            operation: "totp_second_keyboard_interactive",
            hostId: session.hostId,
            sessionId,
            prompts: prompts.map((p) => p.prompt),
          });
          const secondResponses = prompts.map((p) => {
            if (/password/i.test(p.prompt) && session.resolvedPassword) {
              return session.resolvedPassword;
            }
            return "";
          });
          finish(secondResponses);
        },
      );

      session.client.once("ready", () => {
        clearTimeout(timeout);
        resolve();
      });

      session.client.once("error", (error) => {
        clearTimeout(timeout);
        statsLogger.error("SSH client error after TOTP", {
          operation: "totp_client_error",
          hostId: session.hostId,
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        reject(error);
      });
    });

    session.finish(responses);

    await connectionPromise;

    const sessionKey = getSessionKey(
      session.hostId,
      userId,
      session.projectHostId,
    );
    metricsSessions[sessionKey] = {
      client: session.client,
      isConnected: true,
      lastActive: Date.now(),
      activeOperations: 0,
      hostId: session.hostId,
      projectHostId: session.projectHostId,
      userId,
    };
    scheduleMetricsSessionCleanup(sessionKey);

    delete pendingTOTPSessions[sessionId];

    const viewerSessionId = `viewer-${crypto.randomUUID()}`;
    pollingManager.registerViewer(
      session.hostId,
      viewerSessionId,
      userId,
      session.projectHostId,
    );

    res.json({ success: true, viewerSessionId });
  } catch (error) {
    statsLogger.error("TOTP verification failed", {
      operation: "totp_verification_failed",
      hostId: session.hostId,
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });

    if (session.totpAttempts >= 3) {
      delete pendingTOTPSessions[sessionId];
      try {
        session.client.end();
      } catch {
        // expected
      }
    }

    res.status(401).json({
      error: "TOTP verification failed",
      attemptsRemaining: Math.max(0, 3 - session.totpAttempts),
    });
  }
});

registerHostMetricsViewerRoutes(app, {
  fetchHostById,
  supportsMetrics: (host: SSHHostWithCredentials) => supportsMetrics(host),
  parseStatsConfig: (statsConfig: SSHHostWithCredentials["statsConfig"]) =>
    pollingManager.parseStatsConfig(statsConfig),
  updateHeartbeat: (viewerSessionId, userId) =>
    pollingManager.updateHeartbeat(viewerSessionId, userId),
  registerViewer: (hostId, viewerSessionId, userId, projectHostId) =>
    pollingManager.registerViewer(
      hostId,
      viewerSessionId,
      userId,
      projectHostId,
    ),
  unregisterViewer: (hostId, viewerSessionId, userId, projectHostId) =>
    pollingManager.unregisterViewer(
      hostId,
      viewerSessionId,
      userId,
      projectHostId,
    ),
});

registerHostMetricsSettingsRoutes(app, {
  requireAdmin,
  defaultStatsConfig: DEFAULT_STATS_CONFIG,
  refreshAllPolling: () => pollingManager.refreshAllPolling(),
});

registerHostMetricsPreferencesRoutes(app, {
  validateHostId,
  fetchHostById: async (hostId, userId, projectHostId) =>
    (await fetchHostById(hostId, userId, projectHostId)) ?? null,
  parseStatsConfig: (statsConfig) =>
    pollingManager.parseStatsConfig(
      statsConfig as string | StatsConfig | undefined,
    ),
  canAccessHost: async (userId, hostId, level, projectHostId) =>
    (
      await permissionManager.canAccessHost(
        userId,
        hostId,
        level,
        projectHostId,
      )
    ).hasAccess,
});

registerHostMetricsHistoryRoutes(app, {
  validateHostId,
  canAccessHost: async (userId, hostId, level, projectHostId) =>
    (
      await permissionManager.canAccessHost(
        userId,
        hostId,
        level,
        projectHostId,
      )
    ).hasAccess,
});

registerManagerRoutes(app, {
  validateHostId,
  runOnHost: async (hostId, userId, level, projectHostId, fn) => {
    const access = await permissionManager.canAccessHost(
      userId,
      hostId,
      level,
      projectHostId,
    );
    if (!access.hasAccess) {
      throw new AccessDeniedError();
    }
    const host = await fetchHostById(hostId, userId, projectHostId);
    if (!host) {
      throw new AccessDeniedError("Host not found");
    }
    // sudoPassword is encrypted with the owner's key; when the viewer is a
    // different user, re-fetch under the owner's key to decrypt it correctly.
    let sudoPassword = host.sudoPassword;
    if (host.userId && host.userId !== userId) {
      const ownerHost = await fetchHostById(hostId, host.userId);
      if (ownerHost) sudoPassword = ownerHost.sudoPassword;
    }
    const managerHost: ManagerHost = {
      id: host.id,
      userId: host.userId,
      sudoPassword,
      enableDocker: !!(host as { enableDocker?: boolean }).enableDocker,
    };
    return withSshConnection(host, (client) => fn(client, managerHost));
  },
});

// Internal endpoint — only accepts calls from localhost.
// Used by the main backend to notify the metrics service of SSH login events.
app.post("/internal/login-alert", async (req, res) => {
  const remoteIp = req.socket.remoteAddress;
  if (
    remoteIp !== "127.0.0.1" &&
    remoteIp !== "::1" &&
    remoteIp !== "::ffff:127.0.0.1"
  ) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const systemCrypto = (await import("../../utils/system-crypto.js"))
    .SystemCrypto;
  const expectedToken = await systemCrypto.getInstance().getInternalAuthToken();
  const token = req.headers["x-internal-auth"];
  if (!token || token !== expectedToken) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const { hostId, userId, sshUser, fromIp } = req.body as {
    hostId: number;
    userId: string;
    sshUser: string;
    fromIp: string;
  };
  AlertEngine.getInstance()
    .evaluateUserLogin(hostId, userId, sshUser, fromIp)
    .catch(() => {});
  res.json({ ok: true });
});

const PORT = 30005;
let maintenanceInterval: NodeJS.Timeout | null = null;
let shuttingDown = false;
const server = app.listen(PORT, async () => {
  try {
    await authManager.initialize();
  } catch (err) {
    statsLogger.error("Failed to initialize AuthManager", err, {
      operation: "auth_init_error",
    });
  }

  if (shuttingDown) return;
  maintenanceInterval = setInterval(
    () => {
      authFailureTracker.cleanup();
      pollingBackoff.cleanup();
    },
    10 * 60 * 1000,
  );
});

shutdownCleanupRegistry.register("host-metrics", async () => {
  shuttingDown = true;
  await closeHttpServer(server);
  if (maintenanceInterval) {
    clearInterval(maintenanceInterval);
    maintenanceInterval = null;
  }

  pollingManager.destroy();
  for (const [sessionId, session] of Object.entries(metricsSessions)) {
    clearTimeout(session.timeout);
    try {
      session.client.end();
    } catch {
      // expected
    }
    delete metricsSessions[sessionId];
  }

  for (const [sessionId, session] of Object.entries(pendingTOTPSessions)) {
    try {
      session.client.end();
    } catch {
      // expected
    }
    delete pendingTOTPSessions[sessionId];
  }
  connectionPool.destroy();
});
