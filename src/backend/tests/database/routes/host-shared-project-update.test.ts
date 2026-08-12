import express from "express";
import type { Server } from "node:http";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  canAccessHost: vi.fn(),
  getProjectHostMetadataUpdateTarget: vi.fn(),
  isAdmin: vi.fn(),
  logAudit: vi.fn(),
  sshError: vi.fn(),
  updateNonSensitiveForUserWithProjectMetadata: vi.fn(),
}));

vi.mock("axios", () => ({
  default: {
    post: vi.fn(() => Promise.resolve({ data: {} })),
  },
}));

vi.mock("../../../utils/auth-manager.js", () => ({
  AuthManager: {
    getInstance: () => ({
      createAuthMiddleware:
        () =>
        (
          req: express.Request & {
            userId?: string;
            user?: { id: string; username: string; isAdmin: boolean };
          },
          _res: express.Response,
          next: express.NextFunction,
        ) => {
          req.userId = "project-admin";
          req.user = {
            id: "project-admin",
            username: "project-admin",
            isAdmin: false,
          };
          next();
        },
      createDataAccessMiddleware:
        () =>
        (
          _req: express.Request,
          _res: express.Response,
          next: express.NextFunction,
        ) =>
          next(),
    }),
  },
}));

vi.mock("../../../utils/permission-manager.js", () => ({
  PermissionManager: {
    getInstance: () => ({
      canAccessHost: state.canAccessHost,
      isAdmin: state.isAdmin,
    }),
  },
}));

vi.mock("../../../utils/data-crypto.js", () => ({
  DataCrypto: {
    getUserDataKey: vi.fn(() => {
      throw new Error("owner DEK should not be required");
    }),
    validateUserAccess: vi.fn(() => {
      throw new Error("owner DEK should not be required");
    }),
    decryptRecord: vi.fn(),
  },
}));

