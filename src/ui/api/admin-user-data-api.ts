import { authApi, handleApiError, sshHostApi } from "@/main-axios";
import type { SSHHost, SSHHostData } from "@/types/index";

// ADMIN USER DATA MANAGEMENT
// ============================================================================
// Wrappers over the regular data-plane endpoints that act on another user's
// data via the X-Admin-Target-User header (admin only, audited server-side).
// They intentionally bypass the host request caches: the data belongs to the
// target user, not the signed-in admin.

const ADMIN_TARGET_USER_HEADER = "X-Admin-Target-User";

function adminHeaders(targetUserId: string): Record<string, string> {
  return { [ADMIN_TARGET_USER_HEADER]: targetUserId };
}

export async function adminGetUserHosts(
  targetUserId: string,
): Promise<SSHHost[]> {
  try {
    const [response, workspace] = await Promise.all([
      sshHostApi.get("/db/host", {
        headers: adminHeaders(targetUserId),
      }),
      authApi.get(
        `/control-plane/admin/users/${encodeURIComponent(targetUserId)}/personal-project`,
      ),
    ]);
    const links = new Map<
      number,
      {
        projectHostId: number;
        folder: string | null;
        alias: string | null;
      }
    >(
      (Array.isArray(workspace.data?.hosts) ? workspace.data.hosts : []).map(
        (link: {
          projectHostId: number;
          hostId: number;
          folder: string | null;
          alias: string | null;
        }) => [Number(link.hostId), link],
      ),
    );
    return (Array.isArray(response.data) ? response.data : [])
      .filter((host: SSHHost) => links.has(Number(host.id)))
      .map((host: SSHHost) => {
        const link = links.get(Number(host.id));
        return {
          ...host,
          projectHostId: link?.projectHostId,
          name: link?.alias || host.name,
          folder: link?.folder ?? null,
        };
      });
  } catch (error) {
    throw handleApiError(error, "fetch user's hosts");
  }
}

export async function adminCreateUserHost(
  targetUserId: string,
  hostData: SSHHostData,
): Promise<SSHHost> {
  let createdHost: SSHHost | null = null;
  try {
    const workspace = await authApi.get(
      `/control-plane/admin/users/${encodeURIComponent(targetUserId)}/personal-project`,
    );
    const projectId = workspace.data?.project?.id;
    if (typeof projectId !== "string" || !projectId) {
      throw new Error("Personal workspace is unavailable");
    }

    if (hostData.authType === "key" && hostData.key instanceof File) {
      const formData = new FormData();
      formData.append("key", hostData.key);
      const dataWithoutFile = { ...hostData, key: undefined };
      formData.append("data", JSON.stringify(dataWithoutFile));
      const response = await sshHostApi.post("/db/host", formData, {
        headers: {
          "Content-Type": "multipart/form-data",
          ...adminHeaders(targetUserId),
        },
      });
      createdHost = response.data;
    } else {
      const response = await sshHostApi.post("/db/host", hostData, {
        headers: adminHeaders(targetUserId),
      });
      createdHost = response.data;
    }

    if (
      !createdHost ||
      !Number.isSafeInteger(Number(createdHost.projectHostId)) ||
      Number(createdHost.projectHostId) <= 0
    ) {
      throw new Error("Host was not linked to the user's personal workspace");
    }
    return createdHost;
  } catch (error) {
    throw handleApiError(error, "create host for user");
  }
}

export async function adminUpdateUserHost(
  targetUserId: string,
  hostId: number,
  projectHostId: number,
  hostData: SSHHostData,
): Promise<SSHHost> {
  try {
    if (!Number.isSafeInteger(projectHostId) || projectHostId <= 0) {
      throw new Error("Personal workspace host link is missing");
    }
    const updateData = { ...hostData, projectHostId };
    let saved: SSHHost;
    if (hostData.authType === "key" && hostData.key instanceof File) {
      const formData = new FormData();
      formData.append("key", hostData.key);
      const dataWithoutFile = { ...updateData, key: undefined };
      formData.append("data", JSON.stringify(dataWithoutFile));
      const response = await sshHostApi.put(`/db/host/${hostId}`, formData, {
        headers: {
          "Content-Type": "multipart/form-data",
          ...adminHeaders(targetUserId),
        },
      });
      saved = response.data;
    } else {
      const response = await sshHostApi.put(`/db/host/${hostId}`, updateData, {
        headers: adminHeaders(targetUserId),
      });
      saved = response.data;
    }
    const alias = hostData.name?.trim() || null;
    const folder = hostData.folder?.trim() || null;
    return {
      ...saved,
      projectHostId,
      name: alias || saved.name,
      folder: folder ?? "",
    };
  } catch (error) {
    throw handleApiError(error, "update user's host");
  }
}

export async function adminDeleteUserHost(
  targetUserId: string,
  hostId: number,
): Promise<Record<string, unknown>> {
  try {
    const workspace = await authApi.get(
      `/control-plane/admin/users/${encodeURIComponent(targetUserId)}/personal-project`,
    );
    const link = (
      Array.isArray(workspace.data?.hosts) ? workspace.data.hosts : []
    ).find(
      (candidate: { hostId?: unknown }) => Number(candidate.hostId) === hostId,
    ) as { projectHostId?: unknown } | undefined;
    const projectHostId = Number(link?.projectHostId);
    if (!Number.isSafeInteger(projectHostId) || projectHostId <= 0) {
      throw new Error("Host is not in the user's personal workspace");
    }
    const response = await authApi.delete(
      `/control-plane/admin/users/${encodeURIComponent(targetUserId)}/personal-project/hosts/${projectHostId}`,
    );
    return response.data;
  } catch (error) {
    throw handleApiError(error, "delete user's host");
  }
}

