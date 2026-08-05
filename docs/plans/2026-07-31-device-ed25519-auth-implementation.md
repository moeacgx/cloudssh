# CloudSSH 设备认证实施计划

## 交付目标

把 Agent 长期 Token 完整替换为“设备码 + 网页审批 + Ed25519 请求签名”。
一台设备只在首次接入时审批一次；审批后只要设备未撤销、未过期且私钥仍在，
所有 Agent 请求都自动签名，不再逐次弹出审批。

本计划只覆盖设备认证链路。个人空间隔离和文件夹快捷新增主机由各自计划实施，
避免并行修改同一文件。

## 第一阶段：数据库与领域模型

### 1. 增加设备认证表

修改：

- `src/backend/control-plane/schema-migration.ts`
- `src/backend/database/db/schema.ts`
- `src/backend/tests/control-plane/agent-device-migration.test.ts`

新增：

- `agent_devices`：设备 ID、名称、SPKI Ed25519 公钥、SHA-256 指纹、
  `pending/active/revoked` 状态、授权模式、权限范围、并发上限、有效期、审批人、
  最后使用时间和撤销时间。
- `agent_device_projects`：设备与已授权项目的关系，并为每个项目保存内部服务账号 ID。
- `agent_device_codes`：随机请求 ID、设备码摘要、公钥、设备名称、创建时间、过期时间、
  状态和尝试次数。数据库不保存明文设备码。
- `agent_request_nonces`：设备 ID、nonce、过期时间；以 `(device_id, nonce)` 唯一约束
  保证并发请求也不能重放。

迁移必须幂等。迁移完成时统一撤销全部旧 `agent_access_tokens`，保留原表和历史审计引用，
但旧 Token 永远不能再参与 Agent 鉴权。

测试先覆盖：新库建表、旧库升级、重复执行迁移、旧 Token 撤销、设备项目外键和 nonce
唯一约束。单次测试最长 60 秒。

### 2. 定义设备主体

修改：

- `src/backend/agent/types.ts`
- `src/backend/agent/audit.ts`

将运行时主体从 Token 身份改为设备身份，保留现有项目、服务器、scope 和并发字段，
新增 `deviceId`、设备名称与指纹。审计事件新增可空的 `device_id`，新事件不再写入
`token_id`；历史 Token 审计仍可查询。

## 第二阶段：注册、审批与签名鉴权

### 3. 实现首次设备注册

新增：

- `src/backend/agent/device-registration.ts`
- `src/backend/agent/device-registration.test.ts`

公开端点：

- `POST /agent/v1/auth/device-requests`：接收设备名称和 Ed25519 SPKI 公钥，返回一次性的
  明文设备码、随机请求 ID、公钥指纹、过期时间和建议轮询间隔。
- `GET /agent/v1/auth/device-requests/:requestId`：由待审批私钥签名轮询，仅返回
  `pending/approved/denied/expired`；批准时返回正式设备 ID。

设备码使用足够熵的随机值、短期有效、单次消费，并按来源地址、公钥指纹和请求 ID
限速。待审批请求不得访问服务器、项目或用户资料。轮询必须证明持有对应私钥，不能只凭
请求 ID 获取批准结果。

测试覆盖无效公钥、非 Ed25519 公钥、相同设备码摘要冲突、过期、重复消费、错误指纹、
轮询签名错误和错误响应不泄露注册信息。

### 4. 实现网页审批和设备管理

新增或替换：

- `src/backend/agent/device-admin.ts`
- `src/backend/agent/device-admin.test.ts`
- `src/backend/agent/index.ts`

认证端点：

- `POST /agent/admin/v1/device-requests/resolve`：管理员输入设备码后查看设备名和指纹。
- `POST /agent/admin/v1/device-requests/:requestId/approve`：选择全部可管理项目或多选项目、
  scope、并发限制和有效期后批准。
- `POST /agent/admin/v1/device-requests/:requestId/deny`：拒绝请求。
- `GET /agent/admin/v1/devices`：列出待审批和已授权设备。
- `PATCH /agent/admin/v1/devices/:deviceId`：仅允许改设备名称和授权配置。
- `DELETE /agent/admin/v1/devices/:deviceId`：立即撤销设备。

审批事务内为每个授权项目建立内部服务账号和设备项目关系。`all` 模式只覆盖审批人当前
及后续仍有管理权的项目；审批人失去项目管理权时设备动态失权。指定项目模式取授权集合
与审批人当前可管理项目的交集，绝不因迁移或查询扩大权限。

设备码查询、批准、拒绝、改权和撤销全部写审计。并发批准只能有一个成功，且批准后
不创建 Token。

### 5. 替换 Agent 业务接口鉴权

修改：

- `src/backend/agent/auth.ts`
- `src/backend/agent/routes.ts`
- `src/backend/agent/agent-api.test.ts`

签名请求头固定为：

- `X-CloudSSH-Device-ID`
- `X-CloudSSH-Timestamp`
- `X-CloudSSH-Nonce`
- `X-CloudSSH-Body-SHA256`
- `X-CloudSSH-Signature`

签名规范串：

```text
cloudssh-device-v1
<大写 HTTP 方法>
<规范化路径和查询>
<Unix 毫秒时间戳>
<base64url nonce>
<小写十六进制正文 SHA-256>
```

