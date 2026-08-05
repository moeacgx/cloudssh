import type { Client, ClientChannel } from "ssh2";
import { sshLogger } from "../../utils/logger.js";

export interface TmuxSessionInfo {
  name: string;
  created: number;
  lastActivity: number;
  windows: number;
  attachedClients: number;
}

export interface TmuxDetectionResult {
  available: boolean;
  sessions: TmuxSessionInfo[];
}

export type TmuxSessionProbeResult = "found" | "missing" | "unknown";

export type TmuxAttachedClientsProbeResult = number | null;

export type TmuxPackageManager = "apt-get" | "dnf" | "yum" | "apk" | "zypper";

export type TmuxInstallPrivilege = "root" | "sudo";

export type TmuxInstallResult =
  | {
      status: "already_installed";
      packageManager: null;
      privilege: null;
    }
  | {
      status: "installed";
      packageManager: TmuxPackageManager;
      privilege: TmuxInstallPrivilege;
    }
  | {
      status: "unsupported_package_manager";
      packageManager: null;
      privilege: null;
    }
  | {
      status: "insufficient_privileges";
      packageManager: TmuxPackageManager;
      privilege: null;
    }
  | {
      status: "install_failed" | "verification_failed";
      packageManager: TmuxPackageManager;
      privilege: TmuxInstallPrivilege;
    };

