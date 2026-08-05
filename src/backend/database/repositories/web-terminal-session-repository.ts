import { and, desc, eq, inArray } from "drizzle-orm";
import { webTerminalSessions } from "../db/schema.js";
import type { DatabaseContext } from "./database-context.js";

export type WebTerminalSessionRecord = typeof webTerminalSessions.$inferSelect;

export interface WebTerminalSessionInput {
  id: string;
  userId: string;
  hostId: number;
  projectHostId?: number | null;
  tabInstanceId: string;
  tmuxName: string;
  targetFingerprint: string;
  columns: number;
  rows: number;
  createdAt?: string;
  lastAttachedAt?: string | null;
  lastDetachedAt?: string | null;
}

export interface WebTerminalRecoveryIdentity {
  id: string;
  userId: string;
  hostId: number;
  tabInstanceId: string;
}

export class WebTerminalSessionRepository {
  constructor(
    private readonly context: DatabaseContext,
    private readonly onWrite?: () => void | Promise<void>,
  ) {}

  async upsert(
    input: WebTerminalSessionInput,
    now = new Date().toISOString(),
  ): Promise<WebTerminalSessionRecord> {
    const rows = await this.context.drizzle
      .insert(webTerminalSessions)
      .values({
        ...input,
        projectHostId: input.projectHostId ?? null,
        createdAt: input.createdAt ?? now,
        lastAttachedAt: input.lastAttachedAt ?? now,
        lastDetachedAt: input.lastDetachedAt ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: webTerminalSessions.id,
        set: {
          hostId: input.hostId,
          projectHostId: input.projectHostId ?? null,
          tabInstanceId: input.tabInstanceId,
          tmuxName: input.tmuxName,
          targetFingerprint: input.targetFingerprint,
          columns: input.columns,
          rows: input.rows,
          lastAttachedAt: input.lastAttachedAt ?? now,
          lastDetachedAt: input.lastDetachedAt ?? null,
          updatedAt: now,
        },
        setWhere: eq(webTerminalSessions.userId, input.userId),
      })
      .returning();
    if (!rows[0]) {
      throw new Error("Terminal session ID belongs to another user");
    }
    await this.afterWrite();
    return rows[0];
  }

  async findOwned(
    userId: string,
    id: string,
  ): Promise<WebTerminalSessionRecord | null> {
    const rows = await this.context.drizzle
      .select()
      .from(webTerminalSessions)
      .where(
        and(
          eq(webTerminalSessions.id, id),
          eq(webTerminalSessions.userId, userId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async findForRecovery(
    identity: WebTerminalRecoveryIdentity,
  ): Promise<WebTerminalSessionRecord | null> {
    const rows = await this.context.drizzle
      .select()
      .from(webTerminalSessions)
      .where(
        and(
          eq(webTerminalSessions.id, identity.id),
          eq(webTerminalSessions.userId, identity.userId),
          eq(webTerminalSessions.hostId, identity.hostId),
          eq(webTerminalSessions.tabInstanceId, identity.tabInstanceId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  listOwned(userId: string): Promise<WebTerminalSessionRecord[]> {
    return this.context.drizzle
      .select()
      .from(webTerminalSessions)
      .where(eq(webTerminalSessions.userId, userId))
      .orderBy(desc(webTerminalSessions.updatedAt));
  }

  listForHost(hostId: number): Promise<WebTerminalSessionRecord[]> {
    return this.context.drizzle
      .select()
      .from(webTerminalSessions)
      .where(eq(webTerminalSessions.hostId, hostId))
      .orderBy(desc(webTerminalSessions.updatedAt));
  }

  listForHosts(hostIds: number[]): Promise<WebTerminalSessionRecord[]> {
    if (hostIds.length === 0) return Promise.resolve([]);
    return this.context.drizzle
      .select()
      .from(webTerminalSessions)
      .where(inArray(webTerminalSessions.hostId, hostIds))
      .orderBy(desc(webTerminalSessions.updatedAt));
  }

  async markAttached(
    userId: string,
    id: string,
    columns: number,
    rows: number,
    now = new Date().toISOString(),
  ): Promise<boolean> {
    const updated = await this.context.drizzle
      .update(webTerminalSessions)
      .set({
        columns,
        rows,
        lastAttachedAt: now,
        lastDetachedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(webTerminalSessions.id, id),
          eq(webTerminalSessions.userId, userId),
        ),
      )
      .returning({ id: webTerminalSessions.id });
    if (updated.length > 0) await this.afterWrite();
    return updated.length > 0;
  }

  async markDetached(
    userId: string,
    id: string,
    now = new Date().toISOString(),
  ): Promise<boolean> {
    const updated = await this.context.drizzle
      .update(webTerminalSessions)
      .set({ lastDetachedAt: now, updatedAt: now })
      .where(
        and(
          eq(webTerminalSessions.id, id),
          eq(webTerminalSessions.userId, userId),
        ),
      )
      .returning({ id: webTerminalSessions.id });
    if (updated.length > 0) await this.afterWrite();
    return updated.length > 0;
  }

  async deleteOwned(userId: string, id: string): Promise<boolean> {
    const deleted = await this.context.drizzle
      .delete(webTerminalSessions)
      .where(
        and(
          eq(webTerminalSessions.id, id),
          eq(webTerminalSessions.userId, userId),
        ),
      )
      .returning({ id: webTerminalSessions.id });
    if (deleted.length > 0) await this.afterWrite();
    return deleted.length > 0;
  }

  private async afterWrite(): Promise<void> {
    await this.onWrite?.();
  }
}
