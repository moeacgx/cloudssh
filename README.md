# CloudSSH 强化版

[![Release](https://img.shields.io/github/v/release/moeacgx/cloudssh?display_name=tag&sort=semver)](https://github.com/moeacgx/cloudssh/releases/latest)
[![License](https://img.shields.io/github/license/moeacgx/cloudssh)](LICENSE)
[![Docker](https://img.shields.io/badge/deploy-Docker-2496ED?logo=docker&logoColor=white)](docker/docker-compose.cloudssh.yml)
[![Agent Skill](https://img.shields.io/badge/Agent-Ed25519%20Device-111827)](skills/cloudssh-agent/SKILL.md)

<p align="center">
  <a href="https://t.me/zhanzhangck"><img src="https://img.shields.io/badge/Telegram-站长仓库-blue?logo=telegram" alt="Telegram 站长仓库"></a>
  <a href="https://t.me/vpsbbq"><img src="https://img.shields.io/badge/Telegram-NexHub_AI社区-blue?logo=telegram" alt="Telegram NexHub AI社区"></a>
</p>

CloudSSH 是面向个人和小团队的自托管云 SSH 与 Agent 运维平台。它基于
[Termix 2.6.0](https://github.com/Termix-SSH/Termix)，重点补齐了项目级资产隔离、
可共享的持续会话、本地 Agent Skill、面板内在线 Agent、凭据安全、完整审计和容器内一键更新。

它不只是把终端搬到浏览器里，而是把服务器、项目权限、加密凭据、持续会话、
文件操作、在线 Agent 共管和自动化入口放进同一个工作台。

> 当前版本仍在快速迭代。正式部署前请备份数据库、录像卷和根密钥，并完成一次
> 隔离恢复验证。

## 界面预览

<!-- prettier-ignore -->
<p align="center"><img src="docs/repo-images/panel-agent-ssh-copilot.jpg" alt="面板在线 Agent 与人工共管同一个 SSH 终端" width="49%" /> <img src="docs/repo-images/panel-agent-admin-copilot.jpg" alt="后台配置面板 Agent 与 SSH 终端协同" width="49%" /></p>

## ✨ CloudSSH 强化了什么

- **👥 个人空间与团队项目**：每位成员拥有隔离的个人空间；团队项目支持成员、
  角色组和项目管理员、操作者、只读成员等分级权限。
- **🗂️ 项目级服务器资产**：文件夹、标签、主机和快速连接都归属当前项目。同一台
  底层主机可以共享到多个项目，并保留稳定主机身份，不会被 Agent 识别成多台机器。
- **🔐 安全的凭据代用**：项目成员和 Agent 只能让平台代为连接，不能读取 SSH 密码、
  私钥或口令。凭据使用 AES-256-GCM 信封加密，根密钥与数据库备份分离。
- **🧷 平台持续会话**：CloudSSH 后端可以直接持有 SSH PTY，不要求目标机安装
  `tmux`。浏览器关闭或 Agent 分离后，会话仍可从“连接”中继续进入。
- **🪟 远端 `tmux` 固定会话**：适合跨 CloudSSH 重启恢复的长任务。创建固定窗口时
  明确选择平台模式或 `tmux` 模式，不会静默安装软件。
- **🤝 网页、本地 Agent 与面板 Agent 共用终端**：网页、已授权本地 Agent 和面板内在线 Agent
  可以进入或观察同一条 SSH 会话。单会话只允许一个写入租约，其他附件默认只读并可申请接管。
- **🤖 面板内在线 Agent**：SSH 窗口右侧提供 Agent 对话，读取当前目标窗口、终端上下文和
  可选 Skills，在人工可见、可接管的边界内把命令写回所选 SSH。
- **🌐 多服务器 Agent 运维能力**：支持选择多个 SSH 终端作为目标，让 Agent 按管理员配置的
  模型、Skills 和最大并发执行排障、安装、巡检、文件操作等任务。
- **🪪 无 Token 本地 Agent Skill**：设备首次生成 Ed25519 密钥，通过设备码在网页审批一次；
  后续请求自动签名，不需要 MCP、长期访问 Token 或逐次批准。
- **🛠️ 签名 API 运维能力**：本地 Agent 支持按项目和分类查询或创建主机、快速连接、结构化 Job、
  持续 SSH 会话，以及受权限控制的 SFTP 文件管理。
- **📁 可审计的 SFTP**：Agent 支持 `list`、`read`、`upload`、`download`、
  `mkdir`、`rename` 和 `delete`。上传下载只接收本地路径，文件正文不会进入
  Agent 对话。
- **🧭 主机信息补全**：服务器列表可显示国家、城市、ISP 和 ASN；内网地址不会发送给
  第三方地理信息服务。
- **🛡️ MFA 与通行密钥**：登录和高风险操作支持 TOTP 与 WebAuthn。凭据明文访问、
  设备审批、主机修改、会话写入和 SFTP 写操作都会进入审计。
- **🚀 容器内安全更新**：支持 `auto`、`binary` 和 `image` 三种方式，不使用
  updater sidecar，也不向应用挂载 Docker Socket。

## 保留 Termix 的成熟能力

CloudSSH 继续提供 Web SSH、SFTP 文件管理与在线编辑、多标签终端、最多四分屏、
终端搜索、文件预览与传输、会话录像、主机监控，以及 RDP/VNC 远程桌面等能力。

```mermaid
flowchart LR
    Browser["Web 工作台"] --> CloudSSH["CloudSSH"]
    PanelAgent["面板在线 Agent<br/>SSH 侧栏 / Skills"] --> CloudSSH
    Skill["本地 Agent Skill<br/>Ed25519 请求签名"] --> CloudSSH
    CloudSSH --> Control["项目权限 / 加密凭据<br/>会话 Broker / 审计"]
    Control --> Hosts["SSH / SFTP / RDP / VNC 主机"]
```

## 持续会话怎么选

- **平台模式**：不需要安装 `tmux`，网页和 Agent 可以共用同一条 SSH 会话。
  它能抵抗浏览器关闭和 Agent 进程退出，但 CloudSSH 容器重启、底层 SSH 断线后
  无法恢复。
- **`tmux` 模式**：会话实际运行在目标服务器的 `tmux` 中。即使 CloudSSH
  重启或 SSH 重新连接，远端任务仍可继续，适合编译、迁移和长时间脚本。
- **固定平台窗口**：可以长期保留且不受无人附着超时影响，但仍不能跨 CloudSSH
  重启恢复，不应替代远端 `tmux`。

普通无人附着会话默认保留 24 小时。显式关闭会话才会结束对应的远端任务。

## 面板 Agent 与本地 Agent

面板内在线 Agent 由管理员配置 OpenAI 兼容 Base URL、模型、API Key、最大并发和 Skills。
用户在 SSH 窗口右侧选择目标终端后，可以让 Agent 根据当前终端输出、文件窗口和对话上下文
生成并执行命令；人工仍在同一个 SSH 里查看输出、继续输入或接管写入权。

CloudSSH 也保留零 npm 依赖的
[`cloudssh-agent` Skill](skills/cloudssh-agent/SKILL.md)。本地 Agent 主机只需要
Node.js 20 或更高版本，不需要安装 MCP 客户端，也不需要克隆并构建整个仓库。

本地 Skill 首次登录时会在本机生成 Ed25519 设备密钥，并显示一次性设备码和公钥指纹。
设备私钥保存在 Windows DPAPI、macOS Keychain 或 Linux Secret Service 中；安全
存储不可用时会停止，不会降级为明文私钥文件。

网页审批可以授权全部可管理项目，也可以多选指定项目，并单独控制主机创建、
快速连接、命令执行、持续会话、文件读取和文件写入权限。

## 快速开始

需要 Docker Engine 和 Docker Compose v2。Linux 宿主机首次启动时执行：

```bash
git clone https://github.com/moeacgx/cloudssh.git
cd cloudssh

mkdir -p secrets
openssl rand -base64 32 > secrets/cloudssh_master_key
chown 1000:1000 secrets/cloudssh_master_key
chmod 600 secrets/cloudssh_master_key

ALLOW_REGISTRATION=true docker compose \
  -f docker/docker-compose.cloudssh.yml up --build -d
```

默认只监听 `127.0.0.1:8080`。创建首位实例管理员并启用 TOTP 或 WebAuthn 后，
不带 `ALLOW_REGISTRATION=true` 重新创建容器，关闭公开注册：

```bash
docker compose -f docker/docker-compose.cloudssh.yml up -d
```

外网部署应通过受信任的 HTTPS 反向代理访问，不要直接暴露明文 HTTP。根密钥必须
独立备份；丢失根密钥后，数据库中的加密凭据无法恢复。

## 从管理面板更新

管理员可以在 **管理 -> 版本** 中切换更新方式：

- `auto`：默认使用公开 GitHub Release 运行包；容器镜像版本更高时优先使用镜像。
- `binary`：持续使用经过校验并确认启动成功的 Release 运行包。
- `image`：始终使用镜像内程序，由管理员在宿主机执行 Compose 更新。

`auto` 和 `binary` 会在当前容器内完成 Release 校验、兼容性检查、数据库快照、
原子切换和启动失败回退。运行包不包含数据库、录像、环境变量、Docker Secret 或
生产凭据。

详细契约和恢复方式见
[CloudSSH 在线更新文档](docs/CLOUDSSH-UPDATES.md)。正式版本发布在
[GitHub Releases](https://github.com/moeacgx/cloudssh/releases)。

## 当前边界

- 当前使用单实例 SQLite，不支持多副本并发写入或高可用集群。
- 平台持续会话不能抵抗 CloudSSH 重启或底层 SSH 断线；跨平台故障恢复使用远端
  `tmux`。
- 首版没有内网 Connector，CloudSSH 实例必须能够直接访问目标服务器。
- 手机端覆盖连接、输入、会话恢复和紧急关闭，复杂管理操作以桌面网页为主。
- Electron 尚未同步全部团队控制面能力。
- 面板在线 Agent 依赖管理员配置的 OpenAI 兼容接口；本地 Agent 仍通过独立 Skill 和签名 API 接入。

## 文档

- [部署、安全边界、备份与恢复](docs/CLOUDSSH.md)
- [容器内一键更新](docs/CLOUDSSH-UPDATES.md)
- [Agent Skill 安装与命令](skills/cloudssh-agent/SKILL.md)
- [最新正式版本](https://github.com/moeacgx/cloudssh/releases/latest)

## 开发

```bash
npm install
npm run type-check
npm test
npm run test:skill
npm run build
```

应用开发要求的 Node.js 版本见 `package.json`。提交前还应运行
`npm run lint` 和 `npm run format:check`。

## 安全说明

- 不要把生产 `.env`、Docker Secret、数据库、备份或 SSH 凭据提交到仓库。
- Agent 设备应限制项目范围和权限，并定期复核已授权设备。
- 更新信任边界包含本仓库发布权限、GitHub HTTPS、不可变 Release 和摘要链。
- 发现安全问题时，请通过仓库 Security 页面私下报告，不要在公开 Issue 中披露
  凭据。

## 许可与上游

CloudSSH 依据 Apache License 2.0 发布，完整文本见 [LICENSE](LICENSE)。

本项目基于 [Termix](https://github.com/Termix-SSH/Termix)，界面方向参考了
[bifrost0x/webssh](https://github.com/bifrost0x/webssh)。上游版权与第三方说明见
[NOTICE-CLOUDSSH.md](NOTICE-CLOUDSSH.md)。
