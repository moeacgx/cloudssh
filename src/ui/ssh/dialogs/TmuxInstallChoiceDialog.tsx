import { useTranslation } from "react-i18next";
import {
  Cloud,
  LoaderCircle,
  PackagePlus,
  ServerCog,
  ShieldAlert,
} from "lucide-react";
import { Button } from "@/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/dialog";

interface TmuxInstallChoiceDialogProps {
  isOpen: boolean;
  stage: "mode" | "install";
  pendingMode: "tmux" | "install_tmux" | "platform" | null;

  onUseTmux: () => void;
  onInstall: () => void;
  onPlatformKeepalive: () => void;
  onCancel: () => void;
}

export function TmuxInstallChoiceDialog({
  isOpen,
  stage,
  pendingMode,

  onUseTmux,
  onInstall,
  onPlatformKeepalive,
  onCancel,
}: TmuxInstallChoiceDialogProps) {
  const { t } = useTranslation();
  const busy = pendingMode !== null;
  const tmuxBusy = pendingMode === "tmux" || pendingMode === "install_tmux";
  const platformBusy = pendingMode === "platform";

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="w-[calc(100vw-2rem)] gap-0 overflow-hidden border-border/70 bg-popover p-0 shadow-2xl sm:max-w-md"
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <DialogHeader className="border-b border-border/60 px-5 py-4">
          <div className="mb-3 flex size-9 items-center justify-center border border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-400">
            <ShieldAlert className="size-4" />
          </div>
          <DialogTitle>
            {t(
              stage === "mode"
                ? "terminal.pinModeChoiceTitle"
                : "terminal.tmuxInstallChoiceTitle",
            )}
          </DialogTitle>
          <DialogDescription>
            {t(
              stage === "mode"
                ? "terminal.pinModeChoiceDescription"
                : "terminal.tmuxInstallChoiceDescription",
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2 px-5 py-4">
          <button
            type="button"
            disabled={busy}
            onClick={stage === "mode" ? onUseTmux : onInstall}
            className="group flex w-full items-start gap-3 border border-border/70 bg-background/50 px-3 py-3 text-left transition-colors hover:border-foreground/20 hover:bg-muted/60 disabled:pointer-events-none disabled:opacity-60"
          >
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center border border-border bg-background text-foreground">
              {tmuxBusy ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : stage === "mode" ? (
                <ServerCog className="size-3.5" />
              ) : (
                <PackagePlus className="size-3.5" />
              )}
            </span>
            <span className="min-w-0">
              <span className="block text-xs font-medium text-foreground">
                {tmuxBusy
                  ? t(
                      pendingMode === "tmux"
                        ? "terminal.checkingTmux"
                        : "terminal.tmuxInstalling",
                    )
                  : t(
                      stage === "mode"
                        ? "terminal.useRemoteTmux"
                        : "terminal.installTmuxAndPin",
                    )}
              </span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                {t(
                  stage === "mode"
                    ? "terminal.useRemoteTmuxDesc"
                    : "terminal.installTmuxAndPinDesc",
                )}
              </span>
            </span>
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={onPlatformKeepalive}
            className="group flex w-full items-start gap-3 border border-border/70 bg-background/50 px-3 py-3 text-left transition-colors hover:border-foreground/20 hover:bg-muted/60 disabled:pointer-events-none disabled:opacity-60"
          >
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center border border-border bg-background text-foreground">
              {platformBusy ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <Cloud className="size-3.5" />
              )}
            </span>
            <span className="min-w-0">
              <span className="block text-xs font-medium text-foreground">
                {t("terminal.usePlatformKeepalive")}
              </span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                {t("terminal.usePlatformKeepaliveDesc")}
              </span>
            </span>
          </button>
        </div>

        <div className="flex justify-end border-t border-border/60 bg-muted/20 px-5 py-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={onCancel}
          >
            {t("nav.cancel")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
