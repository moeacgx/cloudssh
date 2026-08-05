#!/bin/sh
set -eu
umask 077

COMPOSE_FILE="${COMPOSE_FILE:-docker/docker-compose.cloudssh.yml}"
OUTPUT_DIR="${1:-backups}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="cloudssh-state-${TIMESTAMP}.tar.gz"
PARTIAL_ARCHIVE="${ARCHIVE}.partial"
MANIFEST="${ARCHIVE}.manifest"
PARTIAL_MANIFEST="${MANIFEST}.partial"
CHECKSUM_FILE="${ARCHIVE}.sha256"
PARTIAL_CHECKSUM="${CHECKSUM_FILE}.partial"
REQUIRED_ENTRIES="data/.env data/db.sqlite.encrypted data/agent/runtime-state.json data/agent/agent-security.sqlite recordings/"
WRITER_SERVICES="cloudssh guacd"
MINIMUM_STOP_TIMEOUT=60
HELPER_IMAGE="alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce"
BACKUP_UID="$(id -u)"
BACKUP_GID="$(id -g)"
CLOUDSSH_CONTAINER_ID=""
GUACD_CONTAINER_ID=""

fail() {
  echo "备份失败：$*" >&2
  exit 2
}

resolve_volume_mount() {
  service="$1"
  container_id="$2"
  destination="$3"
  if ! mount_rows="$(
    docker inspect --format '{{range .Mounts}}{{printf "%s|%s|%s\n" .Type .Destination .Name}}{{end}}' \
      "$container_id"
  )"; then
    echo "备份失败：无法读取服务 ${service} 的挂载信息。" >&2
    return 2
  fi

  matched_count=0
  matched_type=""
  matched_name=""
  old_ifs=$IFS
  IFS='
'
  for mount_row in $mount_rows; do
    mount_type="${mount_row%%|*}"
    mount_remainder="${mount_row#*|}"
    mount_destination="${mount_remainder%%|*}"
    mount_name="${mount_remainder#*|}"
    if [ "$mount_destination" = "$destination" ]; then
      matched_count=$((matched_count + 1))
      matched_type="$mount_type"
      matched_name="$mount_name"
    fi
  done
  IFS=$old_ifs

  [ "$matched_count" -eq 1 ] || {
    echo "备份失败：服务 ${service} 必须且只能有一个 ${destination} 挂载。" >&2
    return 2
  }
  [ "$matched_type" = "volume" ] || {
    echo "备份失败：服务 ${service} 的 ${destination} 必须使用 Docker 命名卷。" >&2
    return 2
  }
  [ -n "$matched_name" ] || {
    echo "备份失败：服务 ${service} 的 ${destination} 卷名为空。" >&2
    return 2
  }
  printf '%s' "$matched_name"
}

for service in $WRITER_SERVICES; do
  if ! container_id="$(
    docker compose -f "$COMPOSE_FILE" ps -a -q "$service"
  )"; then
    fail "无法查询 Compose 服务 ${service} 的状态，未创建任何备份。"
  fi
  [ -n "$container_id" ] ||
    fail "找不到 Compose 服务 ${service} 的容器，无法验证其停机状态。"

  if ! state="$(
    docker inspect --format '{{.State.Running}} {{.State.ExitCode}} {{.Config.StopTimeout}}' \
      "$container_id"
  )"; then
    fail "无法检查服务 ${service} 的容器状态。"
  fi
  set -- $state
  running="${1:-}"
  exit_code="${2:-}"
  stop_timeout="${3:-}"
  [ "$running" = "false" ] ||
    fail "服务 ${service} 仍在写入共享数据卷。请先执行 docker compose -f ${COMPOSE_FILE} stop --timeout ${MINIMUM_STOP_TIMEOUT} ${WRITER_SERVICES}。"
  [ "$exit_code" = "0" ] ||
    fail "服务 ${service} 上次退出码为 ${exit_code:-未知}，不能证明已优雅停止。"
  case "$stop_timeout" in
    '' | *[!0-9]*)
      fail "服务 ${service} 的优雅停止时限无效：${stop_timeout:-未设置}。"
      ;;
  esac
  [ "$stop_timeout" -ge "$MINIMUM_STOP_TIMEOUT" ] ||
    fail "服务 ${service} 的优雅停止时限只有 ${stop_timeout} 秒，至少需要 ${MINIMUM_STOP_TIMEOUT} 秒。请按当前编排重新创建容器。"

  case "$service" in
    cloudssh) CLOUDSSH_CONTAINER_ID="$container_id" ;;
    guacd) GUACD_CONTAINER_ID="$container_id" ;;
  esac
