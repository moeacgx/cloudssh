import { describe, expect, it, vi } from "vitest";
import type { TmuxInstallResult } from "../../../hosts/tmux/helper.js";
import { runTmuxInstallSingleflight } from "../../../hosts/terminal/tmux-install-coordinator.js";

const installedResult: TmuxInstallResult = {
  status: "installed",
  packageManager: "apt-get",
  privilege: "root",
};

describe("tmux 主机级安装协调", () => {
  it("同一主机并发安装只启动一次并共享结果", async () => {
    let resolveInstallation!: (result: TmuxInstallResult) => void;
    const installation = new Promise<TmuxInstallResult>((resolve) => {
      resolveInstallation = resolve;
    });
    const startInstallation = vi.fn(() => installation);

    const first = runTmuxInstallSingleflight(42, startInstallation);
    const second = runTmuxInstallSingleflight(42, startInstallation);
    await Promise.resolve();

    expect(startInstallation).toHaveBeenCalledOnce();
    resolveInstallation(installedResult);
    await expect(Promise.all([first, second])).resolves.toEqual([
      installedResult,
      installedResult,
    ]);
  });

  it("不同主机的安装互不阻塞", async () => {
    const firstInstallation = vi.fn(async () => installedResult);
    const secondResult: TmuxInstallResult = {
      status: "installed",
      packageManager: "apk",
      privilege: "sudo",
    };
    const secondInstallation = vi.fn(async () => secondResult);

    await expect(
      Promise.all([
        runTmuxInstallSingleflight(100, firstInstallation),
        runTmuxInstallSingleflight(101, secondInstallation),
      ]),
    ).resolves.toEqual([installedResult, secondResult]);
    expect(firstInstallation).toHaveBeenCalledOnce();
    expect(secondInstallation).toHaveBeenCalledOnce();
  });

  it("失败结果和异常都会释放主机锁，允许下一次重试", async () => {
    const failedResult: TmuxInstallResult = {
      status: "install_failed",
      packageManager: "apt-get",
      privilege: "root",
    };
    const failedAttempt = vi.fn(async () => failedResult);
    const successfulRetry = vi.fn(async () => installedResult);

    await expect(
      runTmuxInstallSingleflight(200, failedAttempt),
    ).resolves.toEqual(failedResult);
    await expect(
      runTmuxInstallSingleflight(200, successfulRetry),
    ).resolves.toEqual(installedResult);

    const rejectedAttempt = vi.fn(async () => {
      throw new Error("installation channel closed");
    });
    await expect(
      runTmuxInstallSingleflight(201, rejectedAttempt),
    ).rejects.toThrow("installation channel closed");
    await expect(
      runTmuxInstallSingleflight(201, successfulRetry),
    ).resolves.toEqual(installedResult);

    expect(failedAttempt).toHaveBeenCalledOnce();
    expect(rejectedAttempt).toHaveBeenCalledOnce();
    expect(successfulRetry).toHaveBeenCalledTimes(2);
  });
});
