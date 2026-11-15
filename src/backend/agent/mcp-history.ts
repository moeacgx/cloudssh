import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { McpInvocation } from "./mcp.js";

export class McpHistory {
  constructor(
    private readonly source: Database.Database,
    private readonly onWrite?: () => void | Promise<void>,
    private readonly sqlite: Database.Database = source,
  ) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS mcp_invocations (
      id TEXT PRIMARY KEY, token_id TEXT NOT NULL, tool TEXT NOT NULL,
      project_id TEXT, success INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
      code TEXT, created_at TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS idx_mcp_invocations_time ON mcp_invocations(created_at);`);
    const columns = sqlite
      .prepare("PRAGMA table_info(mcp_invocations)")
      .all() as Array<{ name: string }>;
    const additions = {
      owner_user_id: "TEXT",
      token_name: "TEXT",
      stage: "TEXT NOT NULL DEFAULT 'completed'",
      request_id: "TEXT",
      operation_dispatched: "INTEGER NOT NULL DEFAULT 0",
      operation_committed: "INTEGER NOT NULL DEFAULT 0",
    };
    for (const [name, definition] of Object.entries(additions)) {
      if (!columns.some((column) => column.name === name))
        sqlite.exec(
          `ALTER TABLE mcp_invocations ADD COLUMN ${name} ${definition}`,
        );
    }
    if (sqlite === source) {
      // 一次性迁移旧记录；已删除的历史密钥无法恢复归属，仅管理员可见。
      sqlite.exec(`UPDATE mcp_invocations SET
        owner_user_id = (SELECT created_by_user_id FROM agent_access_tokens WHERE id = token_id),
        token_name = COALESCE((SELECT name FROM agent_access_tokens WHERE id = token_id), 'Deleted key')
        WHERE token_name IS NULL`);
    } else if (
      source
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mcp_invocations'",
        )
        .get()
    ) {
      // 将旧主库历史迁入安全库，重复启动不覆盖已完成的审计状态。
      const legacy = new McpHistory(source);
      const rows = legacy.sqlite
        .prepare("SELECT * FROM mcp_invocations WHERE created_at >= ?")
        .all(new Date(Date.now() - 30 * 86400000).toISOString()) as Array<
        Record<string, string | number | null>
      >;
      sqlite.transaction(() => {
        for (const row of rows) {
          sqlite
            .prepare(
              `INSERT OR IGNORE INTO mcp_invocations
            (id, token_id, tool, project_id, success, duration_ms, code, created_at,
             owner_user_id, token_name, stage, request_id, operation_dispatched, operation_committed)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              row.id,
              row.token_id,
              row.tool,
              row.project_id,
              row.success,
              row.duration_ms,
              row.code,
              row.created_at,
              row.owner_user_id,
              row.token_name,
              row.stage,
              row.request_id,
              row.operation_dispatched,
              row.operation_committed,
            );
        }
      })();
    }
  }
  async record(entry: McpInvocation) {
    const token = this.source
      .prepare(
        `SELECT created_by_user_id AS ownerUserId, name
      FROM agent_access_tokens WHERE id = ?`,
      )
      .get(entry.tokenId) as
      | { ownerUserId: string | null; name: string }
      | undefined;
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          `INSERT INTO mcp_invocations
        (id, token_id, tool, project_id, success, duration_ms, code, created_at,
         owner_user_id, token_name, stage, request_id, operation_dispatched, operation_committed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          success = excluded.success, duration_ms = excluded.duration_ms,
          code = excluded.code, stage = excluded.stage,
          operation_dispatched = excluded.operation_dispatched,
          operation_committed = excluded.operation_committed`,
        )
        .run(
          entry.id ?? crypto.randomUUID(),
          entry.tokenId,
          entry.tool,
          entry.projectId,
          entry.success ? 1 : 0,
          entry.durationMs,
          entry.code,
          new Date().toISOString(),
          entry.ownerUserId ?? token?.ownerUserId ?? null,
          entry.tokenName ?? token?.name ?? "Deleted key",
          entry.stage ?? "completed",
          entry.requestId ?? null,
          entry.operationDispatched ? 1 : 0,
          entry.operationCommitted ? 1 : 0,
        );
      this.sqlite
        .prepare("DELETE FROM mcp_invocations WHERE created_at < ?")
        .run(new Date(Date.now() - 30 * 86400000).toISOString());
    })();
    await this.onWrite?.();
  }
  list(
    userId: string,
    admin: boolean,
    input: { page: number; tool: string; tokenId: string; status: string },
  ) {
    // 归属快照不依赖仍然存在的项目、密钥或共享项目成员关系。
    const where = `event.created_at >= ? AND (? = 1 OR event.owner_user_id = ?) AND (? = '' OR event.tool = ?)
      AND (? = '' OR event.token_id = ?) AND (? = '' OR event.success = ?)`;
    const params = [
      new Date(Date.now() - 30 * 86400000).toISOString(),
      admin ? 1 : 0,
      userId,
      input.tool,
      input.tool,
      input.tokenId,
      input.tokenId,
      input.status,
      input.status === "success" ? 1 : 0,
    ];
    const from = "FROM mcp_invocations event";
    const total = (
      this.sqlite
        .prepare(`SELECT COUNT(*) AS total ${from} WHERE ${where}`)
        .get(...params) as { total: number }
    ).total;
    const records = this.sqlite
      .prepare(
        `SELECT event.id, event.tool, event.project_id AS projectId,
      event.token_id AS tokenId, event.token_name AS tokenName, event.success, event.duration_ms AS durationMs,
      event.stage, event.request_id AS requestId,
      event.operation_dispatched AS operationDispatched, event.operation_committed AS operationCommitted,
      event.code, event.created_at AS createdAt ${from} WHERE ${where}
      ORDER BY event.created_at DESC, event.id DESC LIMIT 25 OFFSET ?`,
      )
      .all(...params, (input.page - 1) * 25);
    return { records, total, page: input.page, pageSize: 25 };
  }
}
