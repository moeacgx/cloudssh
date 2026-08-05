import http from "http";
import path from "path";
import { AgentSessionBroker } from "./broker.js";
import { UnavailableJobDriver, UnavailableSessionDriver } from "./drivers.js";
import { createPlatformSshDriver } from "./ssh-driver.js";
import { AgentJobManager } from "./jobs.js";
import { createAgentApp } from "./routes.js";
import { SqliteBackedAgentStateStore } from "./store.js";
import { apiLogger } from "../utils/logger.js";
import { getSqlite } from "../database/db/index.js";
import { DatabaseSaveTrigger } from "../utils/database-save-trigger.js";
import { SqliteAgentAuditSink } from "./audit.js";
import type { AgentJobDriver, AgentSessionDriver } from "./types.js";
import { SqliteAgentServerDirectory } from "./servers.js";
import cookieParser from "cookie-parser";
import {
  createAgentDeviceAdminRouter,
  defaultAgentDeviceAdminDependencies,
} from "./device-admin.js";
import {
  AgentDeviceRegistrationRepository,
  createAgentDeviceRegistrationRouter,
} from "./device-registration.js";
import {
  createAgentDeviceAuthMiddleware,
  createAgentDevicePreAuthMiddleware,
  SqliteAgentDeviceStore,
} from "./device-auth.js";
import { AgentSecurityStore } from "./security-store.js";
import { SqliteAgentSessionRecorder } from "./recording.js";
import {
  closeHttpServer,
  shutdownCleanupRegistry,
} from "../utils/shutdown-coordinator.js";
import { registerAgentSessionBroker } from "./runtime-registry.js";
import { SqliteAgentProvisioningService } from "./provisioning.js";
import { createCurrentHostRepository } from "../database/repositories/factory.js";
import { queueHostNetworkInfoRefresh } from "../hosts/network-info.js";
import { PlatformAgentFileService, type AgentFileService } from "./files.js";
import {
  createAgentSessionAdminRouter,
  defaultAgentSessionAdminDependencies,
} from "./session-admin.js";

const dataDir = process.env.DATA_DIR || "./db/data";
const agentDir = path.join(dataDir, "agent");
const sqlite = getSqlite();
const triggerSave = () => DatabaseSaveTrigger.triggerSave("agent_api_write");
const forceDeviceSecuritySave = () =>
  DatabaseSaveTrigger.forceSave("agent_device_security_write");
const security = new AgentSecurityStore(
  path.join(agentDir, "agent-security.sqlite"),
);
security.importLegacyNonces(
  sqlite
    .prepare(
      `SELECT device_id AS deviceId, nonce, expires_at AS expiresAt
         FROM agent_request_nonces`,
    )
    .all() as Array<{ deviceId: string; nonce: string; expiresAt: string }>,
);
const recoveredAuditEvents = security.syncAuditEvents(sqlite);
if (recoveredAuditEvents > 0) {
  await forceDeviceSecuritySave();
}
const devices = new SqliteAgentDeviceStore(
  sqlite,
  triggerSave,
  undefined,
  forceDeviceSecuritySave,
  security,
);
const registration = new AgentDeviceRegistrationRepository(sqlite, triggerSave);
const servers = new SqliteAgentServerDirectory(sqlite);
const provisioning = new SqliteAgentProvisioningService(
  sqlite,
  createCurrentHostRepository(),
  triggerSave,
  (hostId, address) => queueHostNetworkInfoRefresh(hostId, address),
);
const state = new SqliteBackedAgentStateStore(
  path.join(agentDir, "runtime-state.json"),
  sqlite,
  triggerSave,
);
let sessionDriver: AgentSessionDriver = new UnavailableSessionDriver();
let jobDriver: AgentJobDriver = new UnavailableJobDriver();
let fileService: AgentFileService | undefined;
try {
  const sshDriver = await createPlatformSshDriver();
  sessionDriver = sshDriver;
  jobDriver = sshDriver;
  fileService = new PlatformAgentFileService(sshDriver, state);
} catch (error) {
  apiLogger.warn(
    "CloudSSH credential vault is locked; Agent writes are disabled",
    {
      operation: "agent_driver_unavailable",
      error: error instanceof Error ? error.message : "Unknown error",
    },
  );
}
const recordings = new SqliteAgentSessionRecorder(sqlite, dataDir, triggerSave);
const sessions = new AgentSessionBroker(
  state,
  sessionDriver,
  undefined,
  recordings,
);
registerAgentSessionBroker(sessions);
const jobs = new AgentJobManager(state, jobDriver);
const interruptedJobs = await jobs.recoverInterrupted();
if (interruptedJobs > 0) {
  apiLogger.warn("CloudSSH Agent marked interrupted jobs as failed", {
    operation: "agent_jobs_recovered",
    count: interruptedJobs,
  });
}
const audit = new SqliteAgentAuditSink(
  sqlite,
  triggerSave,
  (jobId) => jobs.resolveAuditContext(jobId),
  security,
);
const app = createAgentApp({
  authenticate: createAgentDeviceAuthMiddleware(devices, security),
  preAuthenticateUpload: createAgentDevicePreAuthMiddleware(devices, security),
  registration: createAgentDeviceRegistrationRouter(
    registration,
    undefined,
    undefined,
    security,
  ),
  servers,
  sessions,
  jobs,
  provisioning,
  files: fileService,
  audit,
});
app.use(cookieParser());
app.use(
  "/agent/admin/v1",
  createAgentSessionAdminRouter(defaultAgentSessionAdminDependencies(sqlite)),
);
app.use(
  "/agent/admin/v1",
  createAgentDeviceAdminRouter(
    defaultAgentDeviceAdminDependencies(sqlite, forceDeviceSecuritySave),
  ),
);
const server = http.createServer(app);
// 30012 已由首页服务使用，Agent API 使用独立端口并仅经 Nginx 暴露。
const port = Number(process.env.AGENT_API_PORT || 30013);

async function maintainAgentState(): Promise<void> {
  security.cleanup();
  if (security.syncAuditEvents(sqlite) > 0) {
    await triggerSave();
  }
  await registration.cleanupExpired();
  await sessions.recoverActiveSessions();
  await sessions.cleanupExpiredSessions();
  await recordings.reconcileDangling();
  await recordings.cleanupExpired();
  await state.cleanupPersistentHistory();
  await provisioning.cleanupExpiredQuickConnections();
}

await maintainAgentState();
let maintenancePromise: Promise<void> | null = null;
const maintenanceTimer = setInterval(() => {
  if (maintenancePromise) return;
  maintenancePromise = maintainAgentState()
    .catch((error) => {
      apiLogger.warn("CloudSSH Agent maintenance failed", {
        operation: "agent_maintenance_failed",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    })
    .finally(() => {
      maintenancePromise = null;
    });
}, 60_000);
maintenanceTimer.unref();

shutdownCleanupRegistry.register("agent-api", async () => {
  clearInterval(maintenanceTimer);
  const activeMaintenance = maintenancePromise;
  await closeHttpServer(server);
  await activeMaintenance;
  await jobs.shutdown();
  await sessionDriver.shutdown?.();
  await recordings.checkpointActive();
  try {
    security.syncAuditEvents(sqlite);
  } finally {
    security.close();
  }
});

export const agentServerReady = new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, process.env.AGENT_API_HOST || "127.0.0.1", () => {
    server.off("error", reject);
    apiLogger.info("CloudSSH Agent API started", {
      operation: "agent_api_started",
      port,
    });
    resolve();
  });
});
