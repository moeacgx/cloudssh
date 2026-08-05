import { describe, expect, it, vi } from "vitest";
import { removeWorkspaceHosts } from "@/workspace/project-host-removal";

describe("removeWorkspaceHosts", () => {
  it("按明确范围从所有项目彻底删除自有主机", async () => {
    const deleteHost = vi.fn(async () => undefined);
    const unlinkHost = vi.fn(async () => undefined);

    await removeWorkspaceHosts({
      projectId: "personal-1",
      hostIds: ["7", "8"],
      scope: "all-projects",
      projectHostIdsByHostId: new Map([
        ["7", 70],
        ["8", 80],
      ]),
      hostRemovalMetadataByHostId: new Map([
        ["7", { linkedProjectCount: 2, canDeleteFromAllProjects: true }],
        ["8", { linkedProjectCount: 1, canDeleteFromAllProjects: true }],
      ]),
      deleteHost,
      unlinkHost,
    });

    expect(deleteHost).toHaveBeenCalledTimes(2);
    expect(deleteHost).toHaveBeenNthCalledWith(1, 7);
    expect(deleteHost).toHaveBeenNthCalledWith(2, 8);
    expect(unlinkHost).not.toHaveBeenCalled();
  });

  it("只解除共享主机在当前项目中的关联", async () => {
    const deleteHost = vi.fn(async () => undefined);
    const unlinkHost = vi.fn(async () => undefined);

    await removeWorkspaceHosts({
      projectId: "team-1",
      hostIds: ["7"],
      scope: "current-project",
      projectHostIdsByHostId: new Map([["7", 70]]),
      hostRemovalMetadataByHostId: new Map([
        ["7", { linkedProjectCount: 2, canDeleteFromAllProjects: true }],
      ]),
      deleteHost,
      unlinkHost,
    });

    expect(unlinkHost).toHaveBeenCalledWith("team-1", 70);
    expect(deleteHost).not.toHaveBeenCalled();
  });

  it("唯一项目关联的自有主机不会变成孤儿数据", async () => {
    const deleteHost = vi.fn(async () => undefined);
    const unlinkHost = vi.fn(async () => undefined);

    await removeWorkspaceHosts({
      projectId: "personal-1",
      hostIds: ["7"],
      scope: "current-project",
      projectHostIdsByHostId: new Map([["7", 70]]),
      hostRemovalMetadataByHostId: new Map([
        ["7", { linkedProjectCount: 1, canDeleteFromAllProjects: true }],
      ]),
      deleteHost,
      unlinkHost,
    });

    expect(deleteHost).toHaveBeenCalledWith(7);
    expect(unlinkHost).not.toHaveBeenCalled();
  });

  it("拒绝非所有者请求从所有项目删除", async () => {
    await expect(
      removeWorkspaceHosts({
        projectId: "team-1",
        hostIds: ["7"],
        scope: "all-projects",
        projectHostIdsByHostId: new Map([["7", 70]]),
        hostRemovalMetadataByHostId: new Map([
          ["7", { linkedProjectCount: 2, canDeleteFromAllProjects: false }],
        ]),
        deleteHost: vi.fn(async () => undefined),
        unlinkHost: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow("Only the host owner can delete from all projects");
  });

  it("项目关联过期时拒绝当前项目移除", async () => {
    await expect(
      removeWorkspaceHosts({
        projectId: "team-1",
        hostIds: ["7"],
        scope: "current-project",
        projectHostIdsByHostId: new Map(),
        hostRemovalMetadataByHostId: new Map([
          ["7", { linkedProjectCount: 2, canDeleteFromAllProjects: false }],
        ]),
        deleteHost: vi.fn(async () => undefined),
        unlinkHost: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow("Project host mapping is unavailable");
  });
});
