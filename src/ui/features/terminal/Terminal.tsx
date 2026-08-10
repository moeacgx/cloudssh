/* eslint-disable react-hooks/exhaustive-deps */
import {
  useEffect,
  useRef,
  useState,
  useImperativeHandle,
  forwardRef,
  useCallback,
} from "react";
import { createPortal } from "react-dom";
import { useXTerm } from "react-xtermjs";
import { FitAddon } from "@xterm/addon-fit";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { RobustClipboardProvider } from "@/lib/clipboard-provider";
import { copyToClipboard } from "@/lib/clipboard";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { IDisposable } from "@xterm/xterm";
import { replaceTerminalInputListener } from "./terminal-input-listener";
import { useTranslation } from "react-i18next";
import { getBasePath } from "@/lib/base-path";
import {
  resolveConnectionOrigin,
  buildOriginWsUrl,
} from "@/lib/connection-origin.ts";
import {
  getCookie,
  isElectron,
  logActivity,
  getSnippets,
  deleteCommandFromHistory,
  getCommandHistory,
  getHostPassword,
} from "@/main-axios.ts";
import { TOTPDialog } from "@/ssh/dialogs/TOTPDialog.tsx";
import { SSHAuthDialog } from "@/ssh/dialogs/SSHAuthDialog.tsx";
import { PassphraseDialog } from "@/ssh/dialogs/PassphraseDialog.tsx";
import { WarpgateDialog } from "@/ssh/dialogs/WarpgateDialog.tsx";
import { OPKSSHDialog } from "@/ssh/dialogs/OPKSSHDialog.tsx";
import { HostKeyVerificationDialog } from "@/ssh/dialogs/HostKeyVerificationDialog.tsx";
import { TmuxSessionPicker } from "@/ssh/dialogs/TmuxSessionPicker.tsx";
import { TmuxInstallChoiceDialog } from "@/ssh/dialogs/TmuxInstallChoiceDialog.tsx";
import {
  DEFAULT_TERMINAL_CONFIG,
  TERMINAL_FONTS,
} from "@/lib/terminal-themes.ts";
import { ensureTerminalFontsLoaded } from "./terminal-global-styles.ts";
import { useTheme } from "@/components/theme-provider.tsx";
import { globalShortcutHandler } from "@/lib/global-shortcut-handler";
import { useCommandTracker } from "@/features/terminal/command-history/useCommandTracker.ts";
import { highlightTerminalOutput } from "@/lib/terminal-syntax-highlighter.ts";
import { useCommandHistory } from "@/features/terminal/command-history/CommandHistoryContext.tsx";
import { CommandAutocomplete } from "./command-history/CommandAutocomplete.tsx";
import { SimpleLoader } from "@/lib/SimpleLoader.tsx";
import { useConfirmation } from "@/hooks/use-confirmation.ts";
import {
  ConnectionLogProvider,
  useConnectionLog,
} from "@/ssh/connection-log/ConnectionLogContext.tsx";
import { ConnectionLog } from "@/ssh/connection-log/ConnectionLog.tsx";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { Bot, LockKeyhole, Save } from "lucide-react";
import {
  readTerminalDefaultTheme,
  resolveEffectiveTerminalTheme,
  resolveTermixThemeColors,
  TERMINAL_DEFAULT_THEME_CHANGED_EVENT,
  TERMINAL_DEFAULT_THEME_STORAGE_KEY,
} from "./terminal-theme.ts";
import { ShareSessionModal } from "@/features/session-sharing/ShareSessionModal.tsx";
import type {
  TerminalHandle,
  TerminalHostConfig,
  TerminalSessionPersistenceState,
} from "./terminal-types.ts";
import {
  getNextTerminalFontSize,
  getTerminalFontZoomDirection,
} from "./terminal-font-zoom.ts";
import { buildTerminalConnectionHostConfig } from "./terminal-connection-host-config.ts";
import {
  getUserPreferences,
  parseCustomKeybindings,
} from "@/api/open-tabs-api";
import { findMatchingKeybinding } from "@/lib/keybinding-match";
import { dispatchKeybindingAction } from "@/lib/keybinding-dispatch";
import type { CustomKeybinding } from "@/types/keybindings";
export type { TerminalHandle, TerminalHostConfig } from "./terminal-types.ts";

type HostKeyVerificationData = Omit<
  React.ComponentProps<typeof HostKeyVerificationDialog>,
  "isOpen" | "scenario" | "onAccept" | "onReject" | "backgroundColor"
>;

type AgentSessionAccessMode = "read-only" | "read-write" | "requesting";

interface SSHTerminalProps {
  hostConfig: TerminalHostConfig;
  isVisible: boolean;
  title?: string;
  showTitle?: boolean;
  splitScreen?: boolean;
  onClose?: () => void;
  onTitleChange?: (title: string) => void;
  initialPath?: string;
  executeCommand?: string;
  /** Attach to this tmux session right after connecting (tmux monitor). */
  tmuxAttachSession?: string;
  onOpenFileManager?: (path?: string) => void;
  onOpenFileInEditor?: (filePath: string) => void;
  previewTheme?: string | null;
  /** When true, suppress automatic focus on connect/visibility change. */
  disableAutoFocus?: boolean;
  isQuickConnect?: boolean;
  onSaveQuickConnect?: () => Promise<void>;
  sessionPinned?: boolean;
  sessionManagedTmux?: boolean;
  onSessionPersistenceChange?: (state: TerminalSessionPersistenceState) => void;
}