export class RemoteCommandTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Remote command timed out after ${timeoutMs}ms`);
    this.name = "RemoteCommandTimeoutError";
  }
}

const DEFAULT_EXEC_TIMEOUT_MS = 10_000;

const DEFAULT_INSTALL_TIMEOUT_MS = 150_000;

const TMUX_PACKAGE_MANAGERS = [
  "apt-get",
  "dnf",
  "yum",
  "apk",
  "zypper",
] as const satisfies readonly TmuxPackageManager[];

// 安装命令必须保持为服务端常量，禁止拼接主机名、用户名或任何客户端输入。
const TMUX_INSTALL_SCRIPTS: Readonly<Record<TmuxPackageManager, string>> = {
  "apt-get":
    "export DEBIAN_FRONTEND=noninteractive; " +
    "apt-get update -qq && " +
    "apt-get install -y --no-install-recommends tmux",
  dnf: "dnf -y install tmux",
  yum: "yum -y install tmux",
  apk: "apk add --no-cache tmux",
  zypper: "zypper --non-interactive install --no-recommends tmux",
};

const TMUX_PATH_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/opt/bin",
  "/usr/pkg/bin",
];

export function withTmuxPath(command: string): string {
  const script = `PATH=${TMUX_PATH_DIRS.join(":")}:$PATH; export PATH; ${command}`;
  return `/bin/sh -c ${shellEscape(script)}`;
}

export function tmuxCommand(args: string): string {
  return withTmuxPath(`tmux ${args}`);
}

function exactTmuxTarget(sessionName: string): string {
  return shellEscape(`=${sessionName}`);
}

/**
 * Run a command on the remote host via a separate exec channel.
 * Returns stdout as a string. Does not pollute the interactive shell.
 */
export function execCommand(
  conn: Client,
  command: string,
  timeoutMs = DEFAULT_EXEC_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let activeStream: ClientChannel | null = null;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(
      () => {
        finish(() => {
          try {
            activeStream?.close();
          } catch {
            // 远端通道可能尚未建立或已经关闭。
          }
          reject(new RemoteCommandTimeoutError(timeoutMs));
        });
      },
      Math.max(1, timeoutMs),
    );

    try {
      conn.exec(command, (err, stream) => {
        if (settled) {
          try {
            stream?.close();
          } catch {
            // 超时后才返回的通道只需尽力关闭。
          }
          return;
        }
        if (err) {
          finish(() => reject(err));
          return;
        }
        activeStream = stream;
        let stdout = "";
        let stderr = "";
        stream.on("data", (data: Buffer) => {
          stdout += data.toString("utf-8");
        });
        stream.stderr.on("data", (data: Buffer) => {
          stderr += data.toString("utf-8");
        });
        stream.on("error", (streamError: Error) => {
          finish(() => reject(streamError));
        });
        stream.on("close", (code: number) => {
          // 部分主机会在每个非交互 SSH 命令前向 stdout 输出登录提示。
          // stdout 有内容不能证明命令成功，否则缺少 tmux 的 127 会被误判
          // 为“已安装”，随后直接进入附着流程而跳过安装确认。
          if (code !== 0) {
            finish(() =>
              reject(
                new Error(stderr.trim() || `Command exited with code ${code}`),
              ),
            );
            return;
          }
          finish(() => resolve(stdout.trim()));
        });
      });
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

/**
 * Probe one managed tmux session without conflating a confirmed miss with a
 * transport or exec failure.
 */
export async function probeTmuxSession(
  conn: Client,
  sessionName: string,
  timeoutMs = DEFAULT_EXEC_TIMEOUT_MS,
): Promise<TmuxSessionProbeResult> {
  const target = exactTmuxTarget(sessionName);
  try {
    const output = await execCommand(
      conn,
      withTmuxPath(
        `tmux has-session -t ${target} 2>/dev/null; status=$?; ` +
          `if [ "$status" -eq 0 ]; then printf found; ` +
          `elif [ "$status" -eq 1 ]; then printf missing; ` +
          `else exit "$status"; fi`,
      ),
      timeoutMs,
    );
    return output === "found"
      ? "found"
      : output === "missing"
        ? "missing"
        : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * 查询受管 tmux 窗口当前附着的客户端数。
 * null 表示无法确认（网络/命令异常或窗口不存在），不能当作 0 处理。
 */
export async function probeTmuxAttachedClients(
  conn: Client,
  sessionName: string,
  timeoutMs = DEFAULT_EXEC_TIMEOUT_MS,
): Promise<TmuxAttachedClientsProbeResult> {
  const target = exactTmuxTarget(sessionName);
  try {
    const output = await execCommand(
      conn,
      withTmuxPath(
        `tmux display-message -p -t ${target} '#{session_attached}' 2>/dev/null`,
      ),
      timeoutMs,
    );
    const count = Number.parseInt(output.trim(), 10);
    return Number.isSafeInteger(count) && count >= 0 ? count : null;
  } catch {
    return null;
  }
}

/**
 * 等待当前交互 Shell 真正成为 tmux 客户端。
 * 通过附着数必须增加来区分“窗口存在”与“本次 attach 成功”。
 */
export async function waitForTmuxAttachedClient(
  conn: Client,
  sessionName: string,
  previousAttachedClients: number,
  timeoutMs = 5_000,
  intervalMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const attached = await probeTmuxAttachedClients(
      conn,
      sessionName,
      Math.min(1_000, remainingMs),
    );
    if (attached !== null && attached > previousAttachedClients) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

/**
 * Detect whether tmux is installed and list all existing sessions with details.
 */
export async function detectTmux(
  conn: Client,
  commandTimeoutMs = 2_500,
): Promise<TmuxDetectionResult> {
  try {
    await execCommand(conn, tmuxCommand("-V"), commandTimeoutMs);
  } catch {
    return { available: false, sessions: [] };
  }

  let sessions: TmuxSessionInfo[] = [];
  try {
    const output = await execCommand(
      conn,
      tmuxCommand(
        `list-sessions -F "#{session_name}|#{session_created}|#{session_activity}|#{session_windows}|#{session_attached}" 2>/dev/null`,
      ),
      commandTimeoutMs,
    );
    if (output) {
      sessions = output
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => {
          const [name, created, activity, windows, attached] = line.split("|");
          return {
            name,
            created: parseInt(created, 10) || 0,
            lastActivity: parseInt(activity, 10) || 0,
            windows: parseInt(windows, 10) || 0,
            attachedClients: parseInt(attached, 10) || 0,
          };
        });
    }
  } catch {
    // tmux server not running yet -- no sessions exist
  }

  return { available: true, sessions };
}

/**
 * 查找受支持的远端包管理器。输出只允许来自固定白名单，不能把远端输出
 * 直接拼进后续命令。
 */
async function detectTmuxPackageManager(
  conn: Client,
  timeoutMs: number,
): Promise<TmuxPackageManager | null> {
  const output = await execCommand(
    conn,
    withTmuxPath(
      `for manager in ${TMUX_PACKAGE_MANAGERS.join(" ")}; do ` +
        `if command -v $manager >/dev/null 2>&1; then printf %s $manager; exit 0; fi; ` +
        `done; printf unsupported`,
    ),
    timeoutMs,
  );
  const manager = output.trim();
  return (TMUX_PACKAGE_MANAGERS as readonly string[]).includes(manager)
    ? (manager as TmuxPackageManager)
    : null;
}

/**
 * 只接受 root 或免密 sudo。绝不尝试读取、缓存或发送 sudo 密码。
 */
async function detectTmuxInstallPrivilege(
  conn: Client,
  timeoutMs: number,
): Promise<TmuxInstallPrivilege | null> {
  const output = await execCommand(
    conn,
    withTmuxPath(
      `if [ $(id -u) = 0 ]; then printf root; ` +
        `elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; ` +
        `then printf sudo; else printf denied; fi`,
    ),
    timeoutMs,
  );
  const privilege = output.trim();
  return privilege === "root" || privilege === "sudo" ? privilege : null;
}

/**
 * 构造固定的 tmux 安装命令。脚本内容来自白名单，调用方不能传入命令或
 * 软件包名称；sudo 使用 -n，确保不会在交互通道中等待密码。
 */
function tmuxInstallCommand(
  packageManager: TmuxPackageManager,
  privilege: TmuxInstallPrivilege,
): string {
  const script = `(${TMUX_INSTALL_SCRIPTS[packageManager]}) >/dev/null 2>&1`;
  const command = `/bin/sh -c ${shellEscape(script)}`;
  return privilege === "root" ? command : `sudo -n ${command}`;
}

/**
 * 在用户明确确认后安装 tmux。安装前后都重新检测，避免把命令执行成功
 * 误报成 tmux 已可用。包管理器输出全部丢弃，防止仓库 URL 或环境信息进入
 * 审计日志和 websocket 错误响应。
 */
export async function installTmux(
  conn: Client,
  installTimeoutMs = DEFAULT_INSTALL_TIMEOUT_MS,
): Promise<TmuxInstallResult> {
  const probeTimeoutMs = Math.min(
    DEFAULT_EXEC_TIMEOUT_MS,
    Math.max(1, installTimeoutMs),
  );
  const before = await detectTmux(conn, probeTimeoutMs);
  if (before.available) {
    return {
      status: "already_installed",
      packageManager: null,
      privilege: null,
    };
  }

  let packageManager: TmuxPackageManager | null;
  try {
    packageManager = await detectTmuxPackageManager(conn, probeTimeoutMs);
  } catch {
    return {
      status: "unsupported_package_manager",
      packageManager: null,
      privilege: null,
    };
  }
  if (!packageManager) {
    return {
      status: "unsupported_package_manager",
      packageManager: null,
      privilege: null,
    };
  }

  let privilege: TmuxInstallPrivilege | null;
  try {
    privilege = await detectTmuxInstallPrivilege(conn, probeTimeoutMs);
  } catch {
    privilege = null;
  }
  if (!privilege) {
    return {
      status: "insufficient_privileges",
      packageManager,
      privilege: null,
    };
  }

  try {
    await execCommand(
      conn,
      tmuxInstallCommand(packageManager, privilege),
      Math.max(1, installTimeoutMs),
    );
  } catch {
    return {
      status: "install_failed",
      packageManager,
      privilege,
    };
  }

  const after = await detectTmux(conn, probeTimeoutMs);
  if (!after.available) {
    return {
      status: "verification_failed",
      packageManager,
      privilege,
    };
  }
  return {
    status: "installed",
    packageManager,
    privilege,
  };
}

// tmux options applied on every attach/create:
// - mouse on: enables mouse wheel / touch scrollback through tmux history
// - history-limit: deep scrollback buffer on the remote host
// - set-clipboard on: use OSC 52 to sync tmux selections to the client clipboard
// - mode-keys vi: use vi-style keys in copy mode
// - MouseDragEnd: stop the selection but keep it highlighted so the user can
//   adjust and press Enter to copy (or drag again)
// - Enter: copy the (possibly adjusted) selection and exit copy mode
// - pane-mode-changed hook: on copy-mode entry, show a brief hint so users
//   know to press Enter to copy the selection
// Using -q on set/set-hook to suppress errors on older tmux versions that don't support
// a particular option (e.g. set-clipboard on tmux < 2.5). Note: set-hook doesn't support -q.
const TMUX_OPTS =
  `set -gq mouse on` +
  ` \\; set -gq history-limit 50000` +
  ` \\; set -gq set-clipboard on` +
  ` \\; set -gq aggressive-resize on` +
  ` \\; set -gq mode-keys vi` +
  ` \\; bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X stop-selection` +
  ` \\; bind-key -T copy-mode-vi Enter send-keys -X copy-selection-and-cancel` +
  ` \\; set-hook -g pane-mode-changed` +
  ` 'if -F "#{pane_in_mode}"` +
  ` "display-message -d 2500 \\"Adjust selection and press Enter to copy\\""'`;

