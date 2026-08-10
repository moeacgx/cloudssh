import { useEffect, useState } from "react";
import { Bot, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { Input } from "@/components/input";
import { Textarea } from "@/components/textarea";
import {
  getPanelAgentModels,
  getPanelAgentSettings,
  updatePanelAgentSettings,
  type PanelAgentModel,
  type PanelAgentSettings,
  type PanelAgentSkill,
} from "@/api/panel-agent-api";
import { AccordionSection, AdminToggle } from "./AdminSettingsShared";

export function AdminPanelAgentSection({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<PanelAgentSettings | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempted, setLoadAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [models, setModels] = useState<PanelAgentModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  async function load() {
    setLoading(true);
    setLoadAttempted(true);
    setLoadError(false);
    try {
      const loaded = await getPanelAgentSettings();
      if (!loaded) throw new Error("Panel Agent settings response is empty");
      setSettings(loaded);
    } catch {
      setSettings(null);
      setLoadError(true);
      toast.error(t("admin.panelAgentLoadFailed"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open || settings || loading) return;
    void load();
  }, [open]);

  function update(partial: Partial<PanelAgentSettings>) {
    setSettings((prev) => (prev ? { ...prev, ...partial } : prev));
  }

  function updateSkill(index: number, partial: Partial<PanelAgentSkill>) {
    setSettings((prev) => {
      if (!prev) return prev;
      const skills = prev.skills.map((skill, skillIndex) =>
        skillIndex === index ? { ...skill, ...partial } : skill,
      );
      return { ...prev, skills };
    });
  }

  async function loadModels() {
    if (!settings) return;
    setModelsLoading(true);
    try {
      const loaded = await getPanelAgentModels({
        baseUrl: settings.baseUrl,
        apiKey: apiKeyDraft.trim() || undefined,
      });
      setModels(loaded);
      if (!settings.model && loaded[0]) update({ model: loaded[0].id });
      toast.success(
        t("admin.panelAgentModelsLoaded", { count: loaded.length }),
      );
    } catch {
      toast.error(t("admin.panelAgentModelsLoadFailed"));
    } finally {
      setModelsLoading(false);
    }
  }

  async function save(nextSettings = settings, apiKey = apiKeyDraft) {
    if (!nextSettings) return;
    setSaving(true);
    try {
      const saved = await updatePanelAgentSettings({
        ...nextSettings,
        apiKey: apiKey.trim() ? apiKey.trim() : undefined,
      });
      setSettings(saved);
      setApiKeyDraft("");
      toast.success(t("admin.panelAgentSaved"));
    } catch {
      toast.error(t("admin.panelAgentSaveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function clearApiKey() {
    if (!settings) return;
    setSaving(true);
    try {
      const saved = await updatePanelAgentSettings({ ...settings, apiKey: "" });
      setSettings(saved);
      setApiKeyDraft("");
      toast.success(t("admin.panelAgentKeyCleared"));
    } catch {
      toast.error(t("admin.panelAgentSaveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <AccordionSection
      label={t("admin.sectionPanelAgent")}
      icon={<Bot className="size-4" />}
      open={open}
      onToggle={onToggle}
      scrollIntoViewOnOpen
    >
      <div className="space-y-3 pt-3">
        {loading && (
          <div className="text-xs text-muted-foreground">
            {t("common.loading")}
          </div>
        )}
        {!loading && !settings && (loadError || loadAttempted) && (
          <div className="space-y-2 border border-amber-500/40 bg-amber-500/5 p-3">
            <div className="text-xs font-semibold text-foreground">
              {t("admin.panelAgentUnavailable")}
            </div>
            <div className="text-[11px] leading-5 text-muted-foreground">
              {t("admin.panelAgentUnavailableDesc")}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void load()}
            >
              <RefreshCw className="size-3" />
              {t("common.retry")}
            </Button>
          </div>
        )}
        {settings && (
          <>
            <div className="flex items-start justify-between gap-3 border border-border bg-background p-3">
              <div>
                <div className="text-xs font-semibold text-foreground">
                  {t("admin.panelAgentEnable")}
                </div>
                <div className="mt-1 text-[11px] leading-5 text-muted-foreground">
                  {t("admin.panelAgentEnableDesc")}
                </div>
              </div>
              <AdminToggle
                on={settings.enabled}
                onToggle={() => update({ enabled: !settings.enabled })}
              />
            </div>

            <div className="grid gap-2">
              <label className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                {t("admin.panelAgentBaseUrl")}
              </label>
              <Input
                value={settings.baseUrl}
                onChange={(event) => update({ baseUrl: event.target.value })}
                placeholder="https://api.openai.com/v1"
              />
              <div className="flex items-center justify-between gap-2">
                <label className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                  {t("admin.panelAgentModel")}
                </label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={loadModels}
                  disabled={modelsLoading || !settings.baseUrl}
                >
                  <RefreshCw
                    className={`size-3 ${modelsLoading ? "animate-spin" : ""}`}
                  />
                  {modelsLoading
                    ? t("admin.panelAgentFetchingModels")
                    : t("admin.panelAgentFetchModels")}
                </Button>
              </div>
              <Input
                value={settings.model}
                onChange={(event) => update({ model: event.target.value })}
                placeholder="gpt-4.1-mini"
              />
              {models.length > 0 && (
                <select
                  className="flex h-9 w-full border border-border bg-background px-3 py-1 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
                  value={
                    models.some((model) => model.id === settings.model)
                      ? settings.model
                      : ""
                  }
                  onChange={(event) => update({ model: event.target.value })}
                >
                  <option value="">
                    {t("admin.panelAgentModelSelectPlaceholder")}
                  </option>
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.id}
                    </option>
                  ))}
                </select>
              )}
              <label className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                {t("admin.panelAgentApiKey")}
              </label>
              <div className="flex gap-2">
                <Input
                  type="password"
                  value={apiKeyDraft}
                  onChange={(event) => setApiKeyDraft(event.target.value)}
                  placeholder={
                    settings.apiKeyConfigured
                      ? t("admin.panelAgentApiKeyConfigured")
                      : t("admin.panelAgentApiKeyPlaceholder")
                  }
                />
                {settings.apiKeyConfigured && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={clearApiKey}
                    disabled={saving}
                  >
                    {t("admin.panelAgentClearKey")}
                  </Button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <label className="grid gap-1 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                {t("admin.panelAgentTemperature")}
                <Input
                  type="number"
                  min="0"
                  max="2"
                  step="0.1"
                  value={settings.temperature}
                  onChange={(event) =>
                    update({ temperature: Number(event.target.value) })
                  }
                />
              </label>
              <label className="grid gap-1 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                {t("admin.panelAgentMaxTokens")}
                <Input
                  type="number"
                  min="256"
                  max="8000"
                  value={settings.maxTokens}
                  onChange={(event) =>
                    update({ maxTokens: Number(event.target.value) })
                  }
                />
              </label>
            </div>

            <div className="flex items-center justify-between gap-3 border border-border bg-background p-3">
              <div>
                <div className="text-xs font-semibold text-foreground">
                  {t("admin.panelAgentMultiServer")}
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {t("admin.panelAgentMultiServerDesc")}
                </div>
              </div>
              <AdminToggle
                on={settings.multiServerEnabled}
                onToggle={() =>
                  update({ multiServerEnabled: !settings.multiServerEnabled })
                }
              />
            </div>

            <label className="grid gap-1 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
              {t("admin.panelAgentMaxTargets")}
              <Input
                type="number"
                min="1"
                max="16"
                value={settings.maxTargets}
                onChange={(event) =>
                  update({ maxTargets: Number(event.target.value) })
                }
              />
            </label>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-xs font-semibold text-foreground">
                    {t("admin.panelAgentSkills")}
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {t("admin.panelAgentSkillsDesc")}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    update({
                      skills: [
                        ...settings.skills,
                        {
                          id: `skill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
                          name: "",
                          description: "",
                          content: "",
                          enabled: true,
                        },
                      ],
                    })
                  }
                >
                  <Plus className="size-3" />
                  {t("admin.panelAgentAddSkill")}
                </Button>
              </div>

              {settings.skills.map((skill, index) => (
                <div
                  key={skill.id}
                  className="border border-border bg-background p-2 space-y-2"
                >
                  <div className="flex items-center gap-2">
                    <AdminToggle
                      on={skill.enabled}
                      onToggle={() =>
                        updateSkill(index, { enabled: !skill.enabled })
                      }
                    />
                    <Input
                      value={skill.name}
                      onChange={(event) =>
                        updateSkill(index, { name: event.target.value })
                      }
                      placeholder={t("admin.panelAgentSkillName")}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() =>
                        update({
                          skills: settings.skills.filter(
                            (_, skillIndex) => skillIndex !== index,
                          ),
                        })
                      }
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                  <Input
                    value={skill.description ?? ""}
                    onChange={(event) =>
                      updateSkill(index, { description: event.target.value })
                    }
                    placeholder={t("admin.panelAgentSkillDescription")}
                  />
                  <Textarea
                    value={skill.content}
                    onChange={(event) =>
                      updateSkill(index, { content: event.target.value })
                    }
                    placeholder={t("admin.panelAgentSkillContent")}
                    rows={4}
                  />
                </div>
              ))}
            </div>

            <Button
              type="button"
              onClick={() => save()}
              disabled={saving}
              className="w-full"
            >
              <Save className="size-3.5" />
              {saving ? t("common.saving") : t("admin.panelAgentSave")}
            </Button>
          </>
        )}
      </div>
    </AccordionSection>
  );
}
