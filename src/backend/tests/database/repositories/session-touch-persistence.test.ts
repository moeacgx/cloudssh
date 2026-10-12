import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseContext } from "../../../database/repositories/database-context.js";
import { TestSqliteDatabase } from "./test-support.js";
import { DatabaseSaveTrigger } from "../../../utils/database-save-trigger.js";

const database = vi.hoisted(() => ({
  context: null as DatabaseContext | null,
}));

// 仅替换启动时的真实数据库入口，保留仓库、SQL 和保存调度器。
vi.mock("../../../database/db/index.js", () => ({
  getDb: () => database.context!.drizzle,
  getSqlite: () => database.context!.sqlite,
}));

import { createCurrentSessionRepository } from "../../../database/repositories/factory.js";

describe("会话活动时间的持久化", () => {
  let adapter: TestSqliteDatabase;
  let snapshots: Array<Array<Record<string, unknown>>>;

  beforeEach(async () => {
    vi.useFakeTimers();
    adapter = new TestSqliteDatabase();
    database.context = await adapter.connect();
    adapter.getSqlite().exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, jwt_token TEXT NOT NULL,
        device_type TEXT NOT NULL, device_info TEXT NOT NULL,
        oidc_sub TEXT, oidc_sid TEXT, sso_provider_id INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    snapshots = [];
    DatabaseSaveTrigger.initialize(async () => {
      snapshots.push(
        adapter
          .getSqlite()
          .prepare("SELECT * FROM sessions ORDER BY id")
          .all() as Array<Record<string, unknown>>,
      );
    });
  });

  afterEach(async () => {
    DatabaseSaveTrigger.cleanup();
    await adapter.close();
    database.context = null;
    vi.useRealTimers();
  });

  async function createSession(
    id = "session-1",
    lastActiveAt = "2026-10-12T00:00:00.000Z",
  ) {
    await createCurrentSessionRepository().create({
      id,
      userId: "user-1",
      jwtToken: "original-token",
      deviceType: "desktop",
      deviceInfo: "test",
      expiresAt: "2026-10-13T00:00:00.000Z",
      lastActiveAt,
    });
  }

  it("并发请求跨仓库实例只更新一次，未到一分钟不更新且不回退时间", async () => {
    await createSession();
    snapshots.length = 0;
    const changesBefore = adapter
      .getSqlite()
      .prepare("SELECT total_changes() AS count")
      .get() as { count: number };
    await Promise.all(
      Array.from({ length: 20 }, () =>
        createCurrentSessionRepository().touch(
          "session-1",
          "2026-10-12T00:01:00.000Z",
        ),
      ),
    );
    await createCurrentSessionRepository().touch(
      "session-1",
      "2026-10-12T00:01:59.999Z",
    );
    await createCurrentSessionRepository().touch(
      "session-1",
      "2026-10-12T00:00:30.000Z",
    );
    const row = await createCurrentSessionRepository().findById("session-1");
    const changesAfter = adapter
      .getSqlite()
      .prepare("SELECT total_changes() AS count")
      .get() as { count: number };
    expect(changesAfter.count - changesBefore.count).toBe(1);
    expect(row?.lastActiveAt).toBe("2026-10-12T00:01:00.000Z");
    expect(row?.expiresAt).toBe("2026-10-13T00:00:00.000Z");
    expect(row?.jwtToken).toBe("original-token");
    expect(snapshots).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(snapshots).toHaveLength(1);
    await createCurrentSessionRepository().touch(
      "session-1",
      "2026-10-12T00:02:00.000Z",
    );
    expect(
      (await createCurrentSessionRepository().findById("session-1"))
        ?.lastActiveAt,
    ).toBe("2026-10-12T00:02:00.000Z");
  });

  it("多个会话的活动更新合并保存，兼容 SQLite 默认时间格式", async () => {
    await createSession("session-1", "2026-10-12 00:00:00");
    await createSession("session-2");
    snapshots.length = 0;
    await createCurrentSessionRepository().touch(
      "session-1",
      "2026-10-12T00:00:30.000Z",
    );
    expect(
      (await createCurrentSessionRepository().findById("session-1"))
        ?.lastActiveAt,
    ).toBe("2026-10-12 00:00:00");
    await createCurrentSessionRepository().touch(
      "session-1",
      "2026-10-12T00:01:00.000Z",
    );
    await createCurrentSessionRepository().touch(
      "session-2",
      "2026-10-12T00:01:00.000Z",
    );
    expect(snapshots).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].map((row) => row.last_active_at)).toEqual([
      "2026-10-12T00:01:00.000Z",
      "2026-10-12T00:01:00.000Z",
    ]);
  });

  it("不存在的会话不写盘，创建、令牌更新及撤销仍立即持久化", async () => {
    await createCurrentSessionRepository().touch(
      "missing",
      "2026-10-12T00:01:00.000Z",
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(snapshots).toHaveLength(0);
    await createSession();
    expect(snapshots).toHaveLength(1);
    await createCurrentSessionRepository().touch(
      "session-1",
      "2026-10-12T00:01:00.000Z",
    );
    await createCurrentSessionRepository().updateToken(
      "session-1",
      "new-token",
      "2026-10-12T00:01:01.000Z",
    );
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1][0].jwt_token).toBe("new-token");
    await createCurrentSessionRepository().revoke("session-1");
    expect(snapshots).toHaveLength(3);
    expect(snapshots[2]).toEqual([]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(snapshots).toHaveLength(3);
  });
});
