import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Io } from "@clawnexus/cli";
import { EventLog, openDb, type Db } from "@clawnexus/store";
import { RotatingLog, attachOperationalLog, logPath, redactText, redactValue, tailLog } from "./logfile.js";
import { LAUNCHD_LABEL, TASK_NAME, controlService, installService, planService, serviceStatus, uninstallService, type CmdResult, type RunCmd, type ServiceOptions } from "./service.js";
import { runLogsCommand, runServiceCommand } from "./servicecmd.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cn-ops-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const TOKENS = [
  "123456789:AAFake-token_ABCDEFGHIJKLMNOPQRSTUVWXYZ0",
  "xoxb-1111111111-2222222222-fakeBotTokenABCDEFGH",
  "xapp-1-A111-3333333333-fakeAppTokenABCDEFGHIJKLMNOP",
  "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  "cnb_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd",
  "MTIzNDU2Nzg5MDEyMzQ1Njc4.Gfake1.abcdefghijklmnopqrstuvwxyz0123456789ABCD",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r",
  "Bearer abcdefghijklmnopqrstuvwxyz012345",
  "0123456789abcdef0123456789abcdef0123456789abcdef",
];

describe("log redaction", () => {
  it("removes every kind of credential, wherever it appears", () => {
    for (const t of TOKENS) {
      const out = redactText(`failed with ${t} in the middle`);
      expect(out, t).not.toContain(t.split(/\s/).pop()!);
      expect(out).toContain("[redacted]");
    }
  });

  it("keeps ordinary text, ids and file paths readable", () => {
    const text = "session s_0123456789abcdef on /home/someone/.local/share/clawnexus/memory/contacts/ch-telegram/c-1001 port 7391";
    expect(redactText(text)).toBe(text);
  });

  it("drops people's words and arguments, and hides values under secret-looking names", () => {
    const out = redactValue({ tool: "fs.read", args: { path: "/secret/plan" }, text: "private words", content: "x", reply: "y", apiKey: "k", nested: { password: "p", ok: "fine" } });
    expect(out).toEqual({ tool: "fs.read", apiKey: "[redacted]", nested: { password: "[redacted]", ok: "fine" } });
  });

  it("cuts very long values", () => {
    expect(String(redactValue("x ".repeat(500))).length).toBeLessThan(310);
  });
});

describe("RotatingLog", () => {
  const lines = (p: string): Array<Record<string, unknown>> => readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

  it("writes one JSON object per line with a time, a level and a message, and never a credential", () => {
    const log = new RotatingLog(join(dir, "logs", "g.log"), { now: () => Date.UTC(2026, 0, 2, 3, 4, 5) });
    log.write("info", "hello", { n: 1 });
    log.write("error", `bad ${TOKENS[0]}`, { token: TOKENS[1], note: `using ${TOKENS[2]}` });
    const [a, b] = lines(join(dir, "logs", "g.log"));
    expect(a).toEqual({ ts: "2026-01-02T03:04:05.000Z", level: "info", msg: "hello", n: 1 });
    expect(JSON.stringify(b)).not.toMatch(/AAFake|fakeBotToken|fakeAppToken/);
    if (process.platform !== "win32") expect(statSync(join(dir, "logs", "g.log")).mode & 0o077).toBe(0);
  });

  it("rotates by size, keeps a fixed number of old files, and drops the oldest", () => {
    const p = join(dir, "g.log");
    const log = new RotatingLog(p, { maxBytes: 400, keep: 2 });
    for (let i = 0; i < 40; i++) log.write("info", `entry ${String(i).padStart(2, "0")}`);
    expect(readdirSync(dir).sort()).toEqual(["g.log", "g.log.1", "g.log.2"]);
    for (const f of readdirSync(dir)) expect(statSync(join(dir, f)).size).toBeLessThanOrEqual(400);
    // newest entries are in the current file; older ones in .1 then .2
    expect(String(lines(p).at(-1)?.["msg"])).toBe("entry 39");
    expect(String(lines(`${p}.1`).at(-1)?.["msg"])).toMatch(/entry (2|3)\d/);
    expect(tailLog(p, 5).map((l) => (JSON.parse(l) as { msg: string }).msg)).toEqual(["entry 35", "entry 36", "entry 37", "entry 38", "entry 39"]);
    // a read that needs more than the current file continues into the rotated ones, in order
    const many = tailLog(p, 30).map((l) => (JSON.parse(l) as { msg: string }).msg);
    expect(many.at(-1)).toBe("entry 39");
    expect([...many].sort()).toEqual(many);
  });

  it("picks up the size of an existing file, so a restart does not overshoot", () => {
    const p = join(dir, "g.log");
    writeFileSync(p, "x".repeat(380));
    const log = new RotatingLog(p, { maxBytes: 400, keep: 1 });
    log.write("info", "after restart");
    expect(existsSync(`${p}.1`)).toBe(true);
    expect(readFileSync(p, "utf8")).toContain("after restart");
  });

  it("never throws, even when it cannot write", () => {
    writeFileSync(join(dir, "blocker"), "a file, not a folder");
    const log = new RotatingLog(join(dir, "ok.log"));
    const bad = Object.assign(log, { path: join(dir, "blocker", "x.log") });
    expect(() => bad.write("info", "still fine")).not.toThrow();
  });
});

