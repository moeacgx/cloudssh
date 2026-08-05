import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SSHHost } from "../../../types/index.js";

const mocks = vi.hoisted(() => ({
  createSocks5Connection: vi.fn(),
  createJumpHostChain: vi.fn(),
}));

vi.mock("../../utils/socks5-helper.js", () => ({
  createSocks5Connection: mocks.createSocks5Connection,
}));

vi.mock("../jump-host-chain.js", () => ({
  createJumpHostChain: mocks.createJumpHostChain,
}));

import { startDedicatedTransferConnect } from "./ssh-connection.js";

class FakeClient extends EventEmitter {
  connect = vi.fn();
}

function host(overrides: Partial<SSHHost> = {}): SSHHost {
  return {
    id: 42,
    name: "生产主机",
    ip: "192.0.2.42",
    port: 22,
    username: "root",
    authType: "password",
    password: "secret",
    ...overrides,
  } as SSHHost;
}

describe("文件传输 SSH 路由", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("SOCKS5 连接失败时拒绝请求且绝不回退直连", async () => {
    mocks.createSocks5Connection.mockResolvedValue(null);
    const client = new FakeClient();

    await expect(
      startDedicatedTransferConnect(
        client as never,
        {},
        host({ useSocks5: true, socks5Host: "127.0.0.1" }),
        "owner-1",
      ),
    ).rejects.toThrow("Failed to connect through SOCKS5 proxy");

    expect(client.connect).not.toHaveBeenCalled();
  });

  it("跳板连接失败时拒绝请求且绝不回退直连", async () => {
    mocks.createJumpHostChain.mockResolvedValue(null);
    const client = new FakeClient();

    await expect(
      startDedicatedTransferConnect(
        client as never,
        {},
        host({ jumpHosts: [{ hostId: 7 }] as never }),
        "owner-1",
      ),
    ).rejects.toThrow("Failed to connect through jump hosts");

    expect(client.connect).not.toHaveBeenCalled();
    expect(mocks.createSocks5Connection).not.toHaveBeenCalled();
  });

  it("等待 SOCKS5 时取消会销毁迟到的代理连接", async () => {
    let resolveSocket!: (socket: { destroy: ReturnType<typeof vi.fn> }) => void;
    mocks.createSocks5Connection.mockReturnValue(
      new Promise((resolve) => {
        resolveSocket = resolve;
      }),
    );
    const socket = { destroy: vi.fn() };
    const client = new FakeClient();
    const controller = new AbortController();
    const connecting = startDedicatedTransferConnect(
      client as never,
      {},
      host({ useSocks5: true, socks5Host: "127.0.0.1" }),
      "owner-1",
      controller.signal,
    );

    controller.abort(new Error("request disconnected"));
    await expect(connecting).rejects.toThrow("request disconnected");
    resolveSocket(socket);
    await vi.waitFor(() => expect(socket.destroy).toHaveBeenCalledOnce());
    expect(socket.destroy).toHaveBeenCalledOnce();
    expect(client.connect).not.toHaveBeenCalled();
  });

  it("等待跳板时取消会关闭迟到的跳板连接", async () => {
    let resolveJump!: (jump: {
      end: ReturnType<typeof vi.fn>;
      forwardOut: ReturnType<typeof vi.fn>;
    }) => void;
    mocks.createJumpHostChain.mockReturnValue(
      new Promise((resolve) => {
        resolveJump = resolve;
      }),
    );
    const jump = { end: vi.fn(), forwardOut: vi.fn() };
    const client = new FakeClient();
    const controller = new AbortController();
    const connecting = startDedicatedTransferConnect(
      client as never,
      {},
      host({ jumpHosts: [{ hostId: 7 }] as never }),
      "owner-1",
      controller.signal,
    );

    controller.abort(new Error("request disconnected"));
    await expect(connecting).rejects.toThrow("request disconnected");
    resolveJump(jump);
    await vi.waitFor(() => expect(jump.end).toHaveBeenCalledOnce());
    expect(jump.end).toHaveBeenCalledOnce();
    expect(jump.forwardOut).not.toHaveBeenCalled();
    expect(client.connect).not.toHaveBeenCalled();
  });

  it("跳板转发失败会关闭跳板并拒绝直连", async () => {
    const jump = {
      end: vi.fn(),
      forwardOut: vi.fn(
        (
          _sourceHost: string,
          _sourcePort: number,
          _destinationHost: string,
          _destinationPort: number,
          callback: (error: Error) => void,
        ) => callback(new Error("forward denied")),
      ),
    };
    mocks.createJumpHostChain.mockResolvedValue(jump);
    const client = new FakeClient();

    await expect(
      startDedicatedTransferConnect(
        client as never,
        {},
        host({ jumpHosts: [{ hostId: 7 }] as never }),
        "owner-1",
      ),
    ).rejects.toThrow("forward denied");

    expect(jump.end).toHaveBeenCalledOnce();
    expect(client.connect).not.toHaveBeenCalled();
  });

  it("跳板转发同步抛错时仍会关闭跳板", async () => {
    const jump = {
      end: vi.fn(),
      forwardOut: vi.fn(() => {
        throw new Error("forward crashed");
      }),
    };
    mocks.createJumpHostChain.mockResolvedValue(jump);
    const client = new FakeClient();

    await expect(
      startDedicatedTransferConnect(
        client as never,
        {},
        host({ jumpHosts: [{ hostId: 7 }] as never }),
        "owner-1",
      ),
    ).rejects.toThrow("forward crashed");

    expect(jump.end).toHaveBeenCalledOnce();
    expect(client.connect).not.toHaveBeenCalled();
  });

  it("等待跳板转发回调时取消会立即关闭跳板", async () => {
    let forwardCallback!: (
      error: undefined,
      socket: { destroy: ReturnType<typeof vi.fn> },
    ) => void;
    const jump = {
      end: vi.fn(),
      forwardOut: vi.fn(
        (
          _sourceHost: string,
          _sourcePort: number,
          _destinationHost: string,
          _destinationPort: number,
          callback: typeof forwardCallback,
        ) => {
          forwardCallback = callback;
        },
      ),
    };
    mocks.createJumpHostChain.mockResolvedValue(jump);
    const client = new FakeClient();
    const controller = new AbortController();
    const connecting = startDedicatedTransferConnect(
      client as never,
      {},
      host({ jumpHosts: [{ hostId: 7 }] as never }),
      "owner-1",
      controller.signal,
    );
    await vi.waitFor(() => expect(jump.forwardOut).toHaveBeenCalledOnce());

    controller.abort(new Error("request disconnected"));

    await expect(connecting).rejects.toThrow("request disconnected");
    expect(jump.end).toHaveBeenCalledOnce();
    expect(client.connect).not.toHaveBeenCalled();

    const lateStream = { destroy: vi.fn() };
    forwardCallback(undefined, lateStream);
    expect(lateStream.destroy).toHaveBeenCalledOnce();
    expect(client.connect).not.toHaveBeenCalled();
  });

  it("跳板转发成功后在目标客户端关闭时释放跳板", async () => {
    const stream = { destroy: vi.fn() };
    const jump = {
      end: vi.fn(),
      forwardOut: vi.fn(
        (
          _sourceHost: string,
          _sourcePort: number,
          _destinationHost: string,
          _destinationPort: number,
          callback: (error: undefined, socket: typeof stream) => void,
        ) => callback(undefined, stream),
      ),
    };
    mocks.createJumpHostChain.mockResolvedValue(jump);
    const client = new FakeClient();
    const config: Record<string, unknown> = {};

    await startDedicatedTransferConnect(
      client as never,
      config,
      host({ jumpHosts: [{ hostId: 7 }] as never }),
      "owner-1",
    );

    expect(client.connect).toHaveBeenCalledWith(
      expect.objectContaining({ sock: stream }),
    );
    client.emit("close");
    expect(jump.end).toHaveBeenCalledOnce();
  });
});
