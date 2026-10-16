import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Io } from "@clawnexus/cli";
import { EventLog, openDb } from "@clawnexus/store";
import { acquireLock, createBackup, formatChecks, loadConfig, main, restoreBackup, runDoctor, runSetup, startFromConfig, verifyBackup, writeConfig, type Running } from "./index.js";

let base: string;
let dir: string;
let running: Running | undefined;
const posix = process.platform !== "win32";

function fakeIo(): Io & { outText: string; errText: string } {
  const io = {
    outText: "",
    errText: "",
    out(s: string) {
      io.outText += s;
    },
    err(s: string) {
      io.errText += s;
    },
    env: {} as Record<string, string | undefined>,
    platform: process.platform,
    home: base,
  };
  return io;
}
const cli = async (args: string[]): Promise<{ code: number; out: string; err: string }> => {
  const io = fakeIo();
  const code = await main([...args, "--data-dir", dir], io);
  return { code, out: io.outText, err: io.errText };
};
const start = async (fakeProvider = true): Promise<number> => {
  running = await startFromConfig({ dataDir: dir, io: fakeIo(), port: 0, fakeProvider });
  return running.port;
};

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "cn-daemon-"));
  dir = join(base, "data");
});
afterEach(async () => {
  await running?.stop();
  running = undefined;
  rmSync(base, { recursive: true, force: true });
});

describe("setup", () => {
  it("creates everything, is idempotent, and picks the requested profile", async () => {
    const lines: string[] = [];
    const out = (s: string): void => void lines.push(s);
    const first = await runSetup({ dataDir: dir, profile: "locked-down", out });
    expect(first.steps.find((s) => s.step === "config")?.done).toBe(true);
    expect(existsSync(join(dir, "gateway.token"))).toBe(true);
    expect(existsSync(join(dir, "gateway.db"))).toBe(true);
    expect(loadConfig(dir)).toMatchObject({ state: "ok", config: { security: { profile: "locked-down" } } });

    const token = readFileSync(join(dir, "gateway.token"), "utf8");
    const second = await runSetup({ dataDir: dir, out });
    expect(second.steps.every((s) => !s.done)).toBe(true);
    expect(readFileSync(join(dir, "gateway.token"), "utf8")).toBe(token);

    await runSetup({ dataDir: dir, profile: "standard", out });
    expect(loadConfig(dir)).toMatchObject({ config: { security: { profile: "standard" } } });
  });

  it("rejects unknown profiles and refuses to overwrite a config it cannot read", async () => {
    await expect(runSetup({ dataDir: dir, profile: "yolo", out: () => undefined })).rejects.toThrow(/unknown profile/);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), "{ not json");
    await expect(runSetup({ dataDir: dir, out: () => undefined })).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(join(dir, "config.json"), "utf8")).toBe("{ not json");
  });

  it("asks for a profile when interactive and none was given", async () => {
    const asked: string[] = [];
    await runSetup({ dataDir: dir, out: () => undefined, ask: async (q, _c, fb) => (asked.push(q), fb === "standard" ? "trusted" : fb) });
    expect(asked).toEqual(["Profile"]);
    expect(loadConfig(dir)).toMatchObject({ config: { security: { profile: "trusted" } } });
  });
});

