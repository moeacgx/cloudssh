import { useEffect, useMemo, useState } from "react";
import { Fingerprint, Loader2, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { Input } from "@/components/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/dialog";
import { stepUpWithTotp } from "@/api/mfa-api";
import {
  getWebAuthnErrorTranslationKey,
  stepUpWithWebAuthn,
} from "@/api/webauthn-api";

export type MfaStepUpMethod = "totp" | "webauthn";

export type MfaStepUpDialogProps = {
  open: boolean;
  methods: MfaStepUpMethod[];
  onVerified: () => Promise<void> | void;
  onCancel: () => void;
};

function readableError(error: unknown, fallback: string) {
  if (!(error instanceof Error) || !error.message) return fallback;
  // 浏览器取消、权限或安全上下文错误通常是内部英文异常；统一替换成
  // 本地化提示，服务端返回的中文验证原因仍然原样保留。
  if (
    /NotAllowedError|AbortError|SecurityError|WebAuthn is not supported/i.test(
      error.message,
    )
  ) {
    return fallback;
  }
  return error.message;
}

/**
 * 敏感操作的统一二次验证窗口。这里明确写出 TOTP 身份验证器和通行密钥，
 * 避免只显示用户无法行动的“MFA”缩写。
 */
export function MfaStepUpDialog({
  open,
  methods,
  onVerified,
  onCancel,
}: MfaStepUpDialogProps) {
  const { t } = useTranslation();
  const availableMethods = useMemo(
    () => methods.filter((method, index) => methods.indexOf(method) === index),
    [methods],
  );
  const [method, setMethod] = useState<MfaStepUpMethod>(
    availableMethods.includes("totp") ? "totp" : "webauthn",
  );
  const [totpCode, setTotpCode] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) {
      setTotpCode("");
      setLoading(false);
      return;
    }
    setMethod(availableMethods.includes("totp") ? "totp" : "webauthn");
  }, [open, availableMethods]);

  async function verify() {
    if (loading) return;
    if (method === "totp" && !/^\d{6}$/.test(totpCode)) {
      toast.error(t("auth.stepUpTotpRequired"));
      return;
    }

    setLoading(true);
    try {
      if (method === "totp") {
        await stepUpWithTotp(totpCode);
      } else {
        await stepUpWithWebAuthn();
      }
      await onVerified();
    } catch (error) {
      const webAuthnErrorKey = getWebAuthnErrorTranslationKey(error);
      toast.error(
        webAuthnErrorKey
          ? t(webAuthnErrorKey)
          : readableError(error, t("auth.stepUpFailed")),
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !loading) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-accent-brand" />
            {t("auth.stepUpTitle")}
          </DialogTitle>
          <DialogDescription>{t("auth.stepUpDescription")}</DialogDescription>
        </DialogHeader>

        {availableMethods.length === 0 ? (
          <p className="border border-amber-500/40 bg-amber-500/5 px-3 py-3 text-xs text-muted-foreground">
            {t("auth.stepUpNoMethods")}
          </p>
        ) : availableMethods.length > 1 ? (
          <div className="grid grid-cols-2 gap-2" role="tablist">
            {availableMethods.includes("webauthn") && (
              <Button
                type="button"
                variant={method === "webauthn" ? "default" : "outline"}
                aria-selected={method === "webauthn"}
                onClick={() => setMethod("webauthn")}
                disabled={loading}
              >
                <Fingerprint className="size-3.5" />
                {t("auth.usePasskey")}
              </Button>
            )}
            {availableMethods.includes("totp") && (
              <Button
                type="button"
                variant={method === "totp" ? "default" : "outline"}
                aria-selected={method === "totp"}
                onClick={() => setMethod("totp")}
                disabled={loading}
              >
                {t("auth.useTotpAuthenticator")}
              </Button>
            )}
          </div>
        ) : null}

        {availableMethods.length > 0 && method === "totp" ? (
          <div className="space-y-2">
            <label htmlFor="mfa-step-up-totp" className="text-xs font-medium">
              {t("auth.totpAuthenticatorLabel")}
            </label>
            <Input
              id="mfa-step-up-totp"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="000000"
              value={totpCode}
              disabled={loading}
              onChange={(event) =>
                setTotpCode(event.target.value.replace(/\D/g, ""))
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") void verify();
              }}
              className="text-center font-mono text-xl tracking-normal"
              autoFocus
            />
          </div>
        ) : availableMethods.includes("webauthn") ? (
          <p className="border border-border/70 bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
            {t("auth.passkeyStepUpDescription")}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={loading}
          >
            {t("common.cancel")}
          </Button>
          {availableMethods.length > 0 && (
            <Button
              type="button"
              onClick={() => void verify()}
              disabled={loading}
            >
              {loading && <Loader2 className="size-3 animate-spin" />}
              {method === "webauthn"
                ? t("auth.verifyWithPasskey")
                : t("auth.verifyCode")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
