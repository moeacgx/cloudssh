import crypto from "crypto";
import { gzipSync } from "zlib";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  confirmPendingSelfUpdate,
  createIdempotencyKey,
  getUpdateJob,
  getUpdateMode,
  getUpdaterStatus,
  resetSelfUpdaterTestHooks,
  rollbackUpdate,
  setSelfUpdaterTestHooks,
  setUpdateMode,
  startUpdate,
} from "./updater-client.js";

const VERSION = "2.6.0-cloudssh.29";
const TEST_COMPATIBILITY = {
  nodeMajor: 22,
  modulesAbi: "127",
  libc: "glibc" as const,
  libcVersion: "2.36",
};
let directory = "";
let restart: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
let archive: Buffer;

function writeOctal(
  header: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  const encoded = `${value.toString(8).padStart(length - 1, "0")}\0`;
  header.write(encoded, offset, length, "ascii");
}

function tarEntry(name: string, content?: string, mode = 0o644): Buffer {
  const body = content === undefined ? Buffer.alloc(0) : Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, body.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = content === undefined ? "5".charCodeAt(0) : "0".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, padding]);
}

function runtimeArchive(version = VERSION): Buffer {
  const entries = [
    tarEntry("package.json", JSON.stringify({ version })),
    tarEntry("html/"),
    tarEntry("html/index.html", "<!doctype html>"),
    tarEntry("dist/"),
    tarEntry("dist/backend/"),
    tarEntry("dist/backend/backend/"),
    tarEntry("dist/backend/backend/starter.js", "console.log('start')"),
    tarEntry("node_modules/"),
    tarEntry("nginx/"),
    tarEntry("nginx/nginx.conf.template", "events {}"),
    tarEntry("nginx/nginx-https.conf.template", "events {}"),
    tarEntry("self-update/"),
    tarEntry(
      "self-update/entrypoint.sh",
      "#!/bin/sh\nexec node dist/backend/backend/starter.js\n",
      0o755,
    ),
    Buffer.alloc(1024),
  ];
  return gzipSync(Buffer.concat(entries));
}

function releaseFetch(
  runtime: Buffer,
  options?: {
    hash?: string;
    size?: number;
    arch?: string;
    schemaVersion?: number;
    manifestHash?: string;
    nodeMajor?: number;
    omitContentLength?: boolean;
  },
) {
  const digest =
    options?.hash ?? crypto.createHash("sha256").update(runtime).digest("hex");
  const size = options?.size ?? runtime.length;
  const runtimeManifest = JSON.stringify({
    schemaVersion: options?.schemaVersion ?? 1,
    version: VERSION,
    channel: "stable",
    revision: "a".repeat(40),
    entrypointProtocol: 2,
    runtimeCompatibility: {
      contract: "cloudssh-node-glibc-v1",
      ...TEST_COMPATIBILITY,
      nodeMajor: options?.nodeMajor ?? TEST_COMPATIBILITY.nodeMajor,
    },
    databaseCompatibility: {
      contract: "cloudssh-sqlite-backward-v1",
      rollbackSafe: true,
    },
    assets: [
      {
        os: "linux",
        arch: options?.arch ?? "amd64",
        name: `cloudssh-runtime-${VERSION}-linux-amd64.tar.gz`,
        sha256: digest,
        size,
      },
    ],
  });
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("cloudssh-release.json")) {
      return new Response(
        JSON.stringify({
          schemaVersion: 3,
          channel: "stable",
          version: VERSION,
          image: "ghcr.io/moeacgx/cloudssh",
          digest: `sha256:${"b".repeat(64)}`,
          revision: "a".repeat(40),
          runtime: {
            manifest: "cloudssh-self-update.json",
            sha256:
              options?.manifestHash ??
              crypto.createHash("sha256").update(runtimeManifest).digest("hex"),
          },
          minEntrypointProtocol: 2,
          deploymentContract: "cloudssh-self-update-v1",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("cloudssh-self-update.json")) {
      return new Response(runtimeManifest, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(runtime, {
      status: 200,
      headers: options?.omitContentLength
        ? undefined
        : { "content-length": String(runtime.length) },
    });
  });
}

async function waitForJob(id: string, state: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = await getUpdateJob(id);
    if (job.state === state) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`job ${id} did not reach ${state}`);
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudssh-self-update-"));
  await fs.writeFile(path.join(directory, "db.sqlite"), "database");
  archive = runtimeArchive();
  restart = vi.fn();
  fetchMock = releaseFetch(archive);
  process.env.VERSION = "2.6.0-cloudssh.28";
  delete process.env.CLOUDSSH_UPDATE_MODE;
  delete process.env.CLOUDSSH_ACTIVE_APP_SOURCE;
  setSelfUpdaterTestHooks({
    dataDir: directory,
    platform: "linux",
    arch: "x64",
    runtimeCompatibility: TEST_COMPATIBILITY,
    fetch: fetchMock,
    forceDatabaseSave: async () => undefined,
    requestRestart: restart,
    runtimeHealthCheck: async () => undefined,
  });
});

