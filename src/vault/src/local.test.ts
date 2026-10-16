import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalVault, VAULT_FILE, VAULT_KEY_FILE } from "./index.js";

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "cn-lv-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("LocalVault", () => {
  it("creates its own key, keeps secrets across restarts, and stores nothing readable", async () => {
    const a = new LocalVault(dir);
    await a.open();
    a.set("plugin.x.token", "super-secret-value-123");
    a.close();
    expect(readFileSync(join(dir, VAULT_FILE), "utf8")).not.toContain("super-secret-value-123");
    const b = new LocalVault(dir);
    await b.open();
    expect(b.get("plugin.x.token")).toBe("super-secret-value-123");
    expect(b.redact.redact("see super-secret-value-123 here")).toBe("see [REDACTED:plugin.x.token] here");
    b.close();
  });

  it("is inert until opened: reads find nothing, writes are refused", () => {
    const v = new LocalVault(dir);
    expect(v.ready).toBe(false);
    expect(v.get("a")).toBeUndefined();
    expect(v.list()).toEqual([]);
    expect(() => v.set("a.b", "value-value")).toThrow(/not open/);
    expect(v.redact.redact("anything")).toBe("anything");
  });

  it("refuses to invent a new key when a vault already exists without one (that would hide data loss)", async () => {
    const a = new LocalVault(dir);
    await a.open();
    a.set("a.b", "value-value");
    a.close();
    rmSync(join(dir, VAULT_KEY_FILE));
    await expect(new LocalVault(dir).open()).rejects.toMatchObject({ code: "BAD_KEY" });
  });

  it("rejects a damaged key file", async () => {
    await new LocalVault(dir).open();
    writeFileSync(join(dir, VAULT_KEY_FILE), "AAAA\n");
    await expect(new LocalVault(dir).open()).rejects.toMatchObject({ code: "BAD_KEY" });
  });
});
