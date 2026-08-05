import { EventEmitter } from "node:events";
import type { Client } from "ssh2";
import { describe, expect, it, vi } from "vitest";
import {
  detectTmux,
  execCommand,
  installTmux,
  killTmuxSession,
  probeTmuxAttachedClients,
  probeTmuxSession,
  RemoteCommandTimeoutError,
  tmuxCommand,
  waitForTmuxAttachedClient,
  withTmuxPath,
} from "../../../hosts/tmux/helper.js";

interface MockExecResult {
  stdout?: string;
  stderr?: string;
  code?: number;
  execError?: Error;
  hang?: boolean;
}

function createSequencedClient(
  results: MockExecResult[],
  commands: string[],
  closeCallbacks: Array<ReturnType<typeof vi.fn>> = [],
): Client {
  return {
    exec(
      command: string,
      callback: (error: Error | null, stream?: never) => void,
    ) {
      commands.push(command);
      const result = results.shift();
      if (!result) {
        callback(new Error("Unexpected remote command"));
        return;
      }
      if (result.execError) {
        callback(result.execError);
        return;
      }

      const stream = new EventEmitter() as EventEmitter & {
        stderr: EventEmitter;
        close: ReturnType<typeof vi.fn>;
      };
      stream.stderr = new EventEmitter();
      stream.close = vi.fn();
      closeCallbacks.push(stream.close);
      callback(null, stream as never);
      if (result.hang) return;

      queueMicrotask(() => {
        if (result.stdout) {
          stream.emit("data", Buffer.from(result.stdout));
        }
        if (result.stderr) {
          stream.stderr.emit("data", Buffer.from(result.stderr));
        }
        stream.emit("close", result.code ?? 0);
      });
    },
  } as unknown as Client;
}