const ALTERNATE_SCREEN_SEQUENCE = /\x1b\[\?(47|1047|1049)([hl])/g;
const RECENT_OUTPUT_MAX_CHARS = 128 * 1024;
const ANSI_SEQUENCE = /\x1b(?:[@-Z\\-_]|\[[0-9;?>=!]*[@-~])/g;

function cleanTerminalContext(value: string) {
  return value
    .replace(ANSI_SEQUENCE, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

function appendRecentOutput(current: string, value: string) {
  const next = current + cleanTerminalContext(value);
  return next.length > RECENT_OUTPUT_MAX_CHARS
    ? next.slice(next.length - RECENT_OUTPUT_MAX_CHARS)
    : next;
}

function recentOutputLines(value: string, maxLines = 120) {
  const bounded = Math.max(1, Math.min(500, Math.floor(maxLines)));
  return value
    .replace(/\r/g, "")
    .split("\n")
    .slice(-bounded)
    .join("\n")
    .trimEnd();
}

const SESSION_PIN_ERROR_MESSAGE_KEYS: Record<string, string> = {
  SESSION_PIN_MODE_REQUIRED: "terminal.sessionPinModeRequired",
  SESSION_PIN_REQUIRES_FRESH_SHELL: "terminal.pinFreshShellRequired",
  MANAGED_TMUX_DETACH_FORBIDDEN: "terminal.managedTmuxDetachForbidden",
  TERMINAL_SESSION_UNMANAGED_TMUX: "terminal.unmanagedTmuxCannotPin",
  SESSION_PIN_RECOVERY_PENDING: "terminal.sessionPinRecoveryPending",
  TMUX_INSTALL_UNSUPPORTED: "terminal.tmuxInstallUnsupported",
  TMUX_INSTALL_PERMISSION_DENIED: "terminal.tmuxInstallPermissionDenied",
  TMUX_INSTALL_FAILED: "terminal.tmuxInstallFailed",
  TMUX_INSTALL_VERIFICATION_FAILED: "terminal.tmuxInstallVerificationFailed",
  TERMINAL_LIFECYCLE_UNAVAILABLE: "terminal.hostLifecycleUnavailable",
};

const TMUX_INSTALL_TIMEOUT_MS = 300_000;

type SessionPinPendingMode = "tmux" | "install_tmux" | "platform" | null;

interface SessionPinChoiceState {
  socket: WebSocket;
  attemptId: number;
  startup: boolean;
  stage: "mode" | "install";
  pendingMode: SessionPinPendingMode;
  previousDisableStdin: boolean;
}

const RECOVERY_DEFERRED_MESSAGE_KEYS: Record<string, string> = {
  RECOVERY_TARGET_CHANGED: "terminal.recoveryTargetChanged",
  RECOVERY_TARGET_UNVERIFIED: "terminal.recoveryTargetUnverified",
  TMUX_SESSION_PROBE_UNAVAILABLE: "terminal.sessionRecoveryRecordKept",
  TMUX_SESSION_ATTACH_PROBE_UNAVAILABLE:
    "terminal.sessionRecoveryAttachUnconfirmed",
  TMUX_SESSION_ATTACH_NOT_CONFIRMED:
    "terminal.sessionRecoveryAttachUnconfirmed",
  SESSION_PIN_RECOVERY_PENDING: "terminal.sessionPinRecoveryPending",
  RECOVERY_WAIT_TIMEOUT: "terminal.sessionRecoveryWaitTimeout",
};

function updateAlternateScreenMode(output: string, currentMode: boolean) {
  ALTERNATE_SCREEN_SEQUENCE.lastIndex = 0;
  let isActive = currentMode;
  let sawSequence = false;
  let match: RegExpExecArray | null;

  while ((match = ALTERNATE_SCREEN_SEQUENCE.exec(output)) !== null) {
    sawSequence = true;
    isActive = match[2] === "h";
  }

  return { isActive, sawSequence };
}

const TerminalInner = forwardRef<TerminalHandle, SSHTerminalProps>(
  function SSHTerminal(
    {
      hostConfig,
      isVisible,
      splitScreen = false,
      onClose,
      onTitleChange,
      initialPath,
      executeCommand,
      tmuxAttachSession,
      onOpenFileManager,
      onOpenFileInEditor,
      previewTheme,
      disableAutoFocus = false,
      isQuickConnect = false,
      onSaveQuickConnect,
      sessionPinned = false,
      sessionManagedTmux = sessionPinned,
      onSessionPersistenceChange,
    },
    ref,
  ) {
    const { t } = useTranslation();
    const { instance: terminal, ref: xtermRef } = useXTerm();
    const commandHistoryContext = useCommandHistory();
    const { confirmWithToast } = useConfirmation();
    const { theme: appTheme } = useTheme();
    const [terminalDefaultTheme, setTerminalDefaultTheme] = useState(
      readTerminalDefaultTheme,
    );
    const { addLog, isExpanded: isConnectionLogExpanded } = useConnectionLog();

    useEffect(() => {
      const updateTerminalDefaultTheme = () => {
        setTerminalDefaultTheme(readTerminalDefaultTheme());
      };
      const handleStorage = (event: StorageEvent) => {
        if (event.key === TERMINAL_DEFAULT_THEME_STORAGE_KEY) {
          updateTerminalDefaultTheme();
        }
      };
      window.addEventListener(
        TERMINAL_DEFAULT_THEME_CHANGED_EVENT,
        updateTerminalDefaultTheme,
      );
      window.addEventListener("storage", handleStorage);
      return () => {
        window.removeEventListener(
          TERMINAL_DEFAULT_THEME_CHANGED_EVENT,
          updateTerminalDefaultTheme,
        );
        window.removeEventListener("storage", handleStorage);
      };
    }, []);

    const savedTheme = localStorage.getItem(
      `terminal_theme_host_${hostConfig.id}`,
    );
    const recentOutputRef = useRef("");
    const config = {
      ...DEFAULT_TERMINAL_CONFIG,
      ...hostConfig.terminalConfig,
      theme: resolveEffectiveTerminalTheme(
        savedTheme ?? hostConfig.terminalConfig?.theme,
        terminalDefaultTheme,
      ),
    };

    const activeTheme = previewTheme || config.theme;
    const themeColors = resolveTermixThemeColors(
      activeTheme,
      appTheme,
      config.customThemeColors,
    );
    const backgroundImage = config.backgroundImage || "";
    const backgroundImageOpacity = config.backgroundImageOpacity ?? 0.15;
    const backgroundColor = backgroundImage
      ? "transparent"
      : themeColors.background;
    const fitAddonRef = useRef<FitAddon | null>(null);
    const webSocketRef = useRef<WebSocket | null>(null);
    const customKeybindingsRef = useRef<CustomKeybinding[]>([]);
    const cachedSnippetsRef = useRef<{ id: number; content: string }[] | null>(
      null,
    );
    const resizeTimeout = useRef<NodeJS.Timeout | null>(null);
    const wasDisconnectedBySSH = useRef(false);
    const pingIntervalRef = useRef<NodeJS.Timeout | null>(null);
    const pongReceivedRef = useRef(true);
    const pongTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const [isConnected, setIsConnected] = useState(false);
    const [shareModalOpen, setShareModalOpen] = useState(false);
    const [isSavingQuickConnect, setIsSavingQuickConnect] = useState(false);
    const [isQuickConnectSaved, setIsQuickConnectSaved] = useState(false);
    const [isConnecting, setIsConnecting] = useState(false);
    const [isFitted, setIsFitted] = useState(false);
    const [connectionError, setConnectionError] = useState<string | null>(null);
    const connectionErrorRef = useRef<string | null>(null);
    const [showDisconnectedOverlay, setShowDisconnectedOverlay] =
      useState(false);

    const updateConnectionError = useCallback((error: string | null) => {
      connectionErrorRef.current = error;
      setConnectionError(error);
    }, []);

    const [, setIsAuthenticated] = useState(false);
    const [totpRequired, setTotpRequired] = useState(false);
    const [totpPrompt, setTotpPrompt] = useState<string>("");
    const [isPasswordPrompt, setIsPasswordPrompt] = useState(false);
    const [mfaPromptMode, setMfaPromptMode] = useState<
      "totp" | "password" | "menu" | "push"
    >("totp");
    const [mfaWaiting, setMfaWaiting] = useState(false);
    const [showAuthDialog, setShowAuthDialog] = useState(false);
    const [authDialogReason, setAuthDialogReason] = useState<
      "no_keyboard" | "auth_failed" | "timeout"
    >("no_keyboard");
    const [showPassphraseDialog, setShowPassphraseDialog] = useState(false);
    const [, setKeyboardInteractiveDetected] = useState(false);
    const [warpgateAuthRequired, setWarpgateAuthRequired] = useState(false);
    const [warpgateAuthUrl, setWarpgateAuthUrl] = useState<string>("");
    const [warpgateSecurityKey, setWarpgateSecurityKey] = useState<string>("");
    const warpgateTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    const [opksshDialog, setOpksshDialog] = useState<{
      isOpen: boolean;
      authUrl: string;
      requestId: string;
      stage: "chooser" | "waiting" | "authenticating" | "completed" | "error";
      error?: string;
      providers?: Array<{ alias: string; issuer: string }>;
    } | null>(null);
    const opksshTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    const opksshFailedRef = useRef(false);
    const currentHostIdRef = useRef<number | null>(null);
    const currentHostConfigRef = useRef<TerminalHostConfig | null>(null);

    // Vault SSH signer interactive OIDC flow
    const [vaultDialog, setVaultDialog] = useState<{
      stage: "waiting" | "error";
      error?: string;
    } | null>(null);
    const vaultFailedRef = useRef(false);
    const vaultPopupRef = useRef<Window | null>(null);
    const vaultTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    const [hostKeyVerification, setHostKeyVerification] = useState<{
      isOpen: boolean;
      scenario: "new" | "changed";
      data: HostKeyVerificationData;
    } | null>(null);

    const sessionIdRef = useRef<string | null>(
      hostConfig.restoredSessionId ?? null,
    );
    const sessionPinnedRef = useRef(sessionPinned);
    const [, setIsSessionPinned] = useState(sessionPinned);
    const [isManagedTmux, setIsManagedTmux] = useState(sessionManagedTmux);
    const inputBlockedRef = useRef(false);
    const agentInputBlockedRef = useRef(Boolean(hostConfig.agentSessionId));
    const [agentAccessMode, setAgentAccessMode] =
      useState<AgentSessionAccessMode | null>(
        hostConfig.agentSessionId ? "read-only" : null,
      );
    const agentAccessModeRef = useRef<AgentSessionAccessMode | null>(
      hostConfig.agentSessionId ? "read-only" : null,
    );
    const previousDisableStdinRef = useRef<boolean | null>(null);
    const pendingPinRequestRef = useRef<{
      desired: boolean;
      startup: boolean;
      resolve: (success: boolean) => void;
      timeout: ReturnType<typeof setTimeout> | null;
      previousDisableStdin: boolean;
      socket: WebSocket;
      attemptId: number;
    } | null>(null);
    const isAttachingSessionRef = useRef<boolean>(false);
    const [tmuxPinChoice, setTmuxPinChoice] =
      useState<SessionPinChoiceState | null>(null);
    const startupAutomationRef = useRef<{
      socket: WebSocket | null;
      timeout: ReturnType<typeof setTimeout> | null;
      connected: boolean;
      phase: "idle" | "scheduled" | "running" | "completed" | "cancelled";
    }>({
      socket: null,
      timeout: null,
      connected: false,
      phase: "idle",
    });
    const [linkClickDialog, setLinkClickDialog] = useState<{
      url: string;
    } | null>(null);

    useEffect(() => {
      if (!linkClickDialog) return;

      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        setLinkClickDialog(null);
      };

      window.addEventListener("keydown", handleKeyDown, true);
      return () => window.removeEventListener("keydown", handleKeyDown, true);
    }, [linkClickDialog]);

    const [tmuxSessionPicker, setTmuxSessionPicker] = useState<{
      sessions: Array<{
        name: string;
        created: number;
        lastActivity: number;
        windows: number;
        attachedClients: number;
      }>;
    } | null>(null);
    const tmuxSessionNameRef = useRef<string | null>(null);
    const [isTmuxAttached, setIsTmuxAttached] = useState(false);
    const tmuxCopyModeHintShownRef = useRef(false);

    const isVisibleRef = useRef<boolean>(false);
    const isFittingRef = useRef(false);
    const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const terminalInputDisposableRef = useRef<IDisposable | null>(null);
    const reconnectAttempts = useRef(0);
    const maxReconnectAttempts = 8;
    const isUnmountingRef = useRef(false);
    const shouldNotReconnectRef = useRef(false);
    const isReconnectingRef = useRef(false);
    const isConnectingRef = useRef(false);
    const wasConnectedRef = useRef(false);
    const wasSessionExpiredRef = useRef(false);

    useEffect(() => {
      sessionPinnedRef.current = sessionPinned;
      setIsSessionPinned(sessionPinned);
      setIsManagedTmux(sessionPinned && sessionManagedTmux);
    }, [sessionManagedTmux, sessionPinned]);

    const publishPersistenceState = useCallback(
      (state: Partial<TerminalSessionPersistenceState> = {}) => {
        onSessionPersistenceChange?.({
          sessionId:
            "sessionId" in state
              ? (state.sessionId ?? null)
              : sessionIdRef.current,
          agentSessionId:
            "agentSessionId" in state
              ? (state.agentSessionId ?? null)
              : (hostConfig.agentSessionId ?? null),
          sessionPinned:
            state.sessionPinned ?? sessionPinnedRef.current ?? false,
          sessionManagedTmux: state.sessionManagedTmux,
          tmuxSessionName:
            "tmuxSessionName" in state
              ? (state.tmuxSessionName ?? null)
              : (tmuxSessionNameRef.current ?? null),
          lastDetachedAt: state.lastDetachedAt,
          retentionExpiresAt: state.retentionExpiresAt,
          recoverable: state.recoverable,
        });
      },
      [onSessionPersistenceChange],
    );

    const syncTerminalInputState = useCallback(() => {
      if (terminal) {
        terminal.options.disableStdin =
          inputBlockedRef.current || agentInputBlockedRef.current;
      }
    }, [terminal]);

    const isTerminalInputBlocked = useCallback(
      () => inputBlockedRef.current || agentInputBlockedRef.current,
      [],
    );

    const applyAgentAccessMode = useCallback(
      (mode: "read-only" | "read-write") => {
        agentInputBlockedRef.current = mode !== "read-write";
        agentAccessModeRef.current = mode;
        setAgentAccessMode(mode);
        syncTerminalInputState();
        if (mode === "read-write") {
          requestAnimationFrame(() => terminal?.focus());
        }
      },
      [syncTerminalInputState, terminal],
    );

    const blockTerminalInput = useCallback(() => {
      if (previousDisableStdinRef.current === null) {
        previousDisableStdinRef.current = inputBlockedRef.current;
      }
      inputBlockedRef.current = true;
      syncTerminalInputState();
      return previousDisableStdinRef.current;
    }, [syncTerminalInputState]);

    const restoreTerminalInput = useCallback(() => {
      const previousDisableStdin = previousDisableStdinRef.current ?? false;
      previousDisableStdinRef.current = null;
      inputBlockedRef.current = previousDisableStdin;
      syncTerminalInputState();
    }, [syncTerminalInputState]);

    useEffect(() => {
      syncTerminalInputState();
    }, [syncTerminalInputState]);

    const sendTerminalInput = useCallback(
      (data: string, socket: WebSocket | null = webSocketRef.current) => {
        if (
          !isMountedRef.current ||
          isTerminalInputBlocked() ||
          !socket ||
          socket !== webSocketRef.current ||
          socket.readyState !== WebSocket.OPEN
        ) {
          return false;
        }
        socket.send(JSON.stringify({ type: "input", data }));
        return true;
      },
      [isTerminalInputBlocked],
    );

    const cancelStartupAutomation = useCallback((socket?: WebSocket | null) => {
      const state = startupAutomationRef.current;
      if (socket && state.socket !== socket) return;
      if (state.timeout) clearTimeout(state.timeout);
      state.timeout = null;
      state.phase = "cancelled";
    }, []);

    const resetStartupAutomation = useCallback(
      (socket: WebSocket, enabled: boolean) => {
        const previous = startupAutomationRef.current;
        if (previous.timeout) clearTimeout(previous.timeout);
        startupAutomationRef.current = {
          socket,
          timeout: null,
          connected: false,
          phase: enabled ? "idle" : "cancelled",
        };
      },
      [],
    );

    const runStartupAutomation = useCallback(
      async (socket: WebSocket) => {
        const isActive = () => {
          const state = startupAutomationRef.current;
          return (
            state.socket === socket &&
            state.phase === "running" &&
            socket.readyState === WebSocket.OPEN
          );
        };

        try {
          const terminalConfig = {
            ...DEFAULT_TERMINAL_CONFIG,
            ...hostConfig.terminalConfig,
          };

          for (const envVar of terminalConfig.environmentVariables ?? []) {
            if (!isActive()) return;
            if (envVar.key && envVar.value) {
              socket.send(
                JSON.stringify({
                  type: "input",
                  data: `export ${envVar.key}="${envVar.value}"\n`,
                }),
              );
            }
          }

          if (terminalConfig.startupSnippetId) {
            try {
              const snippets = await getSnippets();
              const snippet = snippets.find(
                (item: { id: number }) =>
                  item.id === terminalConfig.startupSnippetId,
              );
              if (snippet && isActive()) {
                socket.send(
                  JSON.stringify({
                    type: "input",
                    data: snippet.content + "\n",
                  }),
                );
              }
            } catch (error) {
              console.warn("Failed to execute startup snippet:", error);
            }
          }

          if (terminalConfig.autoMosh && isActive()) {
            socket.send(
              JSON.stringify({
                type: "input",
                data: terminalConfig.moshCommand + "\n",
              }),
            );
          }
        } catch (error) {
          console.warn("Failed to execute terminal startup automation:", error);
        } finally {
          const state = startupAutomationRef.current;
          if (state.socket === socket && state.phase === "running") {
            state.phase = "completed";
          }
        }
      },
      [hostConfig.terminalConfig],
    );

    const queueStartupAutomation = useCallback(
      (socket: WebSocket) => {
        const state = startupAutomationRef.current;
        if (state.socket !== socket) return;
        state.connected = true;
        if (state.phase !== "idle") return;

        state.phase = "scheduled";
        state.timeout = setTimeout(() => {
          const current = startupAutomationRef.current;
          if (
            current.socket !== socket ||
            current.phase !== "scheduled" ||
            socket.readyState !== WebSocket.OPEN
          ) {
            return;
          }
          current.timeout = null;
          current.phase = "running";
          void runStartupAutomation(socket);
        }, 100);
      },
      [runStartupAutomation],
    );

    const settlePinRequest = useCallback(
      (success: boolean, expectedSocket?: WebSocket | null) => {
        const pending = pendingPinRequestRef.current;
        if (expectedSocket && pending && pending.socket !== expectedSocket) {
          return;
        }
        if (isMountedRef.current) setTmuxPinChoice(null);
        if (pending?.timeout) clearTimeout(pending.timeout);
        pendingPinRequestRef.current = null;
        restoreTerminalInput();
        pending?.resolve(success);
      },
      [restoreTerminalInput],
    );

    const cancelTmuxPinChoice = useCallback(() => {
      const choice = tmuxPinChoice;
      if (!choice || choice.pendingMode !== null) return;
      if (choice.startup) {
        cancelStartupAutomation(choice.socket);
        shouldNotReconnectRef.current = true;
        wasDisconnectedBySSH.current = true;
        isConnectingRef.current = false;
        setIsConnected(false);
        setIsConnecting(false);
        updateConnectionError(t("terminal.sessionPinCancelled"));
      }
      if (choice.socket.readyState === WebSocket.OPEN) {
        choice.socket.send(JSON.stringify({ type: "cancelSessionPin" }));
        if (choice.startup) {
          choice.socket.send(JSON.stringify({ type: "disconnect" }));
        }
      }
      if (choice.startup) choice.socket.close();
      settlePinRequest(false, choice.socket);
      if (isMountedRef.current) {
        setTimeout(() => {
          if (isMountedRef.current) terminal?.focus();
        }, 50);
      }
    }, [
      cancelStartupAutomation,
      settlePinRequest,
      t,
      terminal,
      tmuxPinChoice,
      updateConnectionError,
    ]);

    const selectTmuxPinMode = useCallback(
      (mode: "tmux" | "install_tmux" | "platform") => {
        const choice = tmuxPinChoice;
        if (!choice) return;
        const socket = choice.socket;
        if (
          choice.pendingMode !== null ||
          webSocketRef.current !== socket ||
          connectionAttemptIdRef.current !== choice.attemptId ||
          socket.readyState !== WebSocket.OPEN
        ) {
          toast.error(t("terminal.sessionPinFailed"));
          if (choice.startup) {
            cancelStartupAutomation(socket);
          }
          settlePinRequest(false, socket);
          return;
        }

        const timeoutMs =
          mode === "install_tmux" ? TMUX_INSTALL_TIMEOUT_MS : 30_000;
        const timeout = setTimeout(() => {
          if (
            !isMountedRef.current ||
            webSocketRef.current !== socket ||
            connectionAttemptIdRef.current !== choice.attemptId
          ) {
            return;
          }
          toast.error(t("terminal.sessionPinFailed"), {
            description: t(
              mode === "install_tmux"
                ? "terminal.tmuxInstallTimedOut"
                : "terminal.sessionPinTimedOut",
            ),
          });
          if (choice.startup) {
            cancelStartupAutomation(socket);
          }
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "cancelSessionPin" }));
          }
          settlePinRequest(false, socket);
        }, timeoutMs);

        const pending = pendingPinRequestRef.current;
        if (pending) {
          if (
            pending.socket !== socket ||
            pending.attemptId !== choice.attemptId
          ) {
            clearTimeout(timeout);
            settlePinRequest(false, pending.socket);
            return;
          }
          if (pending.timeout) clearTimeout(pending.timeout);
          pending.timeout = timeout;
          pending.startup = choice.startup;
        } else {
          pendingPinRequestRef.current = {
            desired: true,
            startup: choice.startup,
            resolve: () => {},
            timeout,
            previousDisableStdin: choice.previousDisableStdin,
            socket,
            attemptId: choice.attemptId,
          };
        }

        setTmuxPinChoice({ ...choice, pendingMode: mode });
        try {
          socket.send(
            JSON.stringify({
              type: "setSessionPinned",
              data: { pinned: true, mode },
            }),
          );
        } catch {
          clearTimeout(timeout);
          if (choice.startup) {
            cancelStartupAutomation(socket);
          }
          settlePinRequest(false, socket);
          toast.error(t("terminal.sessionPinFailed"));
        }
      },
      [cancelStartupAutomation, settlePinRequest, t, tmuxPinChoice],
    );
    useEffect(() => {
      isUnmountingRef.current = false;
      shouldNotReconnectRef.current = false;
      isReconnectingRef.current = false;
      isConnectingRef.current = false;
      reconnectAttempts.current = 0;
      wasConnectedRef.current = false;
      isAttachingSessionRef.current = false;

      return () => {};
    }, [hostConfig.id]);
    const connectionAttemptIdRef = useRef(0);
    const totpTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const connectionTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const activityLoggedRef = useRef(false);
    const commandHistoryTrackingEnabled =
      hostConfig.enableCommandHistory !== false;

    const { trackInput, getCurrentCommand, updateCurrentCommand } =
      useCommandTracker({
        hostId: hostConfig.id,
        enabled: commandHistoryTrackingEnabled,
        onCommandExecuted: (command) => {
          if (!autocompleteHistory.current.includes(command)) {
            autocompleteHistory.current = [
              command,
              ...autocompleteHistory.current,
            ];
          }
        },
      });

    const getCurrentCommandRef = useRef(getCurrentCommand);
    const updateCurrentCommandRef = useRef(updateCurrentCommand);

    useEffect(() => {
      getCurrentCommandRef.current = getCurrentCommand;
      updateCurrentCommandRef.current = updateCurrentCommand;
    }, [getCurrentCommand, updateCurrentCommand]);

    const [showAutocomplete, setShowAutocomplete] = useState(false);
    const [autocompleteSuggestions, setAutocompleteSuggestions] = useState<
      string[]
    >([]);
    const [autocompleteSelectedIndex, setAutocompleteSelectedIndex] =
      useState(0);
    const [autocompletePosition, setAutocompletePosition] = useState({
      top: 0,
      left: 0,
    });
    const autocompleteHistory = useRef<string[]>([]);
    const currentAutocompleteCommand = useRef<string>("");

    const showAutocompleteRef = useRef(false);
    const autocompleteSuggestionsRef = useRef<string[]>([]);
    const autocompleteSelectedIndexRef = useRef(0);

    const [showHistoryDialog] = useState(false);
    const [, setCommandHistory] = useState<string[]>([]);
    const [, setIsLoadingHistory] = useState(false);

    const setIsLoadingRef = useRef(commandHistoryContext.setIsLoading);
    const setCommandHistoryContextRef = useRef(
      commandHistoryContext.setCommandHistory,
    );

    useEffect(() => {
      setIsLoadingRef.current = commandHistoryContext.setIsLoading;
      setCommandHistoryContextRef.current =
        commandHistoryContext.setCommandHistory;
    }, [
      commandHistoryContext.setIsLoading,
      commandHistoryContext.setCommandHistory,
    ]);

    useEffect(() => {
      if (showHistoryDialog && hostConfig.id) {
        setIsLoadingHistory(true);
        setIsLoadingRef.current(true);
        getCommandHistory(hostConfig.id!)
          .then((history) => {
            setCommandHistory(history);
            setCommandHistoryContextRef.current(history);
          })
          .catch((error) => {
            console.error("Failed to load command history:", error);
            setCommandHistory([]);
            setCommandHistoryContextRef.current([]);
          })
          .finally(() => {
            setIsLoadingHistory(false);
            setIsLoadingRef.current(false);
          });
      }
    }, [showHistoryDialog, hostConfig.id]);

    useEffect(() => {
      const autocompleteEnabled =
        localStorage.getItem("commandAutocomplete") === "true";

      if (hostConfig.id && autocompleteEnabled) {
        getCommandHistory(hostConfig.id!)
          .then((history) => {
            autocompleteHistory.current = history;
          })
          .catch((error) => {
            console.error("Failed to load autocomplete history:", error);
            autocompleteHistory.current = [];
          });
      } else {
        autocompleteHistory.current = [];
      }
    }, [hostConfig.id]);

    useEffect(() => {
      showAutocompleteRef.current = showAutocomplete;
    }, [showAutocomplete]);

    useEffect(() => {
      autocompleteSuggestionsRef.current = autocompleteSuggestions;
    }, [autocompleteSuggestions]);

    useEffect(() => {
      autocompleteSelectedIndexRef.current = autocompleteSelectedIndex;
    }, [autocompleteSelectedIndex]);

    const activityLoggingRef = useRef(false);
    const passwordPromptShownRef = useRef(false);
    const alternateScreenModeRef = useRef(false);

    const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null);
    const pendingSizeRef = useRef<{ cols: number; rows: number } | null>(null);
    const notifyTimerRef = useRef<NodeJS.Timeout | null>(null);
    const lastFittedSizeRef = useRef<{ cols: number; rows: number } | null>(
      null,
    );
    const terminalFontSizeRef = useRef(config.fontSize);
    const DEBOUNCE_MS = 140;

    const logTerminalActivity = async () => {
      if (
        !hostConfig.id ||
        activityLoggedRef.current ||
        activityLoggingRef.current
      ) {
        return;
      }

      activityLoggingRef.current = true;
      activityLoggedRef.current = true;

      try {
        const hostName =
          hostConfig.name || `${hostConfig.username}@${hostConfig.ip}`;
        await logActivity("terminal", hostConfig.id, hostName);
      } catch (err) {
        console.warn("Failed to log terminal activity:", err);
        activityLoggedRef.current = false;
      } finally {
        activityLoggingRef.current = false;
      }
    };

    useEffect(() => {
      isVisibleRef.current = isVisible;
    }, [isVisible]);

    useEffect(() => {
      // One-shot: historical code polled every 5s but only ever flipped false→true.
      setIsAuthenticated(true);
    }, []);

    function hardRefresh() {
      try {
        if (
          terminal &&
          typeof (
            terminal as { refresh?: (start: number, end: number) => void }
          ).refresh === "function"
        ) {
          (
            terminal as { refresh?: (start: number, end: number) => void }
          ).refresh(0, terminal.rows - 1);
        }
      } catch (error) {
        console.error("Terminal operation failed:", error);
      }
    }

    function performFit() {
      if (
        !fitAddonRef.current ||
        !terminal ||
        !isVisible ||
        isFittingRef.current
      ) {
        return;
      }

      isFittingRef.current = true;

      try {
        fitAddonRef.current.fit();
        if (terminal && terminal.cols > 0 && terminal.rows > 0) {
          const lastSize = lastFittedSizeRef.current;
          if (
            !lastSize ||
            lastSize.cols !== terminal.cols ||
            lastSize.rows !== terminal.rows
          ) {
            scheduleNotify(terminal.cols, terminal.rows);
            lastFittedSizeRef.current = {
              cols: terminal.cols,
              rows: terminal.rows,
            };
          }
        }
        setIsFitted(true);
      } finally {
        isFittingRef.current = false;
      }
    }

    function changeTerminalFontSize(direction: -1 | 1) {
      const currentFontSize =
        terminal.options.fontSize ??
        terminalFontSizeRef.current ??
        DEFAULT_TERMINAL_CONFIG.fontSize;
      const nextFontSize = getNextTerminalFontSize(currentFontSize, direction);

      if (nextFontSize === currentFontSize) {
        return;
      }

      terminalFontSizeRef.current = nextFontSize;
      terminal.options.fontSize = nextFontSize;
      performFit();
      hardRefresh();
    }

    function handleTotpSubmit(code: string) {
      const isPushMode = mfaPromptMode === "push";
      if (webSocketRef.current && (code || isPushMode)) {
        webSocketRef.current.send(
          JSON.stringify({
            type: isPasswordPrompt ? "password_response" : "totp_response",
            data: { code },
          }),
        );
        if (isPushMode) {
          // Server blocks until the phone approval completes; keep the dialog
          // open in a waiting state rather than closing it immediately. The
          // existing timeout continues running until "connected" or "error".
          setMfaWaiting(true);
          return;
        }
        if (totpTimeoutRef.current) {
          clearTimeout(totpTimeoutRef.current);
          totpTimeoutRef.current = null;
        }
        setTotpRequired(false);
        setTotpPrompt("");
        setIsPasswordPrompt(false);
      }
    }

    function handleTotpCancel() {
      if (totpTimeoutRef.current) {
        clearTimeout(totpTimeoutRef.current);
        totpTimeoutRef.current = null;
      }
      setTotpRequired(false);
      setTotpPrompt("");
      setIsPasswordPrompt(false);
      setMfaPromptMode("totp");
      setMfaWaiting(false);
      if (onClose) onClose();
    }

    function handleWarpgateContinue() {
      if (webSocketRef.current) {
        if (warpgateTimeoutRef.current) {
          clearTimeout(warpgateTimeoutRef.current);
          warpgateTimeoutRef.current = null;
        }
        webSocketRef.current.send(
          JSON.stringify({
            type: "warpgate_auth_continue",
            data: {},
          }),
        );
        setWarpgateAuthRequired(false);
        setWarpgateAuthUrl("");
        setWarpgateSecurityKey("");
      }
    }

    function handleWarpgateCancel() {
      if (warpgateTimeoutRef.current) {
        clearTimeout(warpgateTimeoutRef.current);
        warpgateTimeoutRef.current = null;
      }
      setWarpgateAuthRequired(false);
      setWarpgateAuthUrl("");
      setWarpgateSecurityKey("");
      if (onClose) onClose();
    }

    function handleWarpgateOpenUrl() {
      if (warpgateAuthUrl) {
        window.open(warpgateAuthUrl, "_blank", "noopener,noreferrer");
      }
    }

    function handleAuthDialogSubmit(credentials: {
      password?: string;
      sshKey?: string;
      keyPassword?: string;
    }) {
      if (webSocketRef.current && terminal) {
        webSocketRef.current.send(
          JSON.stringify({
            type: "reconnect_with_credentials",
            data: {
              cols: terminal.cols,
              rows: terminal.rows,
              password: credentials.password,
              sshKey: credentials.sshKey,
              keyPassword: credentials.keyPassword,
              hostConfig: {
                ...hostConfig,
                password: credentials.password,
                key: credentials.sshKey,
                keyPassword: credentials.keyPassword,
              },
            },
          }),
        );
        setShowAuthDialog(false);
        setIsConnecting(true);
      }
    }

    function handleAuthDialogCancel() {
      setShowAuthDialog(false);
      if (onClose) onClose();
    }

    function handlePassphraseSubmit(passphrase: string) {
      if (webSocketRef.current && terminal) {
        webSocketRef.current.send(
          JSON.stringify({
            type: "reconnect_with_credentials",
            data: {
              cols: terminal.cols,
              rows: terminal.rows,
              keyPassword: passphrase,
              hostConfig: {
                ...hostConfig,
                keyPassword: passphrase,
              },
            },
          }),
        );
        setShowPassphraseDialog(false);
        setIsConnecting(true);
      }
    }

    function handlePassphraseCancel() {
      setShowPassphraseDialog(false);
      if (onClose) onClose();
    }

    function scheduleNotify(cols: number, rows: number) {
      if (!(cols > 0 && rows > 0)) return;
      pendingSizeRef.current = { cols, rows };
      if (notifyTimerRef.current) clearTimeout(notifyTimerRef.current);
      notifyTimerRef.current = setTimeout(() => {
        const next = pendingSizeRef.current;
        const last = lastSentSizeRef.current;
        if (!next) return;
        if (last && last.cols === next.cols && last.rows === next.rows) return;
        if (webSocketRef.current?.readyState === WebSocket.OPEN) {
          webSocketRef.current.send(
            JSON.stringify({ type: "resize", data: next }),
          );
          lastSentSizeRef.current = next;
        }
      }, DEBOUNCE_MS);
    }

    function formatTerminalOutput(output: string): string {
      const alternateScreen = updateAlternateScreenMode(
        output,
        alternateScreenModeRef.current,
      );
      alternateScreenModeRef.current = alternateScreen.isActive;

      const syntaxHighlightingEnabled =
        hostConfig.terminalConfig?.syntaxHighlighting !== false;
      if (
        !syntaxHighlightingEnabled ||
        alternateScreen.sawSequence ||
        alternateScreen.isActive
      ) {
        return output;
      }

      return highlightTerminalOutput(
        output,
        hostConfig.terminalConfig?.syntaxHighlightingOptions,
      );
    }

    async function resolvePasswordForPrompt(isSudoPrompt: boolean) {
      let passwordToFill = isSudoPrompt
        ? hostConfig.terminalConfig?.sudoPassword || hostConfig.password
        : hostConfig.password || hostConfig.terminalConfig?.sudoPassword;

      if (!passwordToFill && hostConfig.id) {
        passwordToFill = isSudoPrompt
          ? (await getHostPassword(hostConfig.id, "sudoPassword")) ||
            (await getHostPassword(hostConfig.id, "password")) ||
            undefined
          : (await getHostPassword(hostConfig.id, "password")) ||
            (await getHostPassword(hostConfig.id, "sudoPassword")) ||
            undefined;
      }

      return passwordToFill;
    }

    function maybeOfferPasswordFill(strippedData: string) {
      const passwordPromptPattern =
        /(?:\[sudo\][^\n\r]*:\s*$|sudo:[^\n\r]*password[^\n\r]*required|password for [^\n\r]*:\s*$|Password:\s*$|password:\s*$)/im;
      if (!passwordPromptPattern.test(strippedData)) return;

      const hasStoredPassword =
        hostConfig.terminalConfig?.sudoPassword ||
        hostConfig.password ||
        hostConfig.hasSudoPassword ||
        hostConfig.hasPassword;
      if (!hasStoredPassword || passwordPromptShownRef.current) return;

      passwordPromptShownRef.current = true;
      const isSudoPrompt = /(?:\[sudo\]|sudo:)/i.test(strippedData);

      confirmWithToast(
        t("terminal.passwordPromptFillTitle"),
        async () => {
          const passwordToFill = await resolvePasswordForPrompt(isSudoPrompt);
          if (passwordToFill) sendTerminalInput(passwordToFill + "\n");
          setTimeout(() => {
            passwordPromptShownRef.current = false;
          }, 3000);
        },
        t("common.confirm"),
        t("common.cancel"),
        { confirmOnEnter: true },
      );
      setTimeout(() => {
        passwordPromptShownRef.current = false;
      }, 15000);
    }

    const closeTerminalConnection = (terminateSession: boolean) => {
      isUnmountingRef.current = true;
      shouldNotReconnectRef.current = true;
      isReconnectingRef.current = false;
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }
      if (pongTimeoutRef.current) {
        clearTimeout(pongTimeoutRef.current);
        pongTimeoutRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }
      if (totpTimeoutRef.current) {
        clearTimeout(totpTimeoutRef.current);
        totpTimeoutRef.current = null;
      }
      if (warpgateTimeoutRef.current) {
        clearTimeout(warpgateTimeoutRef.current);
        warpgateTimeoutRef.current = null;
      }
      if (
        terminateSession &&
        webSocketRef.current?.readyState === WebSocket.OPEN
      ) {
        webSocketRef.current.send(JSON.stringify({ type: "disconnect" }));
      }
      sessionIdRef.current = null;
      webSocketRef.current?.close();
      setIsConnected(false);
      setIsConnecting(false);
      settlePinRequest(false);
    };

    useImperativeHandle(
      ref,
      () => ({
        disconnect: () => closeTerminalConnection(true),
        detach: () => closeTerminalConnection(false),
        reconnect: () => {
          isUnmountingRef.current = false;
          shouldNotReconnectRef.current = false;
          isReconnectingRef.current = false;
          isConnectingRef.current = false;
          reconnectAttempts.current = 0;
          wasDisconnectedBySSH.current = false;
          wasConnectedRef.current = false;
          updateConnectionError(null);
          setShowDisconnectedOverlay(false);
          if (terminal) {
            terminal.clear();
            const cols = terminal.cols;
            const rows = terminal.rows;
            connectToHost(cols, rows);
          }
        },
        isConnected: () => isConnected,
        fit: () => {
          if (!fitAddonRef.current || !terminal || isFittingRef.current) return;
          isFittingRef.current = true;
          try {
            fitAddonRef.current.fit();
            if (terminal.cols > 0 && terminal.rows > 0) {
              const lastSize = lastFittedSizeRef.current;
              if (
                !lastSize ||
                lastSize.cols !== terminal.cols ||
                lastSize.rows !== terminal.rows
              ) {
                scheduleNotify(terminal.cols, terminal.rows);
                lastFittedSizeRef.current = {
                  cols: terminal.cols,
                  rows: terminal.rows,
                };
              }
            }
            setIsFitted(true);
          } finally {
            isFittingRef.current = false;
          }
        },
        getRecentOutput: (maxLines?: number) =>
          recentOutputLines(recentOutputRef.current, maxLines),
        getSessionContext: () => ({
          sessionId: sessionIdRef.current,
          agentSessionId: hostConfig.agentSessionId ?? null,
          hostId: hostConfig.id ?? null,
          connected: isConnected,
        }),
        focus: () => terminal?.focus(),
        sendInput: (data: string) => {
          sendTerminalInput(data);
        },
        paste: (text: string) => {
          if (!isTerminalInputBlocked()) terminal?.paste(text);
        },
        notifyResize: () => {
          try {
            const cols = terminal?.cols ?? undefined;
            const rows = terminal?.rows ?? undefined;
            if (typeof cols === "number" && typeof rows === "number") {
              scheduleNotify(cols, rows);
              hardRefresh();
            }
          } catch (error) {
            console.error("Terminal operation failed:", error);
          }
        },
        refresh: () => hardRefresh(),
        getApplicationCursorKeysMode: () =>
          terminal?.modes?.applicationCursorKeysMode ?? false,
        openFileManager: () => {
          if (webSocketRef.current?.readyState === WebSocket.OPEN) {
            webSocketRef.current.send(JSON.stringify({ type: "get_cwd" }));
          } else {
            onOpenFileManager?.("/");
          }
        },
        openShareModal: () => setShareModalOpen(true),
        canShare: () =>
          isConnected &&
          !isQuickConnect &&
          !hostConfig.joinShareId &&
          !hostConfig.agentSessionId &&
          typeof hostConfig.id === "number",
        pinSession: () => {
          if (sessionPinnedRef.current) {
            return Promise.resolve(true);
          }
          if (pendingPinRequestRef.current) {
            return Promise.resolve(false);
          }
          if (
            hostConfig.joinShareId ||
            hostConfig.agentSessionId ||
            isQuickConnect ||
            !sessionIdRef.current ||
            webSocketRef.current?.readyState !== WebSocket.OPEN
          ) {
            toast.error(
              isQuickConnect
                ? t("terminal.saveBeforePinning")
                : hostConfig.agentSessionId
                  ? t("terminal.agentSessionControlled")
                  : t("terminal.sessionNotReadyToPin"),
            );
            return Promise.resolve(false);
          }

          return new Promise<boolean>((resolve) => {
            const socket = webSocketRef.current;
            if (!socket) {
              resolve(false);
              return;
            }
            const attemptId = connectionAttemptIdRef.current;
            const previousDisableStdin = blockTerminalInput();
            pendingPinRequestRef.current = {
              desired: true,
              startup: false,
              resolve,
              timeout: null,
              previousDisableStdin,
              socket,
              attemptId,
            };
            setTmuxPinChoice({
              socket,
              attemptId,
              startup: false,
              stage: "mode",
              pendingMode: null,
              previousDisableStdin,
            });
          });
        },
        isSessionPinned: () => sessionPinnedRef.current,
      }),
      [
        isConnected,
        terminal,
        isQuickConnect,
        hostConfig.joinShareId,
        hostConfig.agentSessionId,
        hostConfig.id,
        blockTerminalInput,
        sendTerminalInput,
        settlePinRequest,
      ],
    );

    function getUseRightClickCopyPaste() {
      return getCookie("rightClickCopyPaste") !== "false";
    }

    function attemptReconnection() {
      if (
        isUnmountingRef.current ||
        shouldNotReconnectRef.current ||
        isReconnectingRef.current ||
        isConnectingRef.current ||
        wasDisconnectedBySSH.current ||
        reconnectTimeoutRef.current !== null
      ) {
        return;
      }

      if (reconnectAttempts.current >= maxReconnectAttempts) {
        setIsConnecting(false);
        shouldNotReconnectRef.current = true;
        setShowDisconnectedOverlay(true);
        addLog({
          type: "error",
          stage: "connection",
          message: t("terminal.maxReconnectAttemptsReached"),
        });
        return;
      }

      isReconnectingRef.current = true;

      if (terminal && !isAttachingSessionRef.current) {
        terminal.clear();
      }

      reconnectAttempts.current++;

      addLog({
        type: "info",
        stage: "connection",
        message: t("terminal.reconnecting", {
          attempt: reconnectAttempts.current,
          max: maxReconnectAttempts,
        }),
      });

      const delay = Math.min(
        2000 * Math.pow(2, reconnectAttempts.current - 1),
        8000,
      );

      reconnectTimeoutRef.current = setTimeout(() => {
        reconnectTimeoutRef.current = null;

        if (
          isUnmountingRef.current ||
          shouldNotReconnectRef.current ||
          wasDisconnectedBySSH.current
        ) {
          isReconnectingRef.current = false;
          return;
        }

        if (reconnectAttempts.current > maxReconnectAttempts) {
          isReconnectingRef.current = false;
          return;
        }

        if (terminal && hostConfig) {
          if (!isAttachingSessionRef.current) {
            terminal.clear();
          }
          const cols = terminal.cols;
          const rows = terminal.rows;
          connectToHost(cols, rows);
        }

        isReconnectingRef.current = false;
      }, delay);
    }

    async function connectToHost(cols: number, rows: number) {
      if (isConnectingRef.current) {
        return;
      }

      const previousSocket = webSocketRef.current;
      cancelStartupAutomation(previousSocket);
      settlePinRequest(false, previousSocket);
      isConnectingRef.current = true;
      connectionAttemptIdRef.current++;
      wasConnectedRef.current = false;

      if (!isReconnectingRef.current) {
        reconnectAttempts.current = 0;
        shouldNotReconnectRef.current = false;
      }

      const isDev =
        !isElectron() &&
        process.env.NODE_ENV === "development" &&
        (window.location.port === "3000" ||
          window.location.port === "5173" ||
          window.location.port === "");

      let baseWsUrl: string;

      if (isDev) {
        baseWsUrl = `${window.location.protocol === "https:" ? "wss" : "ws"}://localhost:30002`;
      } else if (isElectron()) {
        const origin = await resolveConnectionOrigin({
          connectionType: "ssh",
          connectionOrigin: hostConfig.connectionOrigin as
            | "local"
            | "remote"
            | null
            | undefined,
        });
        const resolvedUrl = await buildOriginWsUrl({
          origin,
          localPort: 30002,
          localPath: "",
          remotePath: "/ssh/websocket/",
        });
        if (!resolvedUrl) {
          setIsConnected(false);
          setIsConnecting(false);
          updateConnectionError(t("errors.remoteServerRequired"));
          isConnectingRef.current = false;
          return;
        }
        baseWsUrl = resolvedUrl;
      } else {
        baseWsUrl = `${getBasePath()}/ssh/websocket/`;
      }

      if (previousSocket && previousSocket.readyState !== WebSocket.CLOSED) {
        previousSocket.close();
      }

      const shouldStartPinned =
        sessionIdRef.current === null &&
        !hostConfig.joinShareId &&
        hostConfig.terminalConfig?.startPinned === true &&
        !isQuickConnect &&
        Number.isSafeInteger(hostConfig.id) &&
        Number(hostConfig.id) > 0 &&
        !tmuxAttachSession;

      if (shouldStartPinned) blockTerminalInput();

      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }

      const ws = new WebSocket(baseWsUrl);
      webSocketRef.current = ws;
      resetStartupAutomation(
        ws,
        sessionIdRef.current === null &&
          !hostConfig.joinShareId &&
          !hostConfig.agentSessionId &&
          !tmuxAttachSession &&
          !shouldStartPinned,
      );
      wasDisconnectedBySSH.current = false;
      updateConnectionError(null);
      shouldNotReconnectRef.current = false;
      isReconnectingRef.current = false;
      setIsConnecting(true);

      setupWebSocketListeners(ws, cols, rows, shouldStartPinned);
    }

    function setupWebSocketListeners(
      ws: WebSocket,
      cols: number,
      rows: number,
      shouldStartPinned: boolean,
    ) {
      const currentAttemptId = connectionAttemptIdRef.current;
      const isCurrentConnection = () =>
        isMountedRef.current &&
        webSocketRef.current === ws &&
        connectionAttemptIdRef.current === currentAttemptId;

      ws.addEventListener("open", async () => {
        if (!isCurrentConnection()) return;
        alternateScreenModeRef.current = false;
        connectionTimeoutRef.current = setTimeout(() => {
          if (
            !isConnected &&
            !totpRequired &&
            !isPasswordPrompt &&
            !connectionErrorRef.current
          ) {
            if (terminal) {
              terminal.clear();
            }
            const timeoutMessage = t("terminal.connectionTimeout");
            updateConnectionError(timeoutMessage);
            addLog({
              type: "error",
              stage: "connection",
              message: timeoutMessage,
            });
            if (webSocketRef.current) {
              webSocketRef.current.close();
            }
            if (reconnectAttempts.current > 0) {
              attemptReconnection();
            } else {
              setIsConnecting(false);
              shouldNotReconnectRef.current = true;
            }
          }
        }, 35000);

        currentHostIdRef.current = hostConfig.id;
        currentHostConfigRef.current = hostConfig;

        // 浏览器自动重连和手动重连始终优先附加已知后台会话；只有服务端明确
        // 返回 sessionExpired 才会清空该 ID 并创建新的 SSH。
        const restoredSessionId = sessionIdRef.current;

        if (hostConfig.joinShareId) {
          isAttachingSessionRef.current = true;

          ws.send(
            JSON.stringify({
              type: "joinSharedSession",
              data: {
                shareId: hostConfig.joinShareId,
                tabInstanceId: hostConfig.instanceId,
              },
            }),
          );
        } else if (hostConfig.agentSessionId) {
          isAttachingSessionRef.current = true;
          applyAgentAccessMode("read-only");

          ws.send(
            JSON.stringify({
              type: "attachAgentSession",
              data: {
                agentSessionId: hostConfig.agentSessionId,
                cols,
                rows,
                tabInstanceId: hostConfig.instanceId,
              },
            }),
          );
        } else if (restoredSessionId) {
          sessionIdRef.current = restoredSessionId;
          isAttachingSessionRef.current = true;

          ws.send(
            JSON.stringify({
              type: "attachSession",
              data: {
                sessionId: restoredSessionId,
                hostId: hostConfig.id,
                cols,
                rows,
                tabInstanceId: hostConfig.instanceId,
              },
            }),
          );
        } else {
          isAttachingSessionRef.current = false;
          ws.send(
            JSON.stringify({
              type: "connectToHost",
              data: {
                cols,
                rows,
                hostConfig: buildTerminalConnectionHostConfig(
                  hostConfig,
                  isQuickConnect,
                ),
                initialPath,
                executeCommand,
                tmuxAttachSession,
                pinned: shouldStartPinned,
              },
            }),
          );
        }
        terminalInputDisposableRef.current = replaceTerminalInputListener(
          terminalInputDisposableRef.current,
          terminal,
          (data) => {
            if (!isCurrentConnection() || isTerminalInputBlocked()) {
              return;
            }
            if (data === "\r" || data === "\n") {
              const currentCmd = getCurrentCommand().trim();
              const termixMatch = currentCmd.match(/^termix\s+(.+)$/);
              if (termixMatch && onOpenFileInEditor) {
                const filePath = termixMatch[1].trim();
                trackInput(data);
                terminal.write("\r\n");
                ws.send(
                  JSON.stringify({
                    type: "open_file_in_editor",
                    path: filePath,
                  }),
                );
                return;
              }
            }
            if (sendTerminalInput(data, ws)) trackInput(data);
          },
        );

        pongReceivedRef.current = true;
        pingIntervalRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            if (!pongReceivedRef.current) {
              console.warn(
                "[WebSocket] Pong timeout - connection appears dead, closing",
              );
              ws.close();
              return;
            }
            pongReceivedRef.current = false;
            ws.send(JSON.stringify({ type: "ping" }));
          }
        }, 30000);
      });

      ws.addEventListener("message", (event) => {
        if (!isCurrentConnection()) return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "pong") {
            pongReceivedRef.current = true;
            return;
          }
          if (msg.type === "data") {
            if (typeof msg.data === "string") {
              if (showAutocompleteRef.current) {
                showAutocompleteRef.current = false;
                setShowAutocomplete(false);
                setAutocompleteSuggestions([]);
                currentAutocompleteCommand.current = "";
              }

              terminal.write(formatTerminalOutput(msg.data));
              recentOutputRef.current = appendRecentOutput(
                recentOutputRef.current,
                msg.data,
              );
              // Strip ANSI escape codes before testing — newer sudo versions (Ubuntu 26.04+)
              // emit colored prompts with embedded escape sequences that break the regex.
              const strippedData = msg.data.replace(
                /\x1b(?:[@-Z\\-_]|\[[0-9;?>=!]*[@-~])/g,
                "",
              );
              maybeOfferPasswordFill(strippedData);
            } else {
              const stringData = String(msg.data);
              terminal.write(formatTerminalOutput(stringData));
              recentOutputRef.current = appendRecentOutput(
                recentOutputRef.current,
                stringData,
              );
            }
          } else if (msg.type === "error") {
            const rawErrorMessage = msg.message || t("terminal.unknownError");
            const isAgentSessionError =
              typeof msg.code === "string" &&
              msg.code.startsWith("AGENT_SESSION_");
            const errorMessage = isAgentSessionError
              ? t("terminal.agentSessionUnavailable")
              : rawErrorMessage;

            addLog({
              type: "error",
              stage: "connection",
              message: errorMessage,
            });
            isConnectingRef.current = false;
            if (connectionTimeoutRef.current) {
              clearTimeout(connectionTimeoutRef.current);
              connectionTimeoutRef.current = null;
            }

            // Agent 目标必须始终经过专用入口校验。附着失败时关闭当前
            // WebSocket，避免连接超时逻辑把它反复重试成循环。
            if (isAgentSessionError) {
              updateConnectionError(errorMessage);
              setIsConnected(false);
              setIsConnecting(false);
              isConnectingRef.current = false;
              shouldNotReconnectRef.current = true;
              wasDisconnectedBySSH.current = true;
              webSocketRef.current?.close();
              return;
            }

            if (
              errorMessage.toLowerCase().includes("connection") ||
              errorMessage.toLowerCase().includes("timeout") ||
              errorMessage.toLowerCase().includes("network")
            ) {
              updateConnectionError(errorMessage);
              setIsConnected(false);
              if (terminal) {
                terminal.clear();
              }
              setIsConnecting(false);
              wasDisconnectedBySSH.current = false;
              return;
            }

            if (
              (errorMessage.toLowerCase().includes("auth") &&
                errorMessage.toLowerCase().includes("failed")) ||
              errorMessage.toLowerCase().includes("permission denied") ||
              (errorMessage.toLowerCase().includes("invalid") &&
                (errorMessage.toLowerCase().includes("password") ||
                  errorMessage.toLowerCase().includes("key"))) ||
              errorMessage.toLowerCase().includes("incorrect password")
            ) {
              updateConnectionError(errorMessage);
              setIsConnecting(false);
              shouldNotReconnectRef.current = true;
              if (webSocketRef.current) {
                webSocketRef.current.close();
              }
              return;
            }

            updateConnectionError(errorMessage);
            setIsConnecting(false);
          } else if (msg.type === "connected") {
            opksshFailedRef.current = false;
            vaultFailedRef.current = false;
            wasConnectedRef.current = true;
            setIsConnected(true);
            setIsConnecting(false);
            isConnectingRef.current = false;
            updateConnectionError(null);
            if (connectionTimeoutRef.current) {
              clearTimeout(connectionTimeoutRef.current);
              connectionTimeoutRef.current = null;
            }
            if (reconnectAttempts.current > 0) {
              addLog({
                type: "success",
                stage: "connection",
                message: t("terminal.reconnected"),
              });
            } else {
              addLog({
                type: "success",
                stage: "connection",
                message: t("terminal.connected"),
              });
            }
            reconnectAttempts.current = 0;
            isReconnectingRef.current = false;

            logTerminalActivity();

            queueStartupAutomation(ws);
          } else if (msg.type === "session_ended") {
            cancelStartupAutomation(ws);
            settlePinRequest(false, ws);
            wasDisconnectedBySSH.current = true;
            setIsConnected(false);
            setIsConnecting(false);
            shouldNotReconnectRef.current = true;
            if (onClose) {
              onClose();
            }
          } else if (msg.type === "disconnected") {
            cancelStartupAutomation(ws);
            settlePinRequest(false, ws);
            wasDisconnectedBySSH.current = true;
            shouldNotReconnectRef.current = true;
            setIsConnected(false);
            setIsConnecting(false);
            if (msg.graceful) {
              wasConnectedRef.current = false;
              if (onClose) onClose();
            } else if (wasConnectedRef.current) {
              wasConnectedRef.current = false;
              setShowDisconnectedOverlay(true);
            } else if (!connectionErrorRef.current) {
              updateConnectionError(
                msg.message || t("terminal.connectionRejected"),
              );
            }
          } else if (msg.type === "totp_required") {
            setTotpRequired(true);
            setTotpPrompt(msg.prompt || t("terminal.totpCodeLabel"));
            setIsPasswordPrompt(false);
            setMfaPromptMode("totp");
            setMfaWaiting(false);
            if (connectionTimeoutRef.current) {
              clearTimeout(connectionTimeoutRef.current);
              connectionTimeoutRef.current = null;
            }
            if (totpTimeoutRef.current) {
              clearTimeout(totpTimeoutRef.current);
            }
            totpTimeoutRef.current = setTimeout(() => {
              setTotpRequired(false);
              if (webSocketRef.current) {
                webSocketRef.current.close();
              }
            }, 180000);
          } else if (msg.type === "totp_retry") {
            // Existing prompt remains visible while the backend asks for another code.
            setMfaWaiting(false);
          } else if (msg.type === "password_required") {
            const promptText: string = msg.prompt || "";
            const pushPromptPattern =
              /choose.*push.*totp|press enter.*(push|send)|push notification|authentication by phone/i;
            const isPush = pushPromptPattern.test(promptText);
            const isMenu = !isPush && msg.echo === true;
            const mode: "menu" | "push" | "password" = isPush
              ? "push"
              : isMenu
                ? "menu"
                : "password";

            setTotpRequired(true);
            setTotpPrompt(promptText || t("common.password"));
            setIsPasswordPrompt(true);
            setMfaPromptMode(mode);
            setMfaWaiting(false);
            if (connectionTimeoutRef.current) {
              clearTimeout(connectionTimeoutRef.current);
              connectionTimeoutRef.current = null;
            }
            if (totpTimeoutRef.current) {
              clearTimeout(totpTimeoutRef.current);
            }
            totpTimeoutRef.current = setTimeout(
              () => {
                setTotpRequired(false);
                if (webSocketRef.current) {
                  webSocketRef.current.close();
                }
              },
              isPush ? 300000 : 180000,
            );
          } else if (msg.type === "warpgate_auth_required") {
            setWarpgateAuthRequired(true);
            setWarpgateAuthUrl(msg.url || "");
            setWarpgateSecurityKey(msg.securityKey || "N/A");
            if (connectionTimeoutRef.current) {
              clearTimeout(connectionTimeoutRef.current);
              connectionTimeoutRef.current = null;
            }
            if (warpgateTimeoutRef.current) {
              clearTimeout(warpgateTimeoutRef.current);
            }
            warpgateTimeoutRef.current = setTimeout(() => {
              setWarpgateAuthRequired(false);
              if (webSocketRef.current) {
                webSocketRef.current.close();
              }
            }, 300000);
          } else if (msg.type === "opkssh_auth_required") {
            if (connectionTimeoutRef.current) {
              clearTimeout(connectionTimeoutRef.current);
              connectionTimeoutRef.current = null;
            }
            if (opksshFailedRef.current) {
              setOpksshDialog(null);
              if (opksshTimeoutRef.current) {
                clearTimeout(opksshTimeoutRef.current);
                opksshTimeoutRef.current = null;
              }
              updateConnectionError(t("terminal.opksshAuthFailed"));
              addLog({
                type: "error",
                stage: "auth",
                message: t("terminal.opksshAuthFailed"),
              });
            } else {
              opksshFailedRef.current = true;
              if (webSocketRef.current) {
                webSocketRef.current.send(
                  JSON.stringify({
                    type: "opkssh_start_auth",
                    data: { hostId: msg.hostId },
                  }),
                );
              }
            }
          } else if (msg.type === "vault_auth_required") {
            if (connectionTimeoutRef.current) {
              clearTimeout(connectionTimeoutRef.current);
              connectionTimeoutRef.current = null;
            }
            if (vaultFailedRef.current) {
              setVaultDialog({
                stage: "error",
                error: t("terminal.vaultAuthFailed"),
              });
              updateConnectionError(t("terminal.vaultAuthFailed"));
              addLog({
                type: "error",
                stage: "auth",
                message: t("terminal.vaultAuthFailed"),
              });
            } else {
              vaultFailedRef.current = true;
              webSocketRef.current?.send(
                JSON.stringify({
                  type: "vault_start_auth",
                  data: { hostId: msg.hostId },
                }),
              );
            }
          } else if (msg.type === "vault_auth_url") {
            if (connectionErrorRef.current) return;
            try {
              vaultPopupRef.current = window.open(
                msg.url,
                "termix-vault-oidc",
                "width=540,height=720",
              );
            } catch {
              vaultPopupRef.current = null;
            }
            setVaultDialog({ stage: "waiting" });
            if (vaultTimeoutRef.current) clearTimeout(vaultTimeoutRef.current);
            vaultTimeoutRef.current = setTimeout(() => {
              setVaultDialog(null);
              webSocketRef.current?.close();
            }, 300000);
          } else if (msg.type === "vault_completed") {
            if (vaultTimeoutRef.current) {
              clearTimeout(vaultTimeoutRef.current);
              vaultTimeoutRef.current = null;
            }
            try {
              vaultPopupRef.current?.close();
            } catch {
              // popup may already be closed
            }
            setVaultDialog(null);
            if (webSocketRef.current && terminal) {
              webSocketRef.current.send(
                JSON.stringify({
                  type: "vault_auth_completed",
                  data: {
                    hostId: currentHostIdRef.current,
                    cols: terminal.cols || 80,
                    rows: terminal.rows || 24,
                    hostConfig: currentHostConfigRef.current,
                  },
                }),
              );
            }
          } else if (msg.type === "vault_error") {
            if (connectionErrorRef.current) return;
            vaultFailedRef.current = true;
            if (vaultTimeoutRef.current) {
              clearTimeout(vaultTimeoutRef.current);
              vaultTimeoutRef.current = null;
            }
            try {
              vaultPopupRef.current?.close();
            } catch {
              // popup may already be closed
            }
            setVaultDialog({ stage: "error", error: msg.error });
            setIsConnecting(false);
          } else if (msg.type === "opkssh_status") {
            if (connectionErrorRef.current) return;
            if (msg.stage === "chooser") {
              setOpksshDialog({
                isOpen: true,
                authUrl: msg.url || "",
                requestId: msg.requestId || "",
                stage: "chooser",
                providers: msg.providers,
              });
              if (opksshTimeoutRef.current) {
                clearTimeout(opksshTimeoutRef.current);
              }
              opksshTimeoutRef.current = setTimeout(() => {
                setOpksshDialog(null);
                if (webSocketRef.current) {
                  webSocketRef.current.close();
                }
              }, 300000);
            } else {
              setOpksshDialog((prev) =>
                prev ? { ...prev, stage: msg.stage } : null,
              );
            }
          } else if (msg.type === "opkssh_completed") {
            if (opksshTimeoutRef.current) {
              clearTimeout(opksshTimeoutRef.current);
              opksshTimeoutRef.current = null;
            }
            setOpksshDialog(null);
            if (webSocketRef.current && terminal) {
              webSocketRef.current.send(
                JSON.stringify({
                  type: "opkssh_auth_completed",
                  data: {
                    hostId: currentHostIdRef.current,
                    cols: terminal.cols || 80,
                    rows: terminal.rows || 24,
                    hostConfig: currentHostConfigRef.current,
                  },
                }),
              );
            }
          } else if (msg.type === "opkssh_error") {
            if (connectionErrorRef.current) return;
            opksshFailedRef.current = true;
            if (opksshDialog) {
              setOpksshDialog((prev) =>
                prev ? { ...prev, stage: "error", error: msg.error } : null,
              );
            } else {
              setOpksshDialog({
                isOpen: true,
                authUrl: "",
                requestId: msg.requestId || "",
                stage: "error",
                error: msg.error,
              });
            }
            setIsConnecting(false);
          } else if (msg.type === "opkssh_timeout") {
            if (connectionErrorRef.current) return;
            opksshFailedRef.current = true;
            if (opksshDialog) {
              setOpksshDialog((prev) =>
                prev
                  ? {
                      ...prev,
                      stage: "error",
                      error: t("terminal.opksshTimeout"),
                    }
                  : null,
              );
            } else {
              setOpksshDialog({
                isOpen: true,
                authUrl: "",
                requestId: msg.requestId || "",
                stage: "error",
                error: t("terminal.opksshTimeout"),
              });
            }
            setIsConnecting(false);
          } else if (msg.type === "opkssh_config_error") {
            setOpksshDialog({
              isOpen: true,
              authUrl: "",
              requestId: msg.requestId || "",
              stage: "error",
              error: msg.instructions || msg.error,
            });
          } else if (msg.type === "keyboard_interactive_available") {
            setKeyboardInteractiveDetected(true);
            setIsConnecting(false);
            if (connectionTimeoutRef.current) {
              clearTimeout(connectionTimeoutRef.current);
              connectionTimeoutRef.current = null;
            }
          } else if (msg.type === "auth_method_not_available") {
            setAuthDialogReason("no_keyboard");
            setShowAuthDialog(true);
            setIsConnecting(false);
            if (connectionTimeoutRef.current) {
              clearTimeout(connectionTimeoutRef.current);
              connectionTimeoutRef.current = null;
            }
          } else if (msg.type === "cwd") {
            onOpenFileManager?.(msg.path as string);
          } else if (msg.type === "open_file_in_editor") {
            onOpenFileInEditor?.(msg.path as string);
          } else if (msg.type === "passphrase_required") {
            setShowPassphraseDialog(true);
            setIsConnecting(false);
            if (connectionTimeoutRef.current) {
              clearTimeout(connectionTimeoutRef.current);
              connectionTimeoutRef.current = null;
            }
          } else if (msg.type === "host_key_verification_required") {
            setHostKeyVerification({
              isOpen: true,
              scenario: "new",
              data: msg.data,
            });
            if (connectionTimeoutRef.current) {
              clearTimeout(connectionTimeoutRef.current);
              connectionTimeoutRef.current = null;
            }
          } else if (msg.type === "host_key_changed") {
            setHostKeyVerification({
              isOpen: true,
              scenario: "changed",
              data: msg.data,
            });
            if (connectionTimeoutRef.current) {
              clearTimeout(connectionTimeoutRef.current);
              connectionTimeoutRef.current = null;
            }
          } else if (
            msg.type === "session_pin_mode_required" ||
            msg.type === "session_pin_requires_tmux"
          ) {
            const payload =
              msg.data && typeof msg.data === "object" ? msg.data : {};
            if (
              typeof payload.sessionId === "string" &&
              sessionIdRef.current &&
              payload.sessionId !== sessionIdRef.current
            ) {
              return;
            }
            const isStartupPinChoice = payload.startup === true;
            const pending = pendingPinRequestRef.current;
            if (pending && pending.socket !== ws) return;
            if (pending?.timeout) {
              clearTimeout(pending.timeout);
              pending.timeout = null;
            }
            const previousDisableStdin = blockTerminalInput();
            setTmuxPinChoice((current) => {
              if (
                current?.socket === ws &&
                current.attemptId === currentAttemptId
              ) {
                return {
                  ...current,
                  stage:
                    msg.type === "session_pin_requires_tmux"
                      ? "install"
                      : "mode",
                  pendingMode: null,
                };
              }
              return {
                socket: ws,
                attemptId: currentAttemptId,
                startup: isStartupPinChoice,
                stage:
                  msg.type === "session_pin_requires_tmux" ? "install" : "mode",
                pendingMode: null,
                previousDisableStdin,
              };
            });
          } else if (msg.type === "sessionPinned") {
            const payload = msg;
            const recoveryPending = payload.recoveryPending === true;
            const nextSessionId =
              typeof payload.sessionId === "string"
                ? payload.sessionId
                : sessionIdRef.current;
            const nextPinned = payload.pinned === true;
            const nextTmuxSessionName =
              typeof payload.tmuxSessionName === "string"
                ? payload.tmuxSessionName
                : payload.tmuxSessionName === null
                  ? null
                  : tmuxSessionNameRef.current;
            const nextManagedTmux =
              payload.sessionManagedTmux === true ||
              (payload.sessionManagedTmux !== false &&
                nextPinned &&
                Boolean(nextTmuxSessionName));

            sessionIdRef.current = nextSessionId;
            sessionPinnedRef.current = nextPinned;
            setIsSessionPinned(nextPinned);
            setIsManagedTmux(nextManagedTmux);
            tmuxSessionNameRef.current = nextTmuxSessionName;
            setIsTmuxAttached(Boolean(nextTmuxSessionName));
            publishPersistenceState({
              sessionId: nextSessionId,
              sessionPinned: nextPinned,
              sessionManagedTmux: nextManagedTmux,
              tmuxSessionName: nextTmuxSessionName,
              recoverable: nextManagedTmux,
            });

            const pending = pendingPinRequestRef.current;
            settlePinRequest(
              !recoveryPending && (!pending || pending.desired === nextPinned),
              ws,
            );
          } else if (msg.type === "session_persistence_state") {
            const payload =
              msg.data && typeof msg.data === "object" ? msg.data : {};
            const nextSessionId =
              typeof payload.sessionId === "string"
                ? payload.sessionId
                : sessionIdRef.current;
            const nextPinned = payload.sessionPinned === true;
            const nextTmuxSessionName =
              typeof payload.tmuxSessionName === "string"
                ? payload.tmuxSessionName
                : payload.tmuxSessionName === null
                  ? null
                  : tmuxSessionNameRef.current;

            sessionIdRef.current = nextSessionId;
            sessionPinnedRef.current = nextPinned;
            tmuxSessionNameRef.current = nextTmuxSessionName;
            setIsSessionPinned(nextPinned);
            setIsManagedTmux(payload.sessionManagedTmux === true);
            setIsTmuxAttached(Boolean(nextTmuxSessionName));
            publishPersistenceState({
              sessionId: nextSessionId,
              agentSessionId:
                typeof payload.agentSessionId === "string"
                  ? payload.agentSessionId
                  : (hostConfig.agentSessionId ?? null),
              sessionPinned: nextPinned,
              sessionManagedTmux: payload.sessionManagedTmux === true,
              tmuxSessionName: nextTmuxSessionName,
              lastDetachedAt:
                typeof payload.lastDetachedAt === "number"
                  ? payload.lastDetachedAt
                  : null,
              retentionExpiresAt:
                typeof payload.retentionExpiresAt === "number"
                  ? payload.retentionExpiresAt
                  : null,
              recoverable: payload.recoverable === true,
            });

            const pending = pendingPinRequestRef.current;
            if (pending) {
              settlePinRequest(pending.desired === nextPinned, ws);
            }
          } else if (msg.type === "session_pin_error") {
            const errorMessage =
              typeof msg.message === "string"
                ? msg.message
                : t("terminal.sessionPinFailed");
            const mappedMessageKey =
              typeof msg.code === "string"
                ? SESSION_PIN_ERROR_MESSAGE_KEYS[msg.code]
                : undefined;
            const errorDescription =
              mappedMessageKey !== undefined
                ? t(mappedMessageKey)
                : /tmux/i.test(errorMessage)
                  ? t("terminal.tmuxRequiredForPinning")
                  : errorMessage;
            const pendingPinRequest = pendingPinRequestRef.current;
            const isStartupPinFailure =
              pendingPinRequest?.startup === true ||
              (!wasConnectedRef.current &&
                hostConfig.terminalConfig?.startPinned === true);
            if (isStartupPinFailure) {
              cancelStartupAutomation(ws);
            }
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "cancelSessionPin" }));
            }
            if (isStartupPinFailure) {
              // 连接时固定失败通常需要用户安装 tmux 或修正主机配置。
              // 自动重试只会重复 SSH/密钥授权，不能改变这个前置条件。
              shouldNotReconnectRef.current = true;
              wasDisconnectedBySSH.current = true;
              isConnectingRef.current = false;
              setIsConnected(false);
              setIsConnecting(false);
              updateConnectionError(errorDescription);
              if (
                msg.code !== "SESSION_PIN_RECOVERY_PENDING" &&
                ws.readyState === WebSocket.OPEN
              ) {
                ws.send(JSON.stringify({ type: "disconnect" }));
                sessionIdRef.current = null;
              }
              if (ws.readyState === WebSocket.OPEN) {
                ws.close();
              }
            }
            settlePinRequest(false, ws);
            if (!sessionPinnedRef.current) {
              setIsSessionPinned(false);
              setIsManagedTmux(false);
              publishPersistenceState({
                sessionPinned: false,
                sessionManagedTmux: false,
              });
            }
            toast.error(t("terminal.sessionPinFailed"), {
              description: errorDescription,
            });
          } else if (msg.type === "agent_session_access") {
            const mode = msg.data?.mode;
            if (mode === "read-only" || mode === "read-write") {
              const previousMode = agentAccessModeRef.current;
              applyAgentAccessMode(mode);
              if (previousMode === "read-write" && mode === "read-only") {
                toast.info(t("terminal.agentWriteAccessRevoked"), {
                  id: "terminal-agent-write-access-revoked",
                });
              }
            }
          } else if (msg.type === "agent_session_access_error") {
            if (hostConfig.agentSessionId) {
              applyAgentAccessMode("read-only");
            }
            toast.error(t("terminal.agentAccessFailed"), {
              description:
                typeof msg.message === "string" ? msg.message : undefined,
            });
          } else if (msg.type === "sessionInputBlocked") {
            if (
              msg.code === "AGENT_READ_ONLY" ||
              msg.code === "WRITE_LEASE_INVALID" ||
              msg.code === "ATTACHMENT_NOT_FOUND"
            ) {
              applyAgentAccessMode("read-only");
              toast.info(t("terminal.agentReadOnlyHint"), {
                id: "terminal-agent-read-only-input-blocked",
              });
            } else {
              toast.info(t("terminal.sessionInputBlocked"), {
                id: "terminal-session-pin-input-blocked",
              });
            }
          } else if (msg.type === "sessionCreated") {
            sessionIdRef.current = msg.sessionId;
            publishPersistenceState({ sessionId: msg.sessionId });
            if (hostConfig.instanceId) {
              import("@/main-axios").then(({ patchOpenTab }) => {
                patchOpenTab(hostConfig.instanceId!, {
                  backendSessionId: msg.sessionId,
                }).catch(() => {});
              });
            }
          } else if (msg.type === "sessionAttached") {
            isAttachingSessionRef.current = false;
            opksshFailedRef.current = false;
            vaultFailedRef.current = false;
            wasConnectedRef.current = true;
            setIsConnected(true);
            setIsConnecting(false);
            isConnectingRef.current = false;
            shouldNotReconnectRef.current = false;
            updateConnectionError(null);
            if (connectionTimeoutRef.current) {
              clearTimeout(connectionTimeoutRef.current);
              connectionTimeoutRef.current = null;
            }
            if (reconnectTimeoutRef.current) {
              clearTimeout(reconnectTimeoutRef.current);
              reconnectTimeoutRef.current = null;
            }
            reconnectAttempts.current = 0;
            isReconnectingRef.current = false;
            publishPersistenceState();

            logTerminalActivity();

            addLog({
              type: "success",
              stage: "connection",
              message: t("terminal.reconnected"),
            });
          } else if (msg.type === "sessionAccessRevoked") {
            isAttachingSessionRef.current = false;
            sessionIdRef.current = null;
            shouldNotReconnectRef.current = true;
            wasDisconnectedBySSH.current = true;
            setIsConnected(false);
            setIsConnecting(false);
            updateConnectionError(t("terminal.hostAccessRevoked"));
            settlePinRequest(false, ws);
            toast.error(t("terminal.hostAccessRevoked"));
          } else if (msg.type === "sessionAuthenticationExpired") {
            isAttachingSessionRef.current = false;
            shouldNotReconnectRef.current = true;
            wasDisconnectedBySSH.current = true;
            setIsConnected(false);
            setIsConnecting(false);
            updateConnectionError(t("terminal.loginSessionExpired"));
            settlePinRequest(false, ws);
            toast.error(t("terminal.loginSessionExpired"), {
              description: t("terminal.backgroundSessionStillRunning"),
            });
          } else if (msg.type === "sessionExpired") {
            const accessRevoked = msg.code === "HOST_ACCESS_REVOKED";
            const agentSessionExpired = Boolean(hostConfig.agentSessionId);
            isAttachingSessionRef.current = false;
            sessionIdRef.current = null;
            if (accessRevoked) {
              shouldNotReconnectRef.current = true;
              wasDisconnectedBySSH.current = true;
              wasSessionExpiredRef.current = false;
              setIsConnected(false);
              setIsConnecting(false);
              updateConnectionError(t("terminal.hostAccessRevoked"));
              settlePinRequest(false, ws);
              toast.error(t("terminal.hostAccessRevoked"));
              webSocketRef.current?.close();
              return;
            }
            if (agentSessionExpired) {
              // Agent 远端窗口结束后不降级为普通 SSH；用户可从连接面板
              // 重新进入仍在运行的 Agent 会话或新建独立终端。
              shouldNotReconnectRef.current = true;
              wasDisconnectedBySSH.current = true;
              wasSessionExpiredRef.current = false;
              setIsConnected(false);
              setIsConnecting(false);
              updateConnectionError(t("terminal.agentSessionUnavailable"));
              settlePinRequest(false, ws);
              webSocketRef.current?.close();
              return;
            }
            sessionPinnedRef.current = false;
            setIsSessionPinned(false);
            setIsManagedTmux(false);
            publishPersistenceState({
              sessionId: null,
              sessionPinned: false,
              sessionManagedTmux: false,
              tmuxSessionName: null,
            });
            settlePinRequest(false, ws);
            wasSessionExpiredRef.current = true;
            if (hostConfig.instanceId) {
              import("@/main-axios").then(({ patchOpenTab }) => {
                patchOpenTab(hostConfig.instanceId!, {
                  backendSessionId: null,
                }).catch(() => {});
              });
            }
            if (webSocketRef.current) {
              webSocketRef.current.close();
            }
          } else if (msg.type === "sessionRecoveryDeferred") {
            const mappedMessageKey =
              typeof msg.code === "string"
                ? RECOVERY_DEFERRED_MESSAGE_KEYS[msg.code]
                : undefined;
            const recoveryMessage = t(
              mappedMessageKey ?? "terminal.sessionRecoveryRecordKept",
            );
            isAttachingSessionRef.current = false;
            shouldNotReconnectRef.current = true;
            wasDisconnectedBySSH.current = true;
            setIsConnected(false);
            setIsConnecting(false);
            updateConnectionError(recoveryMessage);
            settlePinRequest(false, ws);
            toast.error(t("terminal.sessionRecoveryDeferred"), {
              description: recoveryMessage,
            });
          } else if (msg.type === "sessionRecoveryFailed") {
            isAttachingSessionRef.current = false;
            settlePinRequest(false, ws);
            toast.error(t("terminal.sessionRecoveryFailed"), {
              description:
                msg.code === "TMUX_SESSION_NOT_FOUND"
                  ? t("terminal.sessionRecoveryTmuxMissing")
                  : typeof msg.message === "string"
                    ? msg.message
                    : undefined,
            });
          } else if (msg.type === "sessionTakenOver") {
            cancelStartupAutomation(ws);
            settlePinRequest(false, ws);
            isAttachingSessionRef.current = false;
            shouldNotReconnectRef.current = true;
            wasDisconnectedBySSH.current = true;
            setIsConnected(false);
            setIsConnecting(false);
            setShowDisconnectedOverlay(true);
            updateConnectionError(t("terminal.sessionTakenOver"));

            addLog({
              type: "warning",
              stage: "connection",
              message: t("terminal.sessionTakenOver"),
            });
          } else if (msg.type === "tmux_sessions_available") {
            setTmuxSessionPicker({
              sessions: msg.sessions,
            });
          } else if (
            msg.type === "tmux_session_created" ||
            msg.type === "tmux_session_attached"
          ) {
            const agentAttached =
              hostConfig.agentSessionId != null ||
              typeof msg.agentSessionId === "string";
            const sessionName =
              typeof msg.sessionName === "string" ? msg.sessionName : "";
            // Agent 的 tmux 窗口是共享运行时，不把内部名称或固定窗口
            // 控件暴露给浏览器；普通网页 tmux 仍保留原有行为。
            tmuxSessionNameRef.current = agentAttached
              ? ""
              : sessionName || "(active)";
            setIsTmuxAttached(!agentAttached);
            publishPersistenceState({
              tmuxSessionName: agentAttached ? null : sessionName || "(active)",
              agentSessionId: agentAttached
                ? (hostConfig.agentSessionId ?? null)
                : null,
            });
            addLog({
              type: "info",
              stage: "connection",
              message: agentAttached
                ? t("terminal.agentSessionAttached")
                : msg.type === "tmux_session_created"
                  ? t("terminal.tmuxSessionCreated", {
                      name: sessionName || "new",
                    })
                  : t("terminal.tmuxSessionAttached", {
                      name: sessionName,
                    }),
            });
          } else if (msg.type === "tmux_unavailable") {
            setTimeout(() => {
              toast.warning(t("terminal.tmuxUnavailable"), {
                duration: 8000,
              });
            }, 500);
            addLog({
              type: "warning",
              stage: "connection",
              message: t("terminal.tmuxUnavailable"),
            });
          } else if (msg.type === "tmux_detached") {
            tmuxSessionNameRef.current = null;
            setIsTmuxAttached(false);
            setIsManagedTmux(false);
            publishPersistenceState({ tmuxSessionName: null });
            toast.info(t("terminal.tmuxDetached"), { duration: 3000 });
          } else if (msg.type === "connection_log") {
            if (msg.data) {
              addLog({
                type: msg.data.level || "info",
                stage: msg.data.stage || "auth",
                message: msg.data.message,
                details: msg.data.details,
              });
            }
          }
        } catch (error) {
          console.error("WebSocket message handler error:", error);
        }
      });

      ws.addEventListener("close", (event) => {
        if (!isCurrentConnection()) {
          return;
        }
        cancelStartupAutomation(ws);
        settlePinRequest(false, ws);

        setIsConnected(false);
        isConnectingRef.current = false;

        if (pingIntervalRef.current) {
          clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = null;
        }

        if (pongTimeoutRef.current) {
          clearTimeout(pongTimeoutRef.current);
          pongTimeoutRef.current = null;
        }

        if (totpTimeoutRef.current) {
          clearTimeout(totpTimeoutRef.current);
          totpTimeoutRef.current = null;
        }

        if (wasSessionExpiredRef.current) {
          wasSessionExpiredRef.current = false;
          const cols = terminal?.cols || 80;
          const rows = terminal?.rows || 24;
          connectToHost(cols, rows);
          return;
        }

        if (event.code === 1006) {
          console.warn(
            "[WebSocket] Abnormal closure detected - attempting reconnection",
          );
          addLog({
            type: "warning",
            stage: "connection",
            message: t("terminal.websocketAbnormalClose"),
          });

          if (wasConnectedRef.current) {
            attemptReconnection();
          } else {
            updateConnectionError(t("terminal.websocketAbnormalClose"));
            setIsConnecting(false);
          }
          return;
        }

        if (event.code === 1008) {
          console.error("WebSocket authentication failed:", event.reason);
          addLog({
            type: "error",
            stage: "auth",
            message: "Authentication failed - please re-login",
          });
          updateConnectionError("Authentication failed - please re-login");
          setIsConnecting(false);
          shouldNotReconnectRef.current = true;

          return;
        }

        if (
          !wasConnectedRef.current &&
          !isAttachingSessionRef.current &&
          event.wasClean &&
          (event.code === 1005 || event.code === 1000)
        ) {
          console.error("[WebSocket] Connection rejected by server");
          addLog({
            type: "error",
            stage: "connection",
            message: t("terminal.connectionRejected"),
          });
          updateConnectionError(t("terminal.connectionRejected"));
          setIsConnecting(false);
          shouldNotReconnectRef.current = true;
          return;
        }

        const shouldAttemptReconnection =
          !wasDisconnectedBySSH.current &&
          !isUnmountingRef.current &&
          !shouldNotReconnectRef.current &&
          !isConnectingRef.current;

        if (shouldAttemptReconnection) {
          wasDisconnectedBySSH.current = false;
          attemptReconnection();
        } else {
          setIsConnecting(false);
        }
      });

      ws.addEventListener("error", (event) => {
        if (!isCurrentConnection()) {
          return;
        }
        cancelStartupAutomation(ws);
        settlePinRequest(false, ws);

        console.error("[WebSocket] Error:", event);

        setIsConnected(false);
        isConnectingRef.current = false;
        updateConnectionError(t("terminal.websocketError"));
        if (terminal) {
          terminal.clear();
        }
        setIsConnecting(false);

        if (pingIntervalRef.current) {
          clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = null;
        }

        if (totpTimeoutRef.current) {
          clearTimeout(totpTimeoutRef.current);
          totpTimeoutRef.current = null;
        }
      });
    }

    async function writeTextToClipboard(text: string): Promise<boolean> {
      const ok = await copyToClipboard(text);
      if (!ok) toast.error(t("terminal.clipboardWriteFailed"));
      return ok;
    }

    async function readTextFromClipboard(): Promise<string> {
      try {
        if (window.electronClipboard) {
          return window.electronClipboard.readText();
        }
        if (navigator.clipboard && navigator.clipboard.readText) {
          return await navigator.clipboard.readText();
        }
      } catch {
        // fall through
      }
      if (window.location.protocol !== "https:" && !isElectron()) {
        toast.error(t("terminal.clipboardHttpWarning"));
      }
      return "";
    }

    const handleSelectCommand = useCallback(
      (command: string) => {
        if (!terminal || !webSocketRef.current) return;

        for (const char of command) {
          sendTerminalInput(char);
        }

        setTimeout(() => {
          terminal.focus();
        }, 100);
      },
      [terminal],
    );

    useEffect(() => {
      commandHistoryContext.setOnSelectCommand(handleSelectCommand);
    }, [handleSelectCommand]);

    const handleAutocompleteSelect = useCallback(
      (selectedCommand: string) => {
        if (!webSocketRef.current) return;

        const currentCmd = currentAutocompleteCommand.current;
        const completion = selectedCommand.substring(currentCmd.length);

        for (const char of completion) {
          sendTerminalInput(char);
        }

        updateCurrentCommand(selectedCommand);

        setShowAutocomplete(false);
        setAutocompleteSuggestions([]);
        currentAutocompleteCommand.current = "";

        setTimeout(() => {
          terminal?.focus();
        }, 50);
      },
      [terminal, updateCurrentCommand],
    );

    const handleDeleteCommand = useCallback(
      async (command: string) => {
        if (!hostConfig.id) return;

        try {
          await deleteCommandFromHistory(hostConfig.id, command);

          setCommandHistory((prev) => {
            const newHistory = prev.filter((cmd) => cmd !== command);
            setCommandHistoryContextRef.current(newHistory);
            return newHistory;
          });

          autocompleteHistory.current = autocompleteHistory.current.filter(
            (cmd) => cmd !== command,
          );
        } catch (error) {
          console.error("Failed to delete command from history:", error);
        }
      },
      [hostConfig.id],
    );

    useEffect(() => {
      commandHistoryContext.setOnDeleteCommand(handleDeleteCommand);
    }, [handleDeleteCommand]);

    // Separate theme and options updates to avoid terminal re-initialization flashes
    useEffect(() => {
      if (!terminal) return;

      const config = {
        ...DEFAULT_TERMINAL_CONFIG,
        ...hostConfig.terminalConfig,
        theme: resolveEffectiveTerminalTheme(
          savedTheme ?? hostConfig.terminalConfig?.theme,
          terminalDefaultTheme,
        ),
      };

      const activeTheme = previewTheme || config.theme;
      const themeColors = resolveTermixThemeColors(
        activeTheme,
        appTheme,
        config.customThemeColors,
      );

      const fontConfig = TERMINAL_FONTS.find(
        (f) => f.value === config.fontFamily,
      );
      const fontFamily = fontConfig?.fallback || TERMINAL_FONTS[0].fallback;
      ensureTerminalFontsLoaded(fontConfig?.value || TERMINAL_FONTS[0].value);

      // Update terminal options individually to avoid re-initialization flashes
      terminal.options.cursorBlink = config.cursorBlink;
      terminal.options.cursorStyle = config.cursorStyle;
      terminal.options.scrollback = config.scrollback;
      terminal.options.fontSize = config.fontSize;
      terminalFontSizeRef.current = config.fontSize;
      terminal.options.fontFamily = fontFamily;
      terminal.options.rightClickSelectsWord = config.rightClickSelectsWord;
      terminal.options.fastScrollSensitivity = config.fastScrollSensitivity;
      terminal.options.minimumContrastRatio = config.minimumContrastRatio;
      terminal.options.letterSpacing = config.letterSpacing;
      terminal.options.lineHeight = config.lineHeight;
      terminal.options.bellStyle = config.bellStyle as
        | "none"
        | "sound"
        | "visual"
        | "both";

      terminal.options.theme = {
        background: config.backgroundImage
          ? "transparent"
          : themeColors.background,
        foreground: themeColors.foreground,
        cursor: themeColors.cursor,
        cursorAccent: themeColors.cursorAccent,
        selectionBackground: themeColors.selectionBackground,
        selectionForeground: themeColors.selectionForeground,
        black: themeColors.black,
        red: themeColors.red,
        green: themeColors.green,
        yellow: themeColors.yellow,
        blue: themeColors.blue,
        magenta: themeColors.magenta,
        cyan: themeColors.cyan,
        white: themeColors.white,
        brightBlack: themeColors.brightBlack,
        brightRed: themeColors.brightRed,
        brightGreen: themeColors.brightGreen,
        brightYellow: themeColors.brightYellow,
        brightBlue: themeColors.brightBlue,
        brightMagenta: themeColors.brightMagenta,
        brightCyan: themeColors.brightCyan,
        brightWhite: themeColors.brightWhite,
      };

      // Ensure terminal is correctly fitted if font-related options change
      if (fitAddonRef.current && isFitted) {
        performFit();
      }

      // Refresh terminal to apply new theme colors to existing buffer content
      hardRefresh();
    }, [
      terminal,
      hostConfig.terminalConfig,
      previewTheme,
      appTheme,
      isFitted,
      savedTheme,
      terminalDefaultTheme,
    ]);

    useEffect(() => {
      if (!terminal || !xtermRef.current) return;

      const config = {
        ...DEFAULT_TERMINAL_CONFIG,
        ...hostConfig.terminalConfig,
        theme: resolveEffectiveTerminalTheme(
          savedTheme ?? hostConfig.terminalConfig?.theme,
          terminalDefaultTheme,
        ),
      };

      const fontConfig = TERMINAL_FONTS.find(
        (f) => f.value === config.fontFamily,
      );
      const fontFamily = fontConfig?.fallback || TERMINAL_FONTS[0].fallback;
      ensureTerminalFontsLoaded(fontConfig?.value || TERMINAL_FONTS[0].value);

      const activeTheme = previewTheme || config.theme;
      const themeColors = resolveTermixThemeColors(
        activeTheme,
        appTheme,
        config.customThemeColors,
      );

      // Set initial options before opening the terminal
      terminal.options = {
        cursorBlink: config.cursorBlink,
        cursorStyle: config.cursorStyle,
        scrollback: config.scrollback,
        fontSize: config.fontSize,
        fontFamily,
        allowTransparency: true, // MUST be set before open()
        convertEol: false,
        macOptionIsMeta: true,
        macOptionClickForcesSelection: false,
        rightClickSelectsWord: config.rightClickSelectsWord,
        fastScrollSensitivity: config.fastScrollSensitivity,
        allowProposedApi: true,
        minimumContrastRatio: config.minimumContrastRatio,
        letterSpacing: config.letterSpacing,
        lineHeight: config.lineHeight,
        bellStyle: config.bellStyle as "none" | "sound" | "visual" | "both",
        theme: {
          background: config.backgroundImage
            ? "transparent"
            : themeColors.background,
          foreground: themeColors.foreground,
          cursor: themeColors.cursor,
          cursorAccent: themeColors.cursorAccent,
          selectionBackground: themeColors.selectionBackground,
          selectionForeground: themeColors.selectionForeground,
          black: themeColors.black,
          red: themeColors.red,
          green: themeColors.green,
          yellow: themeColors.yellow,
          blue: themeColors.blue,
          magenta: themeColors.magenta,
          cyan: themeColors.cyan,
          white: themeColors.white,
          brightBlack: themeColors.brightBlack,
          brightRed: themeColors.brightRed,
          brightGreen: themeColors.brightGreen,
          brightYellow: themeColors.brightYellow,
          brightBlue: themeColors.brightBlue,
          brightMagenta: themeColors.brightMagenta,
          brightCyan: themeColors.brightCyan,
          brightWhite: themeColors.brightWhite,
        },
      };

      const fitAddon = new FitAddon();
      const clipboardProvider = new RobustClipboardProvider();
      const clipboardAddon = new ClipboardAddon(undefined, clipboardProvider);
      const unicode11Addon = new Unicode11Addon();
      const webLinksAddon = new WebLinksAddon((_event, uri) => {
        const url =
          uri.startsWith("http://") || uri.startsWith("https://")
            ? uri
            : `https://${uri}`;

        const hostBehavior = hostConfig.terminalConfig?.linkClickBehavior;
        const globalBehavior =
          localStorage.getItem("terminalLinkClickBehavior") ?? "confirm";
        const behavior = hostBehavior ?? globalBehavior;

        if (behavior === "direct") {
          window.open(url, "_blank");
        } else {
          setLinkClickDialog({ url });
        }
      });

      fitAddonRef.current = fitAddon;
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(clipboardAddon);
      terminal.loadAddon(unicode11Addon);
      terminal.loadAddon(webLinksAddon);

      terminal.unicode.activeVersion = "11";

      terminal.open(xtermRef.current);

      const xtermTextarea = xtermRef.current.querySelector("textarea");
      if (xtermTextarea) {
        xtermTextarea.setAttribute("autocomplete", "off");
        xtermTextarea.setAttribute("autocorrect", "off");
        xtermTextarea.setAttribute("autocapitalize", "none");
        xtermTextarea.setAttribute("spellcheck", "false");
        xtermTextarea.setAttribute("data-gramm", "false");
        xtermTextarea.setAttribute("data-gramm_editor", "false");
        xtermTextarea.setAttribute("data-enable-grammarly", "false");
      }

      terminal.onTitleChange((title) => {
        if (title) onTitleChange?.(title);
      });
      document.fonts.ready.then(() => {
        terminal.refresh(0, terminal.rows - 1);
        fitAddon.fit();
      });

      terminal.attachCustomWheelEventHandler((ev) => {
        if (ev.ctrlKey || ev.metaKey) {
          changeTerminalFontSize(ev.deltaY < 0 ? 1 : -1);
          return false;
        }

        const cfg = {
          ...DEFAULT_TERMINAL_CONFIG,
          ...hostConfig.terminalConfig,
        };
        const mod = cfg.fastScrollModifier;
        const modHeld =
          (mod === "alt" && ev.altKey) ||
          (mod === "ctrl" && ev.ctrlKey) ||
          (mod === "shift" && ev.shiftKey);
        if (modHeld) {
          const lines = Math.round(
            (Math.abs(ev.deltaY) / 100) * (cfg.fastScrollSensitivity ?? 5),
          );
          terminal.scrollLines(ev.deltaY > 0 ? lines : -lines);
          return false;
        }
        return true;
      });

      fitAddonRef.current?.fit();
      // Double-rAF ensures layout is fully settled (fonts, flexbox, etc.) before
      // committing the fitted size, preventing the "terminal too short" glitch.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          fitAddonRef.current?.fit();
          setIsFitted(true);
        });
      });

      const element = xtermRef.current;
      const handleContextMenu = (e: MouseEvent) => {
        if (e.ctrlKey && onOpenFileManager) {
          e.preventDefault();
          e.stopPropagation();
          onOpenFileManager();
          return;
        }

        if (getUseRightClickCopyPaste()) {
          e.preventDefault();
          e.stopPropagation();
          if (terminal.hasSelection()) {
            const text = terminal.getSelection();
            writeTextToClipboard(text).then(() => terminal.clearSelection());
          } else {
            readTextFromClipboard().then((text) => {
              if (text && !isTerminalInputBlocked()) terminal.paste(text);
            });
          }
          return;
        }
      };
      element?.addEventListener("contextmenu", handleContextMenu);

      const handlePaste = (e: ClipboardEvent) => {
        if (isTerminalInputBlocked()) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        const text = e.clipboardData?.getData("text");
        if (text) {
          e.preventDefault();
          e.stopPropagation();
          terminal.paste(text);
        }
      };
      element?.addEventListener("paste", handlePaste);

      let tmuxDragTracking = false;
      const handleTmuxDragStart = (e: MouseEvent) => {
        if (e.button !== 0) return;
        if (!tmuxSessionNameRef.current) return;
        tmuxDragTracking = true;
      };
      const handleTmuxDragMove = () => {
        if (!tmuxDragTracking) return;
        tmuxDragTracking = false;
        if (tmuxCopyModeHintShownRef.current) return;
        tmuxCopyModeHintShownRef.current = true;
        toast.info(t("terminal.tmuxCopyHint"), { duration: 5000 });
      };
      const handleTmuxDragEnd = () => {
        tmuxDragTracking = false;
      };
      element?.addEventListener("mousedown", handleTmuxDragStart);
      element?.addEventListener("mousemove", handleTmuxDragMove);
      element?.addEventListener("mouseup", handleTmuxDragEnd);

      const handleBackspaceMode = (e: KeyboardEvent) => {
        if (e.key !== "Backspace") return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;

        const config = {
          ...DEFAULT_TERMINAL_CONFIG,
          ...hostConfig.terminalConfig,
        };
        if (config.backspaceMode !== "control-h") return;

        e.preventDefault();
        e.stopPropagation();

        sendTerminalInput("\x08");
        return false;
      };

      // On macOS Electron, Tab key events can be swallowed by Chromium's focus
      // traversal system before xterm.js sees them. Calling preventDefault() in
      // the capture phase blocks that traversal while still allowing the event to
      // reach xterm.js's internal handler (which fires our attachCustomKeyEventHandler).
      const handleTabCapture = (e: KeyboardEvent) => {
        if (e.key === "Tab") {
          e.preventDefault();
        }
      };

      element?.addEventListener("keydown", handleBackspaceMode, true);
      element?.addEventListener("keydown", handleTabCapture, true);

      const resizeObserver = new ResizeObserver(() => {
        // Background keep-alive tabs still observe layout; skip fit work.
        if (!isVisibleRef.current) return;
        if (resizeTimeout.current) clearTimeout(resizeTimeout.current);
        resizeTimeout.current = setTimeout(() => {
          if (isVisibleRef.current) {
            performFit();
          }
        }, 50);
      });

      const observeTarget = xtermRef.current.parentElement ?? xtermRef.current;
      resizeObserver.observe(observeTarget);

      return () => {
        isFittingRef.current = false;
        resizeObserver.disconnect();
        clipboardProvider.dispose();
        element?.removeEventListener("contextmenu", handleContextMenu);
        element?.removeEventListener("paste", handlePaste);
        element?.removeEventListener("mousedown", handleTmuxDragStart);
        element?.removeEventListener("mousemove", handleTmuxDragMove);
        element?.removeEventListener("mouseup", handleTmuxDragEnd);
        element?.removeEventListener("keydown", handleBackspaceMode, true);
        element?.removeEventListener("keydown", handleTabCapture, true);
        if (notifyTimerRef.current) clearTimeout(notifyTimerRef.current);
        if (resizeTimeout.current) clearTimeout(resizeTimeout.current);
      };
    }, [xtermRef, terminal]);

    const isMountedRef = useRef(false);

    useEffect(
      () => () => {
        terminalInputDisposableRef.current?.dispose();
        terminalInputDisposableRef.current = null;
      },
      [],
    );

    useEffect(() => {
      isMountedRef.current = true;

      const currentHostId = hostConfig.id;
      return () => {
        if (!isMountedRef.current) {
          return;
        }

        if (
          currentHostIdRef.current !== currentHostId &&
          currentHostIdRef.current !== null
        ) {
          isUnmountingRef.current = true;
          shouldNotReconnectRef.current = true;
          isReconnectingRef.current = false;
          setIsConnecting(false);
          if (reconnectTimeoutRef.current)
            clearTimeout(reconnectTimeoutRef.current);
          if (connectionTimeoutRef.current)
            clearTimeout(connectionTimeoutRef.current);
          if (totpTimeoutRef.current) clearTimeout(totpTimeoutRef.current);
          if (pingIntervalRef.current) {
            clearInterval(pingIntervalRef.current);
            pingIntervalRef.current = null;
          }
          if (pongTimeoutRef.current) {
            clearTimeout(pongTimeoutRef.current);
            pongTimeoutRef.current = null;
          }

          if (webSocketRef.current) {
            webSocketRef.current.close();
          }

          isMountedRef.current = false;
        }
      };
    }, [hostConfig.id, hostConfig.instanceId]);

    useEffect(() => {
      let cancelled = false;
      const loadKeybindings = () => {
        cachedSnippetsRef.current = null;
        getUserPreferences()
          .then((prefs) => {
            if (!cancelled) {
              customKeybindingsRef.current = parseCustomKeybindings(
                prefs.customKeybindings,
              ).filter((kb) => kb.enabled);
            }
          })
          .catch(() => {
            // keep previous/empty bindings on failure, non-fatal
          });
      };
      loadKeybindings();
      window.addEventListener("customKeybindingsChanged", loadKeybindings);
      return () => {
        cancelled = true;
        window.removeEventListener("customKeybindingsChanged", loadKeybindings);
      };
    }, []);

    useEffect(() => {
      if (!terminal) return;

      const getSnippetById = async (
        id: string,
      ): Promise<{ content: string } | undefined> => {
        try {
          if (!cachedSnippetsRef.current) {
            cachedSnippetsRef.current = (await getSnippets()) as unknown as {
              id: number;
              content: string;
            }[];
          }
          const numericId = Number(id);
          return cachedSnippetsRef.current?.find((s) => s.id === numericId);
        } catch {
          return undefined;
        }
      };

      const handleCustomKey = (e: KeyboardEvent): boolean => {
        if (e.type !== "keydown") {
          return true;
        }

        // 固定/切换会话等临界操作期间，所有可能写入远端的快捷键统一门禁。
        // 复制类快捷键仍可通过终端选择工具完成，避免绕过输入锁造成半条命令写入。
        if (isTerminalInputBlocked()) {
          e.preventDefault();
          e.stopPropagation();
          return false;
        }

        // Custom user keybindings take priority over built-in defaults, but
        // never override autocomplete popup navigation while it is open.
        if (!showAutocompleteRef.current) {
          const matched = findMatchingKeybinding(
            e,
            customKeybindingsRef.current,
          );
          if (matched) {
            e.preventDefault();
            e.stopPropagation();
            dispatchKeybindingAction(matched.action, {
              terminal,
              webSocketRef,
              writeTextToClipboard,
              readTextFromClipboard,
              getSnippetById,
            });
            return false;
          }
        }

        // Forward global app shortcuts to AppShell directly — xterm swallows
        // all keydown events and synthetic re-dispatch is unreliable.
        // stopPropagation prevents the same event from also firing the window listener.
        if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
          const globalCodes = [
            "BracketRight",
            "BracketLeft",
            "Backslash",
            "Minus",
          ];
          if (globalCodes.includes(e.code)) {
            e.stopPropagation();
            globalShortcutHandler.current?.(e);
            return false;
          }
        }

        if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
          const arrowCodes = [
            "ArrowLeft",
            "ArrowRight",
            "ArrowUp",
            "ArrowDown",
          ];
          if (arrowCodes.includes(e.code)) {
            e.stopPropagation();
            globalShortcutHandler.current?.(e);
            return false;
          }
        }

        const fontZoomDirection = getTerminalFontZoomDirection(e);
        if (fontZoomDirection !== 0) {
          e.preventDefault();
          e.stopPropagation();
          changeTerminalFontSize(fontZoomDirection);
          return false;
        }

        if (
          e.ctrlKey &&
          !e.shiftKey &&
          !e.altKey &&
          !e.metaKey &&
          e.key.toLowerCase() === "c" &&
          terminal.hasSelection()
        ) {
          const selection = terminal.getSelection();
          if (selection) {
            e.preventDefault();
            e.stopPropagation();
            writeTextToClipboard(selection);
            terminal.clearSelection();
            return false;
          }
        }

        if (
          ((e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey) ||
            (e.ctrlKey &&
              !e.shiftKey &&
              !e.altKey &&
              !e.metaKey &&
              e.key === "Insert")) &&
          (e.key.toLowerCase() === "c" || e.key === "Insert")
        ) {
          const selection = terminal.getSelection();
          if (selection) {
            e.preventDefault();
            e.stopPropagation();
            writeTextToClipboard(selection);
            return false;
          }
        }

        if (
          e.ctrlKey &&
          e.shiftKey &&
          !e.altKey &&
          !e.metaKey &&
          e.key.toLowerCase() === "c"
        ) {
          const selection = terminal.getSelection();
          if (selection) {
            e.preventDefault();
            e.stopPropagation();
            writeTextToClipboard(selection);
            terminal.clearSelection();
            return false;
          }
        }

        if (
          e.ctrlKey &&
          e.shiftKey &&
          !e.altKey &&
          !e.metaKey &&
          e.key.toLowerCase() === "v"
        ) {
          e.preventDefault();
          e.stopPropagation();
          readTextFromClipboard().then((text) => {
            if (text && !isTerminalInputBlocked()) terminal.paste(text);
          });
          return false;
        }

        if (
          e.ctrlKey &&
          !e.shiftKey &&
          !e.altKey &&
          !e.metaKey &&
          e.key.toLowerCase() === "v"
        ) {
          // Let the browser handle Ctrl+V natively, the paste event
          // listener will intercept the result without triggering the
          // clipboard permission popup
          return false;
        }

        if (e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey) {
          const key = e.key.toLowerCase();
          const blockedKeys = ["w", "t", "n", "q"];
          if (blockedKeys.includes(key)) {
            e.preventDefault();
            e.stopPropagation();
            const ctrlCode = key.charCodeAt(0) - 96;
            sendTerminalInput(String.fromCharCode(ctrlCode));
            return false;
          }
        }

        if (showAutocompleteRef.current) {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setShowAutocomplete(false);
            setAutocompleteSuggestions([]);
            currentAutocompleteCommand.current = "";
            return false;
          }

          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation();

            const currentIndex = autocompleteSelectedIndexRef.current;
            const suggestionsLength = autocompleteSuggestionsRef.current.length;

            if (e.key === "ArrowDown") {
              const newIndex =
                currentIndex < suggestionsLength - 1 ? currentIndex + 1 : 0;
              setAutocompleteSelectedIndex(newIndex);
            } else if (e.key === "ArrowUp") {
              const newIndex =
                currentIndex > 0 ? currentIndex - 1 : suggestionsLength - 1;
              setAutocompleteSelectedIndex(newIndex);
            }
            return false;
          }

          if (
            e.key === "Enter" &&
            autocompleteSuggestionsRef.current.length > 0
          ) {
            e.preventDefault();
            e.stopPropagation();

            const selectedCommand =
              autocompleteSuggestionsRef.current[
                autocompleteSelectedIndexRef.current
              ];
            const currentCmd = currentAutocompleteCommand.current;
            const completion = selectedCommand.substring(currentCmd.length);

            for (const char of completion) sendTerminalInput(char);

            updateCurrentCommandRef.current(selectedCommand);

            setShowAutocomplete(false);
            setAutocompleteSuggestions([]);
            currentAutocompleteCommand.current = "";

            return false;
          }

          if (
            e.key === "Tab" &&
            !e.ctrlKey &&
            !e.altKey &&
            !e.metaKey &&
            !e.shiftKey
          ) {
            e.preventDefault();
            e.stopPropagation();
            const currentIndex = autocompleteSelectedIndexRef.current;
            const suggestionsLength = autocompleteSuggestionsRef.current.length;
            const newIndex =
              currentIndex < suggestionsLength - 1 ? currentIndex + 1 : 0;
            setAutocompleteSelectedIndex(newIndex);
            return false;
          }

          setShowAutocomplete(false);
          setAutocompleteSuggestions([]);
          currentAutocompleteCommand.current = "";
          return true;
        }

        if (
          e.key === "Tab" &&
          e.shiftKey &&
          !e.ctrlKey &&
          !e.altKey &&
          !e.metaKey
        ) {
          e.preventDefault();
          e.stopPropagation();
          if (webSocketRef.current?.readyState === 1) {
            sendTerminalInput("\x1b[Z");
          }
          return false;
        }

        if (
          e.key === "Tab" &&
          !e.ctrlKey &&
          !e.altKey &&
          !e.metaKey &&
          !e.shiftKey
        ) {
          e.preventDefault();
          e.stopPropagation();

          const sendTabToShell = () => sendTerminalInput("\t");

          const autocompleteEnabled =
            localStorage.getItem("commandAutocomplete") === "true";

          if (!autocompleteEnabled) {
            sendTabToShell();
            return false;
          }

          const currentCmd = getCurrentCommandRef.current().trim();
          if (currentCmd.length === 0) {
            sendTabToShell();
            return false;
          }

          if (webSocketRef.current?.readyState === 1) {
            const matches = autocompleteHistory.current
              .filter(
                (cmd) =>
                  cmd.startsWith(currentCmd) &&
                  cmd !== currentCmd &&
                  cmd.length > currentCmd.length,
              )
              .slice(0, 5);

            if (matches.length === 1) {
              const completedCommand = matches[0];
              const completion = completedCommand.substring(currentCmd.length);

              for (const char of completion) sendTerminalInput(char);

              updateCurrentCommandRef.current(completedCommand);
            } else if (matches.length > 1) {
              currentAutocompleteCommand.current = currentCmd;
              setAutocompleteSuggestions(matches);
              setAutocompleteSelectedIndex(0);

              const cursorY = terminal.buffer.active.cursorY;
              const cursorX = terminal.buffer.active.cursorX;
              const rect = xtermRef.current?.getBoundingClientRect();

              if (rect) {
                const cellHeight =
                  terminal.rows > 0 ? rect.height / terminal.rows : 20;
                const cellWidth =
                  terminal.cols > 0 ? rect.width / terminal.cols : 10;

                const itemHeight = 32;
                const footerHeight = 32;
                const maxMenuHeight = 240;
                const estimatedMenuHeight = Math.min(
                  matches.length * itemHeight + footerHeight,
                  maxMenuHeight,
                );
                const cursorBottomY = rect.top + (cursorY + 1) * cellHeight;
                const cursorTopY = rect.top + cursorY * cellHeight;
                const spaceBelow = window.innerHeight - cursorBottomY;
                const spaceAbove = cursorTopY;

                const showAbove =
                  spaceBelow < estimatedMenuHeight && spaceAbove > spaceBelow;

                setAutocompletePosition({
                  top: showAbove
                    ? Math.max(0, cursorTopY - estimatedMenuHeight)
                    : cursorBottomY,
                  left: Math.max(0, rect.left + cursorX * cellWidth),
                });
              }

              setShowAutocomplete(true);
            } else {
              sendTabToShell();
            }
          }
          return false;
        }

        return true;
      };

      terminal.attachCustomKeyEventHandler(handleCustomKey);
    }, [terminal]);

    useEffect(() => {
      if (!terminal || !hostConfig || !isVisible) return;
      if (isConnected || isConnecting) return;

      if (isReconnectingRef.current || reconnectTimeoutRef.current !== null) {
        return;
      }

      if (shouldNotReconnectRef.current) {
        return;
      }

      if (
        webSocketRef.current &&
        (webSocketRef.current.readyState === WebSocket.OPEN ||
          webSocketRef.current.readyState === WebSocket.CONNECTING)
      ) {
        return;
      }

      setIsConnecting(true);
      fitAddonRef.current?.fit();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          fitAddonRef.current?.fit();
          if (terminal.cols > 0 && terminal.rows > 0) {
            scheduleNotify(terminal.cols, terminal.rows);
            connectToHost(terminal.cols, terminal.rows);
          }
        });
      });
    }, [terminal, hostConfig.id, isVisible, isConnected, isConnecting]);

    useEffect(() => {
      if (!terminal || !fitAddonRef.current) return;

      if (!isVisible) {
        lastFittedSizeRef.current = null;
        lastSentSizeRef.current = null;
        return;
      }

      const fitTimeoutId = setTimeout(() => {
        if (!isFittingRef.current && terminal.cols > 0 && terminal.rows > 0) {
          performFit();
          if (!splitScreen && !isConnecting && !disableAutoFocus) {
            requestAnimationFrame(() => terminal.focus());
          }
        }
      }, 50);

      return () => clearTimeout(fitTimeoutId);
    }, [terminal, isVisible, splitScreen, isConnecting]);

    const markAgentAccessRequesting = useCallback(() => {
      agentAccessModeRef.current = "requesting";
      agentInputBlockedRef.current = true;
      setAgentAccessMode("requesting");
      syncTerminalInputState();
      window.setTimeout(() => {
        if (agentAccessModeRef.current !== "requesting") return;
        applyAgentAccessMode("read-only");
        toast.error(t("terminal.agentAccessTimeout"));
      }, 10_000);
    }, [applyAgentAccessMode, syncTerminalInputState, t]);

    const requestAgentWriteAccess = useCallback(() => {
      void confirmWithToast(
        {
          title: t("terminal.agentTakeoverTitle"),
          description: t("terminal.agentTakeoverDescription"),
          confirmText: t("terminal.agentTakeoverConfirm"),
          cancelText: t("common.cancel"),
        },
        () => {
          const socket = webSocketRef.current;
          if (!socket || socket.readyState !== WebSocket.OPEN) {
            toast.error(t("terminal.agentAccessFailed"));
            return;
          }
          markAgentAccessRequesting();
          socket.send(JSON.stringify({ type: "requestAgentWriteAccess" }));
        },
      );
    }, [confirmWithToast, markAgentAccessRequesting, t]);

    const releaseAgentWriteAccess = useCallback(() => {
      const socket = webSocketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      markAgentAccessRequesting();
      socket.send(JSON.stringify({ type: "releaseAgentWriteAccess" }));
    }, [markAgentAccessRequesting]);

    const hasConnectionError = !!connectionError;

    return (
      <div
        className="h-full w-full relative"
        style={{
          backgroundColor: backgroundImage ? "transparent" : backgroundColor,
          ...(backgroundImage && {
            backgroundImage: `url(${backgroundImage})`,
            backgroundSize: "cover",
            backgroundPosition: "center",
            backgroundRepeat: "no-repeat",
          }),
        }}
      >
        {backgroundImage && (
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              backgroundColor: themeColors.background,
              opacity: 1 - backgroundImageOpacity,
            }}
          />
        )}
        <div
          ref={xtermRef}
          className="h-full w-full relative"
          style={{
            pointerEvents: isVisible ? "auto" : "none",
            visibility:
              isConnected && isFitted && !connectionError
                ? "visible"
                : "hidden",
          }}
          onClick={() => {
            if (terminal && !splitScreen) {
              terminal.focus();
            }
          }}
        />

        {hostConfig.agentSessionId && isConnected && agentAccessMode && (
          <div className="absolute left-2 top-2 z-[110] flex max-w-[calc(100%-1rem)] items-center gap-2 rounded border border-violet-400/30 bg-black/75 px-2 py-1 text-white shadow-lg backdrop-blur-sm">
            {agentAccessMode === "read-write" ? (
              <Bot className="size-3.5 shrink-0 text-violet-300" />
            ) : (
              <LockKeyhole className="size-3.5 shrink-0 text-violet-300" />
            )}
            <span className="truncate text-[11px] text-white/80">
              {agentAccessMode === "read-write"
                ? t("terminal.agentWriteAccess")
                : agentAccessMode === "requesting"
                  ? t("terminal.agentAccessRequesting")
                  : t("terminal.agentReadOnly")}
            </span>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={agentAccessMode === "requesting"}
              onClick={
                agentAccessMode === "read-write"
                  ? releaseAgentWriteAccess
                  : requestAgentWriteAccess
              }
              className="h-6 shrink-0 px-2 text-[10px]"
            >
              {agentAccessMode === "read-write"
                ? t("terminal.agentReleaseWriteAccess")
                : t("terminal.agentTakeover")}
            </Button>
          </div>
        )}

        {isTmuxAttached && isConnected && !isManagedTmux && (
          <button
            onClick={() => {
              if (webSocketRef.current?.readyState === WebSocket.OPEN) {
                webSocketRef.current.send(
                  JSON.stringify({ type: "tmux_detach" }),
                );
              }
            }}
            title={t("terminal.tmuxDetach")}
            className="absolute top-2 right-2 z-[110] px-2 py-1 text-xs rounded bg-black/60 text-white/70 hover:text-white hover:bg-black/80 transition-colors"
          >
            tmux:detach
          </button>
        )}

        {isQuickConnect &&
          isConnected &&
          !isQuickConnectSaved &&
          onSaveQuickConnect && (
            <Button
              size="sm"
              variant="secondary"
              disabled={isSavingQuickConnect}
              onClick={async () => {
                setIsSavingQuickConnect(true);
                try {
                  await onSaveQuickConnect();
                  setIsQuickConnectSaved(true);
                } catch {
                  // The shell reports the failure with a toast.
                } finally {
                  setIsSavingQuickConnect(false);
                }
              }}
              className="absolute top-2 left-2 z-[110] h-7 gap-1.5 bg-black/60 text-white/80 hover:bg-black/80 hover:text-white"
            >
              <Save className="size-3.5" />
              {t("hosts.addHost")}
            </Button>
          )}

        <SimpleLoader
          visible={isConnecting && !isConnectionLogExpanded}
          message={t("terminal.connecting")}
          backgroundColor={backgroundColor}
        />

        {showDisconnectedOverlay && !isConnecting && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 z-[120]"
            style={{ backgroundColor }}
          >
            <p className="text-sm text-muted-foreground">
              {t("terminal.connectionLost")}
            </p>
            <div className="flex gap-2">
              <Button
                onClick={() => {
                  setShowDisconnectedOverlay(false);
                  isUnmountingRef.current = false;
                  shouldNotReconnectRef.current = false;
                  isReconnectingRef.current = false;
                  isConnectingRef.current = false;
                  reconnectAttempts.current = 0;
                  wasDisconnectedBySSH.current = false;
                  wasConnectedRef.current = false;
                  updateConnectionError(null);
                  if (terminal) {
                    terminal.clear();
                    connectToHost(terminal.cols, terminal.rows);
                  }
                }}
              >
                {t("terminal.reconnect")}
              </Button>
              {onClose && (
                <Button variant="outline" onClick={onClose}>
                  {t("terminal.closeTab")}
                </Button>
              )}
            </div>
          </div>
        )}

        <ConnectionLog
          isConnecting={isConnecting}
          isConnected={isConnected}
          hasConnectionError={hasConnectionError && !showDisconnectedOverlay}
          position={hasConnectionError ? "top" : "bottom"}
        />

        <TmuxInstallChoiceDialog
          isOpen={tmuxPinChoice !== null}
          stage={tmuxPinChoice?.stage ?? "mode"}
          pendingMode={tmuxPinChoice?.pendingMode ?? null}
          onUseTmux={() => selectTmuxPinMode("tmux")}
          onInstall={() => selectTmuxPinMode("install_tmux")}
          onPlatformKeepalive={() => selectTmuxPinMode("platform")}
          onCancel={cancelTmuxPinChoice}
        />

        <TOTPDialog
          isOpen={totpRequired}
          prompt={totpPrompt}
          mode={mfaPromptMode}
          waiting={mfaWaiting}
          onSubmit={handleTotpSubmit}
          onCancel={handleTotpCancel}
          backgroundColor={backgroundColor}
        />

        <SSHAuthDialog
          isOpen={showAuthDialog}
          reason={authDialogReason}
          onSubmit={handleAuthDialogSubmit}
          onCancel={handleAuthDialogCancel}
          hostInfo={{
            ip: hostConfig.ip,
            port: hostConfig.port,
            username: hostConfig.username,
            name: hostConfig.name,
          }}
          backgroundColor={backgroundColor}
        />

        <PassphraseDialog
          isOpen={showPassphraseDialog}
          onSubmit={handlePassphraseSubmit}
          onCancel={handlePassphraseCancel}
          hostInfo={{
            ip: hostConfig.ip,
            port: hostConfig.port,
            username: hostConfig.username,
            name: hostConfig.name,
          }}
          backgroundColor={backgroundColor}
        />

        <WarpgateDialog
          isOpen={warpgateAuthRequired}
          url={warpgateAuthUrl}
          securityKey={warpgateSecurityKey}
          onContinue={handleWarpgateContinue}
          onCancel={handleWarpgateCancel}
          onOpenUrl={handleWarpgateOpenUrl}
          backgroundColor={backgroundColor}
        />

        {opksshDialog?.isOpen && (
          <OPKSSHDialog
            isOpen={opksshDialog.isOpen}
            authUrl={opksshDialog.authUrl}
            requestId={opksshDialog.requestId}
            stage={opksshDialog.stage}
            error={opksshDialog.error}
            providers={opksshDialog.providers}
            onCancel={() => {
              if (webSocketRef.current) {
                webSocketRef.current.send(
                  JSON.stringify({
                    type: "opkssh_cancel",
                    data: { requestId: opksshDialog.requestId },
                  }),
                );
              }
              setOpksshDialog(null);
              if (opksshTimeoutRef.current) {
                clearTimeout(opksshTimeoutRef.current);
                opksshTimeoutRef.current = null;
              }
            }}
            onOpenUrl={() => {
              window.open(opksshDialog.authUrl, "_blank");
              if (webSocketRef.current) {
                webSocketRef.current.send(
                  JSON.stringify({
                    type: "opkssh_browser_opened",
                    data: { requestId: opksshDialog.requestId },
                  }),
                );
              }
            }}
            onSelectProvider={(alias) => {
              if (!opksshDialog.authUrl) return;
              const selectUrl = `${opksshDialog.authUrl}/select?op=${encodeURIComponent(alias)}`;
              window.open(selectUrl, "_blank");
              if (webSocketRef.current) {
                webSocketRef.current.send(
                  JSON.stringify({
                    type: "opkssh_browser_opened",
                    data: { requestId: opksshDialog.requestId },
                  }),
                );
              }
              setOpksshDialog((prev) =>
                prev ? { ...prev, stage: "waiting" } : null,
              );
            }}
            backgroundColor={backgroundColor}
          />
        )}

        {vaultDialog && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60">
            <div className="w-[420px] max-w-[90%] border border-border bg-background p-5 shadow-lg">
              <h3 className="text-sm font-bold mb-2 text-foreground">
                {vaultDialog.stage === "error"
                  ? t("terminal.vaultAuthFailed")
                  : t("terminal.vaultAuthTitle")}
              </h3>
              {vaultDialog.stage === "error" ? (
                <p className="text-xs text-destructive mb-4 break-words">
                  {vaultDialog.error || t("terminal.vaultAuthFailed")}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground mb-4">
                  {t("terminal.vaultAuthDescription")}
                </p>
              )}
              <div className="flex justify-end gap-2">
                {vaultDialog.stage === "waiting" && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      try {
                        vaultPopupRef.current?.focus();
                      } catch {
                        // popup may be gone
                      }
                    }}
                  >
                    {t("terminal.vaultReopen")}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (vaultTimeoutRef.current) {
                      clearTimeout(vaultTimeoutRef.current);
                      vaultTimeoutRef.current = null;
                    }
                    try {
                      vaultPopupRef.current?.close();
                    } catch {
                      // popup may already be closed
                    }
                    webSocketRef.current?.send(
                      JSON.stringify({
                        type: "vault_cancel",
                        data: { hostId: currentHostIdRef.current },
                      }),
                    );
                    setVaultDialog(null);
                  }}
                >
                  {vaultDialog.stage === "error"
                    ? t("common.close")
                    : t("hosts.cancelBtn")}
                </Button>
              </div>
            </div>
          </div>
        )}

        {hostKeyVerification?.isOpen && (
          <HostKeyVerificationDialog
            isOpen={true}
            scenario={hostKeyVerification.scenario}
            {...hostKeyVerification.data}
            onAccept={() => {
              if (webSocketRef.current) {
                webSocketRef.current.send(
                  JSON.stringify({
                    type: "host_key_verification_response",
                    data: { action: "accept" },
                  }),
                );
              }
              setHostKeyVerification(null);
            }}
            onReject={() => {
              if (webSocketRef.current) {
                webSocketRef.current.send(
                  JSON.stringify({
                    type: "host_key_verification_response",
                    data: { action: "reject" },
                  }),
                );
              }
              setHostKeyVerification(null);
              setIsConnecting(false);
              updateConnectionError(t("terminal.hostKeyRejected"));
            }}
            backgroundColor={backgroundColor}
          />
        )}

        {tmuxSessionPicker && (
          <TmuxSessionPicker
            isOpen={true}
            sessions={tmuxSessionPicker.sessions}
            onSelect={(sessionName) => {
              setTmuxSessionPicker(null);
              if (webSocketRef.current?.readyState === WebSocket.OPEN) {
                webSocketRef.current.send(
                  JSON.stringify({
                    type: "tmux_attach",
                    data: { sessionName },
                  }),
                );
              }
              setTimeout(() => terminal?.focus(), 50);
            }}
            onCreateNew={() => {
              setTmuxSessionPicker(null);
              if (webSocketRef.current?.readyState === WebSocket.OPEN) {
                webSocketRef.current.send(
                  JSON.stringify({
                    type: "tmux_attach",
                    data: { sessionName: "" },
                  }),
                );
              }
              setTimeout(() => terminal?.focus(), 50);
            }}
            onCancel={() => setTmuxSessionPicker(null)}
            backgroundColor={backgroundColor}
          />
        )}

        <CommandAutocomplete
          visible={showAutocomplete}
          suggestions={autocompleteSuggestions}
          selectedIndex={autocompleteSelectedIndex}
          position={autocompletePosition}
          onSelect={handleAutocompleteSelect}
        />

        {linkClickDialog &&
          createPortal(
            <div
              className="fixed inset-0 flex items-center justify-center z-[10000]"
              style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
              onClick={() => setLinkClickDialog(null)}
            >
              <div
                className="flex flex-col gap-3 p-4 rounded shadow-lg max-w-sm w-full mx-4"
                style={{ backgroundColor }}
                onClick={(event) => event.stopPropagation()}
              >
                <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
                  {t("terminal.linkDialogTitle")}
                </p>
                <p className="text-sm break-all text-foreground select-all">
                  {linkClickDialog.url}
                </p>
                <div className="flex gap-2 justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      writeTextToClipboard(linkClickDialog.url);
                      setLinkClickDialog(null);
                    }}
                  >
                    {t("terminal.linkDialogCopy")}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => {
                      window.open(
                        linkClickDialog.url,
                        "_blank",
                        "noopener,noreferrer",
                      );
                      setLinkClickDialog(null);
                    }}
                  >
                    {t("terminal.linkDialogOpen")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setLinkClickDialog(null)}
                  >
                    {t("common.cancel")}
                  </Button>
                </div>
              </div>
            </div>,
            document.body,
          )}

        {shareModalOpen && typeof hostConfig.id === "number" && (
          <ShareSessionModal
            open={shareModalOpen}
            onClose={() => setShareModalOpen(false)}
            hostId={hostConfig.id}
            sessionId={sessionIdRef.current}
            protocol="ssh"
            tabInstanceId={hostConfig.instanceId}
          />
        )}
      </div>
    );
  },
);

export const Terminal = forwardRef<TerminalHandle, SSHTerminalProps>(
  function Terminal(props, ref) {
    return (
      <ConnectionLogProvider>
        <TerminalInner {...props} ref={ref} />
      </ConnectionLogProvider>
    );
  },
);
