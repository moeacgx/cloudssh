import { describe, expect, it } from "vitest";
import {
  compareVersions,
  parseVersion,
  versionFromReleaseTag,
} from "./version.js";

describe("CloudSSH 版本比较", () => {
  it("正确比较相同基础版本的 CloudSSH 发布序号", () => {
    expect(compareVersions("2.6.0-cloudssh.16", "v2.6.0-cloudssh.17")).toBe(-1);
    expect(compareVersions("2.6.0-cloudssh.18", "2.6.0-cloudssh.17")).toBe(1);
  });

  it("遵循语义化版本的预发布优先级", () => {
    expect(compareVersions("2.6.0-beta.2", "2.6.0-beta.10")).toBe(-1);
    expect(compareVersions("2.6.0", "2.6.0-rc.9")).toBe(1);
  });

  it("忽略 v 前缀和构建元数据", () => {
    expect(compareVersions("v2.6.0+build.1", "2.6.0+build.2")).toBe(0);
  });

  it("拒绝模糊或不完整版本，避免误选镜像", () => {
    expect(parseVersion("release-2.6")).toBeNull();
    expect(compareVersions("unknown", "2.6.0-cloudssh.17")).toBeNull();
  });

  it("识别仓库现有 release-版本-tag 发布标签", () => {
    expect(versionFromReleaseTag("release-2.6.0-cloudssh.17-tag")).toBe(
      "2.6.0-cloudssh.17",
    );
    expect(versionFromReleaseTag("v2.6.0-cloudssh.17")).toBe(
      "2.6.0-cloudssh.17",
    );
    expect(versionFromReleaseTag("release-latest-tag")).toBeNull();
  });
});
