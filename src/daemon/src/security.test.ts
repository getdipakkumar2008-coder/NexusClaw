import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSecurityDoctor, runSetup, writeConfig, loadConfig } from "./index.js";

let dir: string;
const posix = process.platform !== "win32";
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "cn-sec-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const byId = (cs: Array<{ id: string; status: string; message: string }>, id: string) => cs.find((c) => c.id === id);

async function install(): Promise<void> {
  await runSetup({ dataDir: dir, out: () => undefined });
}
function change(patch: (c: Record<string, any>) => void): void { // eslint-disable-line @typescript-eslint/no-explicit-any
  const loaded = loadConfig(dir);
  if (loaded.state !== "ok") throw new Error("config not ok");
  const raw = JSON.parse(JSON.stringify(loaded.config));
  patch(raw);
  writeConfig(dir, raw);
}

describe("doctor --security", () => {
  it("passes on a default install, with no failures and no warnings", async () => {
    await install();
    const checks = await runSecurityDoctor({ dataDir: dir, fix: false, port: 59990 });
    expect(checks.filter((c) => c.status === "fail"), JSON.stringify(checks)).toEqual([]);
    expect(checks.filter((c) => c.id.startsWith("sec:") && c.status === "warn")).toEqual([]);
    expect(checks.map((c) => c.id)).toEqual(expect.arrayContaining(["sec:exposure", "sec:profile", "sec:files", "sec:backups"]));
  });

  it("warns about the trusted profile, since commands then run without asking", async () => {
    await install();
    change((c) => void (c.security.profile = "trusted"));
    const checks = await runSecurityDoctor({ dataDir: dir, fix: false, port: 59990 });
    expect(byId(checks, "sec:profile")).toMatchObject({ status: "warn" });
  });

  it("fails when the Gateway is open to the network without TLS", async () => {
    await install();
    change((c) => {
      c.gateway.bind = "0.0.0.0";
      c.gateway.insecureAcknowledged = true;
    });
    const checks = await runSecurityDoctor({ dataDir: dir, fix: false, port: 59990 });
    expect(byId(checks, "sec:exposure")).toMatchObject({ status: "fail" });
  });

  it("warns about a backup that carries the vault key", async () => {
    await install();
    mkdirSync(join(dir, "backups", "b1"), { recursive: true });
    writeFileSync(join(dir, "backups", "b1", "vault.key"), "k");
    const checks = await runSecurityDoctor({ dataDir: dir, fix: false, port: 59990 });
    expect(byId(checks, "sec:backups")).toMatchObject({ status: "warn" });
    expect(byId(checks, "sec:backups")?.message).toContain("b1");
  });

  it.runIf(posix)("fails when a key or token file can be read by other users, and when the file-check program can be replaced", async () => {
    await install();
    writeFileSync(join(dir, "vault.key"), "k", { mode: 0o644 });
    chmodSync(join(dir, "vault.key"), 0o644);
    mkdirSync(join(dir, "hooks"));
    writeFileSync(join(dir, "hooks", "scan"), "#!/bin/sh\n", { mode: 0o777 });
    chmodSync(join(dir, "hooks", "scan"), 0o777);
    const checks = await runSecurityDoctor({ dataDir: dir, fix: false, port: 59990 });
    expect(byId(checks, "sec:files")).toMatchObject({ status: "fail" });
    expect(byId(checks, "sec:files")?.message).toContain("vault.key");
    expect(byId(checks, "sec:scan-hook")).toMatchObject({ status: "fail" });
  });

  it("never changes anything, even when asked to fix", async () => {
    await install();
    const before = readFileSync(join(dir, "config.json"), "utf8");
    await runSecurityDoctor({ dataDir: dir, fix: true, port: 59990 });
    expect(readFileSync(join(dir, "config.json"), "utf8")).toBe(before);
  });
});
