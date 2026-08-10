#!/bin/sh
set -eu
umask 077

# Fast, host-side CloudSSH production updater. It deliberately runs outside the
# application container, so the panel never receives Docker daemon access.
REPOSITORY="moeacgx/cloudssh"
INSTALL_DIR="${CLOUDSSH_INSTALL_DIR:-/opt/cloudssh}"
COMPOSE_FILE="${COMPOSE_FILE:-docker/docker-compose.cloudssh.yml}"
ENV_FILE="${CLOUDSSH_ENV_FILE:-docker/.env}"
BACKUP_DIR="${CLOUDSSH_BACKUP_DIR:-backups}"
HEALTH_TIMEOUT_SECONDS="${CLOUDSSH_HEALTH_TIMEOUT_SECONDS:-120}"
VERSION="${CLOUDSSH_VERSION:-}"

fail() {
  echo "CloudSSH 镜像更新失败：$*" >&2
  exit 2
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "宿主机缺少必需命令：$1"
}

sha256_check() {
  checksum_file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c "$checksum_file"
  else
    shasum -a 256 -c "$checksum_file"
  fi
}

download() {
  curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --retry-delay 2 \
    --connect-timeout 15 --output "$2" "$1"
}

validate_version() {
  value="$1"
  valid="$(printf '%s\n' "$value" | sed -n 's/^[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*-cloudssh\.[0-9][0-9]*$/ok/p')"
  [ "$valid" = ok ]
}

latest_release_version() {
  latest_json="$TEMP_DIR/latest-release.json"
  download "https://api.github.com/repos/$REPOSITORY/releases/latest" "$latest_json"
  draft="$(sed -n 's/^[[:space:]]*"draft":[[:space:]]*\([^,]*\).*/\1/p' "$latest_json" | sed -n '1p')"
  prerelease="$(sed -n 's/^[[:space:]]*"prerelease":[[:space:]]*\([^,]*\).*/\1/p' "$latest_json" | sed -n '1p')"
  [ "$draft" = false ] && [ "$prerelease" = false ] ||
    fail "latest Release 不是正式稳定版本"
  latest_version="$(sed -n 's/^[[:space:]]*"tag_name":[[:space:]]*"release-\([^"]*\)-tag".*/\1/p' "$latest_json" | sed -n '1p')"
  validate_version "$latest_version" || fail "latest Release 标签格式无效"
  printf '%s' "$latest_version"
}

manifest_field() {
  field="$1"
  manifest="$2"
  sed -n "s/^[[:space:]]*\"$field\":[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$manifest" | sed -n '1p'
}

validate_release_manifest() {
  manifest="$1"
  expected_version="$2"
  schema_version="$(sed -n 's/^[[:space:]]*"schemaVersion":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$manifest" | sed -n '1p')"
  [ "$schema_version" = 3 ] || fail "Release 清单 schemaVersion 无效"
  [ "$(manifest_field channel "$manifest")" = stable ] || fail "Release 清单渠道不受信任"
  [ "$(manifest_field version "$manifest")" = "$expected_version" ] || fail "Release 清单版本不匹配"
  [ "$(manifest_field image "$manifest")" = ghcr.io/moeacgx/cloudssh ] || fail "Release 清单镜像仓库不受信任"
  digest="$(manifest_field digest "$manifest")"
  digest_suffix="${digest#sha256:}"
  [ "$digest" != "$digest_suffix" ] || fail "Release 清单镜像摘要无效"
  [ "${#digest_suffix}" -eq 64 ] || fail "Release 清单镜像摘要长度无效"
  case "$digest_suffix" in *[!0-9a-f]*) fail "Release 清单镜像摘要无效" ;; esac
  revision="$(manifest_field revision "$manifest")"
  [ "${#revision}" -ge 40 ] && [ "${#revision}" -le 64 ] || fail "Release 清单源码提交长度无效"
  case "$revision" in *[!0-9a-f]*) fail "Release 清单源码提交无效" ;; esac
  [ "$(manifest_field deploymentContract "$manifest")" = cloudssh-self-update-v1 ] ||
    fail "Release 清单部署契约不兼容"
}

architecture() {
  case "$(uname -m)" in
    x86_64 | amd64) printf '%s' amd64 ;;
    aarch64 | arm64) printf '%s' arm64 ;;
    *) fail "不支持的宿主机架构：$(uname -m)" ;;
  esac
}

health_url() {
  published_port="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" port cloudssh 8080 2>/dev/null | sed -n '1p' || true)"
  port="${published_port##*:}"
  case "$port" in
    '' | *[!0-9]*)
      port="${CLOUDSSH_HTTP_PORT:-8080}"
      ;;
  esac
  printf 'http://127.0.0.1:%s/health' "$port"
}

wait_for_health() {
  url="$1"
  elapsed=0
  while [ "$elapsed" -lt "$HEALTH_TIMEOUT_SECONDS" ]; do
    if curl --fail --silent --show-error --max-time 5 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  return 1
}

