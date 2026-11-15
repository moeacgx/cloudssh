import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const http = vi.hoisted(() => ({
  defaults: { baseURL: "/cloudssh/" },
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("@/main-axios", () => ({ agentApi: http }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ i18n: { language: "en" }, t: (key: string) => key }),
}));
vi.mock("@/components/MfaStepUpDialog", () => ({
  MfaStepUpDialog: () => null,
}));
vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: vi.fn(async () => true),
}));
import { McpPanel } from "../../sidebar/McpPanel";
import { mcpConfiguration, mcpEndpoint } from "../../api/mcp-api";

beforeEach(() => {
  vi.clearAllMocks();
  http.get.mockImplementation(async (url: string) => ({
    data: url.endsWith("catalog")
      ? {
          tools: [
            {
              name: "cloudssh_context",
              description: "Context",
              scope: null,
              inputSchema: { type: "object" },
            },
          ],
        }
      : url.endsWith("history")
        ? { records: [], total: 0 }
        : { projects: [{ id: "p1", name: "Production" }], tokens: [] },
  }));
  http.post.mockResolvedValue({
    data: { token: { token: "cssh_only_shown_once" } },
  });
});
afterEach(cleanup);

describe("MCP management", () => {
  it("keeps reverse-proxy base paths and never embeds a real key in client config", () => {
    expect(mcpEndpoint()).toBe(`${window.location.origin}/cloudssh/agent/mcp`);
    expect(mcpConfiguration("https://ssh.test/agent/mcp", "Codex")).toContain(
      'bearer_token_env_var = "CLOUDSSH_MCP_KEY"',
    );
    expect(
      JSON.parse(mcpConfiguration("https://ssh.test/agent/mcp", "Cursor"))
        .mcpServers.cloudssh.headers.Authorization,
    ).toBe("Bearer ${env:CLOUDSSH_MCP_KEY}");
  });
  it("renders tabs and schemas, creates a scoped key, and clears the one-time secret", async () => {
    render(<McpPanel />);
    await waitFor(() =>
      expect(http.get).toHaveBeenCalledWith("/agent/admin/v1/mcp/catalog"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    expect(await screen.findByText("cloudssh_context")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Access keys" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Codex workstation" },
    });
    fireEvent.click(screen.getByLabelText("Production"));
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));
    expect(await screen.findByText("cssh_only_shown_once")).toBeTruthy();
    expect(http.post).toHaveBeenCalledWith(
      "/agent/admin/v1/mcp/tokens",
      expect.objectContaining({
        name: "Codex workstation",
        projectIds: ["p1"],
        scopes: ["sessions:read", "files:read"],
        accessMode: "selected",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Saved" }));
    await waitFor(() =>
      expect(screen.queryByText("cssh_only_shown_once")).toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(await screen.findByText("No invocations")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Status filter"), {
      target: { value: "error" },
    });
    await waitFor(() =>
      expect(http.get).toHaveBeenCalledWith("/agent/admin/v1/mcp/history", {
        params: { page: 1, tool: "", tokenId: "", status: "error" },
      }),
    );
  });
});
