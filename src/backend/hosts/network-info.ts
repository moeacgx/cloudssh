import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { domainToASCII } from "node:url";
import type Database from "better-sqlite3";
import { getSqlite } from "../database/db/index.js";
import { DatabaseSaveTrigger } from "../utils/database-save-trigger.js";
import { databaseLogger } from "../utils/logger.js";
import { getProxyAgent } from "../utils/proxy-agent.js";

export type HostNetworkInfoStatus =
  | "pending"
  | "ready"
  | "private"
  | "failed"
  | "disabled";

export interface HostNetworkInfo {
  status: HostNetworkInfoStatus | "unknown";
  resolvedIp: string | null;
  countryCode: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  isp: string | null;
  asn: string | null;
  updatedAt: string | null;
}

interface HostNetworkInfoRow {
  id: number;
  ip: string;
  networkInfoStatus: string | null;
  networkLookupSource: string | null;
  networkResolvedIp: string | null;
  networkCountryCode: string | null;
  networkCountry: string | null;
  networkRegion: string | null;
  networkCity: string | null;
  networkIsp: string | null;
  networkAsn: string | null;
  networkInfoUpdatedAt: string | null;
}

interface ProviderNetworkInfo {
  countryCode: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  isp: string | null;
  asn: string | null;
}

export interface HostNetworkInfoServiceOptions {
  endpoint?: string | null;
  enabled?: boolean;
  requestTimeoutMs?: number;
  minimumRequestIntervalMs?: number;
  readyCacheMs?: number;
  privateCacheMs?: number;
  failedCacheMs?: number;
  now?: () => Date;
  resolveHostname?: (hostname: string) => Promise<string[]>;
  fetchProvider?: (url: string, timeoutMs: number) => Promise<unknown>;
  afterWrite?: () => Promise<void> | void;
}

interface QueueEntry {
  hostId: number;
  address: string;
  force: boolean;
}

const DEFAULT_ENDPOINT = "https://ipwho.is/{ip}";
const DAY_MS = 24 * 60 * 60 * 1000;

// Node 会把 IPv4 归一化成 IPv4-mapped IPv6；两类规则必须分开保存，
// 否则 IPv6 的保留网段可能误命中普通公网 IPv4。
const nonPublicIpv4Addresses = new BlockList();
const nonPublicIpv6Addresses = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  nonPublicIpv4Addresses.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:2::", 48],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  nonPublicIpv6Addresses.addSubnet(network, prefix, "ipv6");
}

function boundedNumber(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, Math.floor(parsed)))
    : fallback;
}

function cleanText(value: unknown, maxLength = 160): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const cleaned = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeCountryCode(value: unknown): string | null {
  const countryCode = cleanText(value, 2)?.toUpperCase() ?? null;
  return countryCode && /^[A-Z]{2}$/.test(countryCode) ? countryCode : null;
}

function normalizeAsn(value: unknown): string | null {
  const asn = cleanText(value, 32);
  if (!asn) return null;
  if (/^\d+$/.test(asn)) return `AS${asn}`;
  return /^AS\d+$/i.test(asn) ? asn.toUpperCase() : asn;
}

/**
 * 只允许将公网单播地址发送给地区查询服务。内网、环回、链路本地、
 * 文档保留地址及多播地址都在本地识别，不会发给第三方。
 */
export function isPublicIpAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return !nonPublicIpv4Addresses.check(address, "ipv4");
  if (version === 6) return !nonPublicIpv6Addresses.check(address, "ipv6");
  return false;
}

function normalizedHostName(address: string): string | null {
  const candidate = address.trim().replace(/\.$/, "");
  if (!candidate || candidate.length > 253 || /[\s/@\\]/.test(candidate)) {
    return null;
  }
  const ascii = domainToASCII(candidate).toLowerCase();
  if (!ascii || ascii.length > 253) return null;
  const labels = ascii.split(".");
  if (
    labels.some(
      (label) =>
        !label ||
        label.length > 63 ||
        !/^[a-z0-9-]+$/.test(label) ||
        label.startsWith("-") ||
        label.endsWith("-"),
    )
  ) {
    return null;
  }
  return ascii;
}

