import crypto from "crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  hosts,
  projectCredentials,
  projectHosts,
} from "../database/db/schema.js";
import type { DatabaseContext } from "../database/repositories/database-context.js";
import {
  PlatformCredentialVault,
  type PlatformCredentialSecret,
} from "./credential-vault.js";
import { normalizePortKnockSequence } from "../hosts/port-knock-sequence.js";

const MANAGED_CREDENTIAL_ID_PREFIX = "cloudssh-mirror:";

function hasLegacyManagedCredentialName(name: string): boolean {
  return /^Agent .+ \d+$/.test(name);
}

function isManagedProjectCredential(
  credential: { id: string; name: string },
  projectHostId: number,
): boolean {
  if (credential.id.startsWith(MANAGED_CREDENTIAL_ID_PREFIX)) return true;

  // 兼容升级前由 Agent 自动创建的凭据命名格式。
  return (
    hasLegacyManagedCredentialName(credential.name) &&
    credential.name.endsWith(` ${projectHostId}`)
  );
}

function credentialContentsMatch(
  current: {
    username: string;
    authType: string;
    keyType: string | null;
    secret: PlatformCredentialSecret;
  },
  input: {
    username: string;
    authType: string;
    keyType?: string | null;
    secret: PlatformCredentialSecret;
  },
): boolean {
  return (
    current.username === input.username &&
    current.authType === input.authType &&
    current.keyType === (input.keyType ?? null) &&
    current.secret.password === input.secret.password &&
    current.secret.privateKey === input.secret.privateKey &&
    current.secret.passphrase === input.secret.passphrase &&
    current.secret.certificate === input.secret.certificate
  );
}

export class ProjectCredentialRepository {
  constructor(
    private readonly context: DatabaseContext,
    private readonly vault: PlatformCredentialVault,
  ) {}

  async list(projectId: string) {
    return this.context.drizzle
      .select({
        id: projectCredentials.id,
        name: projectCredentials.name,
        username: projectCredentials.username,
        authType: projectCredentials.authType,
        keyType: projectCredentials.keyType,
        createdAt: projectCredentials.createdAt,
        updatedAt: projectCredentials.updatedAt,
      })
      .from(projectCredentials)
      .where(eq(projectCredentials.projectId, projectId));
  }

  async create(input: {
    projectId: string;
    name: string;
    username: string;
    authType: "password" | "key" | "none";
    keyType?: string | null;
    secret: PlatformCredentialSecret;
    createdBy: string;
  }) {
    const id = crypto.randomUUID();
    const encryptedSecret = this.vault.encrypt(
      id,
      input.projectId,
      input.secret,
    );
    await this.context.drizzle.insert(projectCredentials).values({
      id,
      projectId: input.projectId,
      name: input.name,
      username: input.username,
      authType: input.authType,
      encryptedSecret,
      keyType: input.keyType ?? null,
      createdBy: input.createdBy,
    });
    return {
      id,
      name: input.name,
      username: input.username,
      authType: input.authType,
    };
  }

  async remove(projectId: string, credentialId: string): Promise<boolean> {
    const rows = await this.context.drizzle
      .delete(projectCredentials)
      .where(
        and(
          eq(projectCredentials.projectId, projectId),
          eq(projectCredentials.id, credentialId),
        ),
      )
      .returning({ id: projectCredentials.id });
    return rows.length > 0;
  }

  async assignToProjectHost(
    projectId: string,
    projectHostId: number,
    credentialId: string | null,
  ): Promise<boolean> {
    if (credentialId) {
      const credential = await this.context.drizzle
        .select({ id: projectCredentials.id, name: projectCredentials.name })
        .from(projectCredentials)
        .where(
          and(
            eq(projectCredentials.projectId, projectId),
            eq(projectCredentials.id, credentialId),
          ),
        )
        .limit(1);
      if (!credential[0]) return false;
      if (
        credential[0].id.startsWith(MANAGED_CREDENTIAL_ID_PREFIX) ||
        hasLegacyManagedCredentialName(credential[0].name)
      ) {
        const currentAssignment = await this.context.drizzle
          .select({ id: projectHosts.id })
          .from(projectHosts)
          .where(eq(projectHosts.credentialId, credentialId))
          .limit(1);
        if (currentAssignment[0]?.id !== projectHostId) return false;
      }
    }
    const rows = await this.context.drizzle
      .update(projectHosts)
      .set({ credentialId })
      .where(
        and(
          eq(projectHosts.projectId, projectId),
          eq(projectHosts.id, projectHostId),
        ),
      )
      .returning({ id: projectHosts.id });
    return rows.length > 0;
  }

