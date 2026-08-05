import {
  normalizePortKnockSequence,
  type PortKnockStep,
} from "../port-knock-sequence.js";

export interface TerminalConnectionMaterialSource {
  ip: string;
  port: number;
  username: string;
  authType?: string;
  password?: string;
  key?: string;
  keyPassword?: string;
  keyType?: string;
  certPublicKey?: string;
  forceKeyboardInteractive?: boolean | string | number | null;
  useWarpgate?: boolean;
  jumpHosts?: ReadonlyArray<{ hostId: number }>;
  useSocks5?: boolean;
  socks5Host?: string;
  socks5Port?: number;
  socks5Username?: string;
  socks5Password?: string;
  socks5ProxyChain?: unknown;
  portKnockSequence?: ReadonlyArray<PortKnockStep> | string | null;
  terminalConfig?: Readonly<Record<string, unknown>>;
  enableSessionLogging?: boolean;
}

export type TerminalCredentialOverride =
  | { kind: "password"; password: string }
  | {
      kind: "key";
      key: string;
      keyPassword?: string;
      keyType?: string;
    }
  | { kind: "passphrase"; keyPassword: string };

export interface TerminalConnectionMaterial {
  target: {
    ip: string;
    port: number;
  };
  auth: {
    username: string;
    authType: string;
    password?: string;
    key?: string;
    keyPassword?: string;
    keyType?: string;
    certPublicKey?: string;
    forceKeyboardInteractive?: boolean;
    useWarpgate?: boolean;
  };
  runtime: {
    jumpHosts?: Array<{ hostId: number }>;
    useSocks5?: boolean;
    socks5Host?: string;
    socks5Port?: number;
    socks5Username?: string;
    socks5Password?: string;
    socks5ProxyChain?: unknown;
    portKnockSequence?: PortKnockStep[];
    terminalConfig?: Record<string, unknown>;
    enableSessionLogging?: boolean;
  };
}

export interface ResolveTerminalConnectionMaterialInput {
  connectionMode: "saved-host" | "quick-connect";
  clientHost: Readonly<TerminalConnectionMaterialSource>;
  authoritativeHost?: Readonly<TerminalConnectionMaterialSource> | null;
  credentialOverride?: Readonly<TerminalCredentialOverride> | null;
}

function baseAuth(
  source: Readonly<TerminalConnectionMaterialSource>,
): TerminalConnectionMaterial["auth"] {
  return {
    username: source.username,
    authType: source.authType || "none",
    password: source.password,
    key: source.key,
    keyPassword: source.keyPassword,
    keyType: source.keyType,
    certPublicKey: source.certPublicKey,
    // 旧数据库把该开关保存为 "true"/"false" 文本。不能直接依赖
    // JavaScript 真值，否则 "false" 也会跳过密码并强制键盘交互认证。
    forceKeyboardInteractive:
      source.forceKeyboardInteractive === true ||
      source.forceKeyboardInteractive === "true" ||
      source.forceKeyboardInteractive === 1,
    useWarpgate: source.useWarpgate,
  };
}

function applyCredentialOverride(
  auth: TerminalConnectionMaterial["auth"],
  override: Readonly<TerminalCredentialOverride> | null | undefined,
): TerminalConnectionMaterial["auth"] {
  if (!override) return auth;

  switch (override.kind) {
    case "password":
      return {
        username: auth.username,
        authType: "password",
        password: override.password,
        forceKeyboardInteractive: auth.forceKeyboardInteractive,
        useWarpgate: auth.useWarpgate,
      };
    case "key":
      return {
        username: auth.username,
        authType: "key",
        key: override.key,
        keyPassword: override.keyPassword,
        keyType: override.keyType,
        forceKeyboardInteractive: auth.forceKeyboardInteractive,
        useWarpgate: auth.useWarpgate,
      };
    case "passphrase":
      if (!auth.key) {
        throw new Error("SSH key is required for a passphrase override");
      }
      return { ...auth, keyPassword: override.keyPassword };
  }
}

/**
 * 生成单次 SSH 连接使用的材料。有服务端权威主机时，浏览器携带的目标、
 * 凭据和运行参数全部失效；交互式凭据只能通过本函数的内部判别联合临时覆盖。
 */
export function resolveTerminalConnectionMaterial(
  input: ResolveTerminalConnectionMaterialInput,
): TerminalConnectionMaterial {
  if (input.connectionMode === "saved-host" && !input.authoritativeHost) {
    throw new Error("Authoritative host data is required for a saved host");
  }
  const source =
    input.connectionMode === "saved-host"
      ? input.authoritativeHost!
      : input.clientHost;
  const auth = applyCredentialOverride(
    baseAuth(source),
    input.credentialOverride,
  );

  return {
    target: {
      ip: source.ip.replace(/^\[|\]$/g, "").trim(),
      port: source.port,
    },
    auth,
    runtime: {
      jumpHosts: source.jumpHosts?.map((host) => ({ ...host })),
      useSocks5: source.useSocks5,
      socks5Host: source.socks5Host,
      socks5Port: source.socks5Port,
      socks5Username: source.socks5Username,
      socks5Password: source.socks5Password,
      socks5ProxyChain: source.socks5ProxyChain,
      portKnockSequence: normalizePortKnockSequence(source.portKnockSequence),
      terminalConfig: source.terminalConfig
        ? { ...source.terminalConfig }
        : undefined,
      enableSessionLogging: source.enableSessionLogging,
    },
  };
}
