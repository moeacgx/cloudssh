import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";

const api = vi.hoisted(() => ({
  resolveShareLink: vi.fn(async () => {
    throw new Error("resolveShareLink not mocked for this test");
  }),
  ShareLinkError: class ShareLinkError extends Error {
    kind: string;
    constructor(message: string, kind: string) {
      super(message);
      this.kind = kind;
    }
  },
}));

const xterm = vi.hoisted(() => ({
  write: vi.fn(),
  onData: vi.fn(),
}));

vi.mock("@/api/session-sharing-api", () => api);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("react-xtermjs", () => ({
  useXTerm: () => ({
    instance: {
      loadAddon: vi.fn(),
      open: vi.fn(),
      write: xterm.write,
      onData: xterm.onData,
      options: {},
    },
    ref: { current: document.createElement("div") },
  }),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class FitAddon {
    fit() {}
  },
}));

vi.mock("@/features/guacamole/GuacamoleDisplay.tsx", () => ({
  GuacamoleDisplay: () => <div data-testid="guacamole-display" />,
}));

import SharedSessionView from "../../../features/session-sharing/SharedSessionView";

class MockWebSocket {
  static readonly OPEN = 1;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.onclose?.();
  }

  message(message: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

function setSearch(search: string) {
  window.history.pushState({}, "", `/?${search}`);
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  MockWebSocket.instances = [];
  xterm.write.mockReset();
  xterm.onData.mockReset();
  api.resolveShareLink.mockReset();
  api.resolveShareLink.mockImplementation(async () => {
    throw new Error("resolveShareLink not mocked for this test");
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SharedSessionView", () => {
  it("shows a friendly error when no token is present in the URL", async () => {
    setSearch("view=shared");

    render(<SharedSessionView />);

    await waitFor(() => {
      expect(
        screen.getByText("sessionSharing.guestView.linkInvalid"),
      ).toBeTruthy();
    });
    expect(api.resolveShareLink).not.toHaveBeenCalled();
  });

  it("shows a generic error when the link is invalid or expired", async () => {
    setSearch("view=shared&token=bad");
    api.resolveShareLink.mockRejectedValue(
      new api.ShareLinkError("not found", "not-found"),
    );

    render(<SharedSessionView />);

    await waitFor(() => {
      expect(
        screen.getByText("sessionSharing.guestView.linkInvalid"),
      ).toBeTruthy();
    });
  });

  it("shows a rate-limit specific message on 429", async () => {
    setSearch("view=shared&token=abc");
    api.resolveShareLink.mockRejectedValue(
      new api.ShareLinkError("slow down", "rate-limited"),
    );

    render(<SharedSessionView />);

    await waitFor(() => {
      expect(api.resolveShareLink).toHaveBeenCalledWith("abc");
    });
    await waitFor(() => {
      expect(
        screen.getByText("sessionSharing.guestView.rateLimited"),
      ).toBeTruthy();
    });
  });

  it("renders the guacamole display for a resolved rdp share", async () => {
    setSearch("view=shared&token=abc");
    api.resolveShareLink.mockResolvedValue({
      protocol: "rdp",
      permissionLevel: "read-only",
      wsPath: "/guacamole/websocket/",
      connectParams: { token: "guac-join-token" },
    });

    render(<SharedSessionView />);

    await waitFor(() => {
      expect(screen.getByTestId("guacamole-display")).toBeTruthy();
    });
    expect(
      screen.getByText("sessionSharing.guestView.readOnlyBadge"),
    ).toBeTruthy();
  });

  it("writes a warning when shared terminal input is blocked during pinning", async () => {
    setSearch("view=shared&token=abc");
    api.resolveShareLink.mockResolvedValue({
      protocol: "ssh",
      permissionLevel: "read-write",
    });

    render(<SharedSessionView />);

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    MockWebSocket.instances[0].message({ type: "sessionInputBlocked" });

    expect(xterm.write).toHaveBeenCalledWith(
      "\r\n\x1b[33mterminal.sessionInputBlocked\x1b[0m\r\n",
    );
  });
});