describe("operational log from events", () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(join(dir, "g.db"));
  });
  afterEach(() => db.close());

  it("records what happened but not what was said", () => {
    const events = new EventLog(db);
    const log = new RotatingLog(logPath(dir));
    const stop = attachOperationalLog(events, log);
    events.append([
      { type: "gateway.started", data: { version: "1.2.3" } },
      { type: "message.inbound", session: "s_1", data: { text: "my private words", sender: "ann" } },
      { type: "run.delta", session: "s_1", data: { text: "streamed words" } },
      { type: "tool.started", session: "s_1", data: { tool: "fs.read", args: "{\"path\":\"/x\"}" } },
      { type: "tool.denied", session: "s_1", data: { tool: "exec.run", reason: "guest profile does not allow this tool", args: "secret args" } },
      { type: "vault.unavailable", data: { reason: "could not open" } },
      { type: "approval.requested", data: { id: "a1", tool: "fs.write", args: "{\"content\":\"hidden\"}" } },
    ]);
    stop();
    events.append([{ type: "gateway.late", data: {} }]);
    const text = readFileSync(logPath(dir), "utf8");
    const rows = text.trim().split("\n").map((l) => JSON.parse(l) as { level: string; msg: string; session?: string });
    expect(rows.map((r) => r.msg)).toEqual(["gateway.started", "tool.denied", "vault.unavailable", "approval.requested"]);
    expect(rows.find((r) => r.msg === "tool.denied")).toMatchObject({ level: "warn", session: "s_1" });
    expect(rows.find((r) => r.msg === "vault.unavailable")?.level).toBe("error");
    for (const secret of ["private words", "streamed words", "secret args", "hidden", "/x"]) expect(text).not.toContain(secret);
  });
});

// ---------------- services ----------------

const base = (platform: NodeJS.Platform, extra: Partial<ServiceOptions> = {}): ServiceOptions =>
  platform === "win32"
    ? { platform, home: "C:\\Users\\Ann", env: { USERNAME: "Ann", USERDOMAIN: "PC", PATH: "C:\\Windows" }, node: "C:\\Program Files\\nodejs\\node.exe", script: "C:\\Apps\\clawnexus\\dist\\main.js", dataDir: "C:\\Users\\Ann\\AppData\\Roaming\\clawnexus", ...extra }
    : { platform, home: "/home/ann", env: { USER: "ann", PATH: "/usr/local/bin:/usr/bin" }, node: "/usr/bin/node", script: "/opt/clawnexus/dist/main.js", dataDir: "/home/ann/.local/share/clawnexus", uid: 1000, ...extra };

