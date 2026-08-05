import { createHash } from "crypto";
import { existsSync } from "fs";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "fs/promises";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { createRequire } from "module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as typeof import("js-yaml");

const root = process.cwd();
const backupScript = path.join(root, "scripts/cloudssh-backup.sh");
const restoreScript = path.join(root, "scripts/cloudssh-verify-restore.sh");
const migrationScript = path.join(
  root,
  "scripts/cloudssh-migrate-recordings.sh",
);
const requiredStateFiles = [
  ".env",
  "db.sqlite.encrypted",
  "agent/runtime-state.json",
  "agent/agent-security.sqlite",
];
const requiredManifestEntries = [
  ...requiredStateFiles.map((file) => `data/${file}`),
  "recordings/",
];

const shell = [
  process.env.CLOUDSSH_TEST_SHELL,
  process.platform === "win32"
    ? "C:\\Program Files\\Git\\bin\\sh.exe"
    : undefined,
  process.platform === "win32"
    ? "D:\\Program Files\\Git\\bin\\sh.exe"
    : undefined,
  process.platform === "win32" ? undefined : "/bin/sh",
].find(
  (candidate): candidate is string => !!candidate && existsSync(candidate),
);

const temporaryDirectories: string[] = [];
const dockerHostUserArguments =
  process.platform !== "win32" &&
  typeof process.getuid === "function" &&
  typeof process.getgid === "function"
    ? ["--user", `${process.getuid()}:${process.getgid()}`]
    : [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function shellPath(filePath: string): string {
  if (process.platform !== "win32") return filePath;
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(filePath);
  if (!match) return filePath.replaceAll("\\", "/");
  return `/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}

async function createHarness() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cloudssh-backup-test-"),
  );
  temporaryDirectories.push(directory);
  const bin = path.join(directory, "bin");
  const log = path.join(directory, "docker.log");
  const stopped = path.join(directory, "stopped");
  const volumeLabel = path.join(directory, "volume-label");
  await mkdir(bin);
  const docker = path.join(bin, "docker");
  await writeFile(
    docker,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$MOCK_DOCKER_LOG"

if [ "$1" = "compose" ]; then
  service=""
  operation=""
  for argument in "$@"; do
    case "$argument" in
      ps|logs) operation="$argument" ;;
      cloudssh|guacd) service="$argument" ;;
    esac
  done
  if [ "$operation" = "ps" ]; then
    [ "${"$"}MOCK_PS_FAIL" != "$service" ] || exit 41
    echo "${"$"}{service}-container"
    exit 0
  fi
  if [ "$operation" = "logs" ]; then
    [ "${"$"}{MOCK_LOGS_FAIL:-0}" != "1" ] || exit 42
    [ "${"$"}{MOCK_CHECKPOINT:-1}" != "1" ] || echo "[INFO] op:shutdown_db_saved"
    exit 0
  fi
fi

if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  [ "${"$"}{MOCK_IMAGE_MISSING:-0}" != "1" ]
  exit "$?"
fi

if [ "$1" = "volume" ] && [ "$2" = "ls" ]; then
  [ -z "${"$"}{MOCK_EXISTING_VOLUME:-}" ] || echo "${"$"}MOCK_EXISTING_VOLUME"
  exit 0
fi

if [ "$1" = "volume" ] && [ "$2" = "create" ]; then
  last=""
  verification=""
  role=""
  for argument in "$@"; do
    last="$argument"
    case "$argument" in
      cloudssh.restore-verification=*)
        verification="${"$"}{argument#*=}"
        ;;
      cloudssh.restore-role=*)
        role="${"$"}{argument#*=}"
        ;;
    esac
  done
  printf '%s %s' "$verification" "$role" > "$MOCK_VOLUME_LABEL_FILE.$last"
  echo "$last"
  exit 0
fi

if [ "$1" = "volume" ] && [ "$2" = "inspect" ]; then
  last=""
  for argument in "$@"; do last="$argument"; done
  cat "$MOCK_VOLUME_LABEL_FILE.$last"
  exit 0
fi

if [ "$1" = "inspect" ]; then
  last=""
  for argument in "$@"; do last="$argument"; done
  case " $* " in
    *".Mounts"*)
      case "$last" in
        cloudssh-container)
          printf '%s|/app/data|%s\n' \
            "${"$"}{MOCK_DATA_MOUNT_TYPE:-volume}" \
            "${"$"}{MOCK_CLOUDSSH_DATA_VOLUME:-cloudssh-data}"
          printf 'volume|/app/data/session_recordings/guacamole|%s\n' \
            "${"$"}{MOCK_CLOUDSSH_RECORDINGS_VOLUME:-cloudssh-recordings}"
          ;;
        guacd-container)
          printf 'volume|/termix-data/session_recordings/guacamole|%s\n' \
            "${"$"}{MOCK_GUACD_RECORDINGS_VOLUME:-cloudssh-recordings}"
          ;;
      esac
      exit 0
      ;;
  esac
  case "$last" in
    cloudssh-container)
      echo "${"$"}{MOCK_CLOUDSSH_STATE:-false 0 60}"
      ;;
    guacd-container)
      echo "${"$"}{MOCK_GUACD_STATE:-false 0 60}"
      ;;
    *)
      if [ -f "$MOCK_STOPPED_FILE" ]; then
        echo "false 0"
      else
        echo "true"
      fi
      ;;
  esac
  exit 0
fi

if [ "$1" = "run" ]; then
  if [ "${"$"}{MOCK_CHECKPOINT:-1}" = "0" ]; then
    echo "缺少正常关机完成标记" >&2
    exit 2
  fi
  case " $* " in
    *"dst=/source/data"*)
      output_directory=""
      partial_name=""
      for argument in "$@"; do
        case "$argument" in
          type=bind,src=*,dst=/backup)
            output_directory="${"$"}{argument#type=bind,src=}"
            output_directory="${"$"}{output_directory%,dst=/backup}"
            ;;
          BACKUP_ARCHIVE=*) partial_name="${"$"}{argument#*=}" ;;
        esac
      done
      [ -n "$output_directory" ] && [ -n "$partial_name" ] || exit 43
      printf 'mock archive' > "$output_directory/$partial_name"
      ;;
  esac
  exit 0
fi

if [ "$1" = "exec" ]; then
  exit 0
fi

if [ "$1" = "stop" ]; then
  : > "$MOCK_STOPPED_FILE"
  exit 0
fi

if [ "$1" = "logs" ]; then
  echo "[SUCCESS] op:backend_init_complete"
  echo "[INFO] op:shutdown_db_saved"
  exit 0
fi

if [ "$1" = "rm" ]; then
  exit 0
fi

echo "unexpected docker invocation: $*" >&2
exit 99
`,
    { mode: 0o755 },
  );
  await chmod(docker, 0o755);
  return { directory, bin, log, stopped, volumeLabel };
}

