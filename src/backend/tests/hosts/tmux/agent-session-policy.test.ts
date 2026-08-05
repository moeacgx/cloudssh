import { beforeEach, describe, expect, it, vi } from "vitest";

const sqlite = vi.hoisted(() => ({
  prepare: vi.fn(),
}));

vi.mock("../../../database/repositories/factory.js", () => ({
  getCurrentRepositorySqlite: () => sqlite,
}));

import {
  hideAgentManagedTmuxSessions,
  isAgentControlledTerminalSession,
  isAgentManagedTmuxSession,
} from "../../../hosts/tmux/agent-session-policy.js";

describe("Agent tmux session policy", () => {
  beforeEach(() => {
    sqlite.prepare.mockReset();
  });

  it("数据库命中时按全局唯一名称识别 Agent 窗口", () => {
    const get = vi.fn().mockReturnValue({ ok: 1 });
    sqlite.prepare.mockReturnValue({ get });

    expect(isAgentManagedTmuxSession("cloudssh-agent-session", 7)).toBe(true);
    expect(get).toHaveBeenCalledWith("cloudssh-agent-session");
    expect(String(sqlite.prepare.mock.calls[0]?.[0])).not.toContain(
      "project_host.host_id = ?",
    );
  });

  it("数据库未命中时不误拦截普通窗口", () => {
    const get = vi.fn().mockReturnValue(undefined);
    sqlite.prepare.mockReturnValue({ get });

    expect(isAgentManagedTmuxSession("termix-7-abcd", 7)).toBe(false);
    expect(get).toHaveBeenCalledWith("termix-7-abcd");
  });

  it("同一物理服务器以不同 hostId 录入时仍保护 Agent 窗口", () => {
    const get = vi.fn().mockReturnValue({ ok: 1 });
    sqlite.prepare.mockReturnValue({ get });

    expect(isAgentManagedTmuxSession("cloudssh-agent-session", 8)).toBe(true);
    expect(get).toHaveBeenCalledWith("cloudssh-agent-session");
  });

  it("列表中只隐藏已登记的 Agent 窗口", () => {
    const get = vi.fn((tmuxName: string) =>
      tmuxName === "cloudssh-agent-session" ? { ok: 1 } : undefined,
    );
    sqlite.prepare.mockReturnValue({ get });

    expect(
      hideAgentManagedTmuxSessions(
        [
          { name: "cloudssh-agent-session" },
          { name: "cloudssh-web-session" },
          { name: "termix-7-abcd" },
        ],
        7,
      ),
    ).toEqual([{ name: "cloudssh-web-session" }, { name: "termix-7-abcd" }]);
  });

  it("数据库不可用时对 Agent 名称失败关闭，保留网页固定窗口", () => {
    sqlite.prepare.mockImplementation(() => {
      throw new Error("database unavailable");
    });

    expect(
      isAgentManagedTmuxSession(
        "cloudssh-123e4567-e89b-12d3-a456-426614174000",
      ),
    ).toBe(true);
    expect(isAgentManagedTmuxSession("cloudssh-web-12345678")).toBe(false);
    expect(isAgentManagedTmuxSession("termix-7-abcd")).toBe(false);
  });

  it("未指定主机时同样按 tmux 名称查询", () => {
    const get = vi.fn().mockReturnValue({ ok: 1 });
    sqlite.prepare.mockReturnValue({ get });

    expect(isAgentManagedTmuxSession("cloudssh-agent-session")).toBe(true);
    expect(get).toHaveBeenCalledWith("cloudssh-agent-session");
    expect(String(sqlite.prepare.mock.calls[0]?.[0])).not.toContain(
      "project_host.host_id = ?",
    );
  });

  it("只将带 Agent 来源标识的本地会话交给专用附着流程", () => {
    expect(
      isAgentControlledTerminalSession({
        agentSessionId: "agent-session-123456",
      }),
    ).toBe(true);
    expect(isAgentControlledTerminalSession({ agentSessionId: null })).toBe(
      false,
    );
    expect(isAgentControlledTerminalSession(undefined)).toBe(false);
  });
});
