import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    // a vault without its key cannot be opened here, so it is set aside intact rather than left to block a new one
    const aside = readdirSync(dir).find((f) => f.startsWith("secrets.vault.unreadable-"));
    expect(readFileSync(join(dir, aside ?? "missing"), "utf8")).toBe("encrypted-bytes");
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

describe("tool bridge end to end (WP7 slice 2)", () => {
  const FAKE = fileURLToPath(new URL("../../acp/test/fake-harness.mjs", import.meta.url));
  const workspaceFile = (name: string): string => join(dir, "workspace", name);
  const configure = (extra: Record<string, unknown> = {}, security = "standard"): void => {
    process.env["FAKE_MODE"] = "mcp";
    process.env["FAKE_WAIT_S"] = "20";
    writeConfig(dir, {
      configVersion: 1,
      security: { profile: security },
      provider: { harness: "custom", command: process.execPath, args: [FAKE], env: ["FAKE_MODE", "FAKE_WAIT_S"], ...extra },
    });
  };
  afterEach(() => {
    delete process.env["FAKE_MODE"];
    delete process.env["FAKE_WAIT_S"];
  });
  const pendingApproval = async (): Promise<string> => {
    for (let i = 0; i < 400; i++) {
      const a = running?.gateway.approvals.list()[0];
      if (a) return a.id;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("no approval was requested");
  };

  it("the model sees the Gateway's tools through a bridge process it starts itself", async () => {
    await runSetup({ dataDir: dir, out: () => undefined });
    configure();
    const port = String(await start(false));
    const r = await cli(["chat", "list", "--port", port]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("tools=fs_read,fs_list,fs_write,exec_run");
  }, 30_000);

  it("reads run at once; the model's writes wait for the owner, and the owner's yes lets exactly that write through", async () => {
    await runSetup({ dataDir: dir, out: () => undefined });
    configure();
    writeFileSync(workspaceFile("seed.txt"), "seed-content");
    const port = String(await start(false));

    const read = await cli(["chat", 'fs_read|{"path":"seed.txt"}', "--port", port]);
    expect(read.out).toContain("isError=false");
    expect(read.out).toContain("seed-content");

    const writing = cli(["chat", 'fs_write|{"path":"w.txt","content":"from the model"}', "--port", port, "--timeout", "30"]);
    const id = await pendingApproval();
    expect(running?.gateway.approvals.get(id)?.requester).toMatch(/^agent:/);
    expect(existsSync(workspaceFile("w.txt"))).toBe(false); // nothing happens before the owner says so
    expect((await cli(["approvals", "approve", id, "--port", port])).code).toBe(0);
    const done = await writing;
    expect(done.out).toContain("isError=false");
    expect(done.err).toContain("[approval needed]");
    expect(done.err).toContain(`approvals approve ${id}`);
    expect(readFileSync(workspaceFile("w.txt"), "utf8")).toBe("from the model");
  }, 60_000);

  it("when the owner says no, nothing runs and the model is told not to try again", async () => {
    await runSetup({ dataDir: dir, out: () => undefined });
    configure();
    const port = String(await start(false));
    const writing = cli(["chat", 'fs_write|{"path":"no.txt","content":"x"}', "--port", port, "--timeout", "30"]);
    const id = await pendingApproval();
    expect((await cli(["approvals", "deny", id, "--port", port])).code).toBe(0);
    const done = await writing;
    expect(done.out).toContain("isError=true");
    expect(done.out).toMatch(/denied/i);
    expect(existsSync(workspaceFile("no.txt"))).toBe(false);
  }, 60_000);

  it("if the owner never answers, the model gets a clear 'still pending' and the request stays open", async () => {
    await runSetup({ dataDir: dir, out: () => undefined });
    configure();
    process.env["FAKE_WAIT_S"] = "1";
    const port = String(await start(false));
    const r = await cli(["chat", 'fs_write|{"path":"late.txt","content":"x"}', "--port", port, "--timeout", "30"]);
    expect(r.out).toContain("isError=true");
    expect(r.out).toContain("has not approved");
    expect(existsSync(workspaceFile("late.txt"))).toBe(false);
    expect(running?.gateway.approvals.list()).toHaveLength(1);
  }, 60_000);

  it("path escapes by the model are refused like anyone else's", async () => {
    await runSetup({ dataDir: dir, out: () => undefined });
    configure();
    const port = String(await start(false));
    const r = await cli(["chat", 'fs_read|{"path":"../gateway.token"}', "--port", port]);
    expect(r.out).toContain("isError=true");
    expect(r.out).not.toContain(readFileSync(join(dir, "gateway.token"), "utf8").trim());
  }, 30_000);

  it("a locked-down profile refuses program execution from the model outright", async () => {
    await runSetup({ dataDir: dir, out: () => undefined });
    configure({}, "locked-down");
    const port = String(await start(false));
    const r = await cli(["chat", `exec_run|${JSON.stringify({ command: process.execPath, args: ["-e", "1"] })}`, "--port", port]);
    expect(r.out).toContain("isError=true");
    expect(r.out).toMatch(/sandbox/);
    expect(running?.gateway.approvals.list()).toHaveLength(0);
  }, 30_000);

  it("a harness cannot borrow the permission shortcut by naming some other MCP server", async () => {
    await runSetup({ dataDir: dir, out: () => undefined });
    configure({ env: ["FAKE_MODE", "FAKE_WAIT_S", "FAKE_CLAIM"] });
    process.env["FAKE_CLAIM"] = "clawnexus"; // a guessable name; the real one is random per session
    try {
      const port = String(await start(false));
      const r = await cli(["chat", 'fs_write|{"path":"spoof.txt","content":"x"}', "--port", port]);
      expect(r.out).toContain("harness-blocked");
      expect(r.out).toContain('"outcome":"selected"');
      expect(r.out).toContain('"optionId":"no"');
      expect(existsSync(workspaceFile("spoof.txt"))).toBe(false);
      expect(running?.gateway.approvals.list()).toHaveLength(0);
    } finally {
      delete process.env["FAKE_CLAIM"];
    }
  }, 30_000);

  it("with tools switched off the model gets no tools at all", async () => {
    await runSetup({ dataDir: dir, out: () => undefined });
    configure();
    running = await startFromConfig({ dataDir: dir, io: fakeIo(), port: 0, bridgeTools: false });
    const port = String(running.port);
    const r = await cli(["chat", "list", "--port", port]);
    expect(r.out).toContain("no mcp server was offered");
  }, 30_000);

  it("the bridge refuses to run by hand without a credential", async () => {
    const io = fakeIo();
    const code = await main(["mcp-bridge"], io);
    expect(code).toBe(2);
    expect(io.errText).toContain("not meant to be run by hand");
  });
});

describe("plugins from the command line", () => {
  const SAMPLE = fileURLToPath(new URL("../../../extensions/hello-tool", import.meta.url));

  it("install, review, enable only with --yes, use a tool, disable, remove", async () => {
    await runSetup({ dataDir: dir, out: () => undefined });
    const port = String(await start(true));
    const p = (...a: string[]) => cli([...a, "--port", port]);

    expect((await p("plugins", "list")).out).toContain("No plugins installed");
    const inst = await p("plugins", "install", SAMPLE);
    expect(inst.code).toBe(0);
    expect(inst.out).toContain("Nothing has been run and it is not enabled");
    expect(inst.out).toContain("cannot start programs (enforced)");
    expect(inst.out).toContain("not signed");

    const review = await p("plugins", "enable", "hello-tool");
    expect(review.code).toBe(1);
    expect(review.err).toContain("CONFIRM_REQUIRED");
    expect(review.out).toContain("it will be allowed to");
    expect((await p("plugins", "list")).out).toMatch(/hello-tool\s+disabled/);

    const on = await p("plugins", "enable", "hello-tool", "--yes");
    expect(on.code).toBe(0);
    expect(on.out).toContain("hello-tool.greet");
    expect((await p("plugins", "list")).out).toMatch(/hello-tool\s+running/);

    const call = await p("tool", "call", "hello-tool.greet", "--args", '{"name":"CLI"}');
    expect(call.out).toContain("Hello, CLI!");

    expect((await p("plugins", "disable", "hello-tool")).out).toContain("Disabled");
    expect((await p("tool", "call", "hello-tool.greet", "--args", '{"name":"x"}')).out).toContain("UNKNOWN_TOOL");
    const rm = await p("plugins", "remove", "hello-tool");
    expect(rm.out).toContain("data folder was kept");
    expect((await p("plugins", "list")).out).toContain("No plugins installed");
  }, 60_000);

  it("explains a bad folder and an unknown command", async () => {
    await runSetup({ dataDir: dir, out: () => undefined });
    const port = String(await start(true));
    const bad = await cli(["plugins", "install", join(base, "nothing-here"), "--port", port]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("PLUGIN.INVALID");
    expect(bad.err).toContain("Fix:");
    expect((await cli(["plugins", "frobnicate", "--port", port])).err).toContain("USAGE");
  });
});

describe("WebChat from the command line", () => {
  it("webchat link prints a one-time link; opening it makes that browser the owner and it can chat", async () => {
    await runSetup({ dataDir: dir, out: () => undefined });
    const port = String(await start(true));
    const p = (...a: string[]) => cli([...a, "--port", port]);

    const ch = await p("channels");
    expect(ch.out).toMatch(/webchat\s+connected/);

    const link = await p("webchat", "link");
    expect(link.code).toBe(0);
    const url = /http:\/\/127\.0\.0\.1:\d+\/webchat#owner=(cno_[A-Za-z0-9_-]+)/.exec(link.out);
    expect(url).toBeTruthy();
    expect(link.out).toContain("do not share it");

    const { default: WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/webchat`);
    const frames: Array<Record<string, unknown>> = [];
    ws.on("message", (d) => frames.push(JSON.parse(d.toString()) as Record<string, unknown>));
    await new Promise<void>((r) => ws.once("open", () => r()));
    ws.send(JSON.stringify({ t: "hello", secret: null, redeem: url![1] }));
    const waitFor = async (pred: () => boolean): Promise<void> => {
      for (let i = 0; i < 400 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
      expect(pred()).toBe(true);
    };
    await waitFor(() => frames.some((f) => f.t === "ready"));
    expect(frames[0]).toMatchObject({ role: "owner", redeemed: true });
    ws.send(JSON.stringify({ t: "message", id: "cli-test-0001", text: "hello from the browser" }));
    await waitFor(() => frames.some((f) => f.t === "message" && String(f.text).includes("echo: hello from the browser")));
    ws.close();

    const listed = await p("pairing", "list", "--json");
    expect(JSON.parse(listed.out).senders[0]).toMatchObject({ channel: "webchat", role: "owner", status: "paired" });
  }, 30_000);

  it("pairing owner registers your own identity on another channel", async () => {
    await runSetup({ dataDir: dir, out: () => undefined });
    const port = String(await start(true));
    const r = await cli(["pairing", "owner", "telegram", "424242", "--port", port]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("telegram:424242");
    expect((await cli(["pairing", "owner", "telegram", "--port", port])).err).toContain("USAGE");
    expect((await cli(["webchat", "nope", "--port", port])).err).toContain("USAGE");
  });
});

describe("memory from the command line", () => {
  it("writes, shows, lists, exports and erases notes, as plain files you can also edit by hand", async () => {
    await runSetup({ dataDir: dir, out: () => undefined });
    const port = String(await start(true));
    const m = (...a: string[]): Promise<{ code: number; out: string; err: string }> => cli([...a, "--port", port]);

    expect((await m("memory", "path")).out).toContain(join(dir, "memory"));
    expect((await m("memory", "list")).out).toContain("No your notes yet");
    expect((await m("memory", "write", "preferences", "--text", "Likes short answers")).out).toContain("Saved preferences");
    expect((await m("memory", "write", "preferences", "--text", "Metric units", "--append")).code).toBe(0);
    expect((await m("memory", "write", "likes", "--contact", "telegram:1001", "--text", "tea")).code).toBe(0);
    expect(readFileSync(join(dir, "memory", "owner", "preferences.md"), "utf8")).toBe("Likes short answers\nMetric units\n");

    expect((await m("memory", "show", "preferences")).out).toBe("Likes short answers\nMetric units\n");
    expect((await m("memory", "list")).out).toMatch(/preferences\s+\d+ bytes/);
    expect((await m("memory", "show", "likes", "--contact", "telegram:1001")).out).toBe("tea\n");
    expect((await m("memory", "contacts")).out).toMatch(/\(you\)[\s\S]*telegram:1001/);

    // a note typed in an editor is seen without a restart
    writeFileSync(join(dir, "memory", "owner", "handmade.md"), "from my editor\n");
    expect((await m("memory", "show", "handmade")).out).toBe("from my editor\n");

    const out = join(base, "export");
    expect((await m("memory", "export", out)).out).toContain("Exported 3 notes");
    expect(readFileSync(join(out, "owner", "preferences.md"), "utf8")).toBe("Likes short answers\nMetric units\n");
    expect(readFileSync(join(out, "contacts", "telegram", "1001", "likes.md"), "utf8")).toBe("tea\n");
    expect((await m("memory", "export", out)).err).toContain("EXISTS");

    // erasing needs an explicit target and an explicit yes
    expect((await m("memory", "erase")).err).toContain("USAGE");
    expect((await m("memory", "erase", "--all")).err).toContain("CONFIRM_REQUIRED");
    expect(existsSync(join(dir, "memory", "owner", "preferences.md"))).toBe(true);
    expect((await m("memory", "erase", "--contact", "telegram:1001", "--yes")).out).toContain("Erased 1 notes");
    expect((await m("memory", "contacts")).out).not.toContain("1001");
    expect((await m("memory", "erase", "--all", "--yes")).out).toContain("Erased 2 notes");
    expect(existsSync(join(dir, "memory"))).toBe(false);

    expect((await m("memory", "write", "Bad Name", "--text", "x")).err).toContain("MEMORY.INVALID");
    expect((await m("memory", "write", "n")).err).toContain("USAGE");
    expect((await m("memory", "show", "x", "--contact", "nocolon")).err).toContain("USAGE");
  }, 30_000);

  it("travels in a backup and comes back on restore", async () => {
    await runSetup({ dataDir: dir, out: () => undefined });
    const db = openDb(join(dir, "gateway.db"));
    db.close();
    mkdirSync(join(dir, "memory", "owner"), { recursive: true });
    writeFileSync(join(dir, "memory", "owner", "prefs.md"), "Likes short answers\n");
    const out = join(base, "bk");
    const manifest = createBackup(dir, out);
    expect(manifest.files.map((f) => f.name)).toContain("memory/owner/prefs.md");
    rmSync(dir, { recursive: true, force: true });
    await restoreBackup(out, dir, { port: 59993 });
    expect(readFileSync(join(dir, "memory", "owner", "prefs.md"), "utf8")).toBe("Likes short answers\n");
  });
});

describe("plugin settings and secrets from the command line", () => {
  const SECRET = "bot-secret-0123456789";

  function writePlugin(): string {
    const src = join(base, "needs-token");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "clawnexus.plugin.json"),
      JSON.stringify({
        id: "needs-token",
        name: "Needs a token",
        version: "1.0.0",
        kind: "code",
        sdkRange: "^0.3.0",
        entry: "index.mjs",
        permissions: { secrets: ["token"] },
        configSchema: { region: { type: "string", enum: ["eu", "us"], description: "where to run" }, retries: { type: "integer", min: 0, max: 5, optional: true } },
      }),
    );
    writeFileSync(
      join(src, "index.mjs"),
      `export default { setup(ctx) { ctx.registerTool({ name: "where", description: "report settings", run: () => ({ region: ctx.config.region, retries: ctx.config.retries ?? null, token: ctx.secrets.get("token") !== undefined }) }); ctx.registerTool({ name: "leak", description: "echo the token", run: () => "token=" + ctx.secrets.get("token") }); } };`,
    );
    return src;
  }

  it("asks for the secret without taking it from the command line, keeps it encrypted, and starts the plugin when everything is set", async () => {
    await runSetup({ dataDir: dir, out: () => undefined });
    let port = String(await start(true));
    const asked: string[] = [];
    const p = async (value: string | undefined, ...a: string[]): Promise<{ code: number; out: string; err: string }> => {
      const io = fakeIo();
      if (value !== undefined) io.readSecret = (prompt: string): Promise<string> => (asked.push(prompt), Promise.resolve(value));
      const code = await main([...a, "--port", port, "--data-dir", dir], io);
      return { code, out: io.outText, err: io.errText };
    };

    expect((await p(undefined, "plugins", "install", writePlugin())).code).toBe(0);
    const enabled = await p(undefined, "plugins", "enable", "needs-token", "--yes");
    expect(enabled.code).toBe(0);
    expect(enabled.out).toContain("needs_config");
    expect(enabled.out).toContain("setting region, secret token");

    const shown = await p(undefined, "plugins", "config", "needs-token");
    expect(shown.out).toMatch(/setting region\s+\(not set\).*one of eu\/us - where to run/);
    expect(shown.out).toMatch(/secret\s+token\s+NOT SET/);

    expect((await p(undefined, "plugins", "config", "needs-token", "set", "region=mars")).err).toContain("PLUGIN.BAD_VALUE");
    expect((await p(undefined, "plugins", "config", "needs-token", "set", "retries=lots")).err).toContain("must be a number");
    const ok = await p(undefined, "plugins", "config", "needs-token", "set", "region=eu", "retries=2");
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("still needed: secret token");

    const set = await p(SECRET, "plugins", "secret", "needs-token", "set", "token");
    expect(set.code).toBe(0);
    expect(set.out).toContain("Stored token");
    expect(set.out + set.err).not.toContain(SECRET);
    expect(asked[0]).toContain("not shown");
    expect((await p(undefined, "plugins", "list")).out).toMatch(/needs-token\s+running/);

    // The plugin received both; the model-facing result never carries the raw secret.
    expect((await p(undefined, "tool", "call", "needs-token.where", "--args", "{}")).out).toMatch(/"region": "eu"[\s\S]*"retries": 2[\s\S]*"token": true/);
    const leak = await p(undefined, "tool", "call", "needs-token.leak", "--args", "{}", "--approval", "none");
    expect(leak.out + leak.err).not.toContain(SECRET);

    // At rest: encrypted, with the key in its own file; nothing in the database or the audit log.
    expect(readFileSync(join(dir, "secrets.vault"), "utf8")).not.toContain(SECRET);
    expect(existsSync(join(dir, "vault.key"))).toBe(true);
    const db = openDb(join(dir, "gateway.db"));
    try {
      expect(JSON.stringify(new EventLog(db).readSince(0, { limit: 5000 }))).not.toContain(SECRET);
      expect(JSON.stringify(db.prepare("SELECT * FROM plugin_config").all())).not.toContain(SECRET);
    } finally {
      db.close();
    }

    // The secret survives a restart, and the plugin comes back by itself.
    await running?.stop();
    running = undefined;
    port = String(await start(true));
    const again = async (...a: string[]): Promise<string> => (await p(undefined, ...a)).out;

    expect(await again("plugins", "list")).toMatch(/needs-token\s+running/);

    expect((await p(undefined, "plugins", "secret", "needs-token", "delete", "token")).out).toContain("Deleted token");
    expect(await again("plugins", "list")).toMatch(/needs-token\s+needs_config/);
    expect((await p(SECRET, "plugins", "secret", "needs-token", "set", "nope")).err).toContain("does not declare");
  }, 90_000);
});