服务端在 JSON 解析前保留请求正文原始字节，校验头中哈希与原始正文一致；空正文使用
空字节 SHA-256。路径只使用反向代理传给应用的原始路径，查询参数按客户端实际发送顺序
签名，避免客户端与服务端二次排序产生差异。

验证顺序为：头格式、时间窗口、设备状态与有效期、正文哈希、Ed25519 签名、nonce
唯一写入、scope、项目和并发限制。nonce 在验签成功后以唯一事务写入，业务请求即使失败
也不得复用。定时清理过期 nonce，不允许仅用内存保存。

携带 `Authorization: Bearer` 的旧 Skill 返回稳定错误码 `TOKEN_AUTH_REMOVED` 和升级提示；
不得兼容或自动换发设备身份。

测试覆盖方法、路径、查询、正文任一处被篡改，时间过早/过晚，nonce 重放与并发重放，
设备撤销、过期、动态项目失权，以及正确请求保持现有 Job 和持久会话行为。

## 第三阶段：Skill 无 Token 登录

### 6. 重构本机安全身份

修改：

- `skills/cloudssh-agent/scripts/cloudssh.mjs`
- `scripts/cloudssh-skill.test.mjs`
- `skills/cloudssh-agent/SKILL.md`

`auth login --url <https-url>` 的新流程：

1. 本机生成 Ed25519 密钥对。
2. 私钥以 PKCS#8 形式只写入 Windows DPAPI、macOS Keychain 或 Linux Secret Service；
   安全存储不可用时停止，不回退到明文文件。
3. `profile.json` 只保存平台 URL、正式设备 ID、公钥和指纹，不保存私钥、Token 或设备码。
4. 向平台提交公钥和设备名称，终端显示设备码、设备名和指纹，并自动轮询审批。
5. 批准后保存设备 ID，随后用私钥为每个请求签名。

网络请求必须先确定最终 URL 和精确 JSON 字节，再计算正文哈希和签名。每次请求生成新的
随机 nonce 和时间戳；重试必须重新签名，幂等写仍复用同一个 `Idempotency-Key`。

`auth status` 显示已配置、设备 ID、指纹和是否已批准，不读取或打印私钥。`auth logout`
删除本地私钥、设备资料和会话附件状态，但不隐式撤销服务器端设备；服务端撤销只能从网页
设备管理执行。

删除 `--token` 参数、隐藏 Token 输入、Token 脱敏分支和旧的 `agent-token.dpapi` 新写入
逻辑。升级检测到旧 Token 文件时不读取明文内容，只提示重新执行设备登录；登录成功后
删除旧安全存储项。

跨进程测试覆盖：首次生成、轮询批准、第二进程复用同一私钥、签名可验证、每次 nonce
不同、正文稳定、注销清除、私钥丢失后要求重新审批，以及任何输出都不出现私钥。

## 第四阶段：网页 Agent 接入界面

### 7. 用设备审批替换 Token 管理

修改：

- `src/ui/api/agent-admin-api.ts`
- `src/ui/sidebar/AgentIntegrationPanel.tsx`
- `src/ui/tests/api/agent-admin-api.test.ts`
- `src/ui/tests/sidebar/AgentIntegrationPanel.test.tsx`
- `src/ui/locales/en.json`
- `src/ui/locales/translated/zh_CN.json`

界面只保留三块：

1. “批准新设备”：输入设备码，核对设备名与指纹，选择项目、scope、并发和有效期后批准。
2. “已授权设备”：显示设备名、指纹末段、项目范围、上次使用、到期时间、状态；支持改名、
   改权和撤销。
3. “安装与登录”：展示不含任何 Token 的 Skill 地址与 `auth login --url ...` 命令。

彻底删除创建 Token、一次性 Token 弹窗、复制带 Token 命令、服务账号和服务器白名单文案。
审批成功后列表立即刷新。撤销和收窄权限需要明确二次确认。

UI 测试覆盖设备码解析、审批表单校验、全部/多选项目、批准、拒绝、改权、撤销、空列表、
错误提示，以及页面中不存在 Token 创建入口。

## 第五阶段：迁移、安全与交付

### 8. 安全回归

执行以下验证，每条命令单次最长 60 秒：

- 设备注册、审批、签名鉴权和 Agent API 定向测试。
- Skill 纯 Node.js 跨进程测试。
- UI API 与 Agent 接入面板测试。
- 全量 Vitest、类型检查、Lint、格式检查和正式构建。
- 日志与错误响应扫描：不得出现私钥、完整公钥原文、设备码明文、完整签名、旧 Token、
  SSH 密码或 SSH 私钥。
- 重启恢复测试：平台重启后已批准设备仍可签名访问，已使用 nonce 仍不能重放。

### 9. 版本与部署门禁

版本升为 `2.6.0-cloudssh.12`。测试通过后提交并推送 GitHub，但不自动部署生产。

生产部署前必须再次获得明确确认，并完成：

1. 新建数据库和数据卷备份。
2. 校验 SHA-256。
3. 在隔离卷实际恢复并启动验证。
4. 部署新镜像并检查健康状态、网页登录和现有 SSH 主机数据。
5. 用真实 Skill 完成一次设备码审批、服务器列表、Job 和持久会话实战。
6. 确认旧 Token 返回 `TOKEN_AUTH_REMOVED`，且 Vaultwarden、HiveChat、Guacamole 容器未受影响。

任何迁移或实战失败都停止切换，不删除原卷或备份。
