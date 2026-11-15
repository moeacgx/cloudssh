import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpRouter, type McpInvocation } from "./mcp.js";
import { createMcpTools, type McpServices } from "./mcp-tools.js";
import {
  createAgentAuthMiddleware,
  hashAgentToken,
  MemoryAgentCredentialStore,
} from "./auth.js";
import type { AgentPrincipal } from "./types.js";
import { AgentApiError } from "./errors.js";
import { AgentSessionBroker } from "./broker.js";
import { MemoryAgentStateStore } from "./store.js";
import { UnavailableSessionDriver } from "./drivers.js";

const principal: AgentPrincipal = {
  principalId: "key-1",
  serviceAccountId: "account-1",
  projectId: "project-1",
  name: "Test key",
  scopes: ["jobs:execute"],
  serverIds: ["server-1"],
  maxConcurrentSessions: 1,
};
const createJob = vi.fn(async () => ({
  id: "job-1",
  projectId: "project-1",
  state: "queued",
}));
const services = {
  servers: { list: async () => [{ id: "server-1" }] },
  jobs: { create: createJob },
  sessions: {},
} as unknown as McpServices;
let server: Server | undefined;
let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  vi.clearAllMocks();
  createJob.mockReset().mockResolvedValue({
    id: "job-1",
    projectId: "project-1",
    state: "queued",
  });
});

