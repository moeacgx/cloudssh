#!/bin/sh
set -eu
set -f

if [ "$#" -ne 4 ]; then
  echo "用法：$0 <backup.tar.gz> <全新数据卷名> <全新录像卷名> <CloudSSH 根密钥文件>" >&2
  exit 2
fi

fail() {
  echo "恢复验证失败：$*" >&2
  exit 2
}

ARCHIVE_INPUT="$1"
TARGET_DATA_VOLUME="$2"
TARGET_RECORDINGS_VOLUME="$3"
MASTER_KEY_INPUT="$4"
VERIFY_IMAGE="${CLOUDSSH_VERIFY_IMAGE:-cloudssh-termix:2.6.0-cloudssh.32}"
STARTUP_TIMEOUT="${CLOUDSSH_RESTORE_STARTUP_TIMEOUT_SECONDS:-120}"
HELPER_IMAGE="alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SAFE_ARCHIVE_SCRIPT="${SCRIPT_DIR}/cloudssh-safe-archive.py"
STATE_VALIDATOR_SCRIPT="${SCRIPT_DIR}/cloudssh-verify-restored-state.mjs"
VERIFY_CONTAINER=""
RESTORE_RUN_ID="$(date -u +%Y%m%d%H%M%S)-$$"
RESTORE_DATA_VOLUME_CREATED=0
RESTORE_RECORDINGS_VOLUME_CREATED=0

cleanup() {
  status=$?
  trap - 0 1 2 15
  if [ -n "$VERIFY_CONTAINER" ]; then
    docker rm -f "$VERIFY_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [ "$status" -ne 0 ] && \
    { [ "$RESTORE_DATA_VOLUME_CREATED" -eq 1 ] || \
      [ "$RESTORE_RECORDINGS_VOLUME_CREATED" -eq 1 ]; }; then
    echo "本次创建的隔离数据卷和录像卷已保留，便于排查；脚本不会将它们接入生产服务。" >&2
  fi
  exit "$status"
}
trap cleanup 0
trap 'exit 129' 1
trap 'exit 130' 2
trap 'exit 143' 15

case "$STARTUP_TIMEOUT" in
  '' | *[!0-9]*) fail "启动校验超时必须是整数秒。" ;;
esac
[ "$STARTUP_TIMEOUT" -ge 30 ] || fail "启动校验超时不能少于 30 秒。"

validate_volume_name() {
  case "$1" in
    '' | [!a-zA-Z0-9]* | *[!a-zA-Z0-9_.-]*)
      fail "隔离卷名只能以字母或数字开头，并且只能包含字母、数字、点、下划线和连字符：${1:-空名称}"
      ;;
  esac
}
validate_volume_name "$TARGET_DATA_VOLUME"
validate_volume_name "$TARGET_RECORDINGS_VOLUME"
[ "$TARGET_DATA_VOLUME" != "$TARGET_RECORDINGS_VOLUME" ] ||
  fail "数据卷与录像卷必须使用不同名称。"

[ -f "$ARCHIVE_INPUT" ] || fail "备份文件不存在：${ARCHIVE_INPUT}"
[ -s "$MASTER_KEY_INPUT" ] || fail "CloudSSH 根密钥文件不存在或为空：${MASTER_KEY_INPUT}"
[ -s "$SAFE_ARCHIVE_SCRIPT" ] || fail "缺少安全归档解包器：${SAFE_ARCHIVE_SCRIPT}"
[ -s "$STATE_VALIDATOR_SCRIPT" ] || fail "缺少恢复状态校验器：${STATE_VALIDATOR_SCRIPT}"

if ! ARCHIVE_DIR="$(cd "$(dirname "$ARCHIVE_INPUT")" && pwd)"; then
  fail "无法解析备份目录：$(dirname "$ARCHIVE_INPUT")"
fi
ARCHIVE="${ARCHIVE_DIR}/$(basename "$ARCHIVE_INPUT")"
if ! MASTER_KEY_DIR="$(cd "$(dirname "$MASTER_KEY_INPUT")" && pwd)"; then
  fail "无法解析根密钥目录：$(dirname "$MASTER_KEY_INPUT")"
fi
MASTER_KEY="${MASTER_KEY_DIR}/$(basename "$MASTER_KEY_INPUT")"
case "$ARCHIVE_DIR,$MASTER_KEY,$SAFE_ARCHIVE_SCRIPT,$STATE_VALIDATOR_SCRIPT" in
  *,*,*,*,*) fail "备份目录、根密钥和脚本路径不能包含逗号，Docker --mount 无法安全解析。" ;;
