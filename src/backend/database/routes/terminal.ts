import type { AuthenticatedRequest } from "../../../types/index.js";
import express from "express";
import type { Request, Response } from "express";
import { authLogger, databaseLogger } from "../../utils/logger.js";
import { getRequestMeta, logAudit } from "../../utils/audit-logger.js";
import { AuthManager } from "../../utils/auth-manager.js";
import {
  createCurrentCommandHistoryRepository,
  createCurrentHostResolutionRepository,
  createCurrentSettingsRepository,
} from "../repositories/factory.js";
import { sessionManager } from "../../hosts/terminal/session-manager.js";

const router = express.Router();

function isNonEmptyString(val: unknown): val is string {
  return typeof val === "string" && val.trim().length > 0;
}

const authManager = AuthManager.getInstance();
const authenticateJWT = authManager.createAuthMiddleware();
const requireAdmin = authManager.createAdminMiddleware();
const requireDataAccess = authManager.createDataAccessMiddleware();

export function isValidTerminalSessionTimeoutMinutes(
  value: unknown,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 10080
  );
}

/**
 * @openapi
 * /terminal/command_history:
 *   post:
 *     summary: Save command to history
 *     description: Saves a command to the command history for a specific host.
 *     tags:
 *       - Terminal
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               hostId:
 *                 type: integer
 *               command:
 *                 type: string
 *     responses:
 *       201:
 *         description: Command saved successfully.
 *       400:
 *         description: Missing required parameters.
 *       500:
 *         description: Failed to save command.
 */
router.post(
  "/command_history",
  authenticateJWT,
  requireDataAccess,
  async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const { hostId, command } = req.body;

    if (!isNonEmptyString(userId) || !hostId || !isNonEmptyString(command)) {
      authLogger.warn("Invalid command history save request", {
        operation: "command_history_save",
        userId,
        hasHostId: !!hostId,
        hasCommand: !!command,
      });
      return res.status(400).json({ error: "Missing required parameters" });
    }

    const sensitivePatterns = [
      /passw(or)?d/i,
      /\bsecret\b/i,
      /\btoken\b/i,
      /\bapi.?key\b/i,
      /PASS(WORD)?=/i,
      /AWS_SECRET/i,
      /mysql\b.*-p/i,
      /sudo\s+-S\b/,
      /htpasswd/i,
      /sshpass/i,
      /curl\b.*-u\s/i,
      /export\b.*(?:PASSWORD|SECRET|TOKEN|KEY)=/i,
    ];

    const trimmedCommand = command.trim();
    if (sensitivePatterns.some((p: RegExp) => p.test(trimmedCommand))) {
      return res.status(201).json({
        id: 0,
        userId,
        hostId: parseInt(hostId, 10),
        command: trimmedCommand,
        executedAt: new Date().toISOString(),
      });
    }

    const globalEnabled = await createCurrentSettingsRepository().getBoolean(
      "command_history_enabled",
      true,
    );
    if (!globalEnabled) {
      return res.status(201).json({
        id: 0,
        userId,
        hostId: parseInt(hostId, 10),
        command: trimmedCommand,
        executedAt: new Date().toISOString(),
      });
    }

    const hostRecord =
      await createCurrentHostResolutionRepository().findHostById(
        parseInt(hostId, 10),
        userId,
      );
    if (hostRecord?.enableCommandHistory === false) {
      return res.status(201).json({
        id: 0,
        userId,
        hostId: parseInt(hostId, 10),
        command: trimmedCommand,
        executedAt: new Date().toISOString(),
      });
    }

    try {
      const result = await createCurrentCommandHistoryRepository().create(
        userId,
        parseInt(hostId, 10),
        trimmedCommand,
      );

      res.status(201).json(result);
    } catch (err) {
      authLogger.error("Failed to save command to history", err);
      res.status(500).json({
        error: err instanceof Error ? err.message : "Failed to save command",
      });
    }
  },
);

/**
 * @openapi
 * /terminal/command_history/{hostId}:
 *   get:
 *     summary: Get command history
 *     description: Retrieves the command history for a specific host.
 *     tags:
 *       - Terminal
 *     parameters:
 *       - in: path
 *         name: hostId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: A list of commands.
 *       400:
 *         description: Invalid request parameters.
 *       500:
 *         description: Failed to fetch history.
 */
router.get(
  "/command_history/:hostId",
  authenticateJWT,
  requireDataAccess,
  async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const hostId = Array.isArray(req.params.hostId)
      ? req.params.hostId[0]
      : req.params.hostId;
    const hostIdNum = parseInt(hostId, 10);

    if (!isNonEmptyString(userId) || isNaN(hostIdNum)) {
      authLogger.warn("Invalid command history fetch request", {
        userId,
        hostId: hostIdNum,
      });
      return res.status(400).json({ error: "Invalid request parameters" });
    }

    try {
      const uniqueCommands =
        await createCurrentCommandHistoryRepository().listUniqueCommandsForHost(
          userId,
          hostIdNum,
        );

      res.json(uniqueCommands);
    } catch (err) {
      authLogger.error("Failed to fetch command history", err);
      res.status(500).json({
        error: err instanceof Error ? err.message : "Failed to fetch history",
      });
    }
  },
);

