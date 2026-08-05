/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import {
  getWorkspaceProjects,
  type WorkspaceProject,
} from "@/api/workspace-api";
import { Button } from "@/components/button";
import { toast } from "sonner";

const LEGACY_PERSONAL_PROJECT_ID = "personal";

function resolveActiveProjectId(
  currentId: string,
  projects: WorkspaceProject[],
): string {
  if (projects.some((project) => project.id === currentId)) return currentId;

  // 旧版本把个人空间保存为哨兵值，升级后迁移为后端返回的真实项目 ID。
  return (
    projects.find((project) => project.kind === "personal")?.id ??
    projects[0]?.id ??
    LEGACY_PERSONAL_PROJECT_ID
  );
}

type WorkspaceContextValue = {
  projects: WorkspaceProject[];
  activeProject: WorkspaceProject;
  loading: boolean;
  setActiveProjectId: (projectId: string) => void;
  refreshProjects: () => Promise<void>;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [activeProjectId, setActiveProjectIdState] = useState(
    () =>
      localStorage.getItem("cloudssh_active_project") ||
      LEGACY_PERSONAL_PROJECT_ID,
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const hasProjects = useRef(false);
  const initialLoadStarted = useRef(false);

  const refreshProjects = useCallback(async () => {
    setLoadError(false);
    try {
      const loaded = await getWorkspaceProjects();
      if (loaded.length === 0) {
        throw new Error("No workspace projects were returned");
      }
      const next = loaded;
      setProjects(next);
      hasProjects.current = true;
      setActiveProjectIdState((current) => {
        const resolved = resolveActiveProjectId(current, next);
        localStorage.setItem("cloudssh_active_project", resolved);
        return resolved;
      });
    } catch (error) {
      console.error("Failed to load workspace projects", error);
      toast.error(t("workspace.projectsLoadFailed"), {
        id: "workspace-projects-load-failed",
      });
      if (!hasProjects.current) setLoadError(true);
      throw error;
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (initialLoadStarted.current) return;
    initialLoadStarted.current = true;
    void refreshProjects().catch(() => undefined);
  }, [refreshProjects]);

  useEffect(() => {
    const onHostsChanged = () => {
      void refreshProjects().catch(() => undefined);
    };
    window.addEventListener("termix:hosts-changed", onHostsChanged);
    window.addEventListener("ssh-hosts:changed", onHostsChanged);
    window.addEventListener("hosts:refresh", onHostsChanged);
    return () => {
      window.removeEventListener("termix:hosts-changed", onHostsChanged);
      window.removeEventListener("ssh-hosts:changed", onHostsChanged);
      window.removeEventListener("hosts:refresh", onHostsChanged);
    };
  }, [refreshProjects]);

  const setActiveProjectId = useCallback((projectId: string) => {
    localStorage.setItem("cloudssh_active_project", projectId);
    setActiveProjectIdState(projectId);
  }, []);

  const activeProject = useMemo(
    () =>
      projects.find((project) => project.id === activeProjectId) ?? projects[0],
    [activeProjectId, projects],
  );

  const value = useMemo(
    () => ({
      projects,
      activeProject,
      loading,
      setActiveProjectId,
      refreshProjects,
    }),
    [projects, activeProject, loading, setActiveProjectId, refreshProjects],
  );

  // 项目身份解析完成前不挂载消费者，避免它们使用旧 personal 哨兵发请求。
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 bg-background text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        <span>{t("workspace.projectsLoading")}</span>
      </div>
    );
  }

  if (loadError || projects.length === 0) {
    return (
      <div
        role="alert"
        className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background px-6 text-center"
      >
        <AlertTriangle className="size-5 text-destructive" aria-hidden="true" />
        <p className="text-sm text-foreground">
          {t("workspace.projectsLoadFailed")}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setLoading(true);
            void refreshProjects().catch(() => undefined);
          }}
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          {t("workspace.retryProjects")}
        </Button>
      </div>
    );
  }

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error("useWorkspace must be used within WorkspaceProvider");
  }
  return context;
}
