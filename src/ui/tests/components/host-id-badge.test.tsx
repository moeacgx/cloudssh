import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HostIdBadge } from "@/components/host-id-badge";
import { formatHostLabel } from "@/lib/host-id";

afterEach(cleanup);

describe("主机 ID 展示", () => {
  it("对数字和字符串形式的已保存主机使用一致标签", () => {
    render(<HostIdBadge hostId={42} />);
    expect(screen.getByText("#42")).toBeTruthy();
    expect(formatHostLabel("测试主机", "42")).toBe("测试主机 · #42");
  });

  it.each([undefined, null, "", 0, -1, "quick-connect-1234", "NaN"])(
    "不把临时或缺失的 ID %s 展示为主机 ID",
    (hostId) => {
      const { container } = render(<HostIdBadge hostId={hostId} />);
      expect(container.childElementCount).toBe(0);
      expect(formatHostLabel("快速连接", hostId)).toBe("快速连接");
    },
  );
});
