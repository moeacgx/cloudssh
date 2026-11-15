import { agentApi } from "@/main-axios";
import type { AgentScope, AgentProjectOption } from "./agent-admin-api";

const prefix = "/agent/admin/v1/mcp";
export interface McpKey {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: AgentScope[];
  projectIds: string[];
  isActive: number;
  expiresAt: string | null;
  lastUsedAt: string | null;
}
export interface McpTool {
  name: string;
  description: string;
  scope: AgentScope | null;
  mutating: boolean;
  inputSchema: Record<string, unknown>;
}
export interface McpRecord {
  id: string;
  tool: string;
  tokenName: string;
  projectId: string | null;
  success: number;
  durationMs: number;
  code: string | null;
  createdAt: string;
}
export function mcpEndpoint() {
  const base = agentApi.defaults.baseURL ?? "";
  return `${new URL(base || "/", window.location.href).href.replace(/\/$/, "")}/agent/mcp`;
}
export function mcpConfiguration(endpoint: string, client: "Codex" | "Cursor") {
  return client === "Codex"
    ? `[mcp_servers.cloudssh]\nurl = ${JSON.stringify(endpoint)}\nbearer_token_env_var = "CLOUDSSH_MCP_KEY"`
    : JSON.stringify(
        {
          mcpServers: {
            cloudssh: {
              url: endpoint,
              headers: { Authorization: "Bearer ${env:CLOUDSSH_MCP_KEY}" },
            },
          },
        },
        null,
        2,
      );
}
export async function loadMcpAccess() {
  return (
    await agentApi.get<{ projects: AgentProjectOption[]; tokens: McpKey[] }>(
      `${prefix}/tokens`,
    )
  ).data;
}
export async function loadMcpTools() {
  return (await agentApi.get<{ tools: McpTool[] }>(`${prefix}/catalog`)).data
    .tools;
}
export async function createMcpKey(input: {
  name: string;
  projectIds: string[];
  scopes: AgentScope[];
  expiresAt: string | null;
  maxConcurrentSessions: number;
}) {
  return (
    await agentApi.post(`${prefix}/tokens`, {
      ...input,
      accessMode: "selected",
    })
  ).data.token as { token: string };
}
export async function revokeMcpKey(id: string) {
  await agentApi.delete(`${prefix}/tokens/${encodeURIComponent(id)}`);
}
export async function loadMcpHistory(
  page: number,
  tool: string,
  tokenId: string,
  status: string,
) {
  return (
    await agentApi.get<{ records: McpRecord[]; total: number }>(
      `${prefix}/history`,
      { params: { page, tool, tokenId, status } },
    )
  ).data;
}
