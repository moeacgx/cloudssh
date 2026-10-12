import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { getTransferStatus, listActiveTransfers } from "@/main-axios.ts";
import { createFormatTransferMetrics } from "./transferMetricsFormat.ts";
import {
  beginTransferProgressMonitoring,
  isTransferBeingMonitored,
  showTransferCompletionToast,
} from "./transferProgressMonitor.tsx";
import {
  clearStalePendingTransfer,
  getPendingTransferIds,
  isTransferNotified,
} from "./transferNotificationStore.ts";

const POLL_INTERVAL_MS = 2000;

export function TransferMonitor() {
  const inFlight = useRef(false);
  const { t } = useTranslation();
  const formatTransferMetrics = useMemo(
    () => createFormatTransferMetrics(t),
    [t],
  );

  useEffect(() => {
    let disposed = false;
    const reconcileTransfers = async () => {
      if (disposed || inFlight.current || document.visibilityState === "hidden")
        return;
      inFlight.current = true;
      try {
        try {
          const { transfers } = await listActiveTransfers();
          if (disposed) return;
          for (const transfer of transfers) {
            if (isTransferBeingMonitored(transfer.transferId)) continue;
            beginTransferProgressMonitoring(transfer.transferId, t, {
              resumed: true,
              initialStatus: transfer,
              formatTransferMetrics,
            });
          }
        } catch {
          // Non-fatal: file-manager service may be unavailable briefly
        }

        for (const transferId of getPendingTransferIds()) {
          if (disposed) return;
          if (
            isTransferBeingMonitored(transferId) ||
            isTransferNotified(transferId)
          ) {
            continue;
          }

          try {
            const status = await getTransferStatus(transferId);
            if (disposed) return;
            if (status.status === "running") {
              if (!isTransferBeingMonitored(transferId)) {
                beginTransferProgressMonitoring(transferId, t, {
                  resumed: true,
                  initialStatus: status,
                  formatTransferMetrics,
                });
              }
              continue;
            }

            showTransferCompletionToast(
              status,
              t,
              undefined,
              formatTransferMetrics,
            );
          } catch (error) {
            // 仅明确不存在时移除记录，网络异常后仍需恢复监控。
            const status = (error as { response?: { status?: number } })
              ?.response?.status;
            if (!disposed && status === 404)
              clearStalePendingTransfer(transferId);
          }
        }
      } finally {
        // 慢请求期间不叠加轮询；失败后允许下个周期重新查询。
        inFlight.current = false;
      }
    };

    let intervalId: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (intervalId !== null) return;
      intervalId = setInterval(reconcileTransfers, POLL_INTERVAL_MS);
    };
    const stop = () => {
      if (intervalId === null) return;
      clearInterval(intervalId);
      intervalId = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        stop();
        return;
      }
      void reconcileTransfers();
      start();
    };

    void reconcileTransfers();
    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      disposed = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [t, formatTransferMetrics]);

  return null;
}