export type AdminHostSecretField =
  | "password"
  | "sudoPassword"
  | "rdpPassword"
  | "vncPassword"
  | "telnetPassword"
  | "key"
  | "keyPassword";

export async function adminGetUserHostSecrets(
  targetUserId: string,
  hostId: number,
  fields: AdminHostSecretField[],
): Promise<Partial<Record<AdminHostSecretField, string>>> {
  try {
    const response = await sshHostApi.get(`/db/host/${hostId}/admin-secrets`, {
      headers: adminHeaders(targetUserId),
      params: { fields: fields.join(",") },
    });
    return response.data?.secrets ?? {};
  } catch (error) {
    throw handleApiError(error, "view user's host secrets");
  }
}

export async function adminCopyUserHostSecret(
  targetUserId: string,
  hostId: number,
  field: AdminHostSecretField,
): Promise<string> {
  try {
    const response = await sshHostApi.get(`/db/host/${hostId}/admin-secret`, {
      headers: adminHeaders(targetUserId),
      params: { field },
    });
    if (typeof response.data?.value !== "string") {
      throw new Error("Host secret is unavailable");
    }
    return response.data.value;
  } catch (error) {
    throw handleApiError(error, "copy user's host secret");
  }
}

export async function adminGetUserCredentials(
  targetUserId: string,
): Promise<Record<string, unknown>[] | Record<string, unknown>> {
  try {
    const response = await authApi.get("/credentials", {
      headers: adminHeaders(targetUserId),
    });
    return response.data;
  } catch (error) {
    throw handleApiError(error, "fetch user's credentials");
  }
}

export async function adminGetUserCredentialDetails(
  targetUserId: string,
  credentialId: number,
): Promise<Record<string, unknown>> {
  try {
    const response = await authApi.get(`/credentials/${credentialId}`, {
      headers: adminHeaders(targetUserId),
    });
    return response.data;
  } catch (error) {
    throw handleApiError(error, "fetch user's credential details");
  }
}

export async function adminCopyUserCredentialSecret(
  targetUserId: string,
  credentialId: number,
  field: "password" | "key" | "keyPassword",
): Promise<string> {
  try {
    const response = await authApi.get(
      `/credentials/${credentialId}/admin-secret`,
      {
        headers: adminHeaders(targetUserId),
        params: { field },
      },
    );
    if (typeof response.data?.value !== "string") {
      throw new Error("Credential secret is unavailable");
    }
    return response.data.value;
  } catch (error) {
    throw handleApiError(error, "copy user's credential secret");
  }
}

export async function adminCreateUserCredential(
  targetUserId: string,
  credentialData: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    const response = await authApi.post("/credentials", credentialData, {
      headers: adminHeaders(targetUserId),
    });
    return response.data;
  } catch (error) {
    throw handleApiError(error, "create credential for user");
  }
}

export async function adminUpdateUserCredential(
  targetUserId: string,
  credentialId: number,
  credentialData: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    const response = await authApi.put(
      `/credentials/${credentialId}`,
      credentialData,
      { headers: adminHeaders(targetUserId) },
    );
    return response.data;
  } catch (error) {
    throw handleApiError(error, "update user's credential");
  }
}

export async function adminDeleteUserCredential(
  targetUserId: string,
  credentialId: number,
): Promise<Record<string, unknown>> {
  try {
    const response = await authApi.delete(`/credentials/${credentialId}`, {
      headers: adminHeaders(targetUserId),
    });
    return response.data;
  } catch (error) {
    throw handleApiError(error, "delete user's credential");
  }
}

export async function adminGetUserSnippets(
  targetUserId: string,
): Promise<Record<string, unknown>> {
  try {
    const response = await authApi.get("/snippets", {
      headers: adminHeaders(targetUserId),
    });
    return response.data;
  } catch (error) {
    throw handleApiError(error, "fetch user's snippets");
  }
}

export async function adminCreateUserSnippet(
  targetUserId: string,
  snippetData: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    const response = await authApi.post("/snippets", snippetData, {
      headers: adminHeaders(targetUserId),
    });
    return response.data;
  } catch (error) {
    throw handleApiError(error, "create snippet for user");
  }
}

export async function adminUpdateUserSnippet(
  targetUserId: string,
  snippetId: number,
  snippetData: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    const response = await authApi.put(`/snippets/${snippetId}`, snippetData, {
      headers: adminHeaders(targetUserId),
    });
    return response.data;
  } catch (error) {
    throw handleApiError(error, "update user's snippet");
  }
}

export async function adminDeleteUserSnippet(
  targetUserId: string,
  snippetId: number,
): Promise<Record<string, unknown>> {
  try {
    const response = await authApi.delete(`/snippets/${snippetId}`, {
      headers: adminHeaders(targetUserId),
    });
    return response.data;
  } catch (error) {
    throw handleApiError(error, "delete user's snippet");
  }
}
