import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getUserInfo: vi.fn(),
  clearStoredAuth: vi.fn(),
}));

vi.mock("react-dom/client", () => ({
  createRoot: () => ({ render: vi.fn() }),
}));
vi.mock("@/lib/client-cache-version", () => ({
  prepareClientCacheVersion: () => Promise.resolve(),
}));
vi.mock("@/lib/electron-wheel-zoom", () => ({
  installElectronWheelZoomGuard: vi.fn(),
}));
vi.mock("@/lib/electron", () => ({ isElectron: () => false }));
vi.mock("@/hooks/use-service-worker", () => ({ useServiceWorker: vi.fn() }));
vi.mock("@/i18n/i18n", () => ({}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/main-axios", () => ({
  getUserInfo: api.getUserInfo,
  getCurrentToken: vi.fn(),
  appReadyPromise: Promise.resolve(),
}));
vi.mock("@/auth/Auth", () => ({
  Auth: ({ onLogin }: { onLogin: (username: string) => void }) => (
    <button onClick={() => onLogin("user")}>Login</button>
  ),
  clearStoredAuth: api.clearStoredAuth,
  getStoredAuth: vi.fn(),
  updateStoredAuthUsername: vi.fn(),
}));
vi.mock("@/features/tmux-monitor/TmuxMonitorApp", () => ({
  default: () => <div>Protected tmux</div>,
}));
vi.mock("@/features/homepage/HomepageApp", () => ({
  default: () => <div>Protected homepage</div>,
}));
vi.mock("@/features/session-sharing/SharedSessionView", () => ({
  default: () => <div>Public shared session</div>,
}));

import { RootApp } from "../../main";

beforeEach(() => {
  vi.clearAllMocks();
  api.getUserInfo.mockReset();
  window.history.replaceState({}, "", "/?view=tmux-monitor");
});
afterEach(cleanup);

describe("全屏入口认证边界", () => {
  it("认证成功之前不挂载应用，成功之后才显示", async () => {
    let resolve!: (value: unknown) => void;
    api.getUserInfo.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render(<RootApp />);
    await waitFor(() => expect(api.getUserInfo).toHaveBeenCalled());
    expect(screen.queryByText("Protected tmux")).toBeNull();
    await act(async () => resolve({ id: "user", username: "user" }));
    expect(await screen.findByText("Protected tmux")).toBeTruthy();
  });

  it.each(["tmux-monitor", "homepage"])(
    "%s 遇到 401 显示登录而非应用外壳",
    async (view) => {
      window.history.replaceState({}, "", `/?view=${view}`);
      api.getUserInfo.mockRejectedValue({ status: 401 });
      render(<RootApp />);
      expect(await screen.findByText("Login")).toBeTruthy();
      expect(screen.queryByText(/^Protected/)).toBeNull();
      expect(api.clearStoredAuth).toHaveBeenCalledOnce();
    },
  );

  it("403 同样阻止应用挂载，登录后重新校验身份", async () => {
    api.getUserInfo.mockRejectedValue({ response: { status: 403 } });
    render(<RootApp />);
    fireEvent.click(await screen.findByText("Login"));
    await waitFor(() => expect(api.getUserInfo).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Protected tmux")).toBeNull();
    expect(await screen.findByText("Login")).toBeTruthy();
  });

  it("登录完成后校验通过才恢复原全屏视图", async () => {
    window.history.replaceState({}, "", "/?view=homepage");
    api.getUserInfo.mockRejectedValueOnce({ status: 401 });
    render(<RootApp />);
    const login = await screen.findByText("Login");
    api.getUserInfo.mockResolvedValue({ id: "user", username: "user" });
    fireEvent.click(login);
    expect(await screen.findByText("Protected homepage")).toBeTruthy();
    expect(window.location.search).toBe("?view=homepage");
  });

  it("已卸载入口的迟到拒绝不能清除登录状态", async () => {
    let reject!: (reason: unknown) => void;
    api.getUserInfo.mockReturnValue(
      new Promise((_, fail) => {
        reject = fail;
      }),
    );
    const page = render(<RootApp />);
    await waitFor(() => expect(api.getUserInfo).toHaveBeenCalled());
    page.unmount();
    await act(async () => reject({ status: 401 }));
    expect(api.clearStoredAuth).not.toHaveBeenCalled();
  });

  it.each([
    new Error("Network Error"),
    { status: 503 },
    { response: { status: 429 } },
  ])("暂态失败保留登录并允许手动重试", async (error) => {
    api.getUserInfo.mockRejectedValue(error);
    render(<RootApp />);
    const retry = await screen.findByRole("button", { name: "common.retry" });
    expect(screen.queryByText(/^Protected/)).toBeNull();
    expect(screen.queryByText("Login")).toBeNull();
    expect(api.clearStoredAuth).not.toHaveBeenCalled();
    api.getUserInfo.mockResolvedValue({ id: "user", username: "user" });
    fireEvent.click(retry);
    expect(await screen.findByText("Protected tmux")).toBeTruthy();
    expect(api.clearStoredAuth).not.toHaveBeenCalled();
  });

  it("共享会话保持公开入口，不请求当前用户", async () => {
    window.history.replaceState({}, "", "/?view=shared&token=public-link");
    render(<RootApp />);
    expect(await screen.findByText("Public shared session")).toBeTruthy();
    expect(api.getUserInfo).not.toHaveBeenCalled();
  });
});
