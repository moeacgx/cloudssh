import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("CloudSSH 快速镜像构建工作流", () => {
  it("在 main 推送时快速构建并推送 GHCR 镜像", async () => {
    const workflow = await readFile(
      ".github/workflows/cloudssh-docker.yml",
      "utf8",
    );

    expect(workflow).toContain("name: CloudSSH 快速镜像构建");
    expect(workflow).toContain("branches:\n      - main");
    expect(workflow).toContain("workflow_dispatch: {}");
    expect(workflow).toContain("packages: write");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain(
      "ghcr.io/${{ github.repository_owner }}/cloudssh",
    );
    expect(workflow).toContain("docker/setup-qemu-action@");
    expect(workflow).toContain("docker/setup-buildx-action@");
    expect(workflow).toContain("docker/login-action@");
    expect(workflow).toContain("docker/metadata-action@v5");
    expect(workflow).toContain("docker/build-push-action@");
    expect(workflow).toContain("platforms: linux/amd64,linux/arm64");
    expect(workflow).toContain("push: true");
    expect(workflow).toContain("type=ref,event=branch");
    expect(workflow).toContain(
      "type=raw,value=latest,enable={{is_default_branch}}",
    );
    expect(workflow).toContain("type=sha,prefix=sha-");
    expect(workflow).toContain("cache-from: type=gha,scope=cloudssh");
    expect(workflow).toContain("cache-to: type=gha,mode=max,scope=cloudssh");
    expect(workflow).not.toContain("cloudssh-release.json");
    expect(workflow).not.toContain("cloudssh-self-update.json");
    expect(workflow).not.toContain("gh release");
    expect(workflow).not.toContain("docker load");
  });

  it("Docker 上下文排除不影响应用构建的 CI、文档和测试文件", async () => {
    const dockerignore = await readFile(".dockerignore", "utf8");

    expect(dockerignore).toContain(".github/");
    expect(dockerignore).toContain("docs/");
    expect(dockerignore).toContain("**/*.test.ts");
    expect(dockerignore).toContain("**/*.test.tsx");
    expect(dockerignore).toContain("src/**/tests/");
    expect(dockerignore).toContain("vitest.config.ts");
    expect(dockerignore).toContain("vitest.setup.ts");
  });
});
