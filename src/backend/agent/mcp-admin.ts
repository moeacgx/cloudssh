import express from "express";
import type { AuthenticatedRequest } from "../../types/index.js";
import {
  createAgentTokenAdminRouter,
  type AgentTokenAdminDependencies,
} from "./token-admin.js";
import { mcpToolCatalog, type McpServices } from "./mcp-tools.js";
import { McpHistory } from "./mcp-history.js";
export { McpHistory } from "./mcp-history.js";
import { requireRecentMfa } from "./device-admin.js";
import { isAdministrativeTransportAllowed } from "../utils/trust-loopback-proxy.js";

export function createMcpAdminRouter(
  deps: AgentTokenAdminDependencies,
  history: McpHistory,
  services: McpServices,
) {
  const router = express.Router();
  router.use(deps.authenticate);
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.use((req, res, next) => {
    const auth = req as AuthenticatedRequest;
    if (!isAdministrativeTransportAllowed(req)) {
      res.status(426).json({ error: "HTTPS_REQUIRED" });
      return;
    }
    if (auth.apiKeyId || !auth.sessionId || auth.pendingTOTP) {
      res.status(401).json({ code: "INTERACTIVE_SESSION_REQUIRED" });
      return;
    }
    if (req.method !== "GET" && !requireRecentMfa(deps, req, res)) return;
    next();
  });
  router.get("/catalog", (_req, res) => {
    res.json({
      tools: mcpToolCatalog(services, {
        principalId: "catalog",
        serviceAccountId: "",
        projectId: "",
        name: "",
        scopes: [],
        serverIds: [],
        maxConcurrentSessions: 1,
      }),
    });
  });
  router.get("/history", async (req, res, next) => {
    try {
      const page = Number(req.query.page ?? 1);
      const tool = req.query.tool ?? "";
      const tokenId = req.query.tokenId ?? "";
      const status = req.query.status ?? "";
      if (
        !Number.isSafeInteger(page) ||
        page < 1 ||
        page > 100000 ||
        typeof tool !== "string" ||
        tool.length > 128 ||
        typeof tokenId !== "string" ||
        tokenId.length > 128 ||
        !["", "success", "error"].includes(String(status))
      ) {
        res.status(400).json({ error: "Invalid history filters" });
        return;
      }
      const userId = (req as AuthenticatedRequest).userId;
      res.json(
        history.list(userId, await deps.isInstanceAdmin(userId), {
          page,
          tool,
          tokenId,
          status: String(status),
        }),
      );
    } catch (error) {
      next(error);
    }
  });
  router.use(createAgentTokenAdminRouter(deps));
  return router;
}
