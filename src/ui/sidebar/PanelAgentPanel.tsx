import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bot,
  BrainCircuit,
  RefreshCw,
  Send,
  Server,
  ShieldCheck,
  Terminal,
  Wrench,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { Checkbox } from "@/components/checkbox";
import { Textarea } from "@/components/textarea";
import { Input } from "@/components/input";
import {
  getPanelAgentModels,
  getPanelAgentSettings,
  sendPanelAgentChat,
  type PanelAgentChatMessage,
  type PanelAgentModel,
  type PanelAgentSettings,
  type PanelAgentTargetInput,
  type PanelAgentToolCall,
} from "@/api/panel-agent-api";
import type { Tab } from "@/types/ui-types";

const TOOL_ROUND_LIMIT = 6;
const COMMAND_OBSERVE_DELAY_MS = 1_200;

type ToolResultPayload = {
  ok: boolean;
  action: string;
  targetId?: string;
  hostName?: string;
  command?: string;
  risk?: string;
  purpose?: string;
  blocked?: boolean;
  error?: string;
  connected?: boolean;
  recentOutput?: string;
};

function sleep(ms: number) {
  const { promise, resolve } = Promise.withResolvers<void>();
  window.setTimeout(resolve, ms);
  return promise;
}

function stringArg(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberArg(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function commandWithEnter(command: string): string {
  return command.endsWith("\n") || command.endsWith("\r")
    ? command
    : `${command}\r`;
}

function parseToolResult(content: string): ToolResultPayload | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as ToolResultPayload)
      : null;
  } catch {
    return null;
  }
}

function toolCallSummary(toolCall: PanelAgentToolCall) {
  const args = toolCall.arguments ?? {};
  const targetId = stringArg(args.targetId);
  if (toolCall.name === "run_terminal_command") {
    const command = stringArg(args.command);
    return `${toolCall.name}${targetId ? ` · ${targetId}` : ""}${command ? ` · ${command}` : ""}`;
  }
  return `${toolCall.name}${targetId ? ` · ${targetId}` : ""}`;
}

function roleClass(role: PanelAgentChatMessage["role"]) {
  if (role === "user") return "ml-8 border-accent-brand/30 bg-accent-brand/10";
  if (role === "tool") return "border-border bg-muted/40";
  return "mr-8 border-border bg-card";
}

