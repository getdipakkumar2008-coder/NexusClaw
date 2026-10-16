import { describe, expect, it } from "vitest";
import { manifestSchema, sdkRangeSatisfied } from "./index.js";

const base = { id: "hello-tool", name: "Hello", version: "1.0.0", kind: "code", sdkRange: "^0.1.0", entry: "dist/index.js" };

describe("manifestSchema", () => {
  it("accepts a code plugin and fills permission defaults", () => {
    const m = manifestSchema.parse(base);
    expect(m.permissions.exec).toBe(false);
    expect(m.provides).toEqual([]);
  });
  it("rejects unknown keys", () => {
    expect(manifestSchema.safeParse({ ...base, surprise: 1 }).success).toBe(false);
  });
  it("code plugin needs entry; bundle must not have one or exec", () => {
    expect(manifestSchema.safeParse({ ...base, entry: undefined }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base, kind: "bundle" }).success).toBe(false);
    expect(
      manifestSchema.safeParse({ ...base, kind: "bundle", entry: undefined, permissions: { exec: true } }).success,
    ).toBe(false);
    expect(manifestSchema.safeParse({ ...base, kind: "bundle", entry: undefined }).success).toBe(true);
  });
  it("rejects bad ids and versions", () => {
    expect(manifestSchema.safeParse({ ...base, id: "Bad Id" }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base, version: "1" }).success).toBe(false);
  });
});

describe("sdkRangeSatisfied", () => {
  it("follows caret semantics", () => {
    expect(sdkRangeSatisfied("^0.1.0", "0.1.4")).toBe(true);
    expect(sdkRangeSatisfied("^0.1.0", "0.2.0")).toBe(false);
    expect(sdkRangeSatisfied("^1.0.0", "1.4.2")).toBe(true);
    expect(sdkRangeSatisfied("^1.2.0", "1.1.9")).toBe(false);
    expect(sdkRangeSatisfied("^2.0.0", "1.9.9")).toBe(false);
  });
});
