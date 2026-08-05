---
name: cloudssh-agent
description: 通过自带的零 npm 依赖脚本和已审批的 Ed25519 设备身份直接管理 CloudSSH 中已授权项目的主机、快速连接、结构化命令任务、持久 SSH 会话和 SFTP 文件，无需 MCP、Token、仓库克隆或项目构建。用于按项目和分类创建主机、查找服务器、发起临时连接、执行带退出码和超时的远程命令，管理持续会话，以及列出、读取、上传、下载、创建目录、移动和删除远程文件；不得用于获取、展示、复制或传递已有 SSH 凭据和设备私钥。
---

# CloudSSH Agent

只调用本 Skill 自带的 `scripts/cloudssh.mjs`。不要要求 MCP，也不要临时拼接 `curl` 请求。

脚本需要 Agent 主机提供 Node.js 20 或更高版本，但不需要安装任何 npm 包。

## 调用方式

1. 确定本 `SKILL.md` 所在目录，使用绝对路径调用同目录下的脚本：

   ```text
   node <skill目录>/scripts/cloudssh.mjs <命令>
   ```

2. 首次使用先运行 `auth status`。若尚未登录，让用户在自己的交互式终端运行：

   ```text
   node <skill目录>/scripts/cloudssh.mjs auth login --url https://ssh.example.com
   ```

   脚本会在本机生成 Ed25519 设备私钥，写入系统安全存储，并显示一次性设备码、
   设备名称和公钥指纹。让用户在 CloudSSH 网页“Agent 接入”中核对信息并批准。
   一台设备首次批准一次即可，后续请求自动签名，不会逐次弹出审批。

   网页审批时可以授权用户有权管理的全部项目，也可以多选指定项目。每个已授权
   项目内的所有服务器都会自动可见。不创建、不输入也不保存平台 Token。创建
   主机和快速连接还需要网页为设备分别授予“创建主机”和“快速连接”权限；只读
   设备不能借助 Skill 绕过这些权限。

3. 先运行 `servers list`；结果包含项目名、完整服务器名、跨项目稳定的 `hostId`
   和项目入口 `serverId`，以及已授权范围内的 `address`、`port`、`folder`、
   `tags`。这些是连接定位和资产标记信息，不包含用户名、密码、私钥或其他认证
   材料。同一主机分享至多个项目时，各条记录的 `hostId` 相同而 `serverId` 不同；
   必须把它们识别为同一台底层主机的多个项目入口，不能当作多台独立服务器。
   执行命令、会话和文件操作时仍使用目标项目那条记录的 `serverId`。
   只按完整名称精确匹配服务器，不要模糊选择。若没有匹配则停止并报告；若存在
   同名服务器，必须同时展示“项目名 + 完整服务器名”，让用户确认目标后再使用
   对应的 `serverId`。不要要求用户猜测内部 ID，也不要询问 IP、SSH 用户名、
   密码或私钥。

平台地址必须使用 HTTPS；只有 `localhost`、`127.0.0.1` 和 `::1` 允许 HTTP。本地测试可先建立 SSH 隧道，再把 `http://127.0.0.1:<端口>` 作为平台地址。

## 项目、分类与主机

先列出设备已获授权的项目，再读取目标项目的分类。始终使用列表返回的完整项目
ID 和分类路径，不要凭名称猜测内部 ID。

```text
node <脚本> projects list
node <脚本> folders list --project <projectId>
node <脚本> credentials list --project <projectId>
node <脚本> servers create --project <projectId> --folder "生产 / 数据库" --name db-01 --address 203.0.113.10 --port 22 --username root --auth-type credential --credential-id <credentialId>
```

- `--folder` 可省略，表示放在项目根目录；提供时可以使用 `folders list` 返回的
  完整路径，也可以明确给出要新建的分类路径。`--tags` 接受逗号分隔标签。
- 已保存在平台中的凭据优先使用 `--auth-type credential --credential-id <ID>`。
  Skill 不会读取该凭据的密码或私钥，服务端只在建立 SSH 连接时解密。
