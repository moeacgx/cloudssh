import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createHostEditorForm,
  type HostEditorForm,
} from "../../sidebar/HostEditorData";
import { HostEditorGeneralTab } from "../../sidebar/HostEditorGeneralTab";

const workspaceApi = vi.hoisted(() => ({
  getWorkspaceProjectFolders: vi.fn(),
  getAdminUserPersonalProjectFolders: vi.fn(),
}));

vi.mock("@/api/workspace-api", () => workspaceApi);
vi.mock("@/main-axios", () => ({
  isElectron: vi.fn(() => false),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/components/button", () => ({
  Button: (props: Record<string, unknown>) => <button {...props} />,
}));
vi.mock("@/components/input", () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />,
}));
vi.mock("@/components/password-input", () => ({
  PasswordInput: (props: Record<string, unknown>) => (
    <input type="password" {...props} />
  ),
}));
vi.mock("@/components/section-card", () => ({
  FakeSwitch: ({
    checked,
    onChange,
  }: {
    checked: boolean;
    onChange: (value: boolean) => void;
  }) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(event) => onChange(event.currentTarget.checked)}
    />
  ),
  SectionCard: ({ children }: { children: unknown }) => (
    <section>{children}</section>
  ),
  SettingRow: ({ children }: { children: unknown }) => <div>{children}</div>,
}));
vi.mock("../../sidebar/FolderPathPicker", () => ({
  FolderPathPicker: ({
    value,
    onChange,
    folderPaths,
  }: {
    value: string;
    onChange: (path: string) => void;
    folderPaths: string[];
  }) => (
    <select
      aria-label="folder-path-picker"
      data-folder-paths={JSON.stringify(folderPaths)}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">hosts.noFolder</option>
      {folderPaths.map((path) => (
        <option key={path} value={path}>
          {path}
        </option>
      ))}
    </select>
  ),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function renderTab(
  options: { projectId?: string; adminTargetUserId?: string } = {},
) {
  const form = createHostEditorForm(null) as HostEditorForm;
  const setField = vi.fn() as unknown as <K extends keyof HostEditorForm>(
    key: K,
    value: HostEditorForm[K],
  ) => void;

  return render(
    <HostEditorGeneralTab
      form={form}
      setField={setField}
      protocols={{
        enableSsh: false,
        enableRdp: false,
        enableVnc: false,
        enableTelnet: false,
      }}
      handleProtocolToggle={vi.fn()}
      hosts={[]}
      host={null}
      {...options}
    />,
  );
}

describe("主机编辑器的项目文件夹", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceApi.getWorkspaceProjectFolders.mockResolvedValue([]);
    workspaceApi.getAdminUserPersonalProjectFolders.mockResolvedValue([]);
  });

  it("把当前项目的空文件夹传给选择器并允许选择", async () => {
    workspaceApi.getWorkspaceProjectFolders.mockResolvedValue([
      { path: "空目录", color: null, icon: null },
    ]);

    renderTab({ projectId: "project-1" });

    await waitFor(() =>
      expect(workspaceApi.getWorkspaceProjectFolders).toHaveBeenCalledWith(
        "project-1",
      ),
    );
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "空目录" })).toBeTruthy();
      expect(
        JSON.parse(
          screen
            .getByLabelText("folder-path-picker")
            .getAttribute("data-folder-paths") || "[]",
        ),
      ).toContain("空目录");
    });
  });

  it("切换项目后重新请求，并清除旧项目文件夹", async () => {
    const first = deferred<{ path: string; color: null; icon: null }[]>();
    const second = deferred<{ path: string; color: null; icon: null }[]>();
    workspaceApi.getWorkspaceProjectFolders.mockImplementation(
      (projectId: string) =>
        projectId === "project-1" ? first.promise : second.promise,
    );

    const view = renderTab({ projectId: "project-1" });
    first.resolve([{ path: "旧项目", color: null, icon: null }]);
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "旧项目" })).toBeTruthy(),
    );

    view.rerender(
      <HostEditorGeneralTab
        form={createHostEditorForm(null) as HostEditorForm}
        setField={vi.fn() as never}
        protocols={{
          enableSsh: false,
          enableRdp: false,
          enableVnc: false,
          enableTelnet: false,
        }}
        handleProtocolToggle={vi.fn()}
        hosts={[]}
        host={null}
        projectId="project-2"
      />,
    );

    await waitFor(() =>
      expect(workspaceApi.getWorkspaceProjectFolders).toHaveBeenLastCalledWith(
        "project-2",
      ),
    );
    expect(screen.queryByRole("option", { name: "旧项目" })).toBeNull();

    second.resolve([{ path: "新项目", color: null, icon: null }]);
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "新项目" })).toBeTruthy(),
    );
  });

  it("管理员代管用户个人空间时读取目标用户的项目文件夹", async () => {
    workspaceApi.getAdminUserPersonalProjectFolders.mockResolvedValue([
      { path: "用户目录", color: null, icon: null },
    ]);

    renderTab({ adminTargetUserId: "user/with slash" });

    await waitFor(() =>
      expect(
        workspaceApi.getAdminUserPersonalProjectFolders,
      ).toHaveBeenCalledWith("user/with slash"),
    );
    expect(workspaceApi.getWorkspaceProjectFolders).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "用户目录" })).toBeTruthy(),
    );
  });
});
