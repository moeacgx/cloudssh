import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  authApi: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  sshHostApi: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@/main-axios", () => ({
  authApi: api.authApi,
  sshHostApi: api.sshHostApi,
  handleApiError: (error: unknown) => error,
}));

import {
  adminCopyUserHostSecret,
  adminCopyUserCredentialSecret,
  adminCreateUserHost,
  adminGetUserHostSecrets,
  adminUpdateUserHost,
} from "@/api/admin-user-data-api";

const hostData = {
  name: "Production",
  folder: "Linux / Web",
  ip: "203.0.113.10",
  port: 22,
  username: "root",
  authType: "password" as const,
  password: "secret",
};

describe("admin personal workspace host updates", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends host and project metadata in one request", async () => {
    api.sshHostApi.put.mockResolvedValue({
      data: { id: 41, ...hostData },
    });

    await expect(
      adminUpdateUserHost("user-1", 41, 73, hostData),
    ).resolves.toMatchObject({
      id: 41,
      projectHostId: 73,
      name: "Production",
      folder: "Linux / Web",
    });

    expect(api.sshHostApi.put).toHaveBeenCalledWith(
      "/db/host/41",
      { ...hostData, projectHostId: 73 },
      { headers: { "X-Admin-Target-User": "user-1" } },
    );
    expect(api.authApi.put).not.toHaveBeenCalled();
  });

  it("includes the personal project link in multipart key updates", async () => {
    const key = new File(["private-key"], "id_ed25519");
    api.sshHostApi.put.mockResolvedValue({
      data: { id: 42, ...hostData, authType: "key" },
    });

    await adminUpdateUserHost("user-1", 42, 74, {
      ...hostData,
      authType: "key",
      key,
    });

    const [, formData, options] = api.sshHostApi.put.mock.calls[0] as [
      string,
      FormData,
      { headers: Record<string, string> },
    ];
    expect(JSON.parse(String(formData.get("data")))).toMatchObject({
      name: "Production",
      projectHostId: 74,
    });
    expect(formData.get("key")).toBe(key);
    expect(options.headers).toEqual({
      "Content-Type": "multipart/form-data",
      "X-Admin-Target-User": "user-1",
    });
    expect(api.authApi.put).not.toHaveBeenCalled();
  });
});

describe("admin personal workspace host creation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the host endpoint's atomic personal-project association", async () => {
    api.authApi.get.mockResolvedValue({
      data: { project: { id: "personal/project" }, hosts: [] },
    });
    api.sshHostApi.post.mockResolvedValue({
      data: { id: 51, projectHostId: 81, ...hostData },
    });

    await expect(
      adminCreateUserHost("user-1", hostData),
    ).resolves.toMatchObject({ id: 51, projectHostId: 81 });

    expect(api.authApi.post).not.toHaveBeenCalled();
    expect(api.sshHostApi.delete).not.toHaveBeenCalled();
  });

  it("rejects a response that is missing the atomic project link", async () => {
    api.authApi.get.mockResolvedValue({
      data: { project: { id: "personal-1" }, hosts: [] },
    });
    api.sshHostApi.post.mockResolvedValue({ data: { id: 52, ...hostData } });

    await expect(adminCreateUserHost("user-1", hostData)).rejects.toThrow(
      "Host was not linked to the user's personal workspace",
    );
    expect(api.authApi.post).not.toHaveBeenCalled();
    expect(api.sshHostApi.delete).not.toHaveBeenCalled();
  });
});

describe("admin credential secret access", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requests one secret field for the selected target user", async () => {
    api.authApi.get.mockResolvedValue({ data: { value: "private-key" } });

    await expect(
      adminCopyUserCredentialSecret("user-1", 9, "key"),
    ).resolves.toBe("private-key");

    expect(api.authApi.get).toHaveBeenCalledWith(
      "/credentials/9/admin-secret",
      {
        headers: { "X-Admin-Target-User": "user-1" },
        params: { field: "key" },
      },
    );
  });
});

describe("admin host secret access", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the audited administrator view endpoint", async () => {
    api.sshHostApi.get.mockResolvedValue({
      data: { secrets: { password: "password", key: "private-key" } },
    });

    await expect(
      adminGetUserHostSecrets("user-1", 41, ["password", "key"]),
    ).resolves.toEqual({ password: "password", key: "private-key" });

    expect(api.sshHostApi.get).toHaveBeenCalledWith(
      "/db/host/41/admin-secrets",
      {
        headers: { "X-Admin-Target-User": "user-1" },
        params: { fields: "password,key" },
      },
    );
  });

  it("uses the audited administrator copy endpoint", async () => {
    api.sshHostApi.get.mockResolvedValue({ data: { value: "private-key" } });

    await expect(adminCopyUserHostSecret("user-1", 41, "key")).resolves.toBe(
      "private-key",
    );

    expect(api.sshHostApi.get).toHaveBeenCalledWith(
      "/db/host/41/admin-secret",
      {
        headers: { "X-Admin-Target-User": "user-1" },
        params: { field: "key" },
      },
    );
  });
});
