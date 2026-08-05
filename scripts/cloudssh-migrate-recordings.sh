#!/bin/sh
set -eu
set -f

if [ "$#" -gt 2 ]; then
  echo "用法：$0 [旧数据卷名] [新录像卷名]" >&2
  exit 2
fi

DATA_VOLUME="${1:-cloudssh-data}"
RECORDINGS_VOLUME="${2:-cloudssh-recordings}"
HELPER_IMAGE="alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce"

fail() {
  echo "录像迁移失败：$*" >&2
  exit 2
}

validate_volume_name() {
  case "$1" in
    '' | [!a-zA-Z0-9]* | *[!a-zA-Z0-9_.-]*)
      fail "Docker 卷名无效：${1:-空名称}"
      ;;
  esac
}

validate_volume_name "$DATA_VOLUME"
validate_volume_name "$RECORDINGS_VOLUME"
[ "$DATA_VOLUME" != "$RECORDINGS_VOLUME" ] ||
  fail "旧数据卷和新录像卷不能是同一个卷。"

if ! volume_names="$(docker volume ls --format '{{.Name}}')"; then
  fail "无法查询 Docker 卷。"
fi

data_volume_exists=0
recordings_volume_exists=0
old_ifs=$IFS
IFS='
'
for volume_name in $volume_names; do
  [ "$volume_name" != "$DATA_VOLUME" ] || data_volume_exists=1
  [ "$volume_name" != "$RECORDINGS_VOLUME" ] || recordings_volume_exists=1
done
IFS=$old_ifs
[ "$data_volume_exists" -eq 1 ] || fail "旧数据卷不存在：${DATA_VOLUME}"

for volume_name in "$DATA_VOLUME" "$RECORDINGS_VOLUME"; do
  if ! running_containers="$(docker ps -q --filter "volume=${volume_name}")"; then
    fail "无法检查使用卷 ${volume_name} 的运行中容器。"
  fi
  [ -z "$running_containers" ] ||
    fail "卷 ${volume_name} 仍被运行中容器使用，请先停止 CloudSSH 和 guacd。"
done

if [ "$recordings_volume_exists" -eq 0 ]; then
  docker volume create "$RECORDINGS_VOLUME" >/dev/null ||
    fail "无法创建录像卷：${RECORDINGS_VOLUME}"
fi

