import { describe, expect, it } from "vitest";
import { createRuntimeManifest } from "./cloudssh-runtime-manifest.mjs";

const version = "2.6.0-cloudssh.29";
const revision = "a".repeat(40);
const checksum = "b".repeat(64);

function asset(arch: "amd64" | "arm64") {
  return {
    os: "linux" as const,
    arch,
    name: `cloudssh-runtime-${version}-linux-${arch}.tar.gz`,
    sha256: checksum,
    size: 1024,
  };
}

describe("CloudSSH 运行包清单", () => {
  it("生成固定架构、入口协议和校验信息", () => {
    expect(
      createRuntimeManifest({
        version,
        revision,
        protocolVersion: 2,
        nodeMajor: 26,
        modulesAbi: "137",
        libc: "glibc",
        libcVersion: "2.41",
        assets: [asset("amd64"), asset("arm64")],
      }),
    ).toEqual({
      schemaVersion: 1,
      channel: "stable",
      version,
      revision,
      entrypointProtocol: 2,
      runtimeCompatibility: {
        contract: "cloudssh-node-glibc-v1",
        nodeMajor: 26,
        modulesAbi: "137",
        libc: "glibc",
        libcVersion: "2.41",
      },
      databaseCompatibility: {
        contract: "cloudssh-sqlite-backward-v1",
        rollbackSafe: true,
      },
      assets: [asset("amd64"), asset("arm64")],
    });
  });

  it("拒绝缺少架构、重复架构和不匹配的文件名", () => {
    expect(() =>
      createRuntimeManifest({
        version,
        revision,
        protocolVersion: 2,
        nodeMajor: 26,
        modulesAbi: "137",
        libc: "glibc",
        libcVersion: "2.41",
        assets: [asset("amd64")],
      }),
    ).toThrow("必须同时包含");
    expect(() =>
      createRuntimeManifest({
        version,
        revision,
        protocolVersion: 2,
        nodeMajor: 26,
        modulesAbi: "137",
        libc: "glibc",
        libcVersion: "2.41",
        assets: [asset("amd64"), asset("amd64")],
      }),
    ).toThrow("不能重复");
    expect(() =>
      createRuntimeManifest({
        version,
        revision,
        protocolVersion: 2,
        nodeMajor: 26,
        modulesAbi: "137",
        libc: "glibc",
        libcVersion: "2.41",
        assets: [asset("amd64"), { ...asset("arm64"), name: "runtime.tar.gz" }],
      }),
    ).toThrow("运行包名称无效");
  });

  it("拒绝无效校验值、大小、版本和入口协议", () => {
    expect(() =>
      createRuntimeManifest({
        version,
        revision,
        protocolVersion: 2,
        nodeMajor: 26,
        modulesAbi: "137",
        libc: "glibc",
        libcVersion: "2.41",
        assets: [asset("amd64"), { ...asset("arm64"), sha256: "bad" }],
      }),
    ).toThrow("SHA-256");
    expect(() =>
      createRuntimeManifest({
        version,
        revision,
        protocolVersion: 2,
        nodeMajor: 26,
        modulesAbi: "137",
        libc: "glibc",
        libcVersion: "2.41",
        assets: [asset("amd64"), { ...asset("arm64"), size: 0 }],
      }),
    ).toThrow("大小无效");
    expect(() =>
      createRuntimeManifest({
        version: "latest",
        revision,
        protocolVersion: 2,
        nodeMajor: 26,
        modulesAbi: "137",
        libc: "glibc",
        libcVersion: "2.41",
        assets: [asset("amd64"), asset("arm64")],
      }),
    ).toThrow("版本号格式无效");
    expect(() =>
      createRuntimeManifest({
        version,
        revision,
        protocolVersion: 0,
        nodeMajor: 26,
        modulesAbi: "137",
        libc: "glibc",
        libcVersion: "2.41",
        assets: [asset("amd64"), asset("arm64")],
      }),
    ).toThrow("入口协议版本");
    expect(() =>
      createRuntimeManifest({
        version,
        revision,
        protocolVersion: 2,
        nodeMajor: 24,
        modulesAbi: "invalid",
        libc: "glibc",
        libcVersion: "2.41",
        assets: [asset("amd64"), asset("arm64")],
      }),
    ).toThrow("ABI 格式无效");
    expect(() =>
      createRuntimeManifest({
        version,
        revision,
        protocolVersion: 2,
        nodeMajor: 24,
        modulesAbi: "137",
        libc: "musl",
        libcVersion: "1.2.5",
        assets: [asset("amd64"), asset("arm64")],
      }),
    ).toThrow("只支持 glibc");
    expect(() =>
      createRuntimeManifest({
        version,
        revision,
        protocolVersion: 2,
        nodeMajor: 24,
        modulesAbi: "137",
        libc: "glibc",
        libcVersion: "unknown",
        assets: [asset("amd64"), asset("arm64")],
      }),
    ).toThrow("glibc 版本格式无效");
  });
});
