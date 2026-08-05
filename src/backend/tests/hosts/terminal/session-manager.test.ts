import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub all external imports before loading the module under test
const mockCreate = vi.fn().mockResolvedValue({ id: 1 });
const mockUpdateEnded = vi.fn().mockResolvedValue(undefined);
const mockGetSetting = vi
  .fn<(key: string) => string | null>()
  .mockReturnValue(null);
const mockFixedUpsert = vi.fn().mockResolvedValue({});
const mockFixedFindOwned = vi.fn().mockResolvedValue(null);
const mockFixedListOwned = vi.fn().mockResolvedValue([]);
const mockFixedDelete = vi.fn().mockResolvedValue(true);
const mockFixedAttached = vi.fn().mockResolvedValue(true);
const mockFixedDetached = vi.fn().mockResolvedValue(true);
const mockOpenTabUpdate = vi.fn().mockResolvedValue(true);
const mockKillTmuxSession = vi.fn().mockResolvedValue(true);
const mockCanAccessHost = vi.fn().mockResolvedValue({ hasAccess: true });

vi.mock("../../../database/db/index.js", () => ({
  getDb: () => ({}),
}));

vi.mock("../../../database/repositories/factory.js", () => ({
  getCurrentSettingValue: mockGetSetting,
  createCurrentSessionRecordingRepository: () => ({
    create: mockCreate,
    updateEnded: mockUpdateEnded,
  }),
  createCurrentWebTerminalSessionRepository: () => ({
    upsert: mockFixedUpsert,
    findOwned: mockFixedFindOwned,
    listOwned: mockFixedListOwned,
    deleteOwned: mockFixedDelete,
    markAttached: mockFixedAttached,
    markDetached: mockFixedDetached,
  }),
  createCurrentOpenTabRepository: () => ({
    updateForUser: mockOpenTabUpdate,
  }),
}));

vi.mock("../../../hosts/tmux/helper.js", () => ({
  killTmuxSession: mockKillTmuxSession,
}));

vi.mock("../../../utils/permission-manager.js", () => ({
  PermissionManager: {
    getInstance: () => ({ canAccessHost: mockCanAccessHost }),
  },
}));