async function start(
  record?: (entry: McpInvocation) => Promise<void>,
  activePrincipal = principal,
  activeServices = services,
) {
  const token = "cssh_test_token_for_mcp_protocol_integration";
  const hashed = await hashAgentToken(token);
  const store = new MemoryAgentCredentialStore([
    {
      ...activePrincipal,
      id: "key-1",
      tokenPrefix: token.slice(0, 13),
      tokenHash: hashed.hash,
      tokenSalt: hashed.salt,
      active: true,
    },
  ]);
  const audit: McpInvocation[] = [];
  const app = express();
  app.use(express.json());
  app.use(
    "/agent/mcp",
    createMcpRouter(
      activeServices,
      createAgentAuthMiddleware(store),
      async (entry) => {
        await record?.(entry);
        audit.push(entry);
      },
    ),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server!.address();
  if (!address || typeof address === "string")
    throw new Error("No listen address");
  const url = new URL(`http://127.0.0.1:${address.port}/agent/mcp`);
  client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return { token, store, audit, url, client };
}

describe("CloudSSH HTTP MCP", () => {
  it("审计不可用时不下发操作", async () => {
    const { client } = await start(async () => {
      throw new Error("disk full");
    });
    const result = await client.callTool({
      name: "cloudssh_jobs_execute",
      arguments: {
        serverId: "server-1",
        command: "id",
        request_id: "audit-failure",
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("AUDIT_UNAVAILABLE");
    expect(createJob).not.toHaveBeenCalled();
  });
  it("完成审计失败时仍返回已经执行成功的结果", async () => {
    const { client, audit } = await start(async (entry) => {
      if (entry.success) throw new Error("disk full after execution");
    });
    const result = await client.callTool({
      name: "cloudssh_jobs_execute",
      arguments: {
        serverId: "server-1",
        command: "id",
        request_id: "completion-failure",
      },
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain("job-1");
    expect(createJob).toHaveBeenCalledTimes(1);
    expect(audit.at(-1)).toMatchObject({
      stage: "dispatched",
      code: "OUTCOME_UNKNOWN",
    });
  });
  it("negotiates with the real SDK, filters tools and records metadata only", async () => {
    const { client, audit } = await start();
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toContain("cloudssh_jobs_execute");
    expect(listed.tools.map((t) => t.name)).not.toContain(
      "cloudssh_files_delete",
    );
    const result = await client.callTool({
      name: "cloudssh_jobs_execute",
      arguments: {
        serverId: "server-1",
        command: "echo private-command",
        request_id: "retry-1",
      },
    });
    expect(result.isError).not.toBe(true);
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({ principalId: "key-1" }),
      expect.objectContaining({ timeoutMs: 30000 }),
      "retry-1",
    );
    expect(audit).toEqual([
      expect.objectContaining({ stage: "intent", operationDispatched: false }),
      expect.objectContaining({
        stage: "dispatched",
        operationDispatched: true,
      }),
      expect.objectContaining({
        tool: "cloudssh_jobs_execute",
        projectId: "project-1",
        success: true,
      }),
    ]);
    expect(JSON.stringify(audit)).not.toContain("private-command");
  });
  it("rejects missing request IDs and inaccessible tools without running commands", async () => {
    const { client } = await start();
    expect(
      (
        await client.callTool({
          name: "cloudssh_jobs_execute",
          arguments: { serverId: "server-1", command: "id" },
        })
      ).isError,
    ).toBe(true);
    expect(
      (await client.callTool({ name: "cloudssh_files_delete", arguments: {} }))
        .isError,
    ).toBe(true);
    expect(createJob).not.toHaveBeenCalled();
  });
  it("reauthenticates every request after revocation and expiry", async () => {
    const { client, store } = await start();
    store.records[0].active = false;
    await expect(client.listTools()).rejects.toThrow();
    store.records[0].active = true;
    store.records[0].expiresAt = new Date(Date.now() - 1000).toISOString();
    await expect(client.listTools()).rejects.toThrow();
  });
  it("rejects missing tokens and foreign browser origins", async () => {
    const { url, token } = await start();
    expect((await fetch(url, { method: "POST" })).status).toBe(401);
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            Origin: "https://foreign.test",
          },
        })
      ).status,
    ).toBe(403);
  });
  it("enforces scope checks even outside protocol registration", async () => {
    const tool = createMcpTools(services, principal).find(
      (t) => t.name === "cloudssh_files_delete",
    )!;
    await expect(
      tool.execute({ serverId: "server-1", path: "/x", request_id: "r" }),
    ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
  });
  it("propagates service authorization failures and audits errors without arguments", async () => {
    const { client, audit } = await start();
    createJob.mockRejectedValueOnce(
      new AgentApiError(403, "SERVER_DENIED", "Not authorized") as never,
    );
    expect(
      (
        await client.callTool({
          name: "cloudssh_jobs_execute",
          arguments: {
            serverId: "other-project-server",
            command: "id",
            request_id: "r",
          },
        })
      ).isError,
    ).toBe(true);
    expect(audit.at(-1)).toMatchObject({
      success: false,
      code: "SERVER_DENIED",
      projectId: null,
    });
    expect(createJob).not.toHaveBeenCalled();
  });
  it("已授权操作失败时保留目标项目归属", async () => {
    const { client, audit } = await start();
    createJob.mockRejectedValueOnce(
      new AgentApiError(429, "JOB_LIMIT_REACHED", "limit") as never,
    );
    await client.callTool({
      name: "cloudssh_jobs_execute",
      arguments: {
        serverId: "server-1",
        command: "id",
        request_id: "failed-operation",
      },
    });
    expect(audit.at(-1)).toMatchObject({
      success: false,
      code: "JOB_LIMIT_REACHED",
      projectId: "project-1",
    });
  });
  it("下发前的第二次持久化失败也不能执行操作", async () => {
    const { client, audit } = await start(async (entry) => {
      if (entry.stage === "dispatched") throw new Error("disk full");
    });
    const result = await client.callTool({
      name: "cloudssh_jobs_execute",
      arguments: {
        serverId: "server-1",
        command: "id",
        request_id: "dispatch-audit-failure",
      },
    });
    expect(JSON.stringify(result)).toContain("AUDIT_UNAVAILABLE");
    expect(createJob).not.toHaveBeenCalled();
    expect(audit).toHaveLength(1);
  });
  it("会话读取及仅写权限的失败调用均记入目标项目，越权目标不泄露项目", async () => {
    const state = new MemoryAgentStateStore();
    const driver = new UnavailableSessionDriver();
    vi.spyOn(driver, "create").mockResolvedValue({
      runtimeId: "runtime",
      runtimeMode: "platform",
    });
    vi.spyOn(driver, "write").mockResolvedValue();
    const sessions = new AgentSessionBroker(state, driver);
    const sessionPrincipal: AgentPrincipal = {
      ...principal,
      scopes: ["sessions:create", "sessions:read", "sessions:write"],
      projectIds: ["project-1", "project-2"],
      serverProjectIds: { "server-1": "project-2" },
    };
    const session = await sessions.create(
      sessionPrincipal,
      { serverId: "server-1", cols: 120, rows: 30, pinned: false },
      "create-session",
    );
    const { client, audit, store } = await start(undefined, sessionPrincipal, {
      ...services,
      sessions,
    });
    const read = await client.callTool({
      name: "cloudssh_sessions_read",
      arguments: { sessionId: session.id },
    });
    expect(read.isError).not.toBe(true);
    expect(audit.at(-1)).toMatchObject({
      projectId: "project-2",
      success: true,
    });
    const attached = await sessions.attach(
      sessionPrincipal,
      session.id,
      "read-write",
      false,
      "attach-session",
    );
    store.records[0].scopes = ["sessions:write"];
    const write = await client.callTool({
      name: "cloudssh_sessions_write",
      arguments: {
        sessionId: session.id,
        attachmentId: attached.attachmentId,
        leaseId: attached.lease!.id,
        data: "id\n",
        request_id: "write-ok",
      },
    });
    expect(write.isError).not.toBe(true);
    expect(audit.at(-1)).toMatchObject({
      projectId: "project-2",
      success: true,
    });
    const retry = await client.callTool({
      name: "cloudssh_sessions_write",
      arguments: {
        sessionId: session.id,
        attachmentId: attached.attachmentId,
        leaseId: attached.lease!.id,
        data: "id\n",
        request_id: "write-ok",
      },
    });
    expect(retry.isError).not.toBe(true);
    expect(driver.write).toHaveBeenCalledTimes(1);
    await client.callTool({
      name: "cloudssh_sessions_write",
      arguments: {
        sessionId: session.id,
        attachmentId: "bad",
        leaseId: "bad",
        data: "id\n",
        request_id: "write-fails",
      },
    });
    expect(audit.at(-1)).toMatchObject({
      projectId: "project-2",
      code: "WRITE_LEASE_INVALID",
      success: false,
    });
    store.records[0].projectIds = ["project-1"];
    await client.callTool({
      name: "cloudssh_sessions_write",
      arguments: {
        sessionId: session.id,
        attachmentId: "bad",
        leaseId: "bad",
        data: "id\n",
        request_id: "denied",
      },
    });
    expect(audit.at(-1)).toMatchObject({
      projectId: null,
      code: "SESSION_NOT_FOUND",
      operationDispatched: false,
    });
  });
  it("文件操作提交后报错时保留提交标志并明确告知结果不确定", async () => {
    const files = {
      delete: vi.fn(
        async (_p, _server, _path, _recursive, _key, _signal, onCommitted) => {
          onCommitted();
          throw new Error("result persistence failed");
        },
      ),
    } as unknown as McpServices["files"];
    const { client, audit } = await start(
      undefined,
      { ...principal, scopes: ["files:write"] },
      { ...services, files },
    );
    const result = await client.callTool({
      name: "cloudssh_files_delete",
      arguments: {
        serverId: "server-1",
        path: "/tmp/example",
        request_id: "delete-committed",
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("操作已经提交");
    expect(audit.at(-1)).toMatchObject({
      projectId: "project-1",
      operationDispatched: true,
      operationCommitted: true,
      code: "OUTCOME_UNKNOWN",
    });
  });
});
