#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const IMAGE_PATTERN = /^[a-z0-9][a-z0-9.-]*(?:\/[a-z0-9][a-z0-9._-]*)+$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const REVISION_PATTERN = /^[0-9a-f]{40,64}$/;
const DEPLOYMENT_CONTRACT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RUNTIME_MANIFEST_NAME = "cloudssh-self-update.json";

function positiveInteger(value, name) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
  return normalized;
}

function required(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`缺少 ${name}`);
  return normalized;
}

export function createReleaseManifest(input) {
  const version = required(input.version, "version");
  if (version.length > 64 || !VERSION_PATTERN.test(version)) {
    throw new Error("版本号格式无效");
  }

  const image = required(input.image, "image").toLowerCase();
  if (
    !IMAGE_PATTERN.test(image) ||
    image.includes("@") ||
    image.includes(":")
  ) {
    throw new Error("镜像仓库格式无效");
  }
  const digest = required(input.digest, "digest").toLowerCase();
  if (!DIGEST_PATTERN.test(digest)) throw new Error("镜像摘要格式无效");

  const revision = required(input.revision, "revision").toLowerCase();
  if (!REVISION_PATTERN.test(revision)) throw new Error("源码提交格式无效");

  const runtimeManifest = required(
    input.runtimeManifest || RUNTIME_MANIFEST_NAME,
    "runtimeManifest",
  );
  if (runtimeManifest !== RUNTIME_MANIFEST_NAME) {
    throw new Error("运行包清单名称无效");
  }
  const runtimeManifestSha256 = required(
    input.runtimeManifestSha256,
    "runtimeManifestSha256",
  ).toLowerCase();
  if (!SHA256_PATTERN.test(runtimeManifestSha256)) {
    throw new Error("运行包清单 SHA-256 无效");
  }

  const minEntrypointProtocol = positiveInteger(
    input.minEntrypointProtocol,
    "minEntrypointProtocol",
  );
  const deploymentContract = required(
    input.deploymentContract,
    "deploymentContract",
  ).toLowerCase();
  if (!DEPLOYMENT_CONTRACT_PATTERN.test(deploymentContract)) {
    throw new Error("部署契约格式无效");
  }

  return {
    schemaVersion: 3,
    channel: "stable",
    version,
    image,
    digest,
    revision,
    runtime: {
      manifest: runtimeManifest,
      sha256: runtimeManifestSha256,
    },
    minEntrypointProtocol,
    deploymentContract,
  };
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

export async function run(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const manifest = createReleaseManifest({
    version: args.version,
    image: args.image,
    digest: args.digest,
    revision: args.revision,
    runtimeManifest: args["runtime-manifest"] || RUNTIME_MANIFEST_NAME,
    runtimeManifestSha256: args["runtime-manifest-sha256"],
    minEntrypointProtocol: args["min-entrypoint-protocol"] || "2",
    deploymentContract:
      args["deployment-contract"] || "cloudssh-self-update-v1",
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