done

[ -n "$CLOUDSSH_CONTAINER_ID" ] || fail "未找到 CloudSSH 容器。"
[ -n "$GUACD_CONTAINER_ID" ] || fail "未找到 guacd 容器。"

DATA_VOLUME="$(
  resolve_volume_mount cloudssh "$CLOUDSSH_CONTAINER_ID" /app/data
)" || exit $?
CLOUDSSH_RECORDINGS_VOLUME="$(
  resolve_volume_mount cloudssh "$CLOUDSSH_CONTAINER_ID" \
    /app/data/session_recordings/guacamole
)" || exit $?
GUACD_RECORDINGS_VOLUME="$(
  resolve_volume_mount guacd "$GUACD_CONTAINER_ID" \
    /termix-data/session_recordings/guacamole
)" || exit $?

[ "$CLOUDSSH_RECORDINGS_VOLUME" = "$GUACD_RECORDINGS_VOLUME" ] ||
  fail "CloudSSH 与 guacd 挂载的不是同一个录像卷。"
[ "$DATA_VOLUME" != "$CLOUDSSH_RECORDINGS_VOLUME" ] ||
  fail "主数据与录像必须使用两个独立 Docker 卷。"

if [ -n "${CLOUDSSH_DATA_VOLUME:-}" ]; then
  [ "$CLOUDSSH_DATA_VOLUME" = "$DATA_VOLUME" ] ||
    fail "CLOUDSSH_DATA_VOLUME=${CLOUDSSH_DATA_VOLUME} 与容器真实数据卷 ${DATA_VOLUME} 不一致。"
fi
if [ -n "${CLOUDSSH_RECORDINGS_VOLUME:-}" ]; then
  [ "$CLOUDSSH_RECORDINGS_VOLUME" = "$GUACD_RECORDINGS_VOLUME" ] ||
    fail "CLOUDSSH_RECORDINGS_VOLUME=${CLOUDSSH_RECORDINGS_VOLUME} 与容器真实录像卷 ${GUACD_RECORDINGS_VOLUME} 不一致。"
fi

if command -v sha256sum >/dev/null 2>&1; then
  CHECKSUM_COMMAND="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  CHECKSUM_COMMAND="shasum -a 256"
else
  fail "宿主机缺少 sha256sum 或 shasum，不能创建可验证备份。"
fi

mkdir -p "$OUTPUT_DIR"
for output_name in \
  "$ARCHIVE" "$PARTIAL_ARCHIVE" \
  "$MANIFEST" "$PARTIAL_MANIFEST" \
  "$CHECKSUM_FILE" "$PARTIAL_CHECKSUM"; do
  [ ! -e "$OUTPUT_DIR/$output_name" ] ||
    fail "输出文件已存在，拒绝覆盖：$OUTPUT_DIR/$output_name"
done