restore_previous_image() {
  echo "新镜像未通过健康检查，正在恢复 $PREVIOUS_IMAGE。" >&2
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d guacd >&2
  CLOUDSSH_IMAGE="$PREVIOUS_IMAGE" \
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" \
    up -d --no-deps --force-recreate cloudssh >&2
  wait_for_health "$HEALTH_URL" || {
    echo "回滚后的 CloudSSH 也未通过健康检查；请立即使用备份和 Docker 状态排障。" >&2
    return 1
  }
  echo "已恢复 $PREVIOUS_IMAGE。" >&2
}

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$status" -ne 0 ] && [ "$ROLLBACK_REQUIRED" = "1" ]; then
    if ! restore_previous_image; then
      status=3
    fi
  fi
  rm -rf "$TEMP_DIR"
  exit "$status"
}

if [ "$#" -gt 1 ]; then
  fail "用法：$0 [2.6.0-cloudssh.N]"
fi
if [ "$#" -eq 1 ]; then
  VERSION="$1"
fi

require_command curl
require_command docker
require_command gzip
if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
  fail "宿主机缺少 sha256sum 或 shasum"
fi

[ -d "$INSTALL_DIR" ] || fail "安装目录不存在：$INSTALL_DIR"
cd "$INSTALL_DIR"
[ -f "$COMPOSE_FILE" ] || fail "Compose 文件不存在：$COMPOSE_FILE"
[ -f "$ENV_FILE" ] || fail "环境文件不存在：$ENV_FILE"
[ -x scripts/cloudssh-backup.sh ] || fail "缺少可执行备份脚本：scripts/cloudssh-backup.sh"

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cloudssh-image-update.XXXXXX")"
ROLLBACK_REQUIRED=0
PREVIOUS_IMAGE=""
HEALTH_URL=""
trap cleanup EXIT HUP INT TERM

if [ -z "$VERSION" ]; then
  VERSION="$(latest_release_version)" || fail "无法确定最新正式 Release 版本"
fi
validate_version "$VERSION" || fail "版本格式无效：$VERSION"

ARCH="$(architecture)"
TAG="release-$VERSION-tag"
ASSET_BASE="https://github.com/$REPOSITORY/releases/download/$TAG"
RELEASE_MANIFEST="cloudssh-release.json"
ARCHIVE="cloudssh-image-$VERSION-linux-$ARCH.tar.gz"
TARGET_IMAGE="cloudssh-termix:$VERSION"

echo "下载并校验 CloudSSH $VERSION ($ARCH) 离线镜像包。"
download "$ASSET_BASE/$RELEASE_MANIFEST" "$TEMP_DIR/$RELEASE_MANIFEST"
download "$ASSET_BASE/$RELEASE_MANIFEST.sha256" "$TEMP_DIR/$RELEASE_MANIFEST.sha256"
(
  cd "$TEMP_DIR"
  sha256_check "$RELEASE_MANIFEST.sha256"
)
validate_release_manifest "$TEMP_DIR/$RELEASE_MANIFEST" "$VERSION" || fail "Release 清单校验失败"

download "$ASSET_BASE/$ARCHIVE" "$TEMP_DIR/$ARCHIVE"
download "$ASSET_BASE/$ARCHIVE.id" "$TEMP_DIR/$ARCHIVE.id"
download "$ASSET_BASE/$ARCHIVE.sha256" "$TEMP_DIR/$ARCHIVE.sha256"
(
  cd "$TEMP_DIR"
  sha256_check "$ARCHIVE.sha256"
)

gzip -dc "$TEMP_DIR/$ARCHIVE" | docker load >/dev/null
[ "$(docker image inspect "$TARGET_IMAGE" --format '{{.Id}}')" = "$(cat "$TEMP_DIR/$ARCHIVE.id")" ] ||
  fail "离线镜像 ID 与 Release 附件不一致"
[ "$(docker image inspect "$TARGET_IMAGE" --format '{{.Architecture}}')" = "$ARCH" ] ||
  fail "离线镜像架构与宿主机不一致"
[ "$(docker image inspect "$TARGET_IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.version"}}')" = "$VERSION" ] ||
  fail "离线镜像版本标签不匹配"

CONTAINER_ID="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q cloudssh)"
[ -n "$CONTAINER_ID" ] || fail "找不到正在部署的 cloudssh 容器"
PREVIOUS_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$CONTAINER_ID")"
[ -n "$PREVIOUS_IMAGE" ] || fail "无法识别当前 CloudSSH 镜像"
docker image inspect "$PREVIOUS_IMAGE" >/dev/null || fail "当前 CloudSSH 镜像不在本机，拒绝执行无法回滚的更新"
HEALTH_URL="$(health_url)"

echo "停止写入服务，创建升级前备份。"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" \
  stop --timeout 60 cloudssh guacd
if ! sh scripts/cloudssh-backup.sh "$BACKUP_DIR"; then
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" start guacd cloudssh || true
  fail "升级前备份失败，原容器已尝试重新启动"
fi

echo "切换到 $TARGET_IMAGE 并重启 CloudSSH。"
ROLLBACK_REQUIRED=1
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d guacd
CLOUDSSH_IMAGE="$TARGET_IMAGE" \
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" \
  up -d --no-deps --force-recreate cloudssh

if ! wait_for_health "$HEALTH_URL"; then
  fail "新容器在 ${HEALTH_TIMEOUT_SECONDS} 秒内未通过健康检查"
fi
ROLLBACK_REQUIRED=0

echo "CloudSSH 已更新至 $VERSION；健康检查已通过：$HEALTH_URL"
