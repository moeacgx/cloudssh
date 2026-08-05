import { afterEach, describe, expect, it } from "vitest";
import { TestSqliteDatabase } from "./test-support.js";
import { WebTerminalSessionRepository } from "../../../database/repositories/web-terminal-session-repository.js";

describe("WebTerminalSessionRepository", () => {
  let adapter: TestSqliteDatabase | null = null;

  afterEach(async () => {
    await adapter?.close();
    adapter = null;
  });

  async function createRepository(
    onWrite?: () => void | Promise<void>,
  ): Promise<{ repository: WebTerminalSessionRepository; columns: string[] }> {
    adapter = new TestSqliteDatabase();
    const context = await adapter.connect();
    context.sqlite?.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL
      );
      CREATE TABLE ssh_data (
        id INTEGER PRIMARY KEY,
        user_id TEXT NOT NULL,
        ip TEXT NOT NULL,
        port INTEGER NOT NULL,
        username TEXT NOT NULL,
        auth_type TEXT NOT NULL
      );
      CREATE TABLE web_terminal_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        host_id INTEGER NOT NULL,
        project_host_id INTEGER,
        tab_instance_id TEXT NOT NULL,
        tmux_name TEXT NOT NULL,
        target_fingerprint TEXT,
        columns INTEGER NOT NULL DEFAULT 80,
        rows INTEGER NOT NULL DEFAULT 24,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_attached_at TEXT,
        last_detached_at TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX uq_web_terminal_sessions_user_tab
        ON web_terminal_sessions (user_id, tab_instance_id);
      CREATE UNIQUE INDEX uq_web_terminal_sessions_host_tmux
        ON web_terminal_sessions (host_id, tmux_name);
      INSERT INTO users (id, username, password_hash)
      VALUES ('user-1', 'alice', 'hash'), ('user-2', 'bob', 'hash');
      INSERT INTO ssh_data (id, user_id, ip, port, username, auth_type)
      VALUES (1, 'user-1', '127.0.0.1', 22, 'alice', 'none');
    `);

    const columns = (
      context.sqlite
        ?.prepare("PRAGMA table_info(web_terminal_sessions)")
        .all() as Array<{
        name: string;
      }>
    ).map((column) => column.name);
    return {
      repository: new WebTerminalSessionRepository(context, onWrite),
      columns,
    };
  }

  const fixedInput = {
    id: "session-1",
    userId: "user-1",
    hostId: 1,
    projectHostId: 17,
    tabInstanceId: "tab-1",
    tmuxName: "cloudssh-web-session-1",
    targetFingerprint: "sha256:test-target-fingerprint",
    columns: 120,
    rows: 40,
  };

  it("只保存恢复元数据，不包含任何凭据字段", async () => {
    const { repository, columns } = await createRepository();
    await repository.upsert(fixedInput, "2026-07-31T00:00:00.000Z");

    expect(columns).not.toContain("password");
    expect(columns).not.toContain("private_key");
    expect(columns).not.toContain("token");
    expect(await repository.findOwned("user-1", "session-1")).toMatchObject({
      ...fixedInput,
      lastAttachedAt: "2026-07-31T00:00:00.000Z",
      lastDetachedAt: null,
    });
  });

  it("恢复时同时校验用户、会话、主机和标签实例", async () => {
    const { repository } = await createRepository();
    await repository.upsert(fixedInput);

    await expect(
      repository.findForRecovery({
        id: "session-1",
        userId: "user-1",
        hostId: 1,
        tabInstanceId: "tab-1",
      }),
    ).resolves.toMatchObject({ tmuxName: fixedInput.tmuxName });

    for (const mismatch of [
      { id: "other", userId: "user-1", hostId: 1, tabInstanceId: "tab-1" },
      { id: "session-1", userId: "user-2", hostId: 1, tabInstanceId: "tab-1" },
      { id: "session-1", userId: "user-1", hostId: 2, tabInstanceId: "tab-1" },
      { id: "session-1", userId: "user-1", hostId: 1, tabInstanceId: "tab-2" },
    ]) {
      await expect(repository.findForRecovery(mismatch)).resolves.toBeNull();
    }
  });

  it("记录最新附着和断开时间，并按所有者删除", async () => {
    let writes = 0;
    const { repository } = await createRepository(() => {
      writes += 1;
    });
    await repository.upsert(fixedInput, "2026-07-31T00:00:00.000Z");
    await repository.markDetached(
      "user-1",
      "session-1",
      "2026-07-31T01:00:00.000Z",
    );
    await repository.markAttached(
      "user-1",
      "session-1",
      160,
      50,
      "2026-07-31T02:00:00.000Z",
    );

    expect(await repository.findOwned("user-1", "session-1")).toMatchObject({
      columns: 160,
      rows: 50,
      lastAttachedAt: "2026-07-31T02:00:00.000Z",
      lastDetachedAt: null,
    });
    await expect(repository.deleteOwned("user-2", "session-1")).resolves.toBe(
      false,
    );
    await expect(repository.deleteOwned("user-1", "session-1")).resolves.toBe(
      true,
    );
    expect(writes).toBe(4);
  });

  it("拒绝跨用户使用同一会话 ID 覆盖恢复元数据", async () => {
    let writes = 0;
    const { repository } = await createRepository(() => {
      writes += 1;
    });
    await repository.upsert(fixedInput, "2026-07-31T00:00:00.000Z");

    await expect(
      repository.upsert(
        {
          ...fixedInput,
          userId: "user-2",
          hostId: 2,
          projectHostId: 18,
          tabInstanceId: "foreign-tab",
          tmuxName: "cloudssh-web-foreign",
          targetFingerprint: "sha256:foreign",
        },
        "2026-07-31T01:00:00.000Z",
      ),
    ).rejects.toThrow("Terminal session ID belongs to another user");

    expect(await repository.findOwned("user-1", "session-1")).toMatchObject({
      ...fixedInput,
      updatedAt: "2026-07-31T00:00:00.000Z",
    });
    await expect(
      repository.findOwned("user-2", "session-1"),
    ).resolves.toBeNull();
    expect(writes).toBe(1);
  });

  it("可按主机批量发现固定窗口，供删除前保护", async () => {
    const { repository } = await createRepository();
    await repository.upsert(fixedInput);

    await expect(repository.listForHost(1)).resolves.toEqual([
      expect.objectContaining({ id: "session-1", hostId: 1 }),
    ]);
    await expect(repository.listForHost(2)).resolves.toEqual([]);
    await expect(repository.listForHosts([1, 2])).resolves.toHaveLength(1);
    await expect(repository.listForHosts([])).resolves.toEqual([]);
  });
});