docker run --rm --network none \
  -e "BACKUP_UID=${BACKUP_UID}" \
  -e "BACKUP_GID=${BACKUP_GID}" \
  -e "BACKUP_ARCHIVE=${PARTIAL_ARCHIVE}" \
  -e "LEGACY_DATA_VOLUME=${DATA_VOLUME}" \
  --mount "type=volume,src=${DATA_VOLUME},dst=/source/data,readonly" \
  --mount "type=volume,src=${GUACD_RECORDINGS_VOLUME},dst=/source/recordings,readonly" \
  --mount "type=bind,src=$(cd "$OUTPUT_DIR" && pwd),dst=/backup" \
  "$HELPER_IMAGE" \
  sh -ec '
    umask 077
    entries_file=/tmp/cloudssh-recording-entries
    digest_input=/tmp/cloudssh-recording-digest

    build_tree_digest() {
      tree_root="$1"
      [ ! -L "$tree_root" ] && [ -d "$tree_root" ] || {
        echo "录像根路径不是普通目录：${tree_root}" >&2
        return 2
      }
      : > "$entries_file"
      : > "$digest_input"
      find "$tree_root" -mindepth 1 -print0 | sort -z > "$entries_file"
      while IFS= read -r -d "" entry; do
        relative="${entry#${tree_root}/}"
        case "$relative" in
          "" | /* | .. | ../* | */../* | */..)
            echo "录像包含不安全路径：${relative:-空路径}" >&2
            return 2
            ;;
        esac
        if [ -L "$entry" ]; then
          echo "录像包含不允许的符号链接：${relative}" >&2
          return 2
        elif [ -d "$entry" ]; then
          printf "directory\000%s\000" "$relative" >> "$digest_input"
        elif [ -f "$entry" ]; then
          link_count="$(stat -c %h "$entry")" || return 2
          [ "$link_count" = "1" ] || {
            echo "录像包含不允许的硬链接：${relative}" >&2
            return 2
          }
          file_size="$(stat -c %s "$entry")" || return 2
          file_hash_output="$(sha256sum "$entry")" || return 2
          file_hash="${file_hash_output%% *}"
          printf "file\000%s\000%s\000%s\000" \
            "$relative" "$file_size" "$file_hash" >> "$digest_input"
        else
          echo "录像包含不允许的特殊文件：${relative}" >&2
          return 2
        fi
      done < "$entries_file"
      tree_hash_output="$(sha256sum "$digest_input")" || return 2
      printf "%s" "${tree_hash_output%% *}"
    }

    verify_legacy_copy() {
      while IFS= read -r -d "" entry; do
        relative="${entry#${legacy_recordings}/}"
        destination="/source/recordings/${relative}"
        if [ -d "$entry" ]; then
          [ ! -L "$destination" ] && [ -d "$destination" ] || {
            echo "录像卷缺少已迁移目录：${relative}" >&2
            return 2
          }
        else
          [ ! -L "$destination" ] && [ -f "$destination" ] || {
            echo "录像卷缺少已迁移普通文件：${relative}" >&2
            return 2
          }
          source_size="$(stat -c %s "$entry")" || return 2
          destination_size="$(stat -c %s "$destination")" || return 2
          [ "$source_size" = "$destination_size" ] || {
            echo "录像卷中的已迁移文件大小不一致：${relative}" >&2
            return 2
          }
          source_hash_output="$(sha256sum "$entry")" || return 2
          source_hash="${source_hash_output%% *}"
          destination_hash_output="$(sha256sum "$destination")" || return 2
          destination_hash="${destination_hash_output%% *}"
          [ "$source_hash" = "$destination_hash" ] || {
            echo "录像卷中的已迁移文件 SHA-256 不一致：${relative}" >&2
            return 2
          }
        fi
      done < "$entries_file"
    }

    for required in .env db.sqlite.encrypted agent/runtime-state.json agent/agent-security.sqlite; do
      test -s "/source/data/${required}" || {
        echo "缺少必需备份文件：${required}" >&2
        exit 2
      }
    done
    test -d /source/recordings || {
      echo "录像卷挂载不可用" >&2
      exit 2
    }
    build_tree_digest /source/recordings >/dev/null || {
      echo "专用录像卷包含不安全或不可读取的内容，拒绝备份。" >&2
      exit 2
    }
    legacy_recordings=/source/data/session_recordings/guacamole
    if [ -d "$legacy_recordings" ] && \
      find "$legacy_recordings" -mindepth 1 -print -quit | grep -q .; then
      migration_marker=/source/recordings/.cloudssh-legacy-source
      legacy_digest="$(build_tree_digest "$legacy_recordings")" || {
        echo "无法生成旧录像内容摘要，拒绝备份。" >&2
        exit 2
      }
      marker_lines="$(wc -l < "$migration_marker" 2>/dev/null | tr -d " " || true)"
      marker_version="$(sed -n "1s/^version=//p" "$migration_marker" 2>/dev/null || true)"
      marker_volume="$(sed -n "2s/^source_volume=//p" "$migration_marker" 2>/dev/null || true)"
      marker_digest="$(sed -n "3s/^source_digest=//p" "$migration_marker" 2>/dev/null || true)"
      [ "$marker_lines" = "3" ] && \
        [ "$marker_version" = "1" ] && \
        [ "$marker_volume" = "$LEGACY_DATA_VOLUME" ] && \
        [ "$marker_digest" = "$legacy_digest" ] || {
          echo "检测到旧数据卷录像，但专用录像卷没有匹配卷名和内容摘要的迁移校验标记。请重新运行 cloudssh-migrate-recordings.sh。" >&2
          exit 2
        }
      verify_legacy_copy || {
        echo "旧录像与专用录像卷的逐文件复核失败，拒绝备份。" >&2
        exit 2
      }
    fi
    test -s /source/data/.cloudssh-clean-shutdown || {
      echo "缺少正常关机完成标记，拒绝备份可能不一致的数据卷。" >&2
      exit 2
    }
    grep -Eq "^\{\"completedAt\":\"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z\"\}$" \
      /source/data/.cloudssh-clean-shutdown || {
      echo "正常关机完成标记格式无效，拒绝备份。" >&2
      exit 2
    }
    # 运行包来自固定 Release，可重新下载；不把它重复塞进业务数据备份。
    tar -C /source --exclude=data/self-update -czf "/backup/${BACKUP_ARCHIVE}" data recordings
    chown "${BACKUP_UID}:${BACKUP_GID}" "/backup/${BACKUP_ARCHIVE}"
    chmod 600 "/backup/${BACKUP_ARCHIVE}"
  '

