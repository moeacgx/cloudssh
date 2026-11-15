import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { AgentApiError } from "./errors.js";
import {
  AGENT_FILE_LIMITS,
  type AgentFileService,
  type AgentFileTransferResult,
} from "./files.js";
import type { AgentPrincipal, AgentScope } from "./types.js";

export const MCP_FILE_LIMITS = {
  chunkBytes: 256 * 1024,
  fileBytes: AGENT_FILE_LIMITS.maxTransferBytes,
  ttlMs: 10 * 60 * 1000,
  global: 16,
  perPrincipal: 4,
} as const;

export interface McpUploadArgs {
  serverId: string;
  path: string;
  request_id: string;
  size: number;
  sha256: string;
  offset: number;
  dataBase64: string;
  finalize: boolean;
}
export interface McpDownloadArgs {
  serverId: string;
  path: string;
  transferId?: string;
  offset: number;
  length: number;
}
interface Transfer {
  id: string;
  owner: string;
  project: string;
  serverId: string;
  path: string;
  kind: "upload" | "download";
  requestId?: string;
  size: number;
  sha256: string;
  received: number;
  touched: number;
  busy: boolean;
  directory: Promise<string>;
  result?: AgentFileTransferResult;
}
function fail(code: string, message: string, status = 400): never {
  throw new AgentApiError(status, code, message);
}
function authorize(
  principal: AgentPrincipal,
  serverId: string,
  scope: AgentScope,
) {
  if (!principal.scopes.includes(scope))
    fail("SCOPE_DENIED", `Missing scope: ${scope}`, 403);
  const project = principal.serverProjectIds?.[serverId] ?? principal.projectId;
  if (
    (!principal.serverIds.includes("*") &&
      !principal.serverIds.includes(serverId)) ||
    !(principal.projectIds ?? [principal.projectId]).includes(project)
  ) {
    fail("SERVER_DENIED", "Server is not authorized", 403);
  }
  return project;
}
function integer(value: number, max: number, code: string) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max)
    fail(code, "Value is outside the transfer limits");
}
async function digest(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** Bounded private disk staging; never accepts a client-local filesystem path. */
export class McpFileTransfers {
  private readonly entries = new Map<string, Transfer>();
  private readonly active = new Set<Promise<unknown>>();
  private closed = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly files: AgentFileService) {
    this.timer = setInterval(() => {
      void this.cleanup().catch(() => {
        /* Retain failed removals for the next cleanup. */
      });
    }, 60_000);
    this.timer.unref();
  }

  private reserve(
    principal: AgentPrincipal,
    project: string,
    args: { serverId: string; path: string },
    kind: Transfer["kind"],
  ): Transfer {
    if (this.closed)
      fail("TRANSFER_SERVICE_CLOSED", "Transfer service is stopping", 503);
    if (
      this.entries.size >= MCP_FILE_LIMITS.global ||
      [...this.entries.values()].filter(
        (entry) => entry.owner === principal.principalId,
      ).length >= MCP_FILE_LIMITS.perPrincipal
    ) {
      fail(
        "TRANSFER_CAPACITY_EXCEEDED",
        "Too many staged transfers; wait for expiry",
        429,
      );
    }
    const entry: Transfer = {
      id: randomUUID(),
      owner: principal.principalId,
      project,
      serverId: args.serverId,
      path: args.path,
      kind,
      size: 0,
      sha256: "",
      received: 0,
      touched: Date.now(),
      busy: false,
      directory: mkdtemp(join(tmpdir(), "cloudssh-mcp-")),
    };
    // Reserve capacity synchronously, before any filesystem or network await.
    this.entries.set(entry.id, entry);
    return entry;
  }

  private run<T>(entry: Transfer, operation: () => Promise<T>): Promise<T> {
    if (this.closed)
      fail("TRANSFER_SERVICE_CLOSED", "Transfer service is stopping", 503);
    if (entry.busy)
      fail("TRANSFER_BUSY", "Transfer in progress; retry the same chunk", 409);
    entry.busy = true;
    const pending = operation().finally(() => {
      entry.busy = false;
      entry.touched = Date.now();
      this.active.delete(pending);
    });
    this.active.add(pending);
    return pending;
  }

  private async remove(entry: Transfer) {
    const directory = await entry.directory.catch(() => null);
    if (directory) await rm(directory, { recursive: true, force: true });
    this.entries.delete(entry.id);
  }

  async cleanup(now = Date.now()) {
    for (const entry of this.entries.values()) {
      if (!entry.busy && now - entry.touched >= MCP_FILE_LIMITS.ttlMs) {
        entry.busy = true;
        try {
          await this.remove(entry);
        } finally {
          entry.busy = false;
        }
      }
    }
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await Promise.allSettled([...this.active]);
    for (const entry of this.entries.values()) await this.remove(entry);
  }

  async upload(
    principal: AgentPrincipal,
    args: McpUploadArgs,
    onCommitted?: () => void,
  ) {
    const project = authorize(principal, args.serverId, "files:write");
    integer(args.size, MCP_FILE_LIMITS.fileBytes, "FILE_TOO_LARGE");
    integer(args.offset, args.size, "INVALID_OFFSET");
    if (!/^[a-f0-9]{64}$/.test(args.sha256))
      fail("INVALID_CHECKSUM", "Expected lowercase SHA-256");
    if (args.dataBase64.length > Math.ceil(MCP_FILE_LIMITS.chunkBytes / 3) * 4)
      fail("CHUNK_TOO_LARGE", "Chunk exceeds 256 KiB");
    const data = Buffer.from(args.dataBase64, "base64");
    if (data.toString("base64") !== args.dataBase64)
      fail("INVALID_BASE64", "Expected canonical padded Base64");
    if (data.length > MCP_FILE_LIMITS.chunkBytes)
      fail("CHUNK_TOO_LARGE", "Chunk exceeds 256 KiB");
    if (args.offset + data.length > args.size)
      fail("INVALID_OFFSET", "Chunk exceeds declared size");
    let entry = [...this.entries.values()].find(
      (item) =>
        item.kind === "upload" &&
        item.owner === principal.principalId &&
        item.requestId === args.request_id,
    );
    if (
      entry &&
      Date.now() - entry.touched >= MCP_FILE_LIMITS.ttlMs &&
      !entry.busy
    ) {
      await this.cleanup();
      // Re-read after cleanup's await; another request may have reserved this ID.
      entry = [...this.entries.values()].find(
        (item) =>
          item.kind === "upload" &&
          item.owner === principal.principalId &&
          item.requestId === args.request_id,
      );
    }
    if (
      entry &&
      (entry.project !== project ||
        entry.serverId !== args.serverId ||
        entry.path !== args.path ||
        entry.size !== args.size ||
        entry.sha256 !== args.sha256)
    )
      fail(
        "IDEMPOTENCY_CONFLICT",
        "Transfer metadata differs from the original request",
        409,
      );
    if (!entry) {
      if (args.offset !== 0)
        fail(
          "INVALID_OFFSET",
          "Transfer expired or missing; restart at offset zero with the same request_id",
        );
      entry = this.reserve(principal, project, args, "upload");
      entry.requestId = args.request_id;
      entry.size = args.size;
      entry.sha256 = args.sha256;
    }
    const transfer = entry;
    return this.run(transfer, async () => {
      let file: string;
      try {
        file = join(await transfer.directory, "data");
      } catch (error) {
        await this.remove(transfer);
        throw error;
      }
      if (
        args.offset > transfer.received ||
        (args.offset < transfer.received &&
          args.offset + data.length > transfer.received)
      )
        fail(
          "INVALID_OFFSET",
          "Send contiguous chunks or retry an already received chunk",
        );
      const handle = await open(
        file,
        transfer.received === 0 ? "w+" : "r+",
        0o600,
      );
      try {
        if (args.offset < transfer.received) {
          const previous = Buffer.alloc(data.length);
          const { bytesRead } = await handle.read(
            previous,
            0,
            previous.length,
            args.offset,
          );
          if (bytesRead !== data.length || !previous.equals(data))
            fail("IDEMPOTENCY_CONFLICT", "Retried chunk differs", 409);
        } else {
          let written = 0;
          while (written < data.length) {
            const result = await handle.write(
              data,
              written,
              data.length - written,
              args.offset + written,
            );
            if (!result.bytesWritten)
              throw new Error("Staging write made no progress");
            written += result.bytesWritten;
          }
          transfer.received += data.length;
        }
      } finally {
        await handle.close();
      }
      if (args.finalize && !transfer.result) {
        if (transfer.received !== transfer.size)
          fail("UPLOAD_INCOMPLETE", "All bytes must be staged before finalize");
        if ((await digest(file)) !== transfer.sha256) {
          await this.remove(transfer);
          fail("CHECKSUM_MISMATCH", "Staged bytes do not match SHA-256");
        }
        let notified = false;
        const notifyCommitted = () => {
          if (notified) return;
          notified = true;
          onCommitted?.();
        };
        transfer.result = await this.files.upload(
          principal,
          args.serverId,
          args.path,
          {
            size: transfer.size,
            sha256: transfer.sha256,
            openStream: () => createReadStream(file),
          },
          args.request_id,
          undefined,
          notifyCommitted,
        );
        // Persisted success replays do not emit the live commit notification.
        notifyCommitted();
      } else if (args.finalize && transfer.result) onCommitted?.();
      return {
        ...transfer.result,
        size: transfer.size,
        sha256: transfer.sha256,
        nextOffset: transfer.received,
        complete: Boolean(transfer.result),
      };
    });
  }

  async download(principal: AgentPrincipal, args: McpDownloadArgs) {
    const project = authorize(principal, args.serverId, "files:read");
    integer(args.offset, MCP_FILE_LIMITS.fileBytes, "INVALID_OFFSET");
    integer(args.length, MCP_FILE_LIMITS.chunkBytes, "CHUNK_TOO_LARGE");
    if (!args.length) fail("INVALID_LENGTH", "Chunk length must be positive");
    let entry = args.transferId ? this.entries.get(args.transferId) : undefined;
    if (
      args.transferId &&
      (!entry ||
        entry.kind !== "download" ||
        entry.owner !== principal.principalId ||
        entry.project !== project ||
        entry.serverId !== args.serverId ||
        entry.path !== args.path ||
        (!entry.busy && Date.now() - entry.touched >= MCP_FILE_LIMITS.ttlMs))
    )
      fail(
        "TRANSFER_NOT_FOUND",
        "Transfer missing or expired; start a new download",
        404,
      );
    if (!entry) {
      if (args.offset !== 0)
        fail("INVALID_OFFSET", "Start a download at offset zero");
      entry = this.reserve(principal, project, args, "download");
    }
    const transfer = entry;
    return this.run(transfer, async () => {
      let file: string;
      try {
        file = join(await transfer.directory, "data");
        if (!transfer.result) {
          const handle = await open(file, "wx", 0o600);
          const hash = createHash("sha256");
          let size = 0;
          try {
            const sink = new Writable({
              write(chunk: Buffer, _encoding, callback) {
                if (size + chunk.length > MCP_FILE_LIMITS.fileBytes) {
                  callback(
                    new AgentApiError(
                      413,
                      "FILE_TOO_LARGE",
                      "Download exceeds 64 MiB",
                    ),
                  );
                  return;
                }
                hash.update(chunk);
                const position = size;
                size += chunk.length;
                void (async () => {
                  let written = 0;
                  while (written < chunk.length) {
                    const result = await handle.write(
                      chunk,
                      written,
                      chunk.length - written,
                      position + written,
                    );
                    if (!result.bytesWritten)
                      throw new Error("Staging write made no progress");
                    written += result.bytesWritten;
                  }
                })().then(() => callback(), callback);
              },
            });
            transfer.result = await this.files.download(
              principal,
              args.serverId,
              args.path,
              (info) => {
                integer(info.size, MCP_FILE_LIMITS.fileBytes, "FILE_TOO_LARGE");
                return sink;
              },
            );
            if (transfer.result.size !== size)
              fail(
                "DOWNLOAD_SIZE_CHANGED",
                "Download size differs from transferred bytes",
              );
            transfer.size = size;
            transfer.sha256 = hash.digest("hex");
          } finally {
            await handle.close();
          }
        }
      } catch (error) {
        await this.remove(transfer);
        throw error;
      }
      if (args.offset > transfer.size)
        fail("INVALID_OFFSET", "Offset exceeds file size");
      const handle = await open(file, "r");
      const data = Buffer.alloc(
        Math.min(args.length, transfer.size - args.offset),
      );
      try {
        let read = 0;
        while (read < data.length) {
          const { bytesRead } = await handle.read(
            data,
            read,
            data.length - read,
            args.offset + read,
          );
          if (!bytesRead) throw new Error("Staging file was truncated");
          read += bytesRead;
        }
      } finally {
        await handle.close();
      }
      return {
        transferId: transfer.id,
        size: transfer.size,
        sha256: transfer.sha256,
        offset: args.offset,
        nextOffset: args.offset + data.length,
        eof: args.offset + data.length === transfer.size,
        dataBase64: data.toString("base64"),
        expiresInMs: MCP_FILE_LIMITS.ttlMs,
      };
    });
  }
}
