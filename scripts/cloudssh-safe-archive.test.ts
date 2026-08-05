import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const root = process.cwd();
const validator = path.join(root, "scripts", "cloudssh-safe-archive.py");
const temporaryDirectories: string[] = [];
const python = ["python3", "python"].find((candidate) => {
  const result = spawnSync(candidate, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  return result.status === 0;
});

const fixtureScript = String.raw`
import io
import sys
import tarfile

archive_path, fixture = sys.argv[1:]

def directory(archive, name):
    member = tarfile.TarInfo(name)
    member.type = tarfile.DIRTYPE
    member.mode = 0o700
    archive.addfile(member)

def regular(archive, name, content=b"content", mode=0o600):
    member = tarfile.TarInfo(name)
    member.size = len(content)
    member.mode = mode
    archive.addfile(member, io.BytesIO(content))

with tarfile.open(archive_path, "w:gz") as archive:
    directory(archive, "data")
    directory(archive, "recordings")
    if fixture == "valid":
        regular(archive, "data/.env", b"JWT_SECRET=test\n")
        directory(archive, "data/opkssh")
        regular(archive, "data/opkssh/opkssh-linux-amd64", b"binary", 0o755)
        regular(archive, "recordings/demo.guac", b"recording")
    elif fixture == "symlink":
        member = tarfile.TarInfo("data/link")
        member.type = tarfile.SYMTYPE
        member.linkname = "../../outside"
        archive.addfile(member)
    elif fixture == "hardlink":
        regular(archive, "data/source")
        member = tarfile.TarInfo("data/hardlink")
        member.type = tarfile.LNKTYPE
        member.linkname = "data/source"
        archive.addfile(member)
    elif fixture == "fifo":
        member = tarfile.TarInfo("data/fifo")
        member.type = tarfile.FIFOTYPE
        archive.addfile(member)
    elif fixture == "duplicate":
        regular(archive, "data/duplicate", b"first")
        regular(archive, "data/duplicate", b"second")
    elif fixture == "traversal":
        regular(archive, "data/../../outside")
    elif fixture == "absolute":
        regular(archive, "/data/outside")
    elif fixture == "file-parent":
        regular(archive, "data/parent")
        regular(archive, "data/parent/child")
    else:
        raise ValueError(f"unknown fixture: {fixture}")
`;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(name: string): Promise<{
  archive: string;
  directory: string;
}> {
  if (!python) throw new Error("没有可用的 Python 解释器");
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cloudssh-safe-archive-"),
  );
  temporaryDirectories.push(directory);
  const archive = path.join(directory, `${name}.tar.gz`);
  const result = spawnSync(python, ["-c", fixtureScript, archive, name], {
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return { archive, directory };
}

function validate(archive: string) {
  return spawnSync(python!, [validator, "validate", archive], {
    encoding: "utf8",
    timeout: 10_000,
  });
}

describe.skipIf(!python || !existsSync(validator))(
  "CloudSSH 真实 tar 安全校验",
  () => {
    it("接受仅包含普通目录和普通文件的双卷归档", async () => {
      const current = await fixture("valid");
      const result = validate(current.archive);

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("归档结构和成员类型校验通过");
    });

    it.each([
      ["symlink", "符号链接、硬链接或特殊文件"],
      ["hardlink", "符号链接、硬链接或特殊文件"],
      ["fifo", "符号链接、硬链接或特殊文件"],
      ["duplicate", "重复路径"],
      ["traversal", "目录穿越"],
      ["absolute", "绝对路径"],
      ["file-parent", "同时被当作目录"],
    ])("拒绝 %s 恶意归档", async (name, expectedError) => {
      const current = await fixture(name);
      const result = validate(current.archive);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(expectedError);
    });

    it("安全解包后只产生普通文件并强制敏感权限", async () => {
      const current = await fixture("valid");
      const data = path.join(current.directory, "data-target");
      const recordings = path.join(current.directory, "recordings-target");
      const { mkdir } = await import("node:fs/promises");
      await Promise.all([mkdir(data), mkdir(recordings)]);

      const result = spawnSync(
        python!,
        [validator, "extract", current.archive, data, recordings],
        { encoding: "utf8", timeout: 10_000 },
      );

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(await readFile(path.join(data, ".env"), "utf8")).toBe(
        "JWT_SECRET=test\n",
      );
      expect(await readFile(path.join(recordings, "demo.guac"), "utf8")).toBe(
        "recording",
      );
      if (process.platform !== "win32") {
        expect((await stat(path.join(data, ".env"))).mode & 0o777).toBe(0o600);
        expect(
          (await stat(path.join(data, "opkssh/opkssh-linux-amd64"))).mode &
            0o777,
        ).toBe(0o700);
      }
    });
  },
);
