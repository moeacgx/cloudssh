# CloudSSH 私有团队平台

CloudSSH 基于 Termix 2.6.0，增加项目隔离、平台凭据库、持久 SSH 会话和
Agent API。当前实现用于全新私有实例，不应直接覆盖现有 Termix 数据卷。

## 安全边界

- SSH 密码和私钥由服务端凭据库接收，使用 AES-256-GCM 信封加密后写入
  `project_credentials`。普通项目成员、项目服务器列表、审计和 Agent API
  均不返回凭据；实例管理员可在专用管理入口读取、复制和导出明文凭据。
- 根密钥从 `CLOUDSSH_MASTER_KEY_FILE` 或 `CLOUDSSH_MASTER_KEY` 读取。
  生产环境只使用 Docker Secret 文件，并与数据卷备份分开保存。
- Agent 首次登录在本机生成 Ed25519 设备密钥，通过短期设备码由网页审批。
  私钥仅进入系统安全存储，平台只保存公钥。设备可授权全部可管理项目或多选
  指定项目，并绑定 scope、有效期和并发上限；所选项目内全部服务器自动可用。
  审批后每个请求自动签名，不创建长期 Token，也不需要逐次批准。
- Agent API 经主站 `/agent/v1` 暴露；内部监听 `127.0.0.1:30013`，不直接发布
  明文端口。生产环境必须由 HTTPS 反向代理提供服务。
- 项目服务器列表只包含连接目标和状态，不包含用户名、认证方式、密码、私钥
  或凭据 ID。
- 只有实例管理员可在用户管理中查看、复制或导出目标用户的明文密码与私钥；
  项目管理员和其他角色不能使用该能力。该入口拒绝 API Key，只接受五分钟内
  完成 TOTP 或 WebAuthn 验证的网页会话。每次明文查看、复制和导出都必须先写入
  专用审计，审计不可用时拒绝返回，并且正式环境只能通过 HTTPS 使用。

## 本地启动

需要 Node.js 22.12 以上版本。首次启动前生成 32 字节根密钥：

```sh
mkdir -p secrets
openssl rand -base64 32 > secrets/cloudssh_master_key
chown 1000:1000 secrets/cloudssh_master_key
chmod 600 secrets/cloudssh_master_key
ALLOW_REGISTRATION=true docker compose \
  -f docker/docker-compose.cloudssh.yml up --build -d
```

网页入口为 `http://127.0.0.1:8080`。创建首位实例管理员并启用 TOTP 或
WebAuthn 后，不带 `ALLOW_REGISTRATION=true` 重新创建容器；编排默认值为关闭
公开注册。后续成员由管理员创建。正式环境还应在外层配置可信 TLS 证书。
编排默认只监听宿主机回环地址；若确需修改 `CLOUDSSH_BIND_ADDRESS`，必须先由
防火墙或可信反向代理限制来源，不能把明文 HTTP 端口直接暴露到公网。
容器会默认把 Docker 宿主机网关识别为单个 `/32` 可信代理地址；使用独立反代
容器、自定义网络或多层代理时，必须把 `CLOUDSSH_TRUSTED_PROXY_CIDR` 设置为
直接连接 CloudSSH 的代理地址或最小网段；多个不连续网段使用逗号分隔，最多
64 个。启动脚本会逐项校验并去重，非可信来源伪造的 `X-Forwarded-Proto`、
`X-Forwarded-Host` 和 `X-Forwarded-Port` 不会生效。
容器内应用使用 UID/GID `1000:1000` 读取 Docker Secret，因此根密钥文件必须
由该 UID/GID 持有并保持 `0600`；若日志提示凭据库锁定，应先检查这里，而不是
把密钥改成全局可读。

## Agent API

所有业务请求使用 `X-CloudSSH-Device-ID`、时间戳、nonce、正文摘要和 Ed25519
签名头。nonce 在数据库中单次消费以阻止重放。创建和写入必须带
`Idempotency-Key`。服务器参数使用项目服务器关联 ID，不是底层 SSH 主机 ID。

