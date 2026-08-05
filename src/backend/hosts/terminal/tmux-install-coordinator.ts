import type { TmuxInstallResult } from "../tmux/helper.js";

const tmuxInstallOperations = new Map<number, Promise<TmuxInstallResult>>();

/** 同一主机只运行一个安装任务；完成或失败后必须释放，保证后续可以重试。 */
export async function runTmuxInstallSingleflight(
  hostId: number,
  startInstallation: () => Promise<TmuxInstallResult>,
): Promise<TmuxInstallResult> {
  const existing = tmuxInstallOperations.get(hostId);
  if (existing) return existing;

  const operation = Promise.resolve().then(startInstallation);
  tmuxInstallOperations.set(hostId, operation);
  try {
    return await operation;
  } finally {
    if (tmuxInstallOperations.get(hostId) === operation) {
      tmuxInstallOperations.delete(hostId);
    }
  }
}
