import express, { type Response } from "express";
import type { AuthenticatedRequest } from "../../types/index.js";
import { getRequestMeta, type AuditLogParams } from "../utils/audit-logger.js";
import { databaseLogger } from "../utils/logger.js";
import {
  ControlPlaneManagementError,
  type ManagementRepository,
  type ManagedProjectRole,
  type TeamRole,
} from "./management-repository.js";
import type { ProjectHostCredentialInitialization } from "../hosts/host-resolver.js";
import type { TerminalSessionFilter } from "../hosts/terminal/session-manager.js";
import type { TerminalSessionLifecycleCoordinator } from "../hosts/terminal/session-lifecycle-coordinator.js";

export interface ManagementRouterDependencies {
  createRepository: () => ManagementRepository;
  isInstanceAdmin: (userId: string) => Promise<boolean>;
  afterMutation: (reason: string) => Promise<void>;
  notifyHostDeleted?: (
    hostId: number,
    request: AuthenticatedRequest,
    scopeUserId?: string,
  ) => Promise<void>;
  initializeProjectHostCredential: (
    input: ProjectHostCredentialInitialization,
  ) => Promise<void>;
  audit: (entry: AuditLogParams) => Promise<void>;
  findTerminalSessions: (filter: TerminalSessionFilter) => readonly unknown[];
  terminalLifecycleCoordinator: Pick<
    TerminalSessionLifecycleCoordinator,
    "runDestructiveOperation" | "retire"
  >;
}

const TEAM_ROLES = new Set<TeamRole>([
  "team_admin",
  "project_admin",
  "operator",
  "viewer",
]);
const PROJECT_ROLES = new Set<ManagedProjectRole>([
  "project_admin",
  "operator",
  "viewer",
]);

function removesProjectConnectAccess(
  previousRole: TeamRole | ManagedProjectRole | null | undefined,
  nextRole: TeamRole | ManagedProjectRole,
): boolean {
  return (
    nextRole === "viewer" &&
    previousRole !== null &&
    previousRole !== undefined &&
    previousRole !== "viewer"
  );
}
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function param(req: AuthenticatedRequest, name: string): string {
  const raw = req.params[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new ControlPlaneManagementError(400, `Invalid ${name}`);
  }
  return value;
}