esac
ARCHIVE_NAME="$(basename "$ARCHIVE")"
MANIFEST="${ARCHIVE}.manifest"
MANIFEST_NAME="$(basename "$MANIFEST")"
CHECKSUM_FILE="${ARCHIVE}.sha256"

[ -s "$MANIFEST" ] || fail "缺少必需备份清单：${MANIFEST}"
[ -s "$CHECKSUM_FILE" ] || fail "缺少必需 SHA-256 校验文件：${CHECKSUM_FILE}"

if command -v sha256sum >/dev/null 2>&1; then
  checksum_tool="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  checksum_tool="shasum"
else
  fail "宿主机缺少 sha256sum 或 shasum，不能验证备份。"
fi

calculate_checksum() {
  if [ "$checksum_tool" = "sha256sum" ]; then
    sha256sum "$1"
  else
    shasum -a 256 "$1"
  fi
}

expected_archive_hash=""
expected_manifest_hash=""
checksum_entries=0
while IFS= read -r checksum_line || [ -n "$checksum_line" ]; do
  checksum_hash="${checksum_line%% *}"
  checksum_name="${checksum_line#"$checksum_hash"}"
  while [ "${checksum_name# }" != "$checksum_name" ]; do
    checksum_name="${checksum_name# }"
  done
  [ "${#checksum_hash}" -eq 64 ] || fail "SHA-256 文件包含无效摘要。"
  case "$checksum_hash" in
    *[!0-9a-fA-F]*) fail "SHA-256 文件包含无效摘要。" ;;
  esac
  case "$checksum_name" in
    "$ARCHIVE_NAME")
      [ -z "$expected_archive_hash" ] || fail "SHA-256 文件重复列出备份归档。"
      expected_archive_hash="$checksum_hash"
      ;;
    "$MANIFEST_NAME")
      [ -z "$expected_manifest_hash" ] || fail "SHA-256 文件重复列出备份清单。"
      expected_manifest_hash="$checksum_hash"
      ;;
    *) fail "SHA-256 文件包含未授权路径：${checksum_name:-空路径}" ;;
  esac
  checksum_entries=$((checksum_entries + 1))
done < "$CHECKSUM_FILE"

[ "$checksum_entries" -eq 2 ] || fail "SHA-256 文件必须且只能包含归档和清单两项。"
[ -n "$expected_archive_hash" ] || fail "SHA-256 文件未包含备份归档。"
[ -n "$expected_manifest_hash" ] || fail "SHA-256 文件未包含备份清单。"

if ! archive_hash_output="$(calculate_checksum "$ARCHIVE")"; then
  fail "计算备份归档 SHA-256 失败。"
fi
actual_archive_hash="${archive_hash_output%% *}"
if ! manifest_hash_output="$(calculate_checksum "$MANIFEST")"; then
  fail "计算备份清单 SHA-256 失败。"
fi
actual_manifest_hash="${manifest_hash_output%% *}"
[ "$actual_archive_hash" = "$expected_archive_hash" ] || fail "备份归档 SHA-256 不匹配。"
[ "$actual_manifest_hash" = "$expected_manifest_hash" ] || fail "备份清单 SHA-256 不匹配。"

seen_env=0
seen_database=0
seen_runtime=0
seen_security=0
seen_recordings=0
manifest_entries=0
while IFS= read -r manifest_entry || [ -n "$manifest_entry" ]; do
  case "$manifest_entry" in
    data/.env)
      [ "$seen_env" -eq 0 ] || fail "备份清单重复列出 .env。"
      seen_env=1
      ;;
    data/db.sqlite.encrypted)
      [ "$seen_database" -eq 0 ] || fail "备份清单重复列出 db.sqlite.encrypted。"
      seen_database=1
      ;;
    data/agent/runtime-state.json)
      [ "$seen_runtime" -eq 0 ] || fail "备份清单重复列出 agent/runtime-state.json。"
      seen_runtime=1
      ;;
    data/agent/agent-security.sqlite)
      [ "$seen_security" -eq 0 ] || fail "备份清单重复列出 agent/agent-security.sqlite。"
      seen_security=1
      ;;
    recordings/)
      [ "$seen_recordings" -eq 0 ] || fail "备份清单重复列出录像卷。"
      seen_recordings=1
      ;;
    *) fail "备份清单包含未知或空条目：${manifest_entry:-空条目}" ;;
  esac
  manifest_entries=$((manifest_entries + 1))
