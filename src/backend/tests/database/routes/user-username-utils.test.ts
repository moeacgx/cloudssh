import { describe, expect, it } from "vitest";
import { validateUsername } from "../../../database/routes/user-username-utils.js";

describe("validateUsername", () => {
  it("去除首尾空格并接受常用用户名字符", () => {
    expect(validateUsername("  admin_01  ")).toEqual({
      valid: true,
      username: "admin_01",
    });
    expect(validateUsername("user.name-test")).toEqual({
      valid: true,
      username: "user.name-test",
    });
  });

  it("拒绝空值和长度越界", () => {
    expect(validateUsername(" ")).toEqual({
      valid: false,
      code: "USERNAME_REQUIRED",
    });
    expect(validateUsername("ab")).toEqual({
      valid: false,
      code: "USERNAME_LENGTH",
    });
    expect(validateUsername("a".repeat(33))).toEqual({
      valid: false,
      code: "USERNAME_LENGTH",
    });
  });

  it("拒绝不安全字符、非字母数字开头和保留名称", () => {
    expect(validateUsername("-admin")).toEqual({
      valid: false,
      code: "USERNAME_FORMAT",
    });
    expect(validateUsername("admin name")).toEqual({
      valid: false,
      code: "USERNAME_FORMAT",
    });
    expect(validateUsername("SYSTEM")).toEqual({
      valid: false,
      code: "USERNAME_RESERVED",
    });
  });
});