for required_entry in $REQUIRED_ENTRIES; do
  printf '%s\n' "$required_entry"
done > "$OUTPUT_DIR/$PARTIAL_MANIFEST"

checksum_value() {
  if [ "$CHECKSUM_COMMAND" = "sha256sum" ]; then
    sha256sum "$1"
  else
    shasum -a 256 "$1"
  fi
}

archive_hash_output="$(checksum_value "$OUTPUT_DIR/$PARTIAL_ARCHIVE")"
archive_hash="${archive_hash_output%% *}"
manifest_hash_output="$(checksum_value "$OUTPUT_DIR/$PARTIAL_MANIFEST")"
manifest_hash="${manifest_hash_output%% *}"
{
  printf '%s  %s\n' "$archive_hash" "$ARCHIVE"
  printf '%s  %s\n' "$manifest_hash" "$MANIFEST"
} > "$OUTPUT_DIR/$PARTIAL_CHECKSUM"
chmod 600 \
  "$OUTPUT_DIR/$PARTIAL_MANIFEST" \
  "$OUTPUT_DIR/$PARTIAL_CHECKSUM"

# 先发布校验材料，归档名最后原子出现；消费者不会看到半套可用备份。
mv "$OUTPUT_DIR/$PARTIAL_MANIFEST" "$OUTPUT_DIR/$MANIFEST"
mv "$OUTPUT_DIR/$PARTIAL_CHECKSUM" "$OUTPUT_DIR/$CHECKSUM_FILE"
mv "$OUTPUT_DIR/$PARTIAL_ARCHIVE" "$OUTPUT_DIR/$ARCHIVE"

echo "备份已创建：$OUTPUT_DIR/$ARCHIVE"
echo "备份清单：$OUTPUT_DIR/$MANIFEST"
echo "已核对真实挂载：数据卷 ${DATA_VOLUME}，录像卷 ${GUACD_RECORDINGS_VOLUME}。"
echo "根密钥 Secret 未包含在备份中，必须单独离线保管。"
