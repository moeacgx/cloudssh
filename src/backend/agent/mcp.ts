import express, { type RequestHandler } from "express";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AgentAuthenticatedRequest } from "./auth.js";
import { createMcpTools, type McpServices } from "./mcp-tools.js";
import { isAdministrativeTransportAllowed } from "../utils/trust-loopback-proxy.js";
import { isAgentApiError } from "./errors.js";
import { apiLogger } from "../utils/logger.js";

export interface McpInvocation {
  id?: string;
  tokenId: string;
  ownerUserId?: string | null;
  tokenName?: string;
  tool: string;
  projectId: string | null;
  success: boolean;
  durationMs: number;
  code: string | null;
  stage?: "intent" | "dispatched" | "completed";
  requestId?: string | null;
  operationDispatched?: boolean;
  operationCommitted?: boolean;
}

export function createMcpRouter(
  services: McpServices,
  authenticate: RequestHandler,
  record: (entry: McpInvocation) => Promise<void>,
) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (!isAdministrativeTransportAllowed(req)) {
      res.status(426).json({ error: "HTTPS_REQUIRED" });
      return;
    }
    const origin = req.get("origin");
    if (origin && origin !== `${req.protocol}://${req.get("host")}`) {
      res.status(403).json({ error: "ORIGIN_DENIED" });
      return;
    }
    next();
  });
  router.use(authenticate);
  router.post("/", async (req, res, next) => {
    const auth = req as AgentAuthenticatedRequest;
    const principal = auth.agentPrincipal!;
    const server = new McpServer({ name: "cloudssh", version: "1.0.0" });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const tools = createMcpTools(services, principal).filter(
      (tool) => !tool.scope || principal.scopes.includes(tool.scope),
    );
    for (const tool of tools) {
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.schema,
          annotations: {
            readOnlyHint: !tool.mutating,
            destructiveHint: tool.mutating,
            openWorldHint: true,
          },
        },
        async (args) => {
          const start = Date.now();
          const entry: McpInvocation = {
            id: crypto.randomUUID(),
            tokenId: auth.agentTokenId!,
            ownerUserId: auth.agentTokenOwnerUserId,
            tokenName: principal.name,
            tool: tool.name,
            projectId: null,
            success: false,
            durationMs: 0,
            code: "PENDING",
            stage: "intent",
            requestId:
              typeof (args as Record<string, unknown>).request_id === "string"
                ? (args as Record<string, string>).request_id
                : null,
            operationDispatched: false,
            operationCommitted: false,
          };
          const errorResult = (code: string, error: string) => ({
            isError: true,
            content: [
              { type: "text" as const, text: JSON.stringify({ code, error }) },
            ],
          });
          const complete = async () => {
            entry.stage = "completed";
            entry.durationMs = Date.now() - start;
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                await record({ ...entry });
                return;
              } catch {
                // 结果审计失败不能覆盖已执行操作的真实响应；磁盘仍保留调用意图。
              }
            }
            apiLogger.error("MCP completion audit write failed", {
              operation: "mcp_completion_audit_failed",
              invocationId: entry.id,
              operationDispatched: entry.operationDispatched,
              operationCommitted: entry.operationCommitted,
            });
          };
          let authorizationError: unknown;
          try {
            entry.projectId = await tool.resolveProjectId(args);
          } catch (error) {
            authorizationError = error;
          }
          try {
            await record({ ...entry });
            if (!authorizationError && tool.mutating) {
              // 记录的是进入服务调用的边界；崩溃后按“可能已下发”处理，不能推断未执行。
              await record({
                ...entry,
                stage: "dispatched",
                code: "OUTCOME_UNKNOWN",
                operationDispatched: true,
              });
            }
          } catch {
            return errorResult(
              "AUDIT_UNAVAILABLE",
              "审计暂时不可用，操作未执行",
            );
          }
          try {
            if (authorizationError) throw authorizationError;
            entry.operationDispatched = tool.mutating;
            const result = await tool.execute(args, {
              onCommitted: () => {
                entry.operationCommitted = true;
              },
            });
            if (!tool.commitObserved) entry.operationCommitted = tool.mutating;
            entry.success = true;
            entry.code = null;
            await complete();
            return {
              content: [
                { type: "text" as const, text: JSON.stringify(result) },
              ],
            };
          } catch (error) {
            entry.code = isAgentApiError(error)
              ? error.code
              : entry.operationDispatched
                ? "OUTCOME_UNKNOWN"
                : "TOOL_FAILED";
            await complete();
            return errorResult(
              entry.code,
              entry.operationCommitted
                ? "操作已经提交，但结果未能返回；请先检查目标状态，重试必须复用原 request_id"
                : isAgentApiError(error)
                  ? error.message
                  : entry.operationDispatched
                    ? "操作可能已经执行，请先检查目标状态；重试时必须复用原 request_id"
                    : "Tool execution failed",
            );
          }
        },
      );
    }
    res.once("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      if (
        req.body?.method === "tools/call" &&
        typeof req.body.params?.name === "string"
      ) {
        const name = req.body.params.name;
        const tool = tools.find((candidate) => candidate.name === name);
        if (
          !tool ||
          !tool.schema.safeParse(req.body.params.arguments ?? {}).success
        ) {
          await record({
            tokenId: auth.agentTokenId!,
            ownerUserId: auth.agentTokenOwnerUserId,
            tokenName: principal.name,
            tool: tool?.name ?? "unknown",
            projectId: null,
            success: false,
            durationMs: 0,
            code: tool ? "INVALID_ARGUMENTS" : "TOOL_UNAVAILABLE",
          });
        }
      }
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      next(error);
    }
  });
  router.all("/", (_req, res) => {
    res.setHeader("Allow", "POST");
    res.status(405).end();
  });
  return router;
}
