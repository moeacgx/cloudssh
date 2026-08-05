import { describe, expect, it } from "vitest";
import {
  TerminalLifecycleUnavailableError,
  TerminalSessionLifecycleCoordinator,
} from "../../../hosts/terminal/session-lifecycle-coordinator.js";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("TerminalSessionLifecycleCoordinator", () => {
  it("破坏性操作一排队便阻止同一主机创建或固定会话", async () => {
    const coordinator = new TerminalSessionLifecycleCoordinator();
    const release = deferred();
    const deletion = coordinator.runDestructiveOperation(
      { hostIds: [17] },
      () => release.promise,
    );

    expect(() =>
      coordinator.assertSessionCreationAllowed({ hostIds: [17] }),
    ).toThrow(TerminalLifecycleUnavailableError);
    await expect(
      coordinator.runSessionMutation({ hostIds: [17] }, () => undefined),
    ).rejects.toBeInstanceOf(TerminalLifecycleUnavailableError);

    release.resolve();
    await deletion;
  });

  it("等待已经开始的固定写入完成后才执行删除检查", async () => {
    const coordinator = new TerminalSessionLifecycleCoordinator();
    const releaseMutation = deferred();
    const mutationStarted = deferred();
    const events: string[] = [];
    const mutation = coordinator.runSessionMutation(
      { projectHostIds: [23] },
      async () => {
        events.push("mutation-start");
        mutationStarted.resolve();
        await releaseMutation.promise;
        events.push("mutation-end");
      },
    );
    await mutationStarted.promise;

    const deletion = coordinator.runDestructiveOperation(
      { projectHostIds: [23] },
      () => {
        events.push("deletion");
      },
    );
    expect(events).toEqual(["mutation-start"]);

    releaseMutation.resolve();
    await Promise.all([mutation, deletion]);
    expect(events).toEqual(["mutation-start", "mutation-end", "deletion"]);
  });

  it("删除成功后的墓碑永久拒绝旧握手复活目标", async () => {
    const coordinator = new TerminalSessionLifecycleCoordinator();
    await coordinator.runDestructiveOperation({ hostIds: [31] }, () => {
      coordinator.retire({ hostIds: [31] });
    });

    expect(() =>
      coordinator.assertSessionCreationAllowed({ hostIds: [31] }),
    ).toThrow(TerminalLifecycleUnavailableError);
    await expect(
      coordinator.runSessionMutation({ hostIds: [31] }, () => undefined),
    ).rejects.toBeInstanceOf(TerminalLifecycleUnavailableError);
  });

  it("删除失败后解除临时封锁且不留下墓碑", async () => {
    const coordinator = new TerminalSessionLifecycleCoordinator();
    await expect(
      coordinator.runDestructiveOperation({ hostIds: [47] }, () => {
        throw new Error("delete failed");
      }),
    ).rejects.toThrow("delete failed");

    expect(() =>
      coordinator.assertSessionCreationAllowed({ hostIds: [47] }),
    ).not.toThrow();
    await expect(
      coordinator.runSessionMutation({ hostIds: [47] }, () => "allowed"),
    ).resolves.toBe("allowed");
  });

  it("删除用户期间阻止该用户在其他主机新建会话", async () => {
    const coordinator = new TerminalSessionLifecycleCoordinator();
    const release = deferred();
    const deletion = coordinator.runDestructiveOperation(
      { userIds: ["user-1"] },
      () => release.promise,
    );

    expect(() =>
      coordinator.assertSessionCreationAllowed({
        userIds: ["user-1"],
        hostIds: [99],
      }),
    ).toThrow(TerminalLifecycleUnavailableError);
    expect(() =>
      coordinator.assertSessionCreationAllowed({
        userIds: ["user-2"],
        hostIds: [99],
      }),
    ).not.toThrow();

    release.resolve();
    await deletion;
  });
});
