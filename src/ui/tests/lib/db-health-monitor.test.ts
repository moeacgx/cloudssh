import { afterEach, describe, expect, it, vi } from "vitest";
import { dbHealthMonitor } from "@/lib/db-health-monitor";

afterEach(() => dbHealthMonitor.reset());

describe("连接健康提示", () => {
  it("主动取消请求不等于服务器断线", () => {
    dbHealthMonitor.reportDatabaseError({
      code: "ERR_CANCELED",
      message: "request aborted",
    });
    expect(dbHealthMonitor.isDegraded()).toBe(false);
  });

  it("超时只触发一次异常，成功后才恢复", () => {
    const degraded = vi.fn();
    const restored = vi.fn();
    dbHealthMonitor.on("database-connection-degraded", degraded);
    dbHealthMonitor.on("database-connection-degraded-cleared", restored);
    try {
      dbHealthMonitor.reportDatabaseError({
        code: "ECONNABORTED",
        message: "timeout",
      });
      dbHealthMonitor.reportDatabaseError({ code: "ERR_NETWORK" });
      expect(dbHealthMonitor.isDegraded()).toBe(true);
      expect(degraded).toHaveBeenCalledTimes(1);
      dbHealthMonitor.reportDatabaseSuccess();
      expect(dbHealthMonitor.isDegraded()).toBe(false);
      expect(restored).toHaveBeenCalledTimes(1);
    } finally {
      dbHealthMonitor.off("database-connection-degraded", degraded);
      dbHealthMonitor.off("database-connection-degraded-cleared", restored);
    }
  });
});