/**
 * Wait for a tmux session to appear by polling via exec channel.
 * Returns the session name once found, or null on timeout.
 */
export async function waitForTmuxSession(
  conn: Client,
  sessionName: string,
  timeoutMs = 5000,
  intervalMs = 100,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const probe = await probeTmuxSession(
      conn,
      sessionName,
      Math.min(1_000, remainingMs),
    );
    if (probe === "found") return sessionName;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

/**
 * 终止平台受管的 tmux 会话。会话已经不存在时按成功处理；SSH 执行失败时抛错，
 * 以免删除恢复记录后在远端留下无法管理的任务。
 */
export async function killTmuxSession(
  conn: Client,
  sessionName: string,
): Promise<boolean> {
  const target = exactTmuxTarget(sessionName);
  const output = await execCommand(
    conn,
    withTmuxPath(
      `tmux has-session -t ${target} 2>/dev/null; status=$?; ` +
        `if [ "$status" -eq 0 ]; then ` +
        `tmux kill-session -t ${target} && printf killed; ` +
        `elif [ "$status" -eq 1 ]; then printf missing; ` +
        `else exit "$status"; fi`,
    ),
  );
  if (output === "killed" || output === "missing") return true;
  throw new Error("Remote tmux termination could not be confirmed");
}

/**
 * Write tmux attach or new-session command to the interactive shell stream.
 * Uses && exit so the shell only closes if tmux started successfully.
 */
export function attachOrCreateTmuxSession(
  stream: ClientChannel,
  existingSessionName?: string,
  newSessionName?: string,
): void {
  let command: string;
  if (existingSessionName) {
    command = `${tmuxCommand(`${TMUX_OPTS} \\; attach-session -t ${exactTmuxTarget(existingSessionName)}`)} && exit\r`;
  } else {
    const nameFlag = newSessionName ? ` -s ${shellEscape(newSessionName)}` : "";
    command = `${tmuxCommand(`${TMUX_OPTS} \\; new-session${nameFlag}`)} && exit\r`;
  }

  sshLogger.info("Writing tmux command to shell", {
    operation: "tmux_attach_or_create",
    sessionName: existingSessionName || "(auto)",
    isReattach: !!existingSessionName,
  });

  stream.write(command);
}

/**
 * Query the name of the most recently created tmux session via exec channel.
 */
export async function queryNewestTmuxSession(
  conn: Client,
): Promise<string | null> {
  try {
    const output = await execCommand(
      conn,
      tmuxCommand(
        `list-sessions -F "#{session_created}:#{session_name}" 2>/dev/null | sort -rn | head -1 | cut -d: -f2-`,
      ),
    );
    return output || null;
  } catch {
    return null;
  }
}

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