  async resolveForProjectHost(projectHostId: number) {
    const rows = await this.context.drizzle
      .select({
        projectId: projectHosts.projectId,
        hostId: projectHosts.hostId,
        hostName: hosts.name,
        address: hosts.ip,
        port: hosts.port,
        portKnockSequence: hosts.portKnockSequence,
        hostKeyFingerprint: hosts.hostKeyFingerprint,
        credentialId: projectCredentials.id,
        credentialName: projectCredentials.name,
        username: projectCredentials.username,
        authType: projectCredentials.authType,
        encryptedSecret: projectCredentials.encryptedSecret,
        keyType: projectCredentials.keyType,
      })
      .from(projectHosts)
      .innerJoin(hosts, eq(projectHosts.hostId, hosts.id))
      .innerJoin(
        projectCredentials,
        eq(projectHosts.credentialId, projectCredentials.id),
      )
      .where(
        and(
          eq(projectHosts.id, projectHostId),
          eq(projectCredentials.projectId, projectHosts.projectId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      ...row,
      managed: isManagedProjectCredential(
        { id: row.credentialId, name: row.credentialName },
        projectHostId,
      ),
      portKnockSequence: normalizePortKnockSequence(row.portKnockSequence),
      secret: this.vault.decrypt(
        row.credentialId,
        row.projectId,
        row.encryptedSecret,
      ),
      encryptedSecret: undefined,
    };
  }

  async findProjectHostReference(projectHostId: number) {
    const rows = await this.context.drizzle
      .select({
        projectId: projectHosts.projectId,
        hostId: projectHosts.hostId,
      })
      .from(projectHosts)
      .where(eq(projectHosts.id, projectHostId))
      .limit(1);
    return rows[0] ?? null;
  }

  async listProjectHostReferencesForHost(hostId: number) {
    return this.context.drizzle
      .select({
        projectId: projectHosts.projectId,
        projectHostId: projectHosts.id,
        hostId: projectHosts.hostId,
      })
      .from(projectHosts)
      .where(eq(projectHosts.hostId, hostId));
  }

  async listProjectHostReferencesForOwner(ownerId: string) {
    return this.context.drizzle
      .select({
        projectId: projectHosts.projectId,
        projectHostId: projectHosts.id,
        hostId: projectHosts.hostId,
      })
      .from(projectHosts)
      .innerJoin(hosts, eq(projectHosts.hostId, hosts.id))
      .where(eq(hosts.userId, ownerId));
  }

  async ensureForProjectHost(input: {
    projectId: string;
    projectHostId: number;
    hostName: string;
    username: string;
    authType: "password" | "key" | "none";
    keyType?: string | null;
    secret: PlatformCredentialSecret;
    createdBy: string;
  }) {
    const changed = this.context.drizzle.transaction((tx) => {
      const link = tx
        .select({
          projectId: projectHosts.projectId,
          credentialId: projectHosts.credentialId,
        })
        .from(projectHosts)
        .where(
          and(
            eq(projectHosts.id, input.projectHostId),
            eq(projectHosts.projectId, input.projectId),
          ),
        )
        .limit(1)
        .all()[0];
      if (!link) throw new Error("Project host belongs to another project");

      if (link.credentialId) {
        const credential = tx
          .select({
            id: projectCredentials.id,
            name: projectCredentials.name,
            projectId: projectCredentials.projectId,
            username: projectCredentials.username,
            authType: projectCredentials.authType,
            encryptedSecret: projectCredentials.encryptedSecret,
            keyType: projectCredentials.keyType,
          })
          .from(projectCredentials)
          .where(eq(projectCredentials.id, link.credentialId))
          .limit(1)
          .all()[0];
        if (!credential || credential.projectId !== input.projectId) {
          throw new Error("Project credential belongs to another project");
        }

        // 手工分配的项目凭据具有更高优先级，不能被主机镜像覆盖。
        if (!isManagedProjectCredential(credential, input.projectHostId)) {
          return false;
        }

        const currentSecret = this.vault.decrypt(
          credential.id,
          input.projectId,
          credential.encryptedSecret,
        );
        if (
          credentialContentsMatch(
            { ...credential, secret: currentSecret },
            input,
          )
        ) {
          return false;
        }

        tx.update(projectCredentials)
          .set({
            username: input.username,
            authType: input.authType,
            encryptedSecret: this.vault.encrypt(
              credential.id,
              input.projectId,
              input.secret,
            ),
            keyType: input.keyType ?? null,
            updatedAt: sql`CURRENT_TIMESTAMP`,
          })
          .where(
            and(
              eq(projectCredentials.id, credential.id),
              eq(projectCredentials.projectId, input.projectId),
            ),
          )
          .run();
        return true;
      }

      const id = `${MANAGED_CREDENTIAL_ID_PREFIX}${crypto.randomUUID()}`;
      const name = `Agent ${input.hostName} ${input.projectHostId} ${id.slice(-8)}`;
      tx.insert(projectCredentials)
        .values({
          id,
          projectId: input.projectId,
          name,
          username: input.username,
          authType: input.authType,
          encryptedSecret: this.vault.encrypt(
            id,
            input.projectId,
            input.secret,
          ),
          keyType: input.keyType ?? null,
          createdBy: input.createdBy,
        })
        .run();

      const linked = tx
        .update(projectHosts)
        .set({ credentialId: id })
        .where(
          and(
            eq(projectHosts.projectId, input.projectId),
            eq(projectHosts.id, input.projectHostId),
            isNull(projectHosts.credentialId),
          ),
        )
        .returning({ id: projectHosts.id })
        .all();
      if (!linked[0]) {
        throw new Error("Project credential could not be assigned");
      }
      return true;
    });

    const resolved = await this.resolveForProjectHost(input.projectHostId);
    if (!resolved || resolved.projectId !== input.projectId) {
      throw new Error("Project credential could not be resolved");
    }
    return { ...resolved, changed };
  }

  async removeManagedForProjectHost(
    projectId: string,
    projectHostId: number,
  ): Promise<boolean> {
    return this.context.drizzle.transaction((tx) => {
      const link = tx
        .select({ credentialId: projectHosts.credentialId })
        .from(projectHosts)
        .where(
          and(
            eq(projectHosts.id, projectHostId),
            eq(projectHosts.projectId, projectId),
          ),
        )
        .limit(1)
        .all()[0];
      if (!link) throw new Error("Project host belongs to another project");
      if (!link.credentialId) return false;

      const credential = tx
        .select({
          id: projectCredentials.id,
          name: projectCredentials.name,
          projectId: projectCredentials.projectId,
        })
        .from(projectCredentials)
        .where(eq(projectCredentials.id, link.credentialId))
        .limit(1)
        .all()[0];
      if (!credential || credential.projectId !== projectId) {
        throw new Error("Project credential belongs to another project");
      }
      if (!isManagedProjectCredential(credential, projectHostId)) return false;

      tx.update(projectHosts)
        .set({ credentialId: null })
        .where(
          and(
            eq(projectHosts.id, projectHostId),
            eq(projectHosts.projectId, projectId),
          ),
        )
        .run();

      const remainingReference = tx
        .select({ id: projectHosts.id })
        .from(projectHosts)
        .where(eq(projectHosts.credentialId, credential.id))
        .limit(1)
        .all()[0];
      if (!remainingReference) {
        tx.delete(projectCredentials)
          .where(
            and(
              eq(projectCredentials.id, credential.id),
              eq(projectCredentials.projectId, projectId),
            ),
          )
          .run();
      }
      return true;
    });
  }
}
