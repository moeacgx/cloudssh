import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  authApi: { get: vi.fn(), post: vi.fn() },
  sshHostApi: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  invalidate: vi.fn(),
}));

vi.mock("@/main-axios", () => ({
  authApi: api.authApi,
  sshHostApi: api.sshHostApi,
  getAllServerStatuses: vi.fn(),
  handleApiError: (error: unknown) => error,
}));

vi.mock("@/lib/hosts-request-cache", () => ({
  getCachedSSHHosts: vi.fn(),
  invalidateHostsAndStatusCaches: api.invalidate,
}));

import {
  bulkImportSSHHosts,
  createSSHHost,
  exportAllSSHHosts,
  updateSSHHost,
} from "@/api/ssh-host-management-api";

const hostData = {
  name: "Production",
  ip: "203.0.113.10",
  port: 22,
  username: "root",
  authType: "none",
} as never;

describe("project-aware host creation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates and associates a host with the selected project atomically", async () => {
    const host = { id: 41, ...hostData };
    api.sshHostApi.post.mockResolvedValue({ data: host });

    await expect(createSSHHost(hostData, "team/project")).resolves.toEqual(
      host,
    );

    expect(api.sshHostApi.post).toHaveBeenCalledWith("/db/host", {
      ...hostData,
      projectId: "team/project",
    });
    expect(api.authApi.post).not.toHaveBeenCalled();
    expect(api.sshHostApi.delete).not.toHaveBeenCalled();
    expect(api.invalidate).toHaveBeenCalledOnce();
  });

  it("does not leave a client-side host when atomic creation fails", async () => {
    const failure = new Error("project denied");
    api.sshHostApi.post.mockRejectedValue(failure);

    await expect(createSSHHost(hostData, "project-2")).rejects.toBe(failure);

    expect(api.authApi.post).not.toHaveBeenCalled();
    expect(api.authApi.get).not.toHaveBeenCalled();
    expect(api.sshHostApi.delete).not.toHaveBeenCalled();
    expect(api.invalidate).not.toHaveBeenCalled();
  });

  it.each(["   ", "personal"])(
    "rejects unresolved project %j before sending the host",
    async (projectId) => {
      await expect(createSSHHost(hostData, projectId)).rejects.toThrow(
        "Workspace project ID has not been resolved by the control plane",
      );

      expect(api.sshHostApi.post).not.toHaveBeenCalled();
      expect(api.invalidate).not.toHaveBeenCalled();
    },
  );

  it("includes the selected project in private-key multipart creation", async () => {
    const host = { id: 43, ...hostData };
    api.sshHostApi.post.mockResolvedValue({ data: host });
    const keyData = {
      ...hostData,
      authType: "key",
      key: new File(["private-key"], "id_ed25519"),
    } as never;

    await expect(createSSHHost(keyData, "project-3")).resolves.toEqual(host);
    const request = api.sshHostApi.post.mock.calls[0];
    expect(request[0]).toBe("/db/host");
    expect(request[1]).toBeInstanceOf(FormData);
    const serialized = JSON.parse(
      (request[1] as FormData).get("data") as string,
    );
    expect(serialized).not.toHaveProperty("key");
    expect(serialized.projectId).toBe("project-3");
    expect(api.authApi.post).not.toHaveBeenCalled();
  });
});

describe("project-aware host update", () => {
  beforeEach(() => vi.clearAllMocks());

  it("submits host data and project metadata in one request", async () => {
    api.sshHostApi.put.mockResolvedValue({
      data: { id: 41, ...hostData },
    });

    await updateSSHHost(41, hostData, {
      projectId: "team/project",
      projectHostId: 73,
      alias: "生产入口",
      folder: "生产 / Web",
    });

    expect(api.sshHostApi.put).toHaveBeenCalledWith("/db/host/41", {
      ...hostData,
      projectContext: {
        projectId: "team/project",
        projectHostId: 73,
        alias: "生产入口",
        folder: "生产 / Web",
      },
    });
    expect(api.authApi.post).not.toHaveBeenCalled();
    expect(api.invalidate).toHaveBeenCalledOnce();
  });

  it("keeps the project context when updating an uploaded private key", async () => {
    api.sshHostApi.put.mockResolvedValue({
      data: { id: 41, ...hostData },
    });
    const keyData = {
      ...hostData,
      authType: "key",
      key: new File(["private-key"], "id_ed25519"),
    } as never;

    await updateSSHHost(41, keyData, {
      projectId: "project-1",
      projectHostId: 73,
      alias: null,
      folder: "生产",
    });

    const request = api.sshHostApi.put.mock.calls[0];
    expect(request[0]).toBe("/db/host/41");
    expect(request[1]).toBeInstanceOf(FormData);
    const serialized = JSON.parse(
      (request[1] as FormData).get("data") as string,
    );
    expect(serialized).not.toHaveProperty("key");
    expect(serialized.projectContext).toEqual({
      projectId: "project-1",
      projectHostId: 73,
      alias: null,
      folder: "生产",
    });
  });
});

describe("project-aware host import", () => {
  beforeEach(() => vi.clearAllMocks());

  it("associates every imported host with the selected project", async () => {
    api.sshHostApi.post.mockResolvedValue({
      data: {
        message: "ok",
        success: 1,
        updated: 1,
        skipped: 0,
        failed: 0,
        errors: [],
        createdHostIds: [51],
        updatedHostIds: [52],
      },
    });
    api.authApi.post.mockResolvedValue({ data: { server: {} } });

    const result = await bulkImportSSHHosts(
      [hostData],
      true,
      undefined,
      "team/project",
    );

    expect(result.associationFailed).toBe(0);
    expect(api.authApi.post).toHaveBeenNthCalledWith(
      1,
      "/control-plane/projects/team%2Fproject/servers",
      { hostId: 51, alias: null },
    );
    expect(api.authApi.post).toHaveBeenNthCalledWith(
      2,
      "/control-plane/projects/team%2Fproject/servers",
      { hostId: 52, alias: null },
    );
  });

  it("keeps imported data when project association cannot be confirmed", async () => {
    api.sshHostApi.post.mockResolvedValue({
      data: {
        message: "ok",
        success: 1,
        updated: 0,
        skipped: 0,
        failed: 0,
        errors: [],
        createdHostIds: [53],
        updatedHostIds: [],
      },
    });
    api.authApi.post.mockRejectedValue(new Error("project denied"));
    api.authApi.get.mockRejectedValue(new Error("network unavailable"));

    const result = await bulkImportSSHHosts(
      [hostData],
      false,
      undefined,
      "project-2",
    );

    expect(result).toMatchObject({
      success: 1,
      failed: 0,
      associationFailed: 1,
      createdHostIds: [53],
    });
    expect(api.sshHostApi.delete).not.toHaveBeenCalled();
  });
});

describe("project-scoped host export", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends only the current project's host ids", async () => {
    api.sshHostApi.get.mockResolvedValue({ data: { hosts: [] } });

    await exportAllSSHHosts({ hostIds: [7, 9] });

    expect(api.sshHostApi.get).toHaveBeenCalledWith("/db/hosts/export", {
      params: { hostIds: "7,9" },
    });
  });

  it("does not turn an empty project selection into an all-host export", async () => {
    api.sshHostApi.get.mockResolvedValue({ data: { hosts: [] } });

    await exportAllSSHHosts({ hostIds: [] });

    expect(api.sshHostApi.get).toHaveBeenCalledWith("/db/hosts/export", {
      params: { hostIds: "" },
    });
  });
});
