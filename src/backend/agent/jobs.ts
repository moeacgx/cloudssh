import crypto from "crypto";
import { AgentApiError } from "./errors.js";
import {
  findIdempotency,
  findJob,
  hasIdempotencyCapacity,
  type AgentStateStore,
} from "./store.js";
import type {
  AgentJobDriver,
  AgentPersistentState,
  AgentPrincipal,
  AgentScope,
  RunJobResult,
} from "./types.js";
import { apiLogger } from "../utils/logger.js";

const MAX_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_GLOBAL_ACTIVE_JOBS = 32;
const PERSISTENCE_RETRY_DELAYS_MS = [25, 100];
const TERMINAL_JOB_STATES = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELED",
  "TIMED_OUT",
]);

function hash(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function requireScope(principal: AgentPrincipal, scope: AgentScope): void {
  if (!principal.scopes.includes(scope)) {
    throw new AgentApiError(403, "SCOPE_DENIED", `缺少权限：${scope}`);
  }
}

function requireServer(
  principal: AgentPrincipal,
  serverId: string,
): { projectId: string; serviceAccountId: string } {
  if (
    !principal.serverIds.includes("*") &&
    !principal.serverIds.includes(serverId)
  ) {
    throw new AgentApiError(403, "SERVER_DENIED", "当前设备无权访问该服务器");
  }
  return {
    projectId: principal.serverProjectIds?.[serverId] ?? principal.projectId,
    serviceAccountId:
      principal.serverServiceAccountIds?.[serverId] ??
      principal.serviceAccountId,
  };
}

function canAccessProject(
  principal: AgentPrincipal,
  projectId: string,
): boolean {
  return (principal.projectIds ?? [principal.projectId]).includes(projectId);
}

export class AgentJobManager {
  private readonly controllers = new Map<string, AbortController>();
  private readonly executions = new Map<string, Promise<void>>();
  private shuttingDown = false;
  private backgroundFailure: Error | null = null;

  constructor(
    private readonly store: AgentStateStore,
    private readonly driver: AgentJobDriver,
  ) {}

  async recoverInterrupted(): Promise<number> {
    return this.store.update((state) => {
      const finishedAt = new Date().toISOString();
      let recovered = 0;
      for (const job of state.jobs) {
        if (job.state !== "QUEUED" && job.state !== "RUNNING") continue;
        job.state = "FAILED";
        job.finishedAt = finishedAt;
        job.failureReason =
          "Agent restarted; previous execution outcome is unknown";
        recovered += 1;
      }
      return recovered;
    });
  }

  async create(
    principal: AgentPrincipal,
    input: { serverId: string; command: string; timeoutMs: number },
    idempotencyKey: string,
  ) {
    if (this.backgroundFailure) {
      throw new AgentApiError(
        503,
        "AGENT_JOB_STORE_UNHEALTHY",
        "Job 状态存储异常，已暂停新任务，请检查服务日志并重启 Agent",
      );
    }
    if (this.shuttingDown) {
      throw new AgentApiError(
        503,
        "AGENT_SHUTTING_DOWN",
        "Agent 正在关闭，暂不接受新 Job",
      );
    }
    requireScope(principal, "jobs:execute");
    const access = requireServer(principal, input.serverId);
    if (!idempotencyKey) {
      throw new AgentApiError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "必须提供 Idempotency-Key",
      );
    }
    const scopedKey = `${principal.principalId}:project:${access.projectId}:job:create:${idempotencyKey}`;
    const requestHash = hash(input);
    const reservation = await this.store.update((state) => {
      const existing = findIdempotency(state, scopedKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new AgentApiError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "同一个幂等键不能用于不同请求",
          );
        }
        const existingJob = findJob(
          state,
          (existing.response as { jobId: string }).jobId,
        );
        if (!existingJob) {
          throw new AgentApiError(
            410,
            "IDEMPOTENCY_OUTCOME_EXPIRED",
            "原 Job 已从运行历史中淘汰，不能使用相同幂等键重新执行",
          );
        }
        return { job: structuredClone(existingJob), created: false };
      }
      if (!hasIdempotencyCapacity(state)) {
        throw new AgentApiError(
          429,
          "IDEMPOTENCY_CAPACITY_EXCEEDED",
          "防重记录已达到容量上限，请等待历史记录过期后重试",
        );
      }
      const activeJobs = state.jobs.filter(
        (job) => !TERMINAL_JOB_STATES.has(job.state),
      );
      if (activeJobs.length >= MAX_GLOBAL_ACTIVE_JOBS) {
        throw new AgentApiError(
          429,
          "JOB_GLOBAL_LIMIT_REACHED",
          "平台并发 Job 已达到上限",
        );
      }
      const serviceAccountIds = new Set(
        principal.serviceAccountIds ?? [principal.serviceAccountId],
      );
      const deviceActiveJobs = activeJobs.filter((job) =>
        serviceAccountIds.has(job.serviceAccountId),
      ).length;
      if (deviceActiveJobs >= Math.max(1, principal.maxConcurrentSessions)) {
        throw new AgentApiError(
          429,
          "JOB_DEVICE_LIMIT_REACHED",
          "当前设备的并发 Job 已达到上限",
        );
      }
      const now = new Date().toISOString();
      const job = {
        id: crypto.randomUUID(),
        projectId: access.projectId,
        serverId: input.serverId,
        serviceAccountId: access.serviceAccountId,
        command: input.command,
        state: "QUEUED" as const,
        stdout: "",
        stderr: "",
        exitCode: null,
        timeoutMs: Math.min(Math.max(input.timeoutMs, 1_000), MAX_TIMEOUT_MS),
        createdAt: now,
        startedAt: null,
        finishedAt: null,
        failureReason: null,
      };
      state.jobs.push(job);
      state.idempotency.push({
        key: scopedKey,
        requestHash,
        response: { jobId: job.id },
        createdAt: now,
      });
      return { job: structuredClone(job), created: true };
    });
    if (reservation.created || reservation.job.state === "QUEUED") {
      this.startExecution(reservation.job.id);
    }
    return reservation.job;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const activeJobIds = [...this.controllers.keys()];
    if (activeJobIds.length > 0) {
      const active = new Set(activeJobIds);
      await this.store.update((state) => {
        const finishedAt = new Date().toISOString();
        for (const job of state.jobs) {
          if (!active.has(job.id)) continue;
          if (
            ["SUCCEEDED", "FAILED", "CANCELED", "TIMED_OUT"].includes(job.state)
          ) {
            continue;
          }
          job.state = "CANCELED";
          job.finishedAt = finishedAt;
          job.failureReason = "Agent stopped";
        }
      });
    }
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
    await Promise.allSettled([...this.executions.values()]);
  }

  async list(principal: AgentPrincipal) {
    requireScope(principal, "jobs:execute");
    const state = await this.store.read();
    return state.jobs.filter(
      (job) =>
        canAccessProject(principal, job.projectId) &&
        (principal.serverIds.includes("*") ||
          principal.serverIds.includes(job.serverId)),
    );
  }

  async status(principal: AgentPrincipal, jobId: string) {
    requireScope(principal, "jobs:execute");
    const job = findJob(await this.store.read(), jobId);
    if (!job || !canAccessProject(principal, job.projectId)) {
      throw new AgentApiError(404, "JOB_NOT_FOUND", "Job 不存在");
    }
    requireServer(principal, job.serverId);
    return job;
  }

  async resolveAuditContext(jobId: string) {
    const job = findJob(await this.store.read(), jobId);
    if (!job) return null;
    return {
      id: job.id,
      projectId: job.projectId,
      serverId: job.serverId,
    };
  }

  async cancel(principal: AgentPrincipal, jobId: string) {
    const job = await this.status(principal, jobId);
    if (["SUCCEEDED", "FAILED", "CANCELED", "TIMED_OUT"].includes(job.state)) {
      return job;
    }
    this.controllers.get(jobId)?.abort();
    return this.store.update((state) => {
      const current = findJob(state, jobId)!;
      current.state = "CANCELED";
      current.finishedAt = new Date().toISOString();
      return structuredClone(current);
    });
  }

  private async execute(jobId: string): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    let timeout: NodeJS.Timeout | null = null;
    let timedOut = false;
    let removeAbortListener = () => undefined;
    try {
      const job = await this.updateWithRetry((state) => {
        const current = findJob(state, jobId)!;
        current.state = "RUNNING";
        current.startedAt = new Date().toISOString();
        return structuredClone(current);
      });
      const aborted = new Promise<never>((_, reject) => {
        const onAbort = () => reject(new Error("Job canceled"));
        removeAbortListener = () =>
          controller.signal.removeEventListener("abort", onAbort);
        if (controller.signal.aborted) onAbort();
        else
          controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, job.timeoutMs);
      let result: RunJobResult;
      try {
        result = await Promise.race([
          this.driver.run(
            {
              jobId,
              projectId: job.projectId,
              serverId: job.serverId,
              command: job.command,
              timeoutMs: job.timeoutMs,
            },
            controller.signal,
          ),
          aborted,
        ]);
      } catch (error) {
        await this.updateWithRetry((state) => {
          const current = findJob(state, jobId)!;
          if (current.state === "CANCELED") return;
          current.state = timedOut ? "TIMED_OUT" : "FAILED";
          current.failureReason =
            error instanceof Error ? error.message : "未知错误";
          current.finishedAt = new Date().toISOString();
        });
        return;
      }
      await this.updateWithRetry((state) => {
        const current = findJob(state, jobId)!;
        if (current.state === "CANCELED") return;
        current.stdout = result.stdout;
        current.stderr = result.stderr;
        current.exitCode = result.exitCode;
        current.state = result.exitCode === 0 ? "SUCCEEDED" : "FAILED";
        current.finishedAt = new Date().toISOString();
      });
    } finally {
      if (timeout) clearTimeout(timeout);
      removeAbortListener();
      this.controllers.delete(jobId);
    }
  }

  private startExecution(jobId: string): void {
    if (this.executions.has(jobId)) return;
    const execution = this.execute(jobId)
      .catch(async (error) => {
        const failure =
          error instanceof Error ? error : new Error("Unknown Job failure");
        this.backgroundFailure = failure;
        try {
          await this.updateWithRetry((state) => {
            const job = findJob(state, jobId);
            if (!job || TERMINAL_JOB_STATES.has(job.state)) return;
            job.state = "FAILED";
            job.finishedAt = new Date().toISOString();
            job.failureReason =
              "Job outcome is unknown because durable state persistence failed";
          });
        } catch (recoveryError) {
          apiLogger.error(
            "CloudSSH Agent could not persist unknown Job outcome",
            recoveryError,
            { operation: "agent_job_recovery_persist_failed", jobId },
          );
        }
        apiLogger.error("CloudSSH Agent background job failed", error, {
          operation: "agent_job_background_failure",
          jobId,
        });
      })
      .finally(() => {
        if (this.executions.get(jobId) === execution) {
          this.executions.delete(jobId);
        }
      });
    this.executions.set(jobId, execution);
  }

  private async updateWithRetry<T>(
    mutator: (state: AgentPersistentState) => T | Promise<T>,
  ): Promise<T> {
    let lastError: unknown;
    const attempts = PERSISTENCE_RETRY_DELAYS_MS.length + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.store.update(mutator);
      } catch (error) {
        lastError = error;
        if (attempt < PERSISTENCE_RETRY_DELAYS_MS.length) {
          await new Promise((resolve) =>
            setTimeout(resolve, PERSISTENCE_RETRY_DELAYS_MS[attempt]),
          );
        }
      }
    }
    throw lastError;
  }
}
