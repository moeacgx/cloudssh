import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  status: vi.fn(),
  begin: vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/main-axios.ts", () => ({
  listActiveTransfers: api.list,
  getTransferStatus: api.status,
}));
vi.mock("@/features/file-manager/transferProgressMonitor.tsx", () => ({
  beginTransferProgressMonitoring: api.begin,
  isTransferBeingMonitored: () => false,
  showTransferCompletionToast: vi.fn(),
}));
import { TransferMonitor } from "@/features/file-manager/TransferMonitor";
import {
  getPendingTransferIds,
  registerPendingTransfer,
} from "@/features/file-manager/transferNotificationStore";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  localStorage.clear();
});

describe("传输状态轮询", () => {
  it("30 秒慢请求期间只有一个在途查询，失败后能继续", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    api.list
      .mockReturnValueOnce(
        new Promise((_, fail) => {
          reject = fail;
        }),
      )
      .mockResolvedValue({ transfers: [] });
    render(<TransferMonitor />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(api.list).toHaveBeenCalledTimes(1);
    await act(async () => {
      reject(new Error("timeout"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it("卸载后忽略仍在返回的传输列表", async () => {
    let finish!: (value: unknown) => void;
    api.list.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { unmount } = render(<TransferMonitor />);
    unmount();
    await act(async () => {
      finish({ transfers: [{ transferId: "late" }] });
    });
    expect(api.begin).not.toHaveBeenCalled();
  });

  it.each(["api", "axios"])(
    "查询超时保留待恢复传输，%s 404 才清理",
    async (shape) => {
      vi.useFakeTimers();
      registerPendingTransfer("pending-1");
      api.list.mockResolvedValue({ transfers: [] });
      api.status.mockRejectedValueOnce(new Error("timeout"));
      render(<TransferMonitor />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(getPendingTransferIds()).toEqual(["pending-1"]);
      let missingError: unknown = { response: { status: 404 } };
      if (shape === "api") {
        const { handleApiError } =
          await vi.importActual<typeof import("@/main-axios.ts")>(
            "@/main-axios.ts",
          );
        try {
          handleApiError(
            { isAxiosError: true, response: { status: 404 }, config: {} },
            "get transfer status",
          );
        } catch (error) {
          missingError = error;
        }
        expect(missingError).toMatchObject({ name: "ApiError", status: 404 });
        expect(missingError).not.toHaveProperty("response");
      }
      api.status.mockRejectedValueOnce(missingError);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(getPendingTransferIds()).toEqual([]);
    },
  );
});