afterEach(async () => {
  resetSelfUpdaterTestHooks();
  delete process.env.CLOUDSSH_UPDATE_MODE;
  delete process.env.CLOUDSSH_ACTIVE_APP_SOURCE;
  await fs.rm(directory, { recursive: true, force: true });
});

describe("CloudSSH 容器内自更新", () => {
  it("默认使用 auto 模式并持久化更新方式", async () => {
    await expect(getUpdateMode()).resolves.toBe("auto");
    await expect(getUpdaterStatus()).resolves.toMatchObject({
      available: true,
      configured: true,
      enabled: true,
      updateMode: "auto",
      protocolVersion: 2,
    });

    await expect(setUpdateMode("binary")).resolves.toBe("binary");
    await expect(
      fs.readFile(path.join(directory, "update-mode.txt"), "utf8"),
    ).resolves.toBe("binary\n");
  });

  it("模式文件不存在时遵循容器环境配置", async () => {
    process.env.CLOUDSSH_UPDATE_MODE = "image";
    await expect(getUpdateMode()).resolves.toBe("image");
  });

  it("image 模式明确拒绝在容器内替换镜像", async () => {
    await setUpdateMode("image");
    await expect(
      startUpdate({
        targetVersion: VERSION,
        idempotencyKey: "update:12345678",
      }),
    ).rejects.toMatchObject({
      code: "IMAGE_UPDATE_REQUIRES_EXTERNAL_REDEPLOY",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("校验公开运行包、创建数据库快照并原子切换运行目录", async () => {
    const first = await startUpdate({
      targetVersion: VERSION,
      idempotencyKey: "update:12345678",
    });
    const duplicate = await startUpdate({
      targetVersion: VERSION,
      idempotencyKey: "update:12345678",
    });
    expect(duplicate.id).toBe(first.id);

    const restarting = await waitForJob(first.id, "restarting");
    expect(restarting.phase).toBe("starting");
    expect(restart).toHaveBeenCalledOnce();

    const selfUpdate = path.join(directory, "self-update");
    const current = (
      await fs.readFile(path.join(selfUpdate, "app-current"), "utf8")
    ).trim();
    expect(current).toMatch(
      /^releases\/2\.6\.0-cloudssh\.29-[0-9a-f]{12}-[0-9a-f]{8}$/,
    );
    await expect(
      fs.readFile(path.join(selfUpdate, current, "package.json"), "utf8"),
    ).resolves.toContain(`"version":"${VERSION}"`);
    await expect(
      fs.readFile(path.join(selfUpdate, "app-previous"), "utf8"),
    ).resolves.toBe("builtin\n");
    expect(restarting.backupArchive).toBeTruthy();
    const snapshotManifest = JSON.parse(
      await fs.readFile(
        path.join(restarting.backupArchive!, "manifest.json"),
        "utf8",
      ),
    ) as { files: Array<{ name: string }>; excludes: string[] };
    expect(snapshotManifest.files.map((file) => file.name)).toEqual([
      "db.sqlite",
    ]);
    expect(snapshotManifest.excludes).toContain(".env");

    await confirmPendingSelfUpdate(VERSION);
    await expect(getUpdateJob(first.id)).resolves.toMatchObject({
      state: "completed",
      progress: 100,
    });
    await setUpdateMode("binary");
    await expect(getUpdaterStatus()).resolves.toMatchObject({
      activeSource: "image",
      restartRequired: true,
      operation: null,
    });
    await expect(
      fs.stat(path.join(selfUpdate, "confirmed.json")),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(selfUpdate, "pending.json")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("SHA-256 不匹配时保留当前运行目录并记录失败", async () => {
    setSelfUpdaterTestHooks({
      dataDir: directory,
      platform: "linux",
      arch: "x64",
      runtimeCompatibility: TEST_COMPATIBILITY,
      fetch: releaseFetch(archive, { hash: "0".repeat(64) }),
      forceDatabaseSave: async () => undefined,
      requestRestart: restart,
    });
    const job = await startUpdate({
      targetVersion: VERSION,
      idempotencyKey: "update:bad-hash",
    });
    await expect(waitForJob(job.id, "failed")).resolves.toMatchObject({
      failureCode: "ASSET_HASH_MISMATCH",
      message: "运行包 SHA-256 校验失败",
    });
    expect(restart).not.toHaveBeenCalled();
    await expect(
      fs.stat(path.join(directory, "self-update", "app-current")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("拒绝清单版本或 CPU 架构不匹配的运行包", async () => {
    setSelfUpdaterTestHooks({
      dataDir: directory,
      platform: "linux",
      arch: "x64",
      runtimeCompatibility: TEST_COMPATIBILITY,
      fetch: releaseFetch(archive, { arch: "arm64" }),
      forceDatabaseSave: async () => undefined,
      requestRestart: restart,
    });
    const job = await startUpdate({
      targetVersion: VERSION,
      idempotencyKey: "update:wrong-arch",
    });
    await expect(waitForJob(job.id, "failed")).resolves.toMatchObject({
      failureCode: "MANIFEST_ARCH_MISMATCH",
    });
    expect(restart).not.toHaveBeenCalled();
  });

  it("用顶层发布清单锁定运行清单 SHA-256", async () => {
    setSelfUpdaterTestHooks({
      dataDir: directory,
      platform: "linux",
      arch: "x64",
      runtimeCompatibility: TEST_COMPATIBILITY,
      fetch: releaseFetch(archive, { manifestHash: "0".repeat(64) }),
      forceDatabaseSave: async () => undefined,
      requestRestart: restart,
    });
    const job = await startUpdate({
      targetVersion: VERSION,
      idempotencyKey: "update:bad-manifest-hash",
    });
    await expect(waitForJob(job.id, "failed")).resolves.toMatchObject({
      failureCode: "RUNTIME_MANIFEST_HASH_MISMATCH",
    });
  });

  it("拒绝 Node 主版本、原生模块 ABI 或 libc 不兼容的运行包", async () => {
    setSelfUpdaterTestHooks({
      dataDir: directory,
      platform: "linux",
      arch: "x64",
      runtimeCompatibility: TEST_COMPATIBILITY,
      fetch: releaseFetch(archive, { nodeMajor: 23 }),
      forceDatabaseSave: async () => undefined,
      requestRestart: restart,
    });
    const job = await startUpdate({
      targetVersion: VERSION,
      idempotencyKey: "update:wrong-node-abi",
    });
    await expect(waitForJob(job.id, "failed")).resolves.toMatchObject({
      failureCode: "RUNTIME_COMPATIBILITY_MISMATCH",
    });
  });

  it("解包后再次核对 package.json 版本", async () => {
    const wrongRuntime = runtimeArchive("2.6.0-cloudssh.27");
    setSelfUpdaterTestHooks({
      dataDir: directory,
      platform: "linux",
      arch: "x64",
      runtimeCompatibility: TEST_COMPATIBILITY,
      fetch: releaseFetch(wrongRuntime),
      forceDatabaseSave: async () => undefined,
      requestRestart: restart,
    });
    const job = await startUpdate({
      targetVersion: VERSION,
      idempotencyKey: "update:wrong-package",
    });
    await expect(waitForJob(job.id, "failed")).resolves.toMatchObject({
      failureCode: "RUNTIME_VERSION_MISMATCH",
    });
    expect(restart).not.toHaveBeenCalled();
  });

  it("接受没有 Content-Length 的分块运行包响应", async () => {
    setSelfUpdaterTestHooks({
      dataDir: directory,
      platform: "linux",
      arch: "x64",
      runtimeCompatibility: TEST_COMPATIBILITY,
      fetch: releaseFetch(archive, { omitContentLength: true }),
      forceDatabaseSave: async () => undefined,
      requestRestart: restart,
    });
    const update = await startUpdate({
      targetVersion: VERSION,
      idempotencyKey: "update:chunked-response",
    });
    await expect(waitForJob(update.id, "restarting")).resolves.toMatchObject({
      failureCode: null,
    });
  });

  it("只按受控 app-previous 指针回退并在启动后确认", async () => {
    const update = await startUpdate({
      targetVersion: VERSION,
      idempotencyKey: "update:for-rollback",
    });
    await waitForJob(update.id, "restarting");
    await confirmPendingSelfUpdate(VERSION);
    process.env.VERSION = VERSION;

    const rollback = await rollbackUpdate({
      idempotencyKey: "rollback:12345678",
    });
    const restarting = await waitForJob(rollback.id, "restarting");
    expect(restarting.targetVersion).toBe("2.6.0-cloudssh.28");
    await expect(
      fs.readFile(path.join(directory, "self-update", "app-current"), "utf8"),
    ).resolves.toBe("builtin\n");

    await confirmPendingSelfUpdate("2.6.0-cloudssh.28");
    await expect(getUpdateJob(rollback.id)).resolves.toMatchObject({
      state: "rolled_back",
      phase: "rolled_back",
    });
  });

  it("Web 健康检查失败时不确认新运行包并保留回退事务", async () => {
    const update = await startUpdate({
      targetVersion: VERSION,
      idempotencyKey: "update:health-failure",
    });
    await waitForJob(update.id, "restarting");
    setSelfUpdaterTestHooks({
      dataDir: directory,
      platform: "linux",
      arch: "x64",
      runtimeCompatibility: TEST_COMPATIBILITY,
      fetch: fetchMock,
      forceDatabaseSave: async () => undefined,
      requestRestart: restart,
      runtimeHealthCheck: async () => {
        throw new Error("nginx unavailable");
      },
    });

    await expect(confirmPendingSelfUpdate(VERSION)).rejects.toThrow(
      "nginx unavailable",
    );
    await expect(
      fs.stat(path.join(directory, "self-update", "pending.json")),
    ).resolves.toBeTruthy();
    await expect(getUpdateJob(update.id)).resolves.toMatchObject({
      state: "restarting",
    });
  });

  it("任务状态缺失时从 pending 重建并完成确认", async () => {
    const selfUpdate = path.join(directory, "self-update");
    await fs.mkdir(selfUpdate, { recursive: true });
    await fs.writeFile(
      path.join(selfUpdate, "pending.json"),
      JSON.stringify({
        schemaVersion: 1,
        jobId: "missing-job",
        action: "update",
        targetVersion: VERSION,
        previousPointer: "builtin",
        targetPointer: "releases/missing-job",
        createdAt: new Date().toISOString(),
      }),
    );
    await fs.writeFile(path.join(selfUpdate, "boot-attempted"), "attempted");

    await expect(confirmPendingSelfUpdate(VERSION)).resolves.toBeUndefined();
    await expect(getUpdateJob("missing-job")).resolves.toMatchObject({
      state: "completed",
      targetVersion: VERSION,
    });
    await expect(
      fs.stat(path.join(selfUpdate, "pending.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.stat(path.join(selfUpdate, "boot-attempted")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("隔离损坏的更新状态，核心状态接口仍可用", async () => {
    const selfUpdate = path.join(directory, "self-update");
    await fs.mkdir(selfUpdate, { recursive: true });
    await fs.writeFile(path.join(selfUpdate, "state.json"), "{broken");

    await expect(getUpdaterStatus()).resolves.toMatchObject({
      available: true,
      operation: null,
    });
    const files = await fs.readdir(selfUpdate);
    expect(files.some((name) => name.startsWith("state.json.invalid-"))).toBe(
      true,
    );
  });

  it("隔离越界运行目录指针，状态接口回退到镜像来源", async () => {
    const selfUpdate = path.join(directory, "self-update");
    await fs.mkdir(selfUpdate, { recursive: true });
    await fs.writeFile(path.join(selfUpdate, "app-current"), "../../escape\n");

    await expect(getUpdaterStatus()).resolves.toMatchObject({
      activeSource: "image",
      canRollback: false,
    });
    const files = await fs.readdir(selfUpdate);
    expect(files.some((name) => name.startsWith("app-current.invalid-"))).toBe(
      true,
    );
  });

  it("隔离损坏的 pending 并恢复上一运行目录指针", async () => {
    const selfUpdate = path.join(directory, "self-update");
    await fs.mkdir(selfUpdate, { recursive: true });
    await fs.writeFile(path.join(selfUpdate, "app-current"), "releases/bad\n");
    await fs.writeFile(path.join(selfUpdate, "app-previous"), "builtin\n");
    await fs.writeFile(path.join(selfUpdate, "pending.json"), "{broken");
    await fs.writeFile(path.join(selfUpdate, "boot-attempted"), "attempted");

    await expect(confirmPendingSelfUpdate(VERSION)).resolves.toBeUndefined();
    await expect(
      fs.readFile(path.join(selfUpdate, "app-current"), "utf8"),
    ).resolves.toBe("builtin\n");
    const files = await fs.readdir(selfUpdate);
    expect(files.some((name) => name.startsWith("pending.json.invalid-"))).toBe(
      true,
    );
    await expect(
      fs.stat(path.join(selfUpdate, "boot-attempted")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("保留合规幂等键并替换过短值", () => {
    expect(createIdempotencyKey("update:12345678")).toBe("update:12345678");
    expect(createIdempotencyKey("short")).not.toBe("short");
  });
});