```text
POST   /agent/v1/sessions
GET    /agent/v1/servers
GET    /agent/v1/projects
GET    /agent/v1/projects/:projectId/folders
GET    /agent/v1/projects/:projectId/credentials
POST   /agent/v1/servers
POST   /agent/v1/quick-connections
GET    /agent/v1/files/list?serverId=...&path=...
GET    /agent/v1/files/read?serverId=...&path=...
GET    /agent/v1/files/download?serverId=...&path=...
POST   /agent/v1/files/upload?serverId=...&path=...
POST   /agent/v1/files/mkdir
POST   /agent/v1/files/rename
POST   /agent/v1/files/delete
GET    /agent/v1/sessions
GET    /agent/v1/sessions/:id/status
POST   /agent/v1/sessions/:id/attach
GET    /agent/v1/sessions/:id/read?cursor=...
POST   /agent/v1/sessions/:id/write
POST   /agent/v1/sessions/:id/resize
POST   /agent/v1/sessions/:id/detach
POST   /agent/v1/sessions/:id/close
POST   /agent/v1/jobs
GET    /agent/v1/jobs
GET    /agent/v1/jobs/:id
POST   /agent/v1/jobs/:id/cancel
```

创建 Agent 会话时可传 `runtimeMode: "platform" | "tmux"`。普通会话默认使用
`platform`，由 CloudSSH 后端直接持有原生 SSH PTY，目标机不需要安装 `tmux`，
网页和 Agent 可附着同一会话；显式设置 `pinned: true` 且未指定运行模式时仍默认
使用 `tmux`，以保留跨 CloudSSH 容器重启恢复的能力。需要长期保留但不安装
`tmux` 时，应同时传 `runtimeMode: "platform"` 和 `pinned: true`。这种会话不会
因无人附着超时而关闭，但 CloudSSH 进程或容器重启后无法恢复，状态会明确转为
失败，不会伪装成仍可连接。

设备只有在审批时分别获得 `servers:create` 或
`quick-connections:create` scope，才能向已授权项目创建长期主机或快速连接。
主机可指定项目、项目分类和标签；快速连接必须指定项目并提供已人工核对的
SSH Host Key 指纹。凭据列表只返回 ID、名称、用户名和认证类型，不返回密码、
私钥或私钥口令。本机新凭据只能由 Skill 通过 `--password-file`、`--key-file`
或 `--key-password-file` 读取并经 HTTPS 提交，敏感内容不进入命令行、审计或
幂等记录。

文件接口直接复用平台 SFTP 凭据链。`files:read` 允许列出目录、读取文本及下载，
`files:write` 允许上传、创建目录、重命名/移动和删除。上传与下载命令只接受本地
文件路径，正文不会打印到 Agent 输出；上传、创建目录、移动及删除均写入审计。

## 主机地区与 ISP

新建、编辑及历史主机会异步补充国家、城市、ISP 和 ASN。默认查询服务为
`https://ipwho.is/{ip}`，只会发送解析后的公网单播 IP；内网、环回、链路本地、
文档保留和多播地址都在本地判定，不会发送给第三方。查询失败不会影响 SSH
连接，结果会缓存并自动刷新界面。

若实例不允许向第三方发送公网 IP，在启动 Compose 前设置：

```sh
export CLOUDSSH_NETWORK_INFO_ENABLED=false
```

也可用 `CLOUDSSH_NETWORK_INFO_ENDPOINT` 指向自建的 HTTPS 查询服务。地址必须
包含 `{ip}` 占位符，或能接受 `?ip=` 查询参数；明文 HTTP 端点会被拒绝。

Agent 或浏览器分离只删除附件。Agent 普通会话和浏览器普通 SSH 窗口默认保留
24 小时；浏览器管理员可在“SSH 断线保留时间”中调整普通窗口的 1 分钟至 7 天
保留期。每次重新进入后再离开都会重新计时，有人附着时不会因该计时器关闭。

浏览器终端顶部的“固定窗口”提供两种模式：

- **tmux 固定**在目标服务器创建平台受管的远端 `tmux`。浏览器关闭、网络中断、
  底层 SSH 断线、CloudSSH 重启或网页登录过期后，远端任务仍继续运行；重新连接
  后可恢复窗口。只有明确执行“终止窗口”才会终止受管 `tmux`。
- **平台保活**复用 CloudSSH 后端持有的 SSH 连接，不要求目标服务器安装 `tmux`。
  关闭网页或离开终端不会停止任务，但底层 SSH 断线或 CloudSSH 服务重启后无法
  恢复，因此不适合必须跨平台故障继续运行的长任务。

固定窗口必须在输入命令前开启，避免把已经运行的前台进程强行迁移到另一个
shell。输出游标包含会话 ID、流世代和序号，不能跨会话使用。写入采用单租约
模型，接管会使旧租约立即失效。

