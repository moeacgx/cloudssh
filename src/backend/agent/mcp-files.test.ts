import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpFileTransfers, MCP_FILE_LIMITS } from "./mcp-files.js";
import type { AgentFileService } from "./files.js";
import type { AgentPrincipal } from "./types.js";

const principal: AgentPrincipal = {
  principalId: "key-1",
  serviceAccountId: "user-1",
  projectId: "project-1",
  scopes: ["files:read", "files:write"],
  serverIds: ["server-1"],
  name: "key",
  maxConcurrentSessions: 1,
};
const bytes = Buffer.from([0, 255, 128, 13, 10, 0, 42]);
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const managers: McpFileTransfers[] = [];
function setup(data = bytes) {
  let stored = Buffer.alloc(0);
  const upload = vi.fn<AgentFileService["upload"]>(
    async (_p, serverId, path, source, _id, _signal, committed) => {
      const chunks: Buffer[] = [];
      for await (const chunk of Buffer.isBuffer(source)
        ? Readable.from([source])
        : source.openStream())
        chunks.push(Buffer.from(chunk));
      stored = Buffer.concat(chunks);
      committed?.();
      return { serverId, path, size: stored.length };
    },
  );
  const download = vi.fn<AgentFileService["download"]>(
    async (_p, serverId, path, open) => {
      const info = { serverId, path, size: data.length };
      await pipeline(Readable.from([data]), open(info));
      return info;
    },
  );
  const manager = new McpFileTransfers({
    upload,
    download,
  } as unknown as AgentFileService);
  managers.push(manager);
  const args = {
    serverId: "server-1",
    path: "/tmp/binary",
    request_id: "upload-1",
    size: bytes.length,
    sha256: sha(bytes),
    offset: 0,
    dataBase64: bytes.toString("base64"),
    finalize: true,
  };
  return { manager, args, upload, download, stored: () => stored };
}
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close();
});

