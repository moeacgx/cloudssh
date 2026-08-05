import type { SSHHostWithStatus } from "@/main-axios";
import type { Host, Credential } from "@/types/ui-types";

type RawSSHHost = SSHHostWithStatus & {
  hasPassword?: boolean;
  hasKey?: boolean;
  hasKeyPassword?: boolean;
  hasRdpPassword?: boolean;
  hasVncPassword?: boolean;
  hasTelnetPassword?: boolean;
  linkedProjectCount?: number;
  canDeleteFromAllProjects?: boolean;
};
type HostQuickAction = Host["quickActions"][number];
type HostJumpHost = NonNullable<Host["jumpHosts"]>[number];
type RawCredential = {
  id: number | string;
  name: string;
  username: string;
  authType?: string;
  description?: string | null;
  folder?: string | null;
  tags?: string[];
  publicKey?: string | null;
  password?: string | null;
  key?: string | null;
  keyPassword?: string | null;
  hasKey?: boolean;
  hasKeyPassword?: boolean;
};

function parseJson<T>(v: unknown): T | undefined {
  if (!v) return undefined;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return undefined;
    }
  }
  return v as T;
}

function parseJsonArray<T>(value: unknown): T[] {
  const parsed = parseJson<unknown>(value);
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

export function createHostManagerEditEvent(host: Host): CustomEvent<Host> {
  return new CustomEvent("host-manager:edit-host", { detail: host });
}

export function sshHostToHost(h: RawSSHHost): Host {
  const host = h;
  const isSshHost = h.connectionType === "ssh" || !h.connectionType;
  return {
    id: String(h.id),
    projectHostId:
      h.projectHostId != null ? String(h.projectHostId) : undefined,
    sourceName: h.sourceName,
    sourceFolder: h.sourceFolder,
    name: h.name,
    username: h.username,
    ip: h.ip,
    port: h.port,
    folder: h.folder ?? "",
    online: h.status === "online",
    cpu: null,
    ram: null,
    lastAccess: "",
    tags: h.tags ?? [],
    networkInfo: h.networkInfo ?? null,
    authType: h.authType,
    password: h.password,
    hasPassword: !!host.hasPassword || !!h.password,
    hasKey: !!host.hasKey || !!(typeof h.key === "string" && h.key),
    hasKeyPassword: !!host.hasKeyPassword || !!h.keyPassword,
    key: typeof h.key === "string" ? h.key : undefined,
    keyPassword: h.keyPassword,
    keyType: h.keyType,
    credentialId: h.credentialId != null ? String(h.credentialId) : undefined,
    vaultProfileId:
      (h as { vaultProfileId?: number | string | null }).vaultProfileId != null
        ? String((h as { vaultProfileId?: number | string }).vaultProfileId)
        : undefined,
    notes: h.notes,
    pin: h.pin ?? false,
    macAddress: h.macAddress,
    enableSsh: h.enableSsh != null ? h.enableSsh : isSshHost,
    enableTerminal:
      h.enableTerminal ?? (h.enableSsh != null ? h.enableSsh : isSshHost),
    enableSessionLogging: h.enableSessionLogging ?? true,
    enableCommandHistory: h.enableCommandHistory ?? true,
    enableTunnel: h.enableTunnel ?? false,
    enableFileManager: h.enableFileManager ?? true,
    enableDocker: h.enableDocker ?? false,
    enableProxmox: h.enableProxmox ?? false,
    enableTmuxMonitor: h.enableTmuxMonitor ?? false,
    proxmoxConfig: h.proxmoxConfig ?? null,
    enableRdp: h.enableRdp != null ? h.enableRdp : h.connectionType === "rdp",
    enableVnc: h.enableVnc != null ? h.enableVnc : h.connectionType === "vnc",
    enableTelnet:
      h.enableTelnet != null ? h.enableTelnet : h.connectionType === "telnet",
    sshPort:
      h.sshPort ??
      (h.connectionType === "ssh" || !h.connectionType ? h.port : 22),
    rdpPort: h.rdpPort ?? (h.connectionType === "rdp" ? h.port : 3389),
    vncPort: h.vncPort ?? (h.connectionType === "vnc" ? h.port : 5900),
    telnetPort: h.telnetPort ?? (h.connectionType === "telnet" ? h.port : 23),
    rdpAuthType:
      (h.rdpAuthType as "direct" | "credential") ??
      (h.rdpCredentialId ? "credential" : "direct"),
    rdpCredentialId:
      h.rdpCredentialId != null ? String(h.rdpCredentialId) : undefined,
    rdpUser: h.rdpUser,
    rdpPassword: h.rdpPassword ?? "",
    hasRdpPassword: !!host.hasRdpPassword || !!h.rdpPassword,
    domain: h.rdpDomain,
    security: h.rdpSecurity,
    ignoreCert: h.rdpIgnoreCert ?? false,
    vncAuthType:
      (h.vncAuthType as "direct" | "credential") ??
      (h.vncCredentialId ? "credential" : "direct"),
    vncCredentialId:
      h.vncCredentialId != null ? String(h.vncCredentialId) : undefined,
    vncPassword: h.vncPassword ?? "",
    hasVncPassword: !!host.hasVncPassword || !!h.vncPassword,
    vncUser: h.vncUser,
    telnetAuthType:
      (h.telnetAuthType as "direct" | "credential") ??
      (h.telnetCredentialId ? "credential" : "direct"),
    telnetCredentialId:
      h.telnetCredentialId != null ? String(h.telnetCredentialId) : undefined,
    telnetUser: h.telnetUser,
    telnetPassword: h.telnetPassword ?? "",
    hasTelnetPassword: !!host.hasTelnetPassword || !!h.telnetPassword,
    quickActions: (h.quickActions ?? []).map((a: HostQuickAction) => ({
      name: a.name,
      snippetId: String(a.snippetId),
    })),
    serverTunnels: parseJson(h.tunnelConnections) ?? [],
    jumpHosts: (parseJson<HostJumpHost[]>(h.jumpHosts) ?? []).map((j) => ({
      hostId: String(j.hostId ?? j.hostid ?? j),
    })),
    portKnockSequence: parseJsonArray(h.portKnockSequence),
    defaultPath: h.defaultPath,
    terminalConfig: parseJson(h.terminalConfig) as Host["terminalConfig"],
    statsConfig: parseJson(h.statsConfig) as Host["statsConfig"],
    guacamoleConfig: parseJson(h.guacamoleConfig),
    forceKeyboardInteractive: h.forceKeyboardInteractive ?? false,
    useSocks5: h.useSocks5,
    socks5Host: h.socks5Host,
    socks5Port: h.socks5Port,
    socks5Username: h.socks5Username,
    socks5Password: h.socks5Password,
    socks5ProxyChain: parseJson(h.socks5ProxyChain) ?? [],
    overrideCredentialUsername: h.overrideCredentialUsername ?? false,
    isShared: h.isShared ?? false,
    permissionLevel: h.permissionLevel,
    sharedExpiresAt: h.sharedExpiresAt,
    ownerUsername: h.ownerUsername,
    linkedProjectCount: host.linkedProjectCount ?? 1,
    // 旧版接口没有该字段时，沿用原有的所有者/共享判断；真正的权限仍由后端校验。
    canDeleteFromAllProjects: host.canDeleteFromAllProjects ?? !h.isShared,
  };
}

export function mapCredentials(res: unknown): Credential[] {
  const arr = Array.isArray(res) ? res : [];
  return (arr as RawCredential[]).map((c) => ({
    id: String(c.id),
    name: c.name,
    username: c.username,
    type: c.authType === "key" ? "key" : "password",
    description: c.description ?? "",
    folder: c.folder ?? "",
    tags: c.tags ?? [],
    publicKey: c.publicKey ?? undefined,
  }));
}

export function mapCredentialDetails(res: unknown): Credential {
  const raw = res as RawCredential;
  const credential = mapCredentials([raw])[0];
  if (!credential) {
    throw new Error("Credential details are invalid");
  }

  return {
    ...credential,
    value:
      raw.authType === "key"
        ? raw.key || (raw.hasKey ? "existing_key" : "")
        : (raw.password ?? ""),
    password: raw.password ?? "",
    passphrase:
      raw.keyPassword || (raw.hasKeyPassword ? "existing_key_password" : ""),
  };
}
