import express from "express";
import cookieParser from "cookie-parser";
import { createCorsMiddleware } from "../../utils/cors-config.js";
import { logger } from "../../utils/logger.js";
import { AuthManager } from "../../utils/auth-manager.js";
import {
  closeHttpServer,
  shutdownCleanupRegistry,
} from "../../utils/shutdown-coordinator.js";
import { registerDockerContainerRoutes } from "./container-routes.js";
import {
  sshSessions,
  pendingTOTPSessions,
  executeDockerCommand,
} from "./session-manager.js";
import {
  DOCKER_TIMESTAMP_RE,
  getRequestUserId,
  registerDockerSshRoutes,
} from "./routes.js";

const sshLogger = logger;

const app = express();

app.use(createCorsMiddleware(["GET", "POST", "PUT", "DELETE", "OPTIONS"]));

app.use(cookieParser());
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ limit: "100mb", extended: true }));
app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

const authManager = AuthManager.getInstance();
app.use(authManager.createAuthMiddleware());

registerDockerSshRoutes(app);

registerDockerContainerRoutes(app, {
  sshSessions,
  pendingTOTPSessions,
  getRequestUserId,
  executeDockerCommand,
  dockerTimestampPattern: DOCKER_TIMESTAMP_RE,
});

const PORT = 30007;

const server = app.listen(PORT, async () => {
  try {
    await authManager.initialize();
  } catch (err) {
    sshLogger.error("Failed to initialize Docker backend", err, {
      operation: "startup",
    });
  }
});

shutdownCleanupRegistry.register("docker-api", async () => {
  await closeHttpServer(server);

  for (const [sessionId, session] of Object.entries(sshSessions)) {
    clearTimeout(session.timeout);
    try {
      session.client.end();
    } catch {
      // 资源可能已经关闭
    }
    delete sshSessions[sessionId];
  }

  for (const [sessionId, session] of Object.entries(pendingTOTPSessions)) {
    try {
      session.client.end();
    } catch {
      // 资源可能已经关闭
    }
    delete pendingTOTPSessions[sessionId];
  }
});