经常承载长任务的主机可在 SSH 终端设置中启用“连接时固定窗口”。平台会先确认
所选固定模式；选择 `tmux` 时，还会等待创建或附着成功。确认完成后，平台才按
顺序写入环境变量、切换初始目录、执行启动命令并开放输入，避免启动内容提前进入
普通 Shell 或被长任务当作标准输入。如果创建或附着确认失败，平台不会执行这些
启动步骤，并会关闭本次普通连接；无法确认回滚时保留恢复记录，避免远端窗口变成
无索引任务。

运行状态 sidecar 会保留最近 30 天、最多 1,000 条已结束会话和 Job。已结束
会话的终端输出保留 24 小时，Job 输出采用 64 MiB 全局上限；普通幂等记录的
防重窗口为 7 天，仍关联保留中会话或 Job 的创建记录不会提前淘汰。
控制面中的已结束 Agent 会话元数据保留 90 天；个人空间的纯元数据录像随会话
一并清理，团队项目的完整录像在自身保留期结束且文件清理成功后才允许删除会话。

## 独立 Skill

推荐直接安装仓库中的
[`skills/cloudssh-agent`](../skills/cloudssh-agent/SKILL.md)。在 Codex 中要求
`skill-installer` 从下面的 GitHub 路径安装即可，安装器默认直接下载 Skill
子目录，不需要手工克隆仓库：

```text
https://github.com/moeacgx/cloudssh/tree/main/skills/cloudssh-agent
```

安装后重启 Codex。Skill 自带零 npm 依赖的脚本，只要求 Agent 主机具备
Node.js 20 或更高版本，不需要 MCP、MCP 客户端、`npm install` 或项目构建。
首次登录只需在交互式终端运行：

```sh
node <已安装Skill目录>/scripts/cloudssh.mjs auth login --url https://ssh.example.com
```

脚本显示设备码、设备名称和公钥指纹后，在网页“Agent 接入”中批准一次。
Ed25519 设备私钥会保存到 Windows DPAPI、macOS Keychain 或 Linux Secret
Service；平台地址、设备 ID、会话附件、租约和输出游标只保存于当前系统用户
私有目录。设备被撤销、过期、私钥丢失或更换设备时才需要重新审批。

## 远端要求

`tmux` 固定使用固定 `cloudssh-*` 名称连接远端 `tmux`；平台保活不要求目标
服务器安装 `tmux`。当目标服务器缺少 `tmux` 时，网页会明确要求操作者选择
“安装 tmux 并固定”“使用平台保活”或“取消”，绝不会静默安装系统包。

自动安装只支持 `apt-get`、`dnf`、`yum`、`apk` 和 `zypper`，并且只会以
`root` 或无需密码的 `sudo -n` 执行。CloudSSH 不索取或保存 sudo 密码，网页和
接口也不会收到包管理器的原始输出；安装条件不满足时会直接失败，操作者仍可选择
平台保活。无论选择哪种模式，都必须先在网页端验证并固定 SSH Host Key，平台
不会跳过 Host Key 校验。

## 备份与隔离恢复

CloudSSH 使用 Termix 的内存 SQLite 加密快照机制，因此不直接操作运行中的
WAL 文件。编排把主数据放在 `cloudssh-data`，把 Guacamole 录像放在独立的
`cloudssh-recordings`；`guacd` 只能访问录像卷，不能读取数据库、密钥配置或
Agent 安全库。完整恢复至少需要 `db.sqlite.encrypted`、数据卷内自动生成的 `.env`、
`agent/runtime-state.json` 和 `agent/agent-security.sqlite`。后两个文件分别保存
Job/会话防重状态和设备签名防重、安全审计状态，缺失时恢复检查必须失败。
`cloudssh` 和 `guacd` 两个录像卷写入服务都配置了至少 60 秒的优雅
停止时限。首次采用该配置时应重新创建容器；每次备份前都必须同时停止两个
服务，使最后一次数据库强制保存与 Agent 安全库检查点完成：

```sh
docker compose -f docker/docker-compose.cloudssh.yml up -d --build --force-recreate
docker compose -f docker/docker-compose.cloudssh.yml \
  stop --timeout 60 cloudssh guacd
sh scripts/cloudssh-backup.sh
docker compose -f docker/docker-compose.cloudssh.yml start guacd cloudssh
```

