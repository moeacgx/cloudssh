import { mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  githubReleaseHeaders,
  resolveGitHubReleaseToken,
} from "./github-auth.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("GitHub 私有 Release 鉴权", () => {
  it("优先读取 Docker Secret，并且只放入请求头", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "cloudssh-github-"));
    temporaryDirectories.push(directory);
    const tokenFile = path.join(directory, "token");
    const fileToken = `github_pat_${"a".repeat(32)}`;
    writeFileSync(tokenFile, `${fileToken}\n`, { mode: 0o600 });

    const environment = {
      CLOUDSSH_GITHUB_TOKEN_FILE: tokenFile,
      CLOUDSSH_GITHUB_TOKEN: `github_pat_${"b".repeat(32)}`,
    };
    expect(resolveGitHubReleaseToken(environment)).toBe(fileToken);
    expect(githubReleaseHeaders(environment)).toMatchObject({
      Authorization: `Bearer ${fileToken}`,
      Accept: "application/vnd.github+json",
    });
  });

  it("无 Token 时仍可查询公开仓库", () => {
    const headers = githubReleaseHeaders({
      CLOUDSSH_GITHUB_TOKEN_FILE: "Z:/missing/cloudssh-token",
    });
    expect(headers).not.toHaveProperty("Authorization");
  });

  it("拒绝空白字符和异常长度的 Token", () => {
    expect(
      resolveGitHubReleaseToken({ CLOUDSSH_GITHUB_TOKEN: "token with space" }),
    ).toBeUndefined();
    expect(
      resolveGitHubReleaseToken({ CLOUDSSH_GITHUB_TOKEN: "short" }),
    ).toBeUndefined();
  });
});
