import Database from "better-sqlite3";
import {
  HostNetworkInfoService,
  hostNetworkInfoFromRecord,
  isPublicIpAddress,
} from "./network-info.js";

function createDatabase(ip = "8.8.8.8") {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE ssh_data (
      id INTEGER PRIMARY KEY,
      ip TEXT NOT NULL,
      network_info_status TEXT,
      network_lookup_source TEXT,
      network_resolved_ip TEXT,
      network_country_code TEXT,
      network_country TEXT,
      network_region TEXT,
      network_city TEXT,
      network_isp TEXT,
      network_asn TEXT,
      network_info_updated_at TEXT
    );
    INSERT INTO ssh_data (id, ip) VALUES (1, '${ip}');
  `);
  return sqlite;
}

describe("HostNetworkInfoService", () => {
  it("主机地址变化后不会短暂显示旧地址的地区信息", () => {
    expect(
      hostNetworkInfoFromRecord({
        ip: "1.1.1.1",
        networkInfoStatus: "ready",
        networkLookupSource: "8.8.8.8",
        networkResolvedIp: "8.8.8.8",
        networkCountryCode: "US",
        networkCountry: "United States",
        networkRegion: "California",
        networkCity: "Los Angeles",
        networkIsp: "Old ISP",
        networkAsn: "AS2914",
        networkInfoUpdatedAt: "2026-08-02T00:00:00.000Z",
      }),
    ).toEqual({
      status: "unknown",
      resolvedIp: null,
      countryCode: null,
      country: null,
      region: null,
      city: null,
      isp: null,
      asn: null,
      updatedAt: null,
    });
  });

  it("不会把内网、环回和保留地址发送给第三方", async () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.1.1",
      "192.0.2.1",
      "::1",
      "fc00::1",
      "fe80::1",
      "fec0::1",
      "64:ff9b:1::1",
      "2001:2::1",
      "2001:db8::1",
      "3fff::1",
    ]) {
      expect(isPublicIpAddress(address)).toBe(false);
    }
    expect(isPublicIpAddress("8.8.8.8")).toBe(true);
    expect(isPublicIpAddress("2606:4700:4700::1111")).toBe(true);

    const sqlite = createDatabase("10.0.0.8");
    const fetchProvider = vi.fn();
    const service = new HostNetworkInfoService(sqlite, {
      fetchProvider,
      minimumRequestIntervalMs: 0,
      afterWrite: () => undefined,
    });

    await expect(service.refreshNow(1, "10.0.0.8")).resolves.toMatchObject({
      status: "private",
      country: null,
      isp: null,
    });
    expect(fetchProvider).not.toHaveBeenCalled();
  });

  it("查询并规范化国家、城市、ISP 与 ASN", async () => {
    const sqlite = createDatabase();
    const writes = vi.fn();
    const fetchProvider = vi.fn(async () => ({
      success: true,
      country_code: "us",
      country: "United States",
      region: "California",
      city: "Los Angeles",
      connection: {
        asn: 2914,
        isp: "NTT America, Inc.",
      },
    }));
    const service = new HostNetworkInfoService(sqlite, {
      fetchProvider,
      minimumRequestIntervalMs: 0,
      afterWrite: writes,
      now: () => new Date("2026-08-02T00:00:00.000Z"),
    });

    const info = await service.refreshNow(1, "8.8.8.8");

    expect(info).toEqual({
      status: "ready",
      resolvedIp: "8.8.8.8",
      countryCode: "US",
      country: "United States",
      region: "California",
      city: "Los Angeles",
      isp: "NTT America, Inc.",
      asn: "AS2914",
      updatedAt: "2026-08-02T00:00:00.000Z",
    });
    expect(fetchProvider).toHaveBeenCalledWith(
      "https://ipwho.is/8.8.8.8",
      4_000,
    );
    expect(writes).toHaveBeenCalledTimes(2);
  });

  it("主机名只向查询服务发送解析后的公网 IP", async () => {
    const sqlite = createDatabase("ssh.example.com");
    const fetchProvider = vi.fn(async () => ({
      country_code: "JP",
      country: "Japan",
      city: "Tokyo",
      connection: { isp: "Example ISP" },
    }));
    const service = new HostNetworkInfoService(sqlite, {
      resolveHostname: async () => ["192.168.1.2", "203.0.113.5", "1.1.1.1"],
      fetchProvider,
      minimumRequestIntervalMs: 0,
      afterWrite: () => undefined,
    });

    const info = await service.refreshNow(1, "ssh.example.com");

    expect(info).toMatchObject({ status: "ready", resolvedIp: "1.1.1.1" });
    expect(fetchProvider).toHaveBeenCalledWith(
      "https://ipwho.is/1.1.1.1",
      4_000,
    );
  });

  it("缓存有效时不会重复访问外部服务，地址变化后会重新查询", async () => {
    const sqlite = createDatabase();
    let now = new Date("2026-08-02T00:00:00.000Z");
    const fetchProvider = vi.fn(async () => ({
      country_code: "US",
      country: "United States",
      connection: { isp: "Example ISP" },
    }));
    const service = new HostNetworkInfoService(sqlite, {
      fetchProvider,
      minimumRequestIntervalMs: 0,
      afterWrite: () => undefined,
      now: () => now,
    });

    await service.refreshNow(1, "8.8.8.8");
    now = new Date("2026-08-03T00:00:00.000Z");
    await service.refreshNow(1, "8.8.8.8");
    expect(fetchProvider).toHaveBeenCalledTimes(1);

    sqlite.prepare("UPDATE ssh_data SET ip = ? WHERE id = 1").run("1.1.1.1");
    await service.refreshNow(1, "1.1.1.1");
    expect(fetchProvider).toHaveBeenCalledTimes(2);
  });

  it("启动回填会先把所有待查主机标为查询中", async () => {
    const sqlite = createDatabase();
    sqlite
      .prepare("INSERT INTO ssh_data (id, ip) VALUES (2, ?)")
      .run("1.1.1.1");
    let releaseFirst!: () => void;
    const firstLookup = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fetchProvider = vi.fn(async () => {
      if (fetchProvider.mock.calls.length === 1) await firstLookup;
      return {
        country_code: "US",
        country: "United States",
        connection: { isp: "Example ISP" },
      };
    });
    const service = new HostNetworkInfoService(sqlite, {
      fetchProvider,
      minimumRequestIntervalMs: 0,
      afterWrite: () => undefined,
    });

    expect(service.queueBackfill()).toBe(2);
    expect(
      sqlite
        .prepare(
          "SELECT id, network_info_status AS status FROM ssh_data ORDER BY id",
        )
        .all(),
    ).toEqual([
      { id: 1, status: "pending" },
      { id: 2, status: "pending" },
    ]);

    releaseFirst();
    await vi.waitFor(() => {
      expect(fetchProvider).toHaveBeenCalledTimes(2);
      expect(
        sqlite
          .prepare(
            "SELECT network_info_status AS status FROM ssh_data ORDER BY id",
          )
          .all(),
      ).toEqual([{ status: "ready" }, { status: "ready" }]);
    });
    sqlite.close();
  });

  it("外部服务失败只记录失败状态，不阻断主机功能", async () => {
    const sqlite = createDatabase();
    const service = new HostNetworkInfoService(sqlite, {
      fetchProvider: async () => {
        throw new Error("offline");
      },
      minimumRequestIntervalMs: 0,
      afterWrite: () => undefined,
    });

    await expect(service.refreshNow(1, "8.8.8.8")).resolves.toMatchObject({
      status: "failed",
      country: null,
      isp: null,
    });
  });

  it("拒绝使用明文 HTTP 的地区查询服务", async () => {
    const sqlite = createDatabase();
    const fetchProvider = vi.fn();
    const service = new HostNetworkInfoService(sqlite, {
      endpoint: "http://geo.example.test/{ip}",
      fetchProvider,
      minimumRequestIntervalMs: 0,
      afterWrite: () => undefined,
    });

    await expect(service.refreshNow(1, "8.8.8.8")).resolves.toMatchObject({
      status: "failed",
    });
    expect(fetchProvider).not.toHaveBeenCalled();
  });

  it("查询服务请求禁止跟随重定向", async () => {
    const sqlite = createDatabase();
    const fetchProvider = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.redirect).toBe("error");
        return new Response(
          JSON.stringify({
            country_code: "US",
            country: "United States",
            connection: { isp: "Example ISP" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    );
    vi.stubGlobal("fetch", fetchProvider);
    try {
      const service = new HostNetworkInfoService(sqlite, {
        minimumRequestIntervalMs: 0,
        afterWrite: () => undefined,
      });

      await expect(service.refreshNow(1, "8.8.8.8")).resolves.toMatchObject({
        status: "ready",
      });
      expect(fetchProvider).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
      sqlite.close();
    }
  });
});
