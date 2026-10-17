import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Io } from "@clawnexus/cli";
import { LocalVault } from "@clawnexus/vault";
import { createBackup, restoreBackup } from "./backup.js";
import { runDoctor } from "./doctor.js";
import { main } from "./main.js";
import { startFromConfig, type Running } from "./serve.js";
import { runSetup } from "./setup.js";

let base: string;
let dir: string;
let running: Running | undefined;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "cn-bk-"));
  dir = join(base, "data");
});
afterEach(async () => {
  await running?.stop();
  running = undefined;
  rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const io = (): Io & { text: string } => {
  const x = { text: "", out: (s: string) => void (x.text += s), err: (s: string) => void (x.text += s), env: {} as Record<string, string | undefined>, platform: process.platform, home: base };
  return x;
};
const cli = async (args: string[], d = dir): Promise<{ code: number; text: string }> => {
  const i = io();
  const code = await main([...args, "--data-dir", d], i);
  return { code, text: i.text };
};
const names = (m: { files: Array<{ name: string }> }): string[] => m.files.map((f) => f.name).sort();

async function seedPluginAndSecret(): Promise<void> {
  await runSetup({ dataDir: dir, out: () => undefined });
  mkdirSync(join(dir, "plugins", "demo"), { recursive: true });
  writeFileSync(join(dir, "plugins", "demo", "clawnexus.plugin.json"), '{"id":"demo"}');
  writeFileSync(join(dir, "plugins", "demo", "index.mjs"), "export default {};");
  mkdirSync(join(dir, "plugins", ".install-abc123"), { recursive: true }); // an interrupted install
  writeFileSync(join(dir, "plugins", ".install-abc123", "junk"), "x");
  mkdirSync(join(dir, "plugin-data", "demo"), { recursive: true });
  writeFileSync(join(dir, "plugin-data", "demo", "state.json"), '{"cursor":42}');
  const v = new LocalVault(dir);
  await v.open();
  v.set("plugin.demo.token", "s3cret-value-123");
  v.close();
}

describe("backing up plugins and their state", () => {
  it("includes installed plugins and their data, skips interrupted installs, and leaves the vault key out by default", async () => {
    await seedPluginAndSecret();
    const m = createBackup(dir, join(base, "bk"));
    expect(names(m)).toEqual(expect.arrayContaining(["plugins/demo/clawnexus.plugin.json", "plugins/demo/index.mjs", "plugin-data/demo/state.json", "secrets.vault", "gateway.db"]));
    expect(names(m).some((n) => n.includes(".install-"))).toBe(false);
    expect(names(m)).not.toContain("vault.key");
    expect(existsSync(join(base, "bk", "vault.key"))).toBe(false);
    expect(readFileSync(join(base, "bk", "secrets.vault"), "utf8")).not.toContain("s3cret-value-123");
  });

  it("puts the vault key in only when asked, and says so", async () => {
    await seedPluginAndSecret();
    const plain = await cli(["backup", "--out", join(base, "a")]);
    expect(plain.text).toMatch(/key is not; after a restore, enter them again/);
    const keyed = await cli(["backup", "--out", join(base, "b"), "--include-key"]);
    expect(keyed.text).toMatch(/WARNING: the vault key IS included/);
    expect(existsSync(join(base, "b", "vault.key"))).toBe(true);
    expect(existsSync(join(base, "a", "vault.key"))).toBe(false);
  });

  it("restores plugins and their state on a clean computer, and the secrets too when the key came along", async () => {
    await seedPluginAndSecret();
    createBackup(dir, join(base, "bk"), { includeKey: true });
    const fresh = join(base, "fresh");
    const r = await restoreBackup(join(base, "bk"), fresh, { port: 59971 });
    expect(r.vault).toBe("restored");
    expect(readFileSync(join(fresh, "plugins", "demo", "index.mjs"), "utf8")).toBe("export default {};");
    expect(readFileSync(join(fresh, "plugin-data", "demo", "state.json"), "utf8")).toBe('{"cursor":42}');
    const v = new LocalVault(fresh);
    await v.open();
    expect(v.get("plugin.demo.token")).toBe("s3cret-value-123");
    v.close();
    expect((await runDoctor({ dataDir: fresh, fix: false, port: 59971 })).find((c) => c.id === "vault")).toBeUndefined();
  });

  it("without the key, sets the unreadable secrets aside so a new vault can be made, and says so", async () => {
    await seedPluginAndSecret();
    createBackup(dir, join(base, "bk"));
    const fresh = join(base, "fresh");
    const r = await restoreBackup(join(base, "bk"), fresh, { port: 59971, now: () => 5 });
    expect(r.vault).toBe("set-aside");
    expect(existsSync(join(fresh, "secrets.vault"))).toBe(false);
    expect(existsSync(join(fresh, "secrets.vault.unreadable-5"))).toBe(true);
    expect(readFileSync(join(fresh, "plugins", "demo", "index.mjs"), "utf8")).toBe("export default {};"); // the plugin itself came back
    // a new vault works, so the owner can enter the secret again
    const v = new LocalVault(fresh);
    await v.open();
    v.set("plugin.demo.token", "again");
    expect(v.get("plugin.demo.token")).toBe("again");
    v.close();
    const said = await cli(["restore", join(base, "bk"), "--force"], join(base, "fresh2"));
    expect(said.text).toMatch(/secrets cannot be opened here.*plugins secret/);
  });

  it("replaces the plugin folder as a whole and keeps what was there, so no stale file can change approved code", async () => {
    await seedPluginAndSecret();
    createBackup(dir, join(base, "bk"), { includeKey: true });
    writeFileSync(join(dir, "plugins", "demo", "extra.mjs"), "// added after the backup");
    mkdirSync(join(dir, "plugins", "other"), { recursive: true });
    writeFileSync(join(dir, "plugins", "other", "x"), "x");
    const r = await restoreBackup(join(base, "bk"), dir, { force: true, port: 59971, now: () => 7 });
    expect(readdirSync(join(dir, "plugins")).sort()).toEqual(["demo"]); // exactly the backed-up plugins
    expect(existsSync(join(dir, "plugins", "demo", "extra.mjs"))).toBe(false);
    expect(r.setAside).toContain(join(dir, "plugins.before-restore-7"));
    expect(readFileSync(join(dir, "plugins.before-restore-7", "demo", "extra.mjs"), "utf8")).toBe("// added after the backup");
    expect(existsSync(join(dir, "plugins.before-restore-7", "other", "x"))).toBe(true);
  });

  it("warns when a vault has lost its key", async () => {
    await seedPluginAndSecret();
    rmSync(join(dir, "vault.key"));
    const c = (await runDoctor({ dataDir: dir, fix: false, port: 59971 })).find((x) => x.id === "vault");
    expect(c).toMatchObject({ status: "fail", fix: expect.stringMatching(/plugins secret/) });
  });
});

describe("a plugin survives a backup and restore", () => {
  it("is still enabled and runs on the restored computer, because the code it was approved for is unchanged", async () => {
    await runSetup({ dataDir: dir, out: () => undefined });
    running = await startFromConfig({ dataDir: dir, io: io(), port: 0, fakeProvider: true });
    const p = String(running.port);
    expect((await cli(["plugins", "install", "hello-tool", "--port", p])).code).toBe(0);
    expect((await cli(["plugins", "enable", "hello-tool", "--yes", "--port", p])).code).toBe(0);
    expect((await cli(["tool", "call", "hello-tool.greet", "--args", '{"name":"before"}', "--port", p])).text).toContain("Hello, before!");
    await running.stop();
    running = undefined;

    createBackup(dir, join(base, "bk"));
    const fresh = join(base, "fresh");
    await restoreBackup(join(base, "bk"), fresh, { port: 59971 });
    running = await startFromConfig({ dataDir: fresh, io: io(), port: 0, fakeProvider: true });
    const p2 = String(running.port);
    expect((await cli(["plugins", "list", "--port", p2], fresh)).text).toMatch(/hello-tool\s+running/);
    expect((await cli(["tool", "call", "hello-tool.greet", "--args", '{"name":"after"}', "--port", p2], fresh)).text).toContain("Hello, after!");
  }, 60_000);
});

describe("the outbox from the command line", () => {
  it("shows what is waiting and what gave up (never the text), and can retry or purge it", async () => {
    await runSetup({ dataDir: dir, out: () => undefined });
    running = await startFromConfig({ dataDir: dir, io: io(), port: 0, fakeProvider: true });
    const p = String(running.port);
    const outbox = running.gateway.channels.outbox;
    expect((await cli(["channels", "outbox", "--port", p])).text).toMatch(/outbox is empty/);

    outbox.enqueue({ channel: "ghost", accountId: "default", conversationId: "c1" }, ["a private answer"]);
    outbox.enqueue({ channel: "ghost", accountId: "default", conversationId: "c2" }, ["another answer"]);
    outbox.failGroup(outbox.head("ghost", "default", "c2")!.group, "Telegram: chat not found");
    const shown = await cli(["channels", "outbox", "--port", p]);
    expect(shown.text).toMatch(/ghost\s+1 waiting, 1 gave up/);
    expect(shown.text).toMatch(/Telegram: chat not found/);
    expect(shown.text).not.toMatch(/private answer|another answer/);

    expect((await cli(["channels", "outbox", "retry", "--port", p])).text).toMatch(/Put 1 failed message/);
    expect(outbox.summary()).toMatchObject({ pending: 2, failed: 0 });
    outbox.failGroup(outbox.head("ghost", "default", "c2")!.group, "again");
    expect((await cli(["channels", "outbox", "purge", "--port", p])).text).toMatch(/Deleted 1 message/);
    expect((await cli(["channels", "outbox", "purge", "--all", "--port", p])).text).toMatch(/Deleted 1 message/);
    expect((await cli(["channels", "outbox", "bogus", "--port", p])).text).toMatch(/USAGE/);
  }, 30_000);

  it("is emptied by a restore, so old answers are not sent again", async () => {
    await runSetup({ dataDir: dir, out: () => undefined });
    running = await startFromConfig({ dataDir: dir, io: io(), port: 0, fakeProvider: true });
    running.gateway.channels.outbox.enqueue({ channel: "ghost", accountId: "default", conversationId: "c1" }, ["stale answer"]);
    await running.stop();
    running = undefined;
    createBackup(dir, join(base, "bk"));
    const fresh = join(base, "fresh");
    await restoreBackup(join(base, "bk"), fresh, { port: 59971 });
    running = await startFromConfig({ dataDir: fresh, io: io(), port: 0, fakeProvider: true });
    expect(running.gateway.channels.outbox.summary()).toMatchObject({ pending: 0, failed: 0 });
  }, 30_000);
});

describe("attachments", () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("....IHDR a picture for the backup test")]);

  it("are listed in a session, saved from the command line, and travel in a backup", async () => {
    await runSetup({ dataDir: dir, out: () => undefined });
    running = await startFromConfig({ dataDir: dir, io: io(), port: 0, fakeProvider: true });
    const p = String(running.port);
    const gw = running.gateway;
    const { id } = gw.blobs.put(PNG, "image/png");
    const s = gw.sessions!.getOrCreate({ channel: "local", conversation: "main", scope: "owner" });
    gw.sessions!.send(s.id, "a picture", { sender: "owner", attachments: [{ id, name: "pic.png", mime: "image/png", bytes: PNG.length }, { name: "run.exe", dropped: "this kind of file is not accepted" }] });
    await gw.sessions!.idle();

    const shown = await cli(["sessions", "show", s.id, "--port", p]);
    expect(shown.text).toContain("file: pic.png (image/png");
    expect(shown.text).toContain(`attachment get ${id}`);
    expect(shown.text).toContain("file: run.exe (not accepted: this kind of file is not accepted)");

    const out = join(base, "saved.png");
    const got = await cli(["attachment", "get", id, "--out", out, "--port", p]);
    expect(got.text).toMatch(/Saved \d+ bytes \(image\/png\)/);
    expect(readFileSync(out)).toEqual(PNG);
    expect((await cli(["attachment", "get", id, "--out", out, "--port", p])).text).toMatch(/EXISTS/);
    expect((await cli(["attachment", "get", id, "--port", p])).text).toMatch(/USAGE/);
    expect((await cli(["attachment", "get", "0".repeat(64), "--out", join(base, "x"), "--port", p])).text).toMatch(/no such attachment/);

    await running.stop();
    running = undefined;
    const m = createBackup(dir, join(base, "bk"));
    expect(m.files.map((f) => f.name)).toContain(`blobs/${id.slice(0, 2)}/${id}`);
    const fresh = join(base, "fresh");
    await restoreBackup(join(base, "bk"), fresh, { port: 59971 });
    running = await startFromConfig({ dataDir: fresh, io: io(), port: 0, fakeProvider: true });
    expect(running.gateway.blobs.read(id)).toEqual(PNG);
    const again = await cli(["sessions", "show", s.id, "--port", String(running.port)], fresh);
    expect(again.text).toContain("file: pic.png");
  }, 60_000);
});
