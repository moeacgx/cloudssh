import { TERMINAL_THEMES } from "@/lib/terminal-themes.ts";
import type { TerminalConfig } from "@/types/index.ts";

export const DEFAULT_TERMINAL_THEME = "termixDark";
export const TERMINAL_DEFAULT_THEME_STORAGE_KEY = "terminalDefaultTheme";
export const TERMINAL_DEFAULT_THEME_CHANGED_EVENT =
  "terminalDefaultThemeChanged";

export function normalizeTerminalDefaultTheme(value?: string | null): string {
  if (value && value !== "termix" && TERMINAL_THEMES[value]) return value;
  return DEFAULT_TERMINAL_THEME;
}

const HOST_DEFAULT_TERMINAL_THEME_VALUES = new Set([
  "termix",
  "termixDark",
  "termixLight",
  "Termix Dark",
  "Termix Light",
]);

function isHostDefaultTerminalTheme(value?: string | null): boolean {
  return !value || HOST_DEFAULT_TERMINAL_THEME_VALUES.has(value);
}

export function readTerminalDefaultTheme(): string {
  if (typeof window === "undefined") return DEFAULT_TERMINAL_THEME;
  return normalizeTerminalDefaultTheme(
    window.localStorage.getItem(TERMINAL_DEFAULT_THEME_STORAGE_KEY),
  );
}

export function resolveEffectiveTerminalTheme(
  hostTheme: string | null | undefined,
  terminalDefaultTheme: string | null | undefined,
): string {
  if (isHostDefaultTerminalTheme(hostTheme)) {
    return normalizeTerminalDefaultTheme(terminalDefaultTheme);
  }
  return hostTheme === "custom" || TERMINAL_THEMES[hostTheme]
    ? hostTheme
    : normalizeTerminalDefaultTheme(terminalDefaultTheme);
}

// Background/foreground per UI theme for "Termix Default" - must match index.css
const TERMIX_DEFAULT_COLORS: Record<
  string,
  { background: string; foreground: string }
> = {
  dark: { background: "#0c0d0b", foreground: "#fafafa" },
  light: { background: "#ffffff", foreground: "#111210" },
  dracula: { background: "#282a36", foreground: "#f8f8f2" },
  catppuccin: { background: "#1e1e2e", foreground: "#cdd6f4" },
  nord: { background: "#2e3440", foreground: "#eceff4" },
  solarized: { background: "#002b36", foreground: "#839496" },
  "tokyo-night": { background: "#1a1b26", foreground: "#a9b1d6" },
  "one-dark": { background: "#282c34", foreground: "#abb2bf" },
  gruvbox: { background: "#282828", foreground: "#ebdbb2" },
};

export function resolveTermixThemeColors(
  activeTheme: string,
  appTheme: string,
  customThemeColors?: TerminalConfig["customThemeColors"],
) {
  if (activeTheme === "custom") {
    if (customThemeColors) {
      return customThemeColors;
    }
    return TERMINAL_THEMES.termixDark.colors;
  }
  if (activeTheme !== "termix") {
    return (
      TERMINAL_THEMES[activeTheme]?.colors || TERMINAL_THEMES.termixDark.colors
    );
  }
  let resolvedUiTheme = appTheme;
  if (appTheme === "system") {
    resolvedUiTheme = window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  const uiColors =
    TERMIX_DEFAULT_COLORS[resolvedUiTheme] ?? TERMIX_DEFAULT_COLORS.dark;
  const base = TERMINAL_THEMES.termixDark.colors;
  return {
    ...base,
    background: uiColors.background,
    foreground: uiColors.foreground,
    cursor: uiColors.foreground,
    cursorAccent: uiColors.background,
  };
}