describe("gateway run + CLI end to end (milestone M1)", () => {
  it("setup -> start -> status -> chat streams the reply -> sessions/export", async () => {
    expect((await cli(["setup", "--yes"])).code).toBe(0);
    const port = String(await start());

    const st = await cli(["status", "--port", port]);
    expect(st.code).toBe(0);
    expect(st.out).toContain("uptime");

    const chat = await cli(["chat", "hello", "world", "--port", port]);
    expect(chat.code).toBe(0);
    expect(chat.out).toContain("echo: hello world");

    const list = await cli(["sessions", "list", "--port", port, "--json"]);
    const sessions = JSON.parse(list.out).sessions as Array<{ id: string }>;
    expect(sessions).toHaveLength(1);
    const exp = await cli(["sessions", "export", sessions[0]!.id, "--port", port]);
    expect(exp.out).toContain("echo: hello world");
    const show = await cli(["sessions", "show", sessions[0]!.id, "--port", port]);
    expect(show.out).toContain("[assistant] echo: hello world");
  });

  it("reports a clear error when the Gateway has no provider", async () => {
    await cli(["setup", "--yes"]);
    const port = String(await start(false));
    const r = await cli(["chat", "hi", "--port", port]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("PROVIDER.NOT_CONFIGURED");
    expect(r.err).toContain("Fix:");
  });

  it("pairing and approvals commands work against the live Gateway", async () => {
    await cli(["setup", "--yes"]);
    const port = String(await start());
    expect((await cli(["pairing", "list", "--port", port])).out).toContain("No senders");
    expect((await cli(["approvals", "list", "--port", port])).out).toContain("Nothing waiting");
    expect((await cli(["pairing", "approve", "NOPE", "--port", port])).code).toBe(1);

    const args = JSON.stringify({ command: process.execPath, args: ["-e", "console.log(7*6)"] });
    const need = await cli(["tool", "call", "exec.run", "--args", args, "--port", port]);
    expect(need.out).toContain("Approval needed");
    const id = /approvals approve (\w+)/.exec(need.out)?.[1] ?? "";
    expect((await cli(["approvals", "approve", id, "--port", port])).code).toBe(0);
    const ran = await cli(["tool", "call", "exec.run", "--args", args, "--approval", id, "--port", port]);
    expect(ran.code).toBe(0);
    expect(ran.out).toContain("42");
    const replay = await cli(["tool", "call", "exec.run", "--args", args, "--approval", id, "--port", port]);
    expect(replay.code).toBe(1);
  });

  it("refuses a second Gateway on the same data directory", async () => {
    await cli(["setup", "--yes"]);
    await start();
    await expect(startFromConfig({ dataDir: dir, io: fakeIo(), port: 0 })).rejects.toThrow(/Gateway .*already using|another Gateway/);
  });

  it("refuses to start on a stale or broken config and says how to fix it", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ configVersion: 0 }));
    await expect(startFromConfig({ dataDir: dir, io: fakeIo(), port: 0 })).rejects.toThrow(/version 0/);
    expect(existsSync(join(dir, "gateway.lock"))).toBe(false);
  });

  it("removes its lock on a clean stop", async () => {
    await start();
    expect(existsSync(join(dir, "gateway.lock"))).toBe(true);
    await running!.stop();
    running = undefined;
    expect(existsSync(join(dir, "gateway.lock"))).toBe(false);
  });

  it("takes over a stale lock left by a dead process", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "gateway.lock"), "2147483646\n");
    const release = acquireLock(dir);
    expect(readFileSync(join(dir, "gateway.lock"), "utf8").trim()).toBe(String(process.pid));
    release();
  });
});

