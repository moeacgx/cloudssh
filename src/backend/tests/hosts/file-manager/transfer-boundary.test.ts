import { describe, expect, it, vi } from "vitest";
import { networkInterfaces } from "node:os";
import {
  getTransferStatus,
  startHostTransfer,
  type HostTransferDeps,
  type SSHSessionLike,
} from "../../../hosts/file-manager/transfer-engine.js";

vi.mock("../../../utils/logger.js", () => ({
  fileLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

const localIp = Object.values(networkInterfaces())
  .flat()
  .find(
    (entry) => entry && !entry.internal && entry.family === "IPv4",
  )?.address;

describe("主机传输的远端文件系统边界", () => {
  it.each([
    "127.0.0.1",
    "localhost",
    "[::1]",
    "192.0.2.10",
    ...(localIp ? [localIp] : []),
  ])("目标 %s 必须经已授权的目标 SFTP 写入，禁止本地落盘", async (ip) => {
    const bytes = Buffer.from("isolated-transfer-fixture");
    const received: Buffer[] = [];
    const stat = {
      size: bytes.length,
      isFile: () => true,
      isDirectory: () => false,
    };
    const source = {
      stat: vi.fn((_path, cb) => cb(null, stat)),
      open: vi.fn((_path, _flags, _mode, cb) => cb(null, Buffer.from("src"))),
      close: vi.fn((_handle, cb) => cb(null)),
      read: vi.fn((_handle, buffer, offset, length, position, cb) => {
        const count = bytes.copy(buffer, offset, position, position + length);
        cb(null, count, buffer);
      }),
      // 不执行真实本地写入，仅记录是否触发了危险的 fastGet 分支。
      fastGet: vi.fn((_source, _dest, _options, cb) => cb(null)),
    };
    const destination = {
      stat: vi.fn((_path, cb) => cb(new Error("No such file"))),
      open: vi.fn((_path, _flags, _mode, cb) => cb(null, Buffer.from("dst"))),
      close: vi.fn((_handle, cb) => cb(null)),
      write: vi.fn((_handle, buffer, offset, length, _position, cb) => {
        received.push(Buffer.from(buffer.subarray(offset, offset + length)));
        cb(null);
      }),
    };
    const makeSession = (sftp: unknown, address: string): SSHSessionLike => ({
      client: {} as never,
      isConnected: true,
      lastActive: Date.now(),
      activeOperations: 0,
      userId: "user-a",
      ip: address,
      transferPlatform: "unix",
      sftp: sftp as never,
      channelOpener: { run: (action) => action() },
    });
    const sourceSession = makeSession(source, "192.0.2.20");
    const destSession = makeSession(destination, ip);
    const deps: HostTransferDeps = {
      sshSessions: { source: sourceSession, destination: destSession },
      getSessionSftp: async (session) => session.sftp!,
      verifySessionOwnership: (session, userId) => session.userId === userId,
      openDedicatedTransferSession: vi.fn(async (id) =>
        id === "source" ? sourceSession : destSession,
      ),
      closeDedicatedTransferSession: vi.fn(),
      execChannel: vi.fn(),
    };
    const { transferId } = startHostTransfer(deps, {
      sourceSessionId: "source",
      destSessionId: "destination",
      sourcePaths: ["/source-fixture"],
      destPath: "/target-fixture",
      userId: "user-a",
      parallelSegmentCount: 1,
    });
    await vi.waitFor(() =>
      expect(getTransferStatus(transferId, "user-a")?.status).toBe("success"),
    );
    expect(source.fastGet).not.toHaveBeenCalled();
    expect(destination.open).toHaveBeenCalledWith(
      "/target-fixture",
      expect.anything(),
      expect.anything(),
      expect.any(Function),
    );
    expect(Buffer.concat(received)).toEqual(bytes);
  });
});
