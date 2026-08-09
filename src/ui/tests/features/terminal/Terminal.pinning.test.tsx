import React, { createRef } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TerminalHandle } from "@/features/terminal/terminal-types";

const terminalHarness = vi.hoisted(() => {
  const state: {
    dataListener: ((data: string) => void) | null;
  } = { dataListener: null };

  const terminal = {
    options: {} as Record<string, unknown>,
    cols: 80,
    rows: 24,
    unicode: { activeVersion: "" },
    modes: { applicationCursorKeysMode: false },
    buffer: { active: { cursorX: 0, cursorY: 0 } },
    loadAddon: vi.fn(),
    open: vi.fn(),
    write: vi.fn(),
    clear: vi.fn(),
    focus: vi.fn(),
    paste: vi.fn(),
    refresh: vi.fn(),
    scrollLines: vi.fn(),
    hasSelection: vi.fn(() => false),
    getSelection: vi.fn(() => ""),
    clearSelection: vi.fn(),
    onTitleChange: vi.fn(() => ({ dispose: vi.fn() })),
    attachCustomWheelEventHandler: vi.fn(),
    attachCustomKeyEventHandler: vi.fn(),
    onData: vi.fn((listener: (data: string) => void) => {
      state.dataListener = listener;
      return {
        dispose: () => {
          if (state.dataListener === listener) state.dataListener = null;
        },
      };
    }),
  };

  return {
    terminal,
    xtermRef: { current: null as HTMLDivElement | null },
    emitData(data: string) {
      if (terminal.options.disableStdin !== true) state.dataListener?.(data);
    },
    reset() {
      state.dataListener = null;
      terminal.options = {};
      vi.clearAllMocks();
    },
  };
});

const toastHarness = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));

const commandHistoryHarness = vi.hoisted(() => ({
  setIsLoading: vi.fn(),
  setCommandHistory: vi.fn(),
  setOnSelectCommand: vi.fn(),
  setOnDeleteCommand: vi.fn(),
}));

const confirmationHarness = vi.hoisted(() => ({
  confirmWithToast: vi.fn(async (_options: unknown, callback?: () => void) => {
    callback?.();
    return true;
  }),
}));

const mainAxiosHarness = vi.hoisted(() => ({
  getSnippets: vi.fn<() => Promise<Array<{ id: number; content: string }>>>(),
}));

vi.mock("react-xtermjs", () => ({
  useXTerm: () => ({
    instance: terminalHarness.terminal,
    ref: terminalHarness.xtermRef,
  }),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class FitAddon {
    fit() {}
  },
}));

vi.mock("@xterm/addon-clipboard", () => ({
  ClipboardAddon: class ClipboardAddon {},
}));

vi.mock("@xterm/addon-unicode11", () => ({
  Unicode11Addon: class Unicode11Addon {},
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class WebLinksAddon {},
}));