备份脚本会逐个确认容器已停止、退出码为 0、容器停止时限不少于 60 秒，并检查
CloudSSH 在数据库和 Agent 状态全部落盘后写入的正常关机标记。任一 Compose
状态查询失败、标记缺失或服务仍在运行时都会中止，且不会开始归档。脚本随后
从容器真实挂载反查数据卷和录像卷，确认两服务使用同一专用录像卷后再只读归档，
不会仅相信环境变量中的卷名。归档同时包含主数据和录像，并生成强制清单与
SHA-256 校验文件；它不
包含 `secrets/cloudssh_master_key`。归档、清单和校验文件使用仅当前宿主机用户可读的
权限创建。备份仍包含数据库密钥配置和录像；SHA-256 只校验完整性，不提供加密
或来源认证，因此正式备份必须进入带认证加密和访问控制的离线或异地存储。

从旧的单卷编排升级时，先完成旧 `cloudssh-data` 的卷快照并停止两个服务，再执行：

```sh
sh scripts/cloudssh-migrate-recordings.sh cloudssh-data cloudssh-recordings
```

迁移脚本只把旧的 `session_recordings/guacamole` 复制到新录像卷，并逐文件比较；
新卷已有冲突内容、任一卷仍被运行中容器使用或校验不一致时都会失败。脚本不会
删除旧数据卷中的录像副本，校验成功后会写入同时绑定源卷名和旧录像内容摘要的
版本化迁移标记。每次备份都会重新计算摘要并复核所有旧录像仍完整存在于专用卷，
不会只信任历史标记；旧版单行标记需要重新运行迁移脚本生成新格式。
备份脚本检测到旧录像但找不到匹配标记时会拒绝归档，避免旧录像被新嵌套卷隐藏。
完成新格式备份和隔离恢复前，不要手工清理旧副本。

恢复验证需要本次版本的 CloudSSH 镜像和与备份配套、独立保存的根密钥。
使用全新的隔离卷执行：

```sh
sh scripts/cloudssh-verify-restore.sh \
  backups/cloudssh-state-YYYYMMDDTHHMMSSZ.tar.gz \
  cloudssh-restore-data-YYYYMMDD \
  cloudssh-restore-recordings-YYYYMMDD \
  secrets/cloudssh_master_key
```

验证脚本拒绝覆盖任一目标卷，并强制验证相邻的 `.sha256` 与 `.manifest` 文件。
它会检查归档路径和条目类型，拒绝符号链接、硬链接与设备文件，验证 Agent JSON、
Agent SQLite 和解密后主 SQLite 的 `integrity_check`，并用根密钥逐条解密项目
凭据。数据库中的 Agent 完整录像和 Guacamole 录像引用也会逐条核对实际文件、
大小及已有校验和。最后脚本会在无外部网络、无宿主机端口映射的临时容器中同时
挂载隔离数据卷和录像卷，启动恢复后的后端，
通过健康检查后再以 60 秒时限
优雅停止，并确认生成了新的正常关机标记。验证镜像或根密钥不可用时会明确失败，
不会降级为仅检查文件存在。失败时隔离卷会保留供排查，但绝不会自动接入生产。
脚本通过后，管理员仍须在受控隔离环境完成登录和一台测试服务器连接，才算
完整恢复演练通过。若使用其他镜像标签，可设置 `CLOUDSSH_VERIFY_IMAGE`。

## 在线更新

正式部署可选装独立更新器，在管理后台查看当前版本、Release、更新历史并执行
一键更新或回退。主应用不会挂载 Docker Socket；更新前必须生成并校验完整备份，
新镜像必须通过健康检查，否则自动恢复旧镜像。安装方式、安全边界、发布清单及
故障恢复说明见 [CloudSSH 在线更新](CLOUDSSH-UPDATES.md)。

## 上线顺序

1. 备份现有 Termix 数据卷，并执行一次隔离恢复。
2. 以新数据卷启动 CloudSSH，创建团队和项目，再按项目范围审批 Agent 设备。
3. 导入凭据，验证 Host Key，并分别测试网页 SSH、SFTP、持久会话和 Job API。
4. 启用 HTTPS、邀请制注册和 MFA，再允许团队成员访问。
5. 验证审计不含密码、私钥、设备码和完整签名。
6. 新系统稳定后再轮换旧 SSH 凭据；不要提前删除 `llmwiki` 中的记录。

## 当前限制

- 首版为单实例 SQLite，不支持多副本并发写入。
- 不提供端口转发和内置 AI 聊天。
- Web 为主，手机只保证连接、输入、恢复和紧急关闭。
- Electron 尚未同步全部控制面功能。