- 不使用 `--auth-type agent`。网页 SSH Agent 依赖浏览器所在设备，CloudSSH
  后台无法借用该设备的本地 Agent，因此这种主机不能供 Skill 持续连接。
- 如果必须导入本机已有的密码或私钥，只允许把文件路径传给 `--password-file`、
  `--key-file` 或 `--key-password-file`。脚本在内存中读取并通过 HTTPS 发送，
  不打印内容，也不写入待确认请求文件。不要先用其他命令读取文件内容，不要让
  用户把密码或私钥粘贴进对话；不得使用已禁用的 `--password`、`--key`、
  `--key-password` 参数。
- 创建完成后重新运行 `servers list`，使用服务端返回的 `serverId` 执行任务或
  创建持续会话。

## SFTP 文件管理

文件命令直接复用平台后端的 SFTP 凭据解析和连接链路。设备审批时分别授予：

- `files:read`：列出目录、读取文本文件、下载文件。
- `files:write`：上传文件、创建目录、重命名/移动和删除文件或目录。

设备只拥有其中一个权限时，脚本会由服务端拒绝另一类操作；不能通过 Skill
绕过项目或服务器授权。所有上传、下载操作只接收本机文件路径，文件内容由脚本
在本地读取或写入，并通过加密连接传输，不会打印到 Agent 对话、命令参数、待
确认请求或审计正文中。上传和下载默认限制为 64 MiB；下载不会覆盖已有本地
文件，确认覆盖时显式增加 `--force`。

```text
files list --server <serverId> [--path <远程目录>]
files read --server <serverId> --path <远程文件>
files upload --server <serverId> --path <远程文件> --local-path <本地文件>
files download --server <serverId> --path <远程文件> --local-path <本地文件> [--force]
files mkdir --server <serverId> --path <远程目录> [--recursive]
files rename --server <serverId> --source-path <原路径> --destination-path <新路径>
files delete --server <serverId> --path <远程路径> [--recursive]
```

`files read` 只适合读取必要的小型文本配置；服务端会限制返回大小并标记是否
截断。不要用它读取私钥、密码库、完整日志或其他不必要的敏感文件。删除、递归
删除和覆盖下载属于高风险操作，执行前确认用户的明确意图。平台会把每次上传、
创建目录、重命名/移动和删除写入 Agent 审计记录（含项目、服务器、设备和结果，
不含文件正文）。

## 快速连接

快速连接只建立带自动过期时间的临时项目主机。到期且没有关联会话、录像或固定
窗口后会自动清理；仍需保留会话记录时会延后清理。它必须绑定一个已授权项目用于
权限和审计，认证参数与
`servers create` 相同，并必须提供已核对的 SSH Host Key 十六进制指纹：

```text
node <脚本> quick-connect create --project <projectId> --address 203.0.113.10 --port 22 --username root --auth-type credential --credential-id <credentialId> --host-key-fingerprint <fingerprint>
```

使用返回的临时 `serverId` 创建任务或会话。需要长期保留、分类展示或后续从主机
列表进入时，应改用 `servers create`。不得自行信任临时探测到的未知指纹；若没有
可信指纹，先由用户在网页终端核对并保存主机指纹。

## 选择执行方式

- 单条非交互命令使用 `jobs run`，它会等待终态并返回标准输出、标准错误和退出码。
- 需要交互、多轮操作或长期运行的任务使用持久会话。
- 只读排障优先以 `read-only` 附着；确实需要输入时才申请 `read-write` 租约。

## 结构化任务

```text
node <脚本> jobs run --server <serverId> --command "<完整命令>" --timeout-ms 30000
node <脚本> jobs list
node <脚本> jobs status --job <jobId>
node <脚本> jobs cancel --job <jobId>
```

汇总最终状态、退出码和必要输出。输出可能含业务敏感信息时只摘录与结论相关的部分。

## 持久会话