function providerInfoFromResponse(response: unknown): ProviderNetworkInfo {
  const root = asRecord(response);
  if (
    root.success === false ||
    String(root.status ?? "").toLowerCase() === "fail"
  ) {
    throw new Error("Network information provider rejected the lookup");
  }
  const connection = asRecord(root.connection);
  const info = {
    countryCode: normalizeCountryCode(
      root.country_code ?? root.countryCode ?? root.country_code2,
    ),
    country: cleanText(root.country, 120),
    region: cleanText(root.region ?? root.regionName, 120),
    city: cleanText(root.city, 120),
    isp: cleanText(
      connection.isp ?? root.isp ?? connection.org ?? root.org,
      200,
    ),
    asn: normalizeAsn(connection.asn ?? root.asn),
  } satisfies ProviderNetworkInfo;
  if (!info.country && !info.countryCode && !info.city && !info.isp) {
    throw new Error("Network information provider returned no useful data");
  }
  return info;
}

function responseNetworkInfo(
  row: Partial<HostNetworkInfoRow> | Record<string, unknown>,
): HostNetworkInfo {
  const lookupSource = cleanText(row.networkLookupSource, 255);
  const currentAddress = cleanText(
    row.ip ?? (row as Record<string, unknown>).address,
    255,
  );
  if (
    currentAddress &&
    (lookupSource !== currentAddress || row.networkInfoStatus === null)
  ) {
    // 主机地址修改和地区查询之间存在短暂异步窗口。旧地址的地区信息
    // 绝不能挂到新地址上，即便调用方尚未来得及触发下一次查询。
    return {
      status: "unknown",
      resolvedIp: null,
      countryCode: null,
      country: null,
      region: null,
      city: null,
      isp: null,
      asn: null,
      updatedAt: null,
    };
  }
  const rawStatus = row.networkInfoStatus;
  const status: HostNetworkInfo["status"] = [
    "pending",
    "ready",
    "private",
    "failed",
    "disabled",
  ].includes(String(rawStatus))
    ? (rawStatus as HostNetworkInfoStatus)
    : "unknown";
  return {
    status,
    resolvedIp: cleanText(row.networkResolvedIp, 64),
    countryCode: normalizeCountryCode(row.networkCountryCode),
    country: cleanText(row.networkCountry, 120),
    region: cleanText(row.networkRegion, 120),
    city: cleanText(row.networkCity, 120),
    isp: cleanText(row.networkIsp, 200),
    asn: cleanText(row.networkAsn, 32),
    updatedAt: cleanText(row.networkInfoUpdatedAt, 64),
  };
}

/** 将数据库字段稳定转换成 API 使用的 networkInfo 对象。 */
export function hostNetworkInfoFromRecord(
  row: Partial<HostNetworkInfoRow> | Record<string, unknown>,
): HostNetworkInfo {
  return responseNetworkInfo(row);
}

async function defaultResolveHostname(hostname: string): Promise<string[]> {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((result) => result.address);
}

