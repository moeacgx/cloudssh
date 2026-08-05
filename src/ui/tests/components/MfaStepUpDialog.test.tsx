import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mfaApi = vi.hoisted(() => ({
  stepUpWithTotp: vi.fn(),
}));
const webauthnApi = vi.hoisted(() => ({
  stepUpWithWebAuthn: vi.fn(),
  getWebAuthnErrorTranslationKey: vi.fn(() => null),
}));
const notifications = vi.hoisted(() => ({
  error: vi.fn(),
}));

vi.mock("@/api/mfa-api", () => mfaApi);
vi.mock("@/api/webauthn-api", () => webauthnApi);
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({ toast: notifications }));

import { MfaStepUpDialog } from "@/components/MfaStepUpDialog";

beforeEach(() => {
  vi.clearAllMocks();
  mfaApi.stepUpWithTotp.mockResolvedValue({ success: true, method: "totp" });
  webauthnApi.stepUpWithWebAuthn.mockResolvedValue({
    success: true,
    method: "webauthn",
  });
});

afterEach(cleanup);

describe("MfaStepUpDialog", () => {
  it("明确显示 TOTP 身份验证器和通行密钥，而不是只显示 MFA", () => {
    render(
      <MfaStepUpDialog
        open
        methods={["totp", "webauthn"]}
        onVerified={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("auth.stepUpDescription")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "auth.useTotpAuthenticator" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "auth.usePasskey" }),
    ).toBeTruthy();
  });

  it("TOTP 验证成功后继续待执行操作", async () => {
    const onVerified = vi.fn();
    render(
      <MfaStepUpDialog
        open
        methods={["totp"]}
        onVerified={onVerified}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("auth.totpAuthenticatorLabel"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "auth.verifyCode" }));

    await waitFor(() =>
      expect(mfaApi.stepUpWithTotp).toHaveBeenCalledWith("123456"),
    );
    expect(onVerified).toHaveBeenCalledTimes(1);
  });

  it("通行密钥验证成功后继续待执行操作", async () => {
    const onVerified = vi.fn();
    render(
      <MfaStepUpDialog
        open
        methods={["webauthn"]}
        onVerified={onVerified}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "auth.verifyWithPasskey" }),
    );

    await waitFor(() =>
      expect(webauthnApi.stepUpWithWebAuthn).toHaveBeenCalledTimes(1),
    );
    expect(onVerified).toHaveBeenCalledTimes(1);
  });
});
