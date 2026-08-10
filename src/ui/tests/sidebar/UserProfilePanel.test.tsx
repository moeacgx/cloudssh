import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
  TERMINAL_DEFAULT_THEME_CHANGED_EVENT,
  TERMINAL_DEFAULT_THEME_STORAGE_KEY,
} from "@/features/terminal/terminal-theme";

const mainAxios = vi.hoisted(() => ({
  getUserInfo: vi.fn(),
  updateUsername: vi.fn(),
  getApiKeys: vi.fn(),
  createApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
  changePassword: vi.fn(),
  deleteAccount: vi.fn(),
  logoutUser: vi.fn(),
  setupTOTP: vi.fn(),
  enableTOTP: vi.fn(),
  disableTOTP: vi.fn(),
  getVersionInfo: vi.fn(),
  getUserRoles: vi.fn(),
  saveUserPreferences: vi.fn(),
  getUserPreferences: vi.fn(),
}));
const webauthnApi = vi.hoisted(() => ({
  listWebAuthnCredentials: vi.fn(),
  registerWebAuthnCredential: vi.fn(),
  deleteWebAuthnCredential: vi.fn(),
  getWebAuthnErrorTranslationKey: vi.fn(() => "webauthn.error"),
}));
const mfaApi = vi.hoisted(() => ({
  getMfaStepUpMethods: vi.fn(),
}));
const notifications = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));
const translations = vi.hoisted(() => ({
  t: (key: string) => key,
}));

vi.mock("@/main-axios", () => ({
  ...mainAxios,
}));
vi.mock("@/api/webauthn-api", () => webauthnApi);
vi.mock("@/api/mfa-api", () => mfaApi);
vi.mock("@/lib/electron", () => ({
  isElectron: () => false,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => translations,
}));
vi.mock("sonner", () => ({ toast: notifications }));
vi.mock("@/i18n/i18n", () => ({
  changeAppLanguage: vi.fn(async (language: string) => language),
  normalizeLanguageCode: vi.fn((language?: string | null) => language ?? "en"),
}));
vi.mock("@/settings/RemoteSyncPanel.tsx", () => ({
  RemoteSyncPanel: () => null,
}));
vi.mock("@/user/C2STunnelPresetManager", () => ({
  C2STunnelPresetManager: () => null,
}));
vi.mock("@/sidebar/KeybindingsDialog", () => ({
  KeybindingsDialog: () => null,
}));
vi.mock("@/components/MfaStepUpDialog", () => ({
  MfaStepUpDialog: () => null,
}));
vi.mock("@/components/section-card", () => ({
  SettingRow: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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
}));
vi.mock("@/components/input", () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />,
}));
vi.mock("@/components/button", () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    asChild: _asChild,
    ...props
  }: Record<string, unknown> & {
    children?: ReactNode;
  }) => <button {...props}>{children}</button>,
}));
vi.mock("@/components/dialog", () => ({
  Dialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogFooter: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
}));

import { UserProfilePanel } from "@/sidebar/UserProfilePanel";

function mockResolvedData() {
  mainAxios.getUserInfo.mockResolvedValue({
    userId: "user-1",
    username: "demo",
    totp_enabled: false,
    is_oidc: false,
    is_dual_auth: false,
    is_admin: false,
  });
  mainAxios.getApiKeys.mockResolvedValue({ apiKeys: [] });
  mainAxios.getVersionInfo.mockResolvedValue({
    localVersion: "1.0.0",
    status: "up_to_date",
  });
  mainAxios.getUserRoles.mockResolvedValue({ roles: [] });
  webauthnApi.listWebAuthnCredentials.mockResolvedValue({ credentials: [] });
  mfaApi.getMfaStepUpMethods.mockResolvedValue({ methods: [] });
}

function findTerminalThemeSelect(): HTMLSelectElement {
  const select = screen
    .getAllByRole("combobox")
    .find((element) =>
      Array.from((element as HTMLSelectElement).options).some(
        (option) => option.value === "termixDark",
      ),
    ) as HTMLSelectElement | undefined;
  if (!select) {
    throw new Error("terminal theme select not found");
  }
  return select;
}

describe("UserProfilePanel terminal theme", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockResolvedData();
  });

  afterEach(() => {
    cleanup();
  });

  it("updates the terminal default theme without throwing", async () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");

    render(<UserProfilePanel />);

    await screen.findByText("newUi.sidebar.userProfile.sectionAppearance");
    fireEvent.click(
      screen.getByRole("button", {
        name: "newUi.sidebar.userProfile.sectionAppearance",
      }),
    );

    const terminalThemeSelect = findTerminalThemeSelect();
    expect(terminalThemeSelect.value).toBe("termixDark");

    fireEvent.change(terminalThemeSelect, { target: { value: "termixLight" } });

    await waitFor(() => expect(terminalThemeSelect.value).toBe("termixLight"));
    expect(localStorage.getItem(TERMINAL_DEFAULT_THEME_STORAGE_KEY)).toBe(
      "termixLight",
    );
    expect(
      dispatchSpy.mock.calls.some(
        ([event]) =>
          event instanceof Event &&
          event.type === TERMINAL_DEFAULT_THEME_CHANGED_EVENT,
      ),
    ).toBe(true);
  });
});
