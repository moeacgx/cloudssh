import Database from "better-sqlite3";
import express from "express";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedRequest } from "../../types/index.js";
import { ensureControlPlaneSchema } from "../control-plane/schema-migration.js";
import { AgentTokenAdminRepository } from "./token-admin.js";
import {
  createAgentAuthMiddleware,
  SqliteAgentCredentialStore,
} from "./auth.js";
import { createMcpAdminRouter, McpHistory } from "./mcp-admin.js";
import type { McpServices } from "./mcp-tools.js";
import { createMcpRouter } from "./mcp.js";
import { AgentSecurityStore } from "./security-store.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

let sqlite: Database.Database;
let server: Server | undefined;
beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, totp_enabled INTEGER DEFAULT 1);
    CREATE TABLE webauthn_credentials (id TEXT PRIMARY KEY, user_id TEXT);
    CREATE TABLE ssh_data (id INTEGER PRIMARY KEY, user_id TEXT, folder TEXT);
    INSERT INTO users (id, username) VALUES ('owner', 'Owner'), ('other', 'Other');`);
  ensureControlPlaneSchema(sqlite);
  sqlite.exec(`INSERT INTO teams (id, name, slug, owner_user_id) VALUES ('team', 'Team', 'team', 'owner');
    INSERT INTO projects (id, team_id, owner_user_id, kind, name, slug) VALUES
      ('p1', 'team', 'owner', 'team', 'One', 'one'), ('p2', 'team', 'owner', 'team', 'Two', 'two');`);
});
afterEach(async () => {
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  sqlite.close();
});
const input = {
  createdBy: "owner",
  name: "Key",
  scopes: ["sessions:read"] as const,
  accessMode: "selected" as const,
  projectIds: ["p1", "p2"],
  maxConcurrentSessions: 1,
  expiresAt: null,
};
async function key() {
  return (await new AgentTokenAdminRepository(sqlite).createToken({
    ...input,
    scopes: [...input.scopes],
  }))!;
}

describe("MCP key and history management", () => {
  it("删除来源项目及密钥后仍保留所有者和管理员的历史访问", async () => {
    sqlite.pragma("foreign_keys = ON");
    const created = await key();
    const history = new McpHistory(sqlite);
    await history.record({
      tokenId: created.id,
      tool: "cloudssh_context",
      projectId: "p2",
      success: true,
      durationMs: 1,
      code: null,
    });
    sqlite.prepare("DELETE FROM projects WHERE id = ?").run("p1");
    expect(
      sqlite
        .prepare("SELECT id FROM agent_access_tokens WHERE id = ?")
        .get(created.id),
    ).toBeUndefined();
    const filters = { page: 1, tool: "", tokenId: "", status: "" };
    expect(history.list("owner", false, filters)).toMatchObject({
      total: 1,
      isInstanceAdmin: false,
      records: [
        expect.objectContaining({
          tokenName: "Key",
          projectId: "p2",
          owner: {
            userId: "owner",
            username: "Owner",
            isCurrentUser: true,
          },
        }),
      ],
    });
    expect(history.list("other", true, filters).records[0]).toMatchObject({
      owner: { userId: "owner", username: "Owner", isCurrentUser: false },
    });
    expect(history.list("other", false, filters).total).toBe(0);
    expect(history.list("other", true, filters).total).toBe(1);
  });
  it("高频认证仅按分钟更新使用时间", async () => {
    const created = await key();
    const save = vi.fn();
    const store = new SqliteAgentCredentialStore(sqlite, save, async () => [
      "p1",
      "p2",
    ]);
    const now = Date.now();
    for (let i = 0; i < 100; i++)
      await store.touch(created.id, new Date(now + i * 100).toISOString());
    expect(save).toHaveBeenCalledTimes(1);
    await store.touch(created.id, new Date(now + 60000).toISOString());
    expect(save).toHaveBeenCalledTimes(2);
  });
  it("使用时间的合并保存与权限扩展的强制保存独立", async () => {
    const created = await new AgentTokenAdminRepository(sqlite).createToken({
      ...input,
      accessMode: "all",
      projectIds: ["p1"],
      scopes: [...input.scopes],
    });
    const securitySave = vi.fn();
    const usageSave = vi.fn();
    const store = new SqliteAgentCredentialStore(
      sqlite,
      securitySave,
      async () => ["p1", "p2"],
      usageSave,
    );
    for (let i = 0; i < 10; i++) {
      await store.findActiveByPrefix(created!.tokenPrefix);
      await store.touch(created!.id, new Date().toISOString());
    }
    expect(securitySave).toHaveBeenCalledTimes(1);
    expect(usageSave).toHaveBeenCalledTimes(1);
  });
  it("真实 MCP 轮询不会触发主数据库强制保存", async () => {
    const created = (await new AgentTokenAdminRepository(sqlite).createToken({
      ...input,
      scopes: ["jobs:execute"],
    }))!;
    const securitySave = vi.fn();
    const usageSave = vi.fn();
    const credentials = new SqliteAgentCredentialStore(
      sqlite,
      securitySave,
      async () => ["p1", "p2"],
      usageSave,
    );
    const security = new AgentSecurityStore(":memory:");
    const history = security.createMcpHistory(sqlite);
    const app = express();
    app.use(express.json());
    app.use(
      "/mcp",
      createMcpRouter(
        {
          jobs: { status: async () => ({ id: "job", projectId: "p2" }) },
        } as unknown as McpServices,
        createAgentAuthMiddleware(credentials),
        (entry) => history.record(entry),
      ),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    const address = server!.address();
    if (!address || typeof address === "string")
      throw new Error("No listen address");
    const client = new Client({ name: "poll-test", version: "1.0" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${address.port}/mcp`),
          {
            requestInit: {
              headers: { Authorization: `Bearer ${created.token}` },
            },
          },
        ),
      );
      for (let i = 0; i < 10; i++) {
        expect(
          (
            await client.callTool({
              name: "cloudssh_jobs_status",
              arguments: { jobId: "job" },
            })
          ).isError,
        ).not.toBe(true);
      }
      expect(securitySave).not.toHaveBeenCalled();
      expect(usageSave).toHaveBeenCalledTimes(1);
      expect(
        history.list("owner", false, {
          page: 1,
          tool: "",
          tokenId: "",
          status: "",
        }),
      ).toMatchObject({
        total: 10,
        records: expect.arrayContaining([
          expect.objectContaining({ projectId: "p2" }),
        ]),
      });
    } finally {
      await client.close();
      security.close();
    }
  });
  it("历史密钥名称与归属不随当前记录修改", async () => {
    const created = await key();
    const history = new McpHistory(sqlite);
    const entry = {
      id: "fixed-invocation",
      tokenId: created.id,
      tool: "cloudssh_context",
      projectId: "p1",
      success: false,
      durationMs: 0,
      code: "PENDING",
    };
    await history.record({ ...entry, stage: "intent" });
    sqlite
      .prepare(
        "UPDATE agent_access_tokens SET name = ?, created_by_user_id = ? WHERE id = ?",
      )
      .run("Renamed", "other", created.id);
    await history.record({
      ...entry,
      stage: "completed",
      success: true,
      code: null,
    });
    const filters = { page: 1, tool: "", tokenId: "", status: "" };
    expect(history.list("owner", false, filters)).toMatchObject({
      total: 1,
      records: [expect.objectContaining({ tokenName: "Key" })],
    });
    expect(history.list("other", false, filters).total).toBe(0);
  });
  it("stores only a hash, restricts keys to owners and checks current project grants", async () => {
    const created = await key();
    const repository = new AgentTokenAdminRepository(sqlite);
    const other = {
      userId: "other",
      manageableProjectIds: ["p1"],
      isInstanceAdmin: false,
    };
    expect(await repository.listTokens(other)).toEqual([]);
    expect(
      await repository.revokeToken({ ...other, tokenId: created.id }),
    ).toBe(false);
    const list = await repository.listTokens({ ...other, userId: "owner" });
    expect(JSON.stringify(list)).not.toContain(created.token);
    expect(list[0].projectIds).toEqual(["p1", "p2"]);
    expect(list[0].owner).toEqual({
      userId: "owner",
      username: "Owner",
      isCurrentUser: true,
    });
    const adminList = await repository.listTokens({
      ...other,
      isInstanceAdmin: true,
    });
    expect(adminList[0].owner).toEqual({
      userId: "owner",
      username: "Owner",
      isCurrentUser: false,
    });
    const store = new SqliteAgentCredentialStore(
      sqlite,
      undefined,
      async () => ["p2"],
    );
    expect(
      (await store.findActiveByPrefix(created.tokenPrefix))[0].projectIds,
    ).toEqual(["p2"]);
    expect(
      await repository.revokeToken({
        ...other,
        userId: "owner",
        tokenId: created.id,
      }),
    ).toBe(true);
    expect(await store.findActiveByPrefix(created.tokenPrefix)).toEqual([]);
  });
  it("filters and paginates history without exposing other owners or old events", async () => {
    const created = await key();
    const history = new McpHistory(sqlite);
    for (let i = 0; i < 27; i++)
      await history.record({
        tokenId: created.id,
        tool: "cloudssh_context",
        projectId: null,
        success: i % 2 === 0,
        durationMs: i,
        code: null,
      });
    const filters = { page: 1, tool: "", tokenId: "", status: "" };
    expect(history.list("owner", false, filters)).toMatchObject({
      total: 27,
      records: expect.any(Array),
    });
    expect(history.list("owner", false, filters).records).toHaveLength(25);
    expect(
      history.list("owner", false, { ...filters, page: 2 }).records,
    ).toHaveLength(2);
    expect(history.list("other", false, filters).total).toBe(0);
    expect(
      history.list("other", true, { ...filters, status: "success" }).total,
    ).toBe(14);
    expect(
      history.list("owner", false, { ...filters, tokenId: "absent" }).total,
    ).toBe(0);
    sqlite
      .prepare("UPDATE mcp_invocations SET created_at = ?")
      .run("2000-01-01T00:00:00.000Z");
    expect(history.list("owner", false, filters).total).toBe(0);
  });
  it("requires verified interactive sessions and recent MFA before creating a key", async () => {
    const auth = {
      userId: "owner",
      sessionId: "session",
      mfaVerifiedAt: undefined as number | undefined,
      apiKeyId: undefined as number | undefined,
    };
    const app = express();
    app.use(express.json());
    app.use(
      "/mcp",
      createMcpAdminRouter(
        {
          sqlite,
          authenticate: (req, _res, next) => {
            Object.assign(req as AuthenticatedRequest, auth);
            next();
          },
          listManageableProjects: async () => [{ id: "p1", name: "One" }],
          isInstanceAdmin: async () => false,
        },
        new McpHistory(sqlite),
        {} as McpServices,
      ),
    );
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    const address = server!.address();
    if (!address || typeof address === "string")
      throw new Error("No listen address");
    const url = `http://127.0.0.1:${address.port}/mcp/tokens`;
    const create = (projectIds = ["p1"]) =>
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, projectIds }),
      });
    expect(await (await create()).json()).toMatchObject({
      code: "MFA_STEP_UP_REQUIRED",
    });
    auth.mfaVerifiedAt = Math.floor(Date.now() / 1000);
    expect((await create(["p2"])).status).toBe(400);
    const response = await create();
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({
      token: { token: expect.stringMatching(/^cssh_/) },
    });
    auth.apiKeyId = 1;
    expect((await fetch(url)).status).toBe(401);
  });
});