async function defaultFetchProvider(
  url: string,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "error",
      headers: {
        Accept: "application/json",
        "User-Agent": "CloudSSH/network-info",
      },
      dispatcher: getProxyAgent(url),
    });
    if (!response.ok) {
      throw new Error(
        `Network information provider returned ${response.status}`,
      );
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export class HostNetworkInfoService {
  private readonly endpoint: string | null;
  private readonly enabled: boolean;
  private readonly requestTimeoutMs: number;
  private readonly minimumRequestIntervalMs: number;
  private readonly readyCacheMs: number;
  private readonly privateCacheMs: number;
  private readonly failedCacheMs: number;
  private readonly now: () => Date;
  private readonly resolveHostname: (hostname: string) => Promise<string[]>;
  private readonly fetchProvider: (
    url: string,
    timeoutMs: number,
  ) => Promise<unknown>;
  private readonly afterWrite: () => Promise<void> | void;
  private readonly queued = new Map<number, QueueEntry>();
  private draining = false;
  private lastProviderRequestAt = 0;
  private providerQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly sqlite: Database.Database,
    options: HostNetworkInfoServiceOptions = {},
  ) {
    this.endpoint =
      options.endpoint === undefined
        ? process.env.CLOUDSSH_NETWORK_INFO_ENDPOINT || DEFAULT_ENDPOINT
        : options.endpoint;
    this.enabled =
      options.enabled ?? process.env.CLOUDSSH_NETWORK_INFO_ENABLED !== "false";
    this.requestTimeoutMs =
      options.requestTimeoutMs ??
      boundedNumber(
        process.env.CLOUDSSH_NETWORK_INFO_TIMEOUT_MS,
        4_000,
        500,
        30_000,
      );
    this.minimumRequestIntervalMs =
      options.minimumRequestIntervalMs ??
      boundedNumber(
        process.env.CLOUDSSH_NETWORK_INFO_INTERVAL_MS,
        1_100,
        0,
        60_000,
      );
    this.readyCacheMs = options.readyCacheMs ?? 30 * DAY_MS;
    this.privateCacheMs = options.privateCacheMs ?? DAY_MS;
    this.failedCacheMs = options.failedCacheMs ?? 6 * 60 * 60 * 1000;
    this.now = options.now ?? (() => new Date());
    this.resolveHostname = options.resolveHostname ?? defaultResolveHostname;
    this.fetchProvider = options.fetchProvider ?? defaultFetchProvider;
    this.afterWrite =
      options.afterWrite ??
      (() => DatabaseSaveTrigger.triggerSave("host_network_info_update"));
  }

  queue(hostId: number, address: string, force = false): void {
    if (!Number.isSafeInteger(hostId) || hostId <= 0 || !address.trim()) return;
    this.queued.set(hostId, { hostId, address: address.trim(), force });
    this.kickDrain();
  }

  queueBackfill(limit = 5_000): number {
    const safeLimit = Math.min(25_000, Math.max(1, Math.floor(limit)));
    const rows = this.sqlite
      .prepare(
        `SELECT id, ip,
                network_info_status AS networkInfoStatus,
                network_lookup_source AS networkLookupSource,
                network_resolved_ip AS networkResolvedIp,
                network_country_code AS networkCountryCode,
                network_country AS networkCountry,
                network_region AS networkRegion,
                network_city AS networkCity,
                network_isp AS networkIsp,
                network_asn AS networkAsn,
                network_info_updated_at AS networkInfoUpdatedAt
           FROM ssh_data ORDER BY id LIMIT ?`,
      )
      .all(safeLimit) as HostNetworkInfoRow[];
    const stale = rows.filter((row) => !this.isFresh(row));
    if (stale.length === 0) return 0;

    const status: HostNetworkInfoStatus =
      this.enabled && this.endpoint ? "pending" : "disabled";
    const timestamp = this.now().toISOString();
    const markQueued = this.sqlite.prepare(
      `UPDATE ssh_data
          SET network_info_status = ?,
              network_lookup_source = ip,
              network_resolved_ip = NULL,
              network_country_code = NULL,
              network_country = NULL,
              network_region = NULL,
              network_city = NULL,
              network_isp = NULL,
              network_asn = NULL,
              network_info_updated_at = ?
        WHERE id = ? AND ip = ?`,
    );
    this.sqlite.transaction(() => {
      for (const row of stale) {
        markQueued.run(status, timestamp, row.id, row.ip);
      }
    })();
    void Promise.resolve(this.afterWrite()).catch((error) => {
      databaseLogger.warn("Unable to persist network information backfill", {
        operation: "host_network_info_backfill_save_failed",
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
    });

    // 先一次性标记所有条目，再启动串行查询。这样即使前一台主机查询
    // 较慢，任何项目页也能看到 pending 并自动刷新后续主机的结果。
    if (status === "pending") {
      for (const row of stale) this.queue(row.id, row.ip);
    }
    return stale.length;
  }

  async refreshNow(
    hostId: number,
    address: string,
    force = false,
  ): Promise<HostNetworkInfo | null> {
    const row = this.readRow(hostId);
    if (!row || row.ip !== address.trim()) return null;

    if (!this.enabled || !this.endpoint) {
      return this.persist(hostId, row.ip, "disabled", null, null);
    }
    if (!force && this.isFresh(row)) return responseNetworkInfo(row);

    await this.persist(hostId, row.ip, "pending", null, null);
    try {
      const resolvedIp = await this.resolvePublicAddress(row.ip);
      if (!resolvedIp) {
        return this.persist(hostId, row.ip, "private", null, null);
      }
      const providerInfo = await this.lookupProvider(resolvedIp);
      return this.persist(hostId, row.ip, "ready", resolvedIp, providerInfo);
    } catch (error) {
      databaseLogger.warn("Host network information lookup failed", {
        operation: "host_network_info_lookup_failed",
        hostId,
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      return this.persist(hostId, row.ip, "failed", null, null);
    }
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.queued.size > 0) {
        const entry = this.queued.values().next().value as
          | QueueEntry
          | undefined;
        if (!entry) break;
        this.queued.delete(entry.hostId);
        await this.refreshNow(entry.hostId, entry.address, entry.force);
      }
    } finally {
      this.draining = false;
      if (this.queued.size > 0) this.kickDrain();
    }
  }

  private kickDrain(): void {
    if (this.draining) return;
    void this.drain().catch((error) => {
      databaseLogger.warn("Host network information queue failed", {
        operation: "host_network_info_queue_failed",
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
    });
  }

  private readRow(hostId: number): HostNetworkInfoRow | null {
    return (
      (this.sqlite
        .prepare(
          `SELECT id, ip,
                  network_info_status AS networkInfoStatus,
                  network_lookup_source AS networkLookupSource,
                  network_resolved_ip AS networkResolvedIp,
                  network_country_code AS networkCountryCode,
                  network_country AS networkCountry,
                  network_region AS networkRegion,
                  network_city AS networkCity,
                  network_isp AS networkIsp,
                  network_asn AS networkAsn,
                  network_info_updated_at AS networkInfoUpdatedAt
             FROM ssh_data WHERE id = ?`,
        )
        .get(hostId) as HostNetworkInfoRow | undefined) ?? null
    );
  }

  private isFresh(row: HostNetworkInfoRow): boolean {
    if (row.networkLookupSource !== row.ip || !row.networkInfoUpdatedAt) {
      return false;
    }
    const updatedAt = Date.parse(row.networkInfoUpdatedAt);
    if (!Number.isFinite(updatedAt)) return false;
    const age = this.now().getTime() - updatedAt;
    if (age < 0) return false;
    if (row.networkInfoStatus === "ready") return age < this.readyCacheMs;
    if (row.networkInfoStatus === "private") return age < this.privateCacheMs;
    if (row.networkInfoStatus === "failed") return age < this.failedCacheMs;
    // 上次运行关闭查询后，管理员重新启用功能时必须立刻补查。
    if (row.networkInfoStatus === "disabled") return false;
    return false;
  }

  private async resolvePublicAddress(address: string): Promise<string | null> {
    const trimmed = address.trim().replace(/^\[|\]$/g, "");
    if (isIP(trimmed)) return isPublicIpAddress(trimmed) ? trimmed : null;

    const hostname = normalizedHostName(trimmed);
    if (!hostname) throw new Error("Invalid host address");
    const resolved = await this.resolveHostname(hostname);
    return (
      resolved.find(
        (candidate) => isIP(candidate) === 4 && isPublicIpAddress(candidate),
      ) ??
      resolved.find((candidate) => isPublicIpAddress(candidate)) ??
      null
    );
  }

  private providerUrl(ip: string): string {
    const endpoint = this.endpoint ?? "";
    const rendered = endpoint.includes("{ip}")
      ? endpoint.replaceAll("{ip}", encodeURIComponent(ip))
      : endpoint;
    const url = new URL(rendered);
    if (!endpoint.includes("{ip}")) url.searchParams.set("ip", ip);
    if (url.protocol !== "https:") {
      throw new Error("Network information endpoint must use HTTPS");
    }
    return url.toString();
  }

  private async lookupProvider(ip: string): Promise<ProviderNetworkInfo> {
    let result: ProviderNetworkInfo | undefined;
    let failure: unknown;
    const previous = this.providerQueue;
    this.providerQueue = previous
      .catch(() => undefined)
      .then(async () => {
        const waitMs = Math.max(
          0,
          this.lastProviderRequestAt +
            this.minimumRequestIntervalMs -
            Date.now(),
        );
        if (waitMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
        }
        this.lastProviderRequestAt = Date.now();
        try {
          result = providerInfoFromResponse(
            await this.fetchProvider(
              this.providerUrl(ip),
              this.requestTimeoutMs,
            ),
          );
        } catch (error) {
          failure = error;
        }
      });
    await this.providerQueue;
    if (failure) throw failure;
    if (!result) throw new Error("Network information lookup failed");
    return result;
  }

  private async persist(
    hostId: number,
    source: string,
    status: HostNetworkInfoStatus,
    resolvedIp: string | null,
    info: ProviderNetworkInfo | null,
  ): Promise<HostNetworkInfo | null> {
    const timestamp = this.now().toISOString();
    const result = this.sqlite
      .prepare(
        `UPDATE ssh_data
            SET network_info_status = ?,
                network_lookup_source = ?,
                network_resolved_ip = ?,
                network_country_code = ?,
                network_country = ?,
                network_region = ?,
                network_city = ?,
                network_isp = ?,
                network_asn = ?,
                network_info_updated_at = ?
          WHERE id = ? AND ip = ?`,
      )
      .run(
        status,
        source,
        resolvedIp,
        info?.countryCode ?? null,
        info?.country ?? null,
        info?.region ?? null,
        info?.city ?? null,
        info?.isp ?? null,
        info?.asn ?? null,
        timestamp,
        hostId,
        source,
      );
    if (result.changes === 0) return null;
    await this.afterWrite();
    const updated = this.readRow(hostId);
    return updated ? responseNetworkInfo(updated) : null;
  }
}

let currentService: HostNetworkInfoService | null = null;

export function getHostNetworkInfoService(): HostNetworkInfoService {
  currentService ??= new HostNetworkInfoService(getSqlite());
  return currentService;
}

export function queueHostNetworkInfoRefresh(
  hostId: number,
  address: string,
  force = false,
): void {
  try {
    getHostNetworkInfoService().queue(hostId, address, force);
  } catch (error) {
    // 地区信息属于辅助元数据，初始化或查询失败绝不能影响主机创建、编辑或连接。
    databaseLogger.warn("Unable to queue host network information", {
      operation: "host_network_info_queue_unavailable",
      hostId,
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

export function startHostNetworkInfoBackfill(): number {
  const limit = boundedNumber(
    process.env.CLOUDSSH_NETWORK_INFO_BACKFILL_LIMIT,
    5_000,
    1,
    25_000,
  );
  let queued = 0;
  try {
    queued = getHostNetworkInfoService().queueBackfill(limit);
  } catch (error) {
    databaseLogger.warn("Unable to queue host network information backfill", {
      operation: "host_network_info_backfill_unavailable",
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    return 0;
  }
  databaseLogger.info("Host network information backfill queued", {
    operation: "host_network_info_backfill",
    queued,
  });
  return queued;
}
