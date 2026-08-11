import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import {
  AlertTriangle,
  Bot,
  BrainCircuit,
  ChevronDown,
  History,
  MessageSquarePlus,
  Paperclip,
  Plus,
  RefreshCw,
  Send,
  Server,
  Square,
  ShieldCheck,
  Terminal,
  Trash2,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { Checkbox } from "@/components/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/dropdown-menu";
import { Textarea } from "@/components/textarea";
import {
  getPanelAgentModels,
  getPanelAgentSettings,
  sendPanelAgentChat,
  type PanelAgentChatAttachment,
  type PanelAgentChatMessage,
  type PanelAgentModel,
  type PanelAgentReasoningEffort,
  type PanelAgentSettings,
  type PanelAgentTargetInput,
  type PanelAgentToolCall,
} from "@/api/panel-agent-api";
import { MarkdownRenderer } from "@/features/file-manager/components/MarkdownRenderer";
import type { Tab } from "@/types/ui-types";

const TOOL_ROUND_LIMIT = 6;
const COMMAND_OBSERVE_DELAY_MS = 1_200;

const PANEL_AGENT_SELECTED_MODEL_STORAGE_KEY = "panelAgentSelectedModel";
const PANEL_AGENT_MODEL_LIST_STORAGE_KEY = "panelAgentModelList";
const PANEL_AGENT_THINKING_MODE_STORAGE_KEY = "panelAgentThinkingMode";
const PANEL_AGENT_CONVERSATION_HISTORY_STORAGE_KEY =
  "panelAgentConversationHistory";
const MAX_CHAT_ATTACHMENTS = 6;
const MAX_TEXT_ATTACHMENT_CHARS = 80_000;
const MAX_IMAGE_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const MAX_STORED_CONVERSATIONS = 12;

const PANEL_AGENT_THINKING_MODES: PanelAgentReasoningEffort[] = [
  "auto",
  "low",
  "medium",
  "high",
];

export type PanelAgentConversationAction = {
  id: number;
  type: "clear" | "new" | "history";
};

function readStoredSelectedModel(): string {
  if (typeof window === "undefined") return "";
  return (
    window.localStorage
      .getItem(PANEL_AGENT_SELECTED_MODEL_STORAGE_KEY)
      ?.trim() ?? ""
  );
}

function writeStoredSelectedModel(model: string) {
  const value = model.trim();
  if (value) {
    window.localStorage.setItem(PANEL_AGENT_SELECTED_MODEL_STORAGE_KEY, value);
  } else {
    window.localStorage.removeItem(PANEL_AGENT_SELECTED_MODEL_STORAGE_KEY);
  }
}

function readStoredThinkingMode(): PanelAgentReasoningEffort {
  if (typeof window === "undefined") return "auto";
  const value = window.localStorage.getItem(
    PANEL_AGENT_THINKING_MODE_STORAGE_KEY,
  );
  return PANEL_AGENT_THINKING_MODES.includes(value as PanelAgentReasoningEffort)
    ? (value as PanelAgentReasoningEffort)
    : "auto";
}

function writeStoredThinkingMode(mode: PanelAgentReasoningEffort) {
  window.localStorage.setItem(PANEL_AGENT_THINKING_MODE_STORAGE_KEY, mode);
}

function panelModelForSettings(settings: PanelAgentSettings): string {
  return readStoredSelectedModel() || settings.model;
}

function readStoredModelList(): PanelAgentModel[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PANEL_AGENT_MODEL_LIST_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (model): model is PanelAgentModel =>
          Boolean(model) &&
          typeof model === "object" &&
          typeof (model as PanelAgentModel).id === "string",
      )
      .slice(0, 512);
  } catch {
    return [];
  }
}

function writeStoredModelList(models: PanelAgentModel[]) {
  window.localStorage.setItem(
    PANEL_AGENT_MODEL_LIST_STORAGE_KEY,
    JSON.stringify(models.slice(0, 512)),
  );
}

type PanelAgentStoredConversation = {
  id: string;
  title: string;
  updatedAt: number;
  messages: PanelAgentChatMessage[];
};

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

type PanelAgentUiMessage = PanelAgentChatMessage & {
  id: string;
  error?: string;
};

