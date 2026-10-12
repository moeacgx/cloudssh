import { useEffect, useRef } from "react";

function isDocumentVisible(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState !== "hidden";
}

type Options = {
  /** Run callback once when the effect mounts (if visible). Default true. */
  runOnMount?: boolean;
};

/**
 * Runs `callback` on `intervalMs` while the page is visible.
 * Pauses when the tab is backgrounded; fires once on resume.
 */
export function usePageVisibleInterval(
  callback: () => void | Promise<unknown>,
  intervalMs: number,
  enabled = true,
  options: Options = {},
): void {
  const { runOnMount = true } = options;
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const inFlight = useRef(false);

  useEffect(() => {
    if (!enabled || intervalMs <= 0) return;

    let intervalId: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
      if (inFlight.current || !isDocumentVisible()) return;
      inFlight.current = true;
      try {
        await callbackRef.current();
      } catch {
        // 具体错误由调用方展示；单次失败不能锁死后续轮询。
      } finally {
        inFlight.current = false;
      }
    };

    const start = () => {
      if (intervalId !== null) return;
      intervalId = setInterval(tick, intervalMs);
    };

    const stop = () => {
      if (intervalId === null) return;
      clearInterval(intervalId);
      intervalId = null;
    };

    const onVisibility = () => {
      if (isDocumentVisible()) {
        tick();
        start();
      } else {
        stop();
      }
    };

    if (isDocumentVisible()) {
      if (runOnMount) tick();
      start();
    }

    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs, enabled, runOnMount]);
}
