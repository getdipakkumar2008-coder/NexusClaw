import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundledPlugin } from "./run.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cn-bundled-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const plugin = (at: string, name: string): string => {
  const p = join(at, "extensions", name);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, "clawnexus.plugin.json"), "{}");
  return p;
};

describe("plugins that ship with the program", () => {
  it("are found beside an installed program and above a repository checkout", () => {
    const installed = join(dir, "pkg");
    const want = plugin(installed, "telegram");
    expect(bundledPlugin("telegram", join(installed, "dist"))).toBe(want);
    const repo = join(dir, "repo");
    const inRepo = plugin(repo, "slack");
    expect(bundledPlugin("slack", join(repo, "packages", "cli", "dist"))).toBe(inRepo);
  });

  it("are only found by a plain name that has a manifest", () => {
    const pkg = join(dir, "pkg");
    plugin(pkg, "telegram");
    mkdirSync(join(pkg, "extensions", "empty"), { recursive: true });
    expect(bundledPlugin("empty", join(pkg, "dist"))).toBeUndefined();
    expect(bundledPlugin("nope", join(pkg, "dist"))).toBeUndefined();
    for (const bad of ["../telegram", "telegram/..", "Telegram", "", "a b", "./telegram", "C:\\x"]) expect(bundledPlugin(bad, join(pkg, "dist")), bad).toBeUndefined();
  });
});
