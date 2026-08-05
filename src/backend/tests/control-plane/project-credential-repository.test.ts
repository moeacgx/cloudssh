import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectCredentialRepository } from "../../control-plane/credential-repository.js";
import { PlatformCredentialVault } from "../../control-plane/credential-vault.js";
import { TestSqliteDatabase } from "../database/repositories/test-support.js";

describe("ProjectCredentialRepository", () => {
  let adapter: TestSqliteDatabase;
  let repository: ProjectCredentialRepository;
  let vault: PlatformCredentialVault;

  beforeEach(async () => {
    adapter = new TestSqliteDatabase();
    const context = await adapter.connect();
    context.sqlite?.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL
      );
      CREATE TABLE projects (
        id TEXT PRIMARY KEY
      );
      CREATE TABLE ssh_data (
        id INTEGER PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        name TEXT,
        ip TEXT NOT NULL,
        port INTEGER NOT NULL,
        port_knock_sequence TEXT,
        host_key_fingerprint TEXT
      );
      CREATE TABLE project_credentials (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        username TEXT NOT NULL,
        auth_type TEXT NOT NULL,
        encrypted_secret TEXT NOT NULL,
        key_type TEXT,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(project_id, name)
      );
      CREATE TABLE project_hosts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        host_id INTEGER NOT NULL REFERENCES ssh_data(id) ON DELETE CASCADE,
        credential_id TEXT REFERENCES project_credentials(id) ON DELETE SET NULL,
        alias TEXT,
        folder TEXT,
        added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(project_id, host_id)
      );

      INSERT INTO users (id, username) VALUES ('owner', 'Owner');
      INSERT INTO projects (id) VALUES ('project-1'), ('project-2');
      INSERT INTO ssh_data (id, user_id, name, ip, port)
      VALUES
        (42, 'owner', 'Production', '10.0.0.42', 22),
        (43, 'owner', 'Staging', '10.0.0.43', 22);
      INSERT INTO project_hosts (id, project_id, host_id, added_by)
      VALUES
        (9, 'project-1', 42, 'owner'),
        (10, 'project-1', 43, 'owner');
    `);
    vault = new PlatformCredentialVault(Buffer.alloc(32, 7));
    repository = new ProjectCredentialRepository(context, vault);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await adapter.close();
  });

  const mirrorInput = (password: string) => ({
    projectId: "project-1",
    projectHostId: 9,
    hostName: "Production",
    username: "root",
    authType: "password" as const,
    keyType: null,
    secret: { password },
    createdBy: "owner",
  });

  it("atomically creates an encrypted managed credential and assigns it", async () => {
    const resolved = await repository.ensureForProjectHost(
      mirrorInput("first-secret"),
    );
    const context = await adapter.connect();
    const stored = context.sqlite
      ?.prepare(
        `SELECT pc.id, pc.encrypted_secret AS encryptedSecret,
                ph.credential_id AS assignedCredentialId
         FROM project_credentials pc
         JOIN project_hosts ph ON ph.credential_id = pc.id
         WHERE ph.id = 9`,
      )
      .get() as
      | { id: string; encryptedSecret: string; assignedCredentialId: string }
      | undefined;

    expect(resolved).toMatchObject({
      projectId: "project-1",
      hostId: 42,
      managed: true,
      secret: { password: "first-secret" },
    });
    expect(stored?.id).toMatch(/^cloudssh-mirror:/);
    expect(stored?.assignedCredentialId).toBe(stored?.id);
    expect(stored?.encryptedSecret).not.toContain("first-secret");
  });

  it("updates an existing managed mirror when the source credential changes", async () => {
    const first = await repository.ensureForProjectHost(
      mirrorInput("old-secret"),
    );
    const updated = await repository.ensureForProjectHost({
      ...mirrorInput("new-secret"),
      username: "deploy",
      authType: "key",
      keyType: "ssh-ed25519",
      secret: {
        privateKey: "NEW-PRIVATE-KEY",
        passphrase: "new-passphrase",
      },
    });

    expect(updated.credentialId).toBe(first.credentialId);
    expect(updated).toMatchObject({
      username: "deploy",
      authType: "key",
      keyType: "ssh-ed25519",
      secret: {
        privateKey: "NEW-PRIVATE-KEY",
        passphrase: "new-passphrase",
      },
    });
    expect(updated.secret.password).toBeUndefined();
  });

  it("does not rewrite an unchanged managed credential", async () => {
    const first = await repository.ensureForProjectHost(
      mirrorInput("stable-secret"),
    );
    const context = await adapter.connect();
    const before = context.sqlite
      ?.prepare(
        "SELECT encrypted_secret AS encryptedSecret FROM project_credentials WHERE id = ?",
      )
      .get(first.credentialId) as { encryptedSecret: string };

    const second = await repository.ensureForProjectHost(
      mirrorInput("stable-secret"),
    );
    const after = context.sqlite
      ?.prepare(
        "SELECT encrypted_secret AS encryptedSecret FROM project_credentials WHERE id = ?",
      )
      .get(first.credentialId) as { encryptedSecret: string };

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(after.encryptedSecret).toBe(before.encryptedSecret);
  });

  it("does not allow a managed mirror to be assigned to another host", async () => {
    const managed = await repository.ensureForProjectHost(
      mirrorInput("production-secret"),
    );

    await expect(
      repository.assignToProjectHost("project-1", 10, managed.credentialId),
    ).resolves.toBe(false);
    await expect(repository.resolveForProjectHost(10)).resolves.toBeNull();
  });

  it("preserves an explicitly assigned project credential", async () => {
    const manual = await repository.create({
      projectId: "project-1",
      name: "Manual production key",
      username: "manual-user",
      authType: "password",
      secret: { password: "manual-secret" },
      createdBy: "owner",
    });
    await repository.assignToProjectHost("project-1", 9, manual.id);

    const resolved = await repository.ensureForProjectHost(
      mirrorInput("source-secret"),
    );

    expect(resolved).toMatchObject({
      credentialId: manual.id,
      managed: false,
      changed: false,
      username: "manual-user",
      secret: { password: "manual-secret" },
    });
  });

  it("updates a legacy Agent mirror after an upgrade", async () => {
    const context = await adapter.connect();
    const encryptedSecret = vault.encrypt("legacy-id", "project-1", {
      password: "legacy-secret",
    });
    context.sqlite
      ?.prepare(
        `INSERT INTO project_credentials
           (id, project_id, name, username, auth_type, encrypted_secret, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy-id",
        "project-1",
        "Agent Production 9",
        "root",
        "password",
        encryptedSecret,
        "owner",
      );
    context.sqlite
      ?.prepare("UPDATE project_hosts SET credential_id = ? WHERE id = 9")
      .run("legacy-id");

    const resolved = await repository.ensureForProjectHost(
      mirrorInput("rotated-secret"),
    );

    expect(resolved).toMatchObject({
      credentialId: "legacy-id",
      managed: true,
      secret: { password: "rotated-secret" },
    });
  });

  it("does not create credentials across a project boundary", async () => {
    await expect(
      repository.ensureForProjectHost({
        ...mirrorInput("must-not-store"),
        projectId: "project-2",
      }),
    ).rejects.toThrow("another project");

    const context = await adapter.connect();
    const count = context.sqlite
      ?.prepare("SELECT COUNT(*) AS count FROM project_credentials")
      .get() as { count: number };
    expect(count.count).toBe(0);
  });

  it("rolls back both credential creation and assignment when encryption fails", async () => {
    vi.spyOn(vault, "encrypt").mockImplementationOnce(() => {
      throw new Error("vault unavailable");
    });

    await expect(
      repository.ensureForProjectHost(mirrorInput("must-not-store")),
    ).rejects.toThrow("vault unavailable");

    const context = await adapter.connect();
    const credentialCount = context.sqlite
      ?.prepare("SELECT COUNT(*) AS count FROM project_credentials")
      .get() as { count: number };
    const link = context.sqlite
      ?.prepare(
        "SELECT credential_id AS credentialId FROM project_hosts WHERE id = 9",
      )
      .get() as { credentialId: string | null };
    expect(credentialCount.count).toBe(0);
    expect(link.credentialId).toBeNull();
  });

  it("removes only managed mirrors when the source authentication is invalidated", async () => {
    await repository.ensureForProjectHost(mirrorInput("managed-secret"));
    await expect(
      repository.removeManagedForProjectHost("project-1", 9),
    ).resolves.toBe(true);
    await expect(repository.resolveForProjectHost(9)).resolves.toBeNull();

    const manual = await repository.create({
      projectId: "project-1",
      name: "Manual",
      username: "manual-user",
      authType: "password",
      secret: { password: "manual-secret" },
      createdBy: "owner",
    });
    await repository.assignToProjectHost("project-1", 9, manual.id);
    await expect(
      repository.removeManagedForProjectHost("project-1", 9),
    ).resolves.toBe(false);
    await expect(repository.resolveForProjectHost(9)).resolves.toMatchObject({
      credentialId: manual.id,
      secret: { password: "manual-secret" },
    });
  });

  it("serializes concurrent mirror creation without leaving orphan rows", async () => {
    await Promise.all([
      repository.ensureForProjectHost(mirrorInput("first")),
      repository.ensureForProjectHost(mirrorInput("second")),
    ]);

    const context = await adapter.connect();
    const count = context.sqlite
      ?.prepare("SELECT COUNT(*) AS count FROM project_credentials")
      .get() as { count: number };
    const resolved = await repository.resolveForProjectHost(9);
    expect(count.count).toBe(1);
    expect(["first", "second"]).toContain(resolved?.secret.password);
  });

  it("normalizes legacy port-knock JSON for Agent project connections", async () => {
    const credential = await repository.create({
      projectId: "project-1",
      name: "Port knock credential",
      username: "root",
      authType: "password",
      secret: { password: "secret" },
      createdBy: "owner",
    });
    await repository.assignToProjectHost("project-1", 9, credential.id);
    const context = await adapter.connect();
    context.sqlite
      ?.prepare("UPDATE ssh_data SET port_knock_sequence = ? WHERE id = 42")
      .run('"[{\\"port\\":4000,\\"protocol\\":\\"UDP\\"}]"');

    await expect(repository.resolveForProjectHost(9)).resolves.toMatchObject({
      portKnockSequence: [{ port: 4000, protocol: "udp", delay: undefined }],
    });
  });
});