vi.mock("../../../utils/logger.js", () => ({
  sshLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock individual fs.promises methods via a stub object
const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockAppendFile = vi.fn().mockResolvedValue(undefined);
const mockUnlink = vi.fn().mockResolvedValue(undefined);

vi.mock("fs", () => ({
  default: {
    promises: {
      mkdir: mockMkdir,
      writeFile: mockWriteFile,
      appendFile: mockAppendFile,
      readFile: vi.fn(),
      unlink: mockUnlink,
    },
  },
  promises: {
    mkdir: mockMkdir,
    writeFile: mockWriteFile,
    appendFile: mockAppendFile,
    readFile: vi.fn(),
    unlink: mockUnlink,
  },
}));

const {
  sessionManager,
  bindTerminalChannelLifecycle,
  decideTerminalChannelClose,
  inspectTerminalRecoveryRecord,
  isMessageAllowedForParticipant,
  resolveTerminalSessionTimeoutMinutes,
  runGuardedTerminalTask,
  TerminalSessionTransitionError,
} = await import("../../../hosts/terminal/session-manager.js");
const {
  terminalSessionLifecycleCoordinator,
  TerminalLifecycleUnavailableError,
} = await import("../../../hosts/terminal/session-lifecycle-coordinator.js");

// Minimal fake WebSocket - only the surface session-manager touches.
function makeFakeWs(readyState = 1 /* OPEN */) {
  return {
    readyState,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as import("ws").WebSocket;
}
const WS_OPEN = 1;
const WS_CLOSED = 3;

describe("TerminalSessionManager - session logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply resolved values after clearAllMocks
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockCreate.mockResolvedValue({ id: 1 });
    mockUpdateEnded.mockResolvedValue(undefined);
  });

  it("createSession stores sessionLoggingEnabled=true by default", () => {
    const id = sessionManager.createSession("u1", 1, "host", 80, 24);
    const session = sessionManager.getSession(id);
    expect(session?.sessionLoggingEnabled).toBe(true);
    sessionManager.destroySession(id);
  });

  it("createSession stores sessionLoggingEnabled=false when passed", () => {
    const id = sessionManager.createSession(
      "u1",
      1,
      "host",
      80,
      24,
      undefined,
      false,
    );
    const session = sessionManager.getSession(id);
    expect(session?.sessionLoggingEnabled).toBe(false);
    sessionManager.destroySession(id);
  });

  it("rejects new sessions when the user already has ten non-evictable sessions", () => {
    const ids: string[] = [];
    try {
      for (let index = 0; index < 10; index += 1) {
        const id = sessionManager.createSession(
          "limit-user",
          index + 1,
          `host-${index}`,
          80,
          24,
          `limit-tab-${index}`,
          false,
        );
        sessionManager.getSession(id)!.pinned = true;
        ids.push(id);
      }

      expect(() =>
        sessionManager.createSession(
          "limit-user",
          99,
          "overflow",
          80,
          24,
          "limit-tab-overflow",
          false,
        ),
      ).toThrow(/Terminal session limit reached/);
    } finally {
      ids.forEach((id) => sessionManager.destroySession(id));
    }
  });

  it("does not evict a detached ordinary session when the live limit is reached", () => {
    const ids: string[] = [];
    try {
      for (let index = 0; index < 10; index += 1) {
        const id = sessionManager.createSession(
          "retention-limit-user",
          index + 1,
          `host-${index}`,
          80,
          24,
          `retention-limit-tab-${index}`,
          false,
        );
        const session = sessionManager.getSession(id)!;
        session.lastDetachedAt = Date.now() - index * 1_000;
        ids.push(id);
      }

      expect(() =>
        sessionManager.createSession(
          "retention-limit-user",
          99,
          "overflow",
          80,
          24,
          "retention-limit-tab-overflow",
          false,
        ),
      ).toThrow(/close an existing session/);
      expect(sessionManager.getSession(ids[0])).not.toBeNull();
      expect(sessionManager.getSession(ids[9])).not.toBeNull();
    } finally {
      ids.forEach((id) => sessionManager.destroySession(id));
    }
  });

  it("reuses an explicit session id before applying the session limit", () => {
    const ids: string[] = [];
    try {
      for (let index = 0; index < 10; index += 1) {
        const id = sessionManager.createSession(
          "reuse-limit-user",
          index + 1,
          `host-${index}`,
          80,
          24,
          `reuse-tab-${index}`,
          false,
          index === 0 ? { sessionId: "fixed-session-id" } : {},
        );
        sessionManager.getSession(id)!.pinned = true;
        ids.push(id);
      }

      expect(
        sessionManager.createSession(
          "reuse-limit-user",
          1,
          "host-0",
          80,
          24,
          "another-tab",
          false,
          { sessionId: "fixed-session-id" },
        ),
      ).toBe("fixed-session-id");
    } finally {
      ids.forEach((id) => sessionManager.destroySession(id));
    }
  });

  it("按主机、项目主机关联、用户和固定状态查找内存会话", () => {
    const ids = [
      sessionManager.createSession(
        "filter-user-a",
        901,
        "host-a",
        80,
        24,
        "filter-tab-a",
        false,
        { projectHostId: 1901 },
      ),
      sessionManager.createSession(
        "filter-user-b",
        902,
        "host-b",
        80,
        24,
        "filter-tab-b",
        false,
        { projectHostId: 1902 },
      ),
      sessionManager.createSession(
        "filter-user-a",
        903,
        "host-c",
        80,
        24,
        "filter-tab-c",
        false,
      ),
    ];
    sessionManager.getSession(ids[0])!.pinned = true;

    try {
      expect(
        sessionManager.findSessions({ hostIds: [901, 903] }).map((s) => s.id),
      ).toEqual([ids[0], ids[2]]);
      expect(
        sessionManager
          .findSessions({ projectHostIds: [1902], userId: "filter-user-b" })
          .map((s) => s.id),
      ).toEqual([ids[1]]);
      expect(
        sessionManager
          .findSessions({ userIds: ["filter-user-a"], pinned: true })
          .map((s) => s.id),
      ).toEqual([ids[0]]);
    } finally {
      ids.forEach((id) => sessionManager.destroySession(id));
    }
  });

  it("拒绝为已经删除的主机复活旧会话", () => {
    terminalSessionLifecycleCoordinator.retire({ hostIds: [9_999_991] });

    expect(() =>
      sessionManager.createSession(
        "retired-user",
        9_999_991,
        "retired-host",
        80,
        24,
        "retired-tab",
        false,
      ),
    ).toThrow(TerminalLifecycleUnavailableError);
  });

  it("does not write log file when sessionLoggingEnabled=false", async () => {
    const id = sessionManager.createSession(
      "u1",
      1,
      "host",
      80,
      24,
      undefined,
      false,
    );
    sessionManager.bufferOutput(id, "some output");
    sessionManager.destroySession(id);
    await new Promise((r) => setTimeout(r, 20));
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("writes log file and inserts DB row when sessionLoggingEnabled=true", async () => {
    const id = sessionManager.createSession(
      "u1",
      1,
      "host",
      80,
      24,
      undefined,
      true,
    );
    sessionManager.bufferOutput(id, "terminal output data");
    sessionManager.destroySession(id);
    await new Promise((r) => setTimeout(r, 20));
    expect(mockWriteFile).toHaveBeenCalledOnce();
    expect(mockCreate).toHaveBeenCalledOnce();
  });

  it("does not write log file when buffer is empty", async () => {
    const id = sessionManager.createSession(
      "u1",
      1,
      "host",
      80,
      24,
      undefined,
      true,
    );
    sessionManager.destroySession(id);
    await new Promise((r) => setTimeout(r, 20));
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("bufferOutput trims old data when exceeding 512KB", () => {
    const id = sessionManager.createSession(
      "u1",
      1,
      "host",
      80,
      24,
      undefined,
      false,
    );
    const chunk = "x".repeat(300 * 1024);
    sessionManager.bufferOutput(id, chunk);
    sessionManager.bufferOutput(id, chunk);
    const session = sessionManager.getSession(id);
    expect(session!.outputBufferBytes).toBeLessThanOrEqual(512 * 1024);
    sessionManager.destroySession(id);
  });
});

describe("TerminalSessionManager - multiplayer participants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockCreate.mockResolvedValue({ id: 1 });
    mockUpdateEnded.mockResolvedValue(undefined);
  });

  function createConnectedSession(): string {
    const id = sessionManager.createSession(
      "owner-1",
      1,
      "host",
      80,
      24,
      undefined,
      false,
    );
    // Mark connected without a real ssh2 stream - only isConnected is read
    // by attachWs/joinAsParticipant.
    const session = sessionManager.getSession(id)!;
    session.isConnected = true;
    return id;
  }

  it("joinAsParticipant adds a participant without evicting the owner", () => {
    const id = createConnectedSession();
    const ownerWs = makeFakeWs();
    sessionManager.attachWs(id, "owner-1", ownerWs);

    const guestWs = makeFakeWs();
    const session = sessionManager.joinAsParticipant(id, guestWs, {
      userId: null,
      permissionLevel: "read-only",
      guestLabel: "Guest",
    });

    expect(session).not.toBeNull();
    expect(session!.participants.size).toBe(2);
    const ownerParticipant = sessionManager.getParticipantForWs(
      session!,
      ownerWs,
    );
    expect(ownerParticipant?.isOwner).toBe(true);
    expect(ownerWs.send).not.toHaveBeenCalled();

    sessionManager.destroySession(id);
  });

  it("closes the previous owner socket when another tab takes over", () => {
    const id = createConnectedSession();
    const previousOwnerWs = makeFakeWs();
    const nextOwnerWs = makeFakeWs();
    sessionManager.attachWs(id, "owner-1", previousOwnerWs);

    const attached = sessionManager.attachWs(id, "owner-1", nextOwnerWs);

    expect(attached).not.toBeNull();
    expect(previousOwnerWs.send).toHaveBeenCalledWith(
      expect.stringContaining('"type":"sessionTakenOver"'),
    );
    expect(previousOwnerWs.close).toHaveBeenCalledWith(
      4009,
      "Session taken over",
    );
    expect(
      sessionManager.getParticipantForWs(attached!, previousOwnerWs),
    ).toBeNull();
    expect(
      sessionManager.getParticipantForWs(attached!, nextOwnerWs)?.isOwner,
    ).toBe(true);

    sessionManager.destroySession(id);
  });

  it("joinAsParticipant returns null for a nonexistent or unconnected session", () => {
    expect(
      sessionManager.joinAsParticipant("does-not-exist", makeFakeWs(), {
        userId: null,
        permissionLevel: "read-only",
      }),
    ).toBeNull();
  });

  it("broadcast sends to all OPEN participant sockets and skips CLOSED ones", () => {
    const id = createConnectedSession();
    const ownerWs = makeFakeWs(WS_OPEN);
    sessionManager.attachWs(id, "owner-1", ownerWs);

    const openGuestWs = makeFakeWs(WS_OPEN);
    const closedGuestWs = makeFakeWs(WS_CLOSED);
    sessionManager.joinAsParticipant(id, openGuestWs, {
      userId: null,
      permissionLevel: "read-only",
    });
    sessionManager.joinAsParticipant(id, closedGuestWs, {
      userId: null,
      permissionLevel: "read-only",
    });

    sessionManager.broadcast(id, { type: "data", data: "hello" });

    expect(ownerWs.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "data", data: "hello" }),
    );
    expect(openGuestWs.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "data", data: "hello" }),
    );
    expect(closedGuestWs.send).not.toHaveBeenCalled();

    sessionManager.destroySession(id);
  });

  it("broadcast does not throw if a socket's send throws", () => {
    const id = createConnectedSession();
    const throwingWs = makeFakeWs(WS_OPEN);
    (throwingWs.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("send failed");
    });
    sessionManager.attachWs(id, "owner-1", throwingWs);

    expect(() =>
      sessionManager.broadcast(id, { type: "data", data: "x" }),
    ).not.toThrow();

    sessionManager.destroySession(id);
  });

  it("broadcast is a no-op for a nonexistent session", () => {
    expect(() =>
      sessionManager.broadcast("does-not-exist", { type: "data" }),
    ).not.toThrow();
  });

  it("owner detach arms the idle timeout (existing behavior)", () => {
    vi.useFakeTimers();
    try {
      const id = createConnectedSession();
      const ownerWs = makeFakeWs();
      sessionManager.attachWs(id, "owner-1", ownerWs);

      sessionManager.detachWs(id);
      const session = sessionManager.getSession(id);
      expect(session?.detachTimeout).not.toBeNull();
      expect(session?.lastDetachedAt).not.toBeNull();

      sessionManager.destroySession(id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removeParticipant on a non-owner does not arm a timeout or destroy the session", () => {
    const id = createConnectedSession();
    const ownerWs = makeFakeWs();
    sessionManager.attachWs(id, "owner-1", ownerWs);

    const guestWs = makeFakeWs();
    sessionManager.joinAsParticipant(id, guestWs, {
      userId: null,
      permissionLevel: "read-write",
    });

    sessionManager.removeParticipant(id, guestWs);

    const session = sessionManager.getSession(id);
    expect(session).not.toBeNull();
    expect(session?.detachTimeout).toBeNull();
    expect(session?.participants.size).toBe(1);
    expect(sessionManager.getParticipantForWs(session!, guestWs)).toBeNull();

    sessionManager.destroySession(id);
  });

  it("removeParticipant is a no-op when the ws belongs to the owner", () => {
    const id = createConnectedSession();
    const ownerWs = makeFakeWs();
    sessionManager.attachWs(id, "owner-1", ownerWs);

    sessionManager.removeParticipant(id, ownerWs);

    const session = sessionManager.getSession(id);
    expect(session?.participants.size).toBe(1);
    expect(sessionManager.getParticipantForWs(session!, ownerWs)?.isOwner).toBe(
      true,
    );

    sessionManager.destroySession(id);
  });

  it("同一时间只允许一个读写访客持有写入租约", () => {
    const id = createConnectedSession();
    const firstGuestWs = makeFakeWs();
    const secondGuestWs = makeFakeWs();
    sessionManager.joinAsParticipant(id, firstGuestWs, {
      userId: "member-1",
      permissionLevel: "read-write",
    });
    sessionManager.joinAsParticipant(id, secondGuestWs, {
      userId: "member-2",
      permissionLevel: "read-write",
    });

    expect(sessionManager.canWriteToSession(id, firstGuestWs)).toBe(true);
    expect(sessionManager.canWriteToSession(id, secondGuestWs)).toBe(false);

    sessionManager.destroySession(id);
  });

  it("owner 上线时接管写入，离线后确定性交还首个读写访客", () => {
    vi.useFakeTimers();
    try {
      const id = createConnectedSession();
      const firstGuestWs = makeFakeWs();
      const secondGuestWs = makeFakeWs();
      sessionManager.joinAsParticipant(id, firstGuestWs, {
        userId: "member-1",
        permissionLevel: "read-write",
      });
      sessionManager.joinAsParticipant(id, secondGuestWs, {
        userId: "member-2",
        permissionLevel: "read-write",
      });

      const ownerWs = makeFakeWs();
      sessionManager.attachWs(id, "owner-1", ownerWs);
      expect(sessionManager.canWriteToSession(id, ownerWs)).toBe(true);
      expect(sessionManager.canWriteToSession(id, firstGuestWs)).toBe(false);
      expect(sessionManager.canWriteToSession(id, secondGuestWs)).toBe(false);

      sessionManager.detachWs(id);
      expect(sessionManager.canWriteToSession(id, ownerWs)).toBe(false);
      expect(sessionManager.canWriteToSession(id, firstGuestWs)).toBe(true);
      expect(sessionManager.canWriteToSession(id, secondGuestWs)).toBe(false);

      sessionManager.destroySession(id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("写入访客离开或被撤销后将租约转交下一位读写访客", () => {
    const id = createConnectedSession();
    const firstGuestWs = makeFakeWs();
    const secondGuestWs = makeFakeWs();
    const thirdGuestWs = makeFakeWs();
    const readOnlyGuestWs = makeFakeWs();
    sessionManager.joinAsParticipant(id, firstGuestWs, {
      userId: "member-1",
      permissionLevel: "read-write",
    });
    sessionManager.joinAsParticipant(id, readOnlyGuestWs, {
      userId: "member-readonly",
      permissionLevel: "read-only",
    });
    sessionManager.joinAsParticipant(id, secondGuestWs, {
      userId: "member-2",
      permissionLevel: "read-write",
    });
    sessionManager.joinAsParticipant(id, thirdGuestWs, {
      userId: "member-3",
      permissionLevel: "read-write",
    });

    expect(sessionManager.canWriteToSession(id, readOnlyGuestWs)).toBe(false);
    expect(
      sessionManager.evictSharedParticipant(id, firstGuestWs, "revoked"),
    ).toBe(true);
    expect(sessionManager.canWriteToSession(id, firstGuestWs)).toBe(false);
    expect(sessionManager.canWriteToSession(id, secondGuestWs)).toBe(true);

    sessionManager.removeParticipant(id, secondGuestWs);
    expect(sessionManager.canWriteToSession(id, readOnlyGuestWs)).toBe(false);
    expect(sessionManager.canWriteToSession(id, thirdGuestWs)).toBe(true);

    sessionManager.destroySession(id);
  });

  it("权限降级与固定切换都会立即阻止当前租约持有者写入", () => {
    const id = createConnectedSession();
    const guestWs = makeFakeWs();
    sessionManager.joinAsParticipant(id, guestWs, {
      userId: "member-1",
      permissionLevel: "read-write",
    });
    expect(sessionManager.canWriteToSession(id, guestWs)).toBe(true);

    expect(
      sessionManager.updateSharedParticipantPermission(
        id,
        guestWs,
        "read-only",
      ),
    ).toBe(true);
    expect(sessionManager.canWriteToSession(id, guestWs)).toBe(false);

    const ownerWs = makeFakeWs();
    sessionManager.attachWs(id, "owner-1", ownerWs);
    expect(sessionManager.canWriteToSession(id, ownerWs)).toBe(true);
    sessionManager.getSession(id)!.pinTransitionActive = true;
    expect(sessionManager.canWriteToSession(id, ownerWs)).toBe(false);

    sessionManager.destroySession(id);
  });

  it("destroySession cleans up all participants, not just the owner", () => {
    const id = createConnectedSession();
    const ownerWs = makeFakeWs();
    sessionManager.attachWs(id, "owner-1", ownerWs);

    const guestWs = makeFakeWs();
    sessionManager.joinAsParticipant(id, guestWs, {
      userId: null,
      permissionLevel: "read-only",
    });

    sessionManager.destroySession(id);

    expect(guestWs.send).toHaveBeenCalled();
    expect(sessionManager.getSession(id)).toBeNull();
  });

  it("ownerEndSession notifies non-owner participants and destroys the session", () => {
    const id = createConnectedSession();
    const ownerWs = makeFakeWs();
    sessionManager.attachWs(id, "owner-1", ownerWs);

    const guestWs = makeFakeWs();
    sessionManager.joinAsParticipant(id, guestWs, {
      userId: null,
      permissionLevel: "read-write",
    });

    sessionManager.ownerEndSession(id, "owner ended the session");

    expect(guestWs.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "sessionTerminatedByOwner",
        reason: "owner ended the session",
      }),
    );
    expect(sessionManager.getSession(id)).toBeNull();
  });

  it("撤销所有者权限时清退全部访客但保留固定窗口", () => {
    const id = createConnectedSession();
    const ownerWs = makeFakeWs();
    sessionManager.attachWs(id, "owner-1", ownerWs);

    const linkGuestWs = makeFakeWs();
    const userGuestWs = makeFakeWs();
    sessionManager.joinAsParticipant(id, linkGuestWs, {
      userId: null,
      permissionLevel: "read-write",
      shareId: "share-link",
    });
    sessionManager.joinAsParticipant(id, userGuestWs, {
      userId: "member-1",
      permissionLevel: "read-write",
      shareId: "share-user",
    });
    const session = sessionManager.getSession(id)!;
    session.pinned = true;
    session.managedTmux = true;
    session.tmuxSessionName = `cloudssh-web-${id}`;

    const evicted = sessionManager.evictSharedParticipants(
      id,
      "Host access was revoked",
      "HOST_ACCESS_REVOKED",
    );

    expect(evicted).toBe(2);
    expect(sessionManager.getSession(id)).toBe(session);
    expect(session).toMatchObject({
      pinned: true,
      managedTmux: true,
      tmuxSessionName: `cloudssh-web-${id}`,
      isConnected: true,
    });
    expect(mockFixedDelete).not.toHaveBeenCalled();
    expect(ownerWs.close).not.toHaveBeenCalled();
    for (const guestWs of [linkGuestWs, userGuestWs]) {
      expect(guestWs.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: "sessionTerminatedByOwner",
          reason: "Host access was revoked",
          code: "HOST_ACCESS_REVOKED",
        }),
      );
      expect(guestWs.close).toHaveBeenCalledWith(
        4003,
        "Host access was revoked",
      );
      const participant = sessionManager.getParticipantForWs(session, guestWs);
      expect(participant?.accessRevoked).toBe(true);
      expect(isMessageAllowedForParticipant(participant, "input")).toBe(false);
    }

    linkGuestWs.send.mockClear();
    userGuestWs.send.mockClear();
    sessionManager.broadcast(id, { type: "data", data: "secret-output" });
    expect(linkGuestWs.send).not.toHaveBeenCalled();
    expect(userGuestWs.send).not.toHaveBeenCalled();

    sessionManager.destroySession(id);
  });
});

