import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Bot,
  Check,
  Copy,
  KeyRound,
  Loader2,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  approveAgentDevice,
  getAgentAdminAccess,
  resolveAgentDeviceCode,
  revokeAgentDevice,
  updateAgentDevice,
  type AgentAdminAccess,
  type AgentDevice,
  type AgentScope,
  type PendingAgentDevice,
  type UpdateAgentDeviceInput,
} from "@/api/agent-admin-api";
import { Button } from "@/components/button";
import { Checkbox } from "@/components/checkbox";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/accordion";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/dialog";
import { Input } from "@/components/input";
import { Label } from "@/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/select";
import { copyToClipboard } from "@/lib/clipboard";
import {
  CLOUDSSH_REPOSITORY,
  isPublicHttpUrl,
} from "@/sidebar/agent-integration";
import {
  MfaStepUpDialog,
  type MfaStepUpMethod,
} from "@/components/MfaStepUpDialog";
import { getMfaStepUpMethods } from "@/api/mfa-api";

const EMPTY_ACCESS: AgentAdminAccess = { projects: [], devices: [] };
const AVAILABLE_SCOPES: AgentScope[] = [
  "sessions:create",
  "sessions:read",
  "sessions:write",
  "sessions:close",
  "jobs:execute",
  "servers:create",
  "quick-connections:create",
  "files:read",
  "files:write",
];
const DEFAULT_SCOPES = AVAILABLE_SCOPES.filter(
  (scope) => scope !== "files:write",
);
const SCOPE_LABEL_KEYS: Record<AgentScope, string> = {
  "sessions:create": "agentIntegration.management.scopeCreate",
  "sessions:read": "agentIntegration.management.scopeRead",
  "sessions:write": "agentIntegration.management.scopeWrite",
  "sessions:close": "agentIntegration.management.scopeClose",
  "jobs:execute": "agentIntegration.management.scopeJobs",
  "servers:create": "agentIntegration.management.scopeServersCreate",
  "quick-connections:create":
    "agentIntegration.management.scopeQuickConnectionsCreate",
  "files:read": "agentIntegration.management.scopeFilesRead",
  "files:write": "agentIntegration.management.scopeFilesWrite",
};
const SCOPE_DESCRIPTION_KEYS: Record<AgentScope, string> = {
  "sessions:create": "agentIntegration.management.scopeCreateDescription",
  "sessions:read": "agentIntegration.management.scopeReadDescription",
  "sessions:write": "agentIntegration.management.scopeWriteDescription",
  "sessions:close": "agentIntegration.management.scopeCloseDescription",
  "jobs:execute": "agentIntegration.management.scopeJobsDescription",
  "servers:create": "agentIntegration.management.scopeServersCreateDescription",
  "quick-connections:create":
    "agentIntegration.management.scopeQuickConnectionsCreateDescription",
  "files:read": "agentIntegration.management.scopeFilesReadDescription",
  "files:write": "agentIntegration.management.scopeFilesWriteDescription",
};

function skillScriptPath() {
  return /Win/i.test(navigator.platform)
    ? "$env:USERPROFILE\\.agents\\skills\\cloudssh-agent\\scripts\\cloudssh.mjs"
    : "$HOME/.agents/skills/cloudssh-agent/scripts/cloudssh.mjs";
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function CodeBlock({
  value,
  muted = false,
}: {
  value: string;
  muted?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={`flex items-start gap-2 border-y border-border/70 px-2 py-2 ${muted ? "bg-muted/15 text-muted-foreground" : "bg-background/60"}`}
    >
      <code className="min-w-0 flex-1 break-words whitespace-pre-wrap text-[10px] leading-4">
        {value}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t("common.copy")}
        onClick={() => void copyToClipboard(value)}
      >
        <Copy className="size-3" />
      </Button>
    </div>
  );
}

