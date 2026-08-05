import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Host } from "@/types/ui-types";

const mainAxios = vi.hoisted(() => ({
  getRecentActivity: vi.fn(),
}));

vi.mock("@/main-axios", () => mainAxios);
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { CommandPalette } from "../../shell/CommandPalette";

beforeEach(() => {
  vi.clearAllMocks();
  mainAxios.getRecentActivity.mockResolvedValue([]);
});

afterEach(cleanup);

describe("CommandPalette 滚动布局", () => {
  it("结果列表占据剩余高度并支持鼠标和触摸滚动", async () => {
    const hosts = Array.from({ length: 30 }, (_, index) => ({
      id: index + 1,
      name: `主机 ${index + 1}`,
      ip: `192.0.2.${index + 1}`,
      username: "tester",
    })) as Host[];
    const { container } = render(
      <CommandPalette
        isOpen
        setIsOpen={vi.fn()}
        hosts={hosts}
        onOpenTab={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(mainAxios.getRecentActivity).toHaveBeenCalledWith(5),
    );
    expect(
      screen.getByPlaceholderText("commandPalette.searchPlaceholder"),
    ).toBeTruthy();

    const list = container.querySelector(".touch-pan-y");
    expect(list).not.toBeNull();
    expect(list?.classList.contains("min-h-0")).toBe(true);
    expect(list?.classList.contains("flex-1")).toBe(true);
    expect(list?.classList.contains("overflow-y-auto")).toBe(true);
    expect(list?.classList.contains("overscroll-contain")).toBe(true);

    const shell = list?.parentElement?.parentElement;
    expect(shell?.classList.contains("min-h-0")).toBe(true);
    expect(shell?.className).toContain("h-[min(80vh,720px)]");
  });
});
