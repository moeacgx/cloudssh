import dgram from "dgram";
import net from "net";
import ssh2Pkg, {
  type IdentityCallback,
  type ParsedKey,
  type SignCallback,
  type SigningRequestOptions,
} from "ssh2";

const { BaseAgent } = ssh2Pkg;
const DEFAULT_PORT_KNOCK_TIMEOUT_MS = 1000;

type Sleep = (ms: number) => Promise<void>;

type PortKnockingOptions = {
  tcpTimeoutMs?: number;
  udpTimeoutMs?: number;
  createTcpSocket?: () => net.Socket;
  createUdpSocket?: () => dgram.Socket;
  wait?: Sleep;
  signal?: AbortSignal;
};

const sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function portKnockAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Port knocking canceled");
}

async function waitForPortKnockDelay(
  wait: Sleep,
  delay: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) {
    await wait(delay);
    return;
  }
  if (signal.aborted) throw portKnockAbortReason(signal);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(portKnockAbortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    wait(delay).then(() => finish(), finish);
  });
}

export class MemoryAgent extends BaseAgent {
  private key: ParsedKey;

  constructor(key: ParsedKey) {
    super();
    this.key = key;
  }

  getIdentities(cb: IdentityCallback<ParsedKey>): void {
    cb(null, [this.key]);
  }

  sign(
    _pubKey: ParsedKey | Buffer | string,
    data: Buffer,
    optionsOrCb: SigningRequestOptions | SignCallback,
    cb?: SignCallback,
  ): void {
    const callback = typeof optionsOrCb === "function" ? optionsOrCb : cb!;
    const options = typeof optionsOrCb === "function" ? {} : optionsOrCb;
    try {
      const algo =
        options.hash === "sha256"
          ? "rsa-sha2-256"
          : options.hash === "sha512"
            ? "rsa-sha2-512"
            : undefined;
      const signature = this.key.sign(data, algo);
      callback(null, signature);
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

export async function resolveAgentSocket(
  terminalConfig: Record<string, unknown> | undefined,
): Promise<{ socketPath: string } | { error: string }> {
  const explicit = (
    terminalConfig?.agentSocketPath as string | undefined
  )?.trim();
  const resolved = explicit || process.env.SSH_AUTH_SOCK;

  if (!resolved) {
    return {
      error: "SSH_AUTH_SOCK is not set and no socket path was provided.",
    };
  }

  if (process.platform !== "win32") {
    const { access } = await import("fs/promises");
    try {
      await access(resolved);
    } catch {
      return {
        error: `SSH agent socket not found at ${resolved}. Make sure your agent is running.`,
      };
    }
  }

  return { socketPath: resolved };
}

export async function applyAgentAuth(
  connectConfig: Record<string, unknown>,
  terminalConfig: Record<string, unknown> | undefined,
): Promise<{ socketPath: string } | { error: string }> {
  const result = await resolveAgentSocket(terminalConfig);
  if ("error" in result) return result;

  const { createAgent } = ssh2Pkg;
  connectConfig.agent = createAgent(result.socketPath);
  return result;
}

export async function performPortKnocking(
  host: string,
  sequence: Array<{ port: number; protocol?: string; delay?: number }>,
  options: PortKnockingOptions = {},
): Promise<void> {
  const createTcpSocket = options.createTcpSocket ?? (() => new net.Socket());
  const createUdpSocket =
    options.createUdpSocket ?? (() => dgram.createSocket("udp4"));
  const wait = options.wait ?? sleep;
  const tcpTimeoutMs = options.tcpTimeoutMs ?? DEFAULT_PORT_KNOCK_TIMEOUT_MS;
  const udpTimeoutMs = options.udpTimeoutMs ?? DEFAULT_PORT_KNOCK_TIMEOUT_MS;
  const signal = options.signal;

  for (const knock of sequence) {
    if (signal?.aborted) throw portKnockAbortReason(signal);
    const port = Number(knock.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;

    const protocol = (knock.protocol || "tcp").toLowerCase();
    const delay = Number(knock.delay ?? 100);

    await new Promise<void>((resolve, reject) => {
      if (protocol === "udp") {
        const client = createUdpSocket();
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          signal?.removeEventListener("abort", onAbort);
          try {
            client.close();
          } catch {
            // 已关闭的 UDP socket 无需重复处理。
          }
          if (error) reject(error);
          else resolve();
        };
        const onAbort = () =>
          finish(signal ? portKnockAbortReason(signal) : undefined);
        const timeout = setTimeout(() => finish(), udpTimeoutMs);
        client.once("error", () => finish());
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) {
          onAbort();
          return;
        }
        client.send(Buffer.alloc(0), port, host, () => {
          finish();
        });
      } else {
        const socket = createTcpSocket();
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          signal?.removeEventListener("abort", onAbort);
          socket.removeAllListeners("connect");
          socket.destroy();
          if (error) reject(error);
          else resolve();
        };
        const onAbort = () =>
          finish(signal ? portKnockAbortReason(signal) : undefined);
        const timeout = setTimeout(() => finish(), tcpTimeoutMs);
        socket.once("connect", finish);
        socket.once("error", () => finish());
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) {
          onAbort();
          return;
        }
        socket.connect(port, host);
      }
    });

    if (delay > 0) {
      await waitForPortKnockDelay(wait, delay, signal);
    }
  }
}
