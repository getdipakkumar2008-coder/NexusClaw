import { describe, expect, it } from "vitest";
import { gatewayInfo } from "./index.js";

describe("gatewayInfo", () => {
  it("reports versions from the shared packages", () => {
    const info = gatewayInfo();
    expect(info.protocol).toBe("1.0");
    expect(info.configVersion).toBe(1);
  });
});
