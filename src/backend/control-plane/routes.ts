import express, { type RequestHandler, type Response } from "express";
import type { AuthenticatedRequest } from "../../types/index.js";
import { AuthManager } from "../utils/auth-manager.js";
import { logAuditOrThrow, type AuditLogParams } from "../utils/audit-logger.js";
import { databaseLogger } from "../utils/logger.js";
import { PermissionManager } from "../utils/permission-manager.js";
import { createCurrentProjectRepository } from "./factory.js";
import type { ProjectRepository } from "./project-repository.js";
import { createCurrentRepositoryContext } from "../database/repositories/factory.js";
import { DatabaseSaveTrigger } from "../utils/database-save-trigger.js";
import { ProjectCredentialRepository } from "./credential-repository.js";
import {
  loadPlatformMasterKey,
  PlatformCredentialVault,
} from "./credential-vault.js";
import { ManagementRepository } from "./management-repository.js";
import { createManagementRouter } from "./management-routes.js";
import {
  initializeProjectHostCredential,
  type ProjectHostCredentialInitialization,
} from "../hosts/host-resolver.js";
import {
  sessionManager,
  type TerminalSessionFilter,
} from "../hosts/terminal/session-manager.js";
import {
  terminalSessionLifecycleCoordinator,
  type TerminalSessionLifecycleCoordinator,
} from "../hosts/terminal/session-lifecycle-coordinator.js";

type ProjectReadRepository = Pick<
  ProjectRepository,
  | "listVisibleProjects"
  | "findVisibleProject"
  | "listProjectServers"
  | "getProjectOverview"
>;

export interface ControlPlaneRouterDependencies {
  authenticate: RequestHandler;
  createRepository: () => ProjectReadRepository;
  createManagementRepository?: () => ManagementRepository;
  isInstanceAdmin: (userId: string) => Promise<boolean>;
  afterMutation?: (reason: string) => Promise<void>;
  notifyHostDeleted?: (
    hostId: number,
    request: AuthenticatedRequest,
    scopeUserId?: string,
  ) => Promise<void>;
  initializeProjectHostCredential?: (
    input: ProjectHostCredentialInitialization,
  ) => Promise<void>;
  audit?: (entry: AuditLogParams) => Promise<void>;
  findTerminalSessions?: (filter: TerminalSessionFilter) => readonly unknown[];
  terminalLifecycleCoordinator?: Pick<
    TerminalSessionLifecycleCoordinator,
    "runDestructiveOperation" | "retire"
  >;
}

const STATS_SERVER_URL = "http://localhost:30005";

async function notifyHostDeleted(
  hostId: number,
  request: AuthenticatedRequest,
  scopeUserId?: string,
): Promise<void> {
  const axios = (await import("axios")).default;
  await axios.post(
    `${STATS_SERVER_URL}/host-deleted`,
    { hostId, scopeUserId: scopeUserId ?? request.userId },
    {
      headers: {
        Authorization: request.headers.authorization || "",
        Cookie: request.headers.cookie || "",
      },
      timeout: 5000,
    },
  );
}

function defaultDependencies(): ControlPlaneRouterDependencies {
  return {
    authenticate: AuthManager.getInstance().createAuthMiddleware(),
    createRepository: createCurrentProjectRepository,
    createManagementRepository: () =>
      new ManagementRepository(createCurrentRepositoryContext()),
    isInstanceAdmin: (userId) =>
      PermissionManager.getInstance().isAdmin(userId),
    afterMutation: (reason) => DatabaseSaveTrigger.forceSave(reason),
    initializeProjectHostCredential,
    audit: logAuditOrThrow,
  };
}

function projectIdFromRequest(req: AuthenticatedRequest): string | null {
  const value = Array.isArray(req.params.projectId)
    ? req.params.projectId[0]
    : req.params.projectId;
  if (typeof value !== "string") return null;
  const projectId = value.trim();
  return projectId.length > 0 && projectId.length <= 128 ? projectId : null;
}

function handleRouteError(
  res: Response,
  error: unknown,
  operation: string,
  userId: string,
  projectId?: string,
) {
  databaseLogger.error("Control plane project request failed", error, {
    operation,
    userId,
    projectId,
  });
  return res.status(500).json({ error: "Failed to load project data" });
}

async function credentialRepository() {
  return new ProjectCredentialRepository(
    createCurrentRepositoryContext(),
    new PlatformCredentialVault(await loadPlatformMasterKey()),
  );
}

function requiredBodyString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw Object.assign(new Error(`${field} is required`), { status: 400 });
  }
  if (value.length > maxLength) {
    throw Object.assign(new Error(`${field} is too long`), { status: 400 });
  }
  return value.trim();
}

