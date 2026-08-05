import { describe, expect, it } from "vitest";
import {
  isAdministrativeTransportAllowed,
  isLoopbackAddress,
  trustLoopbackProxy,
} from "../../utils/trust-loopback-proxy.js";

describe("trustLoopbackProxy", () => {
  it("仅信任本机反向代理的第一跳", () => {
    expect(trustLoopbackProxy("127.0.0.1", 0)).toBe(true);
    expect(trustLoopbackProxy("::ffff:127.0.0.1", 0)).toBe(true);
    expect(trustLoopbackProxy("::1", 0)).toBe(true);
    expect(trustLoopbackProxy("127.0.0.1", 1)).toBe(false);
    expect(trustLoopbackProxy("198.51.100.10", 0)).toBe(false);
  });

  it("生产环境只允许 HTTPS 或本机管理员操作", () => {
    expect(
      isAdministrativeTransportAllowed(
        { secure: true, ip: "198.51.100.10" },
        "production",
      ),
    ).toBe(true);
    expect(
      isAdministrativeTransportAllowed(
        { secure: false, ip: "127.0.0.1" },
        "production",
      ),
    ).toBe(true);
    expect(
      isAdministrativeTransportAllowed(
        { secure: false, ip: "198.51.100.10" },
        "production",
      ),
    ).toBe(false);
    expect(
      isAdministrativeTransportAllowed(
        { secure: false, ip: "198.51.100.10" },
        "test",
      ),
    ).toBe(true);
  });

  it("只将回环地址识别为本机", () => {
    expect(isLoopbackAddress("127.0.0.5")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("172.18.0.1")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});
