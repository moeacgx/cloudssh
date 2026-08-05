import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  CloudSshApiError,
  CloudSshClient,
  commitDeviceIdentity,
  DeviceKeyCleanupStore,
  LinuxSecretServiceStore,
  loadDeviceProfile,
  MacOsKeychainSecretStore,
  PendingRequestStore,
  ProfileStore,
  readLimitedResponseBuffer,
  readTransferFile,
  SessionStateStore,
  WindowsDpapiSecretStore,
  withFileLock,
  writeTransferFile,
  normalizeBaseUrl,
  resolveSessionRuntimeMode,
} from "../skills/cloudssh-agent/scripts/cloudssh.mjs";

const execFileAsync = promisify(execFile);
const skillScript = path.resolve("skills/cloudssh-agent/scripts/cloudssh.mjs");

class MemorySecretStore {
  constructor(value) {
    this.value = value;
  }
  async get() {
    return this.value;
  }
}

class MemoryKeySlotStore {
  constructor(entries = []) {
    this.values = new Map(entries);
    this.failedDeletes = new Set();
  }

  async get(keyId) {
    return this.values.get(keyId) ?? null;
  }

  async set(value, keyId) {
    this.values.set(keyId, value);
  }

  async delete(keyId) {
    if (this.failedDeletes.has(keyId)) throw new Error("delete failed");
    this.values.delete(keyId);
  }
}

function testIdentity() {
  const { privateKey } = generateKeyPairSync("ed25519");
  return {
    deviceId: "device-test",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function pendingRequestInput(
  fingerprintCharacter,
  requestHashCharacter,
  resource,
) {
  return {
    fingerprint: fingerprintCharacter.repeat(64),
    deviceId: "device-test",
    method: "POST",
    resource,
    requestProof: requestHashCharacter.repeat(64),
    proofKey: Buffer.alloc(32, requestHashCharacter).toString("base64url"),
  };
}

test("Skill 地址仅允许 HTTPS 和本机 HTTP", () => {
  assert.equal(
    normalizeBaseUrl("https://ssh.example.com/"),
    "https://ssh.example.com/agent/v1",
  );
  assert.equal(
    normalizeBaseUrl("http://127.0.0.1:18081"),
    "http://127.0.0.1:18081/agent/v1",
  );
  assert.throws(() => normalizeBaseUrl("http://203.0.113.10:18080"), /HTTPS/);
});

test("持续会话默认使用平台中转，固定会话兼容 tmux 默认值", () => {
  assert.equal(resolveSessionRuntimeMode({}, false), "platform");
  assert.equal(resolveSessionRuntimeMode({ pinned: true }, true), "tmux");
  assert.equal(
    resolveSessionRuntimeMode({ mode: "platform", pinned: true }, true),
    "platform",
  );
  assert.equal(resolveSessionRuntimeMode({ mode: "tmux" }, false), "tmux");
  assert.throws(
    () => resolveSessionRuntimeMode({ mode: "screen" }, false),
    /platform 或 tmux/,
  );
});

test("Skill 客户端使用设备签名列出服务器并为写请求生成幂等键", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cloudssh-skill-client-request-"),
  );
  const identity = testIdentity();
  let idempotencyKey = "";
  try {
    const pendingRequests = new PendingRequestStore(directory);
    const client = new CloudSshClient(
      "https://ssh.example.com",
      new MemorySecretStore(identity),
      async (url, init) => {
        const headers = new Headers(init.headers);
        assert.equal(headers.get("authorization"), null);
        assert.equal(headers.get("x-cloudssh-device-id"), identity.deviceId);
        assert.match(headers.get("x-cloudssh-signature"), /^[A-Za-z0-9_-]+$/);
        assert.match(headers.get("x-cloudssh-nonce"), /^[A-Za-z0-9_-]{16,}$/);
        if (url.pathname.endsWith("/servers")) {
          return new Response(
            JSON.stringify({
              servers: [
                {
                  hostId: 7,
                  serverId: "11",
                  name: "Production",
                  connectionType: "ssh",
                  projectId: "project-1",
                  projectName: "Personal",
                  password: "SERVER_PASSWORD_MUST_NOT_LEAK",
                  privateKey: "SERVER_KEY_MUST_NOT_LEAK",
                  credential: { password: "nested-secret" },
                },
                {
                  hostId: 7,
                  serverId: "22",
                  name: "Production shared",
                  connectionType: "ssh",
                  projectId: "project-2",
                  projectName: "Team",
                  username: "SSH_USERNAME_MUST_NOT_LEAK",
                },
              ],
            }),
          );
        }
        idempotencyKey = headers.get("idempotency-key") ?? "";
        return new Response(JSON.stringify({ job: { id: "job-1" } }), {
          status: 202,
        });
      },
      pendingRequests,
    );
    assert.deepEqual(await client.listServers(), [
      {
        hostId: 7,
        serverId: "11",
        name: "Production",
        connectionType: "ssh",
        projectId: "project-1",
        projectName: "Personal",
      },
      {
        hostId: 7,
        serverId: "22",
        name: "Production shared",
        connectionType: "ssh",
        projectId: "project-2",
        projectName: "Team",
      },
    ]);
    assert.equal(
      (await client.createJob({ serverId: "11", command: "uname -a" })).id,
      "job-1",
    );
    assert.match(idempotencyKey, /^[0-9a-f-]{36}$/);
    assert.deepEqual((await pendingRequests.read()).requests, {});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Skill 文件命令使用签名 SFTP API 并以二进制传输文件", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cloudssh-skill-files-"),
  );
  const identity = testIdentity();
  const upload = Buffer.from([0, 1, 2, 255]);
  const calls = [];
  try {
    const client = new CloudSshClient(
      "https://ssh.example.com",
      new MemorySecretStore(identity),
      async (url, init) => {
        const headers = new Headers(init.headers);
        calls.push({
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          method: init.method,
          contentType: headers.get("content-type"),
          idempotencyKey: headers.get("idempotency-key"),
          body: init.body,
        });
        if (url.pathname.endsWith("/files/list")) {
          return new Response(
            JSON.stringify({ path: "/etc", files: [{ name: "hosts" }] }),
          );
        }
        if (url.pathname.endsWith("/files/read")) {
          return new Response(
            JSON.stringify({
              path: "/etc/hosts",
              content: "127.0.0.1 localhost",
              encoding: "utf8",
              size: 19,
              truncated: false,
            }),
          );
        }
        if (url.pathname.endsWith("/files/download")) {
          return new Response(Buffer.from([9, 8, 7]), {
            headers: { "content-type": "application/octet-stream" },
          });
        }
        if (url.pathname.endsWith("/files/upload")) {
          assert.ok(Buffer.isBuffer(init.body));
          assert.deepEqual(init.body, upload);
          return new Response(
            JSON.stringify({
              file: {
                serverId: "11",
                path: "/tmp/input.bin",
                size: 4,
                content: "UPLOAD_CONTENT_MUST_NOT_LEAK",
                password: "UPLOAD_PASSWORD_MUST_NOT_LEAK",
              },
            }),
            { status: 201 },
          );
        }
        if (url.pathname.endsWith("/files/mkdir")) {
          return new Response(
            JSON.stringify({ directory: { serverId: "11", path: "/tmp/a" } }),
            { status: 201 },
          );
        }
        return new Response(
          JSON.stringify({ file: { serverId: "11", path: "/tmp/a" } }),
        );
      },
      new PendingRequestStore(directory),
    );

    assert.equal((await client.listFiles("11", "/etc")).files[0].name, "hosts");
    assert.equal(
      (await client.readRemoteFile("11", "/etc/hosts")).encoding,
      "utf8",
    );
    assert.deepEqual(
      await client.downloadFile("11", "/tmp/output.bin"),
      Buffer.from([9, 8, 7]),
    );
    assert.deepEqual(await client.uploadFile("11", "/tmp/input.bin", upload), {
      serverId: "11",
      path: "/tmp/input.bin",
      size: 4,
    });
    await client.makeDirectory("11", "/tmp/a", true);
    await client.renameFile("11", "/tmp/a", "/tmp/b");
    await client.deleteFile("11", "/tmp/b", true);

    const uploadCall = calls.find((call) =>
      call.path.endsWith("/files/upload"),
    );
    assert.deepEqual(uploadCall.query, {
      serverId: "11",
      path: "/tmp/input.bin",
    });
    assert.equal(uploadCall.contentType, "application/octet-stream");
    assert.match(uploadCall.idempotencyKey, /^[0-9a-f-]{36}$/);
    for (const call of calls.filter((entry) => entry.method === "POST")) {
      assert.match(call.idempotencyKey, /^[0-9a-f-]{36}$/);
    }
    assert.deepEqual(
      (await new PendingRequestStore(directory).read()).requests,
      {},
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Skill 下载在有无 Content-Length 时都执行字节硬上限", async () => {
  const identity = testIdentity();
  const declaredTooLarge = new CloudSshClient(
    "https://ssh.example.com",
    new MemorySecretStore(identity),
    async () =>
      new Response(new Uint8Array(), {
        headers: { "content-length": String(64 * 1024 * 1024 + 1) },
      }),
  );
  await assert.rejects(
    declaredTooLarge.downloadFile("11", "/tmp/large.bin"),
    (error) =>
      error instanceof CloudSshApiError && error.code === "FILE_TOO_LARGE",
  );

  const streamed = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2, 3]));
        controller.enqueue(Uint8Array.from([4, 5]));
        controller.close();
      },
    }),
  );
  await assert.rejects(
    readLimitedResponseBuffer(streamed, 4),
    (error) =>
      error instanceof CloudSshApiError && error.code === "FILE_TOO_LARGE",
  );
});

