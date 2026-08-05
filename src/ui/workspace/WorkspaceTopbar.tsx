import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Command, Plus, Search } from "lucide-react";
import { useWorkspace } from "@/workspace/WorkspaceContext";
import { CreateProjectDialog } from "@/workspace/CreateProjectDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/dropdown-menu";
import { Button } from "@/components/button";

export function WorkspaceTopbar({
  onOpenCommandPalette,
  onNewConnection,
}: {
  onOpenCommandPalette: () => void;
  onNewConnection: () => void;
}) {
  const { t } = useTranslation();
  const { projects, activeProject, setActiveProjectId, refreshProjects } =
    useWorkspace();
  const [createProjectOpen, setCreateProjectOpen] = useState(false);

  return (
    <header className="cloudssh-topbar flex h-11 shrink-0 items-center border-b border-border bg-sidebar px-2 md:px-3">
      <div
        className="hidden md:flex items-center gap-1.5 mr-3"
        aria-hidden="true"
      >
        <span className="size-2.5 rounded-full bg-[#ff5f57]" />
        <span className="size-2.5 rounded-full bg-[#febc2e]" />
        <span className="size-2.5 rounded-full bg-[#28c840]" />
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="h-8 max-w-[220px] justify-between gap-2 px-2 text-xs font-semibold"
          >
            <span className="size-2 rounded-full bg-accent-brand" />
            <span className="truncate">{activeProject.name}</span>
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel className="text-[10px] uppercase text-muted-foreground">
            {t("workspace.projectSpace")}
          </DropdownMenuLabel>
          {projects.map((project) => (
            <DropdownMenuItem
              key={project.id}
              onSelect={() => setActiveProjectId(project.id)}
              className="flex items-center justify-between"
            >
              <span className="truncate">{project.name}</span>
              <span className="text-[10px] text-muted-foreground">
                {t("workspace.hostCount", { count: project.hostIds.length })}
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCreateProjectOpen(true)}>
            <Plus className="size-3.5" />
            {t("workspace.newProject")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="ml-auto flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground"
          onClick={onOpenCommandPalette}
          title={t("workspace.searchAndCommands")}
        >
          <Search className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="hidden size-8 text-muted-foreground md:inline-flex"
          onClick={onOpenCommandPalette}
          title={t("workspace.commandPalette")}
        >
          <Command className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground"
          onClick={onNewConnection}
          title={t("workspace.newConnection")}
        >
          <Plus className="size-4" />
        </Button>
      </div>
      <CreateProjectDialog
        open={createProjectOpen}
        onOpenChange={setCreateProjectOpen}
        onCreated={async (projectId) => {
          await refreshProjects().catch(() => undefined);
          setActiveProjectId(projectId);
        }}
      />
    </header>
  );
}
