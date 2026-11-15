import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSecurityStore } from "./security-store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function securityFile() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "cloudssh-security-"),
  );
  temporaryDirectories.push(directory);
  return path.join(directory, "security.sqlite");
}

function auditTarget() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE agent_audit_events (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
      service_account_id TEXT NOT NULL, token_id TEXT, device_id TEXT,
      session_id TEXT, project_host_id INTEGER, request_id TEXT,
      action TEXT NOT NULL, success INTEGER NOT NULL, error_code TEXT,
      metadata TEXT, ip_address TEXT, occurred_at TEXT NOT NULL
    );
  `);
  return sqlite;
}

function auditEvent(id: string, occurredAt = new Date().toISOString()) {
  return {
    id,
    projectId: "project-1",
    serviceAccountId: "service-1",
    tokenId: null,
    deviceId: "device-1",
    sessionId: null,
    projectHostId: 11,
    requestId: `request-${id}`,
    action: "post /jobs",
    success: 1,
    errorCode: null,
    metadata: "{}",
    ipAddress: "127.0.0.1",
    occurredAt,
  };
}

describe("Agent 独立安全存储", () => {
  it("MCP 调用意图和下发状态独立落盘，重启及删除密钥后仍可查询", async () => {
    const source = new Database(":memory:");
    source.exec(`CREATE TABLE agent_access_tokens (id TEXT, created_by_user_id TEXT, name TEXT);
      INSERT INTO agent_access_tokens VALUES ('key', 'owner', 'Original');`);
    const file = securityFile();
    const first = new AgentSecurityStore(file);
    const history = first.createMcpHistory(source);
    const entry = {
      id: "invocation",
      tokenId: "key",
      tool: "cloudssh_jobs_execute",
      projectId: "project",
      success: false,
      durationMs: 0,
      code: "PENDING",
      requestId: "retry-key",
    };
    await history.record({ ...entry, stage: "intent" });
    const observer = new AgentSecurityStore(file);
    const filters = { page: 1, tool: "", tokenId: "", status: "" };
    expect(
      observer.createMcpHistory(source).list("owner", false, filters).records,
    ).toEqual([
      expect.objectContaining({
        stage: "intent",
        operationDispatched: 0,
        requestId: "retry-key",
      }),
    ]);
    observer.close();
    await history.record({
      ...entry,
      stage: "dispatched",
      operationDispatched: true,
      code: "OUTCOME_UNKNOWN",
    });
    first.close();
    source.exec("DELETE FROM agent_access_tokens");
    const reopened = new AgentSecurityStore(file);
    expect(
      reopened.createMcpHistory(source).list("owner", false, filters).records,
    ).toEqual([
      expect.objectContaining({
        stage: "dispatched",
        code: "OUTCOME_UNKNOWN",
        tokenName: "Original",
        operationDispatched: 1,
      }),
    ]);
    expect(
      reopened.createMcpHistory(source).list("other", false, filters).total,
    ).toBe(0);
    reopened.close();
    source.close();
  });
  it("将旧 MCP 历史迁入安全库且重启不会重复导入或覆盖完成状态", async () => {
    const source = new Database(":memory:");
    source.exec(`CREATE TABLE agent_access_tokens (id TEXT, created_by_user_id TEXT, name TEXT);
      INSERT INTO agent_access_tokens VALUES ('key', 'owner', 'Original');
      CREATE TABLE mcp_invocations (id TEXT PRIMARY KEY, token_id TEXT, tool TEXT,
        project_id TEXT, success INTEGER, duration_ms INTEGER, code TEXT, created_at TEXT);`);
    source
      .prepare(
        "INSERT INTO mcp_invocations VALUES ('legacy', 'key', 'cloudssh_context', NULL, 1, 1, NULL, ?)",
      )
      .run(new Date().toISOString());
    const file = securityFile();
    const store = new AgentSecurityStore(file);
    const filters = { page: 1, tool: "", tokenId: "", status: "" };
    expect(
      store.createMcpHistory(source).list("owner", false, filters).total,
    ).toBe(1);
    expect(
      store.createMcpHistory(source).list("owner", false, filters).total,
    ).toBe(1);
    store.close();
    source.close();
  });
  it("进程重启后仍拒绝已经消费的 nonce", async () => {
    const file = securityFile();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const first = new AgentSecurityStore(file);
    await expect(
      first.consumeNonce("device-1", "nonce-1", expiresAt),
    ).resolves.toBe(true);
    first.close();

    const reopened = new AgentSecurityStore(file);
    await expect(
      reopened.consumeNonce("device-1", "nonce-1", expiresAt),
    ).resolves.toBe(false);
    reopened.close();
  });

  it("进程重启后保留最小化的认证失败审计", async () => {
    const file = securityFile();
    const first = new AgentSecurityStore(file);
    await first.recordAuthFailure({
      deviceId: "device-1",
      requestId: "request-1",
      method: "POST",
      path: "/agent/v1/jobs",
      errorCode: "DEVICE_SIGNATURE_INVALID",
      ipAddress: "203.0.113.10",
      occurredAt: "2026-07-31T00:00:00.000Z",
    });
    first.close();

    const reopened = new AgentSecurityStore(file);
    expect(reopened.listAuthFailures()).toEqual([
      {
        deviceId: "device-1",
        requestId: "request-1",
        method: "POST",
        path: "/agent/v1/jobs",
        errorCode: "DEVICE_SIGNATURE_INVALID",
        ipAddress: "203.0.113.10",
        occurredAt: "2026-07-31T00:00:00.000Z",
      },
    ]);
    reopened.close();
  });

  it("主库丢失后可从安全库恢复 Agent 审计", async () => {
    const file = securityFile();
    const security = new AgentSecurityStore(file);
    await security.recordAudit(auditEvent("audit-1"));
    security.close();

    const target = auditTarget();
    const reopened = new AgentSecurityStore(file);
    expect(reopened.syncAuditEvents(target)).toBe(1);
    expect(reopened.syncAuditEvents(target)).toBe(0);
    expect(
      target.prepare("SELECT id, action FROM agent_audit_events").get(),
    ).toEqual({ id: "audit-1", action: "post /jobs" });
    reopened.close();
    target.close();
  });

  it("同一事件状态升级后会重新同步且不产生重复行", async () => {
    const security = new AgentSecurityStore(":memory:");
    const target = auditTarget();
    const pending = { ...auditEvent("stable-event"), success: 0 };
    await security.recordAudit(pending);
    expect(security.syncAuditEvents(target)).toBe(1);
    expect(
      target
        .prepare("SELECT success FROM agent_audit_events WHERE id = ?")
        .get(pending.id),
    ).toEqual({ success: 0 });

    await security.recordAudit({ ...pending, success: 1, errorCode: null });
    expect(security.syncAuditEvents(target)).toBe(1);
    await security.recordAudit({
      ...pending,
      success: 0,
      errorCode: "IDEMPOTENCY_CONFLICT",
    });
    expect(security.syncAuditEvents(target)).toBe(1);
    expect(
      target
        .prepare(
          "SELECT COUNT(*) AS count, success FROM agent_audit_events WHERE id = ?",
        )
        .get(pending.id),
    ).toEqual({ count: 1, success: 1 });

    security.close();
    target.close();
  });

  it("可迁移旧安全库并继续使用单调同步序号", async () => {
    const file = securityFile();
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
        service_account_id TEXT NOT NULL, token_id TEXT, device_id TEXT,
        session_id TEXT, project_host_id INTEGER, request_id TEXT,
        action TEXT NOT NULL, success INTEGER NOT NULL, error_code TEXT,
        metadata TEXT, ip_address TEXT, occurred_at TEXT NOT NULL
      );
    `);
    const event = auditEvent("legacy-event");
    legacy
      .prepare(
        `INSERT INTO audit_events (
           id, project_id, service_account_id, token_id, device_id, session_id,
           project_host_id, request_id, action, success, error_code, metadata,
           ip_address, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.projectId,
        event.serviceAccountId,
        event.tokenId,
        event.deviceId,
        event.sessionId,
        event.projectHostId,
        event.requestId,
        event.action,
        event.success,
        event.errorCode,
        event.metadata,
        event.ipAddress,
        event.occurredAt,
      );
    legacy.close();

    const security = new AgentSecurityStore(file);
    const target = auditTarget();
    expect(security.syncAuditEvents(target)).toBe(1);
    await security.recordAudit(auditEvent("after-migration"));
    expect(security.syncAuditEvents(target)).toBe(1);
    expect(
      target.prepare("SELECT id FROM agent_audit_events ORDER BY id").all(),
    ).toEqual([{ id: "after-migration" }, { id: "legacy-event" }]);

    security.close();
    target.close();
  });

  it("清理主库过期审计且不会从安全库重新镜像", async () => {
    const file = securityFile();
    const security = new AgentSecurityStore(file);
    const oldTime = new Date(1_000).toISOString();
    await security.recordAudit({
      id: "audit-old",
      projectId: "project-1",
      serviceAccountId: "service-1",
      tokenId: null,
      deviceId: "device-1",
      sessionId: null,
      projectHostId: 11,
      requestId: "request-old",
      action: "post /jobs",
      success: 1,
      errorCode: null,
      metadata: "{}",
      ipAddress: "127.0.0.1",
      occurredAt: oldTime,
    });
    const target = auditTarget();
    target
      .prepare(
        `INSERT INTO agent_audit_events (
           id, project_id, service_account_id, action, success, occurred_at
         ) VALUES ('main-old', 'project-1', 'service-1', 'old', 1, ?)`,
      )
      .run(oldTime);

    expect(security.syncAuditEvents(target, 1_000, Date.now())).toBe(1);
    expect(target.prepare("SELECT id FROM agent_audit_events").all()).toEqual(
      [],
    );

    security.close();
    target.close();
  });

  it("每批最多同步一千条并在清理后识别行号复用", async () => {
    const security = new AgentSecurityStore(":memory:");
    const target = auditTarget();
    const oldTimestamp = new Date(
      Date.now() - 91 * 24 * 60 * 60 * 1000,
    ).toISOString();
    for (let index = 0; index < 1_001; index += 1) {
      await security.recordAudit(auditEvent(`batch-${index}`, oldTimestamp));
    }

    const beforeRetentionCutoff = Date.parse(oldTimestamp) + 1;
    expect(security.syncAuditEvents(target, 1_000, beforeRetentionCutoff)).toBe(
      1_000,
    );
    expect(security.syncAuditEvents(target, 1_000, beforeRetentionCutoff)).toBe(
      1,
    );
    expect(security.syncAuditEvents(target, 1_000, beforeRetentionCutoff)).toBe(
      0,
    );

    target.prepare("DELETE FROM agent_audit_events").run();
    security.cleanup();
    await security.recordAudit(auditEvent("after-cleanup"));
    expect(security.syncAuditEvents(target)).toBe(1);
    expect(
      target
        .prepare("SELECT id FROM agent_audit_events WHERE id = ?")
        .get("after-cleanup"),
    ).toEqual({ id: "after-cleanup" });

    security.close();
    target.close();
  });
});
