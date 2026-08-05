import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, RefreshCw, RotateCcw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/button.tsx";
import { Alert, AlertDescription, AlertTitle } from "@/components/alert.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/select.tsx";
import { AccordionSection } from "./AdminSettingsShared";
import {
  getUpdateHistory,
  getUpdateStatus,
  rollbackCloudsshUpdate,
  setCloudsshUpdateMode,
  startCloudsshUpdate,
  type UpdateJob,
  type UpdateMode,
  type UpdateStatus,
} from "@/api/update-api";

function newIdempotencyKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function isRunning(job: UpdateJob | null): boolean {
  return !!job && !["idle", "succeeded", "failed"].includes(job.phase);
}

const phaseTranslationKeys: Record<UpdateJob["phase"], string> = {
  idle: "admin.updatePhaseIdle",
  checking: "admin.updatePhaseChecking",
  backing_up: "admin.updatePhaseBackingUp",
  pulling: "admin.updatePhasePulling",
  restarting: "admin.updatePhaseRestarting",
  verifying: "admin.updatePhaseVerifying",
  rolling_back: "admin.updatePhaseRollingBack",
  succeeded: "admin.updatePhaseSucceeded",
  failed: "admin.updatePhaseFailed",
};

const modeTranslationKeys: Record<UpdateMode, string> = {
  auto: "admin.updateModeAuto",
  image: "admin.updateModeImage",
  binary: "admin.updateModeBinary",
};

const modeDescriptionKeys: Record<UpdateMode, string> = {
  auto: "admin.updateModeAutoDesc",
  image: "admin.updateModeImageDesc",
  binary: "admin.updateModeBinaryDesc",
};

