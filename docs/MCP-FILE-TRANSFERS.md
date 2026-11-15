# MCP 二进制文件传输

`cloudssh_files_upload` 需要 `files:write`，`cloudssh_files_download` 需要 `files:read`。每次请求重新验证密钥、项目和主机授权；传输 ID 不能跨密钥或项目使用。

## 限制与重试

- 单文件最多 **64 MiB**；每块最多 **256 KiB 原始字节**，使用标准带填充的 Base64。请求保持在现有 1 MiB JSON 上限以内。
- 暂存使用私有临时目录，每密钥最多 4 个、服务全局最多 16 个传输，空闲 10 分钟过期。正常关闭会删除暂存文件；进程异常终止可能留下系统临时文件，交由主机临时目录清理策略回收。进程重启后传输 ID 不再有效。
- `TRANSFER_BUSY` 表示同一传输正在处理，稍后重试原请求。`TRANSFER_CAPACITY_EXCEEDED` 表示暂存配额已满，等待过期后重试。
- 审计只记录调用元数据，不保存文件正文、Base64、路径或校验和。上传块接收成功不等于远端文件已提交；只有最终提交才标记 `operationCommitted`。

## 上传

先在客户端计算整个文件的字节数和 SHA-256。所有分块复用同一个 `request_id`、`serverId`、`path`、`size`、小写 `sha256`：

```json
{
  "serverId": "server-1",
  "path": "/tmp/example.bin",
  "request_id": "unique-upload-id",
  "size": 3,
  "sha256": "ae4b3280e56e2faf83f414a6e3dabe9d5fbe18976544c05fed121accb85b53fc",
  "offset": 0,
  "dataBase64": "AAEC",
  "finalize": true
}
```

依次发送连续块，下一块 `offset` 使用返回的 `nextOffset`。最后一块设置 `finalize: true`，也可在所有块上传后发送空正文的 finalize 请求。返回 `complete: true` 才表示远端上传完成。空文件使用 `size: 0`、空字符串正文和空文件的 SHA-256。

重复的已接收字节可以重发；字节或元数据冲突会被拒绝。服务端完整校验后复用现有 SFTP 上传服务及其持久化幂等机制，临时文件写完后替换远端目标；**目标文件可能被覆盖**。

发生超时或未知结果，重试时保留原 `request_id` 和文件内容。暂存过期或进程重启后从 offset 0 重新上传，仍使用原 `request_id`，让底层服务判断已有提交；不要通过换 ID 绕过未知结果。

## 下载与本地保存

首次调用传 `serverId`、`path`、`offset: 0`，可设置 `length`（默认 256 KiB）。服务端先完成一次受限 SFTP 快照，再返回：

- `transferId`：后续请求必须带上；
- `dataBase64`、`offset`、`nextOffset`：当前块及下一块位置；
- `size`、`sha256`：整个快照的实际大小与校验和；
- `eof`：是否已读完，空文件第一次即为 true。

后续请求沿用相同主机、路径、transferId，以 nextOffset 继续。可以重读同一块，快照内容不变。过期后重新开始下载，不要把新旧快照拼接。

HTTP MCP 服务不能写客户端本地文件。客户端应解码并按 offset 组装，验证总字节数及 SHA-256 后再发布文件，默认不覆盖已有文件。以下 Node.js 示例接收已连接的 MCP SDK `client`：

```js
import { createHash, randomUUID } from "node:crypto";
import { open, link, unlink } from "node:fs/promises";

async function downloadToNewFile(client, serverId, remotePath, localPath) {
  const temporary = `${localPath}.${randomUUID()}.part`;
  const output = await open(temporary, "wx", 0o600);
  const hash = createHash("sha256");
  let offset = 0;
  let transferId;
  let expected;
  try {
    while (true) {
      const reply = await client.callTool({
        name: "cloudssh_files_download",
        arguments: {
          serverId,
          path: remotePath,
          offset,
          ...(transferId ? { transferId } : {}),
        },
      });
      if (reply.isError) throw new Error(JSON.stringify(reply.content));
      const part = JSON.parse(reply.content[0].text);
      const data = Buffer.from(part.dataBase64, "base64");
      expected ??= { size: part.size, sha256: part.sha256 };
      if (
        part.offset !== offset ||
        part.nextOffset !== offset + data.length ||
        part.size !== expected.size ||
        part.sha256 !== expected.sha256 ||
        (transferId && part.transferId !== transferId) ||
        (!part.eof && !data.length)
      ) {
        throw new Error("Inconsistent download chunk");
      }
      let written = 0;
      while (written < data.length) {
        const result = await output.write(
          data,
          written,
          data.length - written,
          offset + written,
        );
        if (!result.bytesWritten)
          throw new Error("Local write made no progress");
        written += result.bytesWritten;
      }
      hash.update(data);
      offset = part.nextOffset;
      transferId = part.transferId;
      if (part.eof) break;
    }
    if (offset !== expected.size || hash.digest("hex") !== expected.sha256) {
      throw new Error("Download integrity check failed");
    }
    await output.sync();
    await output.close();
    // Same-directory hard link publishes atomically and fails if localPath exists.
    // If the filesystem does not support links, fail rather than silently overwrite.
    await link(temporary, localPath);
  } finally {
    await output.close();
    await unlink(temporary);
  }
}
```