describe("TerminalSessionManager - disconnect retention and fixed windows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSetting.mockReturnValue(null);
    mockFixedUpsert.mockResolvedValue({});
    mockFixedFindOwned.mockResolvedValue(null);
    mockFixedListOwned.mockResolvedValue([]);
    mockFixedDelete.mockResolvedValue(true);
    mockFixedAttached.mockResolvedValue(true);
    mockFixedDetached.mockResolvedValue(true);
    mockOpenTabUpdate.mockResolvedValue(true);
    mockKillTmuxSession.mockResolvedValue(true);
    mockCanAccessHost.mockResolvedValue({ hasAccess: true });
  });

  function createConnectedSession(tabInstanceId = "tab-1") {
    const id = sessionManager.createSession(
      "retention-user",
      7,
      "server",
      100,
      30,
      tabInstanceId,
      false,
      { recoveryTargetFingerprint: "sha256:test-target-fingerprint" },
    );
    const session = sessionManager.getSession(id)!;
    session.isConnected = true;
    return { id, session };
  }

  it("uses 24 hours when the configured retention is absent or invalid", () => {
    expect(resolveTerminalSessionTimeoutMinutes(null)).toBe(1440);
    expect(resolveTerminalSessionTimeoutMinutes("invalid")).toBe(1440);
    expect(resolveTerminalSessionTimeoutMinutes("10081")).toBe(1440);
    expect(resolveTerminalSessionTimeoutMinutes("60")).toBe(60);
  });

  it("destroys an unpinned session after the configured disconnect retention", () => {
    vi.useFakeTimers();
    try {
      mockGetSetting.mockReturnValue("2");
      const { id } = createConnectedSession();
      sessionManager.attachWs(id, "retention-user", makeFakeWs());
      sessionManager.detachWs(id);

      vi.advanceTimersByTime(2 * 60_000 - 1);
      expect(sessionManager.getSession(id)).not.toBeNull();
      vi.advanceTimersByTime(1);
      expect(sessionManager.getSession(id)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a fresh retention window after every reattachment and detach", () => {
    vi.useFakeTimers();
    try {
      mockGetSetting.mockReturnValue("2");
      const { id } = createConnectedSession();
      sessionManager.attachWs(id, "retention-user", makeFakeWs());
      sessionManager.detachWs(id);
      vi.advanceTimersByTime(60_000);

      sessionManager.attachWs(id, "retention-user", makeFakeWs());
      sessionManager.detachWs(id);
      vi.advanceTimersByTime(60_001);
      expect(sessionManager.getSession(id)).not.toBeNull();
      vi.advanceTimersByTime(59_999);
      expect(sessionManager.getSession(id)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("任意参与者在线时暂停保留计时，最后一个参与者离开后才开始计时", () => {
    vi.useFakeTimers();
    try {
      mockGetSetting.mockReturnValue("2");
      const { id, session } = createConnectedSession();
      const ownerWs = makeFakeWs();
      const guestWs = makeFakeWs();
      sessionManager.attachWs(id, "retention-user", ownerWs);
      sessionManager.joinAsParticipant(id, guestWs, {
        userId: "shared-user",
        permissionLevel: "read-only",
      });

      sessionManager.detachWs(id);

      expect(session.lastDetachedAt).toBeNull();
      expect(session.retentionExpiresAt).toBeNull();
      expect(session.detachTimeout).toBeNull();
      expect(sessionManager.refreshDetachedSessionRetention()).toBe(0);
      vi.advanceTimersByTime(2 * 60_000 + 1);
      expect(sessionManager.getSession(id)).toBe(session);

      const finalDetachAt = Date.now();
      sessionManager.removeParticipant(id, guestWs);
      expect(session.lastDetachedAt).toBe(finalDetachAt);
      expect(session.retentionExpiresAt).toBe(finalDetachAt + 2 * 60_000);

      vi.advanceTimersByTime(2 * 60_000 - 1);
      expect(sessionManager.getSession(id)).toBe(session);
      vi.advanceTimersByTime(1);
      expect(sessionManager.getSession(id)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("共享参与者加入时取消已经启动的断线保留计时", () => {
    vi.useFakeTimers();
    try {
      mockGetSetting.mockReturnValue("2");
      const { id, session } = createConnectedSession();
      const guestWs = makeFakeWs();
      sessionManager.attachWs(id, "retention-user", makeFakeWs());
      sessionManager.detachWs(id);
      vi.advanceTimersByTime(60_000);

      sessionManager.joinAsParticipant(id, guestWs, {
        userId: "late-shared-user",
        permissionLevel: "read-write",
      });

      expect(session.lastDetachedAt).toBeNull();
      expect(session.retentionExpiresAt).toBeNull();
      expect(session.detachTimeout).toBeNull();
      vi.advanceTimersByTime(2 * 60_000);
      expect(sessionManager.getSession(id)).toBe(session);

      sessionManager.removeParticipant(id, guestWs);
      vi.advanceTimersByTime(2 * 60_000);
      expect(sessionManager.getSession(id)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("管理员修改保留时间后立即重排已经断开窗口的到期时间", () => {
    vi.useFakeTimers();
    try {
      mockGetSetting.mockReturnValue("10");
      const { id } = createConnectedSession();
      sessionManager.attachWs(id, "retention-user", makeFakeWs());
      sessionManager.detachWs(id);
      vi.advanceTimersByTime(2 * 60_000);

      mockGetSetting.mockReturnValue("3");
      expect(sessionManager.refreshDetachedSessionRetention()).toBe(1);
      vi.advanceTimersByTime(60_000 - 1);
      expect(sessionManager.getSession(id)).not.toBeNull();
      vi.advanceTimersByTime(1);
      expect(sessionManager.getSession(id)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tracks shell input so an active foreground command is not pinned", () => {
    const { id, session } = createConnectedSession();
    expect(session.hasShellInput).toBe(false);

    sessionManager.bufferInput(id, "long-running-command\r");

    expect(session.hasShellInput).toBe(true);
    sessionManager.destroySession(id);
  });

  it("reports input as blocked while a fixed-window transition is in progress", () => {
    const { id } = createConnectedSession();
    sessionManager.beginPinTransition(id, "retention-user");
    expect(sessionManager.isPinTransitionActive(id)).toBe(true);

    sessionManager.finishPinTransition(id);

    expect(sessionManager.isPinTransitionActive(id)).toBe(false);
    sessionManager.destroySession(id);
  });

  it("固定窗口恢复完成后原子解除过渡并附着发起者", () => {
    const id = sessionManager.createSession(
      "recovery-user",
      17,
      "recovery-host",
      100,
      30,
      "recovery-tab",
      false,
      {
        sessionId: "recovery-session",
        pinned: true,
        tmuxSessionName: "cloudssh-web-recovery-session",
        recovering: true,
      },
    );
    const session = sessionManager.getSession(id)!;
    session.isConnected = true;
    const ws = makeFakeWs();
    sessionManager.bufferOutput(id, "buffered output");

    expect(sessionManager.attachWs(id, "recovery-user", ws)).toBeNull();
    const attached = sessionManager.finishRecoveryAndAttachWs(
      id,
      "recovery-user",
      ws,
      "recovery-tab",
    );

    expect(attached).toBe(session);
    expect(session.pinTransitionActive).toBe(false);
    expect(sessionManager.getParticipantForWs(session, ws)?.isOwner).toBe(true);
    expect(sessionManager.canWriteToSession(id, ws)).toBe(true);
    expect(sessionManager.getBuffer(session)).toBe("buffered output");
    sessionManager.destroySession(id);
  });

  it("refuses a second fixed-window transition for the same session", () => {
    const { id } = createConnectedSession();
    sessionManager.beginPinTransition(id, "retention-user");

    expect(() =>
      sessionManager.beginPinTransition(id, "retention-user"),
    ).toThrow(/already in progress/i);

    sessionManager.finishPinTransition(id);
    sessionManager.destroySession(id);
  });

  it("refuses attachment after expiration has started", () => {
    const { id, session } = createConnectedSession();
    const attachedWs = makeFakeWs();
    sessionManager.attachWs(id, "retention-user", attachedWs);
    session.expirationInProgress = true;

    expect(
      sessionManager.attachWs(id, "retention-user", makeFakeWs()),
    ).toBeNull();
    expect(sessionManager.canWriteToSession(id, attachedWs)).toBe(false);

    session.expirationInProgress = false;
    sessionManager.destroySession(id);
  });

  it("does not arm a cleanup timer for a fixed session", async () => {
    vi.useFakeTimers();
    try {
      const { id } = createConnectedSession();
      await sessionManager.pinSession(
        id,
        "retention-user",
        `cloudssh-web-${id}`,
      );
      sessionManager.getSession(id)!.sshConn = {} as import("ssh2").Client;
      sessionManager.attachWs(id, "retention-user", makeFakeWs());
      sessionManager.detachWs(id);

      expect(sessionManager.getSession(id)?.pinned).toBe(true);
      expect(sessionManager.getSession(id)?.detachTimeout).toBeNull();
      vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000);
      expect(sessionManager.getSession(id)).not.toBeNull();
      sessionManager.destroySession(id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("断网期间固定成功会取消原有普通窗口过期计时", async () => {
    vi.useFakeTimers();
    try {
      const { id, session } = createConnectedSession("pin-during-detach-tab");
      sessionManager.attachWs(id, "retention-user", makeFakeWs());
      sessionManager.detachWs(id);
      expect(session.detachTimeout).not.toBeNull();

      await sessionManager.pinSession(
        id,
        "retention-user",
        `cloudssh-web-${id}`,
      );

      expect(session.pinned).toBe(true);
      expect(session.managedTmux).toBe(true);
      expect(session.detachTimeout).toBeNull();
      expect(session.retentionExpiresAt).toBeNull();
      sessionManager.destroySession(id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("新建 tmux 固定失败回滚后恢复断开保留计时", async () => {
    vi.useFakeTimers();
    try {
      const { id, session } = createConnectedSession("new-tmux-rollback-tab");
      sessionManager.attachWs(id, "retention-user", makeFakeWs());
      sessionManager.detachWs(id);
      expect(session.detachTimeout).not.toBeNull();

      await sessionManager.pinSession(
        id,
        "retention-user",
        `cloudssh-web-${id}`,
      );
      expect(session.detachTimeout).toBeNull();

      expect(
        sessionManager.rollbackKilledManagedPin(id, "retention-user"),
      ).toBe(true);
      expect(session).toMatchObject({
        pinned: false,
        managedTmux: false,
        tmuxSessionName: null,
        tmuxCreatedByCloudSsh: false,
      });
      expect(session.detachTimeout).not.toBeNull();
      expect(session.retentionExpiresAt).not.toBeNull();
      sessionManager.destroySession(id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("平台保活固定不依赖 tmux，且不会写入恢复记录或关闭 SSH", async () => {
    vi.useFakeTimers();
    try {
      const { id, session } = createConnectedSession("platform-tab");

      await sessionManager.pinPlatformSession(id, "retention-user");
      expect(session.pinned).toBe(true);
      expect(session.managedTmux).toBe(false);
      expect(session.tmuxSessionName).toBeNull();
      expect(mockFixedUpsert).not.toHaveBeenCalled();

      sessionManager.attachWs(id, "retention-user", makeFakeWs());
      sessionManager.detachWs(id);
      expect(session.detachTimeout).toBeNull();
      expect(session.retentionExpiresAt).toBeNull();
      expect(mockFixedAttached).not.toHaveBeenCalled();
      expect(mockFixedDetached).not.toHaveBeenCalled();

      vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000);
      expect(sessionManager.getSession(id)).toBe(session);

      await expect(
        sessionManager.terminatePinnedSession(id, "retention-user"),
      ).resolves.toBe(true);
      expect(mockKillTmuxSession).not.toHaveBeenCalled();
      expect(mockFixedDelete).not.toHaveBeenCalled();
      expect(sessionManager.getSession(id)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("平台保活固定前会重新校验项目主机访问权限", async () => {
    const { id } = createConnectedSession("platform-access-tab");
    mockCanAccessHost.mockResolvedValueOnce({ hasAccess: false });

    try {
      await expect(
        sessionManager.pinPlatformSession(id, "retention-user"),
      ).rejects.toThrow(/access is no longer available/i);
      expect(mockFixedUpsert).not.toHaveBeenCalled();
      expect(sessionManager.getSession(id)?.pinned).toBe(false);
    } finally {
      sessionManager.destroySession(id);
    }
  });

  it("平台保活确认失败时回滚为普通断开保留窗口", async () => {
    vi.useFakeTimers();
    try {
      const { id, session } = createConnectedSession("platform-rollback-tab");
      const ws = makeFakeWs();
      sessionManager.attachWs(id, "retention-user", ws);
      await sessionManager.pinPlatformSession(id, "retention-user");

      sessionManager.detachWs(id);
      expect(session.detachTimeout).toBeNull();
      expect(sessionManager.rollbackPlatformPin(id, "retention-user")).toBe(
        true,
      );
      expect(session.pinned).toBe(false);
      expect(session.managedTmux).toBe(false);
      expect(session.detachTimeout).not.toBeNull();
      expect(session.retentionExpiresAt).not.toBeNull();

      sessionManager.destroySession(id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("CloudSSH 新建的临时 tmux 可升级为受管固定窗口", async () => {
    const { id, session } = createConnectedSession("cloudssh-tmux-tab");
    session.tmuxSessionName = `termix-${id}`;
    session.tmuxCreatedByCloudSsh = true;

    await expect(
      sessionManager.pinSession(id, "retention-user", session.tmuxSessionName),
    ).resolves.toBe(session);

    expect(session).toMatchObject({
      pinned: true,
      managedTmux: true,
      tmuxSessionName: `termix-${id}`,
      tmuxCreatedByCloudSsh: true,
    });
    expect(mockFixedUpsert).toHaveBeenCalled();
    sessionManager.destroySession(id);
  });

  it("用户附加的既有 tmux 仍拒绝升级为受管固定窗口", async () => {
    const { id, session } = createConnectedSession("external-tmux-tab");
    session.tmuxSessionName = "manually-attached";
    session.tmuxCreatedByCloudSsh = false;

    await expect(
      sessionManager.pinSession(id, "retention-user", session.tmuxSessionName),
    ).rejects.toThrow(/existing tmux session/i);

    expect(session.pinned).toBe(false);
    expect(session.managedTmux).toBe(false);
    expect(mockFixedUpsert).not.toHaveBeenCalled();
    sessionManager.destroySession(id);
  });

  it("接管临时 tmux 失败时只回滚固定记录而不终止远端窗口", async () => {
    vi.useFakeTimers();
    try {
      const { id, session } = createConnectedSession("adopt-rollback-tab");
      session.tmuxSessionName = `termix-${id}`;
      session.tmuxCreatedByCloudSsh = true;
      await sessionManager.pinSession(
        id,
        "retention-user",
        session.tmuxSessionName,
      );

      await expect(
        sessionManager.rollbackManagedPin(id, "retention-user"),
      ).resolves.toBe(true);

      expect(mockFixedDelete).toHaveBeenCalledWith("retention-user", id);
      expect(mockKillTmuxSession).not.toHaveBeenCalled();
      expect(session).toMatchObject({
        pinned: false,
        managedTmux: false,
        tmuxSessionName: `termix-${id}`,
        tmuxCreatedByCloudSsh: true,
      });
      expect(session.detachTimeout).not.toBeNull();
      sessionManager.destroySession(id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("持久化项目前再次校验精确项目主机权限", async () => {
    const id = sessionManager.createSession(
      "revoked-user",
      71,
      "revoked-host",
      100,
      30,
      "revoked-tab",
      false,
      {
        projectHostId: 171,
        recoveryTargetFingerprint: "sha256:revoked-target",
      },
    );
    sessionManager.getSession(id)!.isConnected = true;
    mockCanAccessHost.mockResolvedValueOnce({ hasAccess: false });

    try {
      await expect(
        sessionManager.pinSession(id, "revoked-user", `cloudssh-web-${id}`),
      ).rejects.toThrow(/access is no longer available/i);
      expect(mockCanAccessHost).toHaveBeenCalledWith(
        "revoked-user",
        71,
        "connect",
        171,
      );
      expect(mockFixedUpsert).not.toHaveBeenCalled();
    } finally {
      sessionManager.destroySession(id);
    }
  });

  it("项目访问缺少精确关联上下文时拒绝固定窗口", async () => {
    const id = sessionManager.createSession(
      "ambiguous-project-user",
      72,
      "ambiguous-project-host",
      100,
      30,
      "ambiguous-project-tab",
      false,
      { recoveryTargetFingerprint: "sha256:ambiguous-project-target" },
    );
    sessionManager.getSession(id)!.isConnected = true;
    mockCanAccessHost.mockResolvedValueOnce({
      hasAccess: true,
      isOwner: false,
      projectHostId: 172,
    });

    try {
      await expect(
        sessionManager.pinSession(
          id,
          "ambiguous-project-user",
          `cloudssh-web-${id}`,
        ),
      ).rejects.toThrow(/project host context is required/i);
      expect(mockFixedUpsert).not.toHaveBeenCalled();
    } finally {
      sessionManager.destroySession(id);
    }
  });

  it("拒绝在固定窗口恢复或切换尚未完成时终止窗口", async () => {
    const { id, session } = createConnectedSession();
    session.pinned = true;
    session.managedTmux = true;
    session.tmuxSessionName = `cloudssh-web-${id}`;
    session.sshConn = {} as import("ssh2").Client;
    session.pinTransitionActive = true;

    await expect(
      sessionManager.terminatePinnedSession(id, "retention-user"),
    ).rejects.toBeInstanceOf(TerminalSessionTransitionError);
    expect(mockKillTmuxSession).not.toHaveBeenCalled();
    expect(mockFixedDelete).not.toHaveBeenCalled();
    expect(sessionManager.getSession(id)).toBe(session);

    sessionManager.finishPinTransition(id);
    await expect(
      sessionManager.terminatePinnedSession(id, "retention-user"),
    ).resolves.toBe(true);
  });

  it("远端 tmux 终止结果异常时保留固定恢复记录", async () => {
    const { id, session } = createConnectedSession();
    session.pinned = true;
    session.managedTmux = true;
    session.tmuxSessionName = `cloudssh-web-${id}`;
    session.sshConn = {} as import("ssh2").Client;
    mockKillTmuxSession.mockResolvedValueOnce(false);

    await expect(
      sessionManager.terminatePinnedSession(id, "retention-user"),
    ).rejects.toThrow(/could not be terminated/i);
    expect(mockFixedDelete).not.toHaveBeenCalled();
    expect(sessionManager.getSession(id)).toBe(session);
  });

  it("enforces the persistent fixed-window limit", async () => {
    const { id } = createConnectedSession();
    mockFixedListOwned.mockResolvedValueOnce(
      Array.from({ length: 10 }, (_, index) => ({ id: `fixed-${index}` })),
    );

    await expect(
      sessionManager.pinSession(id, "retention-user", `cloudssh-web-${id}`),
    ).rejects.toThrow(/Pinned terminal limit reached/);
    expect(mockFixedUpsert).not.toHaveBeenCalled();
    sessionManager.destroySession(id);
  });

  it("kills managed tmux before deleting fixed metadata on explicit close", async () => {
    const { id, session } = createConnectedSession();
    session.pinned = true;
    session.managedTmux = true;
    session.tmuxSessionName = `cloudssh-web-${id}`;
    const sshConn = {} as import("ssh2").Client;
    session.sshConn = sshConn;

    await expect(
      sessionManager.terminatePinnedSession(id, "retention-user"),
    ).resolves.toBe(true);
    expect(mockKillTmuxSession).toHaveBeenCalledWith(
      sshConn,
      `cloudssh-web-${id}`,
    );
    expect(mockFixedDelete).toHaveBeenCalledWith("retention-user", id);
    expect(mockKillTmuxSession.mock.invocationCallOrder[0]).toBeLessThan(
      mockFixedDelete.mock.invocationCallOrder[0],
    );
    expect(sessionManager.getSession(id)).toBeNull();
  });

  it("coalesces concurrent termination requests for the same fixed window", async () => {
    const { id, session } = createConnectedSession();
    session.pinned = true;
    session.managedTmux = true;
    session.tmuxSessionName = `cloudssh-web-${id}`;
    session.sshConn = {} as import("ssh2").Client;

    let finishKill: (() => void) | undefined;
    mockKillTmuxSession.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finishKill = () => resolve(true);
        }),
    );

    const first = sessionManager.terminateSession(id, "retention-user");
    const second = sessionManager.terminateSession(id, "retention-user");
    await vi.waitFor(() =>
      expect(mockKillTmuxSession).toHaveBeenCalledTimes(1),
    );
    finishKill?.();

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(mockKillTmuxSession).toHaveBeenCalledTimes(1);
    expect(mockFixedDelete).toHaveBeenCalledTimes(1);
    expect(sessionManager.getSession(id)).toBeNull();
  });

  it("starts a new recording segment when a fixed session is recovered", () => {
    const id = sessionManager.createSession(
      "recording-user",
      8,
      "server",
      100,
      30,
      "recording-tab",
      true,
      {
        sessionId: "recovered-session",
        pinned: true,
        tmuxSessionName: "cloudssh-web-recovered-session",
        recovering: true,
      },
    );
    const session = sessionManager.getSession(id)!;

    expect(session.recordingPath).toMatch(/recovered-session-\d+\.cast$/);
    expect(session.pinTransitionActive).toBe(true);
    sessionManager.destroySession(id);
  });
});

describe("isMessageAllowedForParticipant", () => {
  it("allows any message type for the owner or when there is no participant", () => {
    expect(isMessageAllowedForParticipant(null, "connectToHost")).toBe(true);
    expect(
      isMessageAllowedForParticipant(
        { isOwner: true, permissionLevel: "read-write" },
        "resize",
      ),
    ).toBe(true);
  });

  it("drops input from a read-only participant", () => {
    expect(
      isMessageAllowedForParticipant(
        { isOwner: false, permissionLevel: "read-only" },
        "input",
      ),
    ).toBe(false);
  });

  it("allows input from a read-write non-owner participant", () => {
    expect(
      isMessageAllowedForParticipant(
        { isOwner: false, permissionLevel: "read-write" },
        "input",
      ),
    ).toBe(true);
  });

  it("allows ping and disconnect for any non-owner participant", () => {
    expect(
      isMessageAllowedForParticipant(
        { isOwner: false, permissionLevel: "read-only" },
        "ping",
      ),
    ).toBe(true);
    expect(
      isMessageAllowedForParticipant(
        { isOwner: false, permissionLevel: "read-only" },
        "disconnect",
      ),
    ).toBe(true);
  });

  it("blocks resize and auth/tmux message types for non-owner participants regardless of permission level", () => {
    for (const type of [
      "resize",
      "totp_response",
      "password_response",
      "tmux_attach",
      "tmux_detach",
      "get_cwd",
      "vault_start_auth",
      "opkssh_start_auth",
    ]) {
      expect(
        isMessageAllowedForParticipant(
          { isOwner: false, permissionLevel: "read-write" },
          type,
        ),
      ).toBe(false);
    }
  });
});

describe("terminal runtime lifecycle helpers", () => {
  it("把 exit 信息传给随后的 close，单独 close 保持为空", () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const stream = {
      on: (event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener);
        return stream;
      },
    } as unknown as Pick<import("ssh2").ClientChannel, "on">;
    const onClose = vi.fn();
    bindTerminalChannelLifecycle(stream, onClose);

    listeners.get("exit")?.(23, undefined);
    listeners.get("close")?.();
    expect(onClose).toHaveBeenLastCalledWith({ code: 23, signal: undefined });

    const closeOnlyListeners = new Map<string, (...args: unknown[]) => void>();
    const closeOnlyStream = {
      on: (event: string, listener: (...args: unknown[]) => void) => {
        closeOnlyListeners.set(event, listener);
        return closeOnlyStream;
      },
    } as unknown as Pick<import("ssh2").ClientChannel, "on">;
    bindTerminalChannelLifecycle(closeOnlyStream, onClose);
    closeOnlyListeners.get("close")?.();
    expect(onClose).toHaveBeenLastCalledWith(null);
  });

  it("只有 exit 才表示 Shell 正常结束，单独 close 视为可恢复断线", () => {
    expect(decideTerminalChannelClose(null, false, null)).toEqual({
      kind: "recoverable-disconnect",
      deleteRecoveryRecord: false,
    });
    expect(decideTerminalChannelClose({ code: 23 }, false, null)).toEqual({
      kind: "session-ended",
      deleteRecoveryRecord: false,
    });
  });

  it("固定窗口仅在 exit 后精确确认 tmux 不存在时删除恢复记录", () => {
    expect(decideTerminalChannelClose({ code: 0 }, true, "missing")).toEqual({
      kind: "session-ended",
      deleteRecoveryRecord: true,
    });
    for (const probe of ["found", "unknown", null] as const) {
      expect(decideTerminalChannelClose({ code: 0 }, true, probe)).toEqual({
        kind: "recoverable-disconnect",
        deleteRecoveryRecord: false,
      });
    }
  });

  it("显式消费异步事件处理失败并交给统一错误边界", async () => {
    const failure = new Error("ready workflow failed");
    const onError = vi.fn();

    runGuardedTerminalTask(async () => {
      throw failure;
    }, onError);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("恢复记录查询失败或记录仍在时不会误判为过期", async () => {
    const lookupFailure = new Error("database unavailable");
    const onError = vi.fn();

    await expect(
      inspectTerminalRecoveryRecord(async () => ({ id: "fixed-session" })),
    ).resolves.toBe("retained");
    await expect(inspectTerminalRecoveryRecord(async () => null)).resolves.toBe(
      "missing",
    );
    await expect(
      inspectTerminalRecoveryRecord(async () => {
        throw lookupFailure;
      }, onError),
    ).resolves.toBe("unknown");
    expect(onError).toHaveBeenCalledWith(lookupFailure);
  });
});