describe("service definitions", () => {
  it("systemd: a user unit that starts the Gateway, restarts it on failure, and carries no secret", () => {
    const plan = planService(base("linux", { port: 7400 }));
    const f = plan.files[0]!;
    expect(f.path).toBe("/home/ann/.config/systemd/user/clawnexus.service");
    const text = String(f.content);
    expect(text).toContain('ExecStart="/usr/bin/node" "/opt/clawnexus/dist/main.js" "gateway" "run" "--data-dir" "/home/ann/.local/share/clawnexus" "--port" "7400"');
    expect(text).toMatch(/Restart=on-failure/);
    expect(text).toMatch(/WantedBy=default.target/);
    expect(text).toMatch(/NoNewPrivileges=yes/);
    expect(text).toContain('Environment="PATH=/usr/local/bin:/usr/bin"');
    expect(plan.install.map((c) => c.args.join(" "))).toEqual(["--user daemon-reload", "--user enable --now clawnexus.service"]);
  });

  it("systemd: spaces, quotes, percent signs and dollar signs in paths cannot change the command", () => {
    const text = String(planService(base("linux", { dataDir: "/home/ann/my \"data\" 100% $HOME" })).files[0]!.content);
    expect(text).toContain('"/home/ann/my \\"data\\" 100%% $$HOME"');
    expect(text.split("\n").filter((l) => l.startsWith("ExecStart="))).toHaveLength(1);
  });

  it("launchd: an agent with a label, restart on failure, log files, and everything escaped", () => {
    const plan = planService(base("darwin", { home: "/Users/ann", dataDir: "/Users/ann/Library/Application Support/clawnexus & <co>", uid: 501, env: { PATH: "/opt/homebrew/bin:/usr/bin" } }));
    const text = String(plan.files[0]!.content);
    expect(plan.files[0]!.path).toBe(`/Users/ann/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`);
    expect(text).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(text).toContain("<string>/Users/ann/Library/Application Support/clawnexus &amp; &lt;co&gt;</string>");
    expect(text).not.toContain("& <co>");
    expect(text).toMatch(/RunAtLoad[\s\S]*<true\/>/);
    expect(text).toMatch(/SuccessfulExit[\s\S]*<false\/>/);
    expect(text).toContain("launchd.err.log");
    expect(plan.install.map((c) => `${c.cmd} ${c.args.join(" ")}`)).toEqual([`launchctl bootout gui/501/${LAUNCHD_LABEL}`, `launchctl bootstrap gui/501 /Users/ann/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`]);
  });

  it("Windows: a per-user logon task, no administrator rights, restarted on failure, with quoting that survives an apostrophe in a path", () => {
    const plan = planService(base("win32", { dataDir: "C:\\Users\\O'Brien & Co\\data" }));
    const buf = plan.files[0]!.content as Buffer;
    expect([buf[0], buf[1]]).toEqual([0xff, 0xfe]); // UTF-16 byte-order mark
    const xml = buf.subarray(2).toString("utf16le");
    expect(xml).toContain('encoding="UTF-16"');
    expect(xml).toContain("<UserId>PC\\Ann</UserId>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).toContain("<LogonTrigger>");
    expect(xml).toContain("<Count>999</Count>");
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    // the apostrophe is doubled for PowerShell and the whole thing is escaped for XML
    expect(xml).toContain("&apos;C:\\Users\\O&apos;&apos;Brien &amp; Co\\data&apos;");
    expect(xml).toContain("exit $LASTEXITCODE");
    expect(plan.install[0]!.args).toEqual(["/Create", "/TN", TASK_NAME, "/XML", "C:\\Users\\O'Brien & Co\\data\\service\\gateway-task.xml", "/F"]);
  });

  it("refuses relative paths, control characters, bad ports and systems it does not know", () => {
    expect(() => planService(base("linux", { dataDir: "relative/dir" }))).toThrow(/absolute/);
    expect(() => planService(base("linux", { dataDir: "/tmp/a\nb" }))).toThrow(/control/);
    expect(() => planService(base("linux", { port: 70000 }))).toThrow(/invalid port/);
    expect(() => planService(base("freebsd" as NodeJS.Platform))).toThrow(/no background service support/);
    expect(() => planService(base("win32", { env: {} }))).toThrow(/USERNAME/);
  });
});

describe("installing and removing", () => {
  const fake = (answers: Record<string, Partial<CmdResult>> = {}): { run: RunCmd; calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      run: async (cmd, args) => {
        const key = `${cmd} ${args.join(" ")}`;
        calls.push(key);
        const hit = Object.entries(answers).find(([k]) => key.startsWith(k));
        return { code: 0, stdout: "", stderr: "", ...(hit?.[1] ?? {}) };
      },
    };
  };
  const opts = (): ServiceOptions => {
    const script = join(dir, "dist", "main.js");
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(script, "// program");
    return { platform: "linux", home: join(dir, "home"), env: { PATH: "/usr/bin" }, node: "/usr/bin/node", script, dataDir: join(dir, "data"), uid: 1000 };
  };

  it("writes the definition privately, registers it, and reports what it did", async () => {
    const f = fake();
    const o = opts();
    const r = await installService(o, f.run);
    expect(f.calls).toEqual(["systemctl --user daemon-reload", "systemctl --user enable --now clawnexus.service"]);
    expect(existsSync(r.files[0]!)).toBe(true);
    expect(existsSync(join(o.dataDir, "logs"))).toBe(true);
    expect(r.hints.join(" ")).toMatch(/enable-linger/);
  });

  it("on Windows registers the task and then starts it", async () => {
    const f = fake();
    const o = { ...opts(), platform: "win32" as const, env: { USERNAME: "Ann", USERDOMAIN: "PC" }, node: join(dir, "node.exe") };
    await installService(o, f.run);
    expect(f.calls.map((c) => c.split(" ").slice(0, 3).join(" "))).toEqual([`schtasks /Create /TN`, `schtasks /Run /TN`]);
  });

  it("explains a failure in one line and says what to run to see more", async () => {
    const f = fake({ "systemctl --user enable": { code: 1, stderr: "Failed to connect to bus: No medium found\nsecond line" } });
    await expect(installService(opts(), f.run)).rejects.toMatchObject({ code: "SERVICE_FAILED", message: expect.stringContaining("Failed to connect to bus") });
  });

  it("refuses when the program it would run is missing", async () => {
    const o = { ...opts(), script: join(dir, "nowhere", "main.js") };
    await expect(installService(o, fake().run)).rejects.toMatchObject({ code: "NO_PROGRAM" });
  });

  it("removes the definition, leaves the data alone, and is harmless to repeat", async () => {
    const f = fake();
    const o = opts();
    mkdirSync(o.dataDir, { recursive: true });
    writeFileSync(join(o.dataDir, "gateway.db"), "keep me");
    await installService(o, f.run);
    const r1 = await uninstallService(o, f.run);
    expect(r1.wasInstalled).toBe(true);
    expect(existsSync(join(o.home, ".config", "systemd", "user", "clawnexus.service"))).toBe(false);
    expect(readFileSync(join(o.dataDir, "gateway.db"), "utf8")).toBe("keep me");
    const g = fake({ "systemctl --user cat": { code: 1 } });
    const r2 = await uninstallService(o, g.run);
    expect(r2.wasInstalled).toBe(false);
    expect(g.calls).toEqual(["systemctl --user cat clawnexus.service"]);
  });

  it("starts and stops only something that is installed", async () => {
    const o = opts();
    await expect(controlService("start", o, fake({ "systemctl --user cat": { code: 1 } }).run)).rejects.toMatchObject({ code: "NOT_INSTALLED" });
    const f = fake();
    await controlService("stop", o, f.run);
    expect(f.calls.at(-1)).toBe("systemctl --user stop clawnexus.service");
  });

  it("notices a service that points at a different program or data folder", async () => {
    const o = opts();
    const f = fake();
    await installService(o, f.run);
    expect((await serviceStatus(o, f.run)).problems).toEqual([]);
    const moved = { ...o, dataDir: join(dir, "elsewhere") };
    expect((await serviceStatus(moved, f.run)).problems).toEqual(["the service uses a different data directory than this one"]);
    const other = { ...o, node: "/opt/other/node" };
    expect((await serviceStatus(other, f.run)).problems.join(" ")).toMatch(/different node program/);
    const gone = fake({ "systemctl --user cat": { code: 1 } });
    rmSync(join(o.home, ".config", "systemd", "user", "clawnexus.service"));
    expect((await serviceStatus(o, gone.run)).installed).toBe(false);
  });
});

