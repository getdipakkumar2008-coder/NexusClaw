import { describe, expect, it } from "vitest";
import { versionLine } from "./index.js";

describe("versionLine", () => {
  it("includes the protocol version", () => {
    expect(versionLine()).toContain("protocol 1.0");
  });
});
