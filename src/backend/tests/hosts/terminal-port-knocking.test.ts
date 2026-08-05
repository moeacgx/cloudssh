import { EventEmitter } from "events";
import { describe, expect, it, vi } from "vitest";
import { performPortKnocking } from "../../hosts/terminal-auth-helpers.js";

class FakeTcpSocket extends EventEmitter {
  readonly connect = vi.fn();
  readonly destroy = vi.fn();
}

describe("performPortKnocking", () => {
  it("continues through TCP knock errors", async () => {
    const first = new FakeTcpSocket();
    const second = new FakeTcpSocket();
    const wait = vi.fn().mockResolvedValue(undefined);

    const knocking = performPortKnocking(
      "192.0.2.10",
      [
        { port: 1111, protocol: "tcp", delay: 10 },
        { port: 2222, protocol: "tcp", delay: 0 },
      ],
      {
        createTcpSocket: vi
          .fn()
          .mockReturnValueOnce(first)
          .mockReturnValueOnce(second),
        wait,
      },
    );

    first.emit("error", new Error("closed"));
    await Promise.resolve();
    second.emit("connect");
    await knocking;

    expect(first.connect).toHaveBeenCalledWith(1111, "192.0.2.10");
    expect(second.connect).toHaveBeenCalledWith(2222, "192.0.2.10");
    expect(first.destroy).toHaveBeenCalled();
    expect(second.destroy).toHaveBeenCalled();
    expect(wait).toHaveBeenCalledWith(10);
  });

  it("times out TCP knocks that are silently dropped", async () => {
    const socket = new FakeTcpSocket();
    const wait = vi.fn().mockResolvedValue(undefined);

    await performPortKnocking("192.0.2.10", [{ port: 1111, delay: 0 }], {
      createTcpSocket: () => socket as never,
      tcpTimeoutMs: 1,
      wait,
    });

    expect(socket.connect).toHaveBeenCalledWith(1111, "192.0.2.10");
    expect(socket.destroy).toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
  });

  it("取消活动敲门时立即关闭 socket", async () => {
    const socket = new FakeTcpSocket();
    const controller = new AbortController();
    const knocking = performPortKnocking(
      "192.0.2.10",
      [{ port: 1111, protocol: "tcp", delay: 0 }],
      {
        createTcpSocket: () => socket as never,
        signal: controller.signal,
      },
    );

    controller.abort(new Error("request disconnected"));

    await expect(knocking).rejects.toThrow("request disconnected");
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("取消敲门延时后不再执行后续网络动作", async () => {
    const first = new FakeTcpSocket();
    const second = new FakeTcpSocket();
    const createTcpSocket = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    let finishDelay!: () => void;
    const wait = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDelay = resolve;
        }),
    );
    const controller = new AbortController();
    const knocking = performPortKnocking(
      "192.0.2.10",
      [
        { port: 1111, protocol: "tcp", delay: 200 },
        { port: 2222, protocol: "tcp", delay: 0 },
      ],
      { createTcpSocket, wait, signal: controller.signal },
    );

    first.emit("connect");
    await vi.waitFor(() => expect(wait).toHaveBeenCalledWith(200));
    controller.abort(new Error("request disconnected"));

    await expect(knocking).rejects.toThrow("request disconnected");
    finishDelay();
    await Promise.resolve();
    expect(createTcpSocket).toHaveBeenCalledTimes(1);
    expect(second.connect).not.toHaveBeenCalled();
    expect(first.destroy).toHaveBeenCalled();
  });
});
