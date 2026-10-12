import { describe, expect, it, vi } from "vitest";
import { validateFileManagerConnectInput } from "../../../hosts/file-manager/connect-input.js";

function validate(overrides: unknown) {
  const next = vi.fn();
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  validateFileManagerConnectInput(
    { body: overrides } as never,
    res as never,
    next,
  );
  return { next, res };
}
const valid = {
  sessionId: "file:42:0:test",
  hostId: 42,
  ip: "127.0.0.1",
  port: 22,
  username: "ops",
};

describe("SSH 连接输入边界", () => {
  it.each([{}, [], true, null, "22", 0, -1, 65536, 22.5])(
    "拒绝非法端口 %j 且不进入连接处理",
    (port) => {
      const { next, res } = validate({ ...valid, port });
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    },
  );
  it.each([
    { hostId: [] },
    { hostId: {} },
    { hostId: true },
    { hostId: "oops" },
    { ip: {} },
    { ip: "\0" },
    { username: [] },
    { projectHostId: true },
  ])("拒绝错误类型 %j", (patch) => {
    const { next, res } = validate({ ...valid, ...patch });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
  it.each(["127.0.0.1", "10.0.0.2", "[::1]", "ssh.example.test"])(
    "保留合法 SSH 目标 %s，后续仍需主机授权",
    (ip) => {
      expect(validate({ ...valid, ip }).next).toHaveBeenCalledOnce();
    },
  );
  it("保留快速连接的负数主机 ID", () => {
    expect(
      validate({ ...valid, hostId: -123, sessionId: "-123" }).next,
    ).toHaveBeenCalledOnce();
  });
});
