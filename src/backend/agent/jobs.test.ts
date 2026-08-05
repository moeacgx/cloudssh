import crypto from "crypto";
import { describe, expect, it, vi } from "vitest";
import { AgentJobManager } from "./jobs.js";
import { MemoryAgentStateStore, type AgentStateStore } from "./store.js";
import type {
  AgentJobRecord,
  AgentJobDriver,
  AgentPersistentState,
  AgentPrincipal,
  RunJobInput,
  RunJobResult,
} from "./types.js";
import { apiLogger } from "../utils/logger.js";

const principal: AgentPrincipal = {
  principalId: "device:device-1",
  serviceAccountId: "device-1:project-1",
  projectId: "project-1",
  projectIds: ["project-1"],
  name: "测试设备",
  scopes: ["jobs:execute"],
  serverIds: ["server-1"],
  maxConcurrentSessions: 1,
};

class BlockingJobDriver implements AgentJobDriver {
  private markStarted!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });

  async run(_input: RunJobInput, signal: AbortSignal): Promise<RunJobResult> {
    this.markStarted();
    return new Promise((_, reject) => {
      const cancel = () => reject(new Error("Job canceled"));
      if (signal.aborted) cancel();
      else signal.addEventListener("abort", cancel, { once: true });
    });
  }
}

class FailingBackgroundStore implements AgentStateStore {
  private readonly memory = new MemoryAgentStateStore();
  private updates = 0;

  read(): Promise<AgentPersistentState> {
    return this.memory.read();
  }

  update<T>(
    mutator: (state: AgentPersistentState) => T | Promise<T>,
  ): Promise<T> {
    this.updates += 1;
    if (this.updates > 1) {
      return Promise.reject(new Error("sidecar write failed"));
    }
    return this.memory.update(mutator);
  }
}

class FailingOnceStore implements AgentStateStore {
  private readonly memory = new MemoryAgentStateStore();
  private updates = 0;

  read(): Promise<AgentPersistentState> {
    return this.memory.read();
  }

  update<T>(
    mutator: (state: AgentPersistentState) => T | Promise<T>,
  ): Promise<T> {
    this.updates += 1;
    if (this.updates === 2) {
      return Promise.reject(new Error("transient sidecar failure"));
    }
    return this.memory.update(mutator);
  }
}

class CommitThenFailOnceStore implements AgentStateStore {
  private readonly memory = new MemoryAgentStateStore();
  private failAfterCommit = true;

  read(): Promise<AgentPersistentState> {
    return this.memory.read();
  }

  async update<T>(
    mutator: (state: AgentPersistentState) => T | Promise<T>,
  ): Promise<T> {
    const result = await this.memory.update(mutator);
    if (this.failAfterCommit) {
      this.failAfterCommit = false;
      throw new Error("main database save failed after sidecar commit");
    }
    return result;
  }
}

class ImmediateJobDriver implements AgentJobDriver {
  async run(): Promise<RunJobResult> {
    return { stdout: "ok\n", stderr: "", exitCode: 0 };
  }
}

class IgnoringAbortJobDriver implements AgentJobDriver {
  async run(): Promise<RunJobResult> {
    return new Promise(() => undefined);
  }
}

