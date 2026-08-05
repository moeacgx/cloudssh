import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/alert-dialog";

type CloseTabConfirmDialogProps = {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
};

export function CloseTabConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onOpenChange,
}: CloseTabConfirmDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="gap-4 rounded-md bg-popover p-4 text-popover-foreground sm:max-w-sm">
        <AlertDialogHeader className="gap-1 text-left">
          <AlertDialogTitle className="font-heading text-sm font-medium">
            {title}
          </AlertDialogTitle>
          <AlertDialogDescription
            className={description ? "text-xs/relaxed" : "sr-only"}
          >
            {description ?? title}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex-row justify-end">
          <AlertDialogCancel autoFocus>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20"
            onClick={onConfirm}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
