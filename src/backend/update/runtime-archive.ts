import { promises as fs } from "fs";
import path from "path";
import { createReadStream } from "fs";
import type { FileHandle } from "fs/promises";
import { createGunzip } from "zlib";

const TAR_BLOCK_SIZE = 512;
const MAX_ARCHIVE_ENTRIES = 200_000;
const MAX_UNPACKED_BYTES = 3 * 1024 * 1024 * 1024;
const MAX_SINGLE_FILE_BYTES = 1024 * 1024 * 1024;

async function writeFully(handle: FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(
      chunk,
      offset,
      chunk.length - offset,
    );
    if (bytesWritten <= 0) throw new Error("运行包文件写入被意外中断");
    offset += bytesWritten;
  }
}

class ExactStreamReader {
  private readonly iterator: AsyncIterator<Buffer | Uint8Array>;
  private current = Buffer.alloc(0);
  private offset = 0;
  private ended = false;

  constructor(source: AsyncIterable<Buffer | Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  async readExactly(length: number): Promise<Buffer | null> {
    if (length === 0) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    let collected = 0;

    while (collected < length) {
      if (this.offset >= this.current.length) {
        const next = await this.iterator.next();
        if (next.done) {
          this.ended = true;
          break;
        }
        this.current = Buffer.from(next.value);
        this.offset = 0;
        if (this.current.length === 0) continue;
      }

      const take = Math.min(
        length - collected,
        this.current.length - this.offset,
      );
      chunks.push(this.current.subarray(this.offset, this.offset + take));
      this.offset += take;
      collected += take;
    }

    if (collected === 0 && this.ended) return null;
    if (collected !== length) {
      throw new Error("运行包 TAR 数据被意外截断");
    }
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, length);
  }
}

function tarString(block: Buffer, start: number, length: number): string {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return field
    .subarray(0, end < 0 ? field.length : end)
    .toString("utf8")
    .trim();
}

function tarNumber(block: Buffer, start: number, length: number): number {
  const field = block.subarray(start, start + length);
  if ((field[0] & 0x80) !== 0) {
    throw new Error("运行包包含不受支持的 TAR 二进制数值字段");
  }
  const value = tarString(block, start, length).replace(/\s+$/g, "");
  if (!value) return 0;
  if (!/^[0-7]+$/.test(value)) {
    throw new Error("运行包 TAR 数值字段无效");
  }
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("运行包 TAR 数值超出安全范围");
  }
  return parsed;
}

function verifyHeaderChecksum(block: Buffer): void {
  const expected = tarNumber(block, 148, 8);
  let actual = 0;
  for (let index = 0; index < block.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : block[index];
  }
  if (expected !== actual) {
    throw new Error("运行包 TAR 头校验失败");
  }
}

function normalizedArchivePath(block: Buffer): string {
  const name = tarString(block, 0, 100);
  const prefix = tarString(block, 345, 155);
  const raw = prefix ? `${prefix}/${name}` : name;
  if (!raw || raw.includes("\\") || raw.includes("\0")) {
    throw new Error("运行包包含无效路径");
  }

  const withoutDot = raw.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  const normalized = path.posix.normalize(withoutDot);
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized
      .split("/")
      .some((part) => !part || part === ".." || part.includes(":"))
  ) {
    throw new Error(`运行包包含越界路径：${raw.slice(0, 160)}`);
  }
  return normalized;
}

function destinationPath(root: string, archivePath: string): string {
  const destination = path.resolve(root, ...archivePath.split("/"));
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!destination.startsWith(prefix)) {
    throw new Error("运行包路径逃逸了解包目录");
  }
  return destination;
}

async function ensureParentDirectories(
  root: string,
  destination: string,
): Promise<void> {
  const parent = path.dirname(destination);
  await fs.mkdir(parent, { recursive: true, mode: 0o755 });
  const relative = path.relative(root, parent);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("运行包解包路径中包含非目录节点");
    }
  }
}

export interface ExtractRuntimeArchiveResult {
  entries: number;
  unpackedBytes: number;
}

/**
 * 只解包普通文件和目录。更新包不得使用链接、设备节点、PAX 扩展或 GNU
 * 长文件名，从而保证归档内的名称就是最终落盘名称。
 */
export async function extractRuntimeArchive(
  archivePath: string,
  destinationRoot: string,
): Promise<ExtractRuntimeArchiveResult> {
  await fs.mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  const rootStat = await fs.lstat(destinationRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("运行包 staging 目录无效");
  }

  const gunzip = createReadStream(archivePath).pipe(createGunzip());
  const reader = new ExactStreamReader(gunzip);
  const seen = new Set<string>();
  let entries = 0;
  let unpackedBytes = 0;
  let zeroBlocks = 0;

  try {
    while (true) {
      const header = await reader.readExactly(TAR_BLOCK_SIZE);
      if (!header) break;
      if (header.every((byte) => byte === 0)) {
        zeroBlocks += 1;
        if (zeroBlocks >= 2) break;
        continue;
      }
      zeroBlocks = 0;
      verifyHeaderChecksum(header);

      entries += 1;
      if (entries > MAX_ARCHIVE_ENTRIES) {
        throw new Error("运行包文件数量超过安全限制");
      }

      const archiveEntry = normalizedArchivePath(header);
      if (seen.has(archiveEntry)) {
        throw new Error(`运行包包含重复路径：${archiveEntry}`);
      }
      seen.add(archiveEntry);

      const type = String.fromCharCode(header[156] || 0);
      const size = tarNumber(header, 124, 12);
      const mode = tarNumber(header, 100, 8);
      if (size > MAX_SINGLE_FILE_BYTES) {
        throw new Error(`运行包中的单个文件过大：${archiveEntry}`);
      }
      unpackedBytes += size;
      if (unpackedBytes > MAX_UNPACKED_BYTES) {
        throw new Error("运行包解包后的总大小超过安全限制");
      }

      const destination = destinationPath(destinationRoot, archiveEntry);
      if (type === "5") {
        if (size !== 0)
          throw new Error(`运行包目录条目大小无效：${archiveEntry}`);
        await ensureParentDirectories(destinationRoot, destination);
        await fs.mkdir(destination, { mode: 0o755 });
      } else if (type === "\0" || type === "0") {
        await ensureParentDirectories(destinationRoot, destination);
        const handle = await fs.open(
          destination,
          "wx",
          mode & 0o111 ? 0o755 : 0o644,
        );
        try {
          let remaining = size;
          while (remaining > 0) {
            const chunk = await reader.readExactly(
              Math.min(remaining, 64 * 1024),
            );
            if (!chunk) throw new Error("运行包文件内容被意外截断");
            await writeFully(handle, chunk);
            remaining -= chunk.length;
          }
          await handle.sync();
        } finally {
          await handle.close();
        }
      } else {
        throw new Error(`运行包包含不允许的链接或特殊条目：${archiveEntry}`);
      }

      const padding =
        (TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
      if (padding > 0 && !(await reader.readExactly(padding))) {
        throw new Error("运行包 TAR 填充数据被意外截断");
      }
    }
  } finally {
    gunzip.destroy();
  }

  return { entries, unpackedBytes };
}
