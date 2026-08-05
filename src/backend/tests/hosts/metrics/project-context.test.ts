import { describe, expect, it } from "vitest";
import { parseProjectHostId } from "../../../hosts/metrics/project-context.js";

describe("parseProjectHostId", () => {
  it("accepts positive safe integers from JSON and query strings", () => {
    expect(parseProjectHostId(11)).toBe(11);
    expect(parseProjectHostId("11")).toBe(11);
  });

  it("treats an omitted project as personal context", () => {
    expect(parseProjectHostId(undefined)).toBeUndefined();
    expect(parseProjectHostId(null)).toBeUndefined();
    expect(parseProjectHostId("")).toBeUndefined();
  });

  it("rejects malformed, non-positive, and fractional ids", () => {
    expect(parseProjectHostId("other-project")).toBeNull();
    expect(parseProjectHostId(0)).toBeNull();
    expect(parseProjectHostId(-1)).toBeNull();
    expect(parseProjectHostId(1.5)).toBeNull();
  });
});
