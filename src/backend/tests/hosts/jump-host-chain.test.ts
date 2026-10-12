import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  findHostOwnerId: vi.fn(),
  findHostById: vi.fn(),
  credential: vi.fn(),
  secret: vi.fn(),
  projectCredential: vi.fn(),
  connect: vi.fn(),
}));
vi.mock("../../database/repositories/factory.js", () => ({
  createCurrentHostResolutionRepository: () => ({
    findHostOwnerId: mocks.findHostOwnerId,
    findHostById: mocks.findHostById,
    findCredentialByIdForUser: mocks.credential,
    findOverrideCredentialId: async () => null,
  }),
}));
vi.mock("../../utils/permission-manager.js", () => ({
  PermissionManager: { getInstance: () => ({ canAccessHost: mocks.access }) },
}));
vi.mock("../../control-plane/factory.js", () => ({
  createCurrentProjectCredentialRepository: async () => ({
    resolveForProjectHost: mocks.projectCredential,
  }),
}));
vi.mock("../../utils/shared-host-secrets-manager.js", () => ({
  SharedHostSecretsManager: {
    getInstance: () => ({ getSecretForUser: mocks.secret }),
  },
}));
vi.mock("../../utils/audit-logger.js", () => ({ logAuditOrThrow: vi.fn() }));
vi.mock("../../utils/database-save-trigger.js", () => ({
  DatabaseSaveTrigger: { forceSave: vi.fn() },
}));
vi.mock("../../utils/logger.js", () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
  fileLogger: { warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../utils/socks5-helper.js", () => ({
  createSocks5Connection: vi.fn(),
}));
vi.mock("../../hosts/terminal-auth-helpers.js", () => ({
  applyAgentAuth: vi.fn(),
}));
vi.mock("../../hosts/host-key-verifier.js", () => ({
  SSHHostKeyVerifier: { createHostVerifier: async () => () => true },
}));
vi.mock("ssh2", () => ({
  Client: class {
    handlers = new Map<string, (...args: unknown[]) => void>();
    on(event: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(event, handler);
      return this;
    }
    connect(config: unknown) {
      mocks.connect(config);
      this.handlers.get("ready")?.();
    }
    forwardOut(
      _src: string,
      _srcPort: number,
      _dest: string,
      _destPort: number,
      callback: (error: null, stream: object) => void,
    ) {
      callback(null, {});
    }
    end() {}
  },
}));

import { createJumpHostChain } from "../../hosts/jump-host-chain.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.mockResolvedValue({ hasAccess: false });
  mocks.findHostOwnerId.mockResolvedValue("victim");
  mocks.findHostById.mockImplementation(async () => ({
    id: 9,
    userId: "victim",
    ip: "10.0.0.9",
    port: 22,
    username: "root",
    authType: "password",
    credentialId: 99,
  }));
  mocks.credential.mockResolvedValue({
    authType: "password",
    password: "victim-password",
  });
  mocks.secret.mockResolvedValue(null);
  mocks.projectCredential.mockResolvedValue(null);
});

describe("跳板主机授权", () => {
  it("没有连接权限时，在读取所有者和解密凭据前拒绝", async () => {
    expect(await createJumpHostChain([{ hostId: 9 }], "attacker")).toBeNull();
    expect(mocks.access).toHaveBeenCalledWith(
      "attacker",
      9,
      "connect",
      undefined,
    );
    expect(mocks.findHostOwnerId).not.toHaveBeenCalled();
    expect(mocks.findHostById).not.toHaveBeenCalled();
    expect(mocks.credential).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it("共享凭据缺失时不能退回读取所有者凭据", async () => {
    mocks.access.mockResolvedValue({ hasAccess: true, isShared: true });
    expect(await createJumpHostChain([{ hostId: 9 }], "recipient")).toBeNull();
    expect(mocks.credential).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it("合法共享连接使用接收者快照", async () => {
    mocks.access.mockResolvedValue({ hasAccess: true, isShared: true });
    mocks.secret.mockResolvedValue({ password: "shared-password" });
    expect(
      await createJumpHostChain([{ hostId: 9 }], "recipient"),
    ).not.toBeNull();
    expect(mocks.connect).toHaveBeenCalledWith(
      expect.objectContaining({ password: "shared-password" }),
    );
    expect(mocks.credential).not.toHaveBeenCalled();
  });
  it("合法项目成员使用项目凭据", async () => {
    mocks.access.mockResolvedValue({
      hasAccess: true,
      isShared: true,
      projectHostId: 7,
      projectId: "team",
    });
    mocks.projectCredential.mockResolvedValue({
      projectId: "team",
      hostId: 9,
      address: "10.1.1.9",
      port: 2222,
      username: "operator",
      authType: "password",
      secret: { password: "project-password" },
    });
    expect(
      await createJumpHostChain([{ hostId: 9 }], "operator"),
    ).not.toBeNull();
    expect(mocks.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "10.1.1.9",
        username: "operator",
        password: "project-password",
      }),
    );
    expect(mocks.credential).not.toHaveBeenCalled();
  });
  it("所有者仍可使用自己的凭据", async () => {
    mocks.access.mockResolvedValue({ hasAccess: true, isOwner: true });
    expect(await createJumpHostChain([{ hostId: 9 }], "victim")).not.toBeNull();
    expect(mocks.connect).toHaveBeenCalledWith(
      expect.objectContaining({ password: "victim-password" }),
    );
  });
  it("共享授权撤销后重新连接不复用旧授权", async () => {
    mocks.access.mockResolvedValueOnce({ hasAccess: true, isShared: true });
    mocks.secret.mockResolvedValue({ password: "shared-password" });
    expect(
      await createJumpHostChain([{ hostId: 9 }], "recipient"),
    ).not.toBeNull();
    mocks.connect.mockClear();
    mocks.findHostById.mockClear();
    expect(await createJumpHostChain([{ hostId: 9 }], "recipient")).toBeNull();
    expect(mocks.findHostById).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it("共享快照读取失败时拒绝回退所有者凭据", async () => {
    mocks.access.mockResolvedValue({ hasAccess: true, isShared: true });
    mocks.secret.mockRejectedValueOnce(new Error("snapshot unavailable"));
    expect(await createJumpHostChain([{ hostId: 9 }], "recipient")).toBeNull();
    expect(mocks.credential).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it("多跳链中任一跳拒绝授权时不建立任何连接", async () => {
    mocks.access
      .mockResolvedValueOnce({ hasAccess: true, isOwner: true })
      .mockResolvedValueOnce({ hasAccess: false });
    expect(
      await createJumpHostChain([{ hostId: 9 }, { hostId: 10 }], "victim"),
    ).toBeNull();
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
