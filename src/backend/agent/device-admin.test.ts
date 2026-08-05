import crypto from "crypto";
import type { Server } from "http";
import Database from "better-sqlite3";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedRequest } from "../../types/index.js";
import { ensureControlPlaneSchema } from "../control-plane/schema-migration.js";
import {
  AgentDeviceAdminRepository,
  createAgentDeviceAdminRouter,
} from "./device-admin.js";
import { AgentDeviceRegistrationRepository } from "./device-registration.js";

describe("Agent 已授权设备管理", () => {
  let sqlite: Database.Database;
  let server: Server | undefined;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL,
        password_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0,
        totp_enabled INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE webauthn_credentials (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
        user_verification TEXT NOT NULL DEFAULT 'preferred',
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      );
      CREATE TABLE ssh_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
        folder TEXT
      );
      CREATE TABLE audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL, username TEXT NOT NULL,
        action TEXT NOT NULL, resource_type TEXT NOT NULL,
        resource_id TEXT, resource_name TEXT, details TEXT,
        ip_address TEXT, user_agent TEXT, success INTEGER NOT NULL,
        error_message TEXT, timestamp TEXT DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO users VALUES ('admin', 'admin', 'hash', 1, 0);
      INSERT INTO users VALUES ('project-admin', 'project-admin', 'hash', 0, 0);
    `);
    ensureControlPlaneSchema(sqlite);
    sqlite.exec(`
      INSERT INTO teams (id, name, slug, owner_user_id)
        VALUES ('team-1', 'Team', 'team', 'admin');
      INSERT INTO projects
        (id, team_id, owner_user_id, kind, name, slug)
        VALUES
          ('project-1', 'team-1', 'admin', 'team', 'Project 1', 'project-1'),
          ('project-2', 'team-1', 'admin', 'team', 'Project 2', 'project-2'),
          ('project-3', 'team-1', 'admin', 'team', 'Project 3', 'project-3');
    `);
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
      server = undefined;
    }
    sqlite.close();
  });

  async function approvedDevice(
    projectIds = ["project-1", "project-2"],
    approvedBy = "admin",
  ) {
    const pair = crypto.generateKeyPairSync("ed25519");
    const registration = new AgentDeviceRegistrationRepository(sqlite);
    const pending = await registration.create(
      "Original device",
      pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    );
    return new AgentDeviceAdminRepository(sqlite).approve({
      requestId: pending.requestId,
      approvedBy,
      accessMode: "selected",
      projectIds,
      scopes: ["sessions:read"],
      maxConcurrentSessions: 1,
      expiresAt: null,
    });
  }

  async function pendingDevice() {
    const pair = crypto.generateKeyPairSync("ed25519");
    return new AgentDeviceRegistrationRepository(sqlite).create(
      "Pending device",
      pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    );
  }

  async function startRouter(
    authState: {
      userId?: string;
      pendingTOTP?: boolean;
      mfaVerifiedAt?: number;
    } = {},
  ) {
    const app = express();
    app.use(express.json());
    app.use(
      "/agent/admin/v1",
      createAgentDeviceAdminRouter({
        sqlite,
        authenticate: (req, _res, next) => {
          const auth = req as AuthenticatedRequest;
          auth.userId = authState.userId ?? "admin";
          auth.user = { username: "admin" } as AuthenticatedRequest["user"];
          auth.sessionId = "session-1";
          auth.pendingTOTP = authState.pendingTOTP;
          auth.mfaVerifiedAt = authState.mfaVerifiedAt;
          next();
        },
        listManageableProjects: async () => [
          { id: "project-1", name: "Project 1" },
          { id: "project-2", name: "Project 2" },
        ],
        isInstanceAdmin: async () => true,
      }),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("listen failed");
    }
    return `http://127.0.0.1:${address.port}/agent/admin/v1`;
  }

  const approvalBody = {
    accessMode: "selected",
    projectIds: ["project-1"],
    scopes: ["sessions:read"],
  };

  function grants(deviceId: string) {
    return sqlite
      .prepare(
        `SELECT grant_row.id, grant_row.project_id AS projectId,
                grant_row.service_account_id AS serviceAccountId,
                grant_row.granted_by AS grantedBy,
                grant_row.created_at AS createdAt,
                account.is_active AS accountIsActive,
                account.updated_at AS accountUpdatedAt
           FROM agent_device_projects grant_row
           JOIN service_accounts account
             ON account.id = grant_row.service_account_id
          WHERE grant_row.device_id = ? ORDER BY grant_row.project_id`,
      )
      .all(deviceId);
  }

  it("按当前账号标记设备所有者，并保留其他账号和已删除账号的来源", async () => {
    const own = await approvedDevice(["project-1"], "admin");
    const other = await approvedDevice(["project-1"], "project-admin");
    sqlite
      .prepare(
        "INSERT INTO users VALUES ('deleted-user', 'deleted-account', 'hash', 0, 0)",
      )
      .run();
    const deleted = await approvedDevice(["project-1"], "deleted-user");
    sqlite.prepare("DELETE FROM users WHERE id = 'deleted-user'").run();

    const repository = new AgentDeviceAdminRepository(sqlite);
    const devices = repository.list({
      currentUserId: "admin",
      manageableProjectIds: ["project-1"],
      isInstanceAdmin: true,
    });

    expect(devices.find((device) => device.id === own!.id)?.owner).toEqual({
      userId: "admin",
      username: "admin",
      isCurrentUser: true,
    });
    expect(devices.find((device) => device.id === other!.id)?.owner).toEqual({
      userId: "project-admin",
      username: "project-admin",
      isCurrentUser: false,
    });
    expect(devices.find((device) => device.id === deleted!.id)?.owner).toEqual({
      userId: null,
      username: null,
      isCurrentUser: false,
    });
    expect(JSON.stringify(devices)).not.toContain("ownerUserId");
    expect(JSON.stringify(devices)).not.toContain("ownerUsername");
  });

  it("非实例管理员仍看不到包含无权项目授权的设备", async () => {
    const visible = await approvedDevice(["project-1"], "project-admin");
    await approvedDevice(["project-1", "project-3"], "admin");

    const devices = new AgentDeviceAdminRepository(sqlite).list({
      currentUserId: "project-admin",
      manageableProjectIds: ["project-1", "project-2"],
      isInstanceAdmin: false,
    });

    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      id: visible!.id,
      owner: {
        userId: "project-admin",
        username: "project-admin",
        isCurrentUser: true,
      },
    });
  });

  it("可更新全部字段，并在收窄或扩展项目时管理内部账号", async () => {
    const approved = await approvedDevice();
    const deviceId = approved!.id;
    const originalProjectOne = sqlite
      .prepare(
        `SELECT grant_row.service_account_id AS accountId
           FROM agent_device_projects grant_row
          WHERE grant_row.device_id = ? AND grant_row.project_id = 'project-1'`,
      )
      .get(deviceId) as { accountId: string };
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    const repository = new AgentDeviceAdminRepository(sqlite);

    await expect(
      repository.update({
        deviceId,
        updatedBy: "admin",
        manageableProjectIds: ["project-1", "project-2", "project-3"],
        isInstanceAdmin: true,
        name: "Edited device",
        accessMode: "selected",
        projectIds: ["project-2"],
        scopes: ["sessions:read", "jobs:execute"],
        maxConcurrentSessions: 7,
        expiresAt,
      }),
    ).resolves.toMatchObject({
      id: deviceId,
      name: "Edited device",
      projectIds: ["project-2"],
      maxConcurrentSessions: 7,
      expiresAt,
    });
    expect(
      sqlite
        .prepare(
          `SELECT name, access_mode AS accessMode, scopes,
                  max_concurrent_sessions AS maxConcurrentSessions,
                  expires_at AS expiresAt
             FROM agent_devices WHERE id = ?`,
        )
        .get(deviceId),
    ).toEqual({
      name: "Edited device",
      accessMode: "selected",
      scopes: JSON.stringify(["sessions:read", "jobs:execute"]),
      maxConcurrentSessions: 7,
      expiresAt,
    });
    expect(grants(deviceId)).toEqual([
      expect.objectContaining({ projectId: "project-2", accountIsActive: 1 }),
    ]);
    expect(
      sqlite
        .prepare(
          "SELECT is_active AS isActive FROM service_accounts WHERE id = ?",
        )
        .get(originalProjectOne.accountId),
    ).toEqual({ isActive: 0 });

    await expect(
      repository.update({
        deviceId,
        updatedBy: "admin",
        manageableProjectIds: ["project-1", "project-2", "project-3"],
        isInstanceAdmin: true,
        accessMode: "all",
      }),
    ).resolves.toMatchObject({
      accessMode: "all",
      projectIds: ["project-1", "project-2", "project-3"],
    });
    expect(
      grants(deviceId).map((grant) => ({
        projectId: (grant as { projectId: string }).projectId,
        accountIsActive: (grant as { accountIsActive: number }).accountIsActive,
      })),
    ).toEqual([
      { projectId: "project-1", accountIsActive: 1 },
      { projectId: "project-2", accountIsActive: 1 },
      { projectId: "project-3", accountIsActive: 1 },
    ]);
    expect(
      sqlite
        .prepare(
          `SELECT service_account_id AS accountId
             FROM agent_device_projects
            WHERE device_id = ? AND project_id = 'project-1'`,
        )
        .get(deviceId),
    ).toEqual(originalProjectOne);
  });

  it("其他管理员扩展授权不会转移设备所有者", async () => {
    const approved = await approvedDevice(["project-1"], "project-admin");
    const repository = new AgentDeviceAdminRepository(sqlite);

    await repository.update({
      deviceId: approved!.id,
      updatedBy: "admin",
      manageableProjectIds: ["project-1", "project-2", "project-3"],
      isInstanceAdmin: true,
      accessMode: "all",
    });
    await repository.update({
      deviceId: approved!.id,
      updatedBy: "admin",
      manageableProjectIds: ["project-1", "project-2", "project-3"],
      isInstanceAdmin: true,
      name: "Renamed by admin",
    });

    expect(
      sqlite
        .prepare(
          `SELECT approved_by_user_id AS approvedByUserId,
                  owner_user_id AS ownerUserId
             FROM agent_devices WHERE id = ?`,
        )
        .get(approved!.id),
    ).toEqual({
      approvedByUserId: "admin",
      ownerUserId: "project-admin",
    });
    expect(
      repository.list({
        currentUserId: "admin",
        manageableProjectIds: ["project-1", "project-2", "project-3"],
        isInstanceAdmin: true,
      })[0],
    ).toMatchObject({
      name: "Renamed by admin",
      owner: {
        userId: "project-admin",
        username: "project-admin",
        isCurrentUser: false,
      },
    });
    expect(
      repository.list({
        currentUserId: "project-admin",
        manageableProjectIds: ["project-1", "project-2", "project-3"],
        isInstanceAdmin: true,
      })[0],
    ).toMatchObject({ owner: { isCurrentUser: true } });
    expect(() =>
      sqlite
        .prepare("UPDATE agent_devices SET owner_user_id = ? WHERE id = ?")
        .run("admin", approved!.id),
    ).toThrow("agent device owner is immutable");
  });

  it("项目管理员不能编辑同时包含其无权项目的设备", async () => {
    const approved = await approvedDevice();
    const before = grants(approved!.id);

    await expect(
      new AgentDeviceAdminRepository(sqlite).update({
        deviceId: approved!.id,
        updatedBy: "project-admin",
        manageableProjectIds: ["project-1"],
        isInstanceAdmin: false,
        name: "Unauthorized edit",
      }),
    ).resolves.toBeNull();
    expect(grants(approved!.id)).toEqual(before);
    expect(
      sqlite
        .prepare("SELECT name FROM agent_devices WHERE id = ?")
        .get(approved!.id),
    ).toEqual({ name: "Original device" });
  });

  it("持久化失败会恢复设备、授权、内部账号和审计", async () => {
    const approved = await approvedDevice();
    const deviceId = approved!.id;
    const beforeDevice = sqlite
      .prepare("SELECT * FROM agent_devices WHERE id = ?")
      .get(deviceId);
    const beforeGrants = grants(deviceId);
    const beforeAccounts = sqlite
      .prepare("SELECT * FROM service_accounts ORDER BY id")
      .all();
    const persist = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined);
    const repository = new AgentDeviceAdminRepository(sqlite, persist);

    await expect(
      repository.update({
        deviceId,
        updatedBy: "admin",
        manageableProjectIds: ["project-1", "project-2", "project-3"],
        isInstanceAdmin: true,
        name: "Should roll back",
        accessMode: "selected",
        projectIds: ["project-2", "project-3"],
        scopes: ["jobs:execute"],
        maxConcurrentSessions: 9,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        audit: {
          userId: "admin",
          username: "admin",
          action: "update_agent_device",
          resourceType: "agent_device",
          success: true,
        },
      }),
    ).rejects.toThrow("disk full");

    expect(persist).toHaveBeenCalledTimes(2);
    expect(
      sqlite.prepare("SELECT * FROM agent_devices WHERE id = ?").get(deviceId),
    ).toEqual(beforeDevice);
    expect(grants(deviceId)).toEqual(beforeGrants);
    expect(
      sqlite.prepare("SELECT * FROM service_accounts ORDER BY id").all(),
    ).toEqual(beforeAccounts);
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'update_agent_device'",
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it("PATCH 支持部分更新并拒绝空项目范围", async () => {
    const approved = await approvedDevice(["project-1"]);
    sqlite
      .prepare("UPDATE users SET totp_enabled = 1 WHERE id = 'admin'")
      .run();
    const baseUrl = await startRouter({
      mfaVerifiedAt: Math.floor(Date.now() / 1000),
    });

    const renamed = await fetch(`${baseUrl}/devices/${approved!.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed only" }),
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual({
      device: expect.objectContaining({
        id: approved!.id,
        name: "Renamed only",
        projectIds: ["project-1"],
      }),
    });

    const emptyScope = await fetch(`${baseUrl}/devices/${approved!.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessMode: "selected", projectIds: [] }),
    });
    expect(emptyScope.status).toBe(400);

    const invalidAccessMode = await fetch(
      `${baseUrl}/device-requests/missing/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accessMode: "unexpected",
          projectIds: ["project-1"],
          scopes: ["sessions:read"],
        }),
      },
    );
    expect(invalidAccessMode.status).toBe(400);

    const mixedProjectIds = await fetch(
      `${baseUrl}/device-requests/missing/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accessMode: "selected",
          projectIds: ["project-1", 7],
          scopes: ["sessions:read"],
        }),
      },
    );
    expect(mixedProjectIds.status).toBe(400);
  });

  it("未启用 MFA 的账号不能批准永久设备", async () => {
    const pending = await pendingDevice();
    const baseUrl = await startRouter({
      mfaVerifiedAt: Math.floor(Date.now() / 1000),
    });

    const response = await fetch(
      `${baseUrl}/device-requests/${pending.requestId}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(approvalBody),
      },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "MFA_ENROLLMENT_REQUIRED",
    });
  });

  it("旧通行密钥可作为 MFA 入口并由验证接口强制本地用户验证", async () => {
    const pending = await pendingDevice();
    sqlite
      .prepare(
        "INSERT INTO webauthn_credentials (id, user_id, user_verification) VALUES ('legacy-key', 'admin', 'preferred')",
      )
      .run();
    const baseUrl = await startRouter({
      mfaVerifiedAt: Math.floor(Date.now() / 1000) - 10 * 60,
    });

    const response = await fetch(
      `${baseUrl}/device-requests/${pending.requestId}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(approvalBody),
      },
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: "MFA_STEP_UP_REQUIRED",
      methods: ["webauthn"],
    });
  });

  it("已启用 MFA 但未近期验证时不能修改授权", async () => {
    const approved = await approvedDevice(["project-1"]);
    sqlite
      .prepare("UPDATE users SET totp_enabled = 1 WHERE id = 'admin'")
      .run();
    sqlite
      .prepare(
        "INSERT INTO webauthn_credentials (id, user_id, user_verification) VALUES ('legacy-key', 'admin', 'preferred')",
      )
      .run();
    const baseUrl = await startRouter({
      mfaVerifiedAt: Math.floor(Date.now() / 1000) - 10 * 60,
    });

    const response = await fetch(`${baseUrl}/devices/${approved!.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scopes: ["sessions:read", "jobs:execute"] }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: "MFA_STEP_UP_REQUIRED",
      methods: ["totp", "webauthn"],
    });
  });

  it("仅处于 pendingTOTP 状态不能批准永久设备", async () => {
    const pending = await pendingDevice();
    sqlite
      .prepare("UPDATE users SET totp_enabled = 1 WHERE id = 'admin'")
      .run();
    const baseUrl = await startRouter({
      pendingTOTP: true,
      mfaVerifiedAt: Math.floor(Date.now() / 1000),
    });

    const response = await fetch(
      `${baseUrl}/device-requests/${pending.requestId}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(approvalBody),
      },
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: "INTERACTIVE_SESSION_REQUIRED",
    });
  });

  it.each(["TOTP", "WebAuthn"] as const)(
    "近期完成 %s 验证后可以批准永久设备",
    async (method) => {
      const pending = await pendingDevice();
      if (method === "TOTP") {
        sqlite
          .prepare("UPDATE users SET totp_enabled = 1 WHERE id = 'admin'")
          .run();
      } else {
        sqlite
          .prepare(
            "INSERT INTO webauthn_credentials (id, user_id, user_verification) VALUES ('key-1', 'admin', 'required')",
          )
          .run();
      }
      const baseUrl = await startRouter({
        mfaVerifiedAt: Math.floor(Date.now() / 1000),
      });

      const response = await fetch(
        `${baseUrl}/device-requests/${pending.requestId}/approve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(approvalBody),
        },
      );

      expect(response.status).toBe(201);
      const payload = (await response.json()) as {
        device: { id: string; name: string };
      };
      expect(payload).toEqual({
        device: expect.objectContaining({ name: "Pending device" }),
      });
      if (method === "WebAuthn") {
        const revoked = await fetch(`${baseUrl}/devices/${payload.device.id}`, {
          method: "DELETE",
        });
        expect(revoked.status).toBe(204);
      }
    },
  );
});
