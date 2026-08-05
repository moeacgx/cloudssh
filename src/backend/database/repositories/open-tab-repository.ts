import { and, eq, exists, gt, inArray, not, or } from "drizzle-orm";
import { userOpenTabs, webTerminalSessions } from "../db/schema.js";
import type { DatabaseContext } from "./database-context.js";

export type OpenTabRecord = typeof userOpenTabs.$inferSelect;
export type NewOpenTabRecord = typeof userOpenTabs.$inferInsert;
export type OpenTabUpdate = Partial<
  Pick<NewOpenTabRecord, "label" | "tabOrder" | "backendSessionId">
>;

export type OpenTabUpsertInput = Pick<
  NewOpenTabRecord,
  "id" | "tabType" | "label" | "tabOrder"
> & {
  hostId?: number | null;
  backendSessionId?: string | null;
};

const SSH_TAB_TYPES = ["terminal", "ssh"] as const;

export class OpenTabRepository {
  constructor(
    private readonly context: DatabaseContext,
    private readonly onWrite?: () => void | Promise<void>,
  ) {}

  async listRecentForUser(
    userId: string,
    updatedAfter: string,
  ): Promise<OpenTabRecord[]> {
    return this.context.drizzle
      .select()
      .from(userOpenTabs)
      .where(
        and(
          eq(userOpenTabs.userId, userId),
          or(
            not(inArray(userOpenTabs.tabType, SSH_TAB_TYPES)),
            and(
              inArray(userOpenTabs.tabType, SSH_TAB_TYPES),
              or(
                gt(userOpenTabs.updatedAt, updatedAfter),
                exists(
                  this.context.drizzle
                    .select({ id: webTerminalSessions.id })
                    .from(webTerminalSessions)
                    .where(
                      and(
                        eq(webTerminalSessions.userId, userOpenTabs.userId),
                        eq(webTerminalSessions.tabInstanceId, userOpenTabs.id),
                      ),
                    ),
                ),
              ),
            ),
          ),
        ),
      )
      .orderBy(userOpenTabs.tabOrder);
  }

  async upsertForUser(
    userId: string,
    input: OpenTabUpsertInput,
    updatedAt = new Date().toISOString(),
  ): Promise<void> {
    const existing = await this.findByIdForUser(userId, input.id);
    if (existing) {
      await this.context.drizzle
        .update(userOpenTabs)
        .set({
          tabType: input.tabType,
          hostId: input.hostId ?? null,
          label: input.label,
          tabOrder: input.tabOrder,
          backendSessionId:
            input.backendSessionId !== undefined
              ? input.backendSessionId
              : existing.backendSessionId,
          updatedAt,
        })
        .where(
          and(eq(userOpenTabs.id, input.id), eq(userOpenTabs.userId, userId)),
        );
      await this.afterWrite();
      return;
    }

    await this.context.drizzle.insert(userOpenTabs).values({
      id: input.id,
      userId,
      tabType: input.tabType,
      hostId: input.hostId ?? null,
      label: input.label,
      tabOrder: input.tabOrder,
      backendSessionId: input.backendSessionId ?? null,
      updatedAt,
    });
    await this.afterWrite();
  }

  async replaceForUser(
    userId: string,
    tabs: OpenTabUpsertInput[],
    updatedAt = new Date().toISOString(),
  ): Promise<void> {
    this.context.drizzle.transaction((tx) => {
      const retainedIds = new Set(
        tx
          .select({ id: userOpenTabs.id })
          .from(userOpenTabs)
          .innerJoin(
            webTerminalSessions,
            and(
              eq(webTerminalSessions.userId, userOpenTabs.userId),
              eq(webTerminalSessions.tabInstanceId, userOpenTabs.id),
            ),
          )
          .where(eq(userOpenTabs.userId, userId))
          .all()
          .map((row) => row.id),
      );

      const deleteCondition =
        retainedIds.size === 0
          ? eq(userOpenTabs.userId, userId)
          : and(
              eq(userOpenTabs.userId, userId),
              not(inArray(userOpenTabs.id, [...retainedIds])),
            );
      tx.delete(userOpenTabs).where(deleteCondition).run();

      const tabsToInsert: OpenTabUpsertInput[] = [];
      for (const tab of tabs) {
        if (!retainedIds.has(tab.id)) {
          tabsToInsert.push(tab);
          continue;
        }
        tx.update(userOpenTabs)
          .set({
            tabType: tab.tabType,
            hostId: tab.hostId ?? null,
            label: tab.label,
            tabOrder: tab.tabOrder,
            backendSessionId: tab.backendSessionId ?? null,
            updatedAt,
          })
          .where(
            and(eq(userOpenTabs.id, tab.id), eq(userOpenTabs.userId, userId)),
          )
          .run();
      }

      if (tabsToInsert.length > 0) {
        tx.insert(userOpenTabs)
          .values(
            tabsToInsert.map((tab) => ({
              id: tab.id,
              userId,
              tabType: tab.tabType,
              hostId: tab.hostId ?? null,
              label: tab.label,
              tabOrder: tab.tabOrder,
              backendSessionId: tab.backendSessionId ?? null,
              updatedAt,
            })),
          )
          .run();
      }
    });

    await this.afterWrite();
  }

  async updateForUser(
    userId: string,
    id: string,
    update: OpenTabUpdate,
    updatedAt = new Date().toISOString(),
  ): Promise<boolean> {
    const rows = await this.context.drizzle
      .update(userOpenTabs)
      .set({ ...update, updatedAt })
      .where(and(eq(userOpenTabs.id, id), eq(userOpenTabs.userId, userId)))
      .returning({ id: userOpenTabs.id });

    if (rows.length > 0) {
      await this.afterWrite();
    }

    return rows.length > 0;
  }

  async deleteForUser(userId: string, id: string): Promise<number> {
    const rows = await this.context.drizzle
      .delete(userOpenTabs)
      .where(and(eq(userOpenTabs.id, id), eq(userOpenTabs.userId, userId)))
      .returning({ id: userOpenTabs.id });

    if (rows.length > 0) {
      await this.afterWrite();
    }

    return rows.length;
  }

  async deleteByUserId(userId: string): Promise<number> {
    const rows = await this.context.drizzle
      .delete(userOpenTabs)
      .where(eq(userOpenTabs.userId, userId))
      .returning({ id: userOpenTabs.id });

    if (rows.length > 0) {
      await this.afterWrite();
    }

    return rows.length;
  }

  async findByIdForUser(
    userId: string,
    id: string,
  ): Promise<OpenTabRecord | null> {
    const rows = await this.context.drizzle
      .select()
      .from(userOpenTabs)
      .where(and(eq(userOpenTabs.id, id), eq(userOpenTabs.userId, userId)))
      .limit(1);

    return rows[0] ?? null;
  }

  private async afterWrite(): Promise<void> {
    await this.onWrite?.();
  }
}
