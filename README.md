# CloudSSH

CloudSSH 是面向个人与小团队的自托管云 SSH 工作台。项目基于 Termix 2.6.0
开发，增加项目级资产隔离、持续会话、设备签名 Agent、审计和容器内一键更新。

> 当前版本仍在快速迭代。正式部署前请备份数据库、录像卷和根密钥，并完成一次
> 隔离恢复验证。

## 核心能力

- Web SSH、SFTP、分屏、终端搜索、录像、主机监控和远程桌面；
- 个人空间、团队项目、项目角色组和项目级主机文件夹；
- 平台中转持续会话，以及可选的远端 `tmux` 固定会话；
- Ed25519 设备身份、首次网页审批、项目范围权限和单写入租约；
- Agent 会话共享、结构化 Job API，以及受审计的 SFTP 文件操作；
- 凭据密文存储、MFA 提权、设备与成员操作审计；
- `auto`、`binary`、`image` 三种更新方式，不需要 updater sidecar，
  不挂载 Docker Socket。

## 快速开始

环境要求：Docker Engine、Docker Compose v2，以及用于持久化加密的随机根密钥。

```bash
git clone https://github.com/moeacgx/cloudssh.git
cd cloudssh
mkdir -p secrets
openssl rand -base64 48 > secrets/cloudssh_master_key
chmod 600 secrets/cloudssh_master_key
docker compose -f docker/docker-compose.cloudssh.yml up -d
```

默认只监听 `127.0.0.1:8080`。外网部署应通过受信任的 HTTPS 反向代理访问，
不要直接暴露明文 HTTP。首次初始化完成后保持 `ALLOW_REGISTRATION=false`。

正式环境建议使用固定版本镜像：

```bash
CLOUDSSH_IMAGE=ghcr.io/moeacgx/cloudssh:2.6.0-cloudssh.29 \
docker compose -f docker/docker-compose.cloudssh.yml up -d
```

## 在线更新

管理员可在“管理 -> 版本”中选择更新方式：

- `auto`：默认使用 Release 运行包；容器镜像版本更高时优先使用镜像；
- `binary`：持续使用已确认启动的 Release 运行包；
- `image`：只使用容器镜像，由宿主机执行 Compose 更新。

`auto` 和 `binary` 都在当前容器内完成校验、快照、原子切换与失败回退。
详细安全边界、发布清单和恢复流程见
[CloudSSH 在线更新](docs/CLOUDSSH-UPDATES.md)。

## Agent Skill

仓库内的 `skills/cloudssh-agent` 支持设备码注册、网页审批和 Ed25519 请求签名。
设备私钥保存在本机安全存储中，Skill 参数不会出现 SSH 密码、私钥或平台 Token。

安装与命令说明见 [Agent Skill 文档](skills/cloudssh-agent/SKILL.md)。

## 开发

```bash
npm install
npm run type-check
npm test
npm run test:skill
npm run build
```

Node.js 版本要求见 `package.json`。提交前还应运行 `npm run lint` 和
`npm run format:check`。

## 安全说明

- 数据库只保存加密后的主机凭据，根密钥必须独立于数据库备份保存；
- 不要把生产 `.env`、Docker Secret、数据库、备份或 SSH 凭据提交到仓库；
- Agent 设备授权应限制项目范围和权限，并定期复核已授权设备；
- 更新包的信任边界包含本仓库发布权限、GitHub HTTPS、不可变 Release 和摘要链；
- 发现安全问题时，请通过仓库 Security 页面私下报告，不要在公开 Issue 中披露凭据。

## 许可与上游

CloudSSH 依据 Apache License 2.0 发布，完整文本见 [LICENSE](LICENSE)。

本项目基于 [Termix](https://github.com/Termix-SSH/Termix)，界面方向参考了
[bifrost0x/webssh](https://github.com/bifrost0x/webssh)。上游版权与第三方说明见
[NOTICE-CLOUDSSH.md](NOTICE-CLOUDSSH.md)。
