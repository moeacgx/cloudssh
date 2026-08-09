import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const panelAgentApi = vi.hoisted(() => ({
  getPanelAgentSettings: vi.fn(),
  getPanelAgentModels: vi.fn(),
  updatePanelAgentSettings: vi.fn(),
}));
const notifications = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));
const translations = vi.hoisted(() => ({
  t: (key: string) => key,
}));

vi.mock("@/api/panel-agent-api", () => panelAgentApi);
vi.mock("react-i18next", () => ({
  useTranslation: () => translations,
}));
vi.mock("sonner", () => ({ toast: notifications }));

import { AdminPanelAgentSection } from "@/sidebar/AdminPanelAgentSection";

const settings = {
  enabled: false,
  provider: "openai-compatible" as const,
  baseUrl: "",
  model: "",
  temperature: 0.2,
  maxTokens: 1800,
  multiServerEnabled: true,
  maxTargets: 4,
  skills: [],
  apiKeyConfigured: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  panelAgentApi.getPanelAgentSettings.mockResolvedValue(settings);
});

afterEach(() => {
  cleanup();
});

describe("AdminPanelAgentSection", () => {
  it("loads settings only after the section is opened", async () => {
    const { rerender } = render(
      <AdminPanelAgentSection open={false} onToggle={() => undefined} />,
    );

    expect(panelAgentApi.getPanelAgentSettings).not.toHaveBeenCalled();

    rerender(<AdminPanelAgentSection open onToggle={() => undefined} />);

    expect(await screen.findByText("admin.panelAgentEnable")).toBeTruthy();
    expect(panelAgentApi.getPanelAgentSettings).toHaveBeenCalledOnce();
  });

  it("shows a retryable error instead of an empty panel when settings fail", async () => {
    panelAgentApi.getPanelAgentSettings
      .mockRejectedValueOnce(new Error("missing route"))
      .mockResolvedValueOnce(settings);

    render(<AdminPanelAgentSection open onToggle={() => undefined} />);

    expect(await screen.findByText("admin.panelAgentUnavailable")).toBeTruthy();
    expect(notifications.error).toHaveBeenCalledWith(
      "admin.panelAgentLoadFailed",
    );

    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));

    await waitFor(() =>
      expect(panelAgentApi.getPanelAgentSettings).toHaveBeenCalledTimes(2),
    );
    expect(await screen.findByText("admin.panelAgentEnable")).toBeTruthy();
  });
});
