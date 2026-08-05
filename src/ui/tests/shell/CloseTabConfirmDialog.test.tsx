import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CloseTabConfirmDialog } from "@/shell/CloseTabConfirmDialog";

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof CloseTabConfirmDialog>> = {},
) {
  const props: React.ComponentProps<typeof CloseTabConfirmDialog> = {
    open: true,
    title: "关闭 风本美国 rs2000？",
    confirmLabel: "关闭",
    cancelLabel: "取消",
    onConfirm: vi.fn(),
    onOpenChange: vi.fn(),
    ...overrides,
  };

  return { ...render(<CloseTabConfirmDialog {...props} />), props };
}

describe("CloseTabConfirmDialog", () => {
  it("在视口中央显示关闭确认", () => {
    renderDialog();

    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("关闭 风本美国 rs2000？");
    expect(dialog.className.split(/\s+/)).toEqual(
      expect.arrayContaining([
        "fixed",
        "top-[50%]",
        "left-[50%]",
        "translate-x-[-50%]",
        "translate-y-[-50%]",
        "max-w-[calc(100%-2rem)]",
      ]),
    );
  });

  it("取消时不执行关闭", () => {
    const { props } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(props.onConfirm).not.toHaveBeenCalled();
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("确认时只执行一次关闭", () => {
    const { props } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    expect(props.onConfirm).toHaveBeenCalledTimes(1);
  });

  it("显示固定窗口的终止说明", () => {
    renderDialog({
      title: "要终止固定窗口 rs2000 吗？",
      description: "这会停止远端 tmux 窗口及其中正在运行的命令。",
      confirmLabel: "终止窗口",
    });

    expect(
      screen.getByText("这会停止远端 tmux 窗口及其中正在运行的命令。"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "终止窗口" })).toBeTruthy();
  });

  it("按 Esc 时取消关闭", () => {
    const { props } = renderDialog();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(props.onConfirm).not.toHaveBeenCalled();
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });
});
