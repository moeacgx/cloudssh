import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_THEME,
  normalizeTerminalDefaultTheme,
  resolveEffectiveTerminalTheme,
} from "../../../features/terminal/terminal-theme";

describe("terminal theme resolution", () => {
  it("normalizes invalid or follow-ui defaults to the independent default", () => {
    expect(normalizeTerminalDefaultTheme(null)).toBe(DEFAULT_TERMINAL_THEME);
    expect(normalizeTerminalDefaultTheme("termix")).toBe(
      DEFAULT_TERMINAL_THEME,
    );
    expect(normalizeTerminalDefaultTheme("missing-theme")).toBe(
      DEFAULT_TERMINAL_THEME,
    );
  });

  it("lets global terminal theme control legacy host defaults", () => {
    expect(resolveEffectiveTerminalTheme("termix", "dracula")).toBe("dracula");
    expect(resolveEffectiveTerminalTheme("termixDark", "dracula")).toBe(
      "dracula",
    );
    expect(resolveEffectiveTerminalTheme("Termix Dark", "dracula")).toBe(
      "dracula",
    );
    expect(resolveEffectiveTerminalTheme("termixLight", "nord")).toBe("nord");
  });

  it("keeps explicit per-host themes ahead of the global default", () => {
    expect(resolveEffectiveTerminalTheme("nord", "dracula")).toBe("nord");
    expect(resolveEffectiveTerminalTheme("custom", "dracula")).toBe("custom");
  });
});