describe("doctor", () => {
  it("passes on a fresh setup and reports every area", async () => {
    await runSetup({ dataDir: dir, out: () => undefined });
    const checks = await runDoctor({ dataDir: dir, fix: false, port: 59999 });
    expect(checks.map((c) => c.id)).toEqual(["node", "data-dir", "config", "exposure", "token", "database", "disk", "provider", "port"]);
    expect(checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(formatChecks(checks)).toMatch(/All checks passed|warning/);
  });

  it("flags an old Node, a corrupt config and an unreadable database with fixes", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), "oops");
    writeFileSync(join(dir, "gateway.db"), "this is not a database");
    const checks = await runDoctor({ dataDir: dir, fix: true, nodeVersion: "20.1.0", port: 59998 });
    const by = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(by.node?.status).toBe("fail");
    expect(by.config?.status).toBe("fail");
    expect(by.database?.status).toBe("fail");
    for (const c of checks.filter((x) => x.status !== "ok")) expect(c.fix, c.id).toBeTruthy();
    // --fix must not touch a file it cannot understand
    expect(readFileSync(join(dir, "config.json"), "utf8")).toBe("oops");
  });

  it("--fix migrates a stale config and keeps a backup copy", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ configVersion: 0 }));
    const before = await runDoctor({ dataDir: dir, fix: false, port: 59997 });
    expect(before.find((c) => c.id === "config")).toMatchObject({ status: "fail" });
    const after = await runDoctor({ dataDir: dir, fix: true, port: 59997 });
    expect(after.find((c) => c.id === "config")).toMatchObject({ status: "ok", fixed: true });
    expect(existsSync(join(dir, "config.json.bak"))).toBe(true);
    expect(loadConfig(dir).state).toBe("ok");
  });

  it("warns about exposure beyond loopback", async () => {
    mkdirSync(dir, { recursive: true });
    writeConfig(dir, { configVersion: 1, gateway: { bind: "0.0.0.0", port: 7391, tls: { enabled: true }, auth: { required: true }, insecureAcknowledged: false }, security: { profile: "standard" } });
    const c = (await runDoctor({ dataDir: dir, fix: false, port: 59996 })).find((x) => x.id === "exposure");
    expect(c?.status).toBe("warn");
  });

  it("detects a running Gateway", async () => {
    await runSetup({ dataDir: dir, out: () => undefined });
    const port = await start();
    const c = (await runDoctor({ dataDir: dir, fix: false, port })).find((x) => x.id === "port");
    expect(c).toMatchObject({ status: "ok", message: expect.stringContaining("running") });
  });

  it.runIf(posix)("finds and fixes loose permissions", async () => {
    await runSetup({ dataDir: dir, out: () => undefined });
    chmodSync(dir, 0o755);
    chmodSync(join(dir, "gateway.token"), 0o644);
    const bad = await runDoctor({ dataDir: dir, fix: false, port: 59995 });
    expect(bad.find((c) => c.id === "data-dir")?.status).toBe("fail");
    expect(bad.find((c) => c.id === "token")?.status).toBe("fail");
    const fixed = await runDoctor({ dataDir: dir, fix: true, port: 59995 });
    expect(fixed.filter((c) => c.fixed).map((c) => c.id).sort()).toEqual(["data-dir", "token"]);
  });

  it("the doctor command exits non-zero on failure and supports --json", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), "oops");
    const r = await cli(["doctor", "--json", "--port", "59994"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).some((c: { status: string }) => c.status === "fail")).toBe(true);
  });
});

describe("backup and restore", () => {
  async function seed(): Promise<void> {
    await runSetup({ dataDir: dir, out: () => undefined });
    const db = openDb(join(dir, "gateway.db"));
    new EventLog(db).append([{ type: "marker", data: { v: "keep-me" } }]);
    db.close();
    writeFileSync(join(dir, "secrets.vault"), "encrypted-bytes");
  }

  it("round-trips: backup, wipe, restore", async () => {
    await seed();
    const out = join(base, "bk");
    const m = createBackup(dir, out);
    expect(m.files.map((f) => f.name).sort()).toEqual(["config.json", "gateway.db", "secrets.vault"]);
    expect(existsSync(join(out, "gateway.token"))).toBe(false); // the token never travels in a backup
    expect(verifyBackup(out).files).toHaveLength(3);

    rmSync(dir, { recursive: true, force: true });
    await restoreBackup(out, dir, { port: 59993 });
    const db = openDb(join(dir, "gateway.db"));
    expect(new EventLog(db).readSince(0).some((e) => e.type === "marker")).toBe(true);
    db.close();
    expect(readFileSync(join(dir, "secrets.vault"), "utf8")).toBe("encrypted-bytes");
  });

  it("refuses to clobber existing data unless forced, and keeps the old database aside", async () => {
    await seed();
    const out = join(base, "bk");
    createBackup(dir, out);
    await expect(restoreBackup(out, dir, { port: 59993 })).rejects.toThrow(/already exists/);
    const r = await restoreBackup(out, dir, { force: true, port: 59993, now: () => 1 });
    expect(existsSync(r.movedAside ?? "")).toBe(true);
  });

  it("refuses to restore while a Gateway is running", async () => {
    await seed();
    const out = join(base, "bk");
    createBackup(dir, out);
    const port = await start();
    await expect(restoreBackup(out, dir, { force: true, port })).rejects.toThrow(/answering/);
  });

  it("detects a tampered, truncated or hostile backup", async () => {
    await seed();
    const out = join(base, "bk");
    createBackup(dir, out);
    writeFileSync(join(out, "secrets.vault"), "changed");
    expect(() => verifyBackup(out)).toThrow(/checksum/);

    const hostile = join(base, "bk2");
    createBackup(dir, hostile);
    const mp = join(hostile, "manifest.json");
    const m = JSON.parse(readFileSync(mp, "utf8"));
    m.files.push({ name: "../../escape.txt", bytes: 1, sha256: "x" });
    writeFileSync(mp, JSON.stringify(m));
    expect(() => verifyBackup(hostile)).toThrow(/unsafe/);

    expect(() => verifyBackup(join(base, "nothing"))).toThrow(/manifest/);
    expect(() => createBackup(dir, out)).toThrow(/already exists/);
  });

  it("backs up while the Gateway is running", async () => {
    await seed();
    await start();
    const out = join(base, "live");
    expect(() => createBackup(dir, out)).not.toThrow();
    expect(verifyBackup(out).files.length).toBeGreaterThan(0);
  });

  it("backup/restore commands print results and fail clearly", async () => {
    await seed();
    const out = join(base, "cmd");
    const b = await cli(["backup", "--out", out]);
    expect(b.code).toBe(0);
    expect(b.out).toContain("token is not included");
    expect((await cli(["backup", "--out", out])).err).toContain("BACKUP_EXISTS");
    expect((await cli(["restore"])).err).toContain("USAGE");
  });
});

