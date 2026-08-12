import { and, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  hostAccess,
  hosts,
  projectFolders,
  projectHosts,
  projects,
} from "../db/schema.js";
import type { DatabaseContext } from "./database-context.js";
import { DataCrypto } from "../../utils/data-crypto.js";

export type HostRecord = typeof hosts.$inferSelect;
export type NewHostRecord = typeof hosts.$inferInsert;
export type HostUpdate = Partial<Omit<NewHostRecord, "id" | "userId">>;
export interface HostBulkUpdateState {
  id: number;
  statsConfig: string | null;
  credentialId: number | null;
  proxmoxConfig: string | null;
}

export interface PersonalProjectHostMetadataUpdate {
  projectHostId: number;
  alias: string | null;
  folder: string | null;
  tags?: string | null;
}

export interface ProjectHostMetadataUpdate extends PersonalProjectHostMetadataUpdate {
  projectId: string;
}

export interface PersonalProjectHostCreateMetadata {
  alias: string | null;
  folder: string | null;
  tags?: string | null;
  addedBy: string;
}

export interface ProjectHostCreateMetadata extends PersonalProjectHostCreateMetadata {
  projectId: string;
}

export class PersonalProjectNotFoundError extends Error {
  constructor() {
    super("Personal workspace not found");
    this.name = "PersonalProjectNotFoundError";
  }
}

export class PersonalProjectHostLinkNotFoundError extends Error {
  constructor() {
    super("Personal workspace host link not found");
    this.name = "PersonalProjectHostLinkNotFoundError";
  }
}

export class ProjectHostLinkNotFoundError extends Error {
  constructor() {
    super("Project host link not found");
    this.name = "ProjectHostLinkNotFoundError";
  }
}

export class ProjectHostCreateTargetNotFoundError extends Error {
  constructor() {
    super("Project host creation target not found");
    this.name = "ProjectHostCreateTargetNotFoundError";
  }
}

export class HostHasPersistentSessionsError extends Error {
  constructor(readonly count: number) {
    super("Host still has persistent sessions");
    this.name = "HostHasPersistentSessionsError";
  }
}

export class HostRepository {
  constructor(
    private readonly context: DatabaseContext,
    private readonly onWrite?: () => void | Promise<void>,
  ) {}

  async create(host: NewHostRecord): Promise<HostRecord> {
    const rows = await this.context.drizzle
      .insert(hosts)
      .values({ syncId: randomUUID(), ...host })
      .returning();
    await this.afterWrite();
    return rows[0];
  }

  async createEncryptedForUser(
    userId: string,
    host: NewHostRecord | Record<string, unknown>,
  ): Promise<HostRecord> {
    const userDataKey = DataCrypto.validateUserAccess(userId);
    const tempId = host.id ?? Date.now();
    const dataWithTempId = {
      syncId: randomUUID(),
      ...host,
      id: tempId,
    };
    const encryptedHost = DataCrypto.encryptRecord(
      "ssh_data",
      dataWithTempId,
      userId,
      userDataKey,
    );

    if (!host.id) {
      delete (encryptedHost as Partial<NewHostRecord>).id;
    }

    const rows = await this.context.drizzle
      .insert(hosts)
      .values(encryptedHost as NewHostRecord)
      .returning();

    await this.afterWrite();
    return DataCrypto.decryptRecord("ssh_data", rows[0], userId, userDataKey);
  }

  async createEncryptedForUserWithPersonalProject(
    userId: string,
    host: NewHostRecord | Record<string, unknown>,
    metadata: PersonalProjectHostCreateMetadata,
  ): Promise<{ host: HostRecord; projectHostId: number }> {
    return this.createEncryptedForUserWithProjectTarget(
      userId,
      host,
      metadata,
      {
        personalProjectOwnerId: userId,
      },
    );
  }