describe("service and logs commands", () => {
  const io = (): Io & { text: string } => {
    const x = { text: "", out: (s: string) => void (x.text += s), err: (s: string) => void (x.text += s), env: { PATH: "/usr/bin" }, platform: "linux" as NodeJS.Platform, home: join(dir, "home") };
    return x;
  };
  const run: RunCmd = async () => ({ code: 0, stdout: "", stderr: "" });
  const script = (): string => {
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "main.js"), "//");
    return join(dir, "dist", "main.js");
  };

  it("will not install before setup", async () => {
    await expect(runServiceCommand({ sub: "install", dataDir: join(dir, "data"), io: io(), json: false, run, script: script(), node: "/usr/bin/node", uid: 1000 })).rejects.toMatchObject({ code: "NOT_SET_UP" });
  });

  it("installs, reports status as JSON, and uninstalls", async () => {
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data", "gateway.token"), "t");
    const o = { dataDir: join(dir, "data"), run, script: script(), node: "/usr/bin/node", uid: 1000, port: 59990 };
    const a = io();
    expect(await runServiceCommand({ ...o, sub: "install", io: a, json: false })).toBe(0);
    expect(a.text).toMatch(/Installed the systemd service "clawnexus.service"/);
    const b = io();
    expect(await runServiceCommand({ ...o, sub: "status", io: b, json: true })).toBe(0);
    expect(JSON.parse(b.text)).toMatchObject({ kind: "systemd", installed: true, problems: [], gatewayAnswering: false });
    const c = io();
    expect(await runServiceCommand({ ...o, sub: "uninstall", io: c, json: false })).toBe(0);
    expect(c.text).toMatch(/Your data .* was not touched/);
    await expect(runServiceCommand({ ...o, sub: "frobnicate", io: io(), json: false })).rejects.toMatchObject({ code: "USAGE" });
  });

  it("prints the log readably, or raw as JSON lines", () => {
    new RotatingLog(logPath(dir)).write("warn", "tool.denied", { session: "s_1" });
    const a = io();
    expect(runLogsCommand({ dataDir: dir, io: a, json: false, lines: 10 })).toBe(0);
    expect(a.text).toMatch(/WARN\s+tool.denied \{"session":"s_1"\}/);
    const b = io();
    runLogsCommand({ dataDir: dir, io: b, json: true, lines: 10 });
    expect(JSON.parse(b.text.trim())).toMatchObject({ level: "warn", msg: "tool.denied" });
    const c = io();
    runLogsCommand({ dataDir: join(dir, "empty"), io: c, json: false, lines: 10 });
    expect(c.text).toMatch(/No log yet/);
  });
});
