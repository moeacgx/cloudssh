import { gzipSync } from "zlib";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { extractRuntimeArchive } from "./runtime-archive.js";

const temporaryDirectories: string[] = [];

function octal(
  header: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  header.write(
    `${value.toString(8).padStart(length - 1, "0")}\0`,
    offset,
    length,
    "ascii",
  );
}

function entry(name: string, type: "0" | "2", body = "data"): Buffer {
  const content = type === "0" ? Buffer.from(body) : Buffer.alloc(0);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  octal(header, 100, 8, 0o644);
  octal(header, 108, 8, 0);
  octal(header, 116, 8, 0);
  octal(header, 124, 12, content.length);
  octal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return Buffer.concat([
    header,
    content,
    Buffer.alloc((512 - (content.length % 512)) % 512),
  ]);
}

async function fixture(entries: Buffer[]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudssh-tar-"));
  temporaryDirectories.push(directory);
  const archive = path.join(directory, "runtime.tar.gz");
  const output = path.join(directory, "output");
  await fs.writeFile(
    archive,
    gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)])),
  );
  return { directory, archive, output };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("自更新运行包安全解包", () => {
  it("流式解包普通文件", async () => {
    const value = await fixture([entry("app/file.txt", "0", "hello")]);
    await expect(
      extractRuntimeArchive(value.archive, value.output),
    ).resolves.toEqual({
      entries: 1,
      unpackedBytes: 5,
    });
    await expect(
      fs.readFile(path.join(value.output, "app", "file.txt"), "utf8"),
    ).resolves.toBe("hello");
  });

  it("拒绝路径穿越且不会写到 staging 外", async () => {
    const value = await fixture([entry("../escaped.txt", "0", "secret")]);
    await expect(
      extractRuntimeArchive(value.archive, value.output),
    ).rejects.toThrow("越界路径");
    await expect(
      fs.stat(path.join(value.directory, "escaped.txt")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("拒绝符号链接及其他特殊条目", async () => {
    const value = await fixture([entry("link", "2", "")]);
    await expect(
      extractRuntimeArchive(value.archive, value.output),
    ).rejects.toThrow("不允许的链接或特殊条目");
  });
});
