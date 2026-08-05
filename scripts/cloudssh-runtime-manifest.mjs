#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-cloudssh\.(?:0|[1-9]\d*)$/;
const REVISION_PATTERN = /^[0-9a-f]{40,64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SUPPORTED_ARCHITECTURES = ["amd64", "arm64"];
const RUNTIME_CONTRACT = "cloudssh-node-glibc-v1";
const DATABASE_CONTRACT = "cloudssh-sqlite-backward-v1";

function required(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`缺少 ${name}`);
  return normalized;
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`不支持的参数：${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`参数 ${key} 缺少值`);
    }
    result[key.slice(2)] = value;
    index += 1;
  }
  return result;
}

function parseAsset(value, version) {
  const [arch, name, sha256, sizeText] =
    typeof value === "string"
      ? required(value, "asset").split(":")
      : [value?.arch, value?.name, value?.sha256, value?.size];
  if (!SUPPORTED_ARCHITECTURES.includes(arch)) {
    throw new Error(`不支持的运行包架构：${arch}`);
  }
  const expectedName = `cloudssh-runtime-${version}-linux-${arch}.tar.gz`;
  if (name !== expectedName) throw new Error(`运行包名称无效：${name}`);
  if (!SHA256_PATTERN.test(sha256 || "")) {
    throw new Error(`运行包 SHA-256 无效：${name}`);
  }
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new Error(`运行包大小无效：${name}`);
  }
  return { os: "linux", arch, name, sha256, size };
}

export function createRuntimeManifest(input) {
  const version = required(input.version, "version");
  if (!VERSION_PATTERN.test(version)) throw new Error("版本号格式无效");
  const revision = required(input.revision, "revision").toLowerCase();
  if (!REVISION_PATTERN.test(revision)) throw new Error("源码提交格式无效");
  const protocolVersion = Number(input.protocolVersion);
  if (!Number.isSafeInteger(protocolVersion) || protocolVersion <= 0) {
    throw new Error("入口协议版本必须是正整数");
  }
  const nodeMajor = Number(input.nodeMajor);
  if (!Number.isSafeInteger(nodeMajor) || nodeMajor < 22) {
    throw new Error("Node 主版本必须是不小于 22 的整数");
  }
  const modulesAbi = required(input.modulesAbi, "modulesAbi");
  if (!/^\d{2,4}$/.test(modulesAbi)) {
    throw new Error("Node 原生模块 ABI 格式无效");
  }
  const libc = required(input.libc, "libc").toLowerCase();
  if (libc !== "glibc") throw new Error("运行包只支持 glibc");
  const libcVersion = required(input.libcVersion, "libcVersion");
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(libcVersion)) {
    throw new Error("glibc 版本格式无效");
  }

  const assets = (input.assets || []).map((asset) =>
    parseAsset(asset, version),
  );
  if (
    assets.length !== SUPPORTED_ARCHITECTURES.length ||
    new Set(assets.map((asset) => asset.arch)).size !== assets.length ||
    !SUPPORTED_ARCHITECTURES.every((arch) =>
      assets.some((asset) => asset.arch === arch),
    )
  ) {
    throw new Error("运行包必须同时包含 amd64 和 arm64，且不能重复");
  }

  return {
    schemaVersion: 1,
    channel: "stable",
    version,
    revision,
    entrypointProtocol: protocolVersion,
    runtimeCompatibility: {
      contract: RUNTIME_CONTRACT,
      nodeMajor,
      modulesAbi,
      libc,
      libcVersion,
    },
    databaseCompatibility: {
      contract: DATABASE_CONTRACT,
      rollbackSafe: true,
    },
    assets: assets.sort((left, right) => left.arch.localeCompare(right.arch)),
  };
}

export async function run(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const assets = SUPPORTED_ARCHITECTURES.map((arch) =>
    required(args[`asset-${arch}`], `asset-${arch}`),
  );
  const manifest = createRuntimeManifest({
    version: args.version,
    revision: args.revision,
    protocolVersion: args["entrypoint-protocol"] || "2",
    nodeMajor: args["node-major"],
    modulesAbi: args["modules-abi"],
    libc: args.libc,
    libcVersion: args["libc-version"],
    assets,
  });
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  if (!args.output) {
    process.stdout.write(body);
    return manifest;
  }

  const output = path.resolve(args.output);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, body, { encoding: "utf8", mode: 0o600 });
  return manifest;
}

function isMainModule() {
  const script = process.argv[1];
  return (
    !!script && import.meta.url === pathToFileURL(path.resolve(script)).href
  );
}

if (isMainModule()) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