function runShellScript(
  script: string,
  args: string[],
  harness: Awaited<ReturnType<typeof createHarness>>,
  environment: Record<string, string> = {},
) {
  if (!shell) throw new Error("没有可用的 POSIX shell");
  return spawnSync(
    shell,
    [
      "-c",
      'PATH="$MOCK_BIN:$PATH"; export PATH; exec sh "$SCRIPT" "$@"',
      "cloudssh-test",
      ...args.map(shellPath),
    ],
    {
      cwd: harness.directory,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        ...environment,
        CHERE_INVOKING: "1",
        MOCK_BIN: shellPath(harness.bin),
        MOCK_DOCKER_LOG: shellPath(harness.log),
        MOCK_STOPPED_FILE: shellPath(harness.stopped),
        MOCK_VOLUME_LABEL_FILE: shellPath(harness.volumeLabel),
        SCRIPT: shellPath(script),
      },
    },
  );
}

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

type Command = {
  executable: string;
  prefixArguments: string[];
};

type TarMember = {
  name: string;
  kind: "directory" | "file" | "symlink" | "hardlink" | "fifo";
  content?: string;
  linkName?: string;
};

type PythonArchiveVerifier = {
  program: string;
  prefixArguments: string[];
};

function findHostPython(): Command | null {
  const candidates: Command[] = [
    ...(process.env.CLOUDSSH_TEST_PYTHON
      ? [
          {
            executable: process.env.CLOUDSSH_TEST_PYTHON,
            prefixArguments: [],
          },
        ]
      : []),
    { executable: "python3", prefixArguments: [] },
    { executable: "python", prefixArguments: [] },
    ...(process.platform === "win32"
      ? [{ executable: "py", prefixArguments: ["-3"] }]
      : []),
  ];

  for (const candidate of candidates) {
    const result = spawnSync(
      candidate.executable,
      [...candidate.prefixArguments, "--version"],
      { encoding: "utf8", timeout: 5_000 },
    );
    if (result.status === 0) return candidate;
  }
  return null;
}

