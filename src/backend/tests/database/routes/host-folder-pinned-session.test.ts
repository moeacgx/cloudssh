import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";

const state = vi.hoisted(() => ({
  cleanupCalls: [] as string[],
  fixedSessions: [{ id: "fixed-window" }],
  activeSessions: [] as Array<{ id: string }>,
}));

vi.mock("../../../hosts/terminal/session-manager.js", () => ({
  sessionManager: {
    findSessions: () => state.activeSessions,
  },
}));

vi.mock("../../../utils/logger.js", () => ({
  databaseLogger: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
  sshLogger: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../../../hosts/host-resolver.js", () => ({
  synchronizeProjectHostCredentialsForOwner: vi.fn(),
}));

vi.mock("../../../database/repositories/factory.js", () => {
  const cleanupRepository = (name: string) => ({
    deleteByHostIds: async () => state.cleanupCalls.push(name),
  });
  return {
    createCurrentCommandHistoryRepository: () =>
      cleanupRepository("command-history"),
    createCurrentCredentialRepository: () => ({}),
    createCurrentFileManagerBookmarkRepository: () =>
      cleanupRepository("bookmarks"),
    createCurrentHostFolderRepository: () => ({
      listHostsInFolder: async () => [
        { id: 7, name: "Build host", ip: "10.0.0.7" },
      ],
      deleteHostsAndFolderRecords: async () => {
        state.cleanupCalls.push("hosts");
        return { hostSyncIds: [], folderSyncIds: [] };
      },
    }),
    createCurrentRecentActivityRepository: () =>
      cleanupRepository("recent-activity"),
    createCurrentRbacAccessRepository: () => ({
      deleteHostAccessForHosts: async () => state.cleanupCalls.push("access"),
    }),
    createCurrentSessionRecordingRepository: () =>
      cleanupRepository("recordings"),
    createCurrentSshCredentialUsageRepository: () =>
      cleanupRepository("credential-usage"),
    createCurrentSyncTombstoneRepository: () => ({
      recordMany: async () => state.cleanupCalls.push("tombstones"),
    }),
    createCurrentTransferRecentRepository: () => cleanupRepository("transfers"),
    createCurrentWebTerminalSessionRepository: () => ({
      listForHosts: async () => state.fixedSessions,
    }),
  };
});

const { registerHostFolderRoutes } =
  await import("../../../database/routes/host-folder-routes.js");

const app = express();
app.use(express.json());
const router = express.Router();
registerHostFolderRoutes(router, {
  authenticateJWT: (req, _res, next) => {
    (req as express.Request & { userId: string }).userId = "owner";
    next();
  },
  statsServerUrl: "http://127.0.0.1:30005",
});
app.use(router);

let server: Server | null = null;
let baseUrl = "";

async function request(path: string, init?: RequestInit) {
  if (!server) {
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("测试服务器未绑定端口");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  }
  return fetch(`${baseUrl}${path}`, init);
}

beforeEach(() => {
  state.cleanupCalls = [];
  state.fixedSessions = [{ id: "fixed-window" }];
  state.activeSessions = [];
});

afterAll(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server?.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("主机文件夹固定窗口删除保护", () => {
  it("文件夹内任一主机存在固定窗口时整体拒绝删除", async () => {
    const response = await request("/folders/production/hosts", {
      method: "DELETE",
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "FOLDER_HAS_PINNED_TERMINALS",
      count: 1,
    });
    expect(state.cleanupCalls).toEqual([]);
  });

  it("文件夹内任一主机存在内存活动会话时整体拒绝删除", async () => {
    state.fixedSessions = [];
    state.activeSessions = [{ id: "active-window" }];

    const response = await request("/folders/production/hosts", {
      method: "DELETE",
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "FOLDER_HAS_ACTIVE_TERMINAL_SESSIONS",
      count: 1,
    });
    expect(state.cleanupCalls).toEqual([]);
  });
});
