import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const workspaceApi = vi.hoisted(() => ({
  getWorkspaceProjects: vi.fn(),
}));

vi.mock("@/api/workspace-api", () => workspaceApi);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

import type { WorkspaceProject } from "@/api/workspace-api";
import { WorkspaceProvider, useWorkspace } from "@/workspace/WorkspaceContext";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function ActiveProjectProbe({
  onProject,
}: {
  onProject: (id: string) => void;
}) {
  const { activeProject } = useWorkspace();

  useEffect(() => {
    onProject(activeProject.id);
  }, [activeProject.id, onProject]);

  return <div>{activeProject.id}</div>;
}

describe("WorkspaceProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("waits for the real personal project id and migrates the legacy sentinel", async () => {
    const projects = deferred<WorkspaceProject[]>();
    const onProject = vi.fn();
    localStorage.setItem("cloudssh_active_project", "personal");
    workspaceApi.getWorkspaceProjects.mockReturnValue(projects.promise);

    render(
      <WorkspaceProvider>
        <ActiveProjectProbe onProject={onProject} />
      </WorkspaceProvider>,
    );

    expect(screen.queryByText("personal")).toBeNull();
    expect(onProject).not.toHaveBeenCalled();

    await act(async () => {
      projects.resolve([
        {
          id: "team-project-id",
          name: "Team",
          slug: "team",
          description: null,
          kind: "team",
          teamId: "team-id",
          role: "project_admin",
          hostIds: [],
          memberCount: 1,
        },
        {
          id: "personal-project-uuid",
          name: "Personal",
          slug: "personal",
          description: null,
          kind: "personal",
          teamId: null,
          role: "instance_admin",
          hostIds: [],
          memberCount: 1,
        },
      ]);
      await projects.promise;
    });

    expect((await screen.findByText("personal-project-uuid")).textContent).toBe(
      "personal-project-uuid",
    );
    expect(onProject).toHaveBeenCalledOnce();
    expect(onProject).toHaveBeenCalledWith("personal-project-uuid");
    expect(localStorage.getItem("cloudssh_active_project")).toBe(
      "personal-project-uuid",
    );
  });

  it("shows a retry state instead of mounting consumers with a sentinel", async () => {
    const onProject = vi.fn();
    workspaceApi.getWorkspaceProjects
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce([
        {
          id: "personal-project-uuid",
          name: "Personal",
          slug: "personal",
          description: null,
          kind: "personal",
          teamId: null,
          role: "instance_admin",
          hostIds: [],
          memberCount: 1,
        },
      ]);

    render(
      <WorkspaceProvider>
        <ActiveProjectProbe onProject={onProject} />
      </WorkspaceProvider>,
    );

    expect(
      await screen.findByText("workspace.projectsLoadFailed"),
    ).toBeTruthy();
    expect(onProject).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "workspace.retryProjects" }),
    );
    expect(await screen.findByText("personal-project-uuid")).toBeTruthy();
    expect(onProject).toHaveBeenCalledWith("personal-project-uuid");
  });
});