function hasDockerDaemon(): boolean {
  const result = spawnSync(
    "docker",
    ["info", "--format", "{{json .ServerVersion}}"],
    { encoding: "utf8", timeout: 10_000 },
  );
  return result.status === 0;
}

async function loadPythonArchiveVerifier(): Promise<PythonArchiveVerifier> {
  const normalized = (await readFile(restoreScript, "utf8")).replaceAll(
    "\r\n",
    "\n",
  );
  const heredoc = normalized.match(
    /<<'PY_ARCHIVE'\n([\s\S]*?)\nPY_ARCHIVE(?:\n|$)/,
  );
  if (heredoc) {
    return { program: heredoc[1], prefixArguments: [] };
  }

  const scriptName = /^SAFE_ARCHIVE_SCRIPT="\$\{SCRIPT_DIR\}\/([^"]+)"$/m.exec(
    normalized,
  )?.[1];
  if (
    !scriptName ||
    !normalized.includes(
      '--mount "type=bind,src=${SAFE_ARCHIVE_SCRIPT},dst=/cloudssh-safe-archive.py,readonly"',
    ) ||
    !normalized.includes('"$VERIFY_IMAGE" /cloudssh-safe-archive.py extract')
  ) {
    throw new Error("恢复脚本既没有 PY_ARCHIVE，也没有可解析的安全解包器");
  }
  return {
    program: await readFile(
      path.join(path.dirname(restoreScript), scriptName),
      "utf8",
    ),
    prefixArguments: ["extract"],
  };
}

function extractMigrationHelper(script: string): {
  image: string;
  program: string;
} {
  const normalized = script.replaceAll("\r\n", "\n");
  const image = /^HELPER_IMAGE="([^"]+)"$/m.exec(normalized)?.[1];
  const program =
    /"\$HELPER_IMAGE" \\\n\s+sh -ec '\n([\s\S]*?)\n\s+' \|\| fail/.exec(
      normalized,
    )?.[1];
  if (!image || !program) {
    throw new Error("无法从录像迁移脚本提取固定 Alpine 校验程序");
  }
  return { image, program };
}

function runPython(python: Command, arguments_: string[], input?: string) {
  return spawnSync(
    python.executable,
    [...python.prefixArguments, ...arguments_],
    {
      encoding: "utf8",
      input,
      timeout: 10_000,
    },
  );
}

function createTarArchive(
  python: Command,
  archive: string,
  members: TarMember[],
) {
  const generator = String.raw`
import base64
import io
import json
import sys
import tarfile

archive_path = sys.argv[1]
members = json.loads(base64.b64decode(sys.argv[2]).decode("utf-8"))
with tarfile.open(archive_path, mode="w:gz", format=tarfile.PAX_FORMAT) as output:
    for item in members:
        info = tarfile.TarInfo(item["name"])
        info.mode = 0o700 if item["kind"] == "directory" else 0o600
        if item["kind"] == "directory":
            info.type = tarfile.DIRTYPE
            output.addfile(info)
        elif item["kind"] == "file":
            content = item.get("content", "").encode("utf-8")
            info.size = len(content)
            output.addfile(info, io.BytesIO(content))
        elif item["kind"] == "symlink":
            info.type = tarfile.SYMTYPE
            info.linkname = item.get("linkName", "data/valid.txt")
            output.addfile(info)
        elif item["kind"] == "hardlink":
            info.type = tarfile.LNKTYPE
            info.linkname = item.get("linkName", "data/valid.txt")
            output.addfile(info)
        elif item["kind"] == "fifo":
            info.type = tarfile.FIFOTYPE
            output.addfile(info)
        else:
            raise ValueError(f"unknown member kind: {item['kind']}")
`;
  const encodedMembers = Buffer.from(JSON.stringify(members)).toString(
    "base64",
  );
  const result = runPython(python, ["-c", generator, archive, encodedMembers]);
  if (result.status !== 0) {
    throw new Error(`创建测试 tar 失败：${result.stdout}\n${result.stderr}`);
  }
}

function runArchiveVerifier(
  python: Command,
  verifier: PythonArchiveVerifier,
  archive: string,
  dataRoot: string,
  recordingsRoot: string,
) {
  return runPython(
    python,
    ["-", ...verifier.prefixArguments, archive, dataRoot, recordingsRoot],
    verifier.program,
  );
}

async function createArchiveRoots(directory: string) {
  const dataRoot = path.join(directory, "restore-data");
  const recordingsRoot = path.join(directory, "restore-recordings");
  await Promise.all([mkdir(dataRoot), mkdir(recordingsRoot)]);
  return { dataRoot, recordingsRoot };
}

