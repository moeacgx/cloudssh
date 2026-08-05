import { beforeEach, describe, expect, it, vi } from "vitest";

const repository = vi.hoisted(() => ({
  createFiring: vi.fn(async () => undefined),
  findRuleById: vi.fn(async () => null),
  getHostDisplayName: vi.fn(async () => "测试主机"),
  listEnabledChannelsForRule: vi.fn(async () => []),
  listEnabledRulesForHost: vi.fn(async () => []),
  listEnabledRulesForHostUser: vi.fn(async () => []),
  pruneFiringsOlderThan: vi.fn(),
}));

vi.mock("../../database/repositories/factory.js", () => ({
  createCurrentAlertRepository: () => repository,
}));

vi.mock("../../utils/notification-sender.js", () => ({
  sendNotification: vi.fn(async () => undefined),
}));

vi.mock("../../utils/logger.js", () => ({
  statsLogger: { warn: vi.fn() },
}));

import { AlertEngine } from "./alert-engine.js";

function rule(input: {
  id: number;
  userId: string;
  triggerType: "host_offline" | "cpu_threshold";
}) {
  return {
    ...input,
    hostId: 101,
    name: `rule-${input.id}`,
    enabled: true,
    thresholdValue: input.triggerType === "cpu_threshold" ? 80 : null,
    thresholdDurationSeconds: 0,
    cooldownMinutes: 0,
  };
}

describe("主机监控告警用户隔离", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repository.getHostDisplayName.mockResolvedValue("测试主机");
    repository.listEnabledChannelsForRule.mockResolvedValue([]);
    repository.findRuleById.mockResolvedValue(null);
  });

  it("只评估当前轮询用户自己的指标告警", async () => {
    repository.listEnabledRulesForHostUser.mockImplementation(
      async (_hostId: number, userId: string) =>
        userId === "user-a"
          ? [rule({ id: 1, userId, triggerType: "cpu_threshold" })]
          : [],
    );
    const metrics = {
      cpu: { percent: 90 },
      memory: { percent: 30 },
      disk: { percent: 20 },
    };

    await AlertEngine.getInstance().evaluateMetrics(901, "user-a", metrics);
    await AlertEngine.getInstance().evaluateMetrics(902, "user-b", metrics);

    expect(repository.createFiring).toHaveBeenCalledTimes(1);
    expect(repository.createFiring).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-a", hostId: 901 }),
    );
    expect(repository.listEnabledRulesForHost).not.toHaveBeenCalled();
  });

  it("不同用户首次状态采样不会互相制造离线事件", async () => {
    repository.listEnabledRulesForHostUser.mockImplementation(
      async (_hostId: number, userId: string) => [
        rule({ id: 2, userId, triggerType: "host_offline" }),
      ],
    );
    const engine = AlertEngine.getInstance();

    await engine.evaluateStatus(903, "user-a", true);
    await engine.evaluateStatus(903, "user-b", false);
    expect(repository.createFiring).not.toHaveBeenCalled();

    await engine.evaluateStatus(903, "user-b", true);
    await engine.evaluateStatus(903, "user-b", false);
    expect(repository.createFiring).toHaveBeenCalledTimes(1);
    expect(repository.createFiring).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-b", hostId: 903 }),
    );
  });
});
