# 为 CloudSSH 贡献

感谢你参与 CloudSSH。Issue 和 Pull Request 可以使用中文或英文。提交代码前请先
搜索现有 Issue，避免重复实现；涉及权限、凭据、数据库或更新链路的较大改动，建议
先开 Issue 说明设计与兼容方案。

## 开发环境

- Node.js 24（仓库通过 `.nvmrc` 固定；最低支持 22.12）
- npm 11 或更高版本
- Git
- 可选：Docker、临时 OpenSSH 与 `tmux`，用于集成测试

不要在开发环境、测试、Issue、日志或截图中使用生产 SSH 凭据、设备私钥、平台
Token、数据库、录像或根密钥。

## 安装与启动

```sh
git clone https://github.com/moeacgx/cloudssh.git
cd cloudssh
npm ci
```

分别启动后端和前端开发服务器：

```sh
npm run dev:backend
npm run dev
```

前端默认地址为 <http://localhost:5173/>。Docker 部署、根密钥、备份与隔离恢复请
参阅 [`docs/CLOUDSSH.md`](docs/CLOUDSSH.md)。

## 提交流程

1. 在 [CloudSSH 仓库](https://github.com/moeacgx/cloudssh) 创建 Fork。
2. 从最新 `main` 创建职责单一的分支，例如：

   ```sh
   git checkout -b feat/project-session-search
   ```

3. 完成代码、测试和必要文档。
4. 使用 Conventional Commits，例如：

   ```sh
   git commit -m "feat(session): add project session search"
   ```

5. 推送分支并向 `moeacgx/cloudssh:main` 创建 Pull Request。

除非维护者明确要求，不要在普通 PR 中修改版本号、创建发布标签或提交构建产物。

## 提交前检查

行为变更应增加或更新测试。先运行相关定向测试，提交 PR 前至少完成：

```sh
npm run type-check
npm run lint
npm run format:check
npm test
npm run test:skill
npm run build
```

如果改动涉及 Docker、Nginx、备份、恢复或 Release，还应运行对应脚本测试，并在 PR
中写明实际验证环境、结果和回滚方式。

## 工程与安全边界

- 复用现有 React、Tailwind、shadcn 和 Lucide 组件，不引入平行设计体系。
- 保持个人空间与团队项目隔离；任何项目级查询都不能把 `personal` 等前端哨兵值
  当作真实项目 ID 发送给后端。
- 密码、私钥、设备私钥、完整 Token 和根密钥不得进入 API 响应、日志、审计索引、
  录像索引或错误信息。
- 修改凭据加密、AAD、MFA、WebAuthn、设备签名、nonce 或租约逻辑时，必须覆盖失败
  路径、重放、越权和旧数据兼容测试。
- 数据库迁移必须保持 SQLite 回退边界，说明备份、恢复和回滚影响；不得静默删除或
  重写用户数据。
- 终端、SFTP、分屏和侧栏切换不得无故重新挂载 xterm 或关闭持续会话。
- Agent 接入继续使用设备码、网页审批和 Ed25519 签名；不要重新引入长期明文 Token、
  SSH 凭据下发或逐次审批。
- 容器内更新不得挂载 Docker Socket，也不要引入独立 updater sidecar。镜像更新由
  宿主机完成，二进制更新使用公开且不可变的 GitHub Release。

## Pull Request 要求

PR 描述应包含：

- 问题、方案和用户可见影响；
- 已执行的测试及结果；
- UI 改动的桌面与手机截图；
- 数据库、配置、权限或部署变更的兼容与回滚说明；
- 关联 Issue，以及需要同步更新的 README、Skill 或运维文档。

请保持改动聚焦，不要夹带无关重构、格式化全仓库或上游元数据变更。

## 问题与安全报告

普通缺陷和功能建议请使用
[CloudSSH Issues](https://github.com/moeacgx/cloudssh/issues)。安全漏洞不要公开提交
Issue，请按 [`SECURITY.md`](SECURITY.md) 使用 GitHub 私有安全公告。

提交贡献即表示你同意相关内容按仓库的 [Apache License 2.0](LICENSE) 发布，并保留
[`NOTICE-CLOUDSSH.md`](NOTICE-CLOUDSSH.md) 中的上游声明。
