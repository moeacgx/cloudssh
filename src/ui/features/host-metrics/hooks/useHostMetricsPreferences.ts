import { useCallback, useEffect, useRef, useState } from "react";
import { getHostMetricsLayout, saveHostMetricsLayout } from "@/main-axios";
import type { HostMetricsLayout } from "@/types/host-metrics";
import { useProjectHostId } from "../ProjectHostContext";

const SAVE_DEBOUNCE_MS = 800;

function lsKey(hostId: number, projectHostId?: number) {
  return `hostMetricsLayout:${projectHostId ?? "personal"}:${hostId}`;
}

function readCache(
  hostId: number,
  projectHostId?: number,
): HostMetricsLayout | null {
  try {
    const raw = localStorage.getItem(lsKey(hostId, projectHostId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.slots))
      return parsed as HostMetricsLayout;
  } catch {
    /* ignore */
  }
  return null;
}

function writeCache(
  hostId: number,
  layout: HostMetricsLayout,
  projectHostId?: number,
) {
  try {
    localStorage.setItem(lsKey(hostId, projectHostId), JSON.stringify(layout));
  } catch {
    /* ignore */
  }
}

/**
 * Per-host Host Metrics layout, cached in localStorage for instant paint and
 * synced to the backend (so it follows the user across devices). Saves are
 * debounced. Returns null layout until the first load resolves.
 */
export function useHostMetricsPreferences(hostId: number | null) {
  const projectHostId = useProjectHostId();
  const [layout, setLayout] = useState<HostMetricsLayout | null>(() =>
    hostId != null ? readCache(hostId, projectHostId) : null,
  );
  const [loaded, setLoaded] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (hostId == null) return;
    let cancelled = false;
    setLoaded(false);
    const cached = readCache(hostId, projectHostId);
    if (cached) setLayout(cached);

    getHostMetricsLayout(hostId, projectHostId)
      .then((remote) => {
        if (cancelled || !remote) return;
        setLayout(remote);
        writeCache(hostId, remote, projectHostId);
      })
      .catch(() => {
        /* keep cache/default */
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [hostId, projectHostId]);

  const save = useCallback(
    (next: HostMetricsLayout) => {
      if (hostId == null) return;
      setLayout(next);
      writeCache(hostId, next, projectHostId);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveHostMetricsLayout(hostId, next, projectHostId).catch(() => {
          /* best-effort; cache already holds it */
        });
      }, SAVE_DEBOUNCE_MS);
    },
    [hostId, projectHostId],
  );

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  return { layout, setLayout: save, loaded };
}
