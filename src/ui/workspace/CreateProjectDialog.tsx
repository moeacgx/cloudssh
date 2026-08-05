import { FormEvent, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/button";
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
import { Textarea } from "@/components/textarea";
import {
  createWorkspaceProject,
  createWorkspaceTeam,
  getWorkspaceTeams,
  type WorkspaceTeam,
} from "@/api/workspace-api";

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function suggestedSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function CreateProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (projectId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [teams, setTeams] = useState<WorkspaceTeam[]>([]);
  const [teamMode, setTeamMode] = useState<"existing" | "new">("existing");
  const [teamId, setTeamId] = useState("");
  const [teamName, setTeamName] = useState("");
  const [teamSlug, setTeamSlug] = useState("");
  const [projectName, setProjectName] = useState("");
  const [projectSlug, setProjectSlug] = useState("");
  const [description, setDescription] = useState("");
  const [loadingTeams, setLoadingTeams] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoadingTeams(true);
    void getWorkspaceTeams()
      .then((loaded) => {
        setTeams(loaded);
        setTeamId((current) => current || loaded[0]?.id || "");
        if (loaded.length === 0) setTeamMode("new");
      })
      .catch((error) => {
        console.error("Failed to load teams", error);
        toast.error(t("workspace.create.teamsLoadFailed"));
      })
      .finally(() => setLoadingTeams(false));
  }, [open, t]);

  const valid = useMemo(() => {
    const projectValid =
      projectName.trim().length > 0 && SLUG_PATTERN.test(projectSlug);
    if (teamMode === "existing") return projectValid && teamId.length > 0;
    return (
      projectValid && teamName.trim().length > 0 && SLUG_PATTERN.test(teamSlug)
    );
  }, [projectName, projectSlug, teamId, teamMode, teamName, teamSlug]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    try {
      const selectedTeamId =
        teamMode === "new"
          ? (
              await createWorkspaceTeam({
                name: teamName.trim(),
                slug: teamSlug,
              })
            ).id
          : teamId;
      const project = await createWorkspaceProject(selectedTeamId, {
        name: projectName.trim(),
        slug: projectSlug,
        description: description.trim() || undefined,
      });
      await onCreated(project.id);
      toast.success(t("workspace.create.created"));
      onOpenChange(false);
      setProjectName("");
      setProjectSlug("");
      setDescription("");
    } catch (error) {
      console.error("Failed to create project", error);
      toast.error(
        error instanceof Error
          ? error.message
          : t("workspace.create.createFailed"),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={submitting ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("workspace.create.title")}</DialogTitle>
          <DialogDescription>
            {t("workspace.create.description")}
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant={teamMode === "existing" ? "secondary" : "outline"}
              disabled={loadingTeams || teams.length === 0}
              onClick={() => setTeamMode("existing")}
            >
              {t("workspace.create.existingTeam")}
            </Button>
            <Button
              type="button"
              variant={teamMode === "new" ? "secondary" : "outline"}
              onClick={() => setTeamMode("new")}
            >
              {t("workspace.create.newTeam")}
            </Button>
          </div>

          {teamMode === "existing" ? (
            <div className="space-y-1.5">
              <Label htmlFor="workspace-team">
                {t("workspace.create.team")}
              </Label>
              <select
                id="workspace-team"
                value={teamId}
                onChange={(event) => setTeamId(event.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                disabled={loadingTeams}
              >
                {teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="workspace-team-name">
                  {t("workspace.create.teamName")}
                </Label>
                <Input
                  id="workspace-team-name"
                  value={teamName}
                  maxLength={128}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (!teamSlug || teamSlug === suggestedSlug(teamName)) {
                      setTeamSlug(suggestedSlug(value));
                    }
                    setTeamName(value);
                  }}
                  placeholder={t("workspace.create.teamNamePlaceholder")}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="workspace-team-slug">
                  {t("workspace.create.teamSlug")}
                </Label>
                <Input
                  id="workspace-team-slug"
                  value={teamSlug}
                  maxLength={64}
                  pattern={SLUG_PATTERN.source}
                  onChange={(event) =>
                    setTeamSlug(event.target.value.toLowerCase())
                  }
                  placeholder="ops-team"
                />
              </div>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="workspace-project-name">
                {t("workspace.create.projectName")}
              </Label>
              <Input
                id="workspace-project-name"
                value={projectName}
                maxLength={128}
                onChange={(event) => {
                  const value = event.target.value;
                  if (
                    !projectSlug ||
                    projectSlug === suggestedSlug(projectName)
                  ) {
                    setProjectSlug(suggestedSlug(value));
                  }
                  setProjectName(value);
                }}
                placeholder={t("workspace.create.projectNamePlaceholder")}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="workspace-project-slug">
                {t("workspace.create.projectSlug")}
              </Label>
              <Input
                id="workspace-project-slug"
                value={projectSlug}
                maxLength={64}
                pattern={SLUG_PATTERN.source}
                onChange={(event) =>
                  setProjectSlug(event.target.value.toLowerCase())
                }
                placeholder="production"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="workspace-project-description">
              {t("workspace.create.optionalDescription")}
            </Label>
            <Textarea
              id="workspace-project-description"
              value={description}
              maxLength={1000}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t("workspace.create.descriptionPlaceholder")}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!valid || submitting}>
              {submitting
                ? t("workspace.create.creating")
                : t("workspace.create.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
