import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const http = vi.hoisted(() => ({
  defaults: { baseURL: "/cloudssh/" },
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
}));
const verification = vi.hoisted(() => ({ post: vi.fn(), passkey: vi.fn() }));
vi.mock("@/main-axios", () => ({
  agentApi: http,
  authApi: { post: verification.post },
  handleApiError: (error: unknown) => error,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ i18n: { language: "en" }, t: (key: string) => key }),
}));
vi.mock("@/api/webauthn-api", () => ({
  stepUpWithWebAuthn: verification.passkey,
  getWebAuthnErrorTranslationKey: () => null,
}));
vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: vi.fn(async () => true),
}));
import { McpManagementButton, McpPanel } from "../../sidebar/McpPanel";
import { mcpConfiguration, mcpEndpoint } from "../../api/mcp-api";

beforeEach(() => {
  vi.resetAllMocks();
  verification.post.mockResolvedValue({ data: { success: true } });
  verification.passkey.mockResolvedValue({ success: true });
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
  function deferredVerification() {
    let resolve!: (value: { data: { success: boolean } }) => void;
    const promise = new Promise<{ data: { success: boolean } }>((done) => {
      resolve = done;
    });
    return { promise, resolve: () => resolve({ data: { success: true } }) };
  }

  async function submitCode() {
    fireEvent.change(
      await screen.findByLabelText("auth.totpAuthenticatorLabel"),
      { target: { value: "123456" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "auth.verifyCode" }));
  }

  function roundTripTabs() {
    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    fireEvent.click(screen.getByRole("button", { name: "Access keys" }));
  }

  async function requestVerification(methods = ["totp"], management = false) {
    http.post.mockRejectedValueOnce({
      code: "ERR_BAD_REQUEST",
      response: {
        data: { code: "MFA_STEP_UP_REQUIRED", methods, error: "Verify first" },
      },
    });
    render(management ? <McpManagementButton /> : <McpPanel />);
    if (management)
      fireEvent.click(screen.getByRole("button", { name: "MCP management" }));
    fireEvent.click(screen.getByRole("button", { name: "Access keys" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Local key" },
    });
    fireEvent.click(await screen.findByLabelText("Production"));
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));
  }

  it("verifies inside the creation form and retries the unchanged request once", async () => {
    await requestVerification();
    const code = await screen.findByLabelText("auth.totpAuthenticatorLabel");
    expect(code.closest("form")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Local key",
    );
    expect(http.post).toHaveBeenCalledTimes(1);
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.keyDown(code, { key: "Enter" });
    expect(await screen.findByText("cssh_only_shown_once")).toBeTruthy();
    expect(verification.post).toHaveBeenCalledWith("/users/totp/step-up", {
      totp_code: "123456",
    });
    expect(http.post).toHaveBeenCalledTimes(2);
    expect(http.post.mock.calls[1]).toEqual(http.post.mock.calls[0]);
  });

  it("keeps failed verification in the form and cancellation preserves the draft", async () => {
    verification.post.mockRejectedValueOnce(new Error("Invalid code"));
    await requestVerification();
    fireEvent.change(
      await screen.findByLabelText("auth.totpAuthenticatorLabel"),
      { target: { value: "123456" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "auth.verifyCode" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Invalid code",
    );
    expect(http.post).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
    expect(screen.queryByLabelText("auth.totpAuthenticatorLabel")).toBeNull();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Local key",
    );
    expect(
      (screen.getByLabelText("Production") as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("supports passkey verification without requesting a TOTP code", async () => {
    await requestVerification(["webauthn"]);
    fireEvent.click(
      await screen.findByRole("button", { name: "auth.verifyWithPasskey" }),
    );
    expect(await screen.findByText("cssh_only_shown_once")).toBeTruthy();
    expect(verification.passkey).toHaveBeenCalledTimes(1);
    expect(verification.post).not.toHaveBeenCalled();
    expect(http.post).toHaveBeenCalledTimes(2);
  });

  it("ignores a pending verification after a tab roundtrip and cancellation", async () => {
    const pending = deferredVerification();
    verification.post.mockReturnValueOnce(pending.promise);
    await requestVerification();
    await submitCode();
    roundTripTabs();
    fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
    await act(async () => pending.resolve());
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("cssh_only_shown_once")).toBeNull();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Local key",
    );
  });

  it("keeps verification locked across tab remounts and retries creation only once", async () => {
    const pending = deferredVerification();
    verification.post.mockReturnValueOnce(pending.promise);
    await requestVerification();
    await submitCode();
    roundTripTabs();
    expect(
      (
        screen.getByRole("button", {
          name: "auth.verifyCode",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await submitCode();
    expect(verification.post).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve());
    expect(await screen.findByText("cssh_only_shown_once")).toBeTruthy();
    expect(http.post).toHaveBeenCalledTimes(2);
  });

  it.each(["old-first", "new-first"])(
    "consumes only the current operation when two verification responses arrive %s",
    async (order) => {
      const oldRequest = deferredVerification();
      const newRequest = deferredVerification();
      verification.post
        .mockReturnValueOnce(oldRequest.promise)
        .mockReturnValueOnce(newRequest.promise);
      await requestVerification();
      await submitCode();
      roundTripTabs();
      fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
      http.post.mockRejectedValueOnce({
        response: {
          data: { code: "MFA_STEP_UP_REQUIRED", methods: ["totp"] },
        },
      });
      fireEvent.click(screen.getByRole("button", { name: "Create key" }));
      await submitCode();
      expect(verification.post).toHaveBeenCalledTimes(2);
      expect(http.post).toHaveBeenCalledTimes(2);
      const responses =
        order === "old-first"
          ? [oldRequest, newRequest]
          : [newRequest, oldRequest];
      for (const response of responses) {
        await act(async () => response.resolve());
      }
      expect(await screen.findByText("cssh_only_shown_once")).toBeTruthy();
      expect(http.post).toHaveBeenCalledTimes(3);
    },
  );

  it("does not create a key when the panel closes during passkey verification", async () => {
    const pending = deferredVerification();
    verification.passkey.mockReturnValueOnce(pending.promise);
    await requestVerification(["webauthn"], true);
    fireEvent.click(
      await screen.findByRole("button", { name: "auth.verifyWithPasskey" }),
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => pending.resolve());
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it("does not loop if creation still requires verification after a successful challenge", async () => {
    await requestVerification();
    const code = await screen.findByLabelText("auth.totpAuthenticatorLabel");
    http.post.mockRejectedValueOnce({
      code: "ERR_BAD_REQUEST",
      response: {
        data: {
          code: "MFA_STEP_UP_REQUIRED",
          methods: ["totp"],
          error: "Session expired",
        },
      },
    });
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "auth.verifyCode" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Session expired",
    );
    expect(http.post).toHaveBeenCalledTimes(2);
    expect(screen.queryByLabelText("auth.totpAuthenticatorLabel")).toBeNull();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Local key",
    );
  });
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
  describe("instance admin view of other-account keys", () => {
    const past = "2020-01-02T03:04:05.000Z";
    const future = "2099-05-06T07:08:09.000Z";
    const owner = (username: string | null, isCurrentUser = false) => ({
      userId: username ? `u-${username}` : null,
      username,
      isCurrentUser,
    });
    const key = (
      id: string,
      name: string,
      overrides: Record<string, unknown> = {},
    ) => ({
      id,
      name,
      tokenPrefix: `cssh_${id}`,
      scopes: ["sessions:read"],
      projectIds: ["p1"],
      isActive: 1,
      expiresAt: future,
      lastUsedAt: null,
      ...overrides,
    });

    function serveTokens(
      tokens: ReturnType<typeof key>[],
      isInstanceAdmin = true,
    ) {
      http.get.mockImplementation(async (url: string) => ({
        data: url.endsWith("catalog")
          ? { tools: [] }
          : url.endsWith("history")
            ? { records: [], total: 0, isInstanceAdmin }
            : {
                projects: [{ id: "p1", name: "Production" }],
                tokens,
                isInstanceAdmin,
              },
      }));
    }

    async function openKeyCard(name: string) {
      fireEvent.click(screen.getByRole("button", { name: "Access keys" }));
      const title = await screen.findByText(name);
      const card = title.closest("h4")?.parentElement?.parentElement;
      if (!card) throw new Error(`Key card for ${name} not found`);
      return card as HTMLElement;
    }

    const adminTokens = () => [
      key("own", "Own key", { owner: owner("admin", true) }),
      key("revoked", "Bob revoked key", {
        isActive: 0,
        owner: owner("bob"),
      }),
      key("expired", "Carol expired key", {
        expiresAt: past,
        owner: owner("carol"),
      }),
      key("active", "Dave active key", { owner: owner("dave") }),
      key("orphan", "Orphan key", { owner: owner(null) }),
    ];

    it("shows owner, status and expiry on a revoked other-account key", async () => {
      serveTokens(adminTokens());
      render(<McpPanel />);
      const card = await openKeyCard("Bob revoked key");
      const section = screen.getByText("Keys from other accounts")
        .parentElement as HTMLElement;
      expect(section.contains(card)).toBe(true);
      expect(within(card).getByText(/bob/)).toBeTruthy();
      expect(within(card).getByText(/Revoked/)).toBeTruthy();
      expect(within(card).queryByText(/Active|Expired/)).toBeNull();
      expect(card.textContent).toContain(
        `Expires: ${new Date(future).toLocaleString()}`,
      );
      expect(card.textContent).toContain(
        "agentIntegration.management.scopeRead",
      );
      const revoke = within(card).getByRole("button", { name: "Revoke" });
      expect((revoke as HTMLButtonElement).disabled).toBe(true);
    });

    it("shows Expired with the past expiry and still allows revoking that key", async () => {
      serveTokens(adminTokens());
      http.delete.mockResolvedValue({});
      render(<McpPanel />);
      const card = await openKeyCard("Carol expired key");
      expect(within(card).getByText(/carol/)).toBeTruthy();
      expect(within(card).getByText(/Expired/)).toBeTruthy();
      expect(within(card).queryByText(/Active|Revoked/)).toBeNull();
      expect(card.textContent).toContain(
        `Expires: ${new Date(past).toLocaleString()}`,
      );
      fireEvent.click(within(card).getByRole("button", { name: "Revoke" }));
      fireEvent.click(
        await screen.findByRole("button", { name: "Confirm revoke" }),
      );
      await waitFor(() =>
        expect(http.delete).toHaveBeenCalledWith(
          "/agent/admin/v1/mcp/tokens/expired",
        ),
      );
    });

    it("keeps Active, unknown-owner and own-key cards consistent", async () => {
      serveTokens(adminTokens());
      render(<McpPanel />);
      const active = await openKeyCard("Dave active key");
      expect(within(active).getByText(/dave/)).toBeTruthy();
      expect(within(active).getByText(/Active/)).toBeTruthy();
      const orphan = await openKeyCard("Orphan key");
      expect(within(orphan).getByText(/Unknown account/)).toBeTruthy();
      const own = await openKeyCard("Own key");
      const section = screen.getByText("Keys from other accounts")
        .parentElement as HTMLElement;
      expect(section.contains(own)).toBe(false);
      expect(within(own).getByText(/Active/)).toBeTruthy();
      expect(within(own).queryByText(/admin/)).toBeNull();
      expect(own.textContent).toContain(
        `Expires: ${new Date(future).toLocaleString()}`,
      );
    });

    it("hides the other-account section from non-admin responses", async () => {
      serveTokens([key("own", "Own key", { owner: owner("me", true) })], false);
      render(<McpPanel />);
      await openKeyCard("Own key");
      expect(screen.queryByText("Keys from other accounts")).toBeNull();
    });
  });
});
