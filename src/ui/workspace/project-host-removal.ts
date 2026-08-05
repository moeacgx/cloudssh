export type WorkspaceHostRemovalScope = "current-project" | "all-projects";

export type WorkspaceHostRemovalMetadata = {
  linkedProjectCount: number;
  canDeleteFromAllProjects: boolean;
};

/**
 * 执行项目主机删除操作。
 *
 * “当前项目”是默认的安全范围；当主机只有这一条项目关联且当前用户
 * 是所有者时，解除当前关联与彻底删除的结果相同，因此自动调用全局
 * 删除接口，避免留下任何项目都看不到的孤儿主机。
 */
export async function removeWorkspaceHosts(input: {
  projectId: string;
  hostIds: string[];
  scope: WorkspaceHostRemovalScope;
  projectHostIdsByHostId: ReadonlyMap<string, number>;
  hostRemovalMetadataByHostId?: ReadonlyMap<
    string,
    WorkspaceHostRemovalMetadata
  >;
  deleteHost: (hostId: number) => Promise<unknown>;
  unlinkHost: (projectId: string, projectHostId: number) => Promise<unknown>;
}): Promise<void> {
  const hostIds = input.hostIds.map((hostId) => {
    const parsed = Number(hostId);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error("Host mapping is unavailable");
    }
    return { key: String(hostId), id: parsed };
  });

  if (input.scope === "all-projects") {
    const notAllowed = hostIds.find(
      ({ key }) =>
        input.hostRemovalMetadataByHostId?.get(key)
          ?.canDeleteFromAllProjects !== true,
    );
    if (notAllowed) {
      throw new Error("Only the host owner can delete from all projects");
    }
    await Promise.all(hostIds.map(({ id }) => input.deleteHost(id)));
    return;
  }

  const operations = hostIds.map(({ key, id }) => {
    const metadata = input.hostRemovalMetadataByHostId?.get(key);
    const isOnlyProject = (metadata?.linkedProjectCount ?? 2) <= 1;

    // 自有主机没有其他项目关联时，不能只删除关联后制造孤儿主机。
    if (metadata?.canDeleteFromAllProjects === true && isOnlyProject) {
      return { type: "delete" as const, hostId: id };
    }

    const projectHostId = input.projectHostIdsByHostId.get(key);
    if (projectHostId === undefined) {
      throw new Error("Project host mapping is unavailable");
    }
    return { type: "unlink" as const, projectHostId };
  });

  await Promise.all(
    operations.map((operation) =>
      operation.type === "delete"
        ? input.deleteHost(operation.hostId)
        : input.unlinkHost(input.projectId, operation.projectHostId),
    ),
  );
}
