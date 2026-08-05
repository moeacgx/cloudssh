import { describe, expect, it } from "vitest";
import type { HostNetworkInfo } from "@/types/index";
import {
  countryText,
  hasPendingHostNetworkInfo,
  ispText,
  locationText,
} from "@/lib/host-network-info";

const translations: Record<string, string> = {
  "hosts.networkPrivate": "内网地址",
  "hosts.networkLookupPending": "正在识别…",
  "hosts.networkUnknown": "未知",
  "hosts.networkNotApplicable": "不适用",
};
const t = (key: string) => translations[key] ?? key;

function networkInfo(patch: Partial<HostNetworkInfo> = {}): HostNetworkInfo {
  return {
    status: "ready",
    resolvedIp: "198.51.100.42",
    countryCode: "us",
    country: "United States",
    region: "California",
    city: "Los Angeles",
    isp: "NTT America, Inc.",
    asn: "AS2914",
    updatedAt: "2026-08-02T00:00:00.000Z",
    ...patch,
  };
}

describe("主机地区与 ISP 展示", () => {
  it("按国家代码、国家和城市生成截图所需格式", () => {
    const info = networkInfo();
    expect(countryText(info)).toBe("US United States");
    expect(locationText(info, t)).toBe("US United States · Los Angeles");
    expect(ispText(info, t)).toBe("NTT America, Inc.");
  });

  it("城市缺失时回退到地区", () => {
    expect(locationText(networkInfo({ city: null }), t)).toBe(
      "US United States · California",
    );
  });

  it("明确区分内网、查询中和失败状态", () => {
    expect(locationText(networkInfo({ status: "private" }), t)).toBe(
      "内网地址",
    );
    expect(ispText(networkInfo({ status: "private" }), t)).toBe("不适用");
    expect(locationText(networkInfo({ status: "pending" }), t)).toBe(
      "正在识别…",
    );
    expect(ispText(networkInfo({ status: "failed" }), t)).toBe("未知");
    expect(locationText(networkInfo({ status: "unknown" }), t)).toBe("未知");
    expect(ispText(networkInfo({ status: "unknown" }), t)).toBe("未知");
  });

  it("只在后端明确返回待查询状态时启用自动刷新", () => {
    expect(hasPendingHostNetworkInfo([{}])).toBe(false);
    expect(
      hasPendingHostNetworkInfo([
        { networkInfo: networkInfo({ status: "pending" }) },
      ]),
    ).toBe(true);
    expect(
      hasPendingHostNetworkInfo([
        { networkInfo: networkInfo({ status: "ready" }) },
      ]),
    ).toBe(false);
  });
});