describe("MCP binary staging", () => {
  it.each(["expiry", "restart"])(
    "reports committed persistent replay after %s",
    async (reset) => {
      const { manager, args, upload } = setup();
      const committed = vi.fn();
      await manager.upload(principal, args, committed);
      expect(committed).toHaveBeenCalledTimes(1);
      let replayManager = manager;
      if (reset === "expiry")
        await manager.cleanup(Date.now() + MCP_FILE_LIMITS.ttlMs + 1);
      else {
        await manager.close();
        replayManager = new McpFileTransfers({
          upload,
        } as unknown as AgentFileService);
        managers.push(replayManager);
      }
      // The persisted success branch returns without invoking the commit callback.
      upload.mockResolvedValueOnce({
        serverId: args.serverId,
        path: args.path,
        size: args.size,
      });
      committed.mockClear();
      await expect(
        replayManager.upload(principal, args, committed),
      ).resolves.toMatchObject({ complete: true });
      expect(committed).toHaveBeenCalledTimes(1);
    },
  );
  it("retains early commit notification when persistence fails after remote commit", async () => {
    const { manager, args, upload } = setup();
    const committed = vi.fn();
    upload.mockImplementationOnce(
      async (_p, _s, _path, _data, _id, _signal, notify) => {
        notify?.();
        throw new Error("persist failed after rename");
      },
    );
    await expect(manager.upload(principal, args, committed)).rejects.toThrow(
      "persist failed after rename",
    );
    expect(committed).toHaveBeenCalledTimes(1);
  });
  it("rejects concurrent finalization and preserves committed bytes on replay", async () => {
    const { manager, args, upload } = setup();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    upload.mockImplementationOnce(
      async (_p, serverId, path, _source, _id, _signal, committed) => {
        entered();
        await gate;
        committed?.();
        return { serverId, path, size: bytes.length };
      },
    );
    const first = manager.upload(principal, args);
    await started;
    try {
      await expect(manager.upload(principal, args)).rejects.toMatchObject({
        code: "TRANSFER_BUSY",
      });
      await manager.cleanup(Date.now() + MCP_FILE_LIMITS.ttlMs + 1);
    } finally {
      release();
    }
    await first;
    await expect(manager.upload(principal, args)).resolves.toMatchObject({
      complete: true,
    });
    expect(upload).toHaveBeenCalledTimes(1);
  });
  it("retains staging after uncertain SFTP failure and retries with the same idempotency key", async () => {
    const { manager, args, upload, stored } = setup();
    upload.mockRejectedValueOnce(new Error("SFTP disconnected"));
    await expect(manager.upload(principal, args)).rejects.toThrow(
      "SFTP disconnected",
    );
    await expect(manager.upload(principal, args)).resolves.toMatchObject({
      complete: true,
    });
    expect(upload.mock.calls.map((call) => call[4])).toEqual([
      args.request_id,
      args.request_id,
    ]);
    expect(stored()).toEqual(bytes);
  });
  it("accepts exactly 64 MiB and rejects a growing download beyond the cap without retaining slots", async () => {
    const data = Buffer.alloc(MCP_FILE_LIMITS.fileBytes, 0xa5);
    const { manager, download } = setup(data);
    const target = {
      serverId: "server-1",
      path: "/large",
      offset: 0,
      length: MCP_FILE_LIMITS.chunkBytes,
    };
    const first = await manager.download(principal, target);
    const last = await manager.download(principal, {
      ...target,
      transferId: first.transferId,
      offset: data.length - MCP_FILE_LIMITS.chunkBytes,
    });
    expect(first.sha256).toBe(sha(data));
    expect(last).toMatchObject({
      eof: true,
      size: data.length,
      nextOffset: data.length,
    });
    download.mockImplementation(async (_p, serverId, path, open) => {
      const info = { serverId, path, size: data.length };
      await pipeline(Readable.from([data, Buffer.from([1])]), open(info));
      return { ...info, size: data.length + 1 };
    });
    for (let i = 0; i < MCP_FILE_LIMITS.perPrincipal + 1; i++) {
      await expect(manager.download(principal, target)).rejects.toMatchObject({
        code: "FILE_TOO_LARGE",
      });
    }
  });
  it("assembles binary chunks, accepts exact retries and finalizes only once", async () => {
    const { manager, args, upload, stored } = setup();
    const first = {
      ...args,
      dataBase64: bytes.subarray(0, 3).toString("base64"),
      finalize: false,
    };
    expect(await manager.upload(principal, first)).toMatchObject({
      nextOffset: 3,
      complete: false,
    });
    await manager.upload(principal, first);
    expect(upload).not.toHaveBeenCalled();
    const last = {
      ...args,
      offset: 3,
      dataBase64: bytes.subarray(3).toString("base64"),
    };
    expect(await manager.upload(principal, last)).toMatchObject({
      complete: true,
      sha256: sha(bytes),
    });
    await manager.upload(principal, last);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(stored()).toEqual(bytes);
    expect(upload.mock.calls[0][4]).toBe(args.request_id);
  });
  it("rejects gaps, conflicting bytes, metadata changes and invalid checksums", async () => {
    const { manager, args, upload } = setup();
    await expect(
      manager.upload(principal, { ...args, offset: 1 }),
    ).rejects.toMatchObject({ code: "INVALID_OFFSET" });
    await manager.upload(principal, { ...args, finalize: false });
    await expect(
      manager.upload(principal, {
        ...args,
        dataBase64: Buffer.alloc(bytes.length).toString("base64"),
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      manager.upload(principal, { ...args, path: "/elsewhere" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      manager.upload(principal, {
        ...args,
        request_id: "bad-sha",
        sha256: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH" });
    expect(upload).not.toHaveBeenCalled();
  });
  it("rejects malformed Base64 and file/chunk overflow before SFTP", async () => {
    const { manager, args, upload } = setup();
    for (const dataBase64 of ["%%%", "Zg", "Zh==", " Zg=="]) {
      await expect(
        manager.upload(principal, { ...args, dataBase64 }),
      ).rejects.toMatchObject({ code: "INVALID_BASE64" });
    }
    await expect(
      manager.upload(principal, { ...args, size: 64 * 1024 * 1024 + 1 }),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    await expect(
      manager.upload(principal, {
        ...args,
        dataBase64: Buffer.alloc(MCP_FILE_LIMITS.chunkBytes + 1).toString(
          "base64",
        ),
      }),
    ).rejects.toMatchObject({ code: "CHUNK_TOO_LARGE" });
    expect(upload).not.toHaveBeenCalled();
  });
  it("downloads a stable binary snapshot and rejects foreign keys and changed grants", async () => {
    const { manager, download } = setup();
    const args = {
      serverId: "server-1",
      path: "/tmp/binary",
      offset: 0,
      length: 3,
    };
    const first = await manager.download(principal, args);
    const second = await manager.download(principal, {
      ...args,
      transferId: first.transferId,
      offset: 3,
      length: 256,
    });
    expect(
      Buffer.concat([
        Buffer.from(first.dataBase64, "base64"),
        Buffer.from(second.dataBase64, "base64"),
      ]),
    ).toEqual(bytes);
    expect(second).toMatchObject({
      eof: true,
      size: bytes.length,
      sha256: sha(bytes),
      nextOffset: bytes.length,
    });
    expect(download).toHaveBeenCalledTimes(1);
    await expect(
      manager.download(
        { ...principal, principalId: "other" },
        { ...args, transferId: first.transferId },
      ),
    ).rejects.toMatchObject({ code: "TRANSFER_NOT_FOUND" });
    await expect(
      manager.download(
        { ...principal, scopes: [] },
        { ...args, transferId: first.transferId },
      ),
    ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    await expect(
      manager.download(
        { ...principal, serverIds: [] },
        { ...args, transferId: first.transferId },
      ),
    ).rejects.toMatchObject({ code: "SERVER_DENIED" });
    await expect(
      manager.download(
        { ...principal, projectId: "project-2" },
        { ...args, transferId: first.transferId },
      ),
    ).rejects.toMatchObject({ code: "TRANSFER_NOT_FOUND" });
  });
  it("supports empty files and expires snapshots", async () => {
    const { manager, args } = setup(Buffer.alloc(0));
    await expect(
      manager.upload(principal, {
        ...args,
        size: 0,
        sha256: sha(Buffer.alloc(0)),
        dataBase64: "",
      }),
    ).resolves.toMatchObject({ complete: true, size: 0 });
    const first = await manager.download(principal, {
      serverId: args.serverId,
      path: args.path,
      offset: 0,
      length: 1,
    });
    expect(first).toMatchObject({
      eof: true,
      dataBase64: "",
      sha256: sha(Buffer.alloc(0)),
    });
    await manager.cleanup(Date.now() + MCP_FILE_LIMITS.ttlMs + 1);
    await expect(
      manager.download(principal, {
        serverId: args.serverId,
        path: args.path,
        transferId: first.transferId,
        offset: 0,
        length: 1,
      }),
    ).rejects.toMatchObject({ code: "TRANSFER_NOT_FOUND" });
  });
  it("bounds staging slots per principal and releases slots after errors", async () => {
    const { manager, args } = setup();
    for (let i = 0; i < MCP_FILE_LIMITS.perPrincipal; i++)
      await manager.upload(principal, {
        ...args,
        request_id: `u${i}`,
        finalize: false,
      });
    await expect(
      manager.upload(principal, { ...args, request_id: "extra" }),
    ).rejects.toMatchObject({ code: "TRANSFER_CAPACITY_EXCEEDED" });
    await manager.cleanup(Date.now() + MCP_FILE_LIMITS.ttlMs + 1);
    await expect(manager.upload(principal, args)).resolves.toMatchObject({
      complete: true,
    });
  });
});
