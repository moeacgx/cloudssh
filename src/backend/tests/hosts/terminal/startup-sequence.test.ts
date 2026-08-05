import { describe, expect, it } from "vitest";
import {
  createTerminalStartupPayloadResolver,
  MAX_STARTUP_INPUT_LENGTH,
  MAX_STARTUP_MOSH_COMMAND_LENGTH,
  runTerminalStartupSequence,
  TerminalStartupValidationError,
  validateTerminalStartupPayload,
} from "../../../hosts/terminal/startup-sequence.js";

describe("终端启动配置延迟解析", () => {
  it("首次请求前不读取片段，并在后续请求中复用同一结果", async () => {
    const loadSnippet = vi.fn().mockResolvedValue("echo startup");
    const resolvePayload = createTerminalStartupPayloadResolver(
      {
        environmentVariables: [{ key: "READY", value: "1" }],
        startupSnippetId: 7,
        autoMosh: true,
        moshCommand: "mosh --predict=always",
      },
      loadSnippet,
    );

    expect(loadSnippet).not.toHaveBeenCalled();
    await expect(resolvePayload()).resolves.toEqual({
      startupInput: 'export READY="1"\necho startup\n',
      startupMoshCommand: "mosh --predict=always",
    });
    await resolvePayload();
    expect(loadSnippet).toHaveBeenCalledTimes(1);
    expect(loadSnippet).toHaveBeenCalledWith(7);
  });

  it("片段读取失败时继续保留环境变量和 Mosh 配置", async () => {
    const resolvePayload = createTerminalStartupPayloadResolver(
      {
        environmentVariables: [{ key: "READY", value: "1" }],
        startupSnippetId: 7,
        autoMosh: true,
        moshCommand: "mosh --predict=always",
      },
      async () => {
        throw new Error("snippet unavailable");
      },
    );

    await expect(resolvePayload()).resolves.toEqual({
      startupInput: 'export READY="1"\n',
      startupMoshCommand: "mosh --predict=always",
    });
  });
});

describe("终端启动载荷验证", () => {
  it("接受边界内的 UTF-8 字节长度", () => {
    const startupInput = "a".repeat(MAX_STARTUP_INPUT_LENGTH);
    const startupMoshCommand = "m".repeat(MAX_STARTUP_MOSH_COMMAND_LENGTH);

    expect(
      validateTerminalStartupPayload({ startupInput, startupMoshCommand }),
    ).toEqual({ startupInput, startupMoshCommand });
  });

  it("按 UTF-8 字节而不是字符数量拒绝超长载荷", () => {
    const multibyteInput = "界".repeat(
      Math.floor(MAX_STARTUP_INPUT_LENGTH / 3) + 1,
    );

    expect(() =>
      validateTerminalStartupPayload({ startupInput: multibyteInput }),
    ).toThrowError(
      expect.objectContaining({
        code: "STARTUP_INPUT_TOO_LARGE",
        message: "Startup input exceeds the allowed size",
      }),
    );
    expect(() =>
      validateTerminalStartupPayload({
        startupMoshCommand: "m".repeat(MAX_STARTUP_MOSH_COMMAND_LENGTH + 1),
      }),
    ).toThrowError(
      expect.objectContaining({ code: "STARTUP_MOSH_COMMAND_TOO_LARGE" }),
    );
  });

  it("拒绝非字符串且错误不包含原始敏感载荷", () => {
    const sensitiveValue = { password: "do-not-log-this-secret" };

    try {
      validateTerminalStartupPayload({ startupInput: sensitiveValue });
      throw new Error("Expected startup validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TerminalStartupValidationError);
      expect(error).toMatchObject({ code: "INVALID_STARTUP_INPUT" });
      expect(String(error)).not.toContain(sensitiveValue.password);
    }
  });
});

describe("终端启动写入顺序", () => {
  it("严格按启动输入、目录、命令和 Mosh 顺序写入", async () => {
    const writes: Array<{ stage: string; data: string }> = [];

    await runTerminalStartupSequence({
      startupInput: "export TOKEN=secret\n",
      initialPathCommand: 'cd "/srv/app"\r',
      executeCommand: "npm run worker",
      startupMoshCommand: "mosh --predict=adaptive",
      interCommandDelayMs: 0,
      isActive: () => true,
      write: (data, stage) => writes.push({ stage, data }),
    });

    expect(writes).toEqual([
      { stage: "startup_input", data: "export TOKEN=secret\n" },
      { stage: "initial_path", data: 'cd "/srv/app"\r' },
      { stage: "execute_command", data: "npm run worker\r" },
      { stage: "startup_mosh", data: "mosh --predict=adaptive\r" },
    ]);
  });

  it("每次写入前重新检查会话状态", async () => {
    let active = true;
    const writes: string[] = [];

    await runTerminalStartupSequence({
      startupInput: "export READY=1\n",
      initialPathCommand: 'cd "/srv/app"\r',
      executeCommand: "run-task",
      interCommandDelayMs: 0,
      isActive: () => active,
      write: (data) => {
        writes.push(data);
        active = false;
      },
    });

    expect(writes).toEqual(["export READY=1\n"]);
  });

  it("取消发生在命令间隔期间时不再写入后续启动内容", async () => {
    vi.useFakeTimers();
    try {
      let active = true;
      const writes: string[] = [];
      const operation = runTerminalStartupSequence({
        startupInput: "export READY=1\n",
        initialPathCommand: 'cd "/srv/app"\r',
        executeCommand: "run-task",
        interCommandDelayMs: 500,
        isActive: () => active,
        write: (data) => {
          writes.push(data);
          active = false;
        },
      });

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(500);
      await operation;

      expect(writes).toEqual(["export READY=1\n"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("写入异常只返回通用错误，不泄露启动内容", async () => {
    const secret = "export PRIVATE_TOKEN=do-not-expose\n";

    const operation = runTerminalStartupSequence({
      startupInput: secret,
      interCommandDelayMs: 0,
      isActive: () => true,
      write: () => {
        throw new Error("remote stream failed: " + secret);
      },
    });

    await expect(operation).rejects.toMatchObject({
      code: "TERMINAL_STARTUP_WRITE_FAILED",
      message: "Terminal startup sequence could not be written",
    });
    await operation.catch((error: unknown) => {
      expect(String(error)).not.toContain(secret.trim());
    });
  });
});