describe("Agent Job 关闭排空", () => {
  it("取消并等待后台 Job，且关闭后拒绝新任务", async () => {
    const state = new MemoryAgentStateStore();
    const driver = new BlockingJobDriver();
    const jobs = new AgentJobManager(state, driver);
    const job = await jobs.create(
      principal,
      { serverId: "server-1", command: "sleep 60", timeoutMs: 60_000 },
      "shutdown-job",
    );
    await driver.started;

    await jobs.shutdown();

    await expect(jobs.status(principal, job.id)).resolves.toMatchObject({
      state: "CANCELED",
      failureReason: "Agent stopped",
    });
    await expect(
      jobs.create(
        principal,
        { serverId: "server-1", command: "hostname", timeoutMs: 5_000 },
        "after-shutdown",
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: "AGENT_SHUTTING_DOWN",
    });
  });

  it.each(["QUEUED", "RUNNING"] as const)(
    "重启后将 %s Job 标记为结果未知的失败状态",
    async (jobState) => {
      const state = new MemoryAgentStateStore();
      const now = new Date().toISOString();
      const interrupted: AgentJobRecord = {
        id: `job-${jobState.toLowerCase()}`,
        projectId: "project-1",
        serverId: "server-1",
        serviceAccountId: "device-1:project-1",
        command: "deploy.sh",
        state: jobState,
        stdout: "",
        stderr: "",
        exitCode: null,
        timeoutMs: 60_000,
        createdAt: now,
        startedAt: jobState === "RUNNING" ? now : null,
        finishedAt: null,
        failureReason: null,
      };
      await state.update((current) => {
        current.jobs.push(interrupted);
      });
      const jobs = new AgentJobManager(state, new BlockingJobDriver());

      await expect(jobs.recoverInterrupted()).resolves.toBe(1);
      await expect(
        jobs.status(principal, interrupted.id),
      ).resolves.toMatchObject({
        state: "FAILED",
        exitCode: null,
        failureReason: "Agent restarted; previous execution outcome is unknown",
      });
      await expect(jobs.recoverInterrupted()).resolves.toBe(0);
    },
  );

  it("消费后台持久化异常并完成受控关闭", async () => {
    const error = vi.spyOn(apiLogger, "error").mockImplementation(() => {});
    const jobs = new AgentJobManager(
      new FailingBackgroundStore(),
      new BlockingJobDriver(),
    );

    try {
      await jobs.create(
        principal,
        { serverId: "server-1", command: "hostname", timeoutMs: 5_000 },
        "failing-sidecar",
      );
      await vi.waitFor(() => {
        expect(error).toHaveBeenCalledWith(
          "CloudSSH Agent background job failed",
          expect.objectContaining({ message: "sidecar write failed" }),
          expect.objectContaining({
            operation: "agent_job_background_failure",
          }),
        );
      });
      await expect(
        jobs.create(
          principal,
          { serverId: "server-1", command: "date", timeoutMs: 5_000 },
          "after-store-failure",
        ),
      ).rejects.toMatchObject({
        status: 503,
        code: "AGENT_JOB_STORE_UNHEALTHY",
      });
      await expect(jobs.shutdown()).resolves.toBeUndefined();
    } finally {
      error.mockRestore();
    }
  });

  it("瞬时持久化失败重试后仍保存最终 Job 结果", async () => {
    const jobs = new AgentJobManager(
      new FailingOnceStore(),
      new ImmediateJobDriver(),
    );
    const job = await jobs.create(
      principal,
      { serverId: "server-1", command: "printf ok", timeoutMs: 5_000 },
      "transient-store",
    );

    await vi.waitFor(async () => {
      await expect(jobs.status(principal, job.id)).resolves.toMatchObject({
        state: "SUCCEEDED",
        stdout: "ok\n",
        exitCode: 0,
      });
    });
    await jobs.shutdown();
  });

  it("预留已提交但主库保存失败时由相同幂等请求接续 Job", async () => {
    const driver = new ImmediateJobDriver();
    const jobs = new AgentJobManager(new CommitThenFailOnceStore(), driver);
    const input = {
      serverId: "server-1",
      command: "printf recovered",
      timeoutMs: 5_000,
    };

    await expect(
      jobs.create(principal, input, "resume-queued-job"),
    ).rejects.toThrow("main database save failed after sidecar commit");
    const recovered = await jobs.create(principal, input, "resume-queued-job");

    await vi.waitFor(async () => {
      await expect(jobs.status(principal, recovered.id)).resolves.toMatchObject(
        {
          state: "SUCCEEDED",
          stdout: "ok\n",
        },
      );
    });
    await jobs.shutdown();
  });

  it("同一设备达到活动 Job 上限时返回 429", async () => {
    const driver = new BlockingJobDriver();
    const jobs = new AgentJobManager(new MemoryAgentStateStore(), driver);
    await jobs.create(
      principal,
      { serverId: "server-1", command: "sleep 60", timeoutMs: 60_000 },
      "first-active-job",
    );
    await driver.started;

    await expect(
      jobs.create(
        principal,
        { serverId: "server-1", command: "hostname", timeoutMs: 5_000 },
        "second-active-job",
      ),
    ).rejects.toMatchObject({
      status: 429,
      code: "JOB_DEVICE_LIMIT_REACHED",
    });
    await jobs.shutdown();
  });

  it("驱动忽略 AbortSignal 时管理器仍按超时释放 Job", async () => {
    const jobs = new AgentJobManager(
      new MemoryAgentStateStore(),
      new IgnoringAbortJobDriver(),
    );
    const job = await jobs.create(
      principal,
      { serverId: "server-1", command: "hang", timeoutMs: 1_000 },
      "hard-timeout",
    );

    await vi.waitFor(
      async () => {
        await expect(jobs.status(principal, job.id)).resolves.toMatchObject({
          state: "TIMED_OUT",
        });
      },
      { timeout: 2_000 },
    );
    await expect(jobs.shutdown()).resolves.toBeUndefined();
  });

  it("Job 实体淘汰后相同幂等键返回 410 而不重新执行", async () => {
    const store = new MemoryAgentStateStore();
    const input = {
      serverId: "server-1",
      command: "deploy.sh",
      timeoutMs: 5_000,
    };
    const createdAt = new Date().toISOString();
    await store.update((state) => {
      for (let index = 0; index < 1_001; index += 1) {
        state.jobs.push({
          id: `job-${index}`,
          projectId: "project-1",
          serverId: "server-1",
          serviceAccountId: "device-1:project-1",
          command: "deploy.sh",
          state: "SUCCEEDED",
          stdout: "",
          stderr: "",
          exitCode: 0,
          timeoutMs: 5_000,
          createdAt,
          startedAt: createdAt,
          finishedAt: new Date(Date.now() + index).toISOString(),
          failureReason: null,
        });
      }
      state.idempotency.push({
        key: "device:device-1:project:project-1:job:create:expired-job",
        requestHash: crypto
          .createHash("sha256")
          .update(JSON.stringify(input))
          .digest("hex"),
        response: { jobId: "job-0" },
        createdAt,
      });
    });
    const driver = new ImmediateJobDriver();
    const jobs = new AgentJobManager(store, driver);

    await expect(
      jobs.create(principal, input, "expired-job"),
    ).rejects.toMatchObject({
      status: 410,
      code: "IDEMPOTENCY_OUTCOME_EXPIRED",
    });
  });
});