docker run --rm --network none \
  -e "LEGACY_DATA_VOLUME=${DATA_VOLUME}" \
  --mount "type=volume,src=${DATA_VOLUME},dst=/legacy,readonly" \
  --mount "type=volume,src=${RECORDINGS_VOLUME},dst=/recordings" \
  "$HELPER_IMAGE" \
  sh -ec '
    source_directory=/legacy/session_recordings/guacamole
    migration_marker=/recordings/.cloudssh-legacy-source
    entries_file=/tmp/cloudssh-legacy-recording-entries
    digest_input=/tmp/cloudssh-legacy-recording-digest

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
            echo "旧录像包含不安全路径：${relative:-空路径}" >&2
            return 2
            ;;
        esac
        if [ -L "$entry" ]; then
          echo "旧录像包含不允许的符号链接：${relative}" >&2
          return 2
        elif [ -d "$entry" ]; then
          printf "directory\000%s\000" "$relative" >> "$digest_input"
        elif [ -f "$entry" ]; then
          link_count="$(stat -c %h "$entry")" || return 2
          [ "$link_count" = "1" ] || {
            echo "旧录像包含不允许的硬链接：${relative}" >&2
            return 2
          }
          file_size="$(stat -c %s "$entry")" || return 2
          file_hash_output="$(sha256sum "$entry")" || return 2
          file_hash="${file_hash_output%% *}"
          printf "file\000%s\000%s\000%s\000" \
            "$relative" "$file_size" "$file_hash" >> "$digest_input"
        else
          echo "旧录像包含不允许的特殊文件：${relative}" >&2
          return 2
        fi
      done < "$entries_file"
      tree_hash_output="$(sha256sum "$digest_input")" || return 2
      printf "%s" "${tree_hash_output%% *}"
    }

    verify_source_copy() {
      while IFS= read -r -d "" entry; do
        relative="${entry#${source_directory}/}"
        destination="/recordings/${relative}"
        if [ -d "$entry" ]; then
          [ ! -L "$destination" ] && [ -d "$destination" ] || {
            echo "录像卷缺少迁移目录：${relative}" >&2
            return 2
          }
        else
          [ ! -L "$destination" ] && [ -f "$destination" ] || {
            echo "录像卷缺少迁移普通文件：${relative}" >&2
            return 2
          }
          source_size="$(stat -c %s "$entry")" || return 2
          destination_size="$(stat -c %s "$destination")" || return 2
          [ "$source_size" = "$destination_size" ] || {
            echo "录像卷中的迁移文件大小不一致：${relative}" >&2
            return 2
          }
          source_hash_output="$(sha256sum "$entry")" || return 2
          source_hash="${source_hash_output%% *}"
          destination_hash_output="$(sha256sum "$destination")" || return 2
          destination_hash="${destination_hash_output%% *}"
          [ "$source_hash" = "$destination_hash" ] || {
            echo "录像卷中的迁移文件 SHA-256 不一致：${relative}" >&2
            return 2
          }
        fi
      done < "$entries_file"
    }

    copy_missing_source_entries() {
      while IFS= read -r -d "" entry; do
        relative="${entry#${source_directory}/}"
        destination="/recordings/${relative}"
        if [ -d "$entry" ]; then
          if [ -e "$destination" ] || [ -L "$destination" ]; then
            [ ! -L "$destination" ] && [ -d "$destination" ] || return 2
          else
            mkdir -p "$destination"
          fi
        elif [ ! -e "$destination" ] && [ ! -L "$destination" ]; then
          mkdir -p "$(dirname "$destination")"
          cp -a -n "$entry" "$destination"
        fi
      done < "$entries_file"
    }

    validate_marker() {
      [ -s "$migration_marker" ] || return 1
      marker_lines="$(wc -l < "$migration_marker" | tr -d " ")"
      marker_version="$(sed -n "1s/^version=//p" "$migration_marker")"
      marker_volume="$(sed -n "2s/^source_volume=//p" "$migration_marker")"
      marker_digest="$(sed -n "3s/^source_digest=//p" "$migration_marker")"
      [ "$marker_lines" = "3" ] && \
        [ "$marker_version" = "1" ] && \
        [ "$marker_volume" = "$LEGACY_DATA_VOLUME" ] && \
        [ "$marker_digest" = "$source_digest" ]
    }

    build_tree_digest /recordings >/dev/null || {
      echo "专用录像卷包含不安全或不可读取的内容，拒绝迁移。" >&2
      exit 2
    }
    if [ ! -e "$source_directory" ]; then
      echo "旧数据卷没有 Guacamole 录像目录，无需复制。"
      exit 0
    fi
    [ ! -L "$source_directory" ] && [ -d "$source_directory" ] || {
      echo "旧录像路径不是普通目录，拒绝迁移。" >&2
      exit 2
    }

    source_digest="$(build_tree_digest "$source_directory")" || {
      echo "无法生成旧录像内容摘要，拒绝迁移。" >&2
      exit 2
    }

    if [ -s "$migration_marker" ]; then
      validate_marker || {
        echo "录像卷迁移标记与当前旧数据卷或内容摘要不匹配，拒绝继续。" >&2
        exit 2
      }
      verify_source_copy || exit 2
      echo "录像卷迁移标记和逐文件内容复核通过，无需重复复制。"
      exit 0
    fi

    # 只补齐缺失条目，绝不覆盖目标卷中已经存在的文件。
    copy_missing_source_entries || {
      echo "无法无损补齐录像卷中的缺失条目。" >&2
      exit 2
    }
    verify_source_copy || {
      echo "录像卷未完整包含旧录像，或已有同名文件内容不同。" >&2
      exit 2
    }

    umask 077
    marker_tmp="${migration_marker}.tmp.$$"
    {
      printf "version=1\n"
      printf "source_volume=%s\n" "$LEGACY_DATA_VOLUME"
      printf "source_digest=%s\n" "$source_digest"
    } > "$marker_tmp"
    chmod 600 "$marker_tmp"
    mv "$marker_tmp" "$migration_marker"
  ' || fail "无损复制或逐文件校验失败；旧数据卷内容保持不变。"

echo "录像迁移校验完成：${DATA_VOLUME} -> ${RECORDINGS_VOLUME}"
echo "旧数据卷中的录像副本未删除，可在完成备份与隔离恢复后再单独处理。"
