import { Client as SSHClient, type ConnectConfig } from "ssh2";
import type { SSHHost } from "../../../types/index.js";
import { SSH_ALGORITHMS } from "../../utils/ssh-algorithms.js";
import {
  createSocks5Connection,
  type SOCKS5Config,
} from "../../utils/socks5-helper.js";
import { SSHHostKeyVerifier } from "../host-key-verifier.js";
import { createJumpHostChain } from "../jump-host-chain.js";
import { resolveSshConnectConfigHost } from "../ssh-dns.js";
import { applyAgentAuth } from "../terminal-auth-helpers.js";

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("SSH connection canceled");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

async function waitForAbortableResource<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  dispose: (resource: T) => void,
): Promise<T> {
  if (!signal) return operation;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (resource) => {
        if (settled) {
          try {
            dispose(resource);
          } catch {
            // 取消已经返回给调用方；迟到资源的清理失败不能形成未处理拒绝。
          }
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(resource);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function buildDedicatedTransferConnectConfig(
  host: SSHHost,
  userId: string,
  client: SSHClient,
): Promise<ConnectConfig> {
  const { ip, port, username } = host;
  const preloadedHostData = await SSHHostKeyVerifier.preloadHostData(host.id);
  const config: ConnectConfig & Record<string, unknown> = {
    host: ip?.replace(/^\[|\]$/g, "") || ip,
    port,
    username,
    tryKeyboard: true,
    keepaliveInterval: 30000,
    keepaliveCountMax: 120,
    readyTimeout: 60000,
    tcpKeepAlive: true,
    tcpKeepAliveInitialDelay: 5000,
    hostVerifier: await SSHHostKeyVerifier.createHostVerifier(
      host.id,
      ip,
      port,
      null,
      userId,
      false,
      preloadedHostData,
    ),
    env: {
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
    },
    algorithms: {
      kex: [
        "curve25519-sha256",
        "curve25519-sha256@libssh.org",
        "ecdh-sha2-nistp521",
        "ecdh-sha2-nistp384",
        "ecdh-sha2-nistp256",
        "diffie-hellman-group-exchange-sha256",
        "diffie-hellman-group14-sha256",
        "diffie-hellman-group14-sha1",
        "diffie-hellman-group-exchange-sha1",
        "diffie-hellman-group1-sha1",
      ],
      serverHostKey: [
        "ssh-ed25519",
        "ecdsa-sha2-nistp521",
        "ecdsa-sha2-nistp384",
        "ecdsa-sha2-nistp256",
        "rsa-sha2-512",
        "rsa-sha2-256",
        "ssh-rsa",
        "ssh-dss",
      ],
      cipher: SSH_ALGORITHMS.cipher,
      hmac: [
        "hmac-sha2-512-etm@openssh.com",
        "hmac-sha2-256-etm@openssh.com",
        "hmac-sha2-512",
        "hmac-sha2-256",
        "hmac-sha1",
        "hmac-md5",
      ],
      compress: ["none", "zlib@openssh.com", "zlib"],
    },
  };
  await resolveSshConnectConfigHost(config);

  const authType = host.authType;
  if (authType === "key" && host.key?.trim()) {
    const cleanKey = host.key
      .trim()
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
    config.privateKey = Buffer.from(cleanKey, "utf8");
    if (host.keyPassword) config.passphrase = host.keyPassword;
  } else if (authType === "password") {
    if (!host.password) {
      throw new Error("Password required for transfer connection");
    }
    config.password = host.password;
  } else if (authType === "opkssh") {
    const { getOPKSSHToken } = await import("../opkssh-auth.js");
    const token = await getOPKSSHToken(userId, host.id);
    if (!token) {
      throw new Error(
        "OPKSSH authentication required. Open a Terminal connection to this host first.",
      );
    }
    const { setupOPKSSHCertAuth } = await import("../opkssh-cert-auth.js");
    await setupOPKSSHCertAuth(config, client, token, username);
  } else if (authType === "agent") {
    const result = await applyAgentAuth(
      config,
      host.terminalConfig as unknown as Record<string, unknown> | undefined,
    );
    if ("error" in result) throw new Error(result.error);
  } else if (authType !== "none" && authType !== "tailscale") {
    throw new Error(`Unsupported auth type for transfer: ${authType}`);
  }

  return config;
}

export function attachDedicatedKeyboardInteractive(
  client: SSHClient,
  host: SSHHost,
): void {
  client.on(
    "keyboard-interactive",
    (
      _name: string,
      _instructions: string,
      _instructionsLang: string,
      prompts: Array<{ prompt: string; echo: boolean }>,
      finish: (responses: string[]) => void,
    ) => {
      finish(
        prompts.map((prompt) =>
          /password/i.test(prompt.prompt) && host.password ? host.password : "",
        ),
      );
    },
  );
}

export async function startDedicatedTransferConnect(
  client: SSHClient,
  config: ConnectConfig,
  host: SSHHost,
  userId: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const proxyConfig: SOCKS5Config | null =
    host.useSocks5 &&
    (host.socks5Host ||
      (host.socks5ProxyChain && host.socks5ProxyChain.length > 0))
      ? {
          useSocks5: host.useSocks5,
          socks5Host: host.socks5Host,
          socks5Port: host.socks5Port,
          socks5Username: host.socks5Username,
          socks5Password: host.socks5Password,
          socks5ProxyChain: host.socks5ProxyChain,
        }
      : null;

  if (host.jumpHosts?.length) {
    const jumpClient = await waitForAbortableResource(
      createJumpHostChain(host.jumpHosts, userId, proxyConfig),
      signal,
      (lateClient) => lateClient?.end(),
    );
    if (!jumpClient) {
      throw new Error("Failed to connect through jump hosts for transfer");
    }
    if (signal?.aborted) {
      jumpClient.end();
      throw abortReason(signal);
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let jumpClosed = false;
      const closeJump = () => {
        if (jumpClosed) return;
        jumpClosed = true;
        jumpClient.end();
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => {
        closeJump();
        finish(abortReason(signal!));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        jumpClient.forwardOut(
          "127.0.0.1",
          0,
          host.ip,
          host.port,
          (error, stream) => {
            if (error) {
              closeJump();
              finish(
                new Error(
                  `Failed to forward through jump host for transfer: ${error.message}`,
                ),
              );
              return;
            }
            if (signal?.aborted) {
              stream.destroy();
              closeJump();
              finish(abortReason(signal));
              return;
            }
            config.sock = stream;
            client.once("close", closeJump);
            try {
              client.connect(config);
              finish();
            } catch (error) {
              stream.destroy();
              closeJump();
              finish(error instanceof Error ? error : new Error(String(error)));
            }
          },
        );
      } catch (error) {
        closeJump();
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return;
  }

  if (proxyConfig) {
    const proxySocket = await waitForAbortableResource(
      createSocks5Connection(host.ip, host.port, proxyConfig),
      signal,
      (lateSocket) => lateSocket?.destroy(),
    );
    if (!proxySocket) {
      throw new Error("Failed to connect through SOCKS5 proxy for transfer");
    }
    if (signal?.aborted) {
      proxySocket.destroy();
      throw abortReason(signal);
    }
    config.sock = proxySocket;
    try {
      client.connect(config);
    } catch (error) {
      proxySocket.destroy();
      throw error;
    }
    return;
  }

  throwIfAborted(signal);
  client.connect(config);
}