```text
node <脚本> sessions create --server <serverId> --mode platform --cols 120 --rows 30
node <脚本> sessions list
node <脚本> sessions attach --session <sessionId> --mode read-write
node <脚本> sessions send --session <sessionId> --command <命令>
node <脚本> sessions read --session <sessionId>
node <脚本> sessions detach --session <sessionId>
```

- `platform` 是默认模式。CloudSSH 后端直接持有原生 SSH PTY，目标机不需要
  安装 `tmux`；网页可以进入 Agent 正在使用的同一会话。浏览器、Agent 或脚本
  退出不会关闭它，但 CloudSSH 容器重启、升级或底层 SSH 断线后不能恢复。
- `tmux` 使用目标机的远端持久窗口，需要目标机安装 `tmux`，但 CloudSSH 重启
  后仍可重新附着。只增加 `--pinned` 而未明确 `--mode` 时会自动选择 `tmux`。
- `--mode platform --pinned` 允许平台进程内长期保留；它不受无人附着 24 小时
  清理限制，但仍不能跨 CloudSSH 重启。不要把它误当作远端可恢复窗口。
- 脚本在系统用户私有目录保存最近的附件、写入租约和输出游标，因此后续 Agent 调用可继续同一会话。
- `sessions read` 默认从已保存游标继续读取；只有确需回看当前缓冲区时使用 `--from-start`。
- 普通会话无人附着 24 小时后会被清理。需要跨平台重启恢复的长任务使用
  `--mode tmux --pinned`；使用前确认目标机已安装 `tmux`。
- 写入租约过期时重新 `attach --mode read-write`。若上一次写入结果不确定，先读取输出和会话状态，不要直接重放命令。
- 遇到 `NETWORK_ERROR` 或 `RESPONSE_UNCERTAIN` 时，使用完全相同的参数重新执行原命令。脚本会跨进程复用待确认请求的幂等键和请求 ID，同时为每次请求生成新的签名；不要为了重试修改参数。
- 遇到 `WRITE_LEASE_HELD` 时报告冲突。只有用户明确要求接管才增加 `--takeover`。
- 工作完成默认 `detach`，让所选运行时继续工作。只有用户明确要求终止远端任务时才调用 `sessions close`。

## 安全规则

- 把 `--takeover`、`sessions close` 以及修改或删除远端数据的命令视为高风险操作，执行前确认用户意图。
- 除本脚本为认证和续接会话所需的内部访问外，不直接读取 CloudSSH 配置目录或系统钥匙串；不读取平台数据库、SSH 密码或私钥。
- 不导出服务器凭据。服务端负责解密凭据并建立 SSH 连接。
- 只读取已有平台凭据的 ID、名称、用户名和认证类型，不读取其密码、私钥或口令。
  创建主机所需的本地敏感文件只能由本 Skill 脚本内部读取；不得通过 shell、文件
  工具或模型上下文查看其内容。
- `--password-file`、`--key-file` 和 `--key-password-file` 只能使用用户明确提供或
  当次确认的路径。不得扫描 `.ssh`、系统凭据目录或工作区猜测可用密钥。
- Ed25519 设备私钥只存在于 Windows DPAPI、macOS Keychain 或 Linux Secret Service；安全存储不可用时停止，不回退到明文文件。
- 不读取、导出或展示设备私钥。设备被撤销、过期、私钥丢失、换设备或轮换密钥时，才重新执行首次审批。
- 所有创建、附着和写入请求由脚本自动管理幂等键。结果不确定的请求只在本机私有目录保存操作路径、由设备私钥派生密钥保护的正文校验值、请求 ID、幂等键和有效期，不保存正文哈希、命令正文、SSH 凭据或设备私钥；成功或明确业务错误后自动清理。
- 待确认请求默认保留 7 天且最多 256 条。达到上限时先核对已有 Job 和会话结果，不要绕过保护重复执行远程操作。
- 浏览器、Agent 或脚本进程结束都不会关闭远端持久会话。
