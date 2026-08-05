import fs from "fs";

type Environment = Record<string, string | undefined>;

function normalizeToken(value: string | undefined): string | undefined {
  const token = value?.trim();
  if (!token || token.length < 20 || token.length > 4096 || /\s/.test(token)) {
    return undefined;
  }
  return token;
}

function readTokenFile(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  try {
    return normalizeToken(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * 私有 Fork 的 Release 查询使用只读 GitHub Token。优先读取 Docker
 * Secret，环境变量仅用于本地开发；Token 永远不会进入 URL 或日志。
 */
export function resolveGitHubReleaseToken(
  environment: Environment = process.env,
): string | undefined {
  const configuredFile = environment.CLOUDSSH_GITHUB_TOKEN_FILE;
  const fromConfiguredFile = readTokenFile(configuredFile);
  if (fromConfiguredFile) return fromConfiguredFile;

  if (!configuredFile) {
    const fromDefaultSecret = readTokenFile(
      "/run/secrets/cloudssh_github_token",
    );
    if (fromDefaultSecret) return fromDefaultSecret;
  }

  return normalizeToken(environment.CLOUDSSH_GITHUB_TOKEN);
}

export function githubReleaseHeaders(
  environment: Environment = process.env,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "CloudSSH-UpdateChecker/1",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = resolveGitHubReleaseToken(environment);
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}