function localDateTimeValue(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function DeviceEditDialog({
  device,
  projects,
  saving,
  onClose,
  onSave,
}: {
  device: AgentDevice;
  projects: AgentAdminAccess["projects"];
  saving: boolean;
  onClose: () => void;
  onSave: (input: UpdateAgentDeviceInput) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(device.name);
  const [accessMode, setAccessMode] = useState(device.accessMode);
  const [projectIds, setProjectIds] = useState(device.projectIds);
  const [scopes, setScopes] = useState(device.scopes);
  const [concurrency, setConcurrency] = useState(device.maxConcurrentSessions);
  const [expiresAt, setExpiresAt] = useState(
    localDateTimeValue(device.expiresAt),
  );
  const expirationTime = expiresAt ? new Date(expiresAt).getTime() : null;
  const valid =
    name.trim().length > 0 &&
    name.trim().length <= 64 &&
    scopes.length > 0 &&
    projects.length > 0 &&
    (accessMode === "all" || projectIds.length > 0) &&
    Number.isSafeInteger(concurrency) &&
    concurrency >= 1 &&
    concurrency <= 100 &&
    (expirationTime === null ||
      (Number.isFinite(expirationTime) && expirationTime > Date.now()));

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("agentIntegration.management.editDevice")}
          </DialogTitle>
          <DialogDescription className="break-all font-mono text-[10px]">
            {device.fingerprint}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="agent-device-name">
              {t("agentIntegration.management.deviceName")}
            </Label>
            <Input
              id="agent-device-name"
              value={name}
              maxLength={64}
              disabled={saving}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div className="space-y-1">
            <Label>{t("agentIntegration.management.projectAccess")}</Label>
            <Select
              value={accessMode}
              disabled={saving}
              onValueChange={(value) =>
                setAccessMode(value as "all" | "selected")
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  {t("agentIntegration.management.allManageableProjects")}
                </SelectItem>
                <SelectItem value="selected">
                  {t("agentIntegration.management.selectedProjects")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {accessMode === "selected" && (
            <div className="max-h-36 overflow-y-auto border-y border-border/60 py-1">
              {projects.map((project) => (
                <label
                  key={project.id}
                  className="flex items-center gap-2 px-1 py-1 text-[10px]"
                >
                  <Checkbox
                    checked={projectIds.includes(project.id)}
                    disabled={saving}
                    onCheckedChange={(checked) =>
                      setProjectIds((current) =>
                        checked === true
                          ? [...new Set([...current, project.id])]
                          : current.filter((id) => id !== project.id),
                      )
                    }
                  />
                  {project.name}
                </label>
              ))}
            </div>
          )}

          <fieldset className="grid grid-cols-2 gap-1">
            <legend className="col-span-2 text-[10px] font-medium">
              {t("agentIntegration.management.scopes")}
            </legend>
            {AVAILABLE_SCOPES.map((scope) => (
              <label
                key={scope}
                className="flex items-center gap-1.5 text-[9px]"
              >
                <Checkbox
                  checked={scopes.includes(scope)}
                  disabled={saving}
                  onCheckedChange={(checked) =>
                    setScopes((current) =>
                      checked === true
                        ? [...new Set([...current, scope])]
                        : current.filter((item) => item !== scope),
                    )
                  }
                />
                <span title={t(SCOPE_DESCRIPTION_KEYS[scope])}>
                  {t(SCOPE_LABEL_KEYS[scope])}
                </span>
              </label>
            ))}
          </fieldset>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="agent-device-concurrency">
                {t("agentIntegration.management.maxConcurrency")}
              </Label>
              <Input
                id="agent-device-concurrency"
                type="number"
                min={1}
                max={100}
                value={concurrency}
                disabled={saving}
                onChange={(event) => setConcurrency(Number(event.target.value))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="agent-device-expiration">
                {t("agentIntegration.management.expirationOptional")}
              </Label>
              <Input
                id="agent-device-expiration"
                type="datetime-local"
                value={expiresAt}
                disabled={saving}
                onChange={(event) => setExpiresAt(event.target.value)}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={onClose}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            disabled={!valid || saving}
            onClick={() =>
              void onSave({
                name: name.trim(),
                accessMode,
                projectIds: accessMode === "all" ? [] : projectIds,
                scopes,
                maxConcurrentSessions: concurrency,
                expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
              })
            }
          >
            {saving ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Check className="size-3" />
            )}
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeviceRow({
  device,
  projectNames,
  showOwner,
  busy,
  onEdit,
  onRevoke,
}: {
  device: AgentDevice;
  projectNames: Map<string, string>;
  showOwner: boolean;
  busy: boolean;
  onEdit: () => void;
  onRevoke: () => void;
}) {
  const { t } = useTranslation();
  const projects =
    device.accessMode === "all"
      ? t("agentIntegration.management.allManageableProjects")
      : device.projectIds.map((id) => projectNames.get(id) ?? id).join("、");
  return (
    <div className="flex items-start gap-2 border-t border-border/60 px-2 py-2 first:border-0">
      <KeyRound className="mt-0.5 size-3.5 text-emerald-500" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[11px] font-semibold">
            {device.name}
          </span>
          <span
            className={`size-1.5 rounded-full ${device.status === "active" ? "bg-emerald-500" : "bg-muted-foreground"}`}
          />
        </div>
        <p className="truncate font-mono text-[9px] text-muted-foreground">
          {device.fingerprint.slice(0, 12)}…{device.fingerprint.slice(-12)}
        </p>
        <p className="mt-0.5 truncate text-[9px] text-muted-foreground">
          {projects}
        </p>
        {showOwner && (
          <p className="mt-0.5 truncate text-[9px] text-muted-foreground/80">
            {t("agentIntegration.management.deviceOwnerAccount", {
              username:
                device.owner.username ??
                t("agentIntegration.management.unknownOwner"),
            })}
          </p>
        )}
      </div>
      {device.status === "active" && (
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={busy}
            aria-label={t("agentIntegration.management.editDevice")}
            title={t("agentIntegration.management.editDevice")}
            onClick={onEdit}
          >
            <Pencil className="size-3" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={busy}
            aria-label={t("agentIntegration.management.revokeDevice")}
            title={t("agentIntegration.management.revokeDevice")}
            onClick={onRevoke}
          >
            {busy ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Trash2 className="size-3 text-destructive" />
            )}
          </Button>
        </div>
      )}
    </div>
  );
}

export function AgentIntegrationPanel({
  platformUrl: platformUrlOverride,
}: {
  platformUrl?: string;
} = {}) {
  const { t } = useTranslation();
  const platformUrl = useMemo(
    () => platformUrlOverride ?? window.location.origin,
    [platformUrlOverride],
  );
  const insecure = isPublicHttpUrl(platformUrl);
  // 登录命令必须指向用户当前打开的 CloudSSH 面板。
  // 公网 HTTP 仍由 Skill 拒绝，但不能悄悄替换成固定的示例域名，
  // 否则复制出来的命令会连接到错误的实例。
  const loginUrl = platformUrl;
  const skillUrl = `${CLOUDSSH_REPOSITORY}/tree/main/skills/cloudssh-agent`;
  const scriptPath = skillScriptPath();
  const loginCommand = `node "${scriptPath}" auth login --url ${loginUrl}`;
  const agentPrompt = t("agentIntegration.agentPrompt", {
    skillUrl,
    loginCommand,
    statusCommand: `node "${scriptPath}" auth status`,
    serversCommand: `node "${scriptPath}" servers list`,
  });
  const [access, setAccess] = useState<AgentAdminAccess>(EMPTY_ACCESS);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState("");
  const [pending, setPending] = useState<PendingAgentDevice | null>(null);
  const [accessMode, setAccessMode] = useState<"all" | "selected">("all");
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [scopes, setScopes] = useState<AgentScope[]>(DEFAULT_SCOPES);
  const [concurrency, setConcurrency] = useState(1);
  const [expiresAt, setExpiresAt] = useState("");
  const [editingDevice, setEditingDevice] = useState<AgentDevice | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [stepUpAvailableMethods, setStepUpAvailableMethods] = useState<
    MfaStepUpMethod[]
  >(["webauthn", "totp"]);
  const pendingSensitiveActionRef = useRef<{
    action: () => Promise<void>;
    fallback: string;
    busyKey: string;
  } | null>(null);
  const lookupRevisionRef = useRef(0);
  const translationRef = useRef(t);
  translationRef.current = t;

  const refresh = async (failureKey = "refreshFailed") => {
    setLoading(true);
    try {
      setAccess(await getAgentAdminAccess());
    } catch (error) {
      toast.error(
        errorText(
          error,
          translationRef.current(`agentIntegration.management.${failureKey}`),
        ),
      );
    } finally {
      setLoading(false);
    }
  };
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    void refreshRef.current("loadFailed");
  }, []);

  async function runSensitiveAction(
    action: () => Promise<void>,
    fallback: string,
    busyKey: string,
    allowStepUp = true,
  ) {
    setBusy(busyKey);
    let waitingForStepUp = false;
    try {
      await action();
    } catch (error) {
      const methods = allowStepUp ? getMfaStepUpMethods(error) : null;
      if (methods) {
        waitingForStepUp = true;
        pendingSensitiveActionRef.current = { action, fallback, busyKey };
        setStepUpAvailableMethods(methods);
        setStepUpOpen(true);
        return;
      }
      toast.error(errorText(error, fallback));
    } finally {
      if (!waitingForStepUp) {
        setBusy((current) => (current === busyKey ? null : current));
      }
    }
  }

  async function finishStepUp() {
    const pendingAction = pendingSensitiveActionRef.current;
    pendingSensitiveActionRef.current = null;
    setStepUpOpen(false);
    if (!pendingAction) return;
    await runSensitiveAction(
      pendingAction.action,
      pendingAction.fallback,
      pendingAction.busyKey,
      false,
    );
  }

  async function lookupCode() {
    const revision = ++lookupRevisionRef.current;
    setPending(null);
    setBusy("resolve");
    try {
      const request = await resolveAgentDeviceCode(deviceCode);
      if (lookupRevisionRef.current === revision) setPending(request);
    } catch (error) {
      if (lookupRevisionRef.current === revision) {
        toast.error(
          errorText(error, t("agentIntegration.management.deviceCodeInvalid")),
        );
      }
    } finally {
      if (lookupRevisionRef.current === revision) setBusy(null);
    }
  }

  async function approve() {
    if (!pending) return;
    const request = pending;
    const input = {
      scopes: [...scopes],
      accessMode,
      projectIds: accessMode === "all" ? [] : [...projectIds],
      maxConcurrentSessions: concurrency,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    };
    await runSensitiveAction(
      async () => {
        await approveAgentDevice(request.requestId, input);
        setPending(null);
        setDeviceCode("");
        await refresh();
        toast.success(t("agentIntegration.management.deviceApproved"));
      },
      t("agentIntegration.management.deviceApproveFailed"),
      "approve",
    );
  }

  async function revoke(device: AgentDevice) {
    if (
      !window.confirm(
        t("agentIntegration.management.revokeDeviceConfirm", {
          name: device.name,
        }),
      )
    )
      return;
    await runSensitiveAction(
      async () => {
        await revokeAgentDevice(device.id);
        await refresh();
      },
      t("agentIntegration.management.deviceRevokeFailed"),
      device.id,
    );
  }

  async function saveDevice(input: UpdateAgentDeviceInput) {
    if (!editingDevice) return;
    const deviceId = editingDevice.id;
    await runSensitiveAction(
      async () => {
        await updateAgentDevice(deviceId, input);
        await refresh();
        setEditingDevice(null);
        toast.success(t("agentIntegration.management.deviceUpdated"));
      },
      t("agentIntegration.management.deviceUpdateFailed"),
      `edit:${deviceId}`,
    );
  }

  const projectNames = new Map(
    access.projects.map((project) => [project.id, project.name]),
  );
  const deviceGroups = useMemo(
    () => [
      {
        key: "current",
        label: t("agentIntegration.management.currentAccountDevices"),
        devices: access.devices.filter((device) => device.owner.isCurrentUser),
        showOwner: false,
      },
      {
        key: "other",
        label: t("agentIntegration.management.otherAccountDevices"),
        devices: access.devices.filter((device) => !device.owner.isCurrentUser),
        showOwner: true,
      },
    ],
    [access.devices, t],
  );
  const approvalValid =
    pending &&
    scopes.length > 0 &&
    access.projects.length > 0 &&
    (accessMode === "all" || projectIds.length > 0) &&
    concurrency >= 1 &&
    concurrency <= 100;

  return (
    <div className="flex-1 overflow-y-auto px-3 py-3">
      <div className="mb-3 flex items-center gap-2 border-b border-border/60 pb-3">
        <div className="flex size-9 items-center justify-center rounded-md bg-accent-brand text-white">
          <Bot className="size-4" />
        </div>
        <div>
          <h2 className="text-sm font-semibold">
            {t("agentIntegration.heroTitle")}
          </h2>
          <p className="text-[11px] text-muted-foreground">
            {t("agentIntegration.heroDescription")}
          </p>
        </div>
      </div>

      <section className="border-y border-border/70 py-3">
        <div className="mb-2 flex items-center gap-2">
          <ShieldCheck className="size-4 text-emerald-500" />
          <h3 className="text-xs font-semibold">
            {t("agentIntegration.management.approveNewDevice")}
          </h3>
        </div>
        <p className="mb-2 text-[10px] leading-4 text-muted-foreground">
          {t("agentIntegration.management.deviceApprovalDescription")}
        </p>
        <p className="mb-2 border-l-2 border-amber-500/70 pl-2 text-[10px] leading-4 text-amber-700 dark:text-amber-400">
          {t("agentIntegration.management.deviceApprovalSecurityNotice")}
        </p>
        <div className="flex gap-2">
          <Input
            value={deviceCode}
            maxLength={9}
            placeholder="ABCD-EFGH"
            disabled={busy === "approve"}
            onChange={(event) => {
              lookupRevisionRef.current += 1;
              setPending(null);
              setBusy((current) => (current === "resolve" ? null : current));
              setDeviceCode(event.target.value.toUpperCase());
            }}
          />
          <Button
            type="button"
            size="sm"
            disabled={
              busy !== null || deviceCode.replace(/\W/g, "").length !== 8
            }
            onClick={() => void lookupCode()}
          >
            {busy === "resolve" ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              t("agentIntegration.management.verifyDeviceCode")
            )}
          </Button>
        </div>

        {pending && (
          <div className="mt-3 space-y-2 border-t border-border/60 pt-3">
            <div className="rounded-md bg-muted/40 p-2">
              <p className="text-[11px] font-semibold">{pending.deviceName}</p>
              <p className="break-all font-mono text-[9px] text-muted-foreground">
                {pending.fingerprint}
              </p>
            </div>
            <div>
              <Label className="text-[10px]">
                {t("agentIntegration.management.projectAccess")}
              </Label>
              <Select
                value={accessMode}
                onValueChange={(value) =>
                  setAccessMode(value as "all" | "selected")
                }
              >
                <SelectTrigger size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    {t("agentIntegration.management.allManageableProjects")}
                  </SelectItem>
                  <SelectItem value="selected">
                    {t("agentIntegration.management.selectedProjects")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            {accessMode === "selected" && (
              <div className="max-h-32 overflow-y-auto border-y border-border/60 py-1">
                {access.projects.map((project) => (
                  <label
                    key={project.id}
                    className="flex items-center gap-2 px-1 py-1 text-[10px]"
                  >
                    <Checkbox
                      checked={projectIds.includes(project.id)}
                      onCheckedChange={(checked) =>
                        setProjectIds((current) =>
                          checked
                            ? [...new Set([...current, project.id])]
                            : current.filter((id) => id !== project.id),
                        )
                      }
                    />
                    {project.name}
                  </label>
                ))}
              </div>
            )}
            <fieldset className="grid grid-cols-2 gap-1">
              <legend className="col-span-2 text-[10px] font-medium">
                {t("agentIntegration.management.scopes")}
              </legend>
              {AVAILABLE_SCOPES.map((scope) => (
                <label
                  key={scope}
                  className="flex items-center gap-1.5 text-[9px]"
                >
                  <Checkbox
                    checked={scopes.includes(scope)}
                    onCheckedChange={(checked) =>
                      setScopes((current) =>
                        checked
                          ? [...new Set([...current, scope])]
                          : current.filter((item) => item !== scope),
                      )
                    }
                  />
                  <span title={t(SCOPE_DESCRIPTION_KEYS[scope])}>
                    {t(SCOPE_LABEL_KEYS[scope])}
                  </span>
                </label>
              ))}
            </fieldset>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor="agent-max-concurrency" className="text-[10px]">
                  {t("agentIntegration.management.maxConcurrency")}
                </Label>
                <Input
                  id="agent-max-concurrency"
                  type="number"
                  min={1}
                  max={100}
                  value={concurrency}
                  onChange={(event) =>
                    setConcurrency(Number(event.target.value))
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="agent-expiration" className="text-[10px]">
                  {t("agentIntegration.management.expirationOptional")}
                </Label>
                <Input
                  id="agent-expiration"
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(event) => setExpiresAt(event.target.value)}
                />
              </div>
            </div>
            <Button
              type="button"
              size="sm"
              className="w-full"
              disabled={!approvalValid || busy !== null || loading}
              onClick={() => void approve()}
            >
              {busy === "approve" ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Check className="size-3" />
              )}
              {t("agentIntegration.management.approveDevice")}
            </Button>
          </div>
        )}
      </section>

      <section className="mt-3 border-y border-border/70">
        <div className="flex items-center justify-between px-2 py-2">
          <h3 className="text-xs font-semibold">
            {t("agentIntegration.management.authorizedDevices")}
          </h3>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t("agentIntegration.management.refresh")}
            title={t("agentIntegration.management.refresh")}
            disabled={loading || busy !== null}
            onClick={() => void refresh()}
          >
            <RefreshCw className={`size-3 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
        {!loading && access.devices.length === 0 ? (
          <p className="border-t border-border/60 px-2 py-3 text-[10px] text-muted-foreground">
            {t("agentIntegration.management.noDevices")}
          </p>
        ) : (
          <div className="border-t border-border/60">
            {deviceGroups.map((group) => (
              <section
                key={group.key}
                aria-label={group.label}
                className="border-t border-border/50 first:border-t-0"
              >
                <div className="flex items-center justify-between bg-muted/15 px-2 py-1.5">
                  <h4 className="text-[9px] font-semibold tracking-wide text-muted-foreground">
                    {group.label}
                  </h4>
                  <span className="text-[9px] tabular-nums text-muted-foreground/70">
                    {group.devices.length}
                  </span>
                </div>
                {group.devices.length === 0 ? (
                  <p className="px-2 py-2 text-[9px] text-muted-foreground/70">
                    {t("agentIntegration.management.noDevicesInGroup")}
                  </p>
                ) : (
                  group.devices.map((device) => (
                    <DeviceRow
                      key={device.id}
                      device={device}
                      projectNames={projectNames}
                      showOwner={group.showOwner}
                      busy={busy === device.id || busy === `edit:${device.id}`}
                      onEdit={() => setEditingDevice(device)}
                      onRevoke={() => void revoke(device)}
                    />
                  ))
                )}
              </section>
            ))}
          </div>
        )}
      </section>

      <section className="mt-3 space-y-2">
        <h3 className="text-xs font-semibold">
          {t("agentIntegration.installTitle")}
        </h3>
        <CodeBlock value={skillUrl} />
        <Accordion
          type="single"
          collapsible
          className="border-y border-border/70 bg-muted/10"
        >
          <AccordionItem value="agent-prompt" className="border-b-0">
            <AccordionTrigger className="px-2 py-2 text-xs text-muted-foreground hover:bg-muted/25 hover:no-underline">
              <span className="flex min-w-0 flex-col gap-0.5 pr-1">
                <span className="font-semibold">
                  {t("agentIntegration.agentPromptTitle")}
                </span>
                <span className="text-[10px] leading-4 font-normal text-muted-foreground/70">
                  {t("agentIntegration.agentPromptDescription")}
                </span>
              </span>
            </AccordionTrigger>
            <AccordionContent className="pb-0">
              <CodeBlock value={agentPrompt} muted />
            </AccordionContent>
          </AccordionItem>
        </Accordion>
        <h3 className="pt-1 text-xs font-semibold">
          {t("agentIntegration.loginTitle")}
        </h3>
        <CodeBlock value={loginCommand} />
        <p className="text-[10px] leading-4 text-muted-foreground">
          {t("agentIntegration.deviceLoginNotice")}
        </p>
      </section>
      {insecure && (
        <p className="mt-3 text-[10px] text-amber-600">
          {t("agentIntegration.httpsRequiredDescription")}
        </p>
      )}
      {editingDevice && (
        <DeviceEditDialog
          device={editingDevice}
          projects={access.projects}
          saving={busy === `edit:${editingDevice.id}`}
          onClose={() => setEditingDevice(null)}
          onSave={saveDevice}
        />
      )}
      <MfaStepUpDialog
        open={stepUpOpen}
        methods={stepUpAvailableMethods}
        onVerified={finishStepUp}
        onCancel={() => {
          const pendingAction = pendingSensitiveActionRef.current;
          pendingSensitiveActionRef.current = null;
          setStepUpOpen(false);
          if (pendingAction) {
            setBusy((current) =>
              current === pendingAction.busyKey ? null : current,
            );
          }
        }}
      />
    </div>
  );
}
