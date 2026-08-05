import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const temporaryDirectories: string[] = [];
const originalDataDirectory = process.env.DATA_DIR;
const originalJwtSecret = process.env.JWT_SECRET;

afterEach(async () => {
  vi.resetModules();
  if (originalDataDirectory === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDirectory;
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwtSecret;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform === "win32")(
  "SystemCrypto 密钥文件权限",
  () => {
    it("创建或更新 .env 后强制仅属主可读写", async () => {
      const dataDirectory = await mkdtemp(
        path.join(os.tmpdir(), "cloudssh-system-crypto-"),
      );
      temporaryDirectories.push(dataDirectory);
      const envPath = path.join(dataDirectory, ".env");
      await writeFile(envPath, "JWT_SECRET=too-short\n", { mode: 0o644 });
      process.env.DATA_DIR = dataDirectory;
      delete process.env.JWT_SECRET;

      const { SystemCrypto } = await import("../../utils/system-crypto.js");
      await SystemCrypto.getInstance().getJWTSecret();

      expect((await stat(envPath)).mode & 0o777).toBe(0o600);
    });
  },
);
