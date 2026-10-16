import { describe, expect, it } from "vitest";
import { MAX_FRAME_BYTES, isCompatible, parseFrame } from "./index.js";

describe("parseFrame", () => {
  it("accepts a request", () => {
    const r = parseFrame(JSON.stringify({ t: "req", id: "c-1", method: "session.send", params: { a: 1 } }));
    expect(r.ok).toBe(true);
  });

  it("accepts ok and error responses and events", () => {
    expect(parseFrame('{"t":"res","id":"1","ok":true,"result":{}}').ok).toBe(true);
    expect(
      parseFrame(
        JSON.stringify({
          t: "res",
          id: "1",
          ok: false,
          error: { code: "AUTH.EXPIRED", message: "m", remediation: "r", retryable: false },
        }),
      ).ok,
    ).toBe(true);
    expect(parseFrame('{"t":"evt","seq":0,"type":"run.started"}').ok).toBe(true);
  });

  it.each([
    ["not json", "{nope"],
    ["array", "[]"],
    ["null", "null"],
    ["unknown t", '{"t":"x"}'],
    ["extra key", '{"t":"req","id":"1","method":"a.b","extra":1}'],
    ["bad method", '{"t":"req","id":"1","method":"BAD"}'],
    ["negative seq", '{"t":"evt","seq":-1,"type":"x"}'],
    ["fractional seq", '{"t":"evt","seq":1.5,"type":"x"}'],
    ["empty id", '{"t":"req","id":"","method":"a.b"}'],
    ["error with unknown family", '{"t":"res","id":"1","ok":false,"error":{"code":"WAT","message":"m","remediation":"r","retryable":false}}'],
  ])("rejects %s without throwing", (_name, raw) => {
    const r = parseFrame(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("BAD_FRAME");
  });

  it("rejects oversized frames before parsing", () => {
    const big = JSON.stringify({ t: "req", id: "1", method: "a.b", params: "x".repeat(MAX_FRAME_BYTES) });
    const r = parseFrame(big);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/maximum size/);
  });

  it("survives random garbage", () => {
    for (let i = 0; i < 500; i++) {
      const s = Array.from({ length: (i % 40) + 1 }, () => String.fromCharCode(Math.floor(Math.random() * 0xd7ff))).join("");
      expect(() => parseFrame(s)).not.toThrow();
    }
  });
});

describe("isCompatible", () => {
  it("requires equal major version", () => {
    expect(isCompatible(1)).toBe(true);
    expect(isCompatible(2)).toBe(false);
  });
});
