import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReleaseManifest, run } from "./cloudssh-release-manifest.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const valid = {
  version: "2.6.0-cloudssh.29",
  image: "ghcr.io/moeacgx/cloudssh",
  digest: `sha256:${"a".repeat(64)}`,
  revision: "b".repeat(40),
  runtimeManifest: "cloudssh-self-update.json",
  runtimeManifestSha256: "c".repeat(64),
  minEntrypointProtocol: 2,
  deploymentContract: "cloudssh-self-update-v1",
};

describe("CloudSSH 发布清单", () => {
  it("生成镜像和容器内运行包的固定摘要清单", () => {
    expect(createReleaseManifest(valid)).toEqual({
      schemaVersion: 3,
      channel: "stable",
      version: valid.version,
      image: valid.image,
      digest: valid.digest,
      revision: valid.revision,
      runtime: {
        manifest: valid.runtimeManifest,
        sha256: valid.runtimeManifestSha256,
      },
      minEntrypointProtocol: 2,
      deploymentContract: "cloudssh-self-update-v1",
    });
  });

  it("拒绝可变标签、非法摘要、非法提交和错误运行包清单", () => {
    expect(() =>
      createReleaseManifest({ ...valid, image: `${valid.image}:latest` }),
    ).toThrow("镜像仓库格式无效");
    expect(() =>
      createReleaseManifest({ ...valid, version: "2.6.0-cloudssh..29" }),
    ).toThrow("版本号格式无效");
    expect(() =>
      createReleaseManifest({ ...valid, digest: "sha256:abc" }),
    ).toThrow("镜像摘要格式无效");
    expect(() => createReleaseManifest({ ...valid, revision: "main" })).toThrow(
      "源码提交格式无效",
    );
    expect(() =>
      createReleaseManifest({
        ...valid,
        runtimeManifest: "untrusted.json",
      }),
    ).toThrow("运行包清单名称无效");
    expect(() =>
      createReleaseManifest({ ...valid, runtimeManifestSha256: "bad" }),
    ).toThrow("运行包清单 SHA-256 无效");
    expect(() =>
      createReleaseManifest({ ...valid, minEntrypointProtocol: 0 }),
    ).toThrow("必须是正整数");
  });

  it("命令行模式写出可复现 JSON 文件", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "cloudssh-release-"),
    );
    temporaryDirectories.push(directory);
    const output = path.join(directory, "cloudssh-release.json");
    await run([
      "--version",
      valid.version,
      "--image",
      valid.image,
      "--digest",
      valid.digest,
      "--revision",
      valid.revision,
      "--runtime-manifest-sha256",
      valid.runtimeManifestSha256,
      "--min-entrypoint-protocol",
      "2",
      "--deployment-contract",
      valid.deploymentContract,
      "--output",
      output,
    ]);
    await expect(readFile(output, "utf8")).resolves.toContain(
      '"schemaVersion": 3',
    );
  });
});