  async createEncryptedForUserWithProject(
    userId: string,
    host: NewHostRecord | Record<string, unknown>,
    metadata: ProjectHostCreateMetadata,
  ): Promise<{ host: HostRecord; projectHostId: number }> {
    return this.createEncryptedForUserWithProjectTarget(
      userId,
      host,
      metadata,
      {
        projectId: metadata.projectId,
      },
    );
  }

  private async createEncryptedForUserWithProjectTarget(
    userId: string,
    host: NewHostRecord | Record<string, unknown>,
    metadata: PersonalProjectHostCreateMetadata,
    target: { projectId: string } | { personalProjectOwnerId: string },
  ): Promise<{ host: HostRecord; projectHostId: number }> {
    const userDataKey = DataCrypto.validateUserAccess(userId);
    const tempId = host.id ?? Date.now();
    const encryptedHost = DataCrypto.encryptRecord(
      "ssh_data",
      { syncId: randomUUID(), ...host, id: tempId },
      userId,
      userDataKey,
    ) as NewHostRecord;
    if (!host.id) delete (encryptedHost as Partial<NewHostRecord>).id;

    const created = this.context.drizzle.transaction((tx) => {
      const project = tx
        .select({ id: projects.id })
        .from(projects)
        .where(
          "projectId" in target
            ? eq(projects.id, target.projectId)
            : and(
                eq(projects.ownerUserId, target.personalProjectOwnerId),
                eq(projects.kind, "personal"),
              ),
        )
        .limit(1)
        .all()[0];
      if (!project) {
        throw "projectId" in target
          ? new ProjectHostCreateTargetNotFoundError()
          : new PersonalProjectNotFoundError();
      }

      const createdHost = tx
        .insert(hosts)
        .values(encryptedHost)
        .returning()
        .all()[0];
      if (!createdHost) throw new Error("Failed to create host");

      if (metadata.folder) {
        tx.insert(projectFolders)
          .values({ projectId: project.id, path: metadata.folder })
          .onConflictDoNothing()
          .run();
      }
      const link = tx
        .insert(projectHosts)
        .values({
          projectId: project.id,
          hostId: createdHost.id,
          alias: metadata.alias,
          folder: metadata.folder,
          tags: metadata.tags ?? null,
          addedBy: metadata.addedBy,
        })
        .returning({ id: projectHosts.id })
        .all()[0];
      if (!link) throw new Error("Failed to link host to personal workspace");

      return { host: createdHost, projectHostId: link.id };
    });

    await this.afterWrite();
    return {
      host: DataCrypto.decryptRecord(
        "ssh_data",
        created.host,
        userId,
        userDataKey,
      ),
      projectHostId: created.projectHostId,
    };
  }

  async findById(id: number): Promise<HostRecord | null> {
    const rows = await this.context.drizzle
      .select()
      .from(hosts)
      .where(eq(hosts.id, id))
      .limit(1);

    return rows[0] ?? null;
  }

  async findByIdForUser(
    userId: string,
    hostId: number,
  ): Promise<HostRecord | null> {
    const rows = await this.context.drizzle
      .select()
      .from(hosts)
      .where(and(eq(hosts.id, hostId), eq(hosts.userId, userId)))
      .limit(1);

    return rows[0] ?? null;
  }

  async findDecryptedByIdAs(
    userId: string,
    hostId: number,
  ): Promise<HostRecord | null> {
    const row = await this.findById(hostId);
    if (!row) return null;

    const userDataKey = DataCrypto.getUserDataKey(userId);
    if (!userDataKey) return null;

    return DataCrypto.decryptRecord("ssh_data", row, userId, userDataKey);
  }

  async listProxmoxEnabled(): Promise<
    Pick<HostRecord, "id" | "userId" | "proxmoxConfig">[]
  > {
    return this.context.drizzle
      .select({
        id: hosts.id,
        userId: hosts.userId,
        proxmoxConfig: hosts.proxmoxConfig,
      })
      .from(hosts)
      .where(eq(hosts.enableProxmox, true));
  }

  async listByUserId(userId: string): Promise<HostRecord[]> {
    return this.context.drizzle
      .select()
      .from(hosts)
      .where(eq(hosts.userId, userId));
  }