async function createRecordingFixture(directory: string) {
  const legacyRoot = path.join(directory, "legacy");
  const sourceRoot = path.join(legacyRoot, "session_recordings", "guacamole");
  const recordingsRoot = path.join(directory, "recordings");
  await Promise.all([
    mkdir(path.join(sourceRoot, "nested"), { recursive: true }),
    mkdir(recordingsRoot, { recursive: true }),
  ]);
  await writeFile(path.join(sourceRoot, "nested", "session.cast"), "alpha");
  return { legacyRoot, sourceRoot, recordingsRoot };
}

function runMigrationHelper(
  helper: { image: string; program: string },
  legacyRoot: string,
  recordingsRoot: string,
) {
  return spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      ...dockerHostUserArguments,
      "-e",
      "LEGACY_DATA_VOLUME=cloudssh-legacy-test",
      "--mount",
      `type=bind,src=${legacyRoot},dst=/legacy,readonly`,
      "--mount",
      `type=bind,src=${recordingsRoot},dst=/recordings`,
      helper.image,
      "sh",
      "-ec",
      helper.program,
    ],
    { encoding: "utf8", timeout: 55_000 },
  );
}

function mutateRecordingRoot(
  image: string,
  recordingsRoot: string,
  program: string,
) {
  return spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      ...dockerHostUserArguments,
      "--mount",
      `type=bind,src=${recordingsRoot},dst=/recordings`,
      image,
      "sh",
      "-ec",
      program,
    ],
    { encoding: "utf8", timeout: 55_000 },
  );
}

const hostPython = findHostPython();
const dockerDaemonAvailable = hasDockerDaemon();

async function createRestoreFixture(directory: string) {
  const archiveName = "cloudssh-state-20260731T000000Z.tar.gz";
  const archive = path.join(directory, archiveName);
  const manifest = `${archive}.manifest`;
  const key = path.join(directory, "cloudssh_master_key");
  const archiveContents = Buffer.from("mock archive");
  const manifestContents = `${requiredManifestEntries.join("\n")}\n`;
  await writeFile(archive, archiveContents);
  await writeFile(manifest, manifestContents);
  await writeFile(key, Buffer.alloc(32).toString("base64"));
  await writeFile(
    `${archive}.sha256`,
    `${sha256(archiveContents)}  ${archiveName}\n${sha256(manifestContents)}  ${path.basename(manifest)}\n`,
  );
  return { archive, manifest, key };
}

