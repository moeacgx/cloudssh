import { describe, expect, it, vi } from "vitest";
import { replaceTerminalInputListener } from "@/features/terminal/terminal-input-listener";

describe("终端输入监听器", () => {
  it("重连时释放旧监听器并且只向当前连接发送一次输入", () => {
    const listeners = new Set<(data: string) => void>();
    const source = {
      onData(listener: (data: string) => void) {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    };
    const firstConnection = vi.fn();
    const secondConnection = vi.fn();

    let disposable = replaceTerminalInputListener(
      null,
      source,
      firstConnection,
    );
    disposable = replaceTerminalInputListener(
      disposable,
      source,
      secondConnection,
    );
    for (const listener of listeners) listener("whoami\r");

    expect(listeners.size).toBe(1);
    expect(firstConnection).not.toHaveBeenCalled();
    expect(secondConnection).toHaveBeenCalledOnce();
    expect(secondConnection).toHaveBeenCalledWith("whoami\r");

    disposable.dispose();
    expect(listeners.size).toBe(0);
  });
});