  async listDecryptedByUserId(userId: string): Promise<HostRecord[]> {
    const rows = await this.listByUserId(userId);
    const userDataKey = DataCrypto.getUserDataKey(userId);
    if (!userDataKey) return [];
    return DataCrypto.decryptRecords("ssh_data", rows, userId, userDataKey);
  }

  async existsForImportIdentity(
    userId: string,
    ip: string,
    port: number,
    username: string,
  ): Promise<boolean> {
    const rows = await this.context.drizzle
      .select({ id: hosts.id })
      .from(hosts)
      .where(
        and(
          eq(hosts.userId, userId),
          eq(hosts.ip, ip),
          eq(hosts.port, port),
          eq(hosts.username, username),
        ),
      )
      .limit(1);

    return rows.length > 0;
  }

  async updateForUser(
    userId: string,
    hostId: number,
    update: HostUpdate,
  ): Promise<HostRecord | null> {
    const rows = await this.context.drizzle
      .update(hosts)
      .set({ ...update, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(and(eq(hosts.id, hostId), eq(hosts.userId, userId)))
      .returning();

    await this.afterWrite();
    return rows[0] ?? null;
  }

  async updateEncryptedForUser(
    userId: string,
    hostId: number,
    update: HostUpdate,
  ): Promise<HostRecord | null> {
    const userDataKey = DataCrypto.validateUserAccess(userId);
    const encryptedUpdate = DataCrypto.encryptRecord(
      "ssh_data",
      update,
      userId,
      userDataKey,
    );

    const rows = await this.context.drizzle
      .update(hosts)
      .set({ ...encryptedUpdate, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(and(eq(hosts.id, hostId), eq(hosts.userId, userId)))
      .returning();

    await this.afterWrite();
    return rows[0]
      ? DataCrypto.decryptRecord("ssh_data", rows[0], userId, userDataKey)
      : null;
  }

  async updateEncryptedForUserWithPersonalProjectMetadata(
    hostOwnerId: string,
    personalProjectOwnerId: string,
    hostId: number,
    update: HostUpdate,
    metadata: PersonalProjectHostMetadataUpdate,
  ): Promise<HostRecord | null> {
    return this.updateEncryptedForUserWithProjectMetadataTarget(
      hostOwnerId,
      hostId,
      update,
      metadata,
      { personalProjectOwnerId },
    );
  }

  async updateEncryptedForUserWithProjectMetadata(
    hostOwnerId: string,
    hostId: number,
    update: HostUpdate,
    metadata: ProjectHostMetadataUpdate,
  ): Promise<HostRecord | null> {
    return this.updateEncryptedForUserWithProjectMetadataTarget(
      hostOwnerId,
      hostId,
      update,
      metadata,
      { projectId: metadata.projectId },
    );
  }

  // Project administrators may edit shared project host feature flags without
  // holding the host owner's DEK. Callers must pass only non-secret plaintext
  // columns; this method keeps the host update and project metadata atomic.
  async updateNonSensitiveForUserWithProjectMetadata(
    hostOwnerId: string,
    hostId: number,
    update: HostUpdate,
    metadata: ProjectHostMetadataUpdate,
  ): Promise<HostRecord | null> {
    const updated = this.context.drizzle.transaction((tx) => {
      const link = tx
        .select({
          id: projectHosts.id,
          projectId: projectHosts.projectId,
        })
        .from(projectHosts)
        .innerJoin(projects, eq(projectHosts.projectId, projects.id))
        .where(
          and(
            eq(projectHosts.id, metadata.projectHostId),
            eq(projectHosts.hostId, hostId),
            eq(projects.id, metadata.projectId),
          ),
        )
        .limit(1)
        .all()[0];

      if (!link) {
        throw new ProjectHostLinkNotFoundError();
      }

      const hostRow =
        Object.keys(update).length > 0
          ? tx
              .update(hosts)
              .set({ ...update, updatedAt: sql`CURRENT_TIMESTAMP` })
              .where(and(eq(hosts.id, hostId), eq(hosts.userId, hostOwnerId)))
              .returning()
              .all()[0]
          : tx
              .select()
              .from(hosts)
              .where(and(eq(hosts.id, hostId), eq(hosts.userId, hostOwnerId)))
              .limit(1)
              .all()[0];
      if (!hostRow) return null;

      if (metadata.folder) {
        tx.insert(projectFolders)
          .values({ projectId: link.projectId, path: metadata.folder })
          .onConflictDoNothing()
          .run();
      }
      const metadataUpdate = {
        alias: metadata.alias,
        folder: metadata.folder,
        ...(metadata.tags !== undefined ? { tags: metadata.tags } : {}),
      };
      tx.update(projectHosts)
        .set(metadataUpdate)
        .where(
          and(
            eq(projectHosts.id, link.id),
            eq(projectHosts.projectId, link.projectId),
          ),
        )
        .run();

      return hostRow;
    });

    if (!updated) return null;
    await this.afterWrite();
    return updated;
  }

  private async updateEncryptedForUserWithProjectMetadataTarget(
    hostOwnerId: string,
    hostId: number,
    update: HostUpdate,
    metadata: PersonalProjectHostMetadataUpdate,
    target: { projectId: string } | { personalProjectOwnerId: string },
  ): Promise<HostRecord | null> {
    const userDataKey = DataCrypto.validateUserAccess(hostOwnerId);
    const encryptedUpdate = DataCrypto.encryptRecord(
      "ssh_data",
      update,
      hostOwnerId,
      userDataKey,
    );

    const updated = this.context.drizzle.transaction((tx) => {
      const projectCondition =
        "projectId" in target
          ? eq(projects.id, target.projectId)
          : and(
              eq(projects.kind, "personal"),
              eq(projects.ownerUserId, target.personalProjectOwnerId),
            );
      const link = tx
        .select({
          id: projectHosts.id,
          projectId: projectHosts.projectId,
        })
        .from(projectHosts)
        .innerJoin(projects, eq(projectHosts.projectId, projects.id))
        .where(
          and(
            eq(projectHosts.id, metadata.projectHostId),
            eq(projectHosts.hostId, hostId),
            projectCondition,
          ),
        )
        .limit(1)
        .all()[0];

      if (!link) {
        throw "personalProjectOwnerId" in target
          ? new PersonalProjectHostLinkNotFoundError()
          : new ProjectHostLinkNotFoundError();
      }

      const rows = tx
        .update(hosts)
        .set({ ...encryptedUpdate, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(and(eq(hosts.id, hostId), eq(hosts.userId, hostOwnerId)))
        .returning()
        .all();
      if (!rows[0]) return null;

      if (metadata.folder) {
        tx.insert(projectFolders)
          .values({ projectId: link.projectId, path: metadata.folder })
          .onConflictDoNothing()
          .run();
      }
      const metadataUpdate = {
        alias: metadata.alias,
        folder: metadata.folder,
        ...(metadata.tags !== undefined ? { tags: metadata.tags } : {}),
      };
      tx.update(projectHosts)
        .set(metadataUpdate)
        .where(
          and(
            eq(projectHosts.id, link.id),
            eq(projectHosts.projectId, link.projectId),
          ),
        )
        .run();

      return rows[0];
    });

    if (!updated) return null;
    await this.afterWrite();
    return DataCrypto.decryptRecord(
      "ssh_data",
      updated,
      hostOwnerId,
      userDataKey,
    );
  }

  async listBulkUpdateState(
    userId: string,
    hostIds: number[],
  ): Promise<HostBulkUpdateState[]> {
    if (hostIds.length === 0) {
      return [];
    }

    return this.context.drizzle
      .select({
        id: hosts.id,
        statsConfig: hosts.statsConfig,
        credentialId: hosts.credentialId,
        proxmoxConfig: hosts.proxmoxConfig,
      })
      .from(hosts)
      .where(and(inArray(hosts.id, hostIds), eq(hosts.userId, userId)));
  }

  async updateManyForUser(
    userId: string,
    hostIds: number[],
    update: HostUpdate,
  ): Promise<number> {
    if (hostIds.length === 0 || Object.keys(update).length === 0) {
      return 0;
    }

    const rows = await this.context.drizzle
      .update(hosts)
      .set({ ...update, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(and(inArray(hosts.id, hostIds), eq(hosts.userId, userId)))
      .returning({ id: hosts.id });

    if (rows.length > 0) {
      await this.afterWrite();
    }

    return rows.length;
  }

  async deleteForUser(
    userId: string,
    hostId: number,
  ): Promise<{ syncId: string | null } | null> {
    await this.deleteAccessForHost(hostId);

    const rows = await this.context.drizzle
      .delete(hosts)
      .where(and(eq(hosts.id, hostId), eq(hosts.userId, userId)))
      .returning({ syncId: hosts.syncId });

    await this.afterWrite();
    return rows[0] ?? null;
  }

  async deleteForUserWithRelatedData(
    userId: string,
    hostId: number,
    syncId?: string | null,
  ): Promise<boolean> {
    const sqlite = this.context.sqlite;
    if (!sqlite) throw new Error("SQLite connection is unavailable");

    const deleted = sqlite.transaction(() => {
      const persistent = sqlite
        .prepare(
          `SELECT COUNT(*) AS count
             FROM persistent_sessions session
             JOIN project_hosts project_host
               ON project_host.id = session.project_host_id
            WHERE project_host.host_id = ?`,
        )
        .get(hostId) as { count: number };
      if (persistent.count > 0) {
        throw new HostHasPersistentSessionsError(persistent.count);
      }

      sqlite
        .prepare("DELETE FROM file_manager_recent WHERE host_id = ?")
        .run(hostId);
      sqlite
        .prepare("DELETE FROM file_manager_pinned WHERE host_id = ?")
        .run(hostId);
      sqlite
        .prepare("DELETE FROM file_manager_shortcuts WHERE host_id = ?")
        .run(hostId);
      sqlite
        .prepare(
          "DELETE FROM transfer_recent WHERE source_host_id = ? OR dest_host_id = ?",
        )
        .run(hostId, hostId);
      sqlite
        .prepare("DELETE FROM command_history WHERE host_id = ?")
        .run(hostId);
      sqlite
        .prepare("DELETE FROM ssh_credential_usage WHERE host_id = ?")
        .run(hostId);
      sqlite
        .prepare("DELETE FROM recent_activity WHERE host_id = ?")
        .run(hostId);
      sqlite.prepare("DELETE FROM host_access WHERE host_id = ?").run(hostId);
      sqlite
        .prepare("DELETE FROM session_recordings WHERE host_id = ?")
        .run(hostId);

      const result = sqlite
        .prepare("DELETE FROM ssh_data WHERE id = ? AND user_id = ?")
        .run(hostId, userId);
      if (result.changes === 0) return false;

      if (syncId) {
        sqlite
          .prepare(
            `INSERT INTO sync_tombstones (user_id, entity_type, sync_id)
             VALUES (?, 'hosts', ?)`,
          )
          .run(userId, syncId);
      }
      return true;
    })();

    if (deleted) await this.afterWrite();
    return deleted;
  }

  async deleteByUserId(userId: string): Promise<number> {
    const rows = await this.context.drizzle
      .delete(hosts)
      .where(eq(hosts.userId, userId))
      .returning({ id: hosts.id });

    if (rows.length > 0) {
      await this.afterWrite();
    }

    return rows.length;
  }

  async deleteAccessForHost(hostId: number): Promise<number> {
    const rows = await this.context.drizzle
      .delete(hostAccess)
      .where(eq(hostAccess.hostId, hostId))
      .returning({ id: hostAccess.id });

    if (rows.length > 0) {
      await this.afterWrite();
    }

    return rows.length;
  }

  private async afterWrite(): Promise<void> {
    await this.onWrite?.();
  }
}
