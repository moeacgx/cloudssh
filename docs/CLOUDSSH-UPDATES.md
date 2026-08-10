# CloudSSH 在线更新

CloudSSH 使用容器内自更新，不需要独立更新容器，也不挂载 Docker
Socket。正式版本从公开 GitHub Release 匿名下载，运行包在激活前必须通过固定仓库、
版本、架构、文件名、大小和 SHA-256 校验。

## 更新方式

管理员可以在“管理 -> 版本”切换三种方式：

- `auto`：默认方式。后台一键更新使用 Release 运行包；容器镜像中的版本更高时，
  下次启动自动优先使用镜像版本。
- `binary`：后台一键更新使用 Release 运行包，并持续优先使用已经确认启动的
  `app-current`。这里的“binary”是持久化运行包模式，不是单文件可执行程序；它需要
  下载并安全解压运行包，适合不能授予宿主机 Docker 权限的环境。
- `image`：始终使用镜像内程序。生产环境应使用宿主机的
  `scripts/cloudssh-host-image-update.sh` 加载已校验的离线镜像并重启容器；应用容器
  不会获得 Docker Socket。

更新方式写入数据卷的 `/app/data/update-mode.txt`，所以重建容器后仍然有效。

## 一键更新流程

`auto` 和 `binary` 模式下，管理员完成近期 MFA 后点击更新，系统依次执行：

1. 从 `moeacgx/cloudssh` 的固定 Release 标签读取顶层发布清单。
2. 用顶层清单的 SHA-256 绑定运行包清单，并校验版本、提交和入口协议。
3. 校验 Node 主版本、原生模块 ABI 与 glibc 契约；不兼容时要求使用镜像更新。
4. 根据容器架构选择 `amd64` 或 `arm64` 运行包。
5. 流式下载到数据卷临时目录，同时限制响应大小并计算 SHA-256。
6. 在隔离目录解压，拒绝绝对路径、路径穿越、设备文件和包外链接。
7. 校验 `package.json` 版本、前端、后端、生产依赖和入口脚本。
8. 强制保存数据库，并在 `data/backups` 创建更新前快照及校验清单。
9. 原子轮换 `app-current` 与 `app-previous` 指针，写入 pending 标记后优雅重启。
10. 所有后端服务启动成功后写入 confirmed 标记，更新任务才算完成。

首次启动未确认时，入口脚本会在下一次启动自动归档失败运行包并恢复
`app-previous`；没有可用上一版本时回退到镜像内程序。
损坏的更新状态会被隔离为 `*.invalid-*`，不会阻止 SSH 平台本身启动。
确认成功后只保留当前与上一运行包；更新前数据库快照不会自动删除。

## 持久目录

```text
/app/data/
├── self-update/
│   ├── app-current    # 当前运行包指针：builtin 或 releases/<目录>
│   ├── app-previous   # 上一个可回退运行包指针
│   ├── releases/      # 已校验并解压的运行包
│   ├── pending.json   # 等待启动确认的版本
│   └── state.json     # 更新任务和历史
├── backups/           # 更新前数据库快照
└── update-mode.txt    # auto / image / binary
```

数据库、凭据密文、录像和根密钥不存入运行包，也不会因运行包轮换被移动。
`self-update` 中的运行包可从固定 Release 重新下载，因此常规状态备份会排除该目录，
避免备份体积随版本累积；`update-mode.txt` 和业务数据仍会进入备份。

## Release 契约

每个正式 Release 包含：

- `cloudssh-release.json` 与 `.sha256`；
- `cloudssh-self-update.json` 与 `.sha256`；
- `cloudssh-runtime-<version>-linux-amd64.tar.gz` 与 `.sha256`；
- `cloudssh-runtime-<version>-linux-arm64.tar.gz` 与 `.sha256`。
- `cloudssh-image-<version>-linux-<arch>.tar.gz`、镜像 ID 与 `.sha256`，供宿主机快速重启更新。

总清单示例：

```json
{
  "schemaVersion": 3,
  "channel": "stable",
  "version": "2.6.0-cloudssh.40",
  "image": "ghcr.io/moeacgx/cloudssh",
  "digest": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "revision": "0123456789abcdef0123456789abcdef01234567",
  "runtime": {
    "manifest": "cloudssh-self-update.json",
    "sha256": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
  },
  "minEntrypointProtocol": 2,
  "deploymentContract": "cloudssh-self-update-v1"
}
```

运行包由同一固定摘要镜像导出，包含 `html`、`dist/backend`、生产
`node_modules`、Nginx 模板、`package.json` 和新版入口脚本。运行包不包含
`/app/data`、环境变量、Docker Secret 或任何生产凭据。

运行包清单声明 `cloudssh-node-glibc-v1` 兼容契约、Node 主版本、
`NODE_MODULE_VERSION` 和 libc，同时必须声明
`cloudssh-sqlite-backward-v1` 数据库回退契约。旧容器不满足契约或版本包含
不可向后兼容的数据库迁移时，必须改用镜像更新并先完成隔离恢复演练。

客户端当前信任边界是固定的 `moeacgx/cloudssh` 仓库、GitHub HTTPS、
不可变 Release 与清单摘要链。正式发版前必须在仓库设置中启用不可变 Release，
并把仓库变量 `CLOUDSSH_IMMUTABLE_RELEASES` 设为 `true`；流水线发布后会再次读取
Release 的 `immutable` 状态并校验证明。仓库发布权限失陷仍属于信任边界，不能把
SHA-256 描述成独立的发布者签名。

## 生产快速重启更新

运行包更新会下载并安全解压应用、依赖和原生模块；生产机需要更短的升级窗口时，使用
宿主机镜像更新器。它下载对应架构的离线镜像，校验 Release 清单、附件 SHA-256、镜像
ID、架构和版本标签，然后才停止服务、备份、`docker load`、重建容器并检查 `/health`。
新容器未在 120 秒内健康时，它会自动恢复升级前镜像。

在 `/opt/cloudssh` 的受控运维账号执行；省略版本时选择最新正式 Release：

```sh
cd /opt/cloudssh
sh scripts/cloudssh-host-image-update.sh

# 固定升级到指定正式版本
sh scripts/cloudssh-host-image-update.sh 2.6.0-cloudssh.40
```

脚本需要 `curl`、`docker`、`gzip` 与 `sha256sum`（或 `shasum`），并且要求当前镜像仍在本机，
以保证失败时能够回滚。它只在宿主机调用 Docker；CloudSSH 容器和管理面板都不会挂载或暴露
Docker Socket。
镜像更新器会先读取当前容器的真实 `/app/data` 与录像 Docker 命名卷，后续备份、重建和回滚都强制复用这两个卷；新容器健康前还会再次核对挂载卷名，不一致时拒绝确认，避免因 `.env`、Compose 目录或默认卷名变化误挂空卷造成“数据丢失”假象。
日常推送到 `main` 时，`.github/workflows/cloudssh-docker.yml` 会用缓存优先的多架构 Buildx
直接推送 `ghcr.io/moeacgx/cloudssh` 镜像；正式 Release 仍由 `cloudssh-release.yml`
保留严格的离线包、校验和不可变 Release 链路。

`auto` 与 `binary` 仍保留为无宿主机权限时的容器内运行包更新。生产机采用本节路径时，
请把面板更新方式设为 `image`，避免随后选择较慢的运行包。运行包回退只切换程序，不会
自动把数据库覆盖为旧快照；发生不兼容迁移时必须按 `docs/CLOUDSSH.md` 的恢复流程人工处理。
