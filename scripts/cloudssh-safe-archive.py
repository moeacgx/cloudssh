#!/usr/bin/env python3
"""校验并安全解包 CloudSSH 双卷备份归档。"""

from __future__ import annotations

import argparse
import os
from pathlib import Path, PurePosixPath
import stat
import sys
import tarfile
from typing import Iterable


ALLOWED_ROOTS = {"data", "recordings"}
DEFAULT_MAX_MEMBERS = 200_000
DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024 * 1024
COPY_BUFFER_BYTES = 1024 * 1024


class ArchiveValidationError(RuntimeError):
    """备份归档违反安全或结构约束。"""


def positive_limit(name: str, default: int) -> int:
    raw_value = os.environ.get(name)
    if raw_value is None:
        return default
    try:
        value = int(raw_value)
    except ValueError as error:
        raise ArchiveValidationError(f"{name} 必须是正整数") from error
    if value <= 0:
        raise ArchiveValidationError(f"{name} 必须是正整数")
    return value


def canonical_member_path(name: str) -> tuple[str, tuple[str, ...]]:
    if not name or "\\" in name or "\x00" in name:
        raise ArchiveValidationError(f"归档包含非法路径：{name!r}")

    raw_path = PurePosixPath(name)
    if raw_path.is_absolute():
        raise ArchiveValidationError(f"归档包含绝对路径：{name}")
    parts = tuple(part for part in raw_path.parts if part not in ("", "."))
    if not parts or any(part == ".." for part in parts):
        raise ArchiveValidationError(f"归档包含目录穿越路径：{name}")
    if parts[0] not in ALLOWED_ROOTS:
        raise ArchiveValidationError(f"归档包含未授权顶层路径：{name}")
    return "/".join(parts), parts


def validate_members(members: Iterable[tarfile.TarInfo]) -> list[tarfile.TarInfo]:
    max_members = positive_limit(
        "CLOUDSSH_RESTORE_MAX_ARCHIVE_MEMBERS", DEFAULT_MAX_MEMBERS
    )
    max_total_bytes = positive_limit(
        "CLOUDSSH_RESTORE_MAX_UNCOMPRESSED_BYTES", DEFAULT_MAX_TOTAL_BYTES
    )
    validated: list[tarfile.TarInfo] = []
    member_types: dict[str, str] = {}
    total_bytes = 0

    for member in members:
        if len(validated) >= max_members:
            raise ArchiveValidationError(
                f"归档条目超过上限 {max_members}，拒绝继续"
            )
        canonical, parts = canonical_member_path(member.name)
        if canonical in member_types:
            raise ArchiveValidationError(f"归档包含重复路径：{member.name}")

        if member.isdir():
            member_kind = "directory"
        elif member.isfile():
            if len(parts) == 1:
                raise ArchiveValidationError(
                    f"归档顶层路径必须是目录：{member.name}"
                )
            if member.size < 0:
                raise ArchiveValidationError(f"归档文件大小无效：{member.name}")
            total_bytes += member.size
            if total_bytes > max_total_bytes:
                raise ArchiveValidationError(
                    f"归档解压后大小超过上限 {max_total_bytes} 字节"
                )
            member_kind = "file"
        else:
            raise ArchiveValidationError(
                f"归档包含符号链接、硬链接或特殊文件：{member.name}"
            )

        member_types[canonical] = member_kind
        validated.append(member)

    if not validated:
        raise ArchiveValidationError("备份归档为空")

    for canonical, member_kind in member_types.items():
        parts = canonical.split("/")
        for index in range(1, len(parts)):
            ancestor = "/".join(parts[:index])
            if member_types.get(ancestor) == "file":
                raise ArchiveValidationError(
                    f"归档文件同时被当作目录使用：{ancestor}"
                )
        if len(parts) == 1 and member_kind != "directory":
            raise ArchiveValidationError(f"归档顶层路径必须是目录：{canonical}")

    for required_root in ALLOWED_ROOTS:
        if member_types.get(required_root) != "directory":
            raise ArchiveValidationError(
                f"归档缺少必需顶层目录：{required_root}/"
            )
    return validated


def require_empty_directory(root: Path, label: str) -> None:
    root_stat = root.lstat()
    if stat.S_ISLNK(root_stat.st_mode) or not stat.S_ISDIR(root_stat.st_mode):
        raise ArchiveValidationError(f"{label}目标不是普通目录：{root}")
    if any(root.iterdir()):
        raise ArchiveValidationError(f"{label}目标目录不是空目录：{root}")


def safe_destination(root: Path, parts: tuple[str, ...]) -> Path:
    destination = root.joinpath(*parts)
    try:
        destination.relative_to(root)
    except ValueError as error:
        raise ArchiveValidationError("归档目标逃逸出恢复目录") from error
    return destination