export function AdminUpdateSection({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [history, setHistory] = useState<UpdateJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [changingMode, setChangingMode] = useState(false);
  const pollTimer = useRef<number | null>(null);

  const load = useCallback(
    async (forceRefresh = false, silent = false) => {
      setLoading(true);
      try {
        const [nextStatus, nextHistory] = await Promise.all([
          getUpdateStatus(forceRefresh),
          getUpdateHistory(),
        ]);
        setStatus(nextStatus);
        setHistory(nextHistory?.jobs ?? []);
      } catch (error) {
        if (!silent) {
          const message =
            (error as { message?: string })?.message ||
            t("admin.updateLoadFailed");
          toast.error(message);
        }
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  useEffect(() => {
    if (!open || !isRunning(status?.activeJob ?? null)) return;
    // 主容器切换时短暂不可达属于正常流程。轮询失败后保留当前进度并
    // 安静重试，避免每两秒弹出一次错误提示。
    pollTimer.current = window.setInterval(() => void load(false, true), 2000);
    return () => {
      if (pollTimer.current !== null) window.clearInterval(pollTimer.current);
      pollTimer.current = null;
    };
  }, [open, status?.activeJob, load]);

  async function handleUpdate() {
    const target = status?.latestVersion;
    if (!target || !status?.updater?.enabled) return;
    if (!window.confirm(t("admin.updateConfirm", { version: target }))) return;

    setWorking(true);
    try {
      const result = await startCloudsshUpdate(
        target,
        newIdempotencyKey("cloudssh-update"),
      );
      setStatus((previous) =>
        previous ? { ...previous, activeJob: result.job } : previous,
      );
      toast.success(t("admin.updateStarted"));
    } catch (error) {
      toast.error(
        (error as { message?: string })?.message || t("admin.updateFailed"),
      );
    } finally {
      setWorking(false);
      void load();
    }
  }

  async function handleModeChange(mode: UpdateMode) {
    if (mode === status?.updater.mode) return;
    setChangingMode(true);
    try {
      const result = await setCloudsshUpdateMode(mode);
      setStatus((previous) =>
        previous
          ? {
              ...previous,
              updater: {
                ...previous.updater,
                mode: result.mode,
                supportedModes: result.supportedModes,
                activeSource: result.activeSource,
                restartRequired: result.restartRequired,
                enabled:
                  result.mode === "image" ? false : previous.updater.enabled,
              },
            }
          : previous,
      );
      toast.success(t("admin.updateModeChanged"));
      void load();
    } catch (error) {
      toast.error(
        (error as { message?: string })?.message ||
          t("admin.updateModeChangeFailed"),
      );
    } finally {
      setChangingMode(false);
    }
  }

  async function handleRollback() {
    if (!window.confirm(t("admin.rollbackConfirm"))) return;
    setWorking(true);
    try {
      const result = await rollbackCloudsshUpdate(
        newIdempotencyKey("cloudssh-rollback"),
      );
      setStatus((previous) =>
        previous ? { ...previous, activeJob: result.job } : previous,
      );
      toast.success(t("admin.rollbackStarted"));
    } catch (error) {
      toast.error(
        (error as { message?: string })?.message || t("admin.rollbackFailed"),
      );
    } finally {
      setWorking(false);
      void load();
    }
  }

  const activeJob = status?.activeJob ?? null;
  const updater = status?.updater;
  const updateMode = updater?.mode ?? "auto";
  const supportedModes =
    updater?.supportedModes && updater.supportedModes.length > 0
      ? updater.supportedModes
      : (["auto", "image", "binary"] satisfies UpdateMode[]);
  const canUpdate =
    status?.status === "update_available" &&
    !!status?.latestVersion &&
    updater?.enabled === true &&
    !isRunning(activeJob);

  return (
    <AccordionSection
      label={t("admin.sectionUpdates")}
      icon={<RefreshCw className="size-3.5" />}
      open={open}
      onToggle={onToggle}
    >
      <div className="flex flex-col gap-3 pt-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-foreground">
              {t("admin.currentVersion")}: {status?.currentVersion || "—"}
            </div>
            <div className="text-[10px] text-muted-foreground">
              {status?.latestVersion
                ? t("admin.latestVersion", { version: status.latestVersion })
                : t("admin.latestVersionUnknown")}
            </div>
            {updater?.version && (
              <div className="text-[10px] text-muted-foreground">
                {t("admin.updaterVersion", {
                  version: updater.version,
                })}
              </div>
            )}
            {status?.status === "up_to_date" && (
              <div className="text-[10px] text-emerald-600">
                {t("admin.updateUpToDate")}
              </div>
            )}
            {status?.releaseUrl && (
              <a
                href={status.releaseUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-[10px] text-accent-brand hover:underline"
              >
                {t("admin.viewReleaseNotes")}
                <ExternalLink className="size-2.5" />
              </a>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs shrink-0"
            onClick={() => void load(true)}
            disabled={loading || working}
          >
            <RefreshCw className={`size-3 ${loading ? "animate-spin" : ""}`} />
            {t("admin.checkUpdates")}
          </Button>
        </div>

        {updater && (
          <div className="flex items-start justify-between gap-3 border-y border-border py-2">
            <div className="min-w-0">
              <div className="text-xs font-semibold">
                {t("admin.updateMode")}
              </div>
              <div className="text-[10px] text-muted-foreground">
                {t(modeDescriptionKeys[updateMode])}
              </div>
            </div>
            <Select
              value={updateMode}
              onValueChange={(value) =>
                void handleModeChange(value as UpdateMode)
              }
              disabled={changingMode || working || isRunning(activeJob)}
            >
              <SelectTrigger className="h-7 w-28 shrink-0 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {supportedModes.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {t(modeTranslationKeys[mode])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {updater?.restartRequired && (
          <Alert className="border-amber-500/40 bg-amber-500/5">
            <RefreshCw className="size-4 text-amber-600" />
            <AlertTitle className="text-xs">
              {t("admin.updateModeRestartRequired")}
            </AlertTitle>
            <AlertDescription className="text-[10px] text-muted-foreground">
              {t("admin.updateModeRestartRequiredDesc", {
                source: t(
                  updater.activeSource === "binary"
                    ? "admin.updateSourceBinary"
                    : "admin.updateSourceImage",
                ),
              })}
            </AlertDescription>
          </Alert>
        )}

        {status && !updater?.enabled && (
          <Alert className="border-border bg-muted/30">
            <ShieldCheck className="size-4" />
            <AlertTitle className="text-xs">
              {updater?.configured
                ? t("admin.updaterUnavailable")
                : t("admin.updaterNotInstalled")}
            </AlertTitle>
            <AlertDescription className="text-[10px] text-muted-foreground">
              {updater?.message ||
                (updater?.configured
                  ? t("admin.updaterUnavailableDesc")
                  : t("admin.updaterNotInstalledDesc"))}
            </AlertDescription>
          </Alert>
        )}

        {activeJob && (
          <div className="border border-border bg-background/50 p-2 text-[10px]">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold">{t("admin.updateProgress")}</span>
              <span className="font-mono text-accent-brand">
                {t(phaseTranslationKeys[activeJob.phase])} ·{" "}
                {activeJob.progress}%
              </span>
            </div>
            <div
              role="progressbar"
              aria-label={t("admin.updateProgress")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={activeJob.progress}
              className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full rounded-full bg-accent-brand transition-[width] duration-300"
                style={{ width: `${activeJob.progress}%` }}
              />
            </div>
            {activeJob.message && (
              <div className="mt-1 text-muted-foreground">
                {activeJob.message}
              </div>
            )}
          </div>
        )}

        {canUpdate && (
          <Button
            size="sm"
            className="h-8 text-xs"
            onClick={() => void handleUpdate()}
            disabled={working}
          >
            <RefreshCw className={`size-3 ${working ? "animate-spin" : ""}`} />
            {t("admin.updateNow", {
              version: status?.latestVersion,
            })}
          </Button>
        )}

        {updater?.canRollback && updater.enabled && !isRunning(activeJob) && (
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs border-amber-500/40 text-amber-600"
            onClick={() => void handleRollback()}
            disabled={working}
          >
            <RotateCcw className="size-3" />
            {t("admin.rollbackLast")}
          </Button>
        )}

        {history.length > 0 && (
          <div className="border-t border-border pt-2">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              {t("admin.updateHistory")}
            </div>
            <div className="flex flex-col gap-1.5">
              {history.slice(0, 5).map((job) => (
                <div
                  key={job.id}
                  className="flex items-center justify-between gap-2 text-[10px]"
                >
                  <span className="truncate text-muted-foreground">
                    {job.targetVersion}
                  </span>
                  <span className="shrink-0 font-mono">
                    {t(phaseTranslationKeys[job.phase])}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="text-[10px] text-muted-foreground">
          {t("admin.updateBackupNote")}
        </div>
      </div>
    </AccordionSection>
  );
}
