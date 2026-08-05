import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

interface CompatibleBraceExpansion {
  (pattern: string, options?: { max?: number }): string[];
  expand(pattern: string, options?: { max?: number }): string[];
  EXPANSION_MAX: number;
}

type LegacyMinimatch = (
  value: string,
  pattern: string,
  options?: Record<string, unknown>,
) => boolean;

interface ModernMinimatch {
  minimatch: LegacyMinimatch;
}

type CompatibleMinimatch = LegacyMinimatch | ModernMinimatch;

const require = createRequire(import.meta.url);
const braceExpand = require("brace-expansion") as CompatibleBraceExpansion;

function loadDependencyMinimatch(packageName: string): CompatibleMinimatch {
  const dependencyRequire = createRequire(require.resolve(packageName));
  return dependencyRequire("minimatch") as CompatibleMinimatch;
}

function matchesBracePattern(api: CompatibleMinimatch): boolean {
  const minimatch = typeof api === "function" ? api : api.minimatch;
  return minimatch("file-b.txt", "file-{a,b}.txt");
}

describe("brace-expansion 安全兼容层", () => {
  it("同时支持旧版函数接口和新版命名接口", () => {
    const expected = ["file-a.txt", "file-b.txt"];

    expect(braceExpand("file-{a,b}.txt")).toEqual(expected);
    expect(braceExpand.expand("file-{a,b}.txt")).toEqual(expected);
  });

  it("限制单次展开结果数量", () => {
    expect(braceExpand("item-{1..100}", { max: 5 })).toHaveLength(5);
    expect(braceExpand.EXPANSION_MAX).toBe(100_000);
  });

  it.each([
    ["minimatch 3", "dir-compare"],
    ["minimatch 5", "filelist"],
    ["minimatch 9", "@electron/universal"],
  ])("兼容 Electron 打包链中的 %s", (_name, packageName) => {
    expect(matchesBracePattern(loadDependencyMinimatch(packageName))).toBe(
      true,
    );
  });

  it("兼容根依赖中的 minimatch 10", () => {
    const minimatch = require("minimatch") as CompatibleMinimatch;
    expect(matchesBracePattern(minimatch)).toBe(true);
  });
});
