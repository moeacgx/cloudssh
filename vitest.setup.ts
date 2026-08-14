import { afterAll, afterEach, vi } from "vitest";

if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

async function collectNativeTestHandles() {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) {
    return;
  }

  for (let i = 0; i < 4; i += 1) {
    gc();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await collectNativeTestHandles();
});

afterAll(collectNativeTestHandles);