describe("CloudSSH 备份恢复契约", () => {
  it("Docker 构建上下文排除所有本地密钥和持久数据目录", async () => {
    const dockerignore = (
      await readFile(path.join(root, ".dockerignore"), "utf8")
    )
      .split(/\r?\n/)
      .map((entry) => entry.trim());

    for (const protectedPath of [
      "/.env",
      "/secrets/",
      "/db/",
      "/backups/",
      "/ssl/",
    ]) {
      expect(dockerignore).toContain(protectedPath);
    }
  });

  it("备份、恢复和文档同时覆盖全部必需状态文件", async () => {
    const [backup, restore, documentation] = await Promise.all([
      readFile(backupScript, "utf8"),
      readFile(restoreScript, "utf8"),
      readFile(path.join(root, "docs/CLOUDSSH.md"), "utf8"),
    ]);

    for (const required of requiredStateFiles) {
      expect(backup).toContain(required);
      expect(restore).toContain(required);
      expect(documentation).toContain(required);
    }
    expect(backup).toContain("recordings/");
    expect(restore).toContain("recordings/");
    expect(documentation).toContain("cloudssh-recordings");
  });

  it("两个共享卷写入服务都使用至少 60 秒的停止时限", async () => {
    const compose = yaml.load(
      await readFile(
        path.join(root, "docker/docker-compose.cloudssh.yml"),
        "utf8",
      ),
    ) as {
      services: Record<
        string,
        {
          stop_grace_period?: string;
          volumes?: string[];
          environment?: Record<string, string>;
        }
      >;
      volumes: Record<string, { name?: string }>;
    };

    expect(compose.services.cloudssh.stop_grace_period).toBe("60s");
    expect(compose.services.guacd.stop_grace_period).toBe("60s");
    expect(compose.services.cloudssh.volumes).toContain(
      "cloudssh-data:/app/data",
    );
    expect(compose.services.cloudssh.volumes).toContain(
      "cloudssh-recordings:/app/data/session_recordings/guacamole",
    );
    expect(compose.services.guacd.volumes).toEqual([
      "cloudssh-recordings:/termix-data/session_recordings/guacamole",
    ]);
    expect(compose.services.guacd.volumes).not.toContain(
      "cloudssh-data:/termix-data",
    );
    expect(compose.services.cloudssh.environment).toMatchObject({
      GUACD_RECORDING_PATH: "/termix-data/session_recordings/guacamole",
      GUACD_RECORDING_BACKEND_PATH: "/app/data/session_recordings/guacamole",
    });
    expect(compose.volumes["cloudssh-recordings"].name).toBe(
      "${CLOUDSSH_RECORDINGS_VOLUME:-cloudssh-recordings}",
    );
  });

  it("容器入口让 Node 作为 PID 1 接收优雅停止信号", async () => {
    const entrypoint = await readFile(
      path.join(root, "docker/entrypoint.sh"),
      "utf8",
    );

    expect(entrypoint).toMatch(
      /exec node dist\/backend\/backend\/starter\.js\s*$/,
    );
    expect(entrypoint).not.toContain("tail -f /dev/null");
  });

  it("备份容器内的关机标记正则不会截断外层单引号脚本", async () => {
    const backup = await readFile(backupScript, "utf8");

    expect(backup).toContain('grep -Eq "^\\{\\"completedAt\\":\\"[0-9]{4}');
    expect(backup).not.toContain("grep -Eq '^\\{");
  });

  it("恢复校验包含强制校验链、结构检查、解密和隔离启动", async () => {
    const [restore, safeArchive, stateValidator] = await Promise.all([
      readFile(restoreScript, "utf8"),
      readFile(path.join(root, "scripts/cloudssh-safe-archive.py"), "utf8"),
      readFile(
        path.join(root, "scripts/cloudssh-verify-restored-state.mjs"),
        "utf8",
      ),
    ]);

    expect(restore).toContain("缺少必需备份清单");
    expect(restore).toContain("缺少必需 SHA-256 校验文件");
    expect(restore).toContain("cloudssh-verify-restored-state.mjs");
    expect(restore).toContain(
      "type=bind,src=${STATE_VALIDATOR_SCRIPT},dst=/cloudssh-verify-restored-state.mjs,readonly",
    );
    expect(restore).toContain("--network none");
    expect(restore).toContain("http://127.0.0.1:30001/health");
    expect(restore).toContain("http://127.0.0.1:30013/agent/v1/health");
    expect(restore).toContain("op:backend_init_complete");
    expect(restore).toContain("docker stop --timeout 60");
    expect(restore).toContain(".cloudssh-clean-shutdown");
    expect(restore).toContain("cloudssh-safe-archive.py");
    expect(restore).not.toMatch(/"\$VERIFY_IMAGE"\s+-\s*(?:\\?\r?\n|$)/);
    expect(safeArchive).toContain("tarfile.open");
    expect(safeArchive).toContain("member.isfile()");
    expect(safeArchive).toContain("entry_stat.st_nlink != 1");
    expect(safeArchive).toContain("归档包含符号链接、硬链接或特殊文件");
    expect(restore).toContain("/recordings,readonly");
    expect(stateValidator).toContain("JSON.parse");
    expect(stateValidator).toContain("integrity_check");
    expect(stateValidator).toContain("vault.decrypt");
    expect(stateValidator).toContain("project_session_recordings");
    expect(stateValidator).toContain("session_recordings");
    expect(stateValidator).toContain('typeof recording.checksum !== "string"');
    expect(stateValidator).toContain("checksum does not match the database");
  });

  it("旧录像迁移只复制并逐文件校验，不删除原数据", async () => {
    const migration = await readFile(migrationScript, "utf8");

    expect(migration).toContain("dst=/legacy,readonly");
    expect(migration).toContain("cp -a -n");
    expect(migration).toContain("copy_missing_source_entries");
    expect(migration).toContain("destination_hash");
    expect(migration).toContain("stat -c %h");
    expect(migration).toContain("不允许的硬链接");
    expect(migration).toContain("source_digest=");
    expect(migration).toContain("sha256sum");
    expect(migration).toContain(".cloudssh-legacy-source");
    expect(migration).not.toMatch(/\brm\s+-r/);

    const backup = await readFile(backupScript, "utf8");
    expect(backup).toContain(".cloudssh-legacy-source");
    expect(backup).toContain("marker_digest");
    expect(backup).toContain("legacy_digest");
    expect(backup).toContain("verify_legacy_copy");
    expect(backup).toContain("stat -c %h");
    expect(backup).toContain("不允许的硬链接");
    expect(backup).toContain("重新运行 cloudssh-migrate-recordings.sh");
  });

  it("所有备份与恢复辅助容器默认禁用网络", async () => {
    const [backup, migration, restore] = await Promise.all([
      readFile(backupScript, "utf8"),
      readFile(migrationScript, "utf8"),
      readFile(restoreScript, "utf8"),
    ]);

    expect(backup).toMatch(/docker run --rm --network none/);
    expect(migration).toMatch(/docker run --rm --network none/);
    const normalizedRestore = restore.replaceAll("\r\n", "\n");
    for (const invocation of normalizedRestore.match(
      /docker run[^\n]*(?:\n[ \t]+[^\n]*)*/g,
    ) ?? []) {
      expect(invocation).toContain("--network none");
    }
  });
});