function createMessageId() {
  return window.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function toApiMessages(
  messages: PanelAgentUiMessage[],
): PanelAgentChatMessage[] {
  return messages.map(({ id: _id, error: _error, ...message }) => message);
}

function toUiMessages(
  messages: PanelAgentChatMessage[],
): PanelAgentUiMessage[] {
  return messages.map((message) => ({ ...message, id: createMessageId() }));
}

function readStoredConversationHistory(): PanelAgentStoredConversation[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(
      PANEL_AGENT_CONVERSATION_HISTORY_STORAGE_KEY,
    );
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is PanelAgentStoredConversation =>
          Boolean(item) &&
          typeof item === "object" &&
          typeof (item as PanelAgentStoredConversation).id === "string" &&
          typeof (item as PanelAgentStoredConversation).title === "string" &&
          typeof (item as PanelAgentStoredConversation).updatedAt ===
            "number" &&
          Array.isArray((item as PanelAgentStoredConversation).messages),
      )
      .slice(0, MAX_STORED_CONVERSATIONS);
  } catch {
    return [];
  }
}

function writeStoredConversationHistory(
  conversations: PanelAgentStoredConversation[],
) {
  window.localStorage.setItem(
    PANEL_AGENT_CONVERSATION_HISTORY_STORAGE_KEY,
    JSON.stringify(conversations.slice(0, MAX_STORED_CONVERSATIONS)),
  );
}

function conversationTitle(messages: PanelAgentUiMessage[]) {
  const userMessage = messages.find((message) => message.role === "user");
  const content = userMessage?.content.trim();
  if (content) return content.slice(0, 64);
  const firstAttachment = userMessage?.attachments?.[0];
  return firstAttachment ? firstAttachment.name.slice(0, 64) : "New chat";
}

function formatAttachmentSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsText(file);
  });
}

async function fileToAttachment(file: File): Promise<PanelAgentChatAttachment> {
  const mimeType = file.type || "application/octet-stream";
  const base = {
    id: createMessageId(),
    name: file.name || "attachment",
    mimeType,
    size: file.size,
  };

  if (mimeType.startsWith("image/")) {
    if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
      throw new Error("image attachment too large");
    }
    return { ...base, kind: "image", dataUrl: await readFileAsDataUrl(file) };
  }

  if (
    mimeType.startsWith("text/") ||
    /\.(md|json|ya?ml|log|csv)$/i.test(file.name)
  ) {
    const text = await readFileAsText(file);
    return {
      ...base,
      kind: "text",
      text: text.slice(0, MAX_TEXT_ATTACHMENT_CHARS),
    };
  }

  return { ...base, kind: "file" };
}

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
  if (role === "user") {
    return "ml-7 rounded-2xl border-accent-brand/30 bg-accent-brand/10 shadow-sm backdrop-blur";
  }
  if (role === "tool") {
    return "rounded-xl border-border/70 bg-muted/35 shadow-sm backdrop-blur";
  }
  return "mr-7 rounded-2xl border-border/70 bg-background/70 shadow-sm backdrop-blur";
}

