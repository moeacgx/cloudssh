import { describe, expect, it } from "vitest";
import {
  isFileManagerSessionOwner,
  isValidFileManagerSessionId,
  parseFileManagerSessionContext,
} from "../../hosts/file-manager/session.js";

describe("文件管理会话隔离", () => {
  it("解析带随机后缀的主机与项目上下文", () => {
    expect(parseFileManagerSessionContext("file:42:73:random_id-1")).toEqual({
      hostId: 42,
      projectHostId: 73,
    });
    expect(parseFileManagerSessionContext("file:42:0:random_id-1")).toEqual({
      hostId: 42,
      projectHostId: undefined,
    });
    expect(parseFileManagerSessionContext("42")).toEqual({ hostId: 42 });
  });

  it("拒绝原型键、路径字符与非法上下文", () => {
    for (const value of [
      "__proto__",
      "prototype",
      "constructor",
      "../42",
      "file:0:2:x",
      "file:2:x:y",
    ]) {
      expect(isValidFileManagerSessionId(value)).toBe(
        value === "file:0:2:x" || value === "file:2:x:y",
      );
      expect(parseFileManagerSessionContext(value)).toBeNull();
    }
  });

  it("只有会话所有者可以复用或关闭会话", () => {
    expect(isFileManagerSessionOwner("user-a", "user-a")).toBe(true);
    expect(isFileManagerSessionOwner("user-a", "user-b")).toBe(false);
  });
});