/**
 * @openapi
 * /terminal/command_history/delete:
 *   post:
 *     summary: Delete a specific command from history
 *     description: Deletes a specific command from the history of a host.
 *     tags:
 *       - Terminal
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               hostId:
 *                 type: integer
 *               command:
 *                 type: string
 *     responses:
 *       200:
 *         description: Command deleted successfully.
 *       400:
 *         description: Missing required parameters.
 *       500:
 *         description: Failed to delete command.
 */
router.post(
  "/command_history/delete",
  authenticateJWT,
  requireDataAccess,
  async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const { hostId, command } = req.body;

    if (!isNonEmptyString(userId) || !hostId || !isNonEmptyString(command)) {
      authLogger.warn("Invalid command delete request", {
        operation: "command_history_delete",
        userId,
        hasHostId: !!hostId,
        hasCommand: !!command,
      });
      return res.status(400).json({ error: "Missing required parameters" });
    }

    try {
      const hostIdNum = parseInt(hostId, 10);

      await createCurrentCommandHistoryRepository().deleteCommandForHost(
        userId,
        hostIdNum,
        command.trim(),
      );

      res.json({ success: true });
    } catch (err) {
      authLogger.error("Failed to delete command from history", err);
      res.status(500).json({
        error: err instanceof Error ? err.message : "Failed to delete command",
      });
    }
  },
);

/**
 * @openapi
 * /terminal/command_history/{hostId}:
 *   delete:
 *     summary: Clear command history
 *     description: Clears the entire command history for a specific host.
 *     tags:
 *       - Terminal
 *     parameters:
 *       - in: path
 *         name: hostId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Command history cleared successfully.
 *       400:
 *         description: Invalid request.
 *       500:
 *         description: Failed to clear history.
 */
router.delete(
  "/command_history/:hostId",
  authenticateJWT,
  requireDataAccess,
  async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const hostId = Array.isArray(req.params.hostId)
      ? req.params.hostId[0]
      : req.params.hostId;
    const hostIdNum = parseInt(hostId, 10);

    if (!isNonEmptyString(userId) || isNaN(hostIdNum)) {
      authLogger.warn("Invalid command history clear request");
      return res.status(400).json({ error: "Invalid request" });
    }

    try {
      await createCurrentCommandHistoryRepository().deleteByUserAndHost(
        userId,
        hostIdNum,
      );
      databaseLogger.info("Terminal history cleared", {
        operation: "terminal_history_clear",
        userId,
        hostId: hostIdNum,
      });

      res.json({ success: true });
    } catch (err) {
      authLogger.error("Failed to clear command history", err);
      res.status(500).json({
        error: err instanceof Error ? err.message : "Failed to clear history",
      });
    }
  },
);

/**
 * @openapi
 * /terminal/session_settings:
 *   get:
 *     summary: Get SSH disconnect retention settings
 *     description: Returns how long a detached regular SSH session remains recoverable.
 *     tags:
 *       - Terminal
 *     responses:
 *       200:
 *         description: Session settings.
 *       500:
 *         description: Failed to fetch settings.
 */
router.get(
  "/session_settings",
  authenticateJWT,
  async (_req: Request, res: Response) => {
    try {
      const settings = createCurrentSettingsRepository();
      const timeoutValue = await settings.get(
        "ssh_disconnect_retention_minutes",
      );
      const parsed = timeoutValue ? Number.parseInt(timeoutValue, 10) : 1440;

      res.json({
        timeoutMinutes:
          Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 10080
            ? parsed
            : 1440,
      });
    } catch (err) {
      authLogger.error("Failed to fetch session settings", err);
      res.status(500).json({
        error: err instanceof Error ? err.message : "Failed to fetch settings",
      });
    }
  },
);

/**
 * @openapi
 * /terminal/session_settings:
 *   post:
 *     summary: Update session persistence settings
 *     description: Saves the SSH disconnect retention timeout.
 *     tags:
 *       - Terminal
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               timeoutMinutes:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Settings saved successfully.
 *       400:
 *         description: Invalid parameters.
 *       500:
 *         description: Failed to save settings.
 */
router.post(
  "/session_settings",
  requireAdmin,
  async (req: Request, res: Response) => {
    const authenticatedRequest = req as AuthenticatedRequest;
    const { timeoutMinutes } = req.body;

    if (!isValidTerminalSessionTimeoutMinutes(timeoutMinutes)) {
      return res.status(400).json({
        error: "timeoutMinutes must be an integer between 1 and 10080",
      });
    }

    try {
      const settings = createCurrentSettingsRepository();
      await settings.set(
        "ssh_disconnect_retention_minutes",
        String(timeoutMinutes),
      );
      const refreshedSessions =
        sessionManager.refreshDetachedSessionRetention();
      const { ipAddress, userAgent } = getRequestMeta(req);
      await logAudit({
        userId: authenticatedRequest.userId,
        username:
          authenticatedRequest.user?.username ?? authenticatedRequest.userId,
        action: "update_ssh_disconnect_retention",
        resourceType: "setting",
        resourceId: "ssh_disconnect_retention_minutes",
        details: JSON.stringify({ timeoutMinutes }),
        ipAddress,
        userAgent,
        success: true,
      });

      res.json({ success: true, timeoutMinutes, refreshedSessions });
    } catch (err) {
      authLogger.error("Failed to save session settings", err);
      res.status(500).json({
        error: err instanceof Error ? err.message : "Failed to save settings",
      });
    }
  },
);

export default router;