done < "$MANIFEST"
[ "$manifest_entries" -eq 5 ] || fail "备份清单必须且只能包含四个必需状态文件和录像卷。"
[ "$seen_env$seen_database$seen_runtime$seen_security$seen_recordings" = "11111" ] ||
  fail "备份清单缺少必需状态文件。"

if ! volume_names="$(docker volume ls --format '{{.Name}}')"; then
  fail "无法查询 Docker 卷，未执行恢复。"
fi
old_ifs=$IFS
IFS='
'
for volume_name in $volume_names; do
  [ "$volume_name" != "$TARGET_DATA_VOLUME" ] || fail "目标卷已存在，拒绝覆盖：${TARGET_DATA_VOLUME}"
  [ "$volume_name" != "$TARGET_RECORDINGS_VOLUME" ] || fail "目标卷已存在，拒绝覆盖：${TARGET_RECORDINGS_VOLUME}"
done
IFS=$old_ifs

if ! docker image inspect "$VERIFY_IMAGE" >/dev/null 2>&1; then
  fail "验证镜像 ${VERIFY_IMAGE} 不可用。请先构建该镜像，或设置 CLOUDSSH_VERIFY_IMAGE。"
fi

create_restore_volume() {
  volume_name="$1"
  volume_role="$2"
  docker volume create \
    --label "cloudssh.restore-verification=${RESTORE_RUN_ID}" \
    --label "cloudssh.restore-role=${volume_role}" \
    "$volume_name" >/dev/null || fail "无法创建隔离卷：${volume_name}"
  if ! restore_volume_identity="$(
    docker volume inspect --format '{{index .Labels "cloudssh.restore-verification"}} {{index .Labels "cloudssh.restore-role"}}' \
      "$volume_name"
  )"; then
    fail "无法确认隔离卷的创建身份：${volume_name}"
  fi
  [ "$restore_volume_identity" = "${RESTORE_RUN_ID} ${volume_role}" ] ||
    fail "隔离卷不是本次验证新建的 ${volume_role} 卷，拒绝写入：${volume_name}"
}

create_restore_volume "$TARGET_DATA_VOLUME" data
RESTORE_DATA_VOLUME_CREATED=1
create_restore_volume "$TARGET_RECORDINGS_VOLUME" recordings
RESTORE_RECORDINGS_VOLUME_CREATED=1

if ! docker run --rm --network none --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=256m \
  --entrypoint python3 \
  --mount "type=volume,src=${TARGET_DATA_VOLUME},dst=/restore-data" \
  --mount "type=volume,src=${TARGET_RECORDINGS_VOLUME},dst=/restore-recordings" \
  --mount "type=bind,src=${ARCHIVE_DIR},dst=/backup,readonly" \
  --mount "type=bind,src=${SAFE_ARCHIVE_SCRIPT},dst=/cloudssh-safe-archive.py,readonly" \
  -e PYTHONDONTWRITEBYTECODE=1 \
  "$VERIFY_IMAGE" /cloudssh-safe-archive.py extract \
    "/backup/${ARCHIVE_NAME}" /restore-data /restore-recordings
then
  fail "Python tarfile 归档审计或安全解压失败。"
fi

docker run --rm --network none \
  --mount "type=volume,src=${TARGET_DATA_VOLUME},dst=/restore,readonly" \
  --mount "type=volume,src=${TARGET_RECORDINGS_VOLUME},dst=/recordings,readonly" \
  "$HELPER_IMAGE" \
  sh -ec '
    for required in .env db.sqlite.encrypted agent/runtime-state.json agent/agent-security.sqlite; do
      test -s "/restore/${required}" || {
        echo "恢复卷缺少必需文件：${required}" >&2
        exit 2
      }
    done
    test -s /restore/.cloudssh-clean-shutdown || {
      echo "恢复卷缺少正常关机完成标记" >&2
      exit 2
    }
    test -d /recordings || {
      echo "恢复后的录像卷不可用" >&2
      exit 2
    }
  ' || fail "恢复卷文件检查失败。"

if ! docker run --rm --network none --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=2g \
  --entrypoint node \
  --mount "type=volume,src=${TARGET_DATA_VOLUME},dst=/restore,readonly" \
  --mount "type=volume,src=${TARGET_RECORDINGS_VOLUME},dst=/recordings,readonly" \
  --mount "type=bind,src=${MASTER_KEY},dst=/run/secrets/cloudssh_master_key,readonly" \
  --mount "type=bind,src=${STATE_VALIDATOR_SCRIPT},dst=/cloudssh-verify-restored-state.mjs,readonly" \
  -e DATA_DIR=/restore \
  -e CLOUDSSH_RESTORE_RECORDINGS_DIR=/recordings \
  -e CLOUDSSH_MASTER_KEY_FILE=/run/secrets/cloudssh_master_key \
  "$VERIFY_IMAGE" /cloudssh-verify-restored-state.mjs
