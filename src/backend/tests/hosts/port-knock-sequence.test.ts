import { describe, expect, it } from "vitest";
import {
  normalizePortKnockSequence,
  serializePortKnockSequence,
} from "../../hosts/port-knock-sequence.js";

describe("端口敲门序列归一化", () => {
  it("兼容数组、数据库 JSON 文本和旧版字符串字段", () => {
    expect(
      normalizePortKnockSequence([
        { port: 4000, protocol: "UDP", delay: "150" },
        { port: "5000" },
      ]),
    ).toEqual([
      { port: 4000, protocol: "udp", delay: 150 },
      { port: 5000, protocol: undefined, delay: undefined },
    ]);
    expect(
      normalizePortKnockSequence(
        '[{"port":6000,"protocol":"tcp","delay":100}]',
      ),
    ).toEqual([{ port: 6000, protocol: "tcp", delay: 100 }]);
    expect(
      normalizePortKnockSequence(
        '"[{\\"port\\":7000,\\"protocol\\":\\"tcp\\"}]"',
      ),
    ).toEqual([{ port: 7000, protocol: "tcp", delay: undefined }]);
  });

  it("丢弃畸形、越界和非数组历史值", () => {
    expect(
      normalizePortKnockSequence([
        null,
        "4000",
        { port: 0 },
        { port: 65_536 },
        { port: "not-a-port" },
      ]),
    ).toEqual([]);
    expect(normalizePortKnockSequence("not-json")).toEqual([]);
    expect(normalizePortKnockSequence({ port: 4000 })).toEqual([]);
    expect(normalizePortKnockSequence(null)).toEqual([]);
  });

  it("写入时只序列化有效数组，避免 API 字符串被双重编码", () => {
    expect(serializePortKnockSequence('[{"port":4000,"protocol":"tcp"}]')).toBe(
      '[{"port":4000,"protocol":"tcp"}]',
    );
    expect(serializePortKnockSequence([])).toBeNull();
    expect(serializePortKnockSequence("not-json")).toBeNull();
  });
});
