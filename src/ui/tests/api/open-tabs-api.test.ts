import { beforeEach, describe, expect, it, vi } from "vitest";

const authApi = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

const agentApi = vi.hoisted(() => ({
  post: vi.fn(),
}));

vi.mock("@/main-axios", () => ({ agentApi, authApi }));
import {
  closeAgentSession,
  detachPinnedOpenTab,
  getActiveSessions,
  parseCustomKeybindings,
  parseCustomThemes,
  upsertOpenTabRecord,
  type OpenTabRecord,
} from "../../api/open-tabs-api";

function openTabRecord(overrides: Partial<OpenTabRecord> = {}): OpenTabRecord {
  return {
    id: "tab-1",
    userId: "user-1",
    tabType: "terminal",
    hostId: 5,
    label: "prod-db",
    tabOrder: 0,
    backendSessionId: "session-1",
    sessionPinned: true,
    tmuxSessionName: null,
    lastDetachedAt: 123,
    retentionExpiresAt: null,
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:01:00.000Z",
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("detachPinnedOpenTab", () => {
  it("returns the persisted tab record supplied by the detach endpoint", async () => {
    const record = openTabRecord();
    authApi.post.mockResolvedValueOnce({
      data: { success: true, sessionId: "session-1", tab: record },
    });

    await expect(detachPinnedOpenTab("tab-1")).resolves.toEqual(record);
    expect(authApi.post).toHaveBeenCalledWith("/open-tabs/tab-1/detach");
  });
});

describe("closeAgentSession", () => {
  it("uses the JWT-protected close endpoint with only the encoded session ID", async () => {
    authApi.get.mockResolvedValue({ data: [] });
    agentApi.post.mockResolvedValueOnce({ data: { success: true } });
    await getActiveSessions();

    await expect(closeAgentSession("agent/session 1")).resolves.toBeUndefined();
    await getActiveSessions();

    expect(agentApi.post).toHaveBeenCalledWith(
      "/agent/admin/v1/sessions/agent%2Fsession%201/close",
    );
    expect(authApi.post).not.toHaveBeenCalled();
    expect(authApi.get).toHaveBeenCalledTimes(2);
  });
});

describe("upsertOpenTabRecord", () => {
  it("adds a newly detached tab to the background records", () => {
    const record = openTabRecord();
    expect(upsertOpenTabRecord([], record)).toEqual([record]);
  });

  it("replaces an existing record without creating a duplicate", () => {
    const stale = openTabRecord({ sessionPinned: false, updatedAt: "old" });
    const detached = openTabRecord();

    expect(upsertOpenTabRecord([stale], detached)).toEqual([detached]);
  });
});

describe("parseCustomKeybindings", () => {
  it("parses a valid JSON array", () => {
    const raw = JSON.stringify([
      {
        id: "kb-1",
        combo: {
          key: "c",
          isCode: false,
          ctrl: true,
          alt: false,
          shift: false,
          meta: false,
        },
        action: { type: "copy" },
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const result = parseCustomKeybindings(raw);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("kb-1");
  });

  it("returns an empty array for null or undefined input", () => {
    expect(parseCustomKeybindings(null)).toEqual([]);
    expect(parseCustomKeybindings(undefined)).toEqual([]);
  });

  it("returns an empty array for malformed JSON", () => {
    expect(parseCustomKeybindings("{not json")).toEqual([]);
  });

  it("returns an empty array when the JSON is not an array", () => {
    expect(parseCustomKeybindings(JSON.stringify({ foo: "bar" }))).toEqual([]);
  });
});

describe("parseCustomThemes", () => {
  it("still parses a valid JSON array (regression check)", () => {
    const raw = JSON.stringify([{ id: "t1", name: "My Theme", colors: {} }]);
    expect(parseCustomThemes(raw)).toHaveLength(1);
  });
});
