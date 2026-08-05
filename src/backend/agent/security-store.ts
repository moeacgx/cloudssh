import fs from "fs";
import path from "path";
import crypto from "crypto";
import Database from "better-sqlite3";
import type { AgentDurableAuditEvent } from "./audit.js";
import type {
  AgentAuthFailureAuditStore,
  AgentAuthFailureEvent,
  AgentNonceStore,
} from "./device-auth.js";

const AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_AUTH_FAILURE_EVENTS = 100_000;

export class AgentSecurityStore
  implements AgentNonceStore, AgentAuthFailureAuditStore
{
  private readonly sqlite: Database.Database;
  private auditSyncSequence = 0;

  constructor(filePath: string) {
    if (filePath !== ":memory:") {
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      fs.chmodSync(path.dirname(filePath), 0o700);
    }
    this.sqlite = new Database(filePath);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("synchronous = FULL");
    this.sqlite.pragma("busy_timeout = 5000");
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS request_nonces (
        device_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (device_id, nonce)
      );
      CREATE INDEX IF NOT EXISTS idx_security_nonce_expiry
        ON request_nonces (expires_at);
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        sync_sequence INTEGER NOT NULL DEFAULT 0,
        project_id TEXT NOT NULL,
        service_account_id TEXT NOT NULL,
        token_id TEXT,
        device_id TEXT,
        session_id TEXT,
        project_host_id INTEGER,
        request_id TEXT,
        action TEXT NOT NULL,
        success INTEGER NOT NULL,
        error_code TEXT,
        metadata TEXT,
        ip_address TEXT,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_security_audit_time
        ON audit_events (occurred_at);
      CREATE TABLE IF NOT EXISTS auth_events (
        id TEXT PRIMARY KEY,
        device_id TEXT,
        request_id TEXT,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        error_code TEXT NOT NULL,
        ip_address TEXT,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_security_auth_event_time
        ON auth_events (occurred_at);
      CREATE INDEX IF NOT EXISTS idx_security_auth_event_device_time
        ON auth_events (device_id, occurred_at);
    `);
    const auditColumns = this.sqlite
      .prepare("PRAGMA table_info(audit_events)")
      .all() as Array<{ name: string }>;
    if (!auditColumns.some((column) => column.name === "sync_sequence")) {
      this.sqlite.exec(`
        ALTER TABLE audit_events
          ADD COLUMN sync_sequence INTEGER NOT NULL DEFAULT 0;
        UPDATE audit_events SET sync_sequence = rowid;
      `);
    }
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS audit_event_sequence (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_value INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO audit_event_sequence (id, last_value) VALUES (1, 0);
      UPDATE audit_event_sequence
         SET last_value = MAX(
           last_value,
           COALESCE((SELECT MAX(sync_sequence) FROM audit_events), 0)
         )
       WHERE id = 1;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_security_audit_sequence
        ON audit_events (sync_sequence);
    `);
    if (filePath !== ":memory:") {
      fs.chmodSync(filePath, 0o600);
    }
  }

  async consumeNonce(
    deviceId: string,
    nonce: string,
    expiresAt: string,
  ): Promise<boolean> {
    return this.sqlite.transaction(() => {
      this.sqlite
        .prepare("DELETE FROM request_nonces WHERE expires_at <= ?")
        .run(new Date().toISOString());
      return (
        this.sqlite
          .prepare(
            `INSERT OR IGNORE INTO request_nonces
               (device_id, nonce, expires_at) VALUES (?, ?, ?)`,
          )
          .run(deviceId, nonce, expiresAt).changes > 0
      );
    })();
  }

  importLegacyNonces(
    rows: Array<{ deviceId: string; nonce: string; expiresAt: string }>,
  ): number {
    const insert = this.sqlite.prepare(
      `INSERT OR IGNORE INTO request_nonces
         (device_id, nonce, expires_at) VALUES (?, ?, ?)`,
    );
    return this.sqlite.transaction(() => {
      let imported = 0;
      for (const row of rows) {
        if (Date.parse(row.expiresAt) <= Date.now()) continue;
        imported += insert.run(row.deviceId, row.nonce, row.expiresAt).changes;
      }
      return imported;
    })();
  }

  async recordAudit(event: AgentDurableAuditEvent): Promise<void> {
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          `UPDATE audit_event_sequence
              SET last_value = last_value + 1
            WHERE id = 1`,
        )
        .run();
      const sequence = this.sqlite
        .prepare(
          `SELECT last_value AS value
             FROM audit_event_sequence
            WHERE id = 1`,
        )
        .get() as { value: number };
      this.sqlite
        .prepare(
          `INSERT INTO audit_events (
             id, sync_sequence, project_id, service_account_id, token_id,
             device_id, session_id, project_host_id, request_id, action,
             success, error_code, metadata, ip_address, occurred_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             sync_sequence = excluded.sync_sequence,
             success = MAX(audit_events.success, excluded.success),
             error_code = CASE
               WHEN audit_events.success = 1 OR excluded.success = 1 THEN NULL
               ELSE excluded.error_code
             END,
             metadata = CASE
               WHEN excluded.success >= audit_events.success
                 THEN excluded.metadata
               ELSE audit_events.metadata
             END,
             ip_address = CASE
               WHEN excluded.success >= audit_events.success
                 THEN excluded.ip_address
               ELSE audit_events.ip_address
             END,
             occurred_at = CASE
               WHEN excluded.success >= audit_events.success
                 THEN excluded.occurred_at
               ELSE audit_events.occurred_at
             END`,
        )
        .run(
          event.id,
          sequence.value,
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
    })();
  }

  async recordAuthFailure(event: AgentAuthFailureEvent): Promise<void> {
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare("DELETE FROM auth_events WHERE occurred_at <= ?")
        .run(new Date(Date.now() - AUDIT_RETENTION_MS).toISOString());
      this.sqlite
        .prepare(
          `INSERT INTO auth_events (
             id, device_id, request_id, method, path, error_code,
             ip_address, occurred_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          crypto.randomUUID(),
          event.deviceId,
          event.requestId,
          event.method,
          event.path,
          event.errorCode,
          event.ipAddress,
          event.occurredAt,
        );
      this.sqlite
        .prepare(
          `DELETE FROM auth_events
            WHERE id IN (
              SELECT id FROM auth_events
               ORDER BY occurred_at DESC, rowid DESC
               LIMIT -1 OFFSET ?
            )`,
        )
        .run(MAX_AUTH_FAILURE_EVENTS);
    })();
  }

  listAuthFailures(limit = 100): AgentAuthFailureEvent[] {
    return this.sqlite
      .prepare(
        `SELECT device_id AS deviceId, request_id AS requestId,
                method, path, error_code AS errorCode,
                ip_address AS ipAddress, occurred_at AS occurredAt
           FROM auth_events
          ORDER BY occurred_at DESC, rowid DESC
          LIMIT ?`,
      )
      .all(Math.max(1, Math.min(limit, 1_000))) as AgentAuthFailureEvent[];
  }

  syncAuditEvents(
    target: Database.Database,
    limit = 1_000,
    now = Date.now(),
  ): number {
    const cutoff = new Date(now - AUDIT_RETENTION_MS).toISOString();
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM audit_events
          WHERE sync_sequence > ? ORDER BY sync_sequence LIMIT ?`,
      )
      .all(this.auditSyncSequence, Math.max(1, limit)) as Array<
      Record<string, unknown>
    >;
    const insert = target.prepare(
      `INSERT INTO agent_audit_events (
         id, project_id, service_account_id, token_id, device_id, session_id,
         project_host_id, request_id, action, success, error_code, metadata,
         ip_address, occurred_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         success = MAX(agent_audit_events.success, excluded.success),
         error_code = CASE
           WHEN agent_audit_events.success = 1 OR excluded.success = 1 THEN NULL
           ELSE excluded.error_code
         END,
         metadata = CASE
           WHEN excluded.success >= agent_audit_events.success
             THEN excluded.metadata
           ELSE agent_audit_events.metadata
         END,
         ip_address = CASE
           WHEN excluded.success >= agent_audit_events.success
             THEN excluded.ip_address
           ELSE agent_audit_events.ip_address
         END,
         occurred_at = CASE
           WHEN excluded.success >= agent_audit_events.success
             THEN excluded.occurred_at
           ELSE agent_audit_events.occurred_at
         END`,
    );
    const mutations = target.transaction(() => {
      let changed = target
        .prepare("DELETE FROM agent_audit_events WHERE occurred_at <= ?")
        .run(cutoff).changes;
      for (const row of rows) {
        if (typeof row.occurred_at !== "string" || row.occurred_at <= cutoff) {
          continue;
        }
        try {
          changed += insert.run(
            row.id,
            row.project_id,
            row.service_account_id,
            row.token_id,
            row.device_id,
            row.session_id,
            row.project_host_id,
            row.request_id,
            row.action,
            row.success,
            row.error_code,
            row.metadata,
            row.ip_address,
            row.occurred_at,
          ).changes;
        } catch (error) {
          if (
            (error as { code?: string }).code !== "SQLITE_CONSTRAINT_FOREIGNKEY"
          ) {
            throw error;
          }
          // 已删除的项目或服务账号可能使旧审计无法重新挂接，保留在安全库中。
        }
      }
      return changed;
    })();
    const lastSequence = rows.at(-1)?.sync_sequence;
    if (typeof lastSequence === "number") {
      this.auditSyncSequence = lastSequence;
    }
    return mutations;
  }

  cleanup(now = Date.now()): void {
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare("DELETE FROM request_nonces WHERE expires_at <= ?")
        .run(new Date(now).toISOString());
      this.sqlite
        .prepare("DELETE FROM audit_events WHERE occurred_at <= ?")
        .run(new Date(now - AUDIT_RETENTION_MS).toISOString());
      this.sqlite
        .prepare("DELETE FROM auth_events WHERE occurred_at <= ?")
        .run(new Date(now - AUDIT_RETENTION_MS).toISOString());
    })();
  }

  close(): void {
    this.sqlite.close();
  }
}