describe.skipIf(!hostPython)("真实 PY_ARCHIVE 安全解压契约", () => {
  it("从恢复脚本提取校验器并安全解压正常 tar", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "cloudssh-real-archive-test-"),
    );
    temporaryDirectories.push(directory);
    const archive = path.join(directory, "valid.tar.gz");
    const { dataRoot, recordingsRoot } = await createArchiveRoots(directory);
    const verifier = await loadPythonArchiveVerifier();

    createTarArchive(hostPython!, archive, [
      { name: "data", kind: "directory" },
      { name: "recordings", kind: "directory" },
      { name: "data/.env", kind: "file", content: "SECRET=test\n" },
      {
        name: "recordings/session.cast",
        kind: "file",
        content: "recording",
      },
    ]);

    const result = runArchiveVerifier(
      hostPython!,
      verifier,
      archive,
      dataRoot,
      recordingsRoot,
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    await expect(readFile(path.join(dataRoot, ".env"), "utf8")).resolves.toBe(
      "SECRET=test\n",
    );
    await expect(
      readFile(path.join(recordingsRoot, "session.cast"), "utf8"),
    ).resolves.toBe("recording");
  });

  it.each([
    ["绝对路径", { name: "/data/escape", kind: "file", content: "bad" }],
    ["父目录穿越", { name: "data/../escape", kind: "file", content: "bad" }],
    ["重复路径", { name: "data/valid.txt", kind: "file", content: "again" }],
    [
      "符号链接",
      {
        name: "data/link",
        kind: "symlink",
        linkName: "data/valid.txt",
      },
    ],
    [
      "硬链接",
      {
        name: "data/hardlink",
        kind: "hardlink",
        linkName: "data/valid.txt",
      },
    ],
    ["FIFO", { name: "recordings/pipe", kind: "fifo" }],
  ] satisfies [string, TarMember][])(
    "%s 成员失败，且目标目录没有部分写入",
    async (_label, invalidMember) => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "cloudssh-real-archive-test-"),
      );
      temporaryDirectories.push(directory);
      const archive = path.join(directory, "invalid.tar.gz");
      const { dataRoot, recordingsRoot } = await createArchiveRoots(directory);
      const verifier = await loadPythonArchiveVerifier();

      createTarArchive(hostPython!, archive, [
        { name: "data", kind: "directory" },
        { name: "recordings", kind: "directory" },
        { name: "data/valid.txt", kind: "file", content: "valid" },
        invalidMember,
      ]);

      const result = runArchiveVerifier(
        hostPython!,
        verifier,
        archive,
        dataRoot,
        recordingsRoot,
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/(?:安全解压失败|归档安全校验失败)/);
      await expect(readdir(dataRoot)).resolves.toEqual([]);
      await expect(readdir(recordingsRoot)).resolves.toEqual([]);
    },
  );
});

