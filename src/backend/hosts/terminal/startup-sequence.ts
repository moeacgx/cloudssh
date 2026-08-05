export const MAX_STARTUP_INPUT_LENGTH = 128 * 1024;
export const MAX_STARTUP_MOSH_COMMAND_LENGTH = 8 * 1024;

export type TerminalStartupValidationCode =
  | "INVALID_STARTUP_INPUT"
  | "STARTUP_INPUT_TOO_LARGE"
  | "INVALID_STARTUP_MOSH_COMMAND"
  | "STARTUP_MOSH_COMMAND_TOO_LARGE";

export class TerminalStartupValidationError extends Error {
  constructor(
    public readonly code: TerminalStartupValidationCode,
    message: string,
  ) {
    super(message);
    this.name = "TerminalStartupValidationError";
  }
}

export interface ValidatedTerminalStartupPayload {
  startupInput?: string;
  startupMoshCommand?: string;
}

export interface TerminalStartupConfig {
  environmentVariables?: unknown;
  startupSnippetId?: unknown;
  autoMosh?: unknown;
  moshCommand?: unknown;
}

interface TerminalEnvironmentVariable {
  key?: unknown;
  value?: unknown;
}

/**
 * 固定窗口直到确认保活方式后才调用此函数，避免取消固定时仍读取或执行启动片段。
 * 片段读取失败沿用普通终端的容错策略：跳过片段，但继续执行其余启动配置。
 */
export async function resolveTerminalStartupPayload(
  config: TerminalStartupConfig | null | undefined,
  loadSnippetContent: (snippetId: number) => Promise<string | null>,
): Promise<ValidatedTerminalStartupPayload> {
  const startupInputParts: string[] = [];
  const environmentVariables = Array.isArray(config?.environmentVariables)
    ? (config.environmentVariables as TerminalEnvironmentVariable[])
    : [];

  for (const variable of environmentVariables) {
    if (
      typeof variable?.key === "string" &&
      variable.key.length > 0 &&
      typeof variable.value === "string" &&
      variable.value.length > 0
    ) {
      startupInputParts.push(`export ${variable.key}="${variable.value}"\n`);
    }
  }

  const startupSnippetId = config?.startupSnippetId;
  if (Number.isSafeInteger(startupSnippetId) && Number(startupSnippetId) > 0) {
    try {
      const content = await loadSnippetContent(Number(startupSnippetId));
      if (content) startupInputParts.push(content + "\n");
    } catch {
      // 启动片段属于增强项，读取失败不应阻断 SSH 或固定窗口本身。
    }
  }

  return validateTerminalStartupPayload({
    startupInput: startupInputParts.join("") || undefined,
    startupMoshCommand:
      config?.autoMosh === true &&
      typeof config.moshCommand === "string" &&
      config.moshCommand.length > 0
        ? config.moshCommand
        : undefined,
  });
}

/** 创建按需、单次解析器，确保固定方式尚未确认时不会读取启动片段。 */
export function createTerminalStartupPayloadResolver(
  config: TerminalStartupConfig | null | undefined,
  loadSnippetContent: (snippetId: number) => Promise<string | null>,
): () => Promise<ValidatedTerminalStartupPayload> {
  let pending: Promise<ValidatedTerminalStartupPayload> | null = null;
  return () => {
    pending ??= resolveTerminalStartupPayload(config, loadSnippetContent);
    return pending;
  };
}

function validateOptionalUtf8String(
  value: unknown,
  options: {
    invalidCode: TerminalStartupValidationCode;
    tooLargeCode: TerminalStartupValidationCode;
    invalidMessage: string;
    tooLargeMessage: string;
    maxBytes: number;
  },
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new TerminalStartupValidationError(
      options.invalidCode,
      options.invalidMessage,
    );
  }
  if (Buffer.byteLength(value, "utf8") > options.maxBytes) {
    throw new TerminalStartupValidationError(
      options.tooLargeCode,
      options.tooLargeMessage,
    );
  }
  return value;
}

export function validateTerminalStartupPayload(input: {
  startupInput?: unknown;
  startupMoshCommand?: unknown;
}): ValidatedTerminalStartupPayload {
  return {
    startupInput: validateOptionalUtf8String(input.startupInput, {
      invalidCode: "INVALID_STARTUP_INPUT",
      tooLargeCode: "STARTUP_INPUT_TOO_LARGE",
      invalidMessage: "Startup input must be a string",
      tooLargeMessage: "Startup input exceeds the allowed size",
      maxBytes: MAX_STARTUP_INPUT_LENGTH,
    }),
    startupMoshCommand: validateOptionalUtf8String(input.startupMoshCommand, {
      invalidCode: "INVALID_STARTUP_MOSH_COMMAND",
      tooLargeCode: "STARTUP_MOSH_COMMAND_TOO_LARGE",
      invalidMessage: "Startup Mosh command must be a string",
      tooLargeMessage: "Startup Mosh command exceeds the allowed size",
      maxBytes: MAX_STARTUP_MOSH_COMMAND_LENGTH,
    }),
  };
}

export type TerminalStartupStage =
  | "startup_input"
  | "initial_path"
  | "execute_command"
  | "startup_mosh";

interface TerminalStartupWrite {
  stage: TerminalStartupStage;
  data: string;
}

export interface RunTerminalStartupSequenceOptions {
  startupInput?: string;
  initialPathCommand?: string;
  executeCommand?: string;
  startupMoshCommand?: string;
  initialDelayMs?: number;
  interCommandDelayMs?: number;
  isActive: () => boolean;
  write: (data: string, stage: TerminalStartupStage) => void;
}

export class TerminalStartupWriteError extends Error {
  readonly code = "TERMINAL_STARTUP_WRITE_FAILED";

  constructor() {
    super("Terminal startup sequence could not be written");
    this.name = "TerminalStartupWriteError";
  }
}

function wait(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function buildStartupWrites(
  options: RunTerminalStartupSequenceOptions,
): TerminalStartupWrite[] {
  const writes: TerminalStartupWrite[] = [];
  if (options.startupInput?.trim()) {
    writes.push({ stage: "startup_input", data: options.startupInput });
  }
  if (options.initialPathCommand?.trim()) {
    writes.push({ stage: "initial_path", data: options.initialPathCommand });
  }
  if (options.executeCommand?.trim()) {
    writes.push({
      stage: "execute_command",
      data: options.executeCommand + "\r",
    });
  }
  if (options.startupMoshCommand?.trim()) {
    writes.push({
      stage: "startup_mosh",
      data: options.startupMoshCommand + "\r",
    });
  }
  return writes;
}

export async function runTerminalStartupSequence(
  options: RunTerminalStartupSequenceOptions,
): Promise<void> {
  await wait(Math.max(0, options.initialDelayMs ?? 0));
  const writes = buildStartupWrites(options);
  const interCommandDelayMs = Math.max(0, options.interCommandDelayMs ?? 300);

  for (let index = 0; index < writes.length; index += 1) {
    if (!options.isActive()) return;
    const item = writes[index];
    try {
      options.write(item.data, item.stage);
    } catch {
      throw new TerminalStartupWriteError();
    }
    if (index < writes.length - 1) {
      await wait(interCommandDelayMs);
    }
  }
}