describe("tmux command path handling", () => {
  it("adds common non-login shell tmux paths", () => {
    const command = withTmuxPath("command -v tmux");

    expect(command).toMatch(/^\/bin\/sh -c '/);
    expect(command).toContain("/opt/homebrew/bin");
    expect(command).toContain("/usr/local/bin");
    expect(command).toContain("/opt/bin");
    expect(command).toContain("/usr/pkg/bin");
    expect(command).toContain(":$PATH; export PATH; command -v tmux");
  });

  it("wraps tmux invocations with the same path", () => {
    expect(tmuxCommand("list-sessions")).toMatch(
      /^\/bin\/sh -c 'PATH=.*:\$PATH; export PATH; tmux list-sessions'$/,
    );
  });

  it("detects suffixed tmux versions without parsing the version number", async () => {
    const commands: string[] = [];
    const conn = {
      exec(command: string, callback: (error: null, stream: never) => void) {
        commands.push(command);
        const stream = new EventEmitter() as EventEmitter & {
          stderr: EventEmitter;
        };
        stream.stderr = new EventEmitter();
        callback(null, stream as never);

        queueMicrotask(() => {
          if (commands.length === 1) {
            stream.emit("data", Buffer.from("tmux 3.7b\n"));
            stream.emit("close", 0);
            return;
          }
          stream.emit("close", 1);
        });
      },
    } as unknown as Client;

    await expect(detectTmux(conn)).resolves.toEqual({
      available: true,
      sessions: [],
    });
    expect(commands[0]).toContain("tmux -V");
  });

  it("不会把失败命令前的 SSH 登录提示误判为 tmux 已安装", async () => {
    const commands: string[] = [];
    const conn = createSequencedClient(
      [
        {
          stdout: "Authorized access only\n",
          stderr: "tmux: not found",
          code: 127,
        },
      ],
      commands,
    );

    await expect(detectTmux(conn)).resolves.toEqual({
      available: false,
      sessions: [],
    });
    expect(commands).toHaveLength(1);
  });

  it("远端命令非零退出时即使 stdout 有内容也必须失败", async () => {
    const commands: string[] = [];
    const conn = createSequencedClient(
      [
        {
          stdout: "Authorized access only\n",
          stderr: "tmux: not found",
          code: 127,
        },
      ],
      commands,
    );

    await expect(execCommand(conn, "tmux -V")).rejects.toThrow(
      "tmux: not found",
    );
  });

  it("escapes the managed session name before terminating it", async () => {
    const commands: string[] = [];
    const conn = {
      exec(command: string, callback: (error: null, stream: never) => void) {
        commands.push(command);
        const stream = new EventEmitter() as EventEmitter & {
          stderr: EventEmitter;
        };
        stream.stderr = new EventEmitter();
        callback(null, stream as never);
        queueMicrotask(() => {
          stream.emit("data", Buffer.from("killed"));
          stream.emit("close", 0);
        });
      },
    } as unknown as Client;

    await expect(
      killTmuxSession(conn, "managed'; touch /tmp/unsafe"),
    ).resolves.toBe(true);
    const managedNameOffset = commands[0].indexOf("managed");
    const injectedSeparatorOffset = commands[0].indexOf(
      "; touch /tmp/unsafe",
      managedNameOffset,
    );
    expect(managedNameOffset).toBeGreaterThanOrEqual(0);
    expect(injectedSeparatorOffset).toBeGreaterThan(managedNameOffset);
    expect(
      commands[0].slice(managedNameOffset, injectedSeparatorOffset),
    ).toContain("\\'");
  });

  it("treats an already missing managed session as closed", async () => {
    const conn = {
      exec(_command: string, callback: (error: null, stream: never) => void) {
        const stream = new EventEmitter() as EventEmitter & {
          stderr: EventEmitter;
        };
        stream.stderr = new EventEmitter();
        callback(null, stream as never);
        queueMicrotask(() => {
          stream.emit("data", Buffer.from("missing"));
          stream.emit("close", 0);
        });
      },
    } as unknown as Client;

    await expect(killTmuxSession(conn, "managed-session")).resolves.toBe(true);
  });

  it("不会把 tmux 未安装或 has-session 异常当作窗口已不存在", async () => {
    const commands: string[] = [];
    const conn = {
      exec(command: string, callback: (error: null, stream: never) => void) {
        commands.push(command);
        const stream = new EventEmitter() as EventEmitter & {
          stderr: EventEmitter;
        };
        stream.stderr = new EventEmitter();
        callback(null, stream as never);
        queueMicrotask(() => {
          stream.stderr.emit("data", Buffer.from("tmux: not found"));
          stream.emit("close", 127);
        });
      },
    } as unknown as Client;

    await expect(killTmuxSession(conn, "managed-session")).rejects.toThrow(
      "tmux: not found",
    );
    expect(commands[0]).toContain("status=$?");
    expect(commands[0]).toContain('elif [ "$status" -eq 1 ]');
    expect(commands[0]).toContain('else exit "$status"');
  });

  it("rejects an unexpected termination response", async () => {
    const conn = {
      exec(_command: string, callback: (error: null, stream: never) => void) {
        const stream = new EventEmitter() as EventEmitter & {
          stderr: EventEmitter;
        };
        stream.stderr = new EventEmitter();
        callback(null, stream as never);
        queueMicrotask(() => {
          stream.emit("data", Buffer.from("unknown"));
          stream.emit("close", 0);
        });
      },
    } as unknown as Client;

    await expect(killTmuxSession(conn, "managed-session")).rejects.toThrow(
      "Remote tmux termination could not be confirmed",
    );
  });

  it.each([
    ["found", "found"],
    ["missing", "missing"],
  ] as const)(
    "returns a distinct %s probe result",
    async (output, expected) => {
      const conn = {
        exec(_command: string, callback: (error: null, stream: never) => void) {
          const stream = new EventEmitter() as EventEmitter & {
            stderr: EventEmitter;
          };
          stream.stderr = new EventEmitter();
          callback(null, stream as never);
          queueMicrotask(() => {
            stream.emit("data", Buffer.from(output));
            stream.emit("close", 0);
          });
        },
      } as unknown as Client;

      await expect(probeTmuxSession(conn, "managed-session")).resolves.toBe(
        expected,
      );
    },
  );

  it("keeps probe failures distinct from a confirmed missing session", async () => {
    const conn = {
      exec(_command: string, callback: (error: Error, stream?: never) => void) {
        callback(new Error("exec channel unavailable"));
      },
    } as unknown as Client;

    await expect(probeTmuxSession(conn, "managed-session")).resolves.toBe(
      "unknown",
    );
  });

  it("读取 tmux 当前附着客户端数，并将异常视为未知", async () => {
    const commands: string[] = [];
    const conn = {
      exec(command: string, callback: (error: null, stream: never) => void) {
        commands.push(command);
        const stream = new EventEmitter() as EventEmitter & {
          stderr: EventEmitter;
        };
        stream.stderr = new EventEmitter();
        callback(null, stream as never);
        queueMicrotask(() => {
          stream.emit("data", Buffer.from("2\n"));
          stream.emit("close", 0);
        });
      },
    } as unknown as Client;

    await expect(
      probeTmuxAttachedClients(conn, "managed-session"),
    ).resolves.toBe(2);
    expect(commands[0]).toContain("session_attached");

    const unavailable = {
      exec(_command: string, callback: (error: Error) => void) {
        callback(new Error("exec unavailable"));
      },
    } as unknown as Client;
    await expect(
      probeTmuxAttachedClients(unavailable, "managed-session"),
    ).resolves.toBeNull();
  });

  it("只有附着客户端数增加后才确认本次 tmux attach 成功", async () => {
    const outputs = ["1", "2"];
    const conn = {
      exec(_command: string, callback: (error: null, stream: never) => void) {
        const stream = new EventEmitter() as EventEmitter & {
          stderr: EventEmitter;
        };
        stream.stderr = new EventEmitter();
        callback(null, stream as never);
        queueMicrotask(() => {
          stream.emit("data", Buffer.from(outputs.shift() ?? "2"));
          stream.emit("close", 0);
        });
      },
    } as unknown as Client;

    await expect(
      waitForTmuxAttachedClient(conn, "managed-session", 1, 100, 1),
    ).resolves.toBe(true);
  });

  it("times out a remote exec channel that never finishes", async () => {
    vi.useFakeTimers();
    try {
      const close = vi.fn();
      const conn = {
        exec(_command: string, callback: (error: null, stream: never) => void) {
          const stream = new EventEmitter() as EventEmitter & {
            stderr: EventEmitter;
            close: () => void;
          };
          stream.stderr = new EventEmitter();
          stream.close = close;
          callback(null, stream as never);
        },
      } as unknown as Client;

      const assertion = expect(
        execCommand(conn, "printf never", 50),
      ).rejects.toBeInstanceOf(RemoteCommandTimeoutError);
      await vi.advanceTimersByTimeAsync(50);
      await assertion;
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("tmux controlled installation", () => {
  const missingTmux: MockExecResult = {
    stderr: "tmux: not found",
    code: 127,
  };
  const installedTmux: MockExecResult = { stdout: "tmux 3.4\n" };
  const noTmuxServer: MockExecResult = {
    stderr: "no server running",
    code: 1,
  };

  it("returns immediately when tmux is already available", async () => {
    const commands: string[] = [];
    const conn = createSequencedClient([installedTmux, noTmuxServer], commands);

    await expect(installTmux(conn)).resolves.toEqual({
      status: "already_installed",
      packageManager: null,
      privilege: null,
    });
    expect(commands).toHaveLength(2);
    expect(commands.every((command) => !command.includes(" install "))).toBe(
      true,
    );
  });

  it.each([
    ["apt-get", "apt-get update -qq"],
    ["dnf", "dnf -y install tmux"],
    ["yum", "yum -y install tmux"],
    ["apk", "apk add --no-cache tmux"],
    ["zypper", "zypper --non-interactive install --no-recommends tmux"],
  ] as const)(
    "installs with the whitelisted %s command as root",
    async (manager, expectedCommand) => {
      const commands: string[] = [];
      const conn = createSequencedClient(
        [
          missingTmux,
          { stdout: manager },
          { stdout: "root" },
          {},
          installedTmux,
          noTmuxServer,
        ],
        commands,
      );

      await expect(installTmux(conn)).resolves.toEqual({
        status: "installed",
        packageManager: manager,
        privilege: "root",
      });
      expect(commands[3]).toContain(expectedCommand);
      expect(commands[3]).toContain(">/dev/null 2>&1");
      expect(commands[3]).not.toMatch(/^sudo /);
    },
  );

  it("uses only non-interactive sudo for a non-root host", async () => {
    const commands: string[] = [];
    const conn = createSequencedClient(
      [
        missingTmux,
        { stdout: "dnf" },
        { stdout: "sudo" },
        {},
        installedTmux,
        noTmuxServer,
      ],
      commands,
    );

    await expect(installTmux(conn)).resolves.toMatchObject({
      status: "installed",
      privilege: "sudo",
    });
    expect(commands[2]).toContain("sudo -n true");
    expect(commands[3]).toMatch(/^sudo -n \/bin\/sh -c /);
    expect(commands.join("\n")).not.toMatch(/sudo\s+-S|read\s+-[rsp]/);
  });

  it("rejects package-manager output outside the exact whitelist", async () => {
    const commands: string[] = [];
    const conn = createSequencedClient(
      [missingTmux, { stdout: "apt-get; touch /tmp/unsafe" }],
      commands,
    );

    await expect(installTmux(conn)).resolves.toEqual({
      status: "unsupported_package_manager",
      packageManager: null,
      privilege: null,
    });
    expect(commands).toHaveLength(2);
  });

  it("does not execute an installer without root or passwordless sudo", async () => {
    const commands: string[] = [];
    const conn = createSequencedClient(
      [missingTmux, { stdout: "apt-get" }, { stdout: "denied" }],
      commands,
    );

    await expect(installTmux(conn)).resolves.toEqual({
      status: "insufficient_privileges",
      packageManager: "apt-get",
      privilege: null,
    });
    expect(commands).toHaveLength(3);
  });

  it("reports a package installation failure without returning remote output", async () => {
    const commands: string[] = [];
    const conn = createSequencedClient(
      [
        missingTmux,
        { stdout: "apk" },
        { stdout: "root" },
        { stderr: "private repository URL", code: 2 },
      ],
      commands,
    );

    await expect(installTmux(conn)).resolves.toEqual({
      status: "install_failed",
      packageManager: "apk",
      privilege: "root",
    });
    expect(commands[3]).toContain(">/dev/null 2>&1");
  });

  it("verifies that tmux is actually available after installation", async () => {
    const commands: string[] = [];
    const conn = createSequencedClient(
      [missingTmux, { stdout: "yum" }, { stdout: "root" }, {}, missingTmux],
      commands,
    );

    await expect(installTmux(conn)).resolves.toEqual({
      status: "verification_failed",
      packageManager: "yum",
      privilege: "root",
    });
    expect(commands).toHaveLength(5);
  });

  it("stops a package installation that exceeds its timeout", async () => {
    vi.useFakeTimers();
    try {
      const commands: string[] = [];
      const closeCallbacks: Array<ReturnType<typeof vi.fn>> = [];
      const conn = createSequencedClient(
        [
          missingTmux,
          { stdout: "apt-get" },
          { stdout: "root" },
          { hang: true },
        ],
        commands,
        closeCallbacks,
      );

      const result = installTmux(conn, 50);
      await vi.advanceTimersByTimeAsync(50);
      await expect(result).resolves.toEqual({
        status: "install_failed",
        packageManager: "apt-get",
        privilege: "root",
      });
      expect(closeCallbacks.at(-1)).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