describe.skipIf(!dockerDaemonAvailable)(
  "固定 Alpine helper 的真实录像目录契约（Docker 不可用时明确跳过）",
  () => {
    it("目标存在额外文件时保留额外内容并完成迁移", async () => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "cloudssh-real-recording-test-"),
      );
      temporaryDirectories.push(directory);
      const fixture = await createRecordingFixture(directory);
      await writeFile(
        path.join(fixture.recordingsRoot, "target-only.cast"),
        "preserve",
      );
      const helper = extractMigrationHelper(
        await readFile(migrationScript, "utf8"),
      );

      const result = runMigrationHelper(
        helper,
        fixture.legacyRoot,
        fixture.recordingsRoot,
      );

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      await expect(
        readFile(
          path.join(fixture.recordingsRoot, "nested", "session.cast"),
          "utf8",
        ),
      ).resolves.toBe("alpha");
      await expect(
        readFile(path.join(fixture.recordingsRoot, "target-only.cast"), "utf8"),
      ).resolves.toBe("preserve");
      await expect(
        readFile(
          path.join(fixture.recordingsRoot, ".cloudssh-legacy-source"),
          "utf8",
        ),
      ).resolves.toContain("source_digest=");
    }, 60_000);

    it.each([
      [
        "marker 存在但缺少源文件",
        async (recordingsRoot: string, _image: string) => {
          await rm(path.join(recordingsRoot, "nested", "session.cast"));
          return { expected: "缺少迁移普通文件" };
        },
      ],
      [
        "同大小但内容不同",
        async (recordingsRoot: string, _image: string) => {
          await writeFile(
            path.join(recordingsRoot, "nested", "session.cast"),
            "omega",
          );
          return { expected: "SHA-256 不一致" };
        },
      ],
      [
        "文件大小不同",
        async (recordingsRoot: string, _image: string) => {
          await writeFile(
            path.join(recordingsRoot, "nested", "session.cast"),
            "different-length",
          );
          return { expected: "大小不一致" };
        },
      ],
      [
        "目标包含符号链接",
        async (recordingsRoot: string, image: string) => {
          const mutation = mutateRecordingRoot(
            image,
            recordingsRoot,
            "rm -f /recordings/nested/session.cast; ln -s ../target-only.cast /recordings/nested/session.cast",
          );
          expect(
            mutation.status,
            `${mutation.stdout}\n${mutation.stderr}`,
          ).toBe(0);
          return { expected: "包含不安全或不可读取的内容" };
        },
      ],
      [
        "目标包含 FIFO 特殊文件",
        async (recordingsRoot: string, image: string) => {
          const mutation = mutateRecordingRoot(
            image,
            recordingsRoot,
            "mkfifo /recordings/unsafe.pipe",
          );
          expect(
            mutation.status,
            `${mutation.stdout}\n${mutation.stderr}`,
          ).toBe(0);
          return { expected: "包含不安全或不可读取的内容" };
        },
      ],
    ] as const)(
      "%s 时拒绝带 marker 的目标录像目录",
      async (_label, mutate) => {
        const directory = await mkdtemp(
          path.join(os.tmpdir(), "cloudssh-real-recording-test-"),
        );
        temporaryDirectories.push(directory);
        const fixture = await createRecordingFixture(directory);
        await writeFile(
          path.join(fixture.recordingsRoot, "target-only.cast"),
          "preserve",
        );
        const helper = extractMigrationHelper(
          await readFile(migrationScript, "utf8"),
        );
        const initial = runMigrationHelper(
          helper,
          fixture.legacyRoot,
          fixture.recordingsRoot,
        );
        expect(initial.status, `${initial.stdout}\n${initial.stderr}`).toBe(0);

        const { expected } = await mutate(fixture.recordingsRoot, helper.image);
        const result = runMigrationHelper(
          helper,
          fixture.legacyRoot,
          fixture.recordingsRoot,
        );

        expect(result.status).toBe(2);
        expect(result.stderr).toContain(expected);
      },
      60_000,
    );
  },
);