then
  fail "JSON、SQLite 完整性、录像引用或凭据解密校验失败。"
fi

validation_container_name="cloudssh-restore-verify-${RESTORE_RUN_ID}"
if ! docker run -d --name "$validation_container_name" \
  --label "cloudssh.restore-verification=${RESTORE_RUN_ID}" \
  --network none --restart no \
  --mount "type=volume,src=${TARGET_DATA_VOLUME},dst=/app/data" \
  --mount "type=volume,src=${TARGET_RECORDINGS_VOLUME},dst=/app/data/session_recordings/guacamole" \
  --mount "type=bind,src=${MASTER_KEY},dst=/run/secrets/cloudssh_master_key,readonly" \
  -e DATA_DIR=/app/data \
  -e NODE_ENV=production \
  -e ALLOW_REGISTRATION=false \
  -e ENABLE_GUACAMOLE=false \
  -e AGENT_API_HOST=127.0.0.1 \
  -e CLOUDSSH_MASTER_KEY_FILE=/run/secrets/cloudssh_master_key \
  "$VERIFY_IMAGE" >/dev/null; then
  if validation_container_labels="$(
    docker inspect --format '{{json .Config.Labels}}' \
      "$validation_container_name" 2>/dev/null
  )"; then
    case "$validation_container_labels" in
      *"\"cloudssh.restore-verification\":\"${RESTORE_RUN_ID}\""*)
        docker rm -f "$validation_container_name" >/dev/null 2>&1 || true
        ;;
    esac
  fi
  fail "无法启动隔离校验容器。"
fi
VERIFY_CONTAINER="$validation_container_name"

deadline=$(( $(date +%s) + STARTUP_TIMEOUT ))
startup_ready=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  if ! running="$(docker inspect --format '{{.State.Running}}' "$VERIFY_CONTAINER")"; then
    fail "无法查询隔离校验容器状态。"
  fi
  if [ "$running" != "true" ]; then
    docker logs "$VERIFY_CONTAINER" >&2 || true
    fail "隔离应用在健康检查前退出。"
  fi
  if docker exec "$VERIFY_CONTAINER" \
    wget -q -O /dev/null http://127.0.0.1:30001/health && \
    docker exec "$VERIFY_CONTAINER" \
      wget -q -O /dev/null http://127.0.0.1:30013/agent/v1/health; then
    if ! startup_logs="$(docker logs "$VERIFY_CONTAINER" 2>&1)"; then
      fail "无法读取隔离应用启动日志。"
    fi
    case "$startup_logs" in
      *"op:backend_init_complete"*)
        startup_ready=1
        break
        ;;
    esac
  fi
  sleep 2
done
[ "$startup_ready" -eq 1 ] || {
  docker logs "$VERIFY_CONTAINER" >&2 || true
  fail "隔离应用在 ${STARTUP_TIMEOUT} 秒内未通过健康检查。"
}

docker stop --timeout 60 "$VERIFY_CONTAINER" >/dev/null ||
  fail "隔离应用无法在 60 秒内优雅停止。"
if ! validation_state="$(
  docker inspect --format '{{.State.Running}} {{.State.ExitCode}}' "$VERIFY_CONTAINER"
)"; then
  fail "无法验证隔离应用的退出状态。"
fi
set -- $validation_state
[ "${1:-}" = "false" ] || fail "隔离应用停止后仍在运行。"
[ "${2:-}" = "0" ] || fail "隔离应用退出码不是 0：${2:-未知}"
docker run --rm --network none \
  --mount "type=volume,src=${TARGET_DATA_VOLUME},dst=/restore,readonly" \
  "$HELPER_IMAGE" \
  test -s /restore/.cloudssh-clean-shutdown ||
  fail "隔离应用没有写入正常关机完成标记。"
docker rm "$VERIFY_CONTAINER" >/dev/null || fail "无法清理隔离校验容器。"
VERIFY_CONTAINER=""

echo "隔离恢复验证通过：数据卷 ${TARGET_DATA_VOLUME}，录像卷 ${TARGET_RECORDINGS_VOLUME}。"
echo "已验证校验和、清单、录像卷、JSON、SQLite 完整性、项目凭据解密及隔离应用启动。"
echo "这两个卷未连接生产网络或端口；上线前仍应由管理员完成登录和测试主机连接。"
