import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePageVisibleInterval } from "@/hooks/use-page-visible-interval";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("页面可见轮询", () => {
  it("请求未完成时跳过定时及恢复可见触发，完成后继续轮询", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const callback = vi
      .fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValue(undefined);
    renderHook(() => usePageVisibleInterval(callback, 2000));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(callback).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("失败不锁死后续轮询，卸载后不再启动请求", async () => {
    vi.useFakeTimers();
    const callback = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const { unmount } = renderHook(() =>
      usePageVisibleInterval(callback, 2000),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(callback).toHaveBeenCalledTimes(2);
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(callback).toHaveBeenCalledTimes(2);
  });
});