describe.skipIf(!shell)("CloudSSH 备份脚本失败边界", () => {
  it("成功备份只发布带清单和校验和的完整归档", async () => {
    const harness = await createHarness();
    const output = path.join(harness.directory, "backups");
    const result = runShellScript(backupScript, [output], harness);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const files = await readdir(output);
    expect(files).toHaveLength(3);
    expect(files.some((file) => file.endsWith(".partial"))).toBe(false);
    expect(files.some((file) => file.endsWith(".tar.gz"))).toBe(true);
    expect(files.some((file) => file.endsWith(".manifest"))).toBe(true);
    expect(files.some((file) => file.endsWith(".sha256"))).toBe(true);
  });

  it.each(["cloudssh", "guacd"])(
    "Compose 状态查询失败（%s）时中止且不启动归档容器",
    async (service) => {
      const harness = await createHarness();
      const output = path.join(harness.directory, "backups");
      const result = runShellScript(backupScript, [output], harness, {
        MOCK_PS_FAIL: service,
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        `无法查询 Compose 服务 ${service} 的状态`,
      );
      expect(await readFile(harness.log, "utf8")).not.toContain("run --rm");
      expect(existsSync(output)).toBe(false);
    },
  );

  it.each([
    [
      "仍在运行",
      { MOCK_CLOUDSSH_STATE: "true 0 60" },
      "仍在写入共享数据卷",
      false,
    ],
    [
      "异常退出",
      { MOCK_CLOUDSSH_STATE: "false 137 60" },
      "上次退出码为 137",
      false,
    ],
    [
      "停止时限过短",
      { MOCK_CLOUDSSH_STATE: "false 0 10" },
      "至少需要 60 秒",
      false,
    ],
    ["缺少检查点", { MOCK_CHECKPOINT: "0" }, "缺少正常关机完成标记", true],
  ])(
    "%s 时拒绝备份",
    async (_name, environment, message, validationStarted) => {
      const harness = await createHarness();
      const result = runShellScript(
        backupScript,
        [path.join(harness.directory, "backups")],
        harness,
        environment,
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(message);
      const dockerLog = await readFile(harness.log, "utf8");
      expect(dockerLog.includes("run --rm")).toBe(validationStarted);
    },
  );

  it.each([
    [
      "guacd 使用了不同录像卷",
      { MOCK_GUACD_RECORDINGS_VOLUME: "wrong-recordings" },
      "不是同一个录像卷",
    ],
    [
      "主数据使用 bind mount",
      { MOCK_DATA_MOUNT_TYPE: "bind" },
      "必须使用 Docker 命名卷",
    ],
    [
      "配置的数据卷名与真实挂载不符",
      { CLOUDSSH_DATA_VOLUME: "wrong-data" },
      "与容器真实数据卷",
    ],
  ])("%s 时拒绝备份", async (_name, environment, message) => {
    const harness = await createHarness();
    const result = runShellScript(
      backupScript,
      [path.join(harness.directory, "backups")],
      harness,
      environment,
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(message);
    const dockerLog = await readFile(harness.log, "utf8");
    expect(dockerLog).not.toContain("run --rm");
  });
});

describe.skipIf(!shell)("CloudSSH 恢复脚本校验链", () => {
  it("缺少 manifest 时在任何 Docker 操作前失败", async () => {
    const harness = await createHarness();
    const fixture = await createRestoreFixture(harness.directory);
    await rm(fixture.manifest);
    const result = runShellScript(
      restoreScript,
      [
        fixture.archive,
        "cloudssh-restore-data-test",
        "cloudssh-restore-recordings-test",
        fixture.key,
      ],
      harness,
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("缺少必需备份清单");
    expect(existsSync(harness.log)).toBe(false);
  });

  it("缺少 checksum 时在任何 Docker 操作前失败", async () => {
    const harness = await createHarness();
    const fixture = await createRestoreFixture(harness.directory);
    await rm(`${fixture.archive}.sha256`);
    const result = runShellScript(
      restoreScript,
      [
        fixture.archive,
        "cloudssh-restore-data-test",
        "cloudssh-restore-recordings-test",
        fixture.key,
      ],
      harness,
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("缺少必需 SHA-256 校验文件");
    expect(existsSync(harness.log)).toBe(false);
  });

  it("清单被篡改时在创建隔离卷前失败", async () => {
    const harness = await createHarness();
    const fixture = await createRestoreFixture(harness.directory);
    await writeFile(fixture.manifest, "tampered\n");
    const result = runShellScript(
      restoreScript,
      [
        fixture.archive,
        "cloudssh-restore-data-test",
        "cloudssh-restore-recordings-test",
        fixture.key,
      ],
      harness,
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("备份清单 SHA-256 不匹配");
    expect(existsSync(harness.log)).toBe(false);
  }, 10_000);

  it("完整链会创建隔离卷、无网络启动应用并验证优雅退出", async () => {
    const harness = await createHarness();
    const fixture = await createRestoreFixture(harness.directory);
    const result = runShellScript(
      restoreScript,
      [
        fixture.archive,
        "cloudssh-restore-data-test",
        "cloudssh-restore-recordings-test",
        fixture.key,
      ],
      harness,
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("隔离恢复验证通过");
    const dockerLog = await readFile(harness.log, "utf8");
    expect(dockerLog).toContain("volume create --label");
    expect(dockerLog).toContain("cloudssh-restore-data-test");
    expect(dockerLog).toContain("cloudssh-restore-recordings-test");
    expect(dockerLog).toContain("--network none");
    expect(dockerLog).toContain("exec cloudssh-restore-verify-");
    expect(dockerLog).toContain("stop --timeout 60");
  });
});
