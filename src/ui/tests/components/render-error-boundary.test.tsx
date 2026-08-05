import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RenderErrorBoundary } from "@/components/render-error-boundary";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RenderErrorBoundary", () => {
  it("contains a render failure and retries only the failed subtree", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let shouldThrow = true;

    function Child() {
      if (shouldThrow) throw new Error("render failed");
      return <div>panel ready</div>;
    }

    render(
      <RenderErrorBoundary
        fallback={(reset) => <button onClick={reset}>retry panel</button>}
      >
        <Child />
      </RenderErrorBoundary>,
    );

    expect(screen.getByRole("button", { name: "retry panel" })).toBeTruthy();
    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: "retry panel" }));
    expect(screen.getByText("panel ready")).toBeTruthy();
  });
});
