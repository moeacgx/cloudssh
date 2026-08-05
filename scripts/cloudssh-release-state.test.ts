import { describe, expect, it } from "vitest";

import { planReleaseState } from "./cloudssh-release-state.mjs";

const revision = "a".repeat(40);
const tag = "release-2.6.0-cloudssh.25-tag";

describe("CloudSSH 发布状态判定", () => {
  it("允许同一提交上的残留标签续跑", () => {
    expect(
      planReleaseState({ tag, revision, remoteTagSha: revision, releases: [] }),
    ).toEqual({ state: "new", draftId: "", resumeTag: true });
  });

  it("复用同一提交上的草稿 Release", () => {
    expect(
      planReleaseState({
        tag,
        revision,
        releases: [
          {
            id: 42,
            tag_name: tag,
            target_commitish: revision,
            draft: true,
            assets: [],
          },
        ],
      }),
    ).toEqual({ state: "draft", draftId: "42", resumeTag: false });
  });

  it("草稿缺少附件时仍允许进入幂等附件修复阶段", () => {
    const plan = planReleaseState({
      tag,
      revision,
      releases: [
        [
          {
            id: 43,
            tag_name: tag,
            target_commitish: revision,
            draft: true,
            assets: [{ name: "cloudssh-release.json" }],
          },
        ],
      ],
    });
    expect(plan.state).toBe("draft");
    expect(plan.draftId).toBe("43");
  });

  it("拒绝覆盖已正式发布的版本", () => {
    expect(() =>
      planReleaseState({
        tag,
        revision,
        releases: [
          {
            id: 44,
            tag_name: tag,
            target_commitish: revision,
            draft: false,
          },
        ],
      }),
    ).toThrow("正式版本不可覆盖");
  });

  it("拒绝复用其他提交的标签或草稿", () => {
    expect(() =>
      planReleaseState({
        tag,
        revision,
        remoteTagSha: "b".repeat(40),
        releases: [],
      }),
    ).toThrow("标签已指向其他提交");

    expect(() =>
      planReleaseState({
        tag,
        revision,
        releases: [
          {
            id: 45,
            tag_name: tag,
            target_commitish: "b".repeat(40),
            draft: true,
          },
        ],
      }),
    ).toThrow("草稿 Release 指向其他提交");
  });
});