export function createControlPlaneRouter(
  dependencies: ControlPlaneRouterDependencies = defaultDependencies(),
) {
  const router = express.Router();

  router.use(dependencies.authenticate);
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    next();
  });

  const createManagementRepository =
    dependencies.createManagementRepository ??
    (() => new ManagementRepository(createCurrentRepositoryContext()));
  const afterMutation =
    dependencies.afterMutation ??
    ((reason: string) => DatabaseSaveTrigger.forceSave(reason));
  router.use(
    createManagementRouter({
      createRepository: createManagementRepository,
      isInstanceAdmin: dependencies.isInstanceAdmin,
      afterMutation,
      notifyHostDeleted: dependencies.notifyHostDeleted ?? notifyHostDeleted,
      initializeProjectHostCredential:
        dependencies.initializeProjectHostCredential ??
        initializeProjectHostCredential,
      audit: dependencies.audit ?? logAuditOrThrow,
      findTerminalSessions:
        dependencies.findTerminalSessions ??
        ((filter) => sessionManager.findSessions(filter)),
      terminalLifecycleCoordinator:
        dependencies.terminalLifecycleCoordinator ??
        terminalSessionLifecycleCoordinator,
    }),
  );

  // 返回当前用户通过个人、项目、团队或实例管理员身份可见的项目。
  router.get("/projects", async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.userId;
    try {
      const bootstrap =
        createManagementRepository().bootstrapPersonalProject(userId);
      if (bootstrap.changed) await afterMutation("personal_bootstrap");
      const projects = await dependencies
        .createRepository()
        .listVisibleProjects(
          userId,
          await dependencies.isInstanceAdmin(userId),
        );
      return res.json({ projects });
    } catch (error) {
      return handleRouteError(
        res,
        error,
        "control_plane_projects_list",
        userId,
      );
    }
  });

  // 未授权项目与不存在项目都返回 404，避免泄露项目是否存在。
  router.get(
    "/projects/:projectId",
    async (req: AuthenticatedRequest, res: Response) => {
      const userId = req.userId;
      const projectId = projectIdFromRequest(req);
      if (!projectId) {
        return res.status(400).json({ error: "Invalid project ID" });
      }

      try {
        const project = await dependencies
          .createRepository()
          .findVisibleProject(
            projectId,
            userId,
            await dependencies.isInstanceAdmin(userId),
          );
        if (!project) {
          return res.status(404).json({ error: "Project not found" });
        }
        return res.json({ project });
      } catch (error) {
        return handleRouteError(
          res,
          error,
          "control_plane_project_detail",
          userId,
          projectId,
        );
      }
    },
  );

  router.get(
    "/projects/:projectId/credentials",
    async (req: AuthenticatedRequest, res: Response) => {
      const userId = req.userId;
      const projectId = projectIdFromRequest(req);
      if (!projectId)
        return res.status(400).json({ error: "Invalid project ID" });
      try {
        const project = await dependencies
          .createRepository()
          .findVisibleProject(
            projectId,
            userId,
            await dependencies.isInstanceAdmin(userId),
          );
        if (!project)
          return res.status(404).json({ error: "Project not found" });
        return res.json({
          credentials: await (await credentialRepository()).list(projectId),
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Credential vault unavailable";
        if (message.includes("CLOUDSSH_MASTER_KEY")) {
          return res.status(503).json({
            error: "Credential vault is locked",
            code: "VAULT_LOCKED",
          });
        }
        return handleRouteError(
          res,
          error,
          "project_credentials_list",
          userId,
          projectId,
        );
      }
    },
  );

  router.post(
    "/projects/:projectId/credentials",
    async (req: AuthenticatedRequest, res: Response) => {
      const userId = req.userId;
      const projectId = projectIdFromRequest(req);
      if (!projectId)
        return res.status(400).json({ error: "Invalid project ID" });
      try {
        const isInstanceAdmin = await dependencies.isInstanceAdmin(userId);
        const project = await dependencies
          .createRepository()
          .findVisibleProject(projectId, userId, isInstanceAdmin);
        if (!project)
          return res.status(404).json({ error: "Project not found" });
        if (!isInstanceAdmin && project.role !== "project_admin") {
          return res
            .status(403)
            .json({ error: "Project administrator required" });
        }
        const authType = req.body?.authType;
        if (!["password", "key", "none"].includes(authType)) {
          return res.status(400).json({ error: "Invalid authentication type" });
        }
        const secret = {
          password:
            typeof req.body?.password === "string"
              ? req.body.password
              : undefined,
          privateKey:
            typeof req.body?.privateKey === "string"
              ? req.body.privateKey
              : undefined,
          passphrase:
            typeof req.body?.passphrase === "string"
              ? req.body.passphrase
              : undefined,
        };
        if (authType === "password" && !secret.password) {
          return res.status(400).json({ error: "Password is required" });
        }
        if (authType === "key" && !secret.privateKey) {
          return res.status(400).json({ error: "Private key is required" });
        }
        const credential = await (
          await credentialRepository()
        ).create({
          projectId,
          name: requiredBodyString(req.body?.name, "name", 128),
          username: requiredBodyString(req.body?.username, "username", 128),
          authType,
          keyType:
            typeof req.body?.keyType === "string" ? req.body.keyType : null,
          secret,
          createdBy: userId,
        });
        await DatabaseSaveTrigger.forceSave("project_credential_create");
        return res.status(201).json({ credential });
      } catch (error) {
        const shaped = error as { status?: number; message?: string };
        if (shaped.status)
          return res.status(shaped.status).json({ error: shaped.message });
        if (shaped.message?.includes("CLOUDSSH_MASTER_KEY")) {
          return res.status(503).json({
            error: "Credential vault is locked",
            code: "VAULT_LOCKED",
          });
        }
        return handleRouteError(
          res,
          error,
          "project_credential_create",
          userId,
          projectId,
        );
      }
    },
  );

  router.put(
    "/projects/:projectId/servers/:projectHostId/credential",
    async (req: AuthenticatedRequest, res: Response) => {
      const userId = req.userId;
      const projectId = projectIdFromRequest(req);
      const projectHostId = Number(req.params.projectHostId);
      if (
        !projectId ||
        !Number.isSafeInteger(projectHostId) ||
        projectHostId <= 0
      ) {
        return res.status(400).json({ error: "Invalid project host" });
      }
      try {
        const isInstanceAdmin = await dependencies.isInstanceAdmin(userId);
        const project = await dependencies
          .createRepository()
          .findVisibleProject(projectId, userId, isInstanceAdmin);
        if (!project)
          return res.status(404).json({ error: "Project not found" });
        if (!isInstanceAdmin && project.role !== "project_admin") {
          return res
            .status(403)
            .json({ error: "Project administrator required" });
        }
        const credentialId =
          typeof req.body?.credentialId === "string"
            ? req.body.credentialId
            : null;
        const assigned = await (
          await credentialRepository()
        ).assignToProjectHost(projectId, projectHostId, credentialId);
        if (!assigned)
          return res
            .status(404)
            .json({ error: "Credential or project host not found" });
        await DatabaseSaveTrigger.forceSave("project_credential_assign");
        return res.json({ assigned: true });
      } catch (error) {
        return handleRouteError(
          res,
          error,
          "project_credential_assign",
          userId,
          projectId,
        );
      }
    },
  );

  router.delete(
    "/projects/:projectId/credentials/:credentialId",
    async (req: AuthenticatedRequest, res: Response) => {
      const userId = req.userId;
      const projectId = projectIdFromRequest(req);
      const credentialId = String(req.params.credentialId || "");
      if (!projectId || !credentialId)
        return res.status(400).json({ error: "Invalid credential" });
      try {
        const isInstanceAdmin = await dependencies.isInstanceAdmin(userId);
        const project = await dependencies
          .createRepository()
          .findVisibleProject(projectId, userId, isInstanceAdmin);
        if (!project)
          return res.status(404).json({ error: "Project not found" });
        if (!isInstanceAdmin && project.role !== "project_admin") {
          return res
            .status(403)
            .json({ error: "Project administrator required" });
        }
        const removed = await (
          await credentialRepository()
        ).remove(projectId, credentialId);
        if (!removed)
          return res.status(404).json({ error: "Credential not found" });
        await DatabaseSaveTrigger.forceSave("project_credential_delete");
        return res.status(204).send();
      } catch (error) {
        return handleRouteError(
          res,
          error,
          "project_credential_delete",
          userId,
          projectId,
        );
      }
    },
  );

  // 只返回工作台展示和连接选择所需字段，不返回任何认证字段或凭据编号。
  router.get(
    "/projects/:projectId/servers",
    async (req: AuthenticatedRequest, res: Response) => {
      const userId = req.userId;
      const projectId = projectIdFromRequest(req);
      if (!projectId) {
        return res.status(400).json({ error: "Invalid project ID" });
      }

      try {
        const servers = await dependencies
          .createRepository()
          .listProjectServers(
            projectId,
            userId,
            await dependencies.isInstanceAdmin(userId),
          );
        if (!servers) {
          return res.status(404).json({ error: "Project not found" });
        }
        return res.json({ servers });
      } catch (error) {
        return handleRouteError(
          res,
          error,
          "control_plane_project_servers",
          userId,
          projectId,
        );
      }
    },
  );

  router.get(
    "/projects/:projectId/overview",
    async (req: AuthenticatedRequest, res: Response) => {
      const userId = req.userId;
      const projectId = projectIdFromRequest(req);
      if (!projectId) {
        return res.status(400).json({ error: "Invalid project ID" });
      }

      try {
        const overview = await dependencies
          .createRepository()
          .getProjectOverview(
            projectId,
            userId,
            await dependencies.isInstanceAdmin(userId),
          );
        if (!overview) {
          return res.status(404).json({ error: "Project not found" });
        }
        return res.json(overview);
      } catch (error) {
        return handleRouteError(
          res,
          error,
          "control_plane_project_overview",
          userId,
          projectId,
        );
      }
    },
  );

  return router;
}

export default createControlPlaneRouter();
