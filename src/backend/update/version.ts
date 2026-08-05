export interface ParsedVersion {
  core: [number, number, number];
  prerelease: string[];
}

const RELEASE_VERSION_PATTERN =
  /(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,95})?)/;

export function versionFromReleaseTag(tag: string): string | null {
  const normalized = tag.trim();
  const conventional = normalized.match(
    new RegExp(`^v?${RELEASE_VERSION_PATTERN.source}$`),
  );
  if (conventional?.[1]) return conventional[1];
  const workflowTag = normalized.match(
    new RegExp(`^release-${RELEASE_VERSION_PATTERN.source}-tag$`),
  );
  return workflowTag?.[1] ?? null;
}

export function parseVersion(
  version: string | undefined,
): ParsedVersion | null {
  const match = String(version || "")
    .trim()
    .match(
      /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
    );
  if (!match) return null;

  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

/**
 * 完整比较 CloudSSH 的语义化版本，包括 cloudssh.16 / cloudssh.17 这类
 * 发布序号。旧实现只比较前三段，会把所有 2.6.0-cloudssh.* 误判为相同。
 */
export function compareVersions(
  leftVersion: string | undefined,
  rightVersion: string | undefined,
): number | null {
  const leftParsed = parseVersion(leftVersion);
  const rightParsed = parseVersion(rightVersion);
  if (!leftParsed || !rightParsed) return null;

  for (let index = 0; index < 3; index += 1) {
    if (leftParsed.core[index] > rightParsed.core[index]) return 1;
    if (leftParsed.core[index] < rightParsed.core[index]) return -1;
  }

  if (
    leftParsed.prerelease.length === 0 &&
    rightParsed.prerelease.length === 0
  ) {
    return 0;
  }
  if (leftParsed.prerelease.length === 0) return 1;
  if (rightParsed.prerelease.length === 0) return -1;

  const length = Math.max(
    leftParsed.prerelease.length,
    rightParsed.prerelease.length,
  );
  for (let index = 0; index < length; index += 1) {
    const left = leftParsed.prerelease[index];
    const right = rightParsed.prerelease[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;

    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      const leftNumber = Number(left);
      const rightNumber = Number(right);
      if (leftNumber > rightNumber) return 1;
      if (leftNumber < rightNumber) return -1;
      continue;
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return left.localeCompare(right) > 0 ? 1 : -1;
  }

  return 0;
}