function requiredString(value: unknown, name: string, maxLength: number) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ControlPlaneManagementError(400, `${name} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new ControlPlaneManagementError(400, `${name} is too long`);
  }
  return normalized;
}

function optionalString(
  value: unknown,
  name: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, name, maxLength);
}

function slug(value: unknown) {
  const normalized = requiredString(value, "slug", 64);
  if (!SLUG_PATTERN.test(normalized)) {
    throw new ControlPlaneManagementError(400, "Invalid slug");
  }
  return normalized;
}

function optionalDescription(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 1000) {
    throw new ControlPlaneManagementError(400, "Invalid description");
  }
  return value.trim() || null;
}

function folderPath(value: unknown, name = "path"): string {
  const path = requiredString(value, name, 512);
  if (
    /[\0\r\n]/.test(path) ||
    path.startsWith(" / ") ||
    path.endsWith(" / ") ||
    path.split(" / ").some((part) => !part.trim())
  ) {
    throw new ControlPlaneManagementError(400, `Invalid ${name}`);
  }
  return path;
}

function projectTags(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return "";
  if (!Array.isArray(value) || value.length > 32) {
    throw new ControlPlaneManagementError(400, "Invalid tags");
  }
  return [
    ...new Set(
      value.map((tag) => {
        if (typeof tag !== "string") {
          throw new ControlPlaneManagementError(400, "Invalid tags");
        }
        const normalized = tag.trim();
        if (
          !normalized ||
          normalized.length > 64 ||
          /[\0\r\n,]/.test(normalized)
        ) {
          throw new ControlPlaneManagementError(400, "Invalid tags");
        }
        return normalized;
      }),
    ),
  ].join(",");
}

function nullableStyleValue(
  value: unknown,
  name: "color" | "icon",
): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredString(value, name, 64);
}

function positiveIntegerParam(req: AuthenticatedRequest, name: string): number {
  const value = Number(param(req, name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ControlPlaneManagementError(400, `Invalid ${name}`);
  }
  return value;
}

interface AuthorizationAuditInput {
  action: string;
  resourceType: "team_member" | "project_member" | "project_role_grant";
  resourceId: string;
  resourceName?: string;
  details: Record<string, unknown>;
}

async function auditAuthorizationIntent(
  dependencies: ManagementRouterDependencies,
  req: AuthenticatedRequest,
  input: AuthorizationAuditInput,
) {
  try {
    await dependencies.audit({
      userId: req.userId,
      username: req.user?.username ?? req.userId,
      action: `${input.action}_intent`,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      resourceName: input.resourceName,
      details: JSON.stringify({
        stage: "intent",
        ...input.details,
      }),
      ...getRequestMeta(req),
      success: true,
    });
  } catch (error) {
    databaseLogger.error("Authorization intent audit failed", error, {
      operation: input.action,
      userId: req.userId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
    });
    throw new ControlPlaneManagementError(503, "Audit storage is unavailable");
  }
}

async function auditAuthorizationResult(
  dependencies: ManagementRouterDependencies,
  req: AuthenticatedRequest,
  input: AuthorizationAuditInput,
) {
  try {
    await dependencies.audit({
      userId: req.userId,
      username: req.user?.username ?? req.userId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      resourceName: input.resourceName,
      details: JSON.stringify({ stage: "result", ...input.details }),
      ...getRequestMeta(req),
      success: true,
    });
  } catch (error) {
    databaseLogger.error("Authorization result audit failed", error, {
      operation: input.action,
      userId: req.userId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
    });
  }
}

function respondError(
  res: Response,
  error: unknown,
  operation: string,
  userId: string,
) {
  if (error instanceof ControlPlaneManagementError) {
    return res.status(error.status).json({ error: error.message });
  }
  databaseLogger.error("Control plane management request failed", error, {
    operation,
    userId,
  });
  return res.status(500).json({ error: "Failed to update control plane" });
}

async function adminStatus(
  dependencies: ManagementRouterDependencies,
  userId: string,
) {
  return dependencies.isInstanceAdmin(userId);
}

async function auditAdminPersonalWorkspace(
  dependencies: ManagementRouterDependencies,
  req: AuthenticatedRequest,
  input: {
    action: string;
    targetUserId: string;
    projectId: string;
    projectHostId?: number;
    mode?: string;
    alias?: string | null;
    folder?: string | null;
  },
) {
  if (!dependencies.audit) return;
  await dependencies.audit({
    userId: req.userId,
    username: req.user?.username ?? req.userId,
    action: input.action,
    resourceType: "personal_workspace",
    resourceId: input.projectHostId
      ? `${input.projectId}:${input.projectHostId}`
      : input.projectId,
    resourceName: input.targetUserId,
    details: JSON.stringify(input),
    ...getRequestMeta(req),
    success: true,
  });
}

export function createManagementRouter(
  dependencies: ManagementRouterDependencies,
) {
  const router = express.Router();

  router.get(
    "/admin/users/:targetUserId/personal-project",
    async (req: AuthenticatedRequest, res) => {
      const userId = req.userId;
      try {
        const result = dependencies
          .createRepository()
          .getAdminPersonalWorkspace(
            param(req, "targetUserId"),
            await adminStatus(dependencies, userId),
          );
        if (result.changed) {
          await dependencies.afterMutation(
            "admin_personal_workspace_bootstrap",
          );
        }
        await auditAdminPersonalWorkspace(dependencies, req, {
          action: "admin_personal_workspace_view",
          targetUserId: param(req, "targetUserId"),
          projectId: result.project.id,
        });
        return res.json({
          project: result.project,
          hosts: result.hosts,
          folders: result.folders,
        });
      } catch (error) {
        return respondError(
          res,
          error,
          "admin_personal_workspace_view",
          userId,
        );
      }
    },
  );

  router.delete(
    "/admin/users/:targetUserId/personal-project/hosts/:projectHostId",
    async (req: AuthenticatedRequest, res) => {
      const userId = req.userId;
      try {
        const targetUserId = param(req, "targetUserId");
        const projectHostId = positiveIntegerParam(req, "projectHostId");
        const isInstanceAdmin = await adminStatus(dependencies, userId);
        const repository = dependencies.createRepository();
        const target = repository.getAdminPersonalHostLifecycleTarget(
          targetUserId,
          isInstanceAdmin,
          projectHostId,
        );
        const result =
          await dependencies.terminalLifecycleCoordinator.runDestructiveOperation(
            {
              hostIds: [target.hostId],
              projectHostIds: [target.projectHostId],
            },
            () => {
              const activeSessions = dependencies.findTerminalSessions({
                hostId: target.hostId,
              });
              if (activeSessions.length > 0) {
                throw new ControlPlaneManagementError(
                  409,
                  "Personal workspace host still has active terminal sessions",
                );
              }
              const removed = repository.removeAdminPersonalHost(
                targetUserId,
                isInstanceAdmin,
                projectHostId,
              );
              dependencies.terminalLifecycleCoordinator.retire({
                hostIds: removed.mode === "deleted" ? [removed.hostId] : [],
                projectHostIds: [removed.projectHostId],
              });
              return removed;
            },
          );
        await dependencies.afterMutation(
          "admin_personal_workspace_host_remove",
        );
        if (result.mode === "deleted" && dependencies.notifyHostDeleted) {
          try {
            await dependencies.notifyHostDeleted(
              result.hostId,
              req,
              targetUserId,
            );
          } catch (error) {
            databaseLogger.warn(
              "Failed to stop host monitoring after administrator deletion",
              {
                operation: "admin_personal_workspace_host_remove",
                hostId: result.hostId,
                error: error instanceof Error ? error.message : "Unknown error",
              },
            );
          }
        }
        await auditAdminPersonalWorkspace(dependencies, req, {
          action: "admin_personal_workspace_host_remove",
          targetUserId,
          projectId: result.projectId,
          projectHostId: result.projectHostId,
          mode: result.mode,
        });
        return res.json(result);
      } catch (error) {
        return respondError(
          res,
          error,
          "admin_personal_workspace_host_remove",
          userId,
        );
      }
    },
  );

  router.put(
    "/admin/users/:targetUserId/personal-project/hosts/:projectHostId",
    async (req: AuthenticatedRequest, res) => {
      const userId = req.userId;
      try {
        const projectHostId = positiveIntegerParam(req, "projectHostId");
        const rawAlias = req.body?.alias;
        const alias =
          rawAlias === undefined || rawAlias === null || rawAlias === ""
            ? null
            : requiredString(rawAlias, "alias", 128);
        const rawFolder = req.body?.folder;
        const folder =
          rawFolder === undefined || rawFolder === null || rawFolder === ""
            ? null
            : folderPath(rawFolder, "folder");
        const result = dependencies
          .createRepository()
          .updateAdminPersonalHostMetadata(
            param(req, "targetUserId"),
            await adminStatus(dependencies, userId),
            projectHostId,
            { alias, folder },
          );
        await dependencies.afterMutation(
          "admin_personal_workspace_host_metadata_update",
        );
        await auditAdminPersonalWorkspace(dependencies, req, {
          action: "admin_personal_workspace_host_metadata_update",
          targetUserId: param(req, "targetUserId"),
          projectId: result.projectId,
          projectHostId: result.projectHostId,
          alias: result.alias,
          folder: result.folder,
        });
        return res.json(result);
      } catch (error) {
        return respondError(
          res,
          error,
          "admin_personal_workspace_host_metadata_update",
          userId,
        );
      }
    },
  );

  router.post("/bootstrap", async (req: AuthenticatedRequest, res) => {
    const userId = req.userId;
    try {
      const result = dependencies
        .createRepository()
        .bootstrapPersonalProject(userId);
      if (result.changed)
        await dependencies.afterMutation("personal_bootstrap");
      return res.json({ project: result.project });
    } catch (error) {
      return respondError(res, error, "personal_bootstrap", userId);
    }
  });

  router.get("/teams", async (req: AuthenticatedRequest, res) => {
    const userId = req.userId;
    try {
      return res.json({
        teams: dependencies
          .createRepository()
          .listVisibleTeams(userId, await adminStatus(dependencies, userId)),
      });
    } catch (error) {
      return respondError(res, error, "team_list", userId);
    }
  });

  router.post("/teams", async (req: AuthenticatedRequest, res) => {
    const userId = req.userId;
    try {
      const team = dependencies
        .createRepository()
        .createTeam(
          userId,
          requiredString(req.body?.name, "name", 128),
          slug(req.body?.slug),
        );
      await dependencies.afterMutation("team_create");
      return res.status(201).json({ team });
    } catch (error) {
      return respondError(res, error, "team_create", userId);
    }
  });

  router.patch("/teams/:teamId", async (req: AuthenticatedRequest, res) => {
    const userId = req.userId;
    try {
      const name = optionalString(req.body?.name, "name", 128);
      const nextSlug =
        req.body?.slug === undefined ? undefined : slug(req.body.slug);
      if (name === undefined && nextSlug === undefined) {
        throw new ControlPlaneManagementError(400, "No changes provided");
      }
      const team = dependencies
        .createRepository()
        .updateTeam(
          param(req, "teamId"),
          userId,
          await adminStatus(dependencies, userId),
          { name, slug: nextSlug },
        );
      await dependencies.afterMutation("team_update");
      return res.json({ team });
    } catch (error) {
      return respondError(res, error, "team_update", userId);
    }
  });

  router.delete("/teams/:teamId", async (req: AuthenticatedRequest, res) => {
    const userId = req.userId;
    try {
      dependencies
        .createRepository()
        .deleteTeam(
          param(req, "teamId"),
          userId,
          await adminStatus(dependencies, userId),
        );
      await dependencies.afterMutation("team_delete");
      return res.status(204).send();
    } catch (error) {
      return respondError(res, error, "team_delete", userId);
    }
  });

  router.get(
    "/teams/:teamId/members",
    async (req: AuthenticatedRequest, res) => {
      const userId = req.userId;
      try {
        return res.json({
          members: dependencies
            .createRepository()
            .listTeamMembers(
              param(req, "teamId"),
              userId,
              await adminStatus(dependencies, userId),
            ),
        });
      } catch (error) {
        return respondError(res, error, "team_member_list", userId);
      }
    },
  );

  router.put(
    "/teams/:teamId/members/:userId",
    async (req: AuthenticatedRequest, res) => {
      const userId = req.userId;
      try {
        const role = req.body?.role;
        if (!TEAM_ROLES.has(role)) {
          throw new ControlPlaneManagementError(400, "Invalid team role");
        }
        const teamId = param(req, "teamId");
        const memberUserId = param(req, "userId");
        const isInstanceAdmin = await adminStatus(dependencies, userId);
        const repository = dependencies.createRepository();
        const previousRole = repository
          .listTeamMembers(teamId, userId, isInstanceAdmin)
          .find((member) => member.userId === memberUserId)?.role;
        const audit = {
          action: "team_member_set",
          resourceType: "team_member" as const,
          resourceId: `${teamId}:${memberUserId}`,
          resourceName: memberUserId,
          details: {
            teamId,
            targetUserId: memberUserId,
            previousRole: previousRole ?? null,
            nextRole: role,
          },
        };
        await auditAuthorizationIntent(dependencies, req, audit);
        let member: ReturnType<ManagementRepository["setTeamMember"]>;
        if (removesProjectConnectAccess(previousRole, role)) {
          const projectHostIds = repository.listTeamProjectHostIdsForLifecycle(
            teamId,
            userId,
            isInstanceAdmin,
          );
          member =
            await dependencies.terminalLifecycleCoordinator.runDestructiveOperation(
              { projectHostIds, userIds: [memberUserId] },
              () => {
                const pinnedSessions = dependencies.findTerminalSessions({
                  projectHostIds,
                  userId: memberUserId,
                  pinned: true,
                });
                if (pinnedSessions.length > 0) {
                  throw new ControlPlaneManagementError(
                    409,
                    "Team member still owns pinned terminal windows in this team",
                  );
                }
                return repository.setTeamMember(
                  teamId,
                  userId,
                  isInstanceAdmin,
                  memberUserId,
                  role,
                );
              },
            );
        } else {
          member = repository.setTeamMember(
            teamId,
            userId,
            isInstanceAdmin,
            memberUserId,
            role,
          );
        }
        await dependencies.afterMutation("team_member_set");
        await auditAuthorizationResult(dependencies, req, audit);
        return res.json({ member });
      } catch (error) {
        return respondError(res, error, "team_member_set", userId);
      }
    },
  );

  router.delete(
    "/teams/:teamId/members/:userId",
    async (req: AuthenticatedRequest, res) => {
      const userId = req.userId;
      try {
        const teamId = param(req, "teamId");
        const memberUserId = param(req, "userId");
        const isInstanceAdmin = await adminStatus(dependencies, userId);
        const repository = dependencies.createRepository();
        const previousRole = repository
          .listTeamMembers(teamId, userId, isInstanceAdmin)
          .find((member) => member.userId === memberUserId)?.role;
        const projectHostIds = repository.listTeamProjectHostIdsForLifecycle(
          teamId,
          userId,
          isInstanceAdmin,
        );
        const audit = {
          action: "team_member_remove",
          resourceType: "team_member" as const,
          resourceId: `${teamId}:${memberUserId}`,
          resourceName: memberUserId,
          details: {
            teamId,
            targetUserId: memberUserId,
            previousRole: previousRole ?? null,
            nextRole: null,
          },
        };
        await auditAuthorizationIntent(dependencies, req, audit);
        await dependencies.terminalLifecycleCoordinator.runDestructiveOperation(
          { projectHostIds, userIds: [memberUserId] },
          () => {
            const pinnedSessions = dependencies.findTerminalSessions({
              projectHostIds,
              userId: memberUserId,
              pinned: true,
            });
            if (pinnedSessions.length > 0) {
              throw new ControlPlaneManagementError(
                409,
                "Team member still owns pinned terminal windows in this team",
              );
            }
            repository.removeTeamMember(
              teamId,
              userId,
              isInstanceAdmin,
              memberUserId,
            );
          },
        );
        await dependencies.afterMutation("team_member_remove");
        await auditAuthorizationResult(dependencies, req, audit);
        return res.status(204).send();
      } catch (error) {
        return respondError(res, error, "team_member_remove", userId);
      }
    },
  );

  router.post(
    "/teams/:teamId/projects",
    async (req: AuthenticatedRequest, res) => {
      const userId = req.userId;
      try {
        const project = dependencies
          .createRepository()
          .createTeamProject(
            param(req, "teamId"),
            userId,
            await adminStatus(dependencies, userId),
            {
              name: requiredString(req.body?.name, "name", 128),
              slug: slug(req.body?.slug),
              description: optionalDescription(req.body?.description) ?? null,
            },
          );
        await dependencies.afterMutation("team_project_create");
        return res.status(201).json({ project });
      } catch (error) {
        return respondError(res, error, "team_project_create", userId);
      }
    },
  );

  router.patch(
    "/projects/:projectId",
    async (req: AuthenticatedRequest, res) => {
      const userId = req.userId;
      try {
        const name = optionalString(req.body?.name, "name", 128);
        const nextSlug =
          req.body?.slug === undefined ? undefined : slug(req.body.slug);
        const description = optionalDescription(req.body?.description);
        if (
          name === undefined &&
          nextSlug === undefined &&
          description === undefined
        ) {
          throw new ControlPlaneManagementError(400, "No changes provided");
        }
        const projectId = param(req, "projectId");
        dependencies
          .createRepository()
          .updateProject(
            projectId,
            userId,
            await adminStatus(dependencies, userId),
            { name, slug: nextSlug, description },
          );
        await dependencies.afterMutation("project_update");
        return res.json({ updated: true });
      } catch (error) {
        return respondError(res, error, "project_update", userId);
      }
    },
  );

  router.delete(
    "/projects/:projectId",
    async (req: AuthenticatedRequest, res) => {
      const userId = req.userId;
      try {
        dependencies
          .createRepository()
          .deleteTeamProject(
            param(req, "projectId"),
            userId,
            await adminStatus(dependencies, userId),
          );
        await dependencies.afterMutation("team_project_delete");
        return res.status(204).send();
      } catch (error) {
        return respondError(res, error, "team_project_delete", userId);
      }
    },
  );

  router.get(
    "/projects/:projectId/members",
    async (req: AuthenticatedRequest, res) => {
      const userId = req.userId;
      try {
        return res.json({
          members: dependencies
            .createRepository()
            .listProjectMembers(
              param(req, "projectId"),
              userId,
              await adminStatus(dependencies, userId),
            ),
        });
      } catch (error) {
        return respondError(res, error, "project_member_list", userId);
      }
    },
  );

  router.get(
    "/projects/:projectId/role-grants",
    async (req: AuthenticatedRequest, res) => {
      const userId = req.userId;
      try {
        const roles = dependencies
          .createRepository()
          .listProjectRoleGrants(
            param(req, "projectId"),
            userId,
            await adminStatus(dependencies, userId),
          );
        return res.json({ roles });
      } catch (error) {
        return respondError(res, error, "project_role_grant_list", userId);
      }
    },
  );

  router.put(
    "/projects/:projectId/role-grants/:roleId",
    async (req: AuthenticatedRequest, res) => {
      const userId = req.userId;
      try {
        const projectId = param(req, "projectId");
        const roleId = positiveIntegerParam(req, "roleId");
        const role = req.body?.role;
        if (!PROJECT_ROLES.has(role)) {
          throw new ControlPlaneManagementError(400, "Invalid project role");
        }
        const isInstanceAdmin = await adminStatus(dependencies, userId);
        const repository = dependencies.createRepository();
        const previous = repository
          .listProjectRoleGrants(projectId, userId, isInstanceAdmin)
          .find((candidate) => candidate.roleId === roleId);
        const audit = {
          action: "project_role_grant_set",
          resourceType: "project_role_grant" as const,
          resourceId: `${projectId}:${roleId}`,
          resourceName: previous?.name ?? projectId,
          details: {
            projectId,
            roleId,
            roleName: previous?.name,
            previousRole: previous?.projectRole ?? null,
            nextRole: role,
          },
        };
        await auditAuthorizationIntent(dependencies, req, audit);
        let result: ReturnType<ManagementRepository["setProjectRoleGrant"]>;
        if (removesProjectConnectAccess(previous?.projectRole, role)) {
          const projectHostIds = repository.listProjectHostIdsForLifecycle(
            projectId,
            userId,
            isInstanceAdmin,
          );
          const roleUserIds = repository.listProjectRoleUserIdsForLifecycle(
            projectId,
            userId,
            isInstanceAdmin,
            roleId,
          );
          result =
            await dependencies.terminalLifecycleCoordinator.runDestructiveOperation(
              { projectHostIds, userIds: roleUserIds },
              () => {
                const pinnedSessions = dependencies.findTerminalSessions({
                  projectHostIds,
                  userIds: roleUserIds,
                  pinned: true,
                });
                if (pinnedSessions.length > 0) {
                  throw new ControlPlaneManagementError(
                    409,
                    "Role grant still has users with pinned terminal windows; terminate them before reducing access",
                  );
                }
                return repository.setProjectRoleGrant(
                  projectId,
                  userId,
                  isInstanceAdmin,
                  roleId,
                  role,
                );
              },
            );
        } else {
          result = repository.setProjectRoleGrant(
            projectId,
            userId,
            isInstanceAdmin,
            roleId,
            role,
          );
        }
        await dependencies.afterMutation(
          result.created
            ? "project_role_grant_create"
            : "project_role_grant_update",
        );
        await auditAuthorizationResult(dependencies, req, {
          ...audit,
          action: result.created
            ? "project_role_grant_create"
            : "project_role_grant_update",
          resourceName: result.grant.name,
        });
        return res.status(result.created ? 201 : 200).json({
          roleGrant: result.grant,
        });
      } catch (error) {
        return respondError(res, error, "project_role_grant_set", userId);
      }
    },
  );

  router.delete(
    "/projects/:projectId/role-grants/:roleId",
    async (req: AuthenticatedRequest, res) => {
      const userId = req.userId;
      try {
        const projectId = param(req, "projectId");
        const roleId = positiveIntegerParam(req, "roleId");
        const repository = dependencies.createRepository();
        const isInstanceAdmin = await adminStatus(dependencies, userId);
        const previous = repository
          .listProjectRoleGrants(projectId, userId, isInstanceAdmin)
          .find((role) => role.roleId === roleId);
        const projectHostIds = repository.listProjectHostIdsForLifecycle(
          projectId,
          userId,
          isInstanceAdmin,
        );
        const roleUserIds = repository.listProjectRoleUserIdsForLifecycle(
          projectId,
          userId,
          isInstanceAdmin,
          roleId,
        );
        const audit = {
          action: "project_role_grant_delete",
          resourceType: "project_role_grant" as const,
          resourceId: `${projectId}:${roleId}`,
          resourceName: previous?.name ?? projectId,
          details: {
            projectId,
            roleId,
            roleName: previous?.name,
            previousRole: previous?.projectRole ?? null,
            nextRole: null,
          },
        };
        await auditAuthorizationIntent(dependencies, req, audit);
        await dependencies.terminalLifecycleCoordinator.runDestructiveOperation(
          { projectHostIds, userIds: roleUserIds },
          () => {
            const pinnedSessions = dependencies.findTerminalSessions({
              projectHostIds,
              userIds: roleUserIds,
              pinned: true,
            });
            if (pinnedSessions.length > 0) {
              throw new ControlPlaneManagementError(
                409,
                "Role grant still has users with pinned terminal windows; terminate them before removing the grant",
              );
            }
            repository.removeProjectRoleGrant(
              projectId,
              userId,
              isInstanceAdmin,
              roleId,
            );
          },
        );
        await dependencies.afterMutation("project_role_grant_delete");
        await auditAuthorizationResult(dependencies, req, audit);
        return res.status(204).send();
      } catch (error) {
        return respondError(res, error, "project_role_grant_delete", userId);
      }
    },
  );

  router.put(
    "/projects/:projectId/members/:userId",
    async (req: AuthenticatedRequest, res) => {
      const userId = req.userId;
      try {
        const role = req.body?.role;
        if (!PROJECT_ROLES.has(role)) {
          throw new ControlPlaneManagementError(400, "Invalid project role");
        }
        const projectId = param(req, "projectId");
        const memberUserId = param(req, "userId");
        const isInstanceAdmin = await adminStatus(dependencies, userId);
        const repository = dependencies.createRepository();
        const previousRole = repository
          .listProjectMembers(projectId, userId, isInstanceAdmin)
          .find((member) => member.userId === memberUserId)?.role;
        const audit = {
          action: "project_member_set",
          resourceType: "project_member" as const,
          resourceId: `${projectId}:${memberUserId}`,
          resourceName: memberUserId,
          details: {
            projectId,
            targetUserId: memberUserId,
            previousRole: previousRole ?? null,
            nextRole: role,
          },
        };
        await auditAuthorizationIntent(dependencies, req, audit);
        let member: ReturnType<ManagementRepository["setProjectMember"]>;
        if (removesProjectConnectAccess(previousRole, role)) {
          const projectHostIds = repository.listProjectHostIdsForLifecycle(
            projectId,
            userId,
            isInstanceAdmin,
          );
          member =
            await dependencies.terminalLifecycleCoordinator.runDestructiveOperation(
              { projectHostIds, userIds: [memberUserId] },
              () => {
                const pinnedSessions = dependencies.findTerminalSessions({
                  projectHostIds,
                  userId: memberUserId,
                  pinned: true,
                });
                if (pinnedSessions.length > 0) {
                  throw new ControlPlaneManagementError(
                    409,
                    "Project member still owns pinned terminal windows; terminate them before reducing access",
                  );
                }
                return repository.setProjectMember(
                  projectId,
                  userId,
                  isInstanceAdmin,
                  memberUserId,
                  role,
                );
              },
            );
        } else {
          member = repository.setProjectMember(
            projectId,
            userId,
            isInstanceAdmin,
            memberUserId,
            role,
          );
        }
        await dependencies.afterMutation("project_member_set");
        await auditAuthorizationResult(dependencies, req, audit);
        return res.json({ member });
      } catch (error) {
        return respondError(res, error, "project_member_set", userId);
      }
    },
  );

  router.delete(
    "/projects/:projectId/members/:userId",
    async (req: AuthenticatedRequest, res) => {
      const userId = req.userId;
      try {
        const projectId = param(req, "projectId");
        const memberUserId = param(req, "userId");
        const isInstanceAdmin = await adminStatus(dependencies, userId);
        const repository = dependencies.createRepository();
        const previousRole = repository
          .listProjectMembers(projectId, userId, isInstanceAdmin)
          .find((member) => member.userId === memberUserId)?.role;
        const projectHostIds = repository.listProjectHostIdsForLifecycle(
          projectId,
          userId,
          isInstanceAdmin,
        );
        const audit = {
          action: "project_member_remove",
          resourceType: "project_member" as const,
          resourceId: `${projectId}:${memberUserId}`,
          resourceName: memberUserId,
          details: {
            projectId,
            targetUserId: memberUserId,
            previousRole: previousRole ?? null,
            nextRole: null,
          },
        };
        await auditAuthorizationIntent(dependencies, req, audit);
        await dependencies.terminalLifecycleCoordinator.runDestructiveOperation(
          { projectHostIds, userIds: [memberUserId] },
          () => {
            const pinnedSessions = dependencies.findTerminalSessions({
              projectHostIds,
              userId: memberUserId,
              pinned: true,
            });
            if (pinnedSessions.length > 0) {
              throw new ControlPlaneManagementError(
                409,
                "Project member still owns pinned terminal windows; terminate them before removing access",
              );
            }
            repository.removeProjectMember(
              projectId,
              userId,
              isInstanceAdmin,
              memberUserId,
            );
          },
        );
        await dependencies.afterMutation("project_member_remove");
        await auditAuthorizationResult(dependencies, req, audit);
        return res.status(204).send();
      } catch (error) {
        return respondError(res, error, "project_member_remove", userId);
      }
    },
  );

  router.post(
    "/projects/:projectId/servers",
    async (req: AuthenticatedRequest, res) => {
      const userId = req.userId;
      try {
        const hostId = req.body?.hostId;
        if (!Number.isSafeInteger(hostId) || hostId <= 0) {
          throw new ControlPlaneManagementError(400, "Invalid hostId");
        }
        const rawAlias = req.body?.alias;
        const alias =
          rawAlias === undefined || rawAlias === null || rawAlias === ""
            ? null
            : requiredString(rawAlias, "alias", 128);
        const projectId = param(req, "projectId");
        const isInstanceAdmin = await adminStatus(dependencies, userId);
        const repository = dependencies.createRepository();
        const server = repository.associateHost(
          projectId,
          userId,
          isInstanceAdmin,
          hostId,
          alias,
        );
        if (server.connectionType === "ssh") {
          await dependencies.terminalLifecycleCoordinator.runDestructiveOperation(
            { projectHostIds: [server.projectHostId] },
            async () => {
              try {
                await dependencies.initializeProjectHostCredential({
                  projectId,
                  projectHostId: server.projectHostId,
                  hostId,
                  createdBy: userId,
                });
              } catch (error) {
                try {
                  repository.removeHost(
                    projectId,
                    userId,
                    isInstanceAdmin,
                    server.projectHostId,
                  );
                  dependencies.terminalLifecycleCoordinator.retire({
                    projectHostIds: [server.projectHostId],
                  });
                } catch (rollbackError) {
                  databaseLogger.error(
                    "Failed to roll back project host association",
                    rollbackError,
                    {
                      operation: "project_host_associate_rollback",
                      userId,
                      projectId,
                      hostId,
                      projectHostId: server.projectHostId,
                    },
                  );
                  throw new ControlPlaneManagementError(
                    503,
                    "Project host association could not be rolled back",
                  );
                }
                databaseLogger.warn(
                  "Project host credential initialization failed",
                  {
                    operation: "project_host_credential_initialize",
                    userId,
                    projectId,
                    hostId,
                    projectHostId: server.projectHostId,
                    errorType:
                      error instanceof Error ? error.name : "UnknownError",
                  },
                );
                throw new ControlPlaneManagementError(
                  409,
                  "Host credentials could not be prepared for project access",
                );
              }
            },
          );
        }
        await dependencies.afterMutation("project_host_associate");
        return res.status(201).json({ server });
      } catch (error) {
        return respondError(res, error, "project_host_associate", userId);
      }
    },
  );

  router.get(
    "/projects/:projectId/folders",
    async (req: AuthenticatedRequest, res) => {
      const userId = req.userId;
      try {
        const folders = dependencies
          .createRepository()
          .listProjectFolders(
            param(req, "projectId"),
            userId,
            await adminStatus(dependencies, userId),
          );
        return res.json({ folders });
      } catch (error) {
        return respondError(res, error, "project_folder_list", userId);
      }
    },
  );

  router.put(
    "/projects/:projectId/folders/metadata",
    async (req: AuthenticatedRequest, res) => {
      const userId = req.userId;
      try {
        const folder = dependencies
          .createRepository()
          .saveProjectFolder(
            param(req, "projectId"),
            userId,
            await adminStatus(dependencies, userId),
            {
              path: folderPath(req.body?.path),
              color: nullableStyleValue(req.body?.color, "color"),
              icon: nullableStyleValue(req.body?.icon, "icon"),
            },
          );
        await dependencies.afterMutation("project_folder_save");
        return res.json({ folder });
      } catch (error) {
        return respondError(res, error, "project_folder_save", userId);
      }
    },
  );

  router.put(
    "/projects/:projectId/folders/rename",
    async (req: AuthenticatedRequest, res) => {
      const userId = req.userId;
      try {
        const result = dependencies
          .createRepository()
          .renameProjectFolder(
            param(req, "projectId"),
            userId,
            await adminStatus(dependencies, userId),
            folderPath(req.body?.oldPath, "oldPath"),
            folderPath(req.body?.newPath, "newPath"),
          );
        if (result.updatedFolders > 0 || result.updatedHosts > 0) {
          await dependencies.afterMutation("project_folder_rename");
        }
        return res.json(result);
      } catch (error) {
        return respondError(res, error, "project_folder_rename", userId);
      }
    },
  );

  router.delete(
    "/projects/:projectId/folders",
    async (req: AuthenticatedRequest, res) => {
      const userId = req.userId;
      try {
        const result = dependencies
          .createRepository()
          .deleteProjectFolder(
            param(req, "projectId"),
            userId,
            await adminStatus(dependencies, userId),
            folderPath(req.body?.path),
          );
        await dependencies.afterMutation("project_folder_delete");
        return res.json(result);
      } catch (error) {
        return respondError(res, error, "project_folder_delete", userId);
      }
    },
  );

  router.put(
    "/projects/:projectId/servers/folder",
    async (req: AuthenticatedRequest, res) => {
      const userId = req.userId;
      try {
        const rawIds = req.body?.projectHostIds;
        if (
          !Array.isArray(rawIds) ||
          rawIds.length === 0 ||
          rawIds.length > 500 ||
          rawIds.some((id) => !Number.isSafeInteger(id) || Number(id) <= 0)
        ) {
          throw new ControlPlaneManagementError(400, "Invalid projectHostIds");
        }
        const rawFolder = req.body?.folder;
        const targetFolder =
          rawFolder === undefined || rawFolder === null || rawFolder === ""
            ? null
            : folderPath(rawFolder, "folder");
        const result = dependencies
          .createRepository()
          .moveProjectHosts(
            param(req, "projectId"),
            userId,
            await adminStatus(dependencies, userId),
            rawIds as number[],
            targetFolder,
          );
        await dependencies.afterMutation("project_host_folder_move");
        return res.json(result);
      } catch (error) {
        return respondError(res, error, "project_host_folder_move", userId);
      }
    },
  );

  router.patch(
    "/projects/:projectId/servers/:projectHostId",
    async (req: AuthenticatedRequest, res) => {
      const userId = req.userId;
      try {
        const projectHostId = positiveIntegerParam(req, "projectHostId");
        const rawAlias = req.body?.alias;
        const alias =
          rawAlias === undefined || rawAlias === null || rawAlias === ""
            ? null
            : requiredString(rawAlias, "alias", 128);
        const rawFolder = req.body?.folder;
        const folder =
          rawFolder === undefined || rawFolder === null || rawFolder === ""
            ? null
            : folderPath(rawFolder, "folder");
        const tags = projectTags(req.body?.tags);
        const server = dependencies
          .createRepository()
          .updateProjectHostMetadata(
            param(req, "projectId"),
            userId,
            await adminStatus(dependencies, userId),
            projectHostId,
            { alias, folder, tags },
          );
        await dependencies.afterMutation("project_host_metadata_update");
        return res.json({ server });
      } catch (error) {
        return respondError(res, error, "project_host_metadata_update", userId);
      }
    },
  );

  router.delete(
    "/projects/:projectId/servers/:projectHostId",
    async (req: AuthenticatedRequest, res) => {
      const userId = req.userId;
      try {
        const projectHostId = Number(param(req, "projectHostId"));
        if (!Number.isSafeInteger(projectHostId) || projectHostId <= 0) {
          throw new ControlPlaneManagementError(400, "Invalid projectHostId");
        }
        const projectId = param(req, "projectId");
        const isInstanceAdmin = await adminStatus(dependencies, userId);
        const repository = dependencies.createRepository();
        const target = repository.getProjectHostLifecycleTarget(
          projectId,
          userId,
          isInstanceAdmin,
          projectHostId,
        );
        await dependencies.terminalLifecycleCoordinator.runDestructiveOperation(
          { projectHostIds: [target.projectHostId] },
          () => {
            const activeSessions = dependencies.findTerminalSessions({
              projectHostId: target.projectHostId,
            });
            if (activeSessions.length > 0) {
              throw new ControlPlaneManagementError(
                409,
                "Project host still has active terminal sessions",
              );
            }
            repository.removeHost(
              projectId,
              userId,
              isInstanceAdmin,
              projectHostId,
            );
            dependencies.terminalLifecycleCoordinator.retire({
              projectHostIds: [target.projectHostId],
            });
          },
        );
        await dependencies.afterMutation("project_host_remove");
        return res.status(204).send();
      } catch (error) {
        return respondError(res, error, "project_host_remove", userId);
      }
    },
  );

  return router;
}
