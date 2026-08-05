import { describe, expect, it, vi } from "vitest";

vi.mock("ws", () => {
  class TestWebSocket {
    static readonly OPEN = 1;
  }
  class TestWebSocketServer {
    on() {
      return this;
    }
  }
  return { WebSocket: TestWebSocket, WebSocketServer: TestWebSocketServer };
});

vi.mock("../../../utils/auth-manager.js", () => ({
  AuthManager: { getInstance: () => ({}) },
}));

const { AgentOutputSequencer } =
  await import("../../../hosts/terminal/index.js");

function chunk(generation: number, sequence: number, data: string) {
  return {
    generation,
    sequence,
    data,
    timestamp: "2026-08-03T00:00:00.000Z",
  };
}

describe("Agent platform output sequencer", () => {
  it("先订阅后读快照时按游标顺序输出并消除重复块", () => {
    const emitted: string[] = [];
    const sequencer = new AgentOutputSequencer((output) => {
      emitted.push(output.data);
    });

    // sequence 2 先从实时订阅到达，随后快照包含 0、1、2。
    sequencer.enqueue(chunk(1, 2, "live-2"));
    sequencer.enqueue(chunk(1, 0, "history-0"));
    sequencer.enqueue(chunk(1, 1, "history-1"));
    sequencer.enqueue(chunk(1, 2, "history-duplicate-2"));
    expect(emitted).toEqual([]);

    sequencer.startLive();
    sequencer.enqueue(chunk(1, 3, "live-3"));
    sequencer.enqueue(chunk(1, 1, "late-duplicate"));

    expect(emitted).toEqual([
      "history-0",
      "history-1",
      "history-duplicate-2",
      "live-3",
    ]);
  });

  it("恢复后的新 generation 排在旧 generation 之后", () => {
    const emitted: string[] = [];
    const sequencer = new AgentOutputSequencer((output) => {
      emitted.push(output.data);
    });

    sequencer.enqueue(chunk(2, 0, "generation-2"));
    sequencer.enqueue(chunk(1, 8, "generation-1"));
    sequencer.startLive();

    expect(emitted).toEqual(["generation-1", "generation-2"]);
  });
});