vi.mock("../../../utils/audit-logger.js", () => ({
  getAuditActorContext: () => ({ actorUserId: "project-admin" }),
  getRequestMeta: () => ({ ipAddress: "127.0.0.1", userAgent: "test" }),
  logAudit: state.logAudit,
  logAuditOrThrow: vi.fn(),
}));
vi.mock("../../../utils/logger.js", () => ({
  sshLogger: {
    error: state.sshError,
    warn: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
  databaseLogger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("../../../hosts/network-info.js", () => ({
  hostNetworkInfoFromRecord: () => ({ status: "unknown" }),
  queueHostNetworkInfoRefresh: vi.fn(),
}));

vi.mock("../../../hosts/host-resolver.js", () => ({
  synchronizeProjectHostCredentialsForHost: vi.fn(),
}));

vi.mock("../../../control-plane/management-repository.js", () => ({
  ControlPlaneManagementError: class ControlPlaneManagementError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  },
  ManagementRepository: class ManagementRepository {
    getProjectHostMetadataUpdateTarget(...args: unknown[]) {
      return state.getProjectHostMetadataUpdateTarget(...args);
    }
  },
}));

vi.mock("../../../database/repositories/factory.js", () => ({
  createCurrentCommandHistoryRepository: () => ({}),
  createCurrentCredentialRepository: () => ({}),
  createCurrentFileManagerBookmarkRepository: () => ({}),
  createCurrentHostRepository: () => ({
    updateNonSensitiveForUserWithProjectMetadata:
      state.updateNonSensitiveForUserWithProjectMetadata,
  }),
  createCurrentHostResolutionRepository: () => ({
    findHostUpdateState: async () => ({
      userId: "owner-1",
      credentialId: null,
      rdpCredentialId: null,
      vncCredentialId: null,
      telnetCredentialId: null,
      vaultProfileId: null,
      authType: "password",
    }),
  }),
  createCurrentOpksshTokenRepository: () => ({}),
  createCurrentRbacAccessRepository: () => ({}),
  createCurrentRecentActivityRepository: () => ({}),
  createCurrentRepositoryContext: () => ({}),
  createCurrentRoleRepository: () => ({}),
  createCurrentSessionRecordingRepository: () => ({}),
  createCurrentSshCredentialUsageRepository: () => ({}),
  createCurrentSyncTombstoneRepository: () => ({}),
  createCurrentTransferRecentRepository: () => ({}),
  createCurrentUserRepository: () => ({
    findById: async (id: string) => ({ id, username: id }),
  }),
  createCurrentWebTerminalSessionRepository: () => ({}),
}));

vi.mock("../../../database/routes/host-opkssh-routes.js", () => ({
  registerHostOpksshRoutes: vi.fn(),
}));
vi.mock("../../../database/routes/host-folder-routes.js", () => ({
  registerHostFolderRoutes: vi.fn(),
}));
vi.mock(
  "../../../database/routes/host-file-manager-bookmark-routes.js",
  () => ({
    registerHostFileManagerBookmarkRoutes: vi.fn(),
  }),
);
vi.mock("../../../database/routes/host-command-history-routes.js", () => ({
  registerHostCommandHistoryRoutes: vi.fn(),
}));
vi.mock("../../../database/routes/host-autostart-routes.js", () => ({
  registerHostAutostartRoutes: vi.fn(),
}));
vi.mock("../../../database/routes/host-internal-routes.js", () => ({
  registerHostInternalRoutes: vi.fn(),
}));
vi.mock("../../../database/routes/host-network-routes.js", () => ({
  registerHostNetworkRoutes: vi.fn(),
}));
vi.mock("../../../database/routes/host-bulk-routes.js", () => ({
  registerHostBulkRoutes: vi.fn(),
}));
vi.mock("../../../database/routes/host-enrollment-auth.js", () => ({
  applyHostEnrollmentDefaults: (data: unknown) => data,
  requireHostEnrollmentAccessForPath: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));

const { default: hostRouter } =
  await import("../../../database/routes/host.js");

const app = express();
app.use(express.json());
app.use(hostRouter);

let server: Server | null = null;
let baseUrl = "";

async function request(path: string, init?: RequestInit) {
  if (!server) {
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not expose a TCP port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  }
  return fetch(`${baseUrl}${path}`, init);
}

afterAll(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server?.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  state.canAccessHost.mockResolvedValue({
    hasAccess: true,
    isOwner: false,
    isShared: true,
    permissionLevel: "manage",
    expiresAt: null,
  });
  state.isAdmin.mockResolvedValue(false);
  state.getProjectHostMetadataUpdateTarget.mockReturnValue({
    projectId: "project-1",
    projectHostId: 12,
    hostId: 7,
  });
  state.updateNonSensitiveForUserWithProjectMetadata.mockResolvedValue({
    id: 7,
    userId: "owner-1",
    connectionType: "ssh",
    name: "Owner host",
    ip: "10.0.0.7",
    port: 22,
    username: "root",
    authType: "password",
    enableTerminal: true,
    enableTunnel: true,
    enableFileManager: true,
    enableDocker: true,
    dockerConfig: JSON.stringify({ runtime: "podman" }),
    enableProxmox: false,
    enableTmuxMonitor: false,
    showTerminalInSidebar: true,
    showFileManagerInSidebar: false,
    showTunnelInSidebar: false,
    showDockerInSidebar: false,
    showServerStatsInSidebar: false,
    enableSsh: true,
    enableRdp: false,
    enableVnc: false,
    enableTelnet: false,
    sshPort: 22,
    rdpPort: 3389,
    vncPort: 5900,
    telnetPort: 23,
    tunnelConnections: null,
    jumpHosts: null,
    quickActions: null,
    statsConfig: null,
    terminalConfig: null,
    proxmoxConfig: null,
    forceKeyboardInteractive: "false",
    guacamoleConfig: null,
  });
});

describe("shared project host updates", () => {
  it("persists Docker settings without requiring the host owner data key", async () => {
    const response = await request("/db/host/7", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectContext: {
          projectId: "project-1",
          projectHostId: 12,
          alias: "Docker Alias",
          folder: "Ops",
          tags: ["docker"],
        },
        connectionType: "ssh",
        name: "Docker Alias",
        folder: "Ops",
        tags: ["docker"],
        ip: "10.0.0.7",
        port: 22,
        username: "root",
        authType: "password",
        enableTerminal: true,
        enableTunnel: true,
        enableFileManager: true,
        enableDocker: true,
        dockerConfig: { runtime: "podman" },
        enableSsh: true,
        enableRdp: false,
        enableVnc: false,
        enableTelnet: false,
        sshPort: 22,
        rdpPort: 3389,
        vncPort: 5900,
        telnetPort: 23,
        defaultPath: "/",
      }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: 7,
      isShared: true,
      permissionLevel: "manage",
      enableDocker: true,
      dockerConfig: { runtime: "podman" },
    });
    expect(
      state.updateNonSensitiveForUserWithProjectMetadata,
    ).toHaveBeenCalledWith(
      "owner-1",
      7,
      {
        enableDocker: true,
        dockerConfig: JSON.stringify({ runtime: "podman" }),
      },
      {
        projectId: "project-1",
        projectHostId: 12,
        alias: "Docker Alias",
        folder: "Ops",
        tags: "docker",
      },
    );
    expect(state.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "update_host",
        resourceId: "7",
        userId: "project-admin",
      }),
    );
  });
});
