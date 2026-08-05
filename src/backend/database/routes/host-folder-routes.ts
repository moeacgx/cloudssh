import type { Request, RequestHandler, Response, Router } from "express";
import type { AuthenticatedRequest } from "../../../types/index.js";
import { databaseLogger, sshLogger } from "../../utils/logger.js";
import {
  createCurrentCredentialRepository,
  createCurrentHostFolderRepository,
  createCurrentWebTerminalSessionRepository,
} from "../repositories/factory.js";
import { isNonEmptyString } from "./host-normalizers.js";
import { synchronizeProjectHostCredentialsForOwner } from "../../hosts/host-resolver.js";
import { sessionManager } from "../../hosts/terminal/session-manager.js";
import { terminalSessionLifecycleCoordinator } from "../../hosts/terminal/session-lifecycle-coordinator.js";
import { FolderHostsHavePersistentSessionsError } from "../repositories/host-folder-repository.js";

type HostFolderRoutesDeps = {
  authenticateJWT: RequestHandler;
  statsServerUrl: string;
};

export function registerHostFolderRoutes(
  router: Router,
  { authenticateJWT, statsServerUrl }: HostFolderRoutesDeps,
): void {
  /**
   * @openapi
   * /host/folders/rename:
   *   put:
   *     summary: Rename folder
   *     description: Renames a folder for SSH hosts and credentials.
   *     tags:
   *       - SSH
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               oldName:
   *                 type: string
   *               newName:
   *                 type: string
   *     responses:
   *       200:
   *         description: Folder renamed successfully.
   *       400:
   *         description: Old name and new name are required.
   *       500:
   *         description: Failed to rename folder.
   */
  router.put(
    "/folders/rename",
    authenticateJWT,
    async (req: Request, res: Response) => {
      const userId = (req as AuthenticatedRequest).userId;
      const { oldName, newName } = req.body;

      if (!isNonEmptyString(userId) || !oldName || !newName) {
        sshLogger.warn("Invalid data for folder rename");
        return res
          .status(400)
          .json({ error: "Old name and new name are required" });
      }

      if (oldName === newName) {
        return res.json({ message: "Folder name unchanged" });
      }

      try {
        const { updatedHosts, updatedCredentials } =
          await createCurrentHostFolderRepository().renameFolder(
            userId,
            oldName,
            newName,
          );

        res.json({
          message: "Folder renamed successfully",
          updatedHosts,
          updatedCredentials,
        });
      } catch (err) {
        sshLogger.error("Failed to rename folder", err, {
          operation: "folder_rename",
          userId,
          oldName,
          newName,
        });
        res.status(500).json({ error: "Failed to rename folder" });
      }
    },
  );

  /**
   * @openapi
   * /host/folders:
   *   get:
   *     summary: Get all folders
   *     description: Retrieves all folders for the authenticated user.
   *     tags:
   *       - SSH
   *     responses:
   *       200:
   *         description: A list of folders.
   *       400:
   *         description: Invalid user ID.
   *       500:
   *         description: Failed to fetch folders.
   */
  router.get(
    "/folders",
    authenticateJWT,
    async (req: Request, res: Response) => {
      const userId = (req as AuthenticatedRequest).userId;

      if (!isNonEmptyString(userId)) {
        return res.status(400).json({ error: "Invalid user ID" });
      }

      try {
        const folders =
          await createCurrentHostFolderRepository().listFolders(userId);

        res.json(folders);
      } catch (err) {
        sshLogger.error("Failed to fetch folders", err, {
          operation: "fetch_folders",
          userId,
        });
        res.status(500).json({ error: "Failed to fetch folders" });
      }
    },
  );

  /**
   * @openapi
   * /host/folders/metadata:
   *   put:
   *     summary: Update folder metadata
   *     description: Updates the metadata (color, icon, assigned credential) of a folder.
   *     tags:
   *       - SSH
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               name:
   *                 type: string
   *               color:
   *                 type: string
   *               icon:
   *                 type: string
   *               credentialId:
   *                 type: integer
   *                 nullable: true
   *     responses:
   *       200:
   *         description: Folder metadata updated successfully.
   *       400:
   *         description: Folder name is required.
   *       500:
   *         description: Failed to update folder metadata.
   */
  router.put(
    "/folders/metadata",
    authenticateJWT,
    async (req: Request, res: Response) => {
      const userId = (req as AuthenticatedRequest).userId;
      const { name, color, icon, credentialId } = req.body;

      if (!isNonEmptyString(userId) || !name) {
        return res.status(400).json({ error: "Folder name is required" });
      }

      const normalizedCredentialId =
        credentialId === undefined
          ? undefined
          : credentialId === null || credentialId === ""
            ? null
            : Number(credentialId);

      if (
        normalizedCredentialId !== undefined &&
        normalizedCredentialId !== null &&
        !Number.isInteger(normalizedCredentialId)
      ) {
        return res.status(400).json({ error: "Invalid credential ID" });
      }

      try {
        if (normalizedCredentialId) {
          const credential =
            await createCurrentCredentialRepository().findByIdForUser(
              userId,
              normalizedCredentialId,
            );
          if (!credential) {
            return res.status(404).json({ error: "Credential not found" });
          }
        }

        const { folder, created } =
          await createCurrentHostFolderRepository().upsertMetadata(
            userId,
            name,
            color,
            icon,
            normalizedCredentialId,
          );

        if (!created) {
          databaseLogger.info("Updating SSH folder", {
            operation: "folder_update",
            userId,
            folderId: folder.id,
          });
        } else {
          databaseLogger.info("Creating SSH folder", {
            operation: "folder_create",
            userId,
            name,
          });
        }

        if (normalizedCredentialId !== undefined) {
          try {
            await synchronizeProjectHostCredentialsForOwner(userId);
          } catch (error) {
            databaseLogger.warn(
              "Failed to resync project credentials after folder update",
              {
                operation: "folder_project_credential_resync",
                userId,
                errorType: error instanceof Error ? error.name : "UnknownError",
              },
            );
          }
        }

        res.json({ message: "Folder metadata updated successfully" });
      } catch (err) {
        sshLogger.error("Failed to update folder metadata", err, {
          operation: "update_folder_metadata",
          userId,
          name,
        });
        res.status(500).json({ error: "Failed to update folder metadata" });
      }
    },
  );

  /**
   * @openapi
   * /host/folders/{name}/hosts:
   *   delete:
   *     summary: Delete all hosts in folder
   *     description: Deletes all SSH hosts within a specific folder.
   *     tags:
   *       - SSH
   *     parameters:
   *       - in: path
   *         name: name
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Hosts deleted successfully.
   *       400:
   *         description: Invalid folder name.
   *       500:
   *         description: Failed to delete hosts in folder.
   */
  router.delete(
    "/folders/:name/hosts",
    authenticateJWT,
    async (req: Request, res: Response) => {
      const userId = (req as AuthenticatedRequest).userId;
      const folderName = Array.isArray(req.params.name)
        ? req.params.name[0]
        : req.params.name;

      if (!isNonEmptyString(userId) || !folderName) {
        return res.status(400).json({ error: "Invalid folder name" });
      }
      databaseLogger.info("Deleting SSH folder", {
        operation: "folder_delete",
        userId,
        folderId: folderName,
      });

      try {
        const hostFolderRepository = createCurrentHostFolderRepository();
        const hostsToDelete = await hostFolderRepository.listHostsInFolder(
          userId,
          folderName,
        );

        const hostIds = hostsToDelete.map((host) => host.id);

        const deletionResult =
          await terminalSessionLifecycleCoordinator.runDestructiveOperation(
            { hostIds },
            async () => {
              const activeSessions = sessionManager.findSessions({ hostIds });
              if (activeSessions.length > 0) {
                return {
                  blockedBy: "active" as const,
                  count: activeSessions.length,
                };
              }

              if (hostIds.length > 0) {
                const fixedSessions =
                  await createCurrentWebTerminalSessionRepository().listForHosts(
                    hostIds,
                  );
                if (fixedSessions.length > 0) {
                  return {
                    blockedBy: "pinned" as const,
                    count: fixedSessions.length,
                  };
                }
              }

              try {
                await hostFolderRepository.deleteHostsAndFolderRecords(
                  userId,
                  folderName,
                );
              } catch (error) {
                if (error instanceof FolderHostsHavePersistentSessionsError) {
                  return {
                    blockedBy: "persistent" as const,
                    count: error.count,
                  };
                }
                throw error;
              }

              terminalSessionLifecycleCoordinator.retire({ hostIds });
              return { blockedBy: null };
            },
          );

        if (deletionResult.blockedBy === "active") {
          return res.status(409).json({
            error:
              "This folder contains hosts with active terminal sessions. Terminate them before deleting these hosts.",
            code: "FOLDER_HAS_ACTIVE_TERMINAL_SESSIONS",
            count: deletionResult.count,
          });
        }
        if (deletionResult.blockedBy === "pinned") {
          return res.status(409).json({
            error:
              "This folder contains hosts with pinned terminal windows. Terminate them before deleting these hosts.",
            code: "FOLDER_HAS_PINNED_TERMINALS",
            count: deletionResult.count,
          });
        }
        if (deletionResult.blockedBy === "persistent") {
          return res.status(409).json({
            error:
              "This folder contains hosts with persistent session history. Close or remove those sessions before deleting these hosts.",
            code: "FOLDER_HAS_PERSISTENT_SESSIONS",
            count: deletionResult.count,
          });
        }

        try {
          const axios = (await import("axios")).default;
          for (const host of hostsToDelete) {
            try {
              await axios.post(
                `${statsServerUrl}/host-deleted`,
                { hostId: host.id, scopeUserId: userId },
                {
                  headers: {
                    Authorization: req.headers.authorization || "",
                    Cookie: req.headers.cookie || "",
                  },
                  timeout: 5000,
                },
              );
            } catch (err) {
              sshLogger.warn("Failed to notify stats server of host deletion", {
                operation: "folder_hosts_delete",
                hostId: host.id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        } catch (err) {
          sshLogger.warn("Failed to notify stats server of folder deletion", {
            operation: "folder_hosts_delete",
            folderName,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        res.json({
          message: "All hosts in folder deleted successfully",
          deletedCount: hostsToDelete.length,
        });
      } catch (err) {
        sshLogger.error("Failed to delete hosts in folder", err, {
          operation: "delete_folder_hosts",
          userId,
          folderName,
        });
        res.status(500).json({ error: "Failed to delete hosts in folder" });
      }
    },
  );
}
