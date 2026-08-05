import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function requireText(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} 不能为空。`);
  }
  return value.trim();
}

function flattenReleases(value) {
  if (!Array.isArray(value)) {
    throw new Error("GitHub Release 响应必须是数组。");
  }
  return value.flatMap((item) =>
    Array.isArray(item) ? flattenReleases(item) : [item],
  );
}

export function planReleaseState({
  tag,
  revision,
  remoteTagSha = "",
  releases = [],
}) {
  const expectedTag = requireText(tag, "发布标签");
  const expectedRevision = requireText(revision, "发布提交");
  const tagSha = typeof remoteTagSha === "string" ? remoteTagSha.trim() : "";

  if (!/^[0-9a-f]{40}$/i.test(expectedRevision)) {
    throw new Error("发布提交必须是完整的 40 位 Git SHA。");
  }
  if (tagSha && !/^[0-9a-f]{40}$/i.test(tagSha)) {
    throw new Error("远端标签提交必须是完整的 40 位 Git SHA。");
  }
  if (tagSha && tagSha.toLowerCase() !== expectedRevision.toLowerCase()) {
    throw new Error(
      "该版本标签已指向其他提交；正式版本不可覆盖，请提升版本号。",
    );
  }

  const matches = flattenReleases(releases).filter(
    (release) => release?.tag_name === expectedTag,
  );
  if (matches.length > 1) {
    throw new Error("检测到多个同标签 Release，无法安全续跑。");
  }

  const release = matches[0];
  if (release && release.draft !== true) {
    throw new Error("该正式版本已经发布；正式版本不可覆盖，请提升版本号。");
  }
  if (release && !tagSha && release.target_commitish !== expectedRevision) {
    throw new Error("草稿 Release 指向其他提交，拒绝复用。");
  }

  return {
    state: release ? "draft" : "new",
    draftId: release ? String(release.id) : "",
    resumeTag: Boolean(tagSha),
  };
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`无效参数：${key ?? ""}`);
    }
    values.set(key.slice(2), value);
  }
  return values;
}

export async function run(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const releasesPath = requireText(args.get("releases"), "Release 响应文件");
  const releases = JSON.parse(await readFile(releasesPath, "utf8"));
  const plan = planReleaseState({
    tag: args.get("tag"),
    revision: args.get("revision"),
    remoteTagSha: args.get("tag-sha") ?? "",
    releases,
  });

  process.stdout.write(
    [
      `release_state=${plan.state}`,
      `draft_id=${plan.draftId}`,
      `resume_tag=${plan.resumeTag}`,
    ].join("\n") + "\n",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