export function PanelAgentPanel({
  terminalTabs,
  activeTabId,
  embedded = false,
}: {
  terminalTabs: Tab[];
  activeTabId: string;
  embedded?: boolean;
}) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<PanelAgentSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [selectedTabIds, setSelectedTabIds] = useState<Set<string>>(new Set());
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(
    new Set(),
  );
  const [messages, setMessages] = useState<PanelAgentChatMessage[]>([]);
  const [working, setWorking] = useState(false);
  const [selectedModel, setSelectedModel] = useState("");
  const [models, setModels] = useState<PanelAgentModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  const activeTerminalTab = useMemo(
    () => terminalTabs.find((tab) => tab.id === activeTabId) ?? terminalTabs[0],
    [activeTabId, terminalTabs],
  );

  useEffect(() => {
    if (activeTerminalTab && selectedTabIds.size === 0) {
      setSelectedTabIds(new Set([activeTerminalTab.id]));
    }
  }, [activeTerminalTab, selectedTabIds.size]);

  async function loadSettings() {
    setSettingsLoading(true);
    try {
      const loaded = await getPanelAgentSettings();
      setSettings(loaded);
      setSelectedModel(loaded.model);
      setSelectedSkillIds(
        new Set(
          loaded.skills
            .filter((skill) => skill.enabled)
            .map((skill) => skill.id),
        ),
      );
    } catch {
      toast.error(t("panelAgent.settingsLoadFailed"));
    } finally {
      setSettingsLoading(false);
    }
  }

  useEffect(() => {
    loadSettings();
  }, []);

  async function loadModels() {
    setModelsLoading(true);
    try {
      const loaded = await getPanelAgentModels();
      setModels(loaded);
      if (!selectedModel && loaded[0]) setSelectedModel(loaded[0].id);
    } catch {
      toast.error(t("panelAgent.modelsLoadFailed"));
    } finally {
      setModelsLoading(false);
    }
  }

  function toggleTab(tabId: string) {
    setSelectedTabIds((prev) => {
      const next = new Set(prev);
      if (next.has(tabId)) next.delete(tabId);
      else next.add(tabId);
      return next;
    });
  }

  function toggleSkill(skillId: string) {
    setSelectedSkillIds((prev) => {
      const next = new Set(prev);
      if (next.has(skillId)) next.delete(skillId);
      else next.add(skillId);
      return next;
    });
  }

  function selectedTargets(): PanelAgentTargetInput[] {
    return terminalTabs
      .filter((tab) => selectedTabIds.has(tab.id))
      .map((tab) => {
        const handle = tab.terminalRef?.current;
        const context = handle?.getSessionContext?.();
        return {
          targetId: tab.id,
          hostId: tab.host?.id ?? context?.hostId ?? null,
          hostName: tab.host?.name ?? tab.label,
          sessionId: context?.sessionId ?? tab.persistentSessionId ?? null,
          agentSessionId: context?.agentSessionId ?? tab.agentSessionId ?? null,
          connected: context?.connected ?? handle?.isConnected?.() ?? false,
          recentOutput: handle?.getRecentOutput?.(160) ?? "",
        };
      });
  }

  function toolResult(
    toolCall: PanelAgentToolCall,
    payload: ToolResultPayload,
  ): PanelAgentChatMessage {
    return {
      role: "tool",
      toolCallId: toolCall.id,
      name: toolCall.name,
      content: JSON.stringify(payload),
    };
  }

  async function executeToolCall(
    toolCall: PanelAgentToolCall,
  ): Promise<PanelAgentChatMessage> {
    const targetId = stringArg(toolCall.arguments.targetId);
    const target = terminalTabs.find((tab) => tab.id === targetId);
    const handle = target?.terminalRef?.current;
    const hostName = target?.host?.name ?? target?.label ?? targetId;

    if (!target || !handle) {
      return toolResult(toolCall, {
        ok: false,
        action: toolCall.name,
        targetId,
        hostName,
        error: "TARGET_UNAVAILABLE",
      });
    }

    if (toolCall.name === "read_terminal_context") {
      const maxLines = Math.max(
        20,
        Math.min(500, numberArg(toolCall.arguments.maxLines, 160)),
      );
      return toolResult(toolCall, {
        ok: true,
        action: toolCall.name,
        targetId,
        hostName,
        connected: handle.isConnected?.() ?? false,
        recentOutput: handle.getRecentOutput?.(maxLines) ?? "",
      });
    }

    const command = stringArg(toolCall.arguments.command);
    const risk = stringArg(toolCall.arguments.risk) || "medium";
    const purpose = stringArg(toolCall.arguments.purpose);
    if (!command) {
      return toolResult(toolCall, {
        ok: false,
        action: toolCall.name,
        targetId,
        hostName,
        error: "COMMAND_REQUIRED",
      });
    }
    if (risk === "high") {
      return toolResult(toolCall, {
        ok: false,
        action: toolCall.name,
        targetId,
        hostName,
        command,
        risk,
        purpose,
        blocked: true,
        error: "HIGH_RISK_REQUIRES_CONFIRMATION",
        recentOutput: handle.getRecentOutput?.(80) ?? "",
      });
    }
    if (handle.isConnected?.() === false) {
      return toolResult(toolCall, {
        ok: false,
        action: toolCall.name,
        targetId,
        hostName,
        command,
        risk,
        purpose,
        error: "TARGET_NOT_CONNECTED",
        recentOutput: handle.getRecentOutput?.(80) ?? "",
      });
    }

    handle.sendInput?.(commandWithEnter(command));
    await sleep(COMMAND_OBSERVE_DELAY_MS);
    return toolResult(toolCall, {
      ok: true,
      action: toolCall.name,
      targetId,
      hostName,
      command,
      risk,
      purpose,
      connected: handle.isConnected?.() ?? false,
      recentOutput: handle.getRecentOutput?.(200) ?? "",
    });
  }

  async function continueConversation(seedMessages: PanelAgentChatMessage[]) {
    let history = seedMessages;
    for (let round = 0; round < TOOL_ROUND_LIMIT; round += 1) {
      const response = await sendPanelAgentChat({
        messages: history,
        skillIds: [...selectedSkillIds],
        targets: selectedTargets(),
        model: selectedModel.trim() || undefined,
      });
      const assistantMessage: PanelAgentChatMessage = response.message;
      history = [...history, assistantMessage];
      setMessages(history);
      if (assistantMessage.toolCalls?.length === 0) return;

      for (const toolCall of assistantMessage.toolCalls ?? []) {
        const result = await executeToolCall(toolCall);
        history = [...history, result];
        setMessages(history);
      }
    }

    const limitMessage: PanelAgentChatMessage = {
      role: "assistant",
      content: t("panelAgent.toolRoundLimit"),
      toolCalls: [],
    };
    setMessages([...history, limitMessage]);
  }

  async function handleSend() {
    const content = draft.trim();
    if (!content) {
      toast.error(t("panelAgent.instructionRequired"));
      return;
    }
    const nextMessages: PanelAgentChatMessage[] = [
      ...messages,
      { role: "user", content },
    ];
    setDraft("");
    setWorking(true);
    setMessages(nextMessages);
    try {
      await continueConversation(nextMessages);
    } catch {
      toast.error(t("panelAgent.chatFailed"));
    } finally {
      setWorking(false);
    }
  }

  function renderToolMessage(message: PanelAgentChatMessage, index: number) {
    const payload = parseToolResult(message.content);
    return (
      <div
        key={`${message.toolCallId ?? "tool"}-${index}`}
        className="border border-border bg-muted/40 p-2 text-[11px]"
      >
        <div className="mb-1 flex items-center gap-2 font-semibold text-muted-foreground">
          {payload?.blocked ? (
            <AlertTriangle className="size-3.5 text-amber-600" />
          ) : (
            <Wrench className="size-3.5" />
          )}
          <span>
            {payload?.ok
              ? t("panelAgent.toolCompleted")
              : payload?.blocked
                ? t("panelAgent.toolBlocked")
                : t("panelAgent.toolFailed")}
          </span>
          {payload?.hostName && (
            <span className="ml-auto truncate">{payload.hostName}</span>
          )}
        </div>
        {payload?.command && (
          <pre className="mb-1 overflow-auto bg-black p-2 text-green-200">
            {payload.command}
          </pre>
        )}
        {payload?.error && (
          <p className="mb-1 text-amber-600">{payload.error}</p>
        )}
        {payload?.recentOutput && (
          <pre className="max-h-36 overflow-auto whitespace-pre-wrap bg-background p-2 text-muted-foreground">
            {payload.recentOutput}
          </pre>
        )}
      </div>
    );
  }

  function renderMessage(message: PanelAgentChatMessage, index: number) {
    if (message.role === "tool") return renderToolMessage(message, index);
    return (
      <div
        key={`${message.role}-${index}`}
        className={`border p-3 text-xs ${roleClass(message.role)}`}
      >
        <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          {message.role === "user"
            ? t("panelAgent.you")
            : t("panelAgent.agent")}
        </div>
        {message.content && (
          <p className="whitespace-pre-wrap leading-5 text-foreground">
            {message.content}
          </p>
        )}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="mt-2 space-y-1">
            {message.toolCalls.map((toolCall) => (
              <div
                key={toolCall.id}
                className="flex items-center gap-2 border border-border bg-background p-2 text-[11px] text-muted-foreground"
              >
                <Wrench className="size-3.5" />
                <span className="truncate">{toolCallSummary(toolCall)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  const selectedCount = selectedTabIds.size;
  const activeSkills = settings?.skills.filter((skill) => skill.enabled) ?? [];
  const chatDisabled =
    working ||
    !settings?.enabled ||
    !settings.apiKeyConfigured ||
    !settings.baseUrl ||
    !(selectedModel.trim() || settings.model);

  return (
    <div
      className={`flex h-full min-h-0 flex-col ${embedded ? "bg-background" : "bg-sidebar"}`}
    >
      {!embedded && (
        <div className="border-b border-border p-3">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center border border-accent-brand/30 bg-accent-brand/10 text-accent-brand">
              <Bot className="size-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-foreground">
                {t("panelAgent.title")}
              </h2>
              <p className="text-[11px] text-muted-foreground">
                {t("panelAgent.subtitle")}
              </p>
            </div>
          </div>
        </div>
      )}
      <div className="flex-1 min-h-0 space-y-3 overflow-y-auto p-3">
        <section className="border border-border bg-card p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              <Server className="size-3.5" />
              {t("panelAgent.targets")}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={loadSettings}
              disabled={settingsLoading}
            >
              <RefreshCw className="size-3" />
              {t("common.refresh")}
            </Button>
          </div>
          {terminalTabs.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("panelAgent.noTerminals")}
            </p>
          ) : (
            <div className="space-y-1.5">
              {terminalTabs.map((tab) => {
                const connected =
                  tab.terminalRef?.current?.isConnected?.() ?? false;
                const disabled =
                  !settings?.multiServerEnabled &&
                  selectedCount > 0 &&
                  !selectedTabIds.has(tab.id);
                return (
                  <label
                    key={tab.id}
                    className={`flex cursor-pointer items-center gap-2 border border-border bg-background p-2 text-xs ${disabled ? "opacity-50" : ""}`}
                  >
                    <Checkbox
                      checked={selectedTabIds.has(tab.id)}
                      disabled={disabled}
                      onCheckedChange={() => toggleTab(tab.id)}
                    />
                    <Terminal className="size-3.5 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">
                      {tab.host?.name ?? tab.label}
                    </span>
                    <span
                      className={
                        connected ? "text-emerald-600" : "text-muted-foreground"
                      }
                    >
                      {connected
                        ? t("panelAgent.connected")
                        : t("panelAgent.notConnected")}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </section>

        <section className="border border-border bg-card p-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            <ShieldCheck className="size-3.5" />
            {t("panelAgent.skills")}
          </div>
          {activeSkills.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("panelAgent.noSkills")}
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {activeSkills.map((skill) => (
                <button
                  key={skill.id}
                  type="button"
                  onClick={() => toggleSkill(skill.id)}
                  className={`border px-2 py-1 text-[11px] ${selectedSkillIds.has(skill.id) ? "border-accent-brand bg-accent-brand/10 text-accent-brand" : "border-border text-muted-foreground hover:text-foreground"}`}
                >
                  {skill.name}
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="border border-border bg-card p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              <BrainCircuit className="size-3.5" />
              {t("panelAgent.model")}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={loadModels}
              disabled={
                modelsLoading ||
                !settings?.baseUrl ||
                !settings.apiKeyConfigured
              }
            >
              <RefreshCw
                className={`size-3 ${modelsLoading ? "animate-spin" : ""}`}
              />
              {modelsLoading
                ? t("panelAgent.fetchingModels")
                : t("panelAgent.fetchModels")}
            </Button>
          </div>
          <Input
            value={selectedModel}
            onChange={(event) => setSelectedModel(event.target.value)}
            placeholder={settings?.model || "gpt-4.1-mini"}
          />
          {models.length > 0 && (
            <select
              className="mt-2 flex h-8 w-full border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
              value={
                models.some((model) => model.id === selectedModel)
                  ? selectedModel
                  : ""
              }
              onChange={(event) => setSelectedModel(event.target.value)}
            >
              <option value="">{t("panelAgent.modelSelectPlaceholder")}</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.id}
                </option>
              ))}
            </select>
          )}
        </section>

        <section className="space-y-2 border border-border bg-card p-3">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            <BrainCircuit className="size-3.5" />
            {t("panelAgent.chat")}
          </div>
          <div className="min-h-48 space-y-2">
            {messages.length === 0 ? (
              <div className="border border-dashed border-border p-4 text-center text-xs leading-5 text-muted-foreground">
                {t("panelAgent.chatEmpty")}
              </div>
            ) : (
              messages.map(renderMessage)
            )}
            {working && (
              <div className="flex items-center gap-2 border border-border bg-muted/40 p-2 text-xs text-muted-foreground">
                <RefreshCw className="size-3.5 animate-spin" />
                {t("panelAgent.working")}
              </div>
            )}
          </div>
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t("panelAgent.chatPlaceholder")}
            rows={4}
          />
          <Button
            type="button"
            className="w-full"
            onClick={handleSend}
            disabled={chatDisabled}
          >
            <Send className="size-3.5" />
            {working ? t("panelAgent.working") : t("panelAgent.send")}
          </Button>
          {settings &&
            (!settings.enabled ||
              !settings.apiKeyConfigured ||
              !settings.baseUrl ||
              !(selectedModel.trim() || settings.model)) && (
              <p className="text-[11px] leading-5 text-amber-600">
                {t("panelAgent.adminConfigRequired")}
              </p>
            )}
        </section>
      </div>
    </div>
  );
}