export function PanelAgentPanel({
  terminalTabs,
  activeTabId,
  embedded = false,
  compact = false,
  conversationAction = null,
}: {
  terminalTabs: Tab[];
  activeTabId: string;
  embedded?: boolean;
  compact?: boolean;
  conversationAction?: PanelAgentConversationAction | null;
}) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<PanelAgentSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [selectedTabIds, setSelectedTabIds] = useState<Set<string>>(new Set());
  const [messages, setMessages] = useState<PanelAgentUiMessage[]>([]);
  const [working, setWorking] = useState(false);
  const [selectedModel, setSelectedModel] = useState(readStoredSelectedModel);
  const [models, setModels] = useState(readStoredModelList);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [thinkingMode, setThinkingMode] = useState(readStoredThinkingMode);
  const [attachments, setAttachments] = useState<PanelAgentChatAttachment[]>(
    [],
  );
  const [historyOpen, setHistoryOpen] = useState(false);
  const [conversationHistory, setConversationHistory] = useState(
    readStoredConversationHistory,
  );
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(
    new Set(),
  );
  const tRef = useRef(t);
  const abortControllerRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastConversationActionRef = useRef<number | null>(null);
  const conversationActionHandlersRef = useRef<
    Record<PanelAgentConversationAction["type"], () => void>
  >({
    clear: () => undefined,
    new: () => undefined,
    history: () => undefined,
  });

  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const activeTerminalTab = useMemo(
    () => terminalTabs.find((tab) => tab.id === activeTabId) ?? terminalTabs[0],
    [activeTabId, terminalTabs],
  );

  useEffect(() => {
    if (activeTerminalTab && selectedTabIds.size === 0) {
      setSelectedTabIds(new Set([activeTerminalTab.id]));
    }
  }, [activeTerminalTab, selectedTabIds.size]);

  const loadSettings = useCallback(async () => {
    setSettingsLoading(true);
    try {
      const loaded = await getPanelAgentSettings();
      setSettings(loaded);
      setSelectedModel((current) =>
        current.trim() ? current : panelModelForSettings(loaded),
      );
      setSelectedSkillIds(
        new Set(
          loaded.skills
            .filter((skill) => skill.enabled)
            .map((skill) => skill.id),
        ),
      );
    } catch {
      toast.error(tRef.current("panelAgent.settingsLoadFailed"));
    } finally {
      setSettingsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const loadModels = useCallback(async () => {
    if (!settings?.baseUrl || !settings.apiKeyConfigured) return;
    setModelsLoading(true);
    try {
      const loaded = await getPanelAgentModels();
      setModels(loaded);
      writeStoredModelList(loaded);
      setSelectedModel((current) => {
        const next =
          current.trim() || settings.model.trim() || loaded[0]?.id || "";
        if (next) writeStoredSelectedModel(next);
        return next;
      });
    } catch {
      toast.error(t("panelAgent.modelsLoadFailed"));
    } finally {
      setModelsLoading(false);
    }
  }, [settings?.apiKeyConfigured, settings?.baseUrl, settings?.model, t]);

  useEffect(() => {
    if (models.length === 0) void loadModels();
  }, [loadModels, models.length]);

  function updateSelectedModel(model: string) {
    setSelectedModel(model);
    writeStoredSelectedModel(model);
  }

  function updateThinkingMode(mode: PanelAgentReasoningEffort) {
    setThinkingMode(mode);
    writeStoredThinkingMode(mode);
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
          recentOutput: handle?.getRecentOutput?.(500) ?? "",
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

  async function continueConversation(
    seedMessages: PanelAgentUiMessage[],
    signal: AbortSignal,
  ) {
    let history = seedMessages;
    for (let round = 0; round < TOOL_ROUND_LIMIT; round += 1) {
      signal.throwIfAborted();
      const response = await sendPanelAgentChat(
        {
          messages: toApiMessages(history),
          skillIds: [...selectedSkillIds],
          targets: selectedTargets(),
          model: selectedModel.trim() || undefined,
          reasoningEffort: thinkingMode,
        },
        signal,
      );
      signal.throwIfAborted();
      const assistantMessage: PanelAgentUiMessage = {
        ...response.message,
        id: createMessageId(),
      };
      history = [...history, assistantMessage];
      setMessages(history);
      if ((assistantMessage.toolCalls?.length ?? 0) === 0) return;

      for (const toolCall of assistantMessage.toolCalls ?? []) {
        signal.throwIfAborted();
        const result = await executeToolCall(toolCall);
        signal.throwIfAborted();
        history = [...history, { ...result, id: createMessageId() }];
        setMessages(history);
      }
    }

    const limitMessage: PanelAgentUiMessage = {
      id: createMessageId(),
      role: "assistant",
      content: t("panelAgent.toolRoundLimit"),
      toolCalls: [],
    };
    setMessages([...history, limitMessage]);
  }

  function chatErrorMessage(error: unknown) {
    const code = (error as { code?: unknown })?.code;
    const name = (error as { name?: unknown })?.name;
    if (
      code === "ERR_CANCELED" ||
      name === "AbortError" ||
      name === "CanceledError"
    ) {
      return t("panelAgent.chatStopped");
    }
    return error instanceof Error ? error.message : t("panelAgent.chatFailed");
  }

  async function startConversation(
    seedMessages: PanelAgentUiMessage[],
    userMessageId: string,
  ) {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setWorking(true);
    setMessages(
      seedMessages.map((message) =>
        message.id === userMessageId
          ? { ...message, error: undefined }
          : message,
      ),
    );
    try {
      await continueConversation(
        seedMessages.map((message) =>
          message.id === userMessageId
            ? { ...message, error: undefined }
            : message,
        ),
        controller.signal,
      );
    } catch (error) {
      const message = chatErrorMessage(error);
      setMessages((prev) =>
        prev.map((item) =>
          item.id === userMessageId ? { ...item, error: message } : item,
        ),
      );
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
        setWorking(false);
      }
    }
  }

  async function handleAttachmentChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    if (files.length === 0) return;
    const remainingSlots = MAX_CHAT_ATTACHMENTS - attachments.length;
    if (remainingSlots <= 0) {
      toast.error(t("panelAgent.attachmentLimit"));
      input.value = "";
      return;
    }
    try {
      const prepared = await Promise.all(
        files.slice(0, remainingSlots).map(fileToAttachment),
      );
      setAttachments((current) => [...current, ...prepared]);
      if (files.length > remainingSlots) {
        toast.error(t("panelAgent.attachmentLimit"));
      }
    } catch {
      toast.error(t("panelAgent.attachmentLoadFailed"));
    } finally {
      input.value = "";
    }
  }

  function removeAttachment(id: string) {
    setAttachments((current) => current.filter((item) => item.id !== id));
  }

  async function handleSend() {
    const content = draft.trim();
    if (!content && attachments.length === 0) {
      toast.error(t("panelAgent.instructionRequired"));
      return;
    }
    const userMessage: PanelAgentUiMessage = {
      id: createMessageId(),
      role: "user",
      content: content || t("panelAgent.attachmentPrompt"),
      attachments: attachments.length > 0 ? attachments : undefined,
    };
    const nextMessages = [...messages, userMessage];
    setDraft("");
    setAttachments([]);
    setHistoryOpen(false);
    setMessages(nextMessages);
    await startConversation(nextMessages, userMessage.id);
  }

  function retryFromMessage(index: number) {
    const message = messages[index];
    if (!message || message.role !== "user") return;
    const nextMessages = messages
      .slice(0, index + 1)
      .map((item) =>
        item.id === message.id ? { ...item, error: undefined } : item,
      );
    setMessages(nextMessages);
    void startConversation(nextMessages, message.id);
  }

  function stopConversation() {
    abortControllerRef.current?.abort();
  }

  function abortConversation() {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setWorking(false);
  }

  function archiveCurrentConversation() {
    if (messages.length === 0) return;
    const record: PanelAgentStoredConversation = {
      id: createMessageId(),
      title: conversationTitle(messages),
      updatedAt: Date.now(),
      messages: toApiMessages(messages),
    };
    setConversationHistory((current) => {
      const next = [record, ...current].slice(0, MAX_STORED_CONVERSATIONS);
      writeStoredConversationHistory(next);
      return next;
    });
  }

  function clearConversation() {
    abortConversation();
    setMessages([]);
    setAttachments([]);
    setHistoryOpen(false);
  }

  function newConversation() {
    abortConversation();
    archiveCurrentConversation();
    setMessages([]);
    setAttachments([]);
    setHistoryOpen(false);
  }

  function toggleHistory() {
    setHistoryOpen((current) => !current);
  }

  function restoreConversation(id: string) {
    const stored = conversationHistory.find((item) => item.id === id);
    if (!stored) return;
    abortConversation();
    setMessages(toUiMessages(stored.messages));
    setAttachments([]);
    setHistoryOpen(false);
  }

  conversationActionHandlersRef.current = {
    clear: clearConversation,
    new: newConversation,
    history: toggleHistory,
  };

  useEffect(() => {
    if (!conversationAction) return;
    if (lastConversationActionRef.current === conversationAction.id) return;
    lastConversationActionRef.current = conversationAction.id;
    conversationActionHandlersRef.current[conversationAction.type]();
  }, [conversationAction]);

  function renderToolMessage(message: PanelAgentChatMessage, index: number) {
    const payload = parseToolResult(message.content);
    return (
      <div
        key={`${message.toolCallId ?? "tool"}-${index}`}
        className="rounded-xl border border-border/70 bg-muted/35 p-2 text-[11px] shadow-sm backdrop-blur"
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
          <pre className="mb-1 overflow-auto rounded-lg bg-black/90 p-2 text-green-200">
            {payload.command}
          </pre>
        )}
        {payload?.error && (
          <p className="mb-1 text-amber-600">{payload.error}</p>
        )}
        {payload?.recentOutput && (
          <pre className="max-h-36 overflow-auto rounded-lg bg-background/65 p-2 text-muted-foreground">
            {payload.recentOutput}
          </pre>
        )}
      </div>
    );
  }

  function renderMessage(message: PanelAgentUiMessage, index: number) {
    if (message.role === "tool") return renderToolMessage(message, index);
    return (
      <div
        key={message.id}
        className={`border p-3 text-xs ${roleClass(message.role)}`}
      >
        <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          {message.role === "user"
            ? t("panelAgent.you")
            : t("panelAgent.agent")}
        </div>
        {message.content && (
          <div className="text-xs leading-5 text-foreground [&_p:last-child]:mb-0 [&_pre]:mb-0">
            <MarkdownRenderer compact content={message.content} />
          </div>
        )}
        {message.attachments && message.attachments.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {message.attachments.map((attachment) => (
              <span
                key={attachment.id}
                className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/70 bg-background/55 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur"
              >
                <Paperclip className="size-3" />
                <span className="truncate">{attachment.name}</span>
              </span>
            ))}
          </div>
        )}
        {message.error && (
          <div className="mt-2 space-y-2 border border-destructive/30 bg-destructive/5 p-2 text-[11px] text-destructive">
            <p className="whitespace-pre-wrap leading-5">{message.error}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-[11px]"
              onClick={() => retryFromMessage(index)}
              disabled={working}
            >
              {t("panelAgent.retry")}
            </Button>
          </div>
        )}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="mt-2 space-y-1">
            {message.toolCalls.map((toolCall) => (
              <div
                key={toolCall.id}
                className="flex items-center gap-2 rounded-lg border border-border/70 bg-background/55 p-2 text-[11px] text-muted-foreground backdrop-blur"
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
  const selectedTerminalTabs = terminalTabs.filter((tab) =>
    selectedTabIds.has(tab.id),
  );
  const selectedTargetSummary = selectedTerminalTabs
    .map((tab) => tab.host?.name ?? tab.label)
    .join(" · ");
  const currentModelLabel =
    selectedModel.trim() || settings?.model || t("panelAgent.model");
  const selectableModels =
    models.length > 0
      ? models
      : currentModelLabel !== t("panelAgent.model")
        ? [{ id: currentModelLabel } satisfies PanelAgentModel]
        : [];
  const hasSelectedModel = Boolean(selectedModel.trim() || settings?.model);
  const adminConfigMissing = Boolean(
    settings &&
    (!settings.enabled || !settings.apiKeyConfigured || !settings.baseUrl),
  );
  const modelMissing = Boolean(
    settings && !adminConfigMissing && !hasSelectedModel,
  );

  const chatDisabled =
    working || adminConfigMissing || modelMissing || !settings;
  function handleDraftKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    if (!chatDisabled) void handleSend();
  }

  function renderModelSelector(isCompact: boolean) {
    return (
      <DropdownMenu
        onOpenChange={(open) => {
          if (open && models.length === 0 && !modelsLoading) void loadModels();
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className={
              isCompact
                ? "min-w-0 flex-1 justify-between rounded-full bg-background/20 px-2 py-1.5 text-[11px] backdrop-blur hover:bg-background/35"
                : "min-w-0 max-w-56 justify-between rounded-full border border-border/60 bg-background/70 px-3 shadow-sm backdrop-blur hover:bg-background"
            }
            aria-label={`${t("panelAgent.model")}: ${currentModelLabel}`}
          >
            <span className="truncate">{currentModelLabel}</span>
            <ChevronDown className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60 rounded-xl">
          <DropdownMenuLabel>{t("panelAgent.model")}</DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              void loadModels();
            }}
            disabled={modelsLoading || !settings?.apiKeyConfigured}
          >
            <RefreshCw
              className={`size-3 ${modelsLoading ? "animate-spin" : ""}`}
            />
            {modelsLoading
              ? t("panelAgent.fetchingModels")
              : t("panelAgent.fetchModels")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {selectableModels.length === 0 ? (
            <DropdownMenuLabel>
              {t("panelAgent.modelSelectPlaceholder")}
            </DropdownMenuLabel>
          ) : (
            <DropdownMenuRadioGroup
              value={selectedModel || settings?.model || ""}
              onValueChange={updateSelectedModel}
            >
              {selectableModels.map((model) => (
                <DropdownMenuRadioItem key={model.id} value={model.id}>
                  <span className="truncate">{model.id}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  function renderThinkingSelector(isCompact: boolean) {
    const label = t(`panelAgent.thinking.${thinkingMode}`);
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className={
              isCompact
                ? "flex shrink-0 items-center gap-1 rounded-full bg-accent-brand/10 px-2 py-1.5 text-[11px] text-accent-brand hover:bg-accent-brand/15"
                : "rounded-full border border-accent-brand/20 bg-accent-brand/10 px-3 text-accent-brand shadow-sm backdrop-blur hover:bg-accent-brand/15"
            }
            aria-label={`${t("panelAgent.thinking.label")}: ${label}`}
          >
            <Zap className="size-3" />
            <span>{label}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40 rounded-xl">
          <DropdownMenuLabel>
            {t("panelAgent.thinking.label")}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={thinkingMode}
            onValueChange={(value) =>
              updateThinkingMode(value as PanelAgentReasoningEffort)
            }
          >
            {PANEL_AGENT_THINKING_MODES.map((mode) => (
              <DropdownMenuRadioItem key={mode} value={mode}>
                {t(`panelAgent.thinking.${mode}`)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <div
      className={`flex min-h-0 flex-col overflow-hidden ${embedded ? `flex-1 ${compact ? "bg-transparent" : "bg-gradient-to-b from-background via-background to-muted/20"}` : "h-full bg-sidebar"}`}
    >
      {!embedded && (
        <div className="shrink-0 border-b border-border p-3">
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
      <div
        className={`flex min-h-0 flex-1 flex-col overflow-hidden ${compact ? "gap-2 px-3 pb-3 pt-2" : "gap-3 bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.08),transparent_34%),radial-gradient(circle_at_bottom_right,rgba(16,185,129,0.08),transparent_30%)] p-3"}`}
      >
        <section
          hidden={compact}
          className="shrink-0 rounded-2xl border border-border/60 bg-card/80 p-3 shadow-sm backdrop-blur"
        >
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
                    className={`flex cursor-pointer items-center gap-2 rounded-xl border border-border/60 bg-background/70 p-2 text-xs shadow-sm transition-colors hover:border-accent-brand/30 hover:bg-background ${disabled ? "opacity-50" : ""}`}
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

        <section
          hidden={compact}
          className="shrink-0 rounded-2xl border border-border/60 bg-card/80 p-3 shadow-sm backdrop-blur"
        >
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
                  className={`rounded-full border px-2.5 py-1 text-[11px] shadow-sm transition-colors ${selectedSkillIds.has(skill.id) ? "border-accent-brand bg-accent-brand/10 text-accent-brand" : "border-border/70 bg-background/55 text-muted-foreground hover:border-accent-brand/30 hover:text-foreground"}`}
                >
                  {skill.name}
                </button>
              ))}
            </div>
          )}
        </section>

        <section
          className={`flex min-h-0 flex-1 flex-col gap-2 ${compact ? "border-0 bg-transparent p-0" : "overflow-hidden rounded-3xl border border-border/60 bg-card/75 p-3 shadow-[0_18px_50px_rgba(15,23,42,0.08)] backdrop-blur-xl"}`}
          style={
            !compact
              ? {
                  backgroundColor: "rgba(255, 255, 255, 0.72)",
                  backdropFilter: "blur(24px) saturate(150%)",
                  WebkitBackdropFilter: "blur(24px) saturate(150%)",
                }
              : undefined
          }
        >
          {!compact && (
            <div
              className="flex shrink-0 items-start justify-between gap-3 rounded-2xl border border-border/60 bg-background/65 p-2.5 shadow-sm backdrop-blur"
              style={{
                backgroundColor: "rgba(255, 255, 255, 0.62)",
                backdropFilter: "blur(18px) saturate(145%)",
                WebkitBackdropFilter: "blur(18px) saturate(145%)",
              }}
            >
              <div className="flex min-w-0 items-start gap-2.5">
                <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-2xl border border-accent-brand/25 bg-accent-brand/10 text-accent-brand shadow-inner">
                  <BrainCircuit className="size-4" />
                </div>
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                    <span className="uppercase tracking-widest text-muted-foreground">
                      {t("panelAgent.chat")}
                    </span>
                    <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600">
                      {t("panelAgent.agent")}
                    </span>
                  </div>
                  <div className="flex max-w-full flex-wrap gap-1.5 text-[10px] text-muted-foreground">
                    <span className="rounded-full bg-muted/55 px-2 py-0.5">
                      {selectedCount} {t("panelAgent.targets")}
                    </span>
                    <span className="max-w-40 truncate rounded-full bg-muted/55 px-2 py-0.5">
                      {selectedTargetSummary || t("panelAgent.targets")}
                    </span>
                    <span className="rounded-full bg-muted/55 px-2 py-0.5">
                      {activeSkills.length} {t("panelAgent.skills")}
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="rounded-full"
                  onClick={toggleHistory}
                >
                  <History className="size-3" />
                  {t("panelAgent.history")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="rounded-full"
                  onClick={newConversation}
                >
                  <MessageSquarePlus className="size-3" />
                  {t("panelAgent.newChat")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="rounded-full"
                  onClick={clearConversation}
                  disabled={messages.length === 0 && !working}
                >
                  <Trash2 className="size-3" />
                  {t("panelAgent.clear")}
                </Button>
              </div>
            </div>
          )}
          <div
            data-testid="panel-agent-message-list"
            className={`min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain pr-1 touch-pan-y [scrollbar-gutter:stable] [-webkit-overflow-scrolling:touch] ${compact ? "rounded-xl" : "rounded-2xl border border-border/40 bg-background/35 p-2"}`}
          >
            {historyOpen && (
              <div
                data-testid="panel-agent-history"
                className="space-y-2 rounded-xl border border-border/60 bg-background/35 p-2 text-xs shadow-sm backdrop-blur"
              >
                <div className="font-semibold text-foreground">
                  {t("panelAgent.history")}
                </div>
                {conversationHistory.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">
                    {t("panelAgent.noHistory")}
                  </p>
                ) : (
                  <div className="space-y-1">
                    {conversationHistory.map((conversation) => (
                      <button
                        key={conversation.id}
                        type="button"
                        className="flex w-full items-center gap-2 rounded-lg border border-border/60 bg-background/35 px-2 py-1.5 text-left text-[11px] hover:bg-background/55"
                        onClick={() => restoreConversation(conversation.id)}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {conversation.title}
                        </span>
                        <time className="shrink-0 text-[10px] text-muted-foreground">
                          {new Date(conversation.updatedAt).toLocaleTimeString(
                            [],
                            { hour: "2-digit", minute: "2-digit" },
                          )}
                        </time>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {messages.length === 0 && !historyOpen ? (
              compact ? (
                <div className="min-h-4" aria-hidden="true" />
              ) : (
                <div className="flex min-h-40 flex-col items-center justify-center rounded-2xl border border-dashed border-border/70 bg-gradient-to-br from-background/80 to-muted/35 p-5 text-center text-xs leading-5 text-muted-foreground">
                  <div className="mb-3 flex size-10 items-center justify-center rounded-2xl border border-accent-brand/20 bg-accent-brand/10 text-accent-brand shadow-inner">
                    <Bot className="size-5" />
                  </div>
                  <p className="font-semibold text-foreground">
                    {t("panelAgent.chatEmpty")}
                  </p>
                  <p className="mt-1 max-w-72">
                    {t("panelAgent.chatPlaceholder")}
                  </p>
                  <div className="mt-3 flex flex-wrap justify-center gap-1.5 text-[10px]">
                    <span className="rounded-full bg-background/70 px-2 py-1">
                      {t("panelAgent.model")}
                    </span>
                    <span className="rounded-full bg-background/70 px-2 py-1">
                      {t("panelAgent.thinking.label")}
                    </span>
                  </div>
                </div>
              )
            ) : (
              messages.map(renderMessage)
            )}
            {working && (
              <div className="flex items-center gap-2 rounded-xl border border-border/70 bg-muted/40 p-2 text-xs text-muted-foreground backdrop-blur">
                <RefreshCw className="size-3.5 animate-spin" />
                {t("panelAgent.working")}
              </div>
            )}
          </div>
          {attachments.length > 0 && (
            <div
              data-testid="panel-agent-attachments"
              className="flex shrink-0 flex-wrap gap-1.5"
            >
              {attachments.map((attachment) => (
                <span
                  key={attachment.id}
                  className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/60 bg-background/35 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur"
                >
                  <Paperclip className="size-3" />
                  <span className="max-w-36 truncate">{attachment.name}</span>
                  <span>{formatAttachmentSize(attachment.size)}</span>
                  <button
                    type="button"
                    className="rounded-full p-0.5 hover:bg-muted"
                    onClick={() => removeAttachment(attachment.id)}
                    aria-label={t("panelAgent.removeAttachment")}
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleDraftKeyDown}
            placeholder={t("panelAgent.chatPlaceholder")}
            rows={compact ? 3 : 4}
            className={`shrink-0 resize-none ${compact ? "min-h-20 rounded-xl border-border/45 bg-background/25 shadow-inner backdrop-blur placeholder:text-muted-foreground" : "min-h-24 rounded-2xl border-border/60 bg-background/70 shadow-inner placeholder:text-muted-foreground"}`}
            style={
              compact
                ? {
                    backgroundColor: "rgba(255, 255, 255, 0.28)",
                    backdropFilter: "blur(18px) saturate(150%)",
                    WebkitBackdropFilter: "blur(18px) saturate(150%)",
                  }
                : {
                    backgroundColor: "rgba(255, 255, 255, 0.7)",
                    backdropFilter: "blur(14px) saturate(140%)",
                    WebkitBackdropFilter: "blur(14px) saturate(140%)",
                  }
            }
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,video/*,audio/*,text/*,.md,.json,.yaml,.yml,.log,.csv"
            className="hidden"
            data-testid="panel-agent-file-input"
            onChange={handleAttachmentChange}
          />
          <div
            data-testid="panel-agent-composer"
            className={
              compact
                ? "flex shrink-0 items-center gap-2 rounded-2xl border border-border/45 bg-background/25 p-2 text-[11px] text-muted-foreground shadow-sm backdrop-blur"
                : "flex shrink-0 items-center gap-2 rounded-2xl border border-border/60 bg-background/70 p-2 text-[11px] text-muted-foreground shadow-sm backdrop-blur"
            }
            style={
              compact
                ? {
                    backgroundColor: "rgba(255, 255, 255, 0.22)",
                    backdropFilter: "blur(22px) saturate(150%)",
                    WebkitBackdropFilter: "blur(22px) saturate(150%)",
                  }
                : {
                    backgroundColor: "rgba(255, 255, 255, 0.58)",
                    backdropFilter: "blur(18px) saturate(145%)",
                    WebkitBackdropFilter: "blur(18px) saturate(145%)",
                  }
            }
          >
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={
                compact
                  ? "size-8 shrink-0 rounded-full bg-background/20"
                  : "size-9 shrink-0 rounded-full bg-background/60"
              }
              onClick={() => fileInputRef.current?.click()}
              aria-label={t("panelAgent.attach")}
            >
              <Plus className="size-4" />
            </Button>
            {renderModelSelector(compact)}
            {renderThinkingSelector(compact)}
            <Button
              type="button"
              size={compact ? "icon" : "default"}
              className={
                compact
                  ? "size-8 shrink-0 rounded-full bg-zinc-950 text-white shadow-sm hover:bg-zinc-900 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
                  : "h-9 flex-1 rounded-full bg-zinc-950 text-white shadow-sm hover:bg-zinc-900 dark:bg-white dark:text-zinc-950 dark:hover:bg-zinc-200"
              }
              onClick={handleSend}
              disabled={chatDisabled}
              aria-label={t("panelAgent.send")}
            >
              <Send className="size-3.5" />
              {!compact && t("panelAgent.send")}
            </Button>
            {working && !compact && (
              <Button
                type="button"
                variant="outline"
                onClick={stopConversation}
              >
                <Square className="size-3.5" />
                {t("panelAgent.stop")}
              </Button>
            )}
          </div>
          {adminConfigMissing && (
            <p className="shrink-0 text-[11px] leading-5 text-amber-600">
              {t("panelAgent.adminConfigRequired")}
            </p>
          )}
          {modelMissing && (
            <p className="shrink-0 text-[11px] leading-5 text-amber-600">
              {t("panelAgent.modelRequired")}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
