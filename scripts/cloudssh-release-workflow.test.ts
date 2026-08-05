import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("CloudSSH 正式发版工作流", () => {
  it("只发布本仓库 GHCR，并生成固定摘要 Release 清单", async () => {
    const workflow = await readFile(
      ".github/workflows/cloudssh-release.yml",
      "utf8",
    );
    expect(workflow).toContain("packages: write");
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("packages: read");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain(
      "ghcr.io/${{ github.repository_owner }}/cloudssh",
    );
    expect(workflow).toContain("cloudssh-release-manifest.mjs");
    expect(workflow).toContain("cloudssh-release.json");
    expect(workflow).toContain("${{ steps.cloudssh.outputs.digest }}");
    expect(workflow).toContain("cloudssh-runtime-manifest.mjs");
    expect(workflow).toContain(
      "cloudssh-runtime-$VERSION-linux-$runtime_arch.tar.gz",
    );
    expect(workflow).toContain("--hard-dereference");
    expect(workflow).toContain("运行包包含未审核的符号链接");
    expect(workflow).toContain("extractRuntimeArchive");
    expect(workflow).toContain("cloudssh-entrypoint-version-test.sh");
    expect(workflow).toContain('--modules-abi "$modules_abi"');
    expect(workflow).toContain('--libc "$libc"');
    expect(workflow).toContain('--libc-version "$libc_version"');
    expect(workflow).toContain('--min-entrypoint-protocol "2"');
    expect(workflow).toContain(
      '--deployment-contract "cloudssh-self-update-v1"',
    );
    expect(workflow).not.toContain("UPDATER_IMAGE");
    expect(workflow).not.toContain("docker/updater");
    expect(workflow).not.toContain("lukegus");
    expect(workflow).not.toContain("docker.io/");
    expect(workflow).not.toContain("blacksmith");
    expect(workflow).toContain("github.repository == 'moeacgx/cloudssh'");
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain("CLOUDSSH_IMMUTABLE_RELEASES");
    expect(workflow).toContain("--jq '.immutable // false'");
    expect(workflow).toContain('gh release verify "$TAG"');
  });

  it("第三方 Action 全部固定到完整提交", async () => {
    const workflow = await readFile(
      ".github/workflows/cloudssh-release.yml",
      "utf8",
    );
    const actions = workflow
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*uses:\s*([^\s#]+)/)?.[1])
      .filter((value): value is string => Boolean(value));
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(action).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it("生产镜像的外部基础镜像全部固定到 SHA-256 摘要", async () => {
    const dockerfiles = await Promise.all([
      readFile("docker/Dockerfile", "utf8"),
    ]);
    const externalImages = dockerfiles.flatMap((dockerfile) =>
      [...dockerfile.matchAll(/^FROM\s+(node:[^\s]+)(?:\s|$)/gm)].map(
        (match) => match[1],
      ),
    );
    expect(externalImages.length).toBeGreaterThan(0);
    for (const image of externalImages) {
      expect(image).toMatch(/^node:[^@\s]+@sha256:[0-9a-f]{64}$/);
    }
  });

  it("生产编排固定 guacd 摘要并与应用版本保持一致", async () => {
    const [compose, packageText, restoreScript, updateDocs] = await Promise.all(
      [
        readFile("docker/docker-compose.cloudssh.yml", "utf8"),
        readFile("package.json", "utf8"),
        readFile("scripts/cloudssh-verify-restore.sh", "utf8"),
        readFile("docs/CLOUDSSH-UPDATES.md", "utf8"),
      ],
    );
    const packageVersion = (JSON.parse(packageText) as { version: string })
      .version;
    expect(compose).toMatch(
      /image:\s+guacamole\/guacd:1\.6\.0@sha256:[0-9a-f]{64}/,
    );
    expect(compose).toContain(
      `image: "\${CLOUDSSH_IMAGE:-cloudssh-termix:${packageVersion}}"`,
    );
    expect(restoreScript).toContain(`cloudssh-termix:${packageVersion}`);
    expect(updateDocs).toContain(`"version": "${packageVersion}"`);
  });

  it("只读校验正式 Release 中的固定 amd64 镜像", async () => {
    const workflow = await readFile(
      ".github/workflows/cloudssh-export-image.yml",
      "utf8",
    );
    expect(workflow).toContain("contents: read");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("github.repository == 'moeacgx/cloudssh'");
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain("manifest.schemaVersion !== 3");
    expect(workflow).toContain(
      'manifest.deploymentContract !== "cloudssh-self-update-v1"',
    );
    expect(workflow).toContain(
      'manifest.runtime?.manifest !== "cloudssh-self-update.json"',
    );
    expect(workflow).toContain("!sha256Pattern.test(manifest.runtime?.sha256)");
    expect(workflow).toContain('gh release download "$TAG"');
    expect(workflow).toContain('sha256sum -c "$ARCHIVE.sha256"');
    expect(workflow).toContain('gzip -dc "$ARCHIVE" | docker load');
    expect(workflow).toContain("git/ref/tags/$TAG");
    expect(workflow).not.toContain("--verify-tag");
    expect(workflow).not.toContain("--clobber");
    expect(workflow).not.toContain("gh release upload");
    expect(workflow).toContain(
      '[[ ! "$VERSION" =~ ^2\\.6\\.0-cloudssh\\.[1-9][0-9]*$ ]]',
    );
    expect(workflow).not.toContain("2.6.0-cloudssh.[0-9]*)");
    const actions = workflow
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*uses:\s*([^\s#]+)/)?.[1])
      .filter((value): value is string => Boolean(value));
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(action).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it("正式发版在不可变 Release 前一次性上传离线镜像", async () => {
    const workflow = await readFile(
      ".github/workflows/cloudssh-release.yml",
      "utf8",
    );
    const exportStep = workflow.indexOf("从固定摘要镜像导出 amd64 离线包");
    const uploadStep = workflow.indexOf("幂等上传并校验 Release 附件");
    const publishStep = workflow.indexOf(
      "发布已锁定且附件完整的 GitHub Release",
    );
    expect(exportStep).toBeGreaterThan(0);
    expect(uploadStep).toBeGreaterThan(exportStep);
    expect(publishStep).toBeGreaterThan(uploadStep);
    expect(workflow).toContain(
      "cloudssh-image-$VERSION-linux-amd64.tar.gz.sha256",
    );
    expect(workflow).toContain("Release 发布后未进入不可变状态");
  });

  it("正式版本不可覆盖，并可恢复标签、草稿和缺失附件", async () => {
    const workflow = await readFile(
      ".github/workflows/cloudssh-release.yml",
      "utf8",
    );
    expect(workflow).toContain("git ls-remote --tags");
    expect(workflow).toContain("锁定不可变发布标签");
    expect(workflow).toContain('-f ref="refs/tags/$TAG"');
    expect(
      await readFile("scripts/cloudssh-release-state.mjs", "utf8"),
    ).toContain("正式版本不可覆盖");
    expect(workflow).toContain("残留标签，将安全续跑");
    expect(workflow).toContain("cloudssh-release-state.mjs");
    expect(workflow).toContain("创建或复用同提交的草稿 Release");
    expect(workflow).toContain(
      'if ! REMOTE_TAG="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$TAG"',
    );
    expect(workflow).toContain(
      'if ! EXISTING="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$TAG"',
    );
    expect(workflow).not.toContain('2>/dev/null || true)"');
    expect(workflow).toContain("幂等上传并校验 Release 附件");
    expect(workflow).toContain("--clobber");
    expect(workflow).toContain("sha256sum -c cloudssh-release.json.sha256");
    expect(workflow).toContain('[[ "$IS_DRAFT" == "false" ]]');

    const publishJob = workflow.indexOf("\n  publish:");
    const stagingPush = workflow.indexOf("构建并推送 CloudSSH 暂存镜像");
    const manifest = workflow.indexOf("生成固定摘要发布清单");
    const draft = workflow.indexOf("创建或复用同提交的草稿 Release");
    const assets = workflow.indexOf("幂等上传并校验 Release 附件");
    const tagLock = workflow.indexOf("锁定不可变发布标签");
    const fixedImages = workflow.indexOf("提升并校验固定版本镜像标签");
    const release = workflow.indexOf("发布已锁定且附件完整的 GitHub Release");
    const floatingImages = workflow.indexOf("Release 发布后更新浮动镜像标签");
    expect(stagingPush).toBeGreaterThan(publishJob);
    expect(manifest).toBeGreaterThan(stagingPush);
    expect(draft).toBeGreaterThan(manifest);
    expect(assets).toBeGreaterThan(draft);
    expect(tagLock).toBeGreaterThan(assets);
    expect(fixedImages).toBeGreaterThan(tagLock);
    expect(release).toBeGreaterThan(fixedImages);
    expect(floatingImages).toBeGreaterThan(release);

    const beforeTagLock = workflow.slice(publishJob, tagLock);
    expect(beforeTagLock).not.toContain(
      "${{ env.CLOUDSSH_IMAGE }}:${{ needs.verify.outputs.version }}",
    );
    expect(beforeTagLock).not.toContain("${{ env.CLOUDSSH_IMAGE }}:latest");
  });

  it("只允许从 main 分支创建正式版本", async () => {
    const workflow = await readFile(
      ".github/workflows/cloudssh-release.yml",
      "utf8",
    );
    expect(workflow).toContain('GITHUB_REF" != "refs/heads/main');
    expect(workflow).toContain("正式版本只能从 main 分支发布");
  });

  it("CloudSSH 仓库禁用可覆盖 latest 的旧 Docker 发布入口", async () => {
    const legacyWorkflow = await readFile(
      ".github/workflows/docker.yml",
      "utf8",
    );
    expect(legacyWorkflow).toContain(
      "if: ${{ github.repository == 'Termix-SSH/Termix' }}",
    );
  });
});
