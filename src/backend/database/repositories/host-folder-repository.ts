import { and, eq, or, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { hosts, sshCredentials, sshFolders } from "../db/schema.js";
import type { DatabaseContext } from "./database-context.js";

export type HostFolderRecord = typeof sshFolders.$inferSelect;
export type HostFolderHostRecord = typeof hosts.$inferSelect;

export interface RenameFolderResult {
  updatedHosts: number;
  updatedCredentials: number;
}

export class FolderHostsHavePersistentSessionsError extends Error {
  constructor(readonly count: number) {
    super("Folder hosts still have persistent sessions");
    this.name = "FolderHostsHavePersistentSessionsError";
  }
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function descendantFolderPattern(folderName: string): string {
  return `${escapeLikePattern(folderName)} / %`;
}

export class HostFolderRepository {
  constructor(
    private readonly context: DatabaseContext,
    private readonly onWrite?: () => void | Promise<void>,
  ) {}

  async renameFolder(
    userId: string,
    oldName: string,
    newName: string,
    now = new Date().toISOString(),
  ): Promise<RenameFolderResult> {
    const oldPrefix = `${oldName} / `;
    const newPrefix = `${newName} / `;
    const childLike = `${escapeLikePattern(oldPrefix)}%`;
    const renameExpr = (col: SQLiteColumn) =>
      sql`CASE WHEN ${col} = ${oldName} THEN ${newName} ELSE ${newPrefix} || substr(${col}, ${oldPrefix.length + 1}) END`;
    const folderMatch = (col: SQLiteColumn) =>
      or(eq(col, oldName), sql`${col} LIKE ${childLike} ESCAPE '\\'`);

    const result = this.context.drizzle.transaction((tx) => {
      const updatedHosts = tx
        .update(hosts)
        .set({ folder: renameExpr(hosts.folder), updatedAt: now })
        .where(and(eq(hosts.userId, userId), folderMatch(hosts.folder)))
        .returning({ id: hosts.id })
        .all();

      const updatedCredentials = tx
        .update(sshCredentials)
        .set({ folder: renameExpr(sshCredentials.folder), updatedAt: now })
        .where(
          and(
            eq(sshCredentials.userId, userId),
            folderMatch(sshCredentials.folder),
          ),
        )
        .returning({ id: sshCredentials.id })
        .all();

      tx.update(sshFolders)
        .set({ name: renameExpr(sshFolders.name), updatedAt: now })
        .where(and(eq(sshFolders.userId, userId), folderMatch(sshFolders.name)))
        .run();
      return { updatedHosts, updatedCredentials };
    });

    await this.afterWrite();
    return {
      updatedHosts: result.updatedHosts.length,
      updatedCredentials: result.updatedCredentials.length,
    };
  }

  async listFolders(userId: string): Promise<HostFolderRecord[]> {
    return this.context.drizzle
      .select()
      .from(sshFolders)
      .where(eq(sshFolders.userId, userId));
  }

  async upsertMetadata(
    userId: string,
    name: string,
    color: string | null | undefined,
    icon: string | null | undefined,
    credentialId?: number | null,
    now = new Date().toISOString(),
  ): Promise<{ folder: HostFolderRecord; created: boolean }> {
    const existing = await this.findFolder(userId, name);
    if (existing) {
      const [updated] = await this.context.drizzle
        .update(sshFolders)
        .set({
          color,
          icon,
          credentialId:
            credentialId === undefined ? existing.credentialId : credentialId,
          updatedAt: now,
        })
        .where(and(eq(sshFolders.userId, userId), eq(sshFolders.name, name)))
        .returning();

      await this.afterWrite();
      return { folder: updated, created: false };
    }

    const [created] = await this.context.drizzle
      .insert(sshFolders)
      .values({
        syncId: randomUUID(),
        userId,
        name,
        color,
        icon,
        credentialId: credentialId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    await this.afterWrite();
    return { folder: created, created: true };
  }

  async listHostsInFolder(
    userId: string,
    folderName: string,
  ): Promise<HostFolderHostRecord[]> {
    const folderMatch = (col: SQLiteColumn) =>
      or(
        eq(col, folderName),
        sql`${col} LIKE ${descendantFolderPattern(folderName)} ESCAPE '\\'`,
      );

    return this.context.drizzle
      .select()
      .from(hosts)
      .where(and(eq(hosts.userId, userId), folderMatch(hosts.folder)));
  }

  async deleteHostsAndFolderRecords(
    userId: string,
    folderName: string,
  ): Promise<{ hostSyncIds: string[]; folderSyncIds: string[] }> {
    const sqlite = this.context.sqlite;
    if (!sqlite) throw new Error("SQLite connection is unavailable");
    const pattern = descendantFolderPattern(folderName);

    const result = sqlite.transaction(() => {
      const hostsToDelete = sqlite
        .prepare(
          `SELECT id, sync_id AS syncId FROM ssh_data
            WHERE user_id = ?
              AND (folder = ? OR folder LIKE ? ESCAPE '\\')`,
        )
        .all(userId, folderName, pattern) as Array<{
        id: number;
        syncId: string | null;
      }>;
      const deletedFolders = sqlite
        .prepare(
          `SELECT sync_id AS syncId FROM ssh_folders
            WHERE user_id = ?
              AND (name = ? OR name LIKE ? ESCAPE '\\')`,
        )
        .all(userId, folderName, pattern) as Array<{
        syncId: string | null;
      }>;

      const hostIds = hostsToDelete.map((host) => host.id);
      if (hostIds.length > 0) {
        const placeholders = hostIds.map(() => "?").join(",");
        const persistent = sqlite
          .prepare(
            `SELECT COUNT(*) AS count
               FROM persistent_sessions session
               JOIN project_hosts project_host
                 ON project_host.id = session.project_host_id
              WHERE project_host.host_id IN (${placeholders})`,
          )
          .get(...hostIds) as { count: number };
        if (persistent.count > 0) {
          throw new FolderHostsHavePersistentSessionsError(persistent.count);
        }

        for (const table of [
          "file_manager_recent",
          "file_manager_pinned",
          "file_manager_shortcuts",
          "command_history",
          "ssh_credential_usage",
          "recent_activity",
          "host_access",
          "session_recordings",
        ]) {
          sqlite
            .prepare(`DELETE FROM ${table} WHERE host_id IN (${placeholders})`)
            .run(...hostIds);
        }
        sqlite
          .prepare(
            `DELETE FROM transfer_recent
              WHERE source_host_id IN (${placeholders})
                 OR dest_host_id IN (${placeholders})`,
          )
          .run(...hostIds, ...hostIds);
        sqlite
          .prepare(
            `DELETE FROM ssh_data
              WHERE user_id = ? AND id IN (${placeholders})`,
          )
          .run(userId, ...hostIds);
      }

      sqlite
        .prepare(
          `DELETE FROM ssh_folders
            WHERE user_id = ?
              AND (name = ? OR name LIKE ? ESCAPE '\\')`,
        )
        .run(userId, folderName, pattern);

      const tombstone = sqlite.prepare(
        `INSERT INTO sync_tombstones (user_id, entity_type, sync_id)
         VALUES (?, ?, ?)`,
      );
      for (const host of hostsToDelete) {
        if (host.syncId) tombstone.run(userId, "hosts", host.syncId);
      }
      for (const folder of deletedFolders) {
        if (folder.syncId) tombstone.run(userId, "sshFolders", folder.syncId);
      }

      return { hostsToDelete, deletedFolders };
    })();

    await this.afterWrite();

    return {
      hostSyncIds: result.hostsToDelete
        .map((h) => h.syncId)
        .filter((id): id is string => !!id),
      folderSyncIds: result.deletedFolders
        .map((f) => f.syncId)
        .filter((id): id is string => !!id),
    };
  }

  async deleteByUserId(userId: string): Promise<number> {
    const rows = await this.context.drizzle
      .delete(sshFolders)
      .where(eq(sshFolders.userId, userId))
      .returning({ id: sshFolders.id });

    if (rows.length > 0) {
      await this.afterWrite();
    }

    return rows.length;
  }

  private async findFolder(
    userId: string,
    name: string,
  ): Promise<HostFolderRecord | null> {
    const rows = await this.context.drizzle
      .select()
      .from(sshFolders)
      .where(and(eq(sshFolders.userId, userId), eq(sshFolders.name, name)))
      .limit(1);

    return rows[0] ?? null;
  }

  private async afterWrite(): Promise<void> {
    await this.onWrite?.();
  }
}
