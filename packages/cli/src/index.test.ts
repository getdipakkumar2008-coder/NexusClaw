import { describe, expect, it } from "vitest";
import { CliError, defaultDataDir, parseArgs, runCli, versionLine, type Io } from "./index.js";

function fakeIo(env: Record<string, string> = {}): Io & { outText: string; errText: string } {
  const io = {
    outText: "",
    errText: "",
    out(s: string) {
      io.outText += s;
    },
    err(s: string) {
      io.errText += s;
    },
    env,
    platform: "linux" as NodeJS.Platform,
    home: "/home/u",
  };
  return io;
}

describe("versionLine", () => {
  it("includes the protocol version", () => {
    expect(versionLine()).toContain("protocol 1.0");
  });
});

describe("parseArgs", () => {
  it("separates positionals from flags and keeps boolean flags from eating positionals", () => {
    const p = parseArgs(["chat", "--json", "hello", "world", "--session", "s_1", "--port=9000", "-h"]);
    expect(p.positionals).toEqual(["chat", "hello", "world"]);
    expect(p.flags).toEqual({ json: true, session: "s_1", port: "9000", h: true });
  });
  it("treats everything after -- as positional", () => {
    expect(parseArgs(["tool", "call", "x", "--", "--args"]).positionals).toEqual(["tool", "call", "x", "--args"]);
  });
});

describe("defaultDataDir", () => {
  const base = { home: "/home/u" };
  it("honours the override and per-OS conventions", () => {
    expect(defaultDataDir({ ...base, platform: "linux", env: { CLAWNEXUS_DATA_DIR: "/x" } })).toBe("/x");
    expect(defaultDataDir({ ...base, platform: "linux", env: {} }).split("\\").join("/")).toBe("/home/u/.local/share/clawnexus");
    expect(defaultDataDir({ ...base, platform: "linux", env: { XDG_DATA_HOME: "/xdg" } }).split("\\").join("/")).toBe("/xdg/clawnexus");
    expect(defaultDataDir({ ...base, platform: "darwin", env: {} }).split("\\").join("/")).toBe("/home/u/Library/Application Support/ClawNexus");
    expect(defaultDataDir({ ...base, platform: "win32", env: { LOCALAPPDATA: "C:\\L" } })).toContain("ClawNexus");
  });
});

describe("runCli", () => {
  it("prints help and version", async () => {
    const io = fakeIo();
    expect(await runCli([], io)).toBe(0);
    expect(io.outText).toContain("Usage:");
    const v = fakeIo();
    expect(await runCli(["--version"], v)).toBe(0);
    expect(v.outText).toContain("protocol");
  });

  it("reports unknown commands as usage errors with a fix, not a stack trace", async () => {
    const io = fakeIo();
    expect(await runCli(["frobnicate"], io)).toBe(2);
    expect(io.errText).toMatch(/Error USAGE: unknown command frobnicate\n {2}Fix: /);
    expect(io.errText).not.toMatch(/\bat \w+.*\(/);
  });

  it("explains a missing token", async () => {
    const io = fakeIo({ CLAWNEXUS_DATA_DIR: "/definitely/not/here" });
    expect(await runCli(["status"], io)).toBe(1);
    expect(io.errText).toContain("NO_TOKEN");
    expect(io.errText).toContain("setup");
  });

  it("explains an unreachable Gateway", async () => {
    const io = fakeIo();
    expect(await runCli(["status", "--port", "1", "--token", "x"], io)).toBe(1);
    expect(io.errText).toContain("UNREACHABLE");
    expect(io.errText).toContain("gateway run");
  });

  it("rejects a bad port and emits JSON errors on request", async () => {
    const io = fakeIo();
    await runCli(["status", "--port", "abc", "--token", "x", "--json"], io);
    expect(JSON.parse(io.errText).error.code).toBe("USAGE");
  });

  it("CliError carries code and remediation", () => {
    const e = new CliError("X", "m", "r");
    expect([e.code, e.message, e.remediation]).toEqual(["X", "m", "r"]);
  });
});
