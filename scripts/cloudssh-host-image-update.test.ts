import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const updaterPath = "scripts/cloudssh-host-image-update.sh";

async function makeExecutable(filePath: string): Promise<void> {
  await chmod(
    filePath,
    constants.S_IRUSR | constants.S_IWUSR | constants.S_IXUSR,
  );
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function toShellPath(value: string): string {
  if (process.platform !== "win32") return value;
  const normalized = path.resolve(value).replace(/\\/g, "/");
  return normalized.replace(
    /^([A-Za-z]):/,
    (_match, drive: string) => `/${drive.toLowerCase()}`,
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

describe("CloudSSH 宿主机镜像更新器", () => {
  it("只信任固定仓库的已校验正式 Release 离线镜像", async () => {
    const updater = await readFile(updaterPath, "utf8");

    expect(updater).toContain('REPOSITORY="moeacgx/cloudssh"');
    expect(updater).toContain('TAG="release-$VERSION-tag"');
    expect(updater).toContain(
      'ARCHIVE="cloudssh-image-$VERSION-linux-$ARCH.tar.gz"',
    );
    expect(updater).toContain("validate_release_manifest");
    expect(updater).toContain('sha256_check "$RELEASE_MANIFEST.sha256"');
    expect(updater).toContain('sha256_check "$ARCHIVE.sha256"');
    expect(updater).toContain("\"$TARGET_IMAGE\" --format '{{.Id}}'");
    expect(updater).toContain("\"$TARGET_IMAGE\" --format '{{.Architecture}}'");
    expect(updater).toContain(
      '"$TARGET_IMAGE" --format \'{{index .Config.Labels "org.opencontainers.image.version"}}\'',
    );
  });

  it("在切换前备份，并为失败的新容器恢复已运行镜像", async () => {
    const updater = await readFile(updaterPath, "utf8");
    const stopServices = updater.indexOf("stop --timeout 60 cloudssh guacd");
    const backup = updater.indexOf(
      'sh scripts/cloudssh-backup.sh "$BACKUP_DIR"',
    );
    const switchOver = updater.indexOf('CLOUDSSH_IMAGE="$TARGET_IMAGE"');

    expect(stopServices).toBeGreaterThan(0);
    expect(backup).toBeGreaterThan(stopServices);
    expect(switchOver).toBeGreaterThan(backup);
    expect(updater).toContain('PREVIOUS_IMAGE="$(docker inspect');
    expect(updater).toContain("ROLLBACK_REQUIRED=1");
    expect(updater).toContain("restore_previous_image()");
    expect(updater).toContain('CLOUDSSH_IMAGE="$PREVIOUS_IMAGE"');
    expect(updater).toContain('wait_for_health "$HEALTH_URL"');
  });

  it("保留 Docker 守护进程的宿主机边界", async () => {
    const updater = await readFile(updaterPath, "utf8");

    expect(updater).toContain(
      "application container, so the panel never receives Docker daemon access.",
    );
    expect(updater).not.toContain("/var/run/docker.sock");
    expect(updater).not.toContain("DOCKER_HOST=");
  });

  it("执行已校验镜像的备份、切换和健康检查路径", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cloudssh-host-update-"));
    try {
      const installDir = path.join(root, "cloudssh");
      const fixturesDir = path.join(root, "fixtures");
      const mockBin = path.join(root, "mock-bin");
      const logPath = path.join(root, "commands.log");
      await Promise.all([
        mkdir(path.join(installDir, "docker"), { recursive: true }),
        mkdir(path.join(installDir, "scripts"), { recursive: true }),
        mkdir(fixturesDir, { recursive: true }),
        mkdir(mockBin, { recursive: true }),
      ]);

      const version = "2.6.0-cloudssh.34";
      const archiveName = `cloudssh-image-${version}-linux-amd64.tar.gz`;
      const manifestName = "cloudssh-release.json";
      const manifest = `${JSON.stringify(
        {
          schemaVersion: 3,
          channel: "stable",
          version,
          image: "ghcr.io/moeacgx/cloudssh",
          digest: `sha256:${"a".repeat(64)}`,
          revision: "b".repeat(40),
          runtime: {
            manifest: "cloudssh-self-update.json",
            sha256: "c".repeat(64),
          },
          minEntrypointProtocol: 2,
          deploymentContract: "cloudssh-self-update-v1",
        },
        null,
        2,
      )}\n`;
      const archive = gzipSync(Buffer.from("mock docker image"), { mtime: 0 });
      await writeFile(path.join(fixturesDir, manifestName), manifest);
      await writeFile(
        path.join(fixturesDir, `${manifestName}.sha256`),
        `${sha256(manifest)}  ${manifestName}\n`,
      );
      await writeFile(path.join(fixturesDir, archiveName), archive);
      await writeFile(
        path.join(fixturesDir, `${archiveName}.id`),
        "sha256:mock-image\n",
      );
      await writeFile(
        path.join(fixturesDir, `${archiveName}.sha256`),
        `${sha256(archive)}  ${archiveName}\n${sha256("sha256:mock-image\n")}  ${archiveName}.id\n`,
      );
      await writeFile(path.join(installDir, "docker", ".env"), "");
      await writeFile(
        path.join(installDir, "docker", "docker-compose.cloudssh.yml"),
        "services: {}\n",
      );
      const backupScript = path.join(
        installDir,
        "scripts",
        "cloudssh-backup.sh",
      );
      await writeFile(
        backupScript,
        '#!/bin/sh\nprintf "%s\\n" backup >> "$MOCK_LOG"\n',
      );
      await makeExecutable(backupScript);

      const curlMock = path.join(mockBin, "curl");
      await writeFile(
        curlMock,
        '#!/bin/sh\nset -eu\nout=""\nurl=""\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--output" ]; then out="$2"; shift 2; continue; fi\n  url="$1"\n  shift\ndone\nif [ -z "$out" ]; then exit 0; fi\ncp "$FIXTURE_DIR/${url##*/}" "$out"\n',
      );
      await makeExecutable(curlMock);

      const unameMock = path.join(mockBin, "uname");
      await writeFile(unameMock, "#!/bin/sh\necho x86_64\n");
      await makeExecutable(unameMock);

      const dockerMock = path.join(mockBin, "docker");
      await writeFile(
        dockerMock,
        `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$MOCK_LOG"
if [ "$1" = "load" ]; then cat >/dev/null; exit 0; fi
if [ "$1" = "inspect" ]; then echo "cloudssh-termix:previous"; exit 0; fi
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  if [ "$3" = "cloudssh-termix:previous" ] && [ "$#" -eq 3 ]; then exit 0; fi
  case "\${5:-}" in
    '{{.Id}}') echo "sha256:mock-image" ;;
    '{{.Architecture}}') echo "amd64" ;;
    *org.opencontainers.image.version*) echo "${version}" ;;
    *) exit 0 ;;
  esac
  exit 0
fi
if [ "$1" = "compose" ]; then
  case " $* " in
    *" port cloudssh 8080 "*) echo "127.0.0.1:18080" ;;
    *" ps -q cloudssh "*) echo "mock-container" ;;
    *" stop --timeout 60 cloudssh guacd "*) : ;;
    *" up -d guacd "*) : ;;
    *" up -d --no-deps --force-recreate cloudssh "*) : ;;
    *" start guacd cloudssh "*) : ;;
    *) echo "unexpected compose invocation: $*" >&2; exit 1 ;;
  esac
  exit 0
fi
echo "unexpected docker invocation: $*" >&2
exit 1
`,
      );
      await makeExecutable(dockerMock);

      const result = spawnSync(
        "sh",
        [
          "-c",
          `PATH=${shellQuote(toShellPath(mockBin))}:$PATH exec sh ${shellQuote(updaterPath)}`,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            FIXTURE_DIR: toShellPath(fixturesDir),
            MOCK_LOG: toShellPath(logPath),
            CLOUDSSH_INSTALL_DIR: toShellPath(installDir),
            CLOUDSSH_VERSION: version,
            CLOUDSSH_HEALTH_TIMEOUT_SECONDS: "4",
          },
          timeout: 10_000,
        },
      );

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain(`CloudSSH 已更新至 ${version}`);
      const log = await readFile(logPath, "utf8");
      expect(
        log.indexOf("stop --timeout 60 cloudssh guacd"),
      ).toBeGreaterThanOrEqual(0);
      expect(log.indexOf("backup")).toBeGreaterThan(
        log.indexOf("stop --timeout 60 cloudssh guacd"),
      );
      expect(
        log.indexOf("up -d --no-deps --force-recreate cloudssh"),
      ).toBeGreaterThan(log.indexOf("backup"));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 15_000);
});