vi.mock("@/lib/clipboard-provider", () => ({
  RobustClipboardProvider: class RobustClipboardProvider {
    dispose() {}
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/main-axios.ts", () => ({
  getCookie: vi.fn(() => null),
  isElectron: vi.fn(() => false),
  logActivity: vi.fn(async () => undefined),
  getSnippets: mainAxiosHarness.getSnippets,
  deleteCommandFromHistory: vi.fn(async () => undefined),
  getCommandHistory: vi.fn(async () => []),
  getHostPassword: vi.fn(async () => null),
  patchOpenTab: vi.fn(async () => undefined),
}));

vi.mock("@/features/terminal/command-history/useCommandTracker.ts", () => ({
  useCommandTracker: () => ({
    trackInput: vi.fn(),
    getCurrentCommand: vi.fn(() => ""),
    updateCurrentCommand: vi.fn(),
  }),
}));

vi.mock(
  "@/features/terminal/command-history/CommandHistoryContext.tsx",
  () => ({ useCommandHistory: () => commandHistoryHarness }),
);

vi.mock("@/hooks/use-confirmation.ts", () => ({
  useConfirmation: () => confirmationHarness,
}));

vi.mock("@/components/theme-provider.tsx", () => ({
  useTheme: () => ({ theme: "dark" }),
}));

vi.mock("@/ssh/connection-log/ConnectionLogContext.tsx", () => ({
  ConnectionLogProvider: ({ children }: { children: React.ReactNode }) =>
    children,
  useConnectionLog: () => ({ addLog: vi.fn(), isExpanded: false }),
}));

vi.mock("@/ssh/connection-log/ConnectionLog.tsx", () => ({
  ConnectionLog: () => null,
}));

vi.mock("@/features/terminal/command-history/CommandAutocomplete.tsx", () => ({
  CommandAutocomplete: () => null,
}));

vi.mock("@/features/session-sharing/ShareSessionModal.tsx", () => ({
  ShareSessionModal: () => null,
}));

vi.mock("@/lib/SimpleLoader.tsx", () => ({ SimpleLoader: () => null }));

vi.mock("@/ssh/dialogs/TOTPDialog.tsx", () => ({ TOTPDialog: () => null }));
vi.mock("@/ssh/dialogs/SSHAuthDialog.tsx", () => ({
  SSHAuthDialog: () => null,
}));
vi.mock("@/ssh/dialogs/PassphraseDialog.tsx", () => ({
  PassphraseDialog: () => null,
}));
vi.mock("@/ssh/dialogs/WarpgateDialog.tsx", () => ({
  WarpgateDialog: () => null,
}));
vi.mock("@/ssh/dialogs/OPKSSHDialog.tsx", () => ({
  OPKSSHDialog: () => null,
}));
vi.mock("@/ssh/dialogs/HostKeyVerificationDialog.tsx", () => ({
  HostKeyVerificationDialog: () => null,
}));
vi.mock("@/ssh/dialogs/TmuxSessionPicker.tsx", () => ({
  TmuxSessionPicker: () => null,
}));
vi.mock("@/ssh/dialogs/TmuxInstallChoiceDialog.tsx", () => ({
  TmuxInstallChoiceDialog: ({
    isOpen,
    stage,
    pendingMode,
    onUseTmux,
    onInstall,
    onPlatformKeepalive,
    onCancel,
  }: {
    isOpen: boolean;
    stage: "mode" | "install";
    pendingMode: "tmux" | "install_tmux" | "platform" | null;
    onUseTmux: () => void;
    onInstall: () => void;
    onPlatformKeepalive: () => void;
    onCancel: () => void;
  }) =>
    isOpen ? (
      <div data-testid="tmux-install-choice">
        <button
          disabled={pendingMode !== null}
          onClick={stage === "mode" ? onUseTmux : onInstall}
        >
          {stage === "mode" ? "use-tmux" : "install-tmux"}
        </button>
        <button disabled={pendingMode !== null} onClick={onPlatformKeepalive}>
          platform-keepalive
        </button>
        <button disabled={pendingMode !== null} onClick={onCancel}>
          cancel-pin
        </button>
      </div>
    ) : null,
}));

vi.mock("@/features/terminal/terminal-global-styles.ts", () => ({
  ensureTerminalFontsLoaded: vi.fn(),
}));

vi.mock("@/api/open-tabs-api", () => ({
  getUserPreferences: vi.fn(async () => ({})),
  parseCustomKeybindings: vi.fn(() => []),
}));

vi.mock("@/lib/global-shortcut-handler", () => ({
  globalShortcutHandler: { current: null },
}));

vi.mock("sonner", () => ({ toast: toastHarness }));

import { Terminal } from "@/features/terminal/Terminal";

type WebSocketListener = (event: { data?: string; code?: number }) => void;

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  private listeners = new Map<string, Set<WebSocketListener>>();

  constructor(url: string | URL) {
    this.url = String(url);
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: WebSocketListener) {
    const listeners = this.listeners.get(type) ?? new Set<WebSocketListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: WebSocketListener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.dispatch("close", { code: 1000 });
  }

  fail(code = 1006) {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.dispatch("close", { code });
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.dispatch("open", {});
  }

  message(message: Record<string, unknown>) {
    this.dispatch("message", { data: JSON.stringify(message) });
  }

  private dispatch(type: string, event: { data?: string; code?: number }) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

function sentMessages(socket: MockWebSocket) {
  return socket.sent.map((entry) => JSON.parse(entry));
}

async function renderConnectedTerminal(
  terminalProps: Partial<React.ComponentProps<typeof Terminal>> = {},
) {
  const ref = createRef<TerminalHandle>();

  render(
    <Terminal
      ref={ref}
      hostConfig={{
        id: 42,
        instanceId: "tab-42",
        ip: "192.0.2.42",
        port: 22,
        username: "tester",
      }}
      isVisible={true}
      {...terminalProps}
    />,
  );

  await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
  const socket = MockWebSocket.instances[0];

  act(() => socket.open());
  act(() => socket.message({ type: "sessionCreated", sessionId: "sess-42" }));

  expect(ref.current).not.toBeNull();
  return { ref, socket };
}

async function renderRestoredTerminal(sessionId = "sess-restored") {
  const ref = createRef<TerminalHandle>();

  render(
    <Terminal
      ref={ref}
      hostConfig={{
        id: 42,
        instanceId: "tab-42",
        restoredSessionId: sessionId,
        ip: "192.0.2.42",
        port: 22,
        username: "tester",
      }}
      isVisible={true}
    />,
  );

  await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
  const socket = MockWebSocket.instances[0];
  act(() => socket.open());

  expect(sentMessages(socket)).toContainEqual({
    type: "attachSession",
    data: expect.objectContaining({ sessionId }),
  });
  expect(ref.current).not.toBeNull();
  return { ref, socket };
}

beforeEach(() => {
  terminalHarness.reset();
  confirmationHarness.confirmWithToast.mockClear();
  mainAxiosHarness.getSnippets.mockReset().mockResolvedValue([]);
  MockWebSocket.instances = [];
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("固定窗口输入保护", () => {
  it("主机启用连接时固定后在首次连接请求中携带 pinned", async () => {
    render(
      <Terminal
        hostConfig={{
          id: 42,
          instanceId: "tab-42",
          ip: "192.0.2.42",
          port: 22,
          username: "tester",
          terminalConfig: { startPinned: true } as never,
        }}
        isVisible={true}
        initialPath="/srv/task"
        executeCommand="npm run worker"
      />,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());

    expect(sentMessages(socket)).toContainEqual({
      type: "connectToHost",
      data: expect.objectContaining({
        pinned: true,
        initialPath: "/srv/task",
        executeCommand: "npm run worker",
      }),
    });
  });

  it("快速连接不会应用主机的默认固定设置", async () => {
    render(
      <Terminal
        hostConfig={{
          id: 42,
          instanceId: "quick-connect-42",
          ip: "192.0.2.42",
          port: 22,
          username: "tester",
          terminalConfig: { startPinned: true } as never,
        }}
        isVisible={true}
        isQuickConnect={true}
      />,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());

    expect(sentMessages(socket)).toContainEqual({
      type: "connectToHost",
      data: expect.objectContaining({ pinned: false }),
    });
  });

  it("tmux 监视器直接附加时不会创建新的固定窗口", async () => {
    render(
      <Terminal
        hostConfig={{
          id: 42,
          instanceId: "tmux-monitor-42",
          ip: "192.0.2.42",
          port: 22,
          username: "tester",
          terminalConfig: { startPinned: true } as never,
        }}
        isVisible={true}
        tmuxAttachSession="existing-session"
      />,
    );

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());

    expect(sentMessages(socket)).toContainEqual({
      type: "connectToHost",
      data: expect.objectContaining({
        tmuxAttachSession: "existing-session",
        pinned: false,
      }),
    });
  });

  it("连接时固定失败后不会自动重复连接和密钥授权", async () => {
    vi.useFakeTimers();
    try {
      render(
        <Terminal
          hostConfig={{
            id: 42,
            instanceId: "tab-42",
            ip: "192.0.2.42",
            port: 22,
            username: "tester",
            terminalConfig: { startPinned: true } as never,
          }}
          isVisible={true}
        />,
      );

      await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
      const socket = MockWebSocket.instances[0];
      act(() => socket.open());
      act(() =>
        socket.message({ type: "sessionCreated", sessionId: "sess-42" }),
      );
      act(() =>
        socket.message({
          type: "session_pin_mode_required",
          data: { startup: true },
        }),
      );
      fireEvent.click(screen.getByRole("button", { name: "use-tmux" }));
      act(() => socket.message({ type: "connected" }));
      act(() =>
        socket.message({
          type: "session_pin_error",
          code: "SESSION_PIN_FAILED",
          message: "tmux is not installed",
        }),
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });

      expect(MockWebSocket.instances).toHaveLength(1);
      expect(sentMessages(socket)).toContainEqual({ type: "disconnect" });
      expect(socket.readyState).toBe(MockWebSocket.CLOSED);
      terminalHarness.emitData("must-not-run\r");
      expect(sentMessages(socket)).not.toContainEqual({
        type: "input",
        data: "must-not-run\r",
      });
      expect(toastHarness.error).toHaveBeenCalledWith(
        "terminal.sessionPinFailed",
        { description: "terminal.tmuxRequiredForPinning" },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("固定前始终选择模式，切换期间禁用输入且成功后不会关闭终端", async () => {
    const onClose = vi.fn();
    const { ref, socket } = await renderConnectedTerminal({ onClose });

    terminalHarness.emitData("before\r");
    expect(sentMessages(socket)).toContainEqual({
      type: "input",
      data: "before\r",
    });
    socket.sent = [];

    let pinResult: Promise<boolean>;
    act(() => {
      pinResult = ref.current!.pinSession();
    });

    expect(terminalHarness.terminal.options.disableStdin).toBe(true);
    expect(screen.queryByTestId("tmux-install-choice")).not.toBeNull();
    expect(sentMessages(socket)).not.toContainEqual(
      expect.objectContaining({ type: "setSessionPinned" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "use-tmux" }));
    expect(sentMessages(socket)).toContainEqual({
      type: "setSessionPinned",
      data: { pinned: true, mode: "tmux" },
    });

    terminalHarness.emitData("blocked\r");
    expect(sentMessages(socket)).not.toContainEqual({
      type: "input",
      data: "blocked\r",
    });

    act(() => socket.message({ type: "sessionInputBlocked" }));
    expect(toastHarness.info).toHaveBeenCalledWith(
      "terminal.sessionInputBlocked",
      { id: "terminal-session-pin-input-blocked" },
    );

    act(() =>
      socket.message({
        type: "sessionPinned",
        pinned: true,
        sessionId: "sess-42",
        tmuxSessionName: "cloudssh-sess-42",
        sessionManagedTmux: true,
      }),
    );

    await expect(pinResult!).resolves.toBe(true);
    expect(terminalHarness.terminal.options.disableStdin).toBe(false);
    expect(onClose).not.toHaveBeenCalled();

    terminalHarness.emitData("after\r");
    expect(sentMessages(socket)).toContainEqual({
      type: "input",
      data: "after\r",
    });
  });

  it("关闭固定标签只脱离浏览器且不发送终止会话指令", async () => {
    const { ref, socket } = await renderConnectedTerminal();
    act(() =>
      socket.message({
        type: "sessionPinned",
        pinned: true,
        sessionId: "sess-42",
        tmuxSessionName: "cloudssh-sess-42",
        sessionManagedTmux: true,
      }),
    );
    socket.sent = [];

    act(() => ref.current!.detach());

    expect(sentMessages(socket)).not.toContainEqual({ type: "disconnect" });
    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
  });

  it("固定失败后恢复原有输入状态", async () => {
    const { ref, socket } = await renderConnectedTerminal();

    let pinResult: Promise<boolean>;
    act(() => {
      pinResult = ref.current!.pinSession();
    });
    expect(terminalHarness.terminal.options.disableStdin).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "use-tmux" }));

    act(() =>
      socket.message({
        type: "session_pin_error",
        code: "SESSION_PIN_REQUIRES_FRESH_SHELL",
        message: "fresh shell required",
      }),
    );

    await expect(pinResult!).resolves.toBe(false);
    expect(terminalHarness.terminal.options.disableStdin).toBe(false);
    expect(ref.current!.isSessionPinned()).toBe(false);
    expect(toastHarness.success).not.toHaveBeenCalled();

    terminalHarness.emitData("retry\r");
    expect(sentMessages(socket)).toContainEqual({
      type: "input",
      data: "retry\r",
    });
  });

  it("缺少 tmux 时确认安装后继续固定并恢复输入", async () => {
    const { ref, socket } = await renderConnectedTerminal();

    let pinResult: Promise<boolean>;
    act(() => {
      pinResult = ref.current!.pinSession();
    });
    fireEvent.click(screen.getByRole("button", { name: "use-tmux" }));
    expect(sentMessages(socket)).toContainEqual({
      type: "setSessionPinned",
      data: { pinned: true, mode: "tmux" },
    });
    act(() =>
      socket.message({
        type: "session_pin_requires_tmux",
        data: { startup: false },
      }),
    );

    expect(terminalHarness.terminal.options.disableStdin).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "install-tmux" }));
    expect(sentMessages(socket)).toContainEqual({
      type: "setSessionPinned",
      data: { pinned: true, mode: "install_tmux" },
    });
    expect(
      (
        screen.getByRole("button", {
          name: "install-tmux",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    act(() =>
      socket.message({
        type: "sessionPinned",
        pinned: true,
        sessionId: "sess-42",
        tmuxSessionName: "cloudssh-sess-42",
        sessionManagedTmux: true,
      }),
    );

    await expect(pinResult!).resolves.toBe(true);
    expect(ref.current!.isSessionPinned()).toBe(true);
    expect(terminalHarness.terminal.options.disableStdin).toBe(false);
    expect(screen.queryByTestId("tmux-install-choice")).toBeNull();
  });

  it("即使主机安装了 tmux 也可直接选择平台保活", async () => {
    const onSessionPersistenceChange = vi.fn();
    const { ref, socket } = await renderConnectedTerminal({
      onSessionPersistenceChange,
    });

    let pinResult: Promise<boolean>;
    act(() => {
      pinResult = ref.current!.pinSession();
    });

    fireEvent.click(screen.getByRole("button", { name: "platform-keepalive" }));
    expect(sentMessages(socket)).toContainEqual({
      type: "setSessionPinned",
      data: { pinned: true, mode: "platform" },
    });
    expect(sentMessages(socket)).not.toContainEqual({
      type: "setSessionPinned",
      data: { pinned: true, mode: "install_tmux" },
    });

    act(() =>
      socket.message({
        type: "sessionPinned",
        pinned: true,
        sessionId: "sess-42",
        tmuxSessionName: null,
        sessionManagedTmux: false,
      }),
    );

    await expect(pinResult!).resolves.toBe(true);
    expect(ref.current!.isSessionPinned()).toBe(true);
    expect(terminalHarness.terminal.options.disableStdin).toBe(false);
    expect(onSessionPersistenceChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionId: "sess-42",
        sessionPinned: true,
        sessionManagedTmux: false,
        recoverable: false,
      }),
    );
  });

  it("取消固定模式选择不会发送 tmux 或平台保活请求", async () => {
    const { ref, socket } = await renderConnectedTerminal();

    let pinResult: Promise<boolean>;
    act(() => {
      pinResult = ref.current!.pinSession();
    });
    fireEvent.click(screen.getByRole("button", { name: "cancel-pin" }));

    await expect(pinResult!).resolves.toBe(false);
    expect(sentMessages(socket)).toContainEqual({ type: "cancelSessionPin" });
    expect(sentMessages(socket)).not.toContainEqual({
      type: "setSessionPinned",
      data: { pinned: true, mode: "install_tmux" },
    });
    expect(sentMessages(socket)).not.toContainEqual({
      type: "setSessionPinned",
      data: { pinned: true, mode: "platform" },
    });
    expect(ref.current!.isSessionPinned()).toBe(false);
    expect(terminalHarness.terminal.options.disableStdin).toBe(false);
  });

  it("取消连接时固定会关闭本次 SSH 且不会自动重连", async () => {
    vi.useFakeTimers();
    try {
      render(
        <Terminal
          hostConfig={{
            id: 42,
            instanceId: "tab-42",
            ip: "192.0.2.42",
            port: 22,
            username: "tester",
            terminalConfig: { startPinned: true } as never,
          }}
          isVisible={true}
        />,
      );

      await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
      const socket = MockWebSocket.instances[0];
      act(() => socket.open());
      act(() =>
        socket.message({ type: "sessionCreated", sessionId: "sess-42" }),
      );
      act(() =>
        socket.message({
          type: "session_pin_mode_required",
          data: { sessionId: "sess-42", startup: true },
        }),
      );

      fireEvent.click(screen.getByRole("button", { name: "cancel-pin" }));

      expect(sentMessages(socket)).toContainEqual({ type: "cancelSessionPin" });
      expect(sentMessages(socket)).toContainEqual({ type: "disconnect" });
      expect(socket.readyState).toBe(MockWebSocket.CLOSED);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(MockWebSocket.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tmux 安装失败后关闭选择框并恢复输入", async () => {
    const { ref, socket } = await renderConnectedTerminal();

    let pinResult: Promise<boolean>;
    act(() => {
      pinResult = ref.current!.pinSession();
    });
    fireEvent.click(screen.getByRole("button", { name: "use-tmux" }));
    act(() => socket.message({ type: "session_pin_requires_tmux" }));
    fireEvent.click(screen.getByRole("button", { name: "install-tmux" }));

    act(() =>
      socket.message({
        type: "session_pin_error",
        code: "TMUX_INSTALL_FAILED",
        message: "tmux installation failed",
      }),
    );

    await expect(pinResult!).resolves.toBe(false);
    expect(ref.current!.isSessionPinned()).toBe(false);
    expect(terminalHarness.terminal.options.disableStdin).toBe(false);
    expect(screen.queryByTestId("tmux-install-choice")).toBeNull();

    terminalHarness.emitData("after-install-error\r");
    expect(sentMessages(socket)).toContainEqual({
      type: "input",
      data: "after-install-error\r",
    });
  });

  it("已有非受管 tmux 不能固定时显示明确原因且保持未固定", async () => {
    const { ref, socket } = await renderConnectedTerminal();

    let pinResult: Promise<boolean>;
    act(() => {
      pinResult = ref.current!.pinSession();
    });
    fireEvent.click(screen.getByRole("button", { name: "use-tmux" }));

    act(() =>
      socket.message({
        type: "session_pin_error",
        code: "TERMINAL_SESSION_UNMANAGED_TMUX",
        message: "An existing tmux session cannot be converted",
      }),
    );

    await expect(pinResult!).resolves.toBe(false);
    expect(ref.current!.isSessionPinned()).toBe(false);
    expect(toastHarness.error).toHaveBeenCalledWith(
      "terminal.sessionPinFailed",
      { description: "terminal.unmanagedTmuxCannotPin" },
    );
    expect(toastHarness.success).not.toHaveBeenCalled();
  });

  it("固定回滚无法确认时提示恢复记录仍保留", async () => {
    const { ref, socket } = await renderConnectedTerminal();

    let pinResult: Promise<boolean>;
    act(() => {
      pinResult = ref.current!.pinSession();
    });
    fireEvent.click(screen.getByRole("button", { name: "use-tmux" }));
    act(() =>
      socket.message({
        type: "session_pin_error",
        code: "SESSION_PIN_RECOVERY_PENDING",
        message: "rollback could not be confirmed",
      }),
    );

    await expect(pinResult!).resolves.toBe(false);
    expect(toastHarness.error).toHaveBeenCalledWith(
      "terminal.sessionPinFailed",
      { description: "terminal.sessionPinRecoveryPending" },
    );
  });

  it("动态固定回滚不确定时保留固定状态但不报告成功", async () => {
    const { ref, socket } = await renderConnectedTerminal();

    let pinResult: Promise<boolean>;
    act(() => {
      pinResult = ref.current!.pinSession();
    });
    fireEvent.click(screen.getByRole("button", { name: "use-tmux" }));
    act(() =>
      socket.message({
        type: "sessionPinned",
        pinned: true,
        sessionId: "sess-42",
        tmuxSessionName: "cloudssh-sess-42",
        recoveryPending: true,
      }),
    );
    act(() =>
      socket.message({
        type: "session_pin_error",
        code: "SESSION_PIN_RECOVERY_PENDING",
        message: "rollback could not be confirmed",
      }),
    );

    await expect(pinResult!).resolves.toBe(false);
    expect(ref.current!.isSessionPinned()).toBe(true);
    expect(toastHarness.success).not.toHaveBeenCalled();
    expect(toastHarness.error).toHaveBeenCalledWith(
      "terminal.sessionPinFailed",
      { description: "terminal.sessionPinRecoveryPending" },
    );
  });

  it("网页登录过期时提示后台会话仍在运行", async () => {
    const { socket } = await renderConnectedTerminal();

    act(() =>
      socket.message({
        type: "sessionAuthenticationExpired",
        code: "SESSION_EXPIRED",
      }),
    );

    expect(toastHarness.error).toHaveBeenCalledWith(
      "terminal.loginSessionExpired",
      { description: "terminal.backgroundSessionStillRunning" },
    );
  });

  it("恢复探测异常时提示恢复记录已保留", async () => {
    const { socket } = await renderConnectedTerminal();

    act(() =>
      socket.message({
        type: "sessionRecoveryDeferred",
        code: "TMUX_SESSION_PROBE_UNAVAILABLE",
      }),
    );

    expect(toastHarness.error).toHaveBeenCalledWith(
      "terminal.sessionRecoveryDeferred",
      { description: "terminal.sessionRecoveryRecordKept" },
    );
  });

  it.each([
    ["RECOVERY_TARGET_CHANGED", "terminal.recoveryTargetChanged"],
    ["RECOVERY_TARGET_UNVERIFIED", "terminal.recoveryTargetUnverified"],
    [
      "TMUX_SESSION_ATTACH_PROBE_UNAVAILABLE",
      "terminal.sessionRecoveryAttachUnconfirmed",
    ],
    [
      "TMUX_SESSION_ATTACH_NOT_CONFIRMED",
      "terminal.sessionRecoveryAttachUnconfirmed",
    ],
    ["SESSION_PIN_RECOVERY_PENDING", "terminal.sessionPinRecoveryPending"],
  ])("恢复目标校验失败 %s 时显示对应安全说明", async (code, messageKey) => {
    const { socket } = await renderConnectedTerminal();

    act(() =>
      socket.message({
        type: "sessionRecoveryDeferred",
        code,
      }),
    );

    expect(toastHarness.error).toHaveBeenCalledWith(
      "terminal.sessionRecoveryDeferred",
      { description: messageKey },
    );
  });
});

describe("Panel Agent 终端上下文", () => {
  it("暴露最近输出和当前会话上下文", async () => {
    const { ref, socket } = await renderConnectedTerminal();

    act(() => socket.message({ type: "connected" }));
    act(() =>
      socket.message({
        type: "data",
        data: "\u001b[31mnginx failed\u001b[0m\nnext prompt",
      }),
    );

    expect(ref.current?.getRecentOutput()).toBe("nginx failed\nnext prompt");
    expect(ref.current?.getSessionContext()).toMatchObject({
      sessionId: "sess-42",
      hostId: 42,
      connected: true,
    });
  });
});

describe("Agent 会话单写租约", () => {
  async function renderAgentTerminal() {
    const ref = createRef<TerminalHandle>();
    render(
      <Terminal
        ref={ref}
        hostConfig={{
          id: 42,
          instanceId: "agent-tab-42",
          agentSessionId: "agent-session-42",
          ip: "192.0.2.42",
          port: 22,
          username: "tester",
        }}
        isVisible={true}
      />,
    );
    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0];
    act(() => socket.open());
    expect(sentMessages(socket)).toContainEqual({
      type: "attachAgentSession",
      data: expect.objectContaining({ agentSessionId: "agent-session-42" }),
    });
    act(() => socket.message({ type: "connected" }));
    return { ref, socket };
  }

  it("默认只读，明确接管后才发送输入，并可主动释放", async () => {
    const { socket } = await renderAgentTerminal();
    act(() =>
      socket.message({
        type: "agent_session_access",
        data: { mode: "read-only", canTakeover: true },
      }),
    );

    expect(terminalHarness.terminal.options.disableStdin).toBe(true);
    terminalHarness.emitData("blocked\r");
    expect(sentMessages(socket)).not.toContainEqual({
      type: "input",
      data: "blocked\r",
    });

    fireEvent.click(
      screen.getByRole("button", { name: "terminal.agentTakeover" }),
    );
    expect(confirmationHarness.confirmWithToast).toHaveBeenCalledOnce();
    expect(sentMessages(socket)).toContainEqual({
      type: "requestAgentWriteAccess",
    });

    act(() =>
      socket.message({
        type: "agent_session_access",
        data: { mode: "read-write", canTakeover: true },
      }),
    );
    expect(terminalHarness.terminal.options.disableStdin).toBe(false);
    terminalHarness.emitData("hostname\r");
    expect(sentMessages(socket)).toContainEqual({
      type: "input",
      data: "hostname\r",
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "terminal.agentReleaseWriteAccess",
      }),
    );
    expect(sentMessages(socket)).toContainEqual({
      type: "releaseAgentWriteAccess",
    });
    expect(terminalHarness.terminal.options.disableStdin).toBe(true);
  });

  it("其他设备接管后立即降为只读并阻止后续输入", async () => {
    const { socket } = await renderAgentTerminal();
    act(() =>
      socket.message({
        type: "agent_session_access",
        data: { mode: "read-write" },
      }),
    );
    expect(terminalHarness.terminal.options.disableStdin).toBe(false);

    act(() =>
      socket.message({
        type: "agent_session_access",
        data: { mode: "read-only" },
      }),
    );
    expect(terminalHarness.terminal.options.disableStdin).toBe(true);
    expect(toastHarness.info).toHaveBeenCalledWith(
      "terminal.agentWriteAccessRevoked",
      { id: "terminal-agent-write-access-revoked" },
    );
    terminalHarness.emitData("must-not-send\r");
    expect(sentMessages(socket)).not.toContainEqual({
      type: "input",
      data: "must-not-send\r",
    });
  });
});

describe("终端会话重连", () => {
  it("浏览器异常断线后重新附加现有会话而不创建新 SSH", async () => {
    const { socket } = await renderConnectedTerminal();
    act(() => socket.message({ type: "connected" }));
    vi.useFakeTimers();
    try {
      act(() => socket.fail());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });

      expect(MockWebSocket.instances).toHaveLength(2);
      const reconnectSocket = MockWebSocket.instances[1];
      act(() => reconnectSocket.open());

      expect(sentMessages(reconnectSocket)).toContainEqual({
        type: "attachSession",
        data: expect.objectContaining({ sessionId: "sess-42" }),
      });
      expect(sentMessages(reconnectSocket)).not.toContainEqual(
        expect.objectContaining({ type: "connectToHost" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("手动重连优先重新附加当前会话", async () => {
    const { ref, socket } = await renderConnectedTerminal();
    act(() => socket.message({ type: "connected" }));
    act(() => socket.close());
    act(() => ref.current!.reconnect());

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const reconnectSocket = MockWebSocket.instances[1];
    act(() => reconnectSocket.open());

    expect(sentMessages(reconnectSocket)).toContainEqual({
      type: "attachSession",
      data: expect.objectContaining({ sessionId: "sess-42" }),
    });
    expect(sentMessages(reconnectSocket)).not.toContainEqual(
      expect.objectContaining({ type: "connectToHost" }),
    );
  });

  it("会话被其他窗口接管后手动重连仍附加原会话", async () => {
    const { ref, socket } = await renderConnectedTerminal();
    act(() => socket.message({ type: "connected" }));
    act(() => socket.message({ type: "sessionTakenOver" }));
    act(() => socket.fail(4009));
    act(() => ref.current!.reconnect());

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const reconnectSocket = MockWebSocket.instances[1];
    act(() => reconnectSocket.open());

    expect(sentMessages(reconnectSocket)).toContainEqual({
      type: "attachSession",
      data: expect.objectContaining({ sessionId: "sess-42" }),
    });
    expect(sentMessages(reconnectSocket)).not.toContainEqual(
      expect.objectContaining({ type: "connectToHost" }),
    );
  });

  it("恢复失败提示不会提前丢弃会话 ID", async () => {
    const { ref, socket } = await renderRestoredTerminal();
    act(() =>
      socket.message({
        type: "sessionRecoveryFailed",
        code: "TMUX_SESSION_NOT_FOUND",
      }),
    );

    expect(MockWebSocket.instances).toHaveLength(1);
    act(() => socket.close());
    act(() => ref.current!.reconnect());

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const reconnectSocket = MockWebSocket.instances[1];
    act(() => reconnectSocket.open());
    expect(sentMessages(reconnectSocket)).toContainEqual({
      type: "attachSession",
      data: expect.objectContaining({ sessionId: "sess-restored" }),
    });
    expect(sentMessages(reconnectSocket)).not.toContainEqual(
      expect.objectContaining({ type: "connectToHost" }),
    );
  });

  it("只有收到明确 sessionExpired 后才创建新 SSH", async () => {
    const { socket } = await renderRestoredTerminal();
    act(() => socket.message({ type: "sessionExpired" }));

    await waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    const reconnectSocket = MockWebSocket.instances[1];
    act(() => reconnectSocket.open());

    expect(sentMessages(reconnectSocket)).toContainEqual(
      expect.objectContaining({ type: "connectToHost" }),
    );
    expect(sentMessages(reconnectSocket)).not.toContainEqual(
      expect.objectContaining({ type: "attachSession" }),
    );
  });
});

describe("连接时固定的自动启动保护", () => {
  it.each([
    ["平台保活", "platform", "platform-keepalive", false, null],
    ["远端 tmux", "tmux", "use-tmux", true, "cloudssh-sess-42"],
  ] as const)(
    "选择%s后由服务端接管自动启动输入",
    async (_label, mode, buttonName, sessionManagedTmux, tmuxSessionName) => {
      vi.useFakeTimers();
      try {
        mainAxiosHarness.getSnippets.mockResolvedValue([
          { id: 7, content: "echo startup" },
        ]);

        render(
          <Terminal
            hostConfig={{
              id: 42,
              instanceId: "tab-42",
              ip: "192.0.2.42",
              port: 22,
              username: "tester",
              terminalConfig: {
                startPinned: true,
                environmentVariables: [
                  { key: "CLOUDSSH_PIN_TEST", value: "enabled" },
                ],
                startupSnippetId: 7,
                autoMosh: true,
                moshCommand: "mosh --predict=always",
              } as never,
            }}
            isVisible={true}
          />,
        );

        await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
        const socket = MockWebSocket.instances[0];
        const inputData = () =>
          sentMessages(socket)
            .filter((message) => message.type === "input")
            .map((message) => message.data);

        act(() => socket.open());
        act(() =>
          socket.message({ type: "sessionCreated", sessionId: "sess-42" }),
        );
        act(() =>
          socket.message({
            type: "session_pin_mode_required",
            data: { startup: true },
          }),
        );
        act(() => socket.message({ type: "connected" }));

        await act(async () => {
          await vi.advanceTimersByTimeAsync(500);
        });

        expect(screen.queryByTestId("tmux-install-choice")).not.toBeNull();
        expect(terminalHarness.terminal.options.disableStdin).toBe(true);
        expect(inputData()).toEqual([]);
        expect(mainAxiosHarness.getSnippets).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: buttonName }));
        expect(sentMessages(socket)).toContainEqual({
          type: "setSessionPinned",
          data: { pinned: true, mode },
        });

        act(() =>
          socket.message({
            type: "sessionPinned",
            pinned: true,
            sessionId: "sess-42",
            tmuxSessionName,
            sessionManagedTmux,
          }),
        );

        await act(async () => {
          await vi.advanceTimersByTimeAsync(100);
        });

        expect(inputData()).toEqual([]);
        expect(mainAxiosHarness.getSnippets).not.toHaveBeenCalled();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(500);
        });
        expect(inputData()).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("固定选择期间断开会关闭弹窗并恢复输入", async () => {
    const { ref, socket } = await renderConnectedTerminal();

    let pinResult: Promise<boolean>;
    act(() => {
      pinResult = ref.current!.pinSession();
    });

    expect(screen.queryByTestId("tmux-install-choice")).not.toBeNull();
    expect(terminalHarness.terminal.options.disableStdin).toBe(true);

    act(() =>
      socket.message({
        type: "disconnected",
        graceful: false,
        message: "connection lost",
      }),
    );

    await expect(pinResult!).resolves.toBe(false);
    expect(screen.queryByTestId("tmux-install-choice")).toBeNull();
    expect(terminalHarness.terminal.options.disableStdin).toBe(false);

    terminalHarness.emitData("after-disconnect\r");
    expect(sentMessages(socket)).toContainEqual({
      type: "input",
      data: "after-disconnect\r",
    });
  });
});