describe("model provider (WP7)", () => {
  const FAKE = fileURLToPath(new URL("../../acp/test/fake-harness.mjs", import.meta.url));
  const providerOf = (): unknown => {
    const l = loadConfig(dir);
    if (l.state !== "ok") throw new Error(`config not ok: ${l.state}`);
    return l.config.provider;
  };
  const useFakeHarness = (): void => {
    process.env["FAKE_MODE"] = "normal";
    writeConfig(dir, { configVersion: 1, provider: { harness: "custom", command: process.execPath, args: [FAKE], env: ["FAKE_MODE"] } });
  };
  afterEach(() => {
    delete process.env["FAKE_MODE"];
  });

  it("setup --harness records the choice, rejects unknown ones, and replaces overrides when switching", async () => {
    const a = await cli(["setup", "--yes", "--harness", "gemini"]);
    expect(a.code).toBe(0);
    expect(a.out).toContain("model harness: gemini");
    expect(providerOf()).toEqual({ harness: "gemini" });
    expect((await cli(["setup", "--yes", "--harness", "nope"])).err).toContain("USAGE");
    writeConfig(dir, { configVersion: 1, provider: { harness: "gemini", args: ["--acp", "--debug"] } });
    await cli(["setup", "--yes", "--harness", "cursor"]);
    expect(providerOf()).toEqual({ harness: "cursor" });
  });

  it("rejects a custom harness without a command", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ configVersion: 1, provider: { harness: "custom" } }));
    expect(loadConfig(dir).state).toBe("invalid");
  });

  it("doctor warns without a provider and fails when the harness program is missing", async () => {
    await runSetup({ dataDir: dir, out: () => undefined });
    const none = (await runDoctor({ dataDir: dir, fix: false, port: 59998 })).find((c) => c.id === "provider");
    expect(none?.status).toBe("warn");
    writeConfig(dir, { configVersion: 1, provider: { harness: "custom", command: "definitely-not-installed-xyz" } });
    const missing = (await runDoctor({ dataDir: dir, fix: false, port: 59998 })).find((c) => c.id === "provider");
    expect(missing?.status).toBe("fail");
    expect(missing?.fix).toBeTruthy();
    useFakeHarness();
    const ok = (await runDoctor({ dataDir: dir, fix: false, port: 59998 })).find((c) => c.id === "provider");
    expect(ok?.status).toBe("ok");
  });

  it("chat goes through the configured harness end to end", async () => {
    await runSetup({ dataDir: dir, out: () => undefined });
    useFakeHarness();
    const port = String(await start(false));
    const r = await cli(["chat", "hello", "there", "--port", port]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("pong: hello there");
    const again = await cli(["chat", "second", "--port", port]);
    expect(again.out).toContain("pong: second");
  });

  it("provider test prints the answer, and explains when nothing is configured", async () => {
    await runSetup({ dataDir: dir, out: () => undefined });
    expect((await cli(["provider", "test"])).err).toContain("PROVIDER_NOT_CONFIGURED");
    useFakeHarness();
    const r = await cli(["provider", "test", "--prompt", "ping"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("pong: ping");
    expect((await cli(["provider", "nope"])).err).toContain("USAGE");
  });
});