test("Skill 上传只读取同一普通文件句柄并拒绝符号链接和超限文件", async (context) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cloudssh-skill-upload-input-"),
  );
  const source = path.join(directory, "source.bin");
  const linkPath = path.join(directory, "source-link.bin");
  const oversized = path.join(directory, "oversized.bin");
  try {
    await writeFile(source, Buffer.from("safe-content"));
    assert.deepEqual(
      (await readTransferFile(source)).data,
      Buffer.from("safe-content"),
    );

    try {
      await symlink(source, linkPath, "file");
      await assert.rejects(readTransferFile(linkPath), /普通文件/);
    } catch (error) {
      if (error?.code === "EPERM") {
        context.diagnostic("当前 Windows 环境不允许创建文件符号链接");
      } else {
        throw error;
      }
    }

    await writeFile(oversized, Buffer.alloc(0));
    await truncate(oversized, 64 * 1024 * 1024 + 1);
    await assert.rejects(readTransferFile(oversized), /64 MiB/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Skill 并发下载在未使用 force 时只允许一个原子提交", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cloudssh-skill-download-race-"),
  );
  const target = path.join(directory, "result.bin");
  try {
    const results = await Promise.allSettled([
      writeTransferFile(target, Buffer.from("first")),
      writeTransferFile(target, Buffer.from("second")),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const rejected = results.find((result) => result.status === "rejected");
    assert.match(rejected.reason.message, /目标文件已存在/);
    assert.ok(["first", "second"].includes(await readFile(target, "utf8")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Skill 客户端可按项目列出分类、创建主机和快速连接", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cloudssh-skill-host-create-"),
  );
  const identity = testIdentity();
  const calls = [];
  try {
    const client = new CloudSshClient(
      "https://ssh.example.com",
      new MemorySecretStore(identity),
      async (url, init) => {
        const headers = new Headers(init.headers);
        const body = init.body ? JSON.parse(init.body) : null;
        calls.push({ path: url.pathname, method: init.method, headers, body });
        if (url.pathname.endsWith("/projects")) {
          return new Response(
            JSON.stringify({
              projects: [{ id: "project-1", name: "生产", kind: "team" }],
            }),
          );
        }
        if (url.pathname.endsWith("/projects/project-1/folders")) {
          return new Response(
            JSON.stringify({ folders: [{ path: "生产 / 数据库" }] }),
          );
        }
        if (url.pathname.endsWith("/quick-connections")) {
          return new Response(
            JSON.stringify({ connection: { sessionId: "session-quick" } }),
            { status: 201 },
          );
        }
        return new Response(
          JSON.stringify({
            server: { serverId: "server-1", name: "db-01" },
          }),
          { status: 201 },
        );
      },
      new PendingRequestStore(directory),
    );

    assert.deepEqual(await client.listProjects(), [
      { id: "project-1", name: "生产", kind: "team" },
    ]);
    assert.deepEqual(await client.listProjectFolders("project-1"), [
      { path: "生产 / 数据库" },
    ]);
    assert.equal(
      (
        await client.createServer({
          projectId: "project-1",
          folder: "生产 / 数据库",
          name: "db-01",
          address: "203.0.113.10",
          port: 22,
          username: "root",
          authType: "credential",
          credentialId: 42,
        })
      ).serverId,
      "server-1",
    );
    assert.equal(
      (
        await client.createQuickConnection({
          projectId: "project-1",
          address: "203.0.113.11",
          port: 22,
          username: "root",
          authType: "credential",
          credentialId: 42,
        })
      ).sessionId,
      "session-quick",
    );

    assert.deepEqual(
      calls.map(({ path, method }) => ({ path, method })),
      [
        { path: "/agent/v1/projects", method: "GET" },
        {
          path: "/agent/v1/projects/project-1/folders",
          method: "GET",
        },
        { path: "/agent/v1/servers", method: "POST" },
        { path: "/agent/v1/quick-connections", method: "POST" },
      ],
    );
    for (const call of calls.slice(2)) {
      assert.match(call.headers.get("idempotency-key"), /^[0-9a-f-]{36}$/);
      assert.equal(call.body.projectId, "project-1");
      assert.equal(call.body.credentialId, 42);
    }
    assert.deepEqual(
      (await new PendingRequestStore(directory).read()).requests,
      {},
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Skill 创建主机结果不确定时只保存设备密钥保护的校验值", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cloudssh-skill-host-secret-"),
  );
  const password = "do-not-persist-host-password";
  const identity = testIdentity();
  const input = {
    projectId: "project-1",
    address: "203.0.113.10",
    port: 22,
    username: "root",
    authType: "password",
    password,
  };
  try {
    const client = new CloudSshClient(
      "https://ssh.example.com",
      new MemorySecretStore(identity),
      async () => {
        throw new Error("connection reset after request");
      },
      new PendingRequestStore(directory),
    );
    await assert.rejects(
      client.createServer(input),
      (error) => error.code === "NETWORK_ERROR",
    );
    const persisted = await readFile(
      path.join(directory, "pending-requests.json"),
      "utf8",
    );
    assert.equal(persisted.includes(password), false);
    assert.equal(persisted.includes('"password"'), false);
    const bodyHash = createHash("sha256")
      .update(JSON.stringify(input), "utf8")
      .digest("hex");
    assert.equal(persisted.includes(bodyHash), false);
    const state = JSON.parse(persisted);
    assert.equal(state.version, 2);
    const record = Object.values(state.requests)[0];
    assert.match(record.requestProof, /^[a-f0-9]{64}$/);
    assert.equal("requestHash" in record, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Skill 在附着响应丢失后复用操作标识并重新签名", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cloudssh-skill-attach-retry-"),
  );
  const identity = testIdentity();
  const attempts = [];
  try {
    const client = new CloudSshClient(
      "https://ssh.example.com",
      new MemorySecretStore(identity),
      async (_url, init) => {
        const headers = new Headers(init.headers);
        attempts.push({
          idempotencyKey: headers.get("idempotency-key"),
          requestId: headers.get("x-request-id"),
          nonce: headers.get("x-cloudssh-nonce"),
          timestamp: headers.get("x-cloudssh-timestamp"),
          signature: headers.get("x-cloudssh-signature"),
        });
        if (attempts.length === 1) {
          return {
            ok: true,
            status: 200,
            text: async () => {
              throw new Error("response body lost");
            },
          };
        }
        return new Response(
          JSON.stringify({
            attachmentId: "attachment-1",
            lease: { id: "lease-1" },
          }),
        );
      },
      new PendingRequestStore(directory),
    );

    const result = await client.attachSession("session-1", "read-write");

    assert.equal(result.attachmentId, "attachment-1");
    assert.equal(attempts.length, 2);
    assert.match(attempts[0].idempotencyKey, /^[0-9a-f-]{36}$/);
    assert.equal(attempts[1].idempotencyKey, attempts[0].idempotencyKey);
    assert.equal(attempts[1].requestId, attempts[0].requestId);
    assert.notEqual(attempts[1].nonce, attempts[0].nonce);
    assert.notEqual(attempts[1].timestamp, attempts[0].timestamp);
    assert.notEqual(attempts[1].signature, attempts[0].signature);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("结果不确定请求跨客户端实例复用且不保存命令正文", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cloudssh-skill-pending-reuse-"),
  );
  const identity = testIdentity();
  const jobInput = {
    serverId: "server-1",
    command: "printf do-not-persist-this-command",
    timeoutMs: 30_000,
  };
  const firstAttempts = [];
  try {
    const firstClient = new CloudSshClient(
      "https://ssh.example.com",
      new MemorySecretStore(identity),
      async (_url, init) => {
        const headers = new Headers(init.headers);
        firstAttempts.push({
          idempotencyKey: headers.get("idempotency-key"),
          requestId: headers.get("x-request-id"),
          nonce: headers.get("x-cloudssh-nonce"),
        });
        throw new Error("connection reset after request");
      },
      new PendingRequestStore(directory),
    );
    await assert.rejects(
      firstClient.createJob(jobInput),
      (error) => error.code === "NETWORK_ERROR",
    );
    assert.equal(firstAttempts.length, 3);
    assert.ok(
      firstAttempts.every(
        (attempt) =>
          attempt.idempotencyKey === firstAttempts[0].idempotencyKey &&
          attempt.requestId === firstAttempts[0].requestId,
      ),
    );
    assert.equal(
      new Set(firstAttempts.map((attempt) => attempt.nonce)).size,
      3,
    );

    const persisted = await readFile(
      path.join(directory, "pending-requests.json"),
      "utf8",
    );
    assert.equal(persisted.includes(jobInput.command), false);
    assert.equal(persisted.includes('"command"'), false);

    const secondAttempts = [];
    const secondStore = new PendingRequestStore(directory);
    const secondClient = new CloudSshClient(
      "https://ssh.example.com",
      new MemorySecretStore(identity),
      async (_url, init) => {
        const headers = new Headers(init.headers);
        secondAttempts.push({
          idempotencyKey: headers.get("idempotency-key"),
          requestId: headers.get("x-request-id"),
          nonce: headers.get("x-cloudssh-nonce"),
        });
        return new Response(JSON.stringify({ job: { id: "job-recovered" } }), {
          status: 202,
        });
      },
      secondStore,
    );

    assert.equal((await secondClient.createJob(jobInput)).id, "job-recovered");
    assert.equal(
      secondAttempts[0].idempotencyKey,
      firstAttempts[0].idempotencyKey,
    );
    assert.equal(secondAttempts[0].requestId, firstAttempts[0].requestId);
    assert.notEqual(secondAttempts[0].nonce, firstAttempts.at(-1).nonce);
    assert.deepEqual((await secondStore.read()).requests, {});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("旧版待确认请求升级后继续复用操作标识且移除正文哈希", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cloudssh-skill-pending-migration-"),
  );
  const identity = testIdentity();
  const input = {
    serverId: "server-legacy",
    command: "printf legacy-pending-request",
    timeoutMs: 30_000,
  };
  const bodyHash = createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
  const legacyFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        baseUrl: "https://ssh.example.com/agent/v1",
        deviceId: identity.deviceId,
        method: "POST",
        resource: "/agent/v1/jobs",
        requestHash: bodyHash,
      }),
      "utf8",
    )
    .digest("hex");
  const legacyRequestId = randomUUID();
  const legacyIdempotencyKey = randomUUID();
  try {
    await writeFile(
      path.join(directory, "pending-requests.json"),
      `${JSON.stringify({
        version: 1,
        requests: {
          [legacyFingerprint]: {
            requestId: legacyRequestId,
            idempotencyKey: legacyIdempotencyKey,
            deviceId: identity.deviceId,
            method: "POST",
            resource: "/agent/v1/jobs",
            requestHash: bodyHash,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        },
      })}\n`,
      "utf8",
    );

    const attempts = [];
    const client = new CloudSshClient(
      "https://ssh.example.com",
      new MemorySecretStore(identity),
      async (_url, init) => {
        const headers = new Headers(init.headers);
        attempts.push({
          requestId: headers.get("x-request-id"),
          idempotencyKey: headers.get("idempotency-key"),
        });
        throw new Error("connection reset after request");
      },
      new PendingRequestStore(directory),
    );

    await assert.rejects(
      client.createJob(input),
      (error) => error.code === "NETWORK_ERROR",
    );
    assert.ok(
      attempts.every(
        (attempt) =>
          attempt.requestId === legacyRequestId &&
          attempt.idempotencyKey === legacyIdempotencyKey,
      ),
    );
    const persisted = await readFile(
      path.join(directory, "pending-requests.json"),
      "utf8",
    );
    const state = JSON.parse(persisted);
    assert.equal(state.version, 2);
    assert.equal(persisted.includes(bodyHash), false);
    assert.equal(persisted.includes(legacyFingerprint), false);
    const record = Object.values(state.requests)[0];
    assert.equal(record.requestId, legacyRequestId);
    assert.equal(record.idempotencyKey, legacyIdempotencyKey);
    assert.match(record.requestProof, /^[a-f0-9]{64}$/);
    assert.equal("requestHash" in record, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("明确非重试错误会清理待确认请求", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cloudssh-skill-pending-explicit-error-"),
  );
  const store = new PendingRequestStore(directory);
  try {
    const client = new CloudSshClient(
      "https://ssh.example.com",
      new MemorySecretStore(testIdentity()),
      async () =>
        new Response(
          JSON.stringify({ error: "无权访问", code: "SERVER_DENIED" }),
          { status: 403 },
        ),
      store,
    );

    await assert.rejects(
      client.createSession({ serverId: "server-denied" }),
      (error) => error.code === "SERVER_DENIED",
    );
    assert.deepEqual((await store.read()).requests, {});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("服务端无法确认文件操作结果时保留原幂等键", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cloudssh-skill-file-outcome-unknown-"),
  );
  const store = new PendingRequestStore(directory);
  const identity = testIdentity();
  const observedKeys = [];
  try {
    const client = new CloudSshClient(
      "https://ssh.example.com",
      new MemorySecretStore(identity),
      async (_url, init) => {
        observedKeys.push(new Headers(init.headers).get("idempotency-key"));
        return new Response(
          JSON.stringify({
            error: "上一次文件操作结果无法确认",
            code: "IDEMPOTENCY_OUTCOME_UNKNOWN",
          }),
          { status: 409 },
        );
      },
      store,
    );

    await assert.rejects(
      client.makeDirectory("11", "/tmp/uncertain", false),
      (error) => error.code === "IDEMPOTENCY_OUTCOME_UNKNOWN",
    );
    assert.equal(Object.keys((await store.read()).requests).length, 1);

    const retryClient = new CloudSshClient(
      "https://ssh.example.com",
      new MemorySecretStore(identity),
      async (_url, init) => {
        observedKeys.push(new Headers(init.headers).get("idempotency-key"));
        return new Response(
          JSON.stringify({
            error: "上一次文件操作结果无法确认",
            code: "IDEMPOTENCY_OUTCOME_UNKNOWN",
          }),
          { status: 409 },
        );
      },
      new PendingRequestStore(directory),
    );
    await assert.rejects(
      retryClient.makeDirectory("11", "/tmp/uncertain", false),
      (error) => error.code === "IDEMPOTENCY_OUTCOME_UNKNOWN",
    );
    assert.equal(observedKeys[1], observedKeys[0]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("成功但无法解析的响应保留待确认请求", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cloudssh-skill-pending-invalid-response-"),
  );
  const store = new PendingRequestStore(directory);
  try {
    const client = new CloudSshClient(
      "https://ssh.example.com",
      new MemorySecretStore(testIdentity()),
      async () => new Response("not-json", { status: 202 }),
      store,
    );

    await assert.rejects(
      client.createJob({
        serverId: "server-1",
        command: "hostname",
        timeoutMs: 30_000,
      }),
      (error) => error.code === "RESPONSE_UNCERTAIN",
    );
    assert.equal(Object.keys((await store.read()).requests).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("待确认请求日志限制数量并清理过期记录", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cloudssh-skill-pending-expiry-"),
  );
  let now = Date.parse("2026-07-31T00:00:00.000Z");
  const store = new PendingRequestStore(directory, {
    ttlMs: 1_000,
    maxEntries: 1,
    now: () => now,
  });
  const firstInput = pendingRequestInput("a", "b", "/agent/v1/jobs");
  const secondInput = pendingRequestInput("c", "d", "/agent/v1/sessions");
  try {
    const first = await store.reserve(firstInput);
    await assert.rejects(
      store.reserve(secondInput),
      (error) => error.code === "PENDING_REQUEST_LIMIT_REACHED",
    );

    now += 1_001;
    const second = await store.reserve(secondInput);
    assert.notEqual(second.requestId, first.requestId);
    const state = await store.read();
    assert.deepEqual(Object.keys(state.requests), [secondInput.fingerprint]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("并发进程为同一请求只创建一组操作标识", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cloudssh-skill-pending-processes-"),
  );
  const input = pendingRequestInput("e", "f", "/agent/v1/jobs");
  const moduleUrl = pathToFileURL(skillScript).href;
  const worker = `
    import { PendingRequestStore } from ${JSON.stringify(moduleUrl)};
    const store = new PendingRequestStore(process.env.CLOUDSSH_PENDING_TEST_DIR);
    const record = await store.reserve(JSON.parse(process.env.CLOUDSSH_PENDING_TEST_INPUT));
    process.stdout.write(JSON.stringify(record));
  `;
  try {
    const environment = {
      ...process.env,
      CLOUDSSH_PENDING_TEST_DIR: directory,
      CLOUDSSH_PENDING_TEST_INPUT: JSON.stringify(input),
    };
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        execFileAsync(
          process.execPath,
          ["--input-type=module", "--eval", worker],
          { env: environment },
        ),
      ),
    );
    const records = results.map(({ stdout }) => JSON.parse(stdout));
    assert.equal(new Set(records.map((record) => record.requestId)).size, 1);
    assert.equal(
      new Set(records.map((record) => record.idempotencyKey)).size,
      1,
    );
    const state = await new PendingRequestStore(directory).read();
    assert.equal(Object.keys(state.requests).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Skill 错误不会泄露服务端返回的敏感字段", async () => {
  const identity = testIdentity();
  const secret = "cssh_never_leak_skill_test_12345";
  const client = new CloudSshClient(
    "https://ssh.example.com",
    new MemorySecretStore(identity),
    async () =>
      new Response(
        JSON.stringify({ error: `Bearer ${secret}`, code: secret }),
        {
          status: 403,
        },
      ),
  );
  await assert.rejects(
    client.listServers(),
    (error) =>
      error instanceof CloudSshApiError &&
      error.code === "HTTP_ERROR" &&
      !error.code.includes(secret) &&
      !error.message.includes(secret),
  );
});

test("Skill 文件权限错误保留 403 和 SCOPE_DENIED 且不暴露敏感字段", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cloudssh-skill-file-scope-"),
  );
  const identity = testIdentity();
  const sensitiveValues = [
    "FILE_SCOPE_PASSWORD_MUST_NOT_LEAK",
    "FILE_SCOPE_PRIVATE_KEY_MUST_NOT_LEAK",
    "cssh_file_scope_token_must_not_leak",
    "FILE_SCOPE_CONTENT_MUST_NOT_LEAK",
  ];
  try {
    const client = new CloudSshClient(
      "https://ssh.example.com",
      new MemorySecretStore(identity),
      async (url) => {
        const requiredScope = url.pathname.endsWith("/files/upload")
          ? "files:write"
          : "files:read";
        return new Response(
          JSON.stringify({
            error: `设备缺少 ${requiredScope} 权限`,
            code: "SCOPE_DENIED",
            password: sensitiveValues[0],
            privateKey: sensitiveValues[1],
            token: sensitiveValues[2],
            details: { content: sensitiveValues[3] },
          }),
          { status: 403 },
        );
      },
      new PendingRequestStore(directory),
    );

    const operations = [
      () => client.downloadFile("11", "/tmp/read-denied.bin"),
      () =>
        client.uploadFile(
          "11",
          "/tmp/write-denied.bin",
          Buffer.from("local-file-content"),
        ),
    ];
    for (const operation of operations) {
      await assert.rejects(operation(), (error) => {
        assert.ok(error instanceof CloudSshApiError);
        assert.equal(error.status, 403);
        assert.equal(error.code, "SCOPE_DENIED");
        const visibleError = `${error.message}\n${error.stack ?? ""}\n${JSON.stringify(error)}`;
        for (const sensitiveValue of sensitiveValues) {
          assert.equal(visibleError.includes(sensitiveValue), false);
        }
        return true;
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Skill 并发更新会话状态不会互相覆盖", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cloudssh-skill-concurrent-state-"),
  );
  try {
    const first = new SessionStateStore(directory);
    const second = new SessionStateStore(directory);
    await Promise.all([
      first.update("session-1", { cursor: "cursor-1" }),
      second.update("session-2", { cursor: "cursor-2" }),
    ]);
    const sessions = (await first.read()).sessions;
    assert.equal(sessions["session-1"].cursor, "cursor-1");
    assert.equal(sessions["session-2"].cursor, "cursor-2");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Skill 不会抢占仍由存活进程持有的旧时间戳锁", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cloudssh-skill-live-lock-"),
  );
  const file = path.join(directory, "state.json");
  let release;
  try {
    const first = withFileLock(
      file,
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      { timeoutMs: 500, staleMs: 20, heartbeatMs: 10 },
    );
    const lockFile = `${file}.lock`;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        await readFile(lockFile, "utf8");
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    const old = new Date(Date.now() - 60_000);
    await utimes(lockFile, old, old);

    await assert.rejects(
      withFileLock(file, async () => undefined, {
        timeoutMs: 80,
        staleMs: 20,
        heartbeatMs: 10,
      }),
      /其他进程占用/,
    );
    release();
    await first;
  } finally {
    release?.();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Skill 跨进程状态持久保存附件、租约和游标", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cloudssh-skill-state-"),
  );
  try {
    const first = new SessionStateStore(directory);
    await first.update("session-1", {
      attachmentId: "attachment-1",
      leaseId: "lease-1",
      mode: "read-write",
      cursor: "cursor-1",
    });
    const second = new SessionStateStore(directory);
    const restored = (await second.read()).sessions["session-1"];
    assert.deepEqual(
      { ...restored, updatedAt: undefined },
      {
        attachmentId: "attachment-1",
        leaseId: "lease-1",
        mode: "read-write",
        cursor: "cursor-1",
        updatedAt: undefined,
      },
    );
    assert.match(restored.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    await second.remove("session-1");
    assert.deepEqual((await first.read()).sessions, {});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("旧版 Profile 自动使用默认设备密钥槽", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cloudssh-skill-legacy-profile-"),
  );
  try {
    await writeFile(
      path.join(directory, "profile.json"),
      JSON.stringify({
        baseUrl: "https://ssh.example.com",
        deviceId: "legacy-device",
        publicKey: "legacy-public-key",
        fingerprint: "legacy-fingerprint",
      }),
    );
    const profile = await new ProfileStore(directory).read();
    assert.equal(profile.keyId, "default-agent-device-key");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows DPAPI 密钥槽拒绝非 UUID 文件名", async () => {
  const store = new WindowsDpapiSecretStore(os.tmpdir());
  await assert.rejects(store.get("../escape"), /密钥槽 ID 无效/);
  await assert.rejects(store.delete("not-a-uuid"), /密钥槽 ID 无效/);
});

test("并发设备身份提交只保留最终 Profile 对应的私钥", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cloudssh-skill-concurrent-login-"),
  );
  try {
    const profiles = new ProfileStore(directory);
    const cleanups = new DeviceKeyCleanupStore(directory);
    const oldKeyId = randomUUID();
    const firstKeyId = randomUUID();
    const secondKeyId = randomUUID();
    const secrets = new MemoryKeySlotStore([[oldKeyId, "old-private-key"]]);
    await profiles.write({
      baseUrl: "https://ssh.example.com",
      deviceId: "old-device",
      publicKey: "old-public-key",
      fingerprint: "old-fingerprint",
      keyId: oldKeyId,
    });

    await Promise.all([
      commitDeviceIdentity(
        profiles,
        secrets,
        cleanups,
        {
          baseUrl: "https://ssh.example.com",
          deviceId: "first-device",
          publicKey: "first-public-key",
          fingerprint: "first-fingerprint",
          keyId: firstKeyId,
        },
        "first-private-key",
      ),
      commitDeviceIdentity(
        profiles,
        secrets,
        cleanups,
        {
          baseUrl: "https://ssh.example.com",
          deviceId: "second-device",
          publicKey: "second-public-key",
          fingerprint: "second-fingerprint",
          keyId: secondKeyId,
        },
        "second-private-key",
      ),
    ]);

    await loadDeviceProfile(profiles, secrets, cleanups);

    const profile = await profiles.read();
    assert.deepEqual([...secrets.values.keys()], [profile.keyId]);
    assert.equal(
      await secrets.get(profile.keyId),
      `${profile.deviceId.replace("-device", "")}-private-key`,
    );
    assert.deepEqual(await cleanups.read(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("设备私钥写入前先持久登记清理意图", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cloudssh-skill-key-wal-"),
  );
  try {
    const profiles = new ProfileStore(directory);
    const cleanups = new DeviceKeyCleanupStore(directory);
    const oldKeyId = randomUUID();
    const nextKeyId = randomUUID();
    const secrets = new MemoryKeySlotStore([[oldKeyId, "old-private-key"]]);
    await profiles.write({
      baseUrl: "https://ssh.example.com",
      deviceId: "old-device",
      publicKey: "old-public-key",
      fingerprint: "old-fingerprint",
      keyId: oldKeyId,
    });
    secrets.set = async () => {
      assert.deepEqual(await cleanups.read(), [nextKeyId]);
      throw new Error("simulated interruption");
    };

    await assert.rejects(
      commitDeviceIdentity(
        profiles,
        secrets,
        cleanups,
        {
          baseUrl: "https://ssh.example.com",
          deviceId: "new-device",
          publicKey: "new-public-key",
          fingerprint: "new-fingerprint",
          keyId: nextKeyId,
        },
        "new-private-key",
      ),
      /simulated interruption/,
    );
    assert.equal((await profiles.read()).deviceId, "old-device");
    assert.deepEqual(await cleanups.read(), [nextKeyId]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Profile 写入和临时密钥清理同时失败时保留旧身份并排队重试", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cloudssh-skill-profile-rollback-"),
  );
  try {
    const profiles = new ProfileStore(directory);
    const cleanups = new DeviceKeyCleanupStore(directory);
    const oldKeyId = randomUUID();
    const nextKeyId = randomUUID();
    const secrets = new MemoryKeySlotStore([[oldKeyId, "old-private-key"]]);
    await profiles.write({
      baseUrl: "https://ssh.example.com",
      deviceId: "old-device",
      publicKey: "old-public-key",
      fingerprint: "old-fingerprint",
      keyId: oldKeyId,
    });
    const originalWrite = profiles.write.bind(profiles);
    profiles.write = async (profile) => {
      if (profile.deviceId === "new-device") throw new Error("profile failed");
      return originalWrite(profile);
    };
    secrets.failedDeletes.add(nextKeyId);

    await assert.rejects(
      commitDeviceIdentity(
        profiles,
        secrets,
        cleanups,
        {
          baseUrl: "https://ssh.example.com",
          deviceId: "new-device",
          publicKey: "new-public-key",
          fingerprint: "new-fingerprint",
          keyId: nextKeyId,
        },
        "new-private-key",
      ),
      /待清理队列/,
    );
    assert.equal((await profiles.read()).deviceId, "old-device");
    assert.equal(await secrets.get(oldKeyId), "old-private-key");
    assert.deepEqual(await cleanups.read(), [nextKeyId]);

    secrets.failedDeletes.clear();
    await loadDeviceProfile(profiles, secrets, cleanups);
    assert.equal(await secrets.get(nextKeyId), null);
    assert.deepEqual(await cleanups.read(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("macOS 与 Linux 密钥存储始终使用同一 UUID 槽", async () => {
  const keyId = randomUUID();
  for (const Store of [MacOsKeychainSecretStore, LinuxSecretServiceStore]) {
    const calls = [];
    const execute = async (command, args, stdin = "", options = {}) => {
      calls.push({ command, args, stdin, options });
      return { code: 0, stdout: "private-key\n", stderr: "" };
    };
    const store = new Store(execute);
    await store.set("private-key", keyId);
    await store.get(keyId);
    await store.delete(keyId);
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.ok(call.args.includes(keyId));
      assert.equal(call.args.includes("default-agent-device-key"), false);
      assert.equal(call.args.includes("private-key"), false);
    }
    if (Store === MacOsKeychainSecretStore) {
      assert.equal(calls[0].stdin, "private-key\nprivate-key\n");
      assert.equal(calls[0].options.detached, true);
    }
  }
});

test("Windows Skill 使用 DPAPI 保存设备私钥密文", async (context) => {
  if (process.platform !== "win32") {
    context.skip("仅 Windows 支持 DPAPI");
    return;
  }
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cloudssh-skill-dpapi-"),
  );
  const privateKey = testIdentity().privateKey;
  const keyId = randomUUID();
  try {
    const store = new WindowsDpapiSecretStore(directory);
    await store.set(privateKey, keyId);
    const cipher = await readFile(
      path.join(directory, `agent-device-key.${keyId}.dpapi`),
      "utf8",
    );
    assert.equal(cipher.includes(privateKey), false);
    assert.equal(await store.get(keyId), privateKey);
    await store.delete(keyId);
    assert.equal(await store.get(keyId), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("安装后的 Skill 可跨进程发现服务器并复用会话租约与游标", async (context) => {
  if (process.platform !== "win32") {
    context.skip("当前进程级测试使用 Windows DPAPI");
    return;
  }
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cloudssh-skill-e2e-"),
  );
  let writeBody = null;
  let createdHostBody = null;
  let quickConnectionBody = null;
  let uploadedFileBody = null;
  const fileMutationBodies = [];
  const uploadSentinel = "UPLOAD_CONTENT_MUST_NOT_REACH_STDOUT";
  const downloadSentinel = "DOWNLOAD_CONTENT_MUST_NOT_REACH_STDOUT";
  let registeredPublicKey = "";
  let registrationCount = 0;
  const readCursors = [];
  const readAttachments = [];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    response.setHeader("content-type", "application/json");
    if (
      request.method === "POST" &&
      url.pathname.endsWith("/auth/device-requests")
    ) {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      registeredPublicKey = JSON.parse(raw).publicKey;
      registrationCount += 1;
      response.statusCode = 201;
      response.end(
        JSON.stringify({
          request: {
            requestId: `request-${registrationCount}`,
            code: "ABCD-EFGH",
            deviceName: "test-device",
            fingerprint: "test-fingerprint",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            intervalSeconds: 1,
          },
        }),
      );
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname.endsWith("/auth/device-requests/request-1")
    ) {
      assert.ok(registeredPublicKey.includes("BEGIN PUBLIC KEY"));
      assert.match(request.headers["x-cloudssh-signature"], /^[A-Za-z0-9_-]+$/);
      response.end(
        JSON.stringify({ status: "approved", deviceId: "device-1" }),
      );
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname.endsWith("/auth/device-requests/request-2")
    ) {
      response.end(JSON.stringify({ status: "denied" }));
      return;
    }
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers["x-cloudssh-device-id"], "device-1");
    assert.match(request.headers["x-cloudssh-signature"], /^[A-Za-z0-9_-]+$/);
    if (request.method === "GET" && url.pathname.endsWith("/servers")) {
      response.end(
        JSON.stringify({
          servers: [
            {
              hostId: 42,
              serverId: "11",
              name: "Production",
              connectionType: "ssh",
              address: "198.51.100.11",
              port: 2222,
              folder: "生产 / 数据库",
              tags: ["production", "database"],
            },
          ],
        }),
      );
      return;
    }
    if (request.method === "GET" && url.pathname.endsWith("/files/list")) {
      response.end(
        JSON.stringify({
          path: url.searchParams.get("path"),
          files: [{ name: "app.conf", path: "/etc/app.conf" }],
        }),
      );
      return;
    }
    if (request.method === "GET" && url.pathname.endsWith("/files/read")) {
      response.end(
        JSON.stringify({
          path: url.searchParams.get("path"),
          content: "enabled=true\n",
          encoding: "utf8",
          size: 13,
          truncated: false,
        }),
      );
      return;
    }
    if (request.method === "GET" && url.pathname.endsWith("/files/download")) {
      response.setHeader("content-type", "application/octet-stream");
      response.end(downloadSentinel);
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/files/upload")) {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      uploadedFileBody = Buffer.concat(chunks);
      assert.match(request.headers["idempotency-key"], /^[0-9a-f-]{36}$/);
      response.statusCode = 201;
      response.end(
        JSON.stringify({
          file: {
            serverId: url.searchParams.get("serverId"),
            path: url.searchParams.get("path"),
            size: uploadedFileBody.length,
          },
        }),
      );
      return;
    }
    if (
      request.method === "POST" &&
      ["/files/mkdir", "/files/rename", "/files/delete"].some((suffix) =>
        url.pathname.endsWith(suffix),
      )
    ) {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      fileMutationBodies.push({ path: url.pathname, body });
      assert.match(request.headers["idempotency-key"], /^[0-9a-f-]{36}$/);
      const payload = url.pathname.endsWith("/files/mkdir")
        ? { directory: { serverId: body.serverId, path: body.path } }
        : { file: body };
      response.statusCode = url.pathname.endsWith("/files/mkdir") ? 201 : 200;
      response.end(JSON.stringify(payload));
      return;
    }
    if (request.method === "GET" && url.pathname.endsWith("/projects")) {
      response.end(
        JSON.stringify({
          projects: [{ id: "project-1", name: "生产", kind: "team" }],
        }),
      );
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname.endsWith("/projects/project-1/folders")
    ) {
      response.end(JSON.stringify({ folders: [{ path: "生产 / 数据库" }] }));
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname.endsWith("/projects/project-1/credentials")
    ) {
      response.end(
        JSON.stringify({
          credentials: [
            {
              id: "credential-1",
              name: "生产凭据",
              username: "deploy",
              authType: "key",
            },
          ],
        }),
      );
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/servers")) {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      createdHostBody = JSON.parse(raw);
      assert.match(request.headers["idempotency-key"], /^[0-9a-f-]{36}$/);
      response.statusCode = 201;
      response.end(
        JSON.stringify({
          server: {
            serverId: "12",
            projectId: "project-1",
            folder: "生产 / 数据库",
          },
        }),
      );
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname.endsWith("/quick-connections")
    ) {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      quickConnectionBody = JSON.parse(raw);
      assert.match(request.headers["idempotency-key"], /^[0-9a-f-]{36}$/);
      response.statusCode = 201;
      response.end(
        JSON.stringify({
          connection: {
            serverId: "13",
            projectId: "project-1",
            temporary: true,
          },
        }),
      );
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/attach")) {
      response.end(
        JSON.stringify({
          session: { id: "session-1" },
          attachmentId: "attachment-1",
          mode: "read-write",
          lease: { id: "lease-1" },
        }),
      );
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/write")) {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      writeBody = JSON.parse(raw);
      assert.match(request.headers["idempotency-key"], /^[0-9a-f-]{36}$/);
      response.end(JSON.stringify({ accepted: true, duplicate: false }));
      return;
    }
    if (request.method === "POST" && url.pathname.endsWith("/detach")) {
      response.end(JSON.stringify({ detached: true }));
      return;
    }
    if (request.method === "GET" && url.pathname.endsWith("/read")) {
      readCursors.push(url.searchParams.get("cursor"));
      readAttachments.push(url.searchParams.get("attachmentId"));
      response.end(
        JSON.stringify({
          chunks: [],
          nextCursor: readCursors.length === 1 ? "cursor-1" : "cursor-2",
          gap: false,
          state: "RUNNING",
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const invokeRaw = (...args) =>
      execFileAsync(process.execPath, [skillScript, ...args], {
        env: { ...process.env, CLOUDSSH_CONFIG_DIR: directory },
      });
    const invoke = async (...args) => {
      const result = await invokeRaw(...args);
      return JSON.parse(result.stdout);
    };
    const assertCliRejected = async (
      args,
      expectedMessage,
      hiddenValues = [],
    ) => {
      await assert.rejects(invokeRaw(...args), (error) => {
        assert.equal(error.code, 1);
        const payload = JSON.parse(error.stderr);
        assert.match(payload.error, expectedMessage);
        assert.equal(payload.code, "SKILL_ERROR");
        for (const hiddenValue of hiddenValues) {
          assert.equal(error.stderr.includes(hiddenValue), false);
        }
        return true;
      });
    };

    const login = await invoke(
      "auth",
      "login",
      "--url",
      baseUrl,
      "--name",
      "test-device",
    );
    assert.equal(login.authenticated, true);
    assert.equal(login.deviceId, "device-1");
    const profileBeforeFailedLogin = await readFile(
      path.join(directory, "profile.json"),
      "utf8",
    );
    const profile = JSON.parse(profileBeforeFailedLogin);
    assert.match(profile.keyId, /^[0-9a-f-]{36}$/);
    const activeKeyFile = path.join(
      directory,
      `agent-device-key.${profile.keyId}.dpapi`,
    );
    const cipher = await readFile(activeKeyFile, "utf8");
    assert.equal(cipher.includes("PRIVATE KEY"), false);

    assert.deepEqual((await invoke("servers", "list")).servers[0], {
      hostId: 42,
      serverId: "11",
      name: "Production",
      connectionType: "ssh",
      address: "198.51.100.11",
      port: 2222,
      folder: "生产 / 数据库",
      tags: ["production", "database"],
    });
    assert.equal(
      (await invoke("files", "list", "--server", "11", "--path", "/etc"))
        .files[0].name,
      "app.conf",
    );
    assert.equal(
      (
        await invoke(
          "files",
          "read",
          "--server",
          "11",
          "--path",
          "/etc/app.conf",
        )
      ).content,
      "enabled=true\n",
    );
    const uploadPath = path.join(directory, "-upload.bin");
    const downloadPath = path.join(directory, "-download.bin");
    await writeFile(uploadPath, uploadSentinel);
    const uploadExecution = await invokeRaw(
      "files",
      "upload",
      "--server",
      "11",
      "--path",
      "/tmp/upload.bin",
      "--local-path",
      uploadPath,
    );
    assert.equal(uploadExecution.stdout.includes(uploadSentinel), false);
    assert.equal(
      JSON.parse(uploadExecution.stdout).file.path,
      "/tmp/upload.bin",
    );
    assert.equal(uploadedFileBody.toString(), uploadSentinel);
    const downloadExecution = await invokeRaw(
      "files",
      "download",
      "--server",
      "11",
      "--path",
      "/tmp/download.bin",
      "--local-path",
      downloadPath,
    );
    assert.equal(downloadExecution.stdout.includes(downloadSentinel), false);
    assert.equal(
      JSON.parse(downloadExecution.stdout).download.localPath,
      downloadPath,
    );
    assert.equal(await readFile(downloadPath, "utf8"), downloadSentinel);
    for (const action of ["upload", "download"]) {
      const baseArguments = [
        "files",
        action,
        "--server",
        "11",
        "--path",
        `/tmp/${action}-rejected.bin`,
      ];
      await assertCliRejected(baseArguments, /缺少 --local-path/);
      await assertCliRejected(
        [...baseArguments, "--local-path", "-"],
        /不支持标准输入或标准输出/,
      );
      for (const flag of ["content", "data"]) {
        const sentinel = `${action.toUpperCase()}_${flag.toUpperCase()}_MUST_NOT_LEAK`;
        await assertCliRejected(
          [...baseArguments, `--${flag}`, sentinel],
          new RegExp(`未识别参数.*--${flag}`),
          [sentinel],
        );
      }
      await assertCliRejected(
        [...baseArguments, "--unexpected", "value"],
        /未识别参数.*--unexpected/,
      );
    }
    await invoke(
      "files",
      "mkdir",
      "--server",
      "11",
      "--path",
      "/tmp/new",
      "--recursive",
    );
    await invoke(
      "files",
      "rename",
      "--server",
      "11",
      "--source-path",
      "/tmp/new",
      "--destination-path",
      "/tmp/current",
    );
    await invoke(
      "files",
      "delete",
      "--server",
      "11",
      "--path",
      "/tmp/current",
      "--recursive",
    );
    assert.deepEqual(
      fileMutationBodies.map(({ body }) => body),
      [
        { serverId: "11", path: "/tmp/new", recursive: true },
        {
          serverId: "11",
          sourcePath: "/tmp/new",
          destinationPath: "/tmp/current",
        },
        { serverId: "11", path: "/tmp/current", recursive: true },
      ],
    );
    assert.equal(
      (await invoke("projects", "list")).projects[0].id,
      "project-1",
    );
    assert.equal(
      (await invoke("folders", "list", "--project", "project-1")).folders[0]
        .path,
      "生产 / 数据库",
    );
    assert.equal(
      (await invoke("credentials", "list", "--project", "project-1"))
        .credentials[0].id,
      "credential-1",
    );
    assert.equal(
      (
        await invoke(
          "servers",
          "create",
          "--project",
          "project-1",
          "--folder",
          "生产 / 数据库",
          "--name",
          "db-01",
          "--address",
          "198.51.100.20",
          "--username",
          "deploy",
          "--auth-type",
          "credential",
          "--credential-id",
          "credential-1",
        )
      ).server.serverId,
      "12",
    );
    assert.deepEqual(createdHostBody, {
      projectId: "project-1",
      address: "198.51.100.20",
      port: 22,
      username: "deploy",
      authType: "credential",
      name: "db-01",
      folder: "生产 / 数据库",
      credentialId: "credential-1",
    });
    assert.equal(
      (
        await invoke(
          "quick-connect",
          "create",
          "--project",
          "project-1",
          "--address",
          "198.51.100.21",
          "--username",
          "deploy",
          "--auth-type",
          "credential",
          "--credential-id",
          "credential-1",
          "--host-key-fingerprint",
          "ab".repeat(32),
        )
      ).connection.serverId,
      "13",
    );
    assert.deepEqual(quickConnectionBody, {
      projectId: "project-1",
      address: "198.51.100.21",
      port: 22,
      username: "deploy",
      authType: "credential",
      credentialId: "credential-1",
      hostKeyFingerprint: "ab".repeat(32),
    });
    await assert.rejects(
      invoke("auth", "login", "--url", baseUrl, "--name", "rejected-device"),
      (error) => error.stderr?.includes("设备审批已拒绝"),
    );
    assert.equal(
      await readFile(path.join(directory, "profile.json"), "utf8"),
      profileBeforeFailedLogin,
    );
    assert.equal(await readFile(activeKeyFile, "utf8"), cipher);
    assert.deepEqual(
      (await readdir(directory)).filter((file) => file.endsWith(".dpapi")),
      [path.basename(activeKeyFile)],
    );
    assert.equal((await invoke("servers", "list")).servers[0].serverId, "11");
    assert.equal((await invoke("auth", "status")).authenticated, true);
    await invoke(
      "sessions",
      "attach",
      "--session",
      "session-1",
      "--mode",
      "read-write",
    );
    await invoke(
      "sessions",
      "send",
      "--session",
      "session-1",
      "--command",
      "uptime",
    );
    assert.deepEqual(writeBody, {
      attachmentId: "attachment-1",
      leaseId: "lease-1",
      data: "uptime\n",
    });
    await invoke("sessions", "read", "--session", "session-1");
    await invoke("sessions", "detach", "--session", "session-1");
    await invoke("sessions", "read", "--session", "session-1");
    assert.deepEqual(readCursors, [null, "cursor-1"]);
    assert.deepEqual(readAttachments, ["attachment-1", null]);
    assert.equal((await invoke("auth", "logout")).authenticated, false);
    assert.equal((await invoke("auth", "status")).authenticated, false);
    await assert.rejects(
      readFile(activeKeyFile, "utf8"),
      (error) => error.code === "ENOENT",
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
