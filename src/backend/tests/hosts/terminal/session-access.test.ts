import { describe, expect, it, vi } from "vitest";
import { filterSessionsByHostAccess } from "../../../hosts/terminal/session-access.js";

describe("终端会话列表权限过滤", () => {
  it("只保留当前仍可访问的会话并维持顺序", async () => {
    const sessions = [
      { id: "allowed-first" },
      { id: "revoked" },
      { id: "allowed-last" },
    ];
    const hasAccess = vi.fn(async (session: { id: string }) =>
      session.id.startsWith("allowed"),
    );

    await expect(
      filterSessionsByHostAccess(sessions, hasAccess),
    ).resolves.toEqual([sessions[0], sessions[2]]);
  });

  it("权限检查失败时不返回对应会话", async () => {
    const sessions = [{ id: "permission-error" }];

    await expect(
      filterSessionsByHostAccess(sessions, async () => {
        throw new Error("permission database unavailable");
      }),
    ).resolves.toEqual([]);
  });
});
