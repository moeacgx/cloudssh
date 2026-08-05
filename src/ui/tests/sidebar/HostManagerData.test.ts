import { describe, expect, it } from "vitest";

import type { SSHHostWithStatus } from "@/main-axios";
import { sshHostToHost } from "../../sidebar/HostManagerData";

function rawHost(
  overrides: Partial<SSHHostWithStatus> = {},
): SSHHostWithStatus {
  return {
    id: 1,
    name: "测试主机",
    ip: "192.0.2.10",
    port: 22,
    username: "root",
    folder: "",
    tags: [],
    pin: false,
    authType: "password",
    enableTerminal: true,
    enableSessionLogging: true,
    enableCommandHistory: true,
    enableTunnel: false,
    enableFileManager: true,
    enableDocker: false,
    enableProxmox: false,
    enableTmuxMonitor: false,
    showTerminalInSidebar: false,
    showFileManagerInSidebar: false,
    showTunnelInSidebar: false,
    showDockerInSidebar: false,
    showServerStatsInSidebar: false,
    defaultPath: "/",
    tunnelConnections: [],
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    status: "unknown",
    ...overrides,
  } as SSHHostWithStatus;
}

describe("sshHostToHost", () => {
  it("保留服务端返回的 SSH 密码已保存标记", () => {
    const host = sshHostToHost(rawHost({ hasPassword: true }));

    expect(host.hasPassword).toBe(true);
    expect(host.password).toBeUndefined();
  });

  it("保留项目共享数量和彻底删除权限", () => {
    const host = sshHostToHost(
      rawHost({
        linkedProjectCount: 3,
        canDeleteFromAllProjects: true,
      } as never),
    );

    expect(host.linkedProjectCount).toBe(3);
    expect(host.canDeleteFromAllProjects).toBe(true);
  });

  it("只把数组形式的端口敲门配置传入连接层", () => {
    expect(
      sshHostToHost(
        rawHost({
          portKnockSequence: '[{"port":4000,"protocol":"tcp"}]',
        } as never),
      ).portKnockSequence,
    ).toEqual([{ port: 4000, protocol: "tcp" }]);

    expect(
      sshHostToHost(rawHost({ portKnockSequence: { port: 4000 } } as never))
        .portKnockSequence,
    ).toEqual([]);
  });
});