def ensure_plain_directory(directory: Path, root: Path) -> None:
    relative_parts = directory.relative_to(root).parts
    current = root
    for part in relative_parts:
        current = current / part
        try:
            current.mkdir(mode=0o700)
        except FileExistsError:
            pass
        current_stat = current.lstat()
        if stat.S_ISLNK(current_stat.st_mode) or not stat.S_ISDIR(
            current_stat.st_mode
        ):
            raise ArchiveValidationError(f"恢复路径包含非普通目录：{current}")
        current.chmod(0o700)


def extract_regular_file(
    archive: tarfile.TarFile,
    member: tarfile.TarInfo,
    destination: Path,
    root: Path,
) -> None:
    ensure_plain_directory(destination.parent, root)
    source = archive.extractfile(member)
    if source is None:
        raise ArchiveValidationError(f"无法读取归档文件：{member.name}")

    no_follow = getattr(os, "O_NOFOLLOW", 0)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | no_follow
    # 只保留归档中的所有者执行位，其他权限统一收紧；OPKSSH 等二进制仍可执行。
    safe_mode = 0o600 | (member.mode & 0o100)
    descriptor = os.open(destination, flags, safe_mode)
    copied_bytes = 0
    try:
        with source, os.fdopen(descriptor, "wb", closefd=True) as output:
            while True:
                chunk = source.read(COPY_BUFFER_BYTES)
                if not chunk:
                    break
                copied_bytes += len(chunk)
                if copied_bytes > member.size:
                    raise ArchiveValidationError(
                        f"归档文件实际内容超过声明大小：{member.name}"
                    )
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    if copied_bytes != member.size:
        destination.unlink(missing_ok=True)
        raise ArchiveValidationError(
            f"归档文件内容长度与声明不一致：{member.name}"
        )
    destination.chmod(safe_mode)


def verify_plain_tree(root: Path, label: str) -> None:
    pending = [root]
    while pending:
        directory = pending.pop()
        for entry in os.scandir(directory):
            entry_stat = entry.stat(follow_symlinks=False)
            if stat.S_ISLNK(entry_stat.st_mode):
                raise ArchiveValidationError(f"{label}包含符号链接：{entry.path}")
            if stat.S_ISDIR(entry_stat.st_mode):
                pending.append(Path(entry.path))
                continue
            if not stat.S_ISREG(entry_stat.st_mode):
                raise ArchiveValidationError(f"{label}包含特殊文件：{entry.path}")
            if os.name != "nt" and entry_stat.st_nlink != 1:
                raise ArchiveValidationError(f"{label}包含硬链接：{entry.path}")


def extract_archive(
    archive: tarfile.TarFile,
    members: list[tarfile.TarInfo],
    data_root: Path,
    recordings_root: Path,
) -> None:
    require_empty_directory(data_root, "数据卷")
    require_empty_directory(recordings_root, "录像卷")
    roots = {"data": data_root, "recordings": recordings_root}

    directories: list[tuple[Path, Path]] = []
    files: list[tuple[tarfile.TarInfo, Path, Path]] = []
    for member in members:
        _, parts = canonical_member_path(member.name)
        root = roots[parts[0]]
        relative_parts = parts[1:]
        if not relative_parts:
            continue
        destination = safe_destination(root, relative_parts)
        if member.isdir():
            directories.append((destination, root))
        else:
            files.append((member, destination, root))

    for directory, root in sorted(directories, key=lambda item: len(item[0].parts)):
        ensure_plain_directory(directory, root)
    for member, destination, root in files:
        extract_regular_file(archive, member, destination, root)

    verify_plain_tree(data_root, "恢复后的数据卷")
    verify_plain_tree(recordings_root, "恢复后的录像卷")


def inspect_archive(
    archive_path: Path,
    data_root: Path | None = None,
    recordings_root: Path | None = None,
) -> None:
    if not archive_path.is_file():
        raise ArchiveValidationError(f"备份归档不存在：{archive_path}")
    try:
        with tarfile.open(archive_path, mode="r:gz") as archive:
            members = validate_members(archive.getmembers())
            if data_root is not None and recordings_root is not None:
                extract_archive(archive, members, data_root, recordings_root)
    except (tarfile.TarError, OSError) as error:
        raise ArchiveValidationError(f"无法安全读取或解包归档：{error}") from error


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    validate = subcommands.add_parser("validate", help="只校验归档")
    validate.add_argument("archive", type=Path)
    extract = subcommands.add_parser("extract", help="校验并解包到两个空目录")
    extract.add_argument("archive", type=Path)
    extract.add_argument("data_root", type=Path)
    extract.add_argument("recordings_root", type=Path)
    return parser.parse_args()


def main() -> int:
    arguments = parse_arguments()
    try:
        if arguments.command == "validate":
            inspect_archive(arguments.archive)
            print("归档结构和成员类型校验通过。")
        else:
            inspect_archive(
                arguments.archive,
                arguments.data_root,
                arguments.recordings_root,
            )
            print("归档已安全解包并完成文件树复核。")
        return 0
    except ArchiveValidationError as error:
        print(f"归档安全校验失败：{error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
