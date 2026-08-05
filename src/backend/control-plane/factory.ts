import { createCurrentRepositoryContext } from "../database/repositories/factory.js";
import { ProjectRepository } from "./project-repository.js";
import { ProjectCredentialRepository } from "./credential-repository.js";
import {
  loadPlatformMasterKey,
  PlatformCredentialVault,
} from "./credential-vault.js";

export function createCurrentProjectRepository(): ProjectRepository {
  return new ProjectRepository(createCurrentRepositoryContext());
}

export async function createCurrentProjectCredentialRepository(): Promise<ProjectCredentialRepository> {
  return new ProjectCredentialRepository(
    createCurrentRepositoryContext(),
    new PlatformCredentialVault(await loadPlatformMasterKey()),
  );
}
