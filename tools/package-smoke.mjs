// Install the built package the way a user would, in an empty folder, and use it end to end:
// no repository, no workspace, nothing but what is in the tarball.
//
//   node tools/package-smoke.mjs [PATH-TO-TGZ]
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { get } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

process.noDeprecation = true;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const win = process.platform === "win32";
const tgz = process.argv[2] ?? join(root, "release", readdirSync(join(root, "release")).find((f) => f.endsWith(".tgz")) ?? "missing.tgz");
if (!existsSync(tgz)) throw new Error(`no package at ${tgz}; run \`node tools/package.mjs\` first`);

const work = mkdtempSync(join(tmpdir(), "cn-smoke-"));
const inst = join(work, "inst");
const data = join(work, "data");
let gateway;
let failed = false;
const step = (msg) => process.stdout.write(`  ${msg}\n`);
const check = (cond, msg) => {
  if (!cond) {
    failed = true;
    process.stdout.write(`  FAIL ${msg}\n`);
    throw new Error(msg);
  }
  step(`ok   ${msg}`);
};

const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
    s.on("error", rej);
  });
const health = (port) =>
  new Promise((res) => {
    const r = get({ host: "127.0.0.1", port, path: "/healthz", timeout: 500 }, (m) => {
      m.resume();
      res(m.statusCode === 200);
    });
    r.on("error", () => res(false));
    r.on("timeout", () => (r.destroy(), res(false)));
  });
const page = (port, path) =>
  new Promise((res, rej) => {
    get({ host: "127.0.0.1", port, path }, (m) => {
      let body = "";
      m.on("data", (d) => (body += d));
      m.on("end", () => res({ status: m.statusCode, body }));
    }).on("error", rej);
  });

try {
  process.stdout.write(`Smoke test of ${tgz}\n`);
  execFileSync("npm", ["install", "--prefix", inst, tgz, "--ignore-scripts", "--no-audit", "--no-fund", "--no-save"], { stdio: "ignore", shell: win });
  const entry = join(inst, "node_modules", "clawnexus", "dist", "main.js");
  check(existsSync(entry), "installed from the tarball with no other downloads");
  check(!existsSync(join(inst, "node_modules", "ws")), "needs no other package at run time");

  const port = await freePort();
  const cli = (...a) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [entry, ...a, "--data-dir", data, "--port", String(port)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } }) };
    } catch (e) {
      return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };

  const shim = execFileSync(join(inst, "node_modules", ".bin", win ? "clawnexus.cmd" : "clawnexus"), ["--version"], { encoding: "utf8", shell: win });
  check(/clawnexus/.test(shim), "the installed command runs through npm's shim");

  check(cli("setup", "--yes").code === 0, "setup creates the data folder, config and token");

  gateway = spawn(process.execPath, [entry, "gateway", "run", "--fake-provider", "--data-dir", data, "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  let gwOut = "";
  gateway.stdout.on("data", (d) => (gwOut += d));
  gateway.stderr.on("data", (d) => (gwOut += d));
  for (let i = 0; i < 100 && !(await health(port)); i++) await new Promise((r) => setTimeout(r, 100));
  check(await health(port), "the Gateway starts");

  check(cli("status").out.includes("ok") || cli("status").code === 0, "status answers");
  check(/echo: hello/.test(cli("chat", "hello").out), "a chat message gets a reply");
  const wc = await page(port, "/webchat");
  check(wc.status === 200 && /<html/i.test(wc.body), "the WebChat page is served (its files are in the package)");

  check(cli("memory", "write", "note", "--text", "remember this").code === 0 && /remember this/.test(cli("memory", "show", "note").out), "memory saves and reads a note");

  check(cli("plugins", "install", "hello-tool").code === 0, "a plugin that ships with the program installs by name");
  check(cli("plugins", "enable", "hello-tool", "--yes").code === 0, "it can be enabled");
  const t = cli("tool", "call", "hello-tool.greet", "--args", JSON.stringify({ name: "smoke" }));
  check(/Hello, smoke!/.test(t.out), "its tool runs in its own process (the plugin shim is in the package)");
  check(cli("plugins", "install", "telegram").code === 0 && cli("plugins", "install", "discord").code === 0 && cli("plugins", "install", "slack").code === 0, "the channel plugins install by name");
  check(/gateway\.listening/.test(cli("logs").out), "the log records the start");
  check(!/[0-9]{6,}:[A-Za-z0-9_-]{30,}|xox[bp]-/.test(cli("logs", "--lines", "500").out), "and holds no credentials");
  check(cli("doctor").out.includes("database"), "doctor runs");
  const sec = cli("doctor", "--security");
  check(sec.code === 0 && sec.out.includes("sec:exposure"), "doctor --security passes on the installed default");

  const made = cli("tls", "init", "--host", "gw.example.org");
  check(made.code === 0 && /fingerprint: [0-9A-F]{2}(:[0-9A-F]{2}){31}/.test(made.out), "a certificate can be made (no openssl needed)");
  const pair = cli("devices", "pair", "--name", "smoke phone");
  check(/Pairing code: [2-9A-HJKMNP-Z]{10}/.test(pair.out), "a device can be given a pairing code");
  check(/smoke phone|No devices|pairing code/.test(cli("devices", "list").out), "devices can be listed");

  process.stdout.write("Package smoke test passed.\n");
} catch (e) {
  failed = true;
  process.stdout.write(`Package smoke test FAILED: ${e instanceof Error ? e.message : e}\n`);
} finally {
  if (gateway && gateway.exitCode === null) {
    gateway.kill();
    await new Promise((r) => gateway.once("exit", r));
  }
  // On Windows a plugin process can hold its folder for a moment after the Gateway ends. A leftover temp folder is not a
  // failure of what is being tested, so wait for it a while and then only say so.
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 60, retryDelay: 250 });
  } catch (e) {
    process.stdout.write(`  note: could not remove ${work}: ${e instanceof Error ? e.message : e}\n`);
  }
}
process.exit(failed ? 1 : 0);
