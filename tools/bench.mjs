// Measures the numbers in docs/01 (NFR-PERF-1..3) against a real Gateway and prints them. Run after `pnpm build`:
//
//   node tools/bench.mjs [--check] [--json]
//
// With --check it exits non-zero when a target is missed. The Gateway runs in its own process so the memory figure is
// the Gateway's, and with a fake model so only our overhead is measured, not a model's latency. Results depend on the
// machine; the targets are written for a 2-core VM, so run it on something comparable before believing a failure.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const check = process.argv.includes("--check");
const asJson = process.argv.includes("--json");
const root = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "cn-bench-"));

const TARGETS = { idleRssMb: 250, idleCpuPct: 2, overheadP95Ms: 150, fanoutP95Ms: 200 };

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? NaN;
};
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The Gateway, in a child process, reporting its own memory and CPU on request.
const childCode = `
import { startGateway } from ${JSON.stringify(pathToFileURL(join(root, "src/gateway/dist/index.js")).href)};
import { FakeProvider } from ${JSON.stringify(pathToFileURL(join(root, "src/sessions/dist/index.js")).href)};
const started = await startGateway({ dataDir: ${JSON.stringify(dir)}, port: 0, provider: new FakeProvider({ reply: () => "ok" }) });
process.send({ ready: true, port: started.port });
process.on("message", (m) => {
  if (m === "stats") process.send({ rss: process.memoryUsage().rss, cpu: process.cpuUsage(), t: process.hrtime.bigint().toString() });
  if (m === "emit") started.gateway.events.append([{ type: "bench.tick", data: { sentAt: Date.now() } }]);
  if (m === "stop") started.gateway.stop().then(() => process.exit(0));
});
`;
const scriptPath = join(dir, "child.mjs");
writeFileSync(scriptPath, childCode);

const child = spawn(process.execPath, [scriptPath], { stdio: ["ignore", "inherit", "inherit", "ipc"], cwd: root });
const waiters = [];
child.on("message", (m) => (m.ready ? waiters.shift()?.(m) : waiters.shift()?.(m)));
const ask = (m) => new Promise((resolve) => (waiters.push(resolve), child.send(m)));
const ready = await new Promise((resolve) => waiters.push(resolve));
const port = ready.port;
const token = readFileSync(join(dir, "gateway.token"), "utf8").trim();

class Client {
  constructor(ws) {
    this.ws = ws;
    this.n = 0;
    this.waiters = new Map();
    this.onEvent = () => {};
    ws.addEventListener("message", (e) => {
      const f = JSON.parse(String(e.data));
      if (f.t === "res") this.waiters.get(f.id)?.(f);
      else if (f.t === "evt") this.onEvent(f);
    });
  }
  static async open() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`);
    await new Promise((resolve, reject) => (ws.addEventListener("open", resolve), ws.addEventListener("error", reject)));
    const c = new Client(ws);
    const r = await c.call("connection.hello", { protocol: { major: 1, minor: 0 }, client: { kind: "bench", version: "0" }, auth: { token } });
    if (!r.ok) throw new Error("hello failed");
    return c;
  }
  call(method, params) {
    const id = `b-${++this.n}`;
    return new Promise((resolve) => {
      this.waiters.set(id, resolve);
      this.ws.send(JSON.stringify({ t: "req", id, method, params }));
    });
  }
}

const results = {};
try {
  // NFR-PERF-1: idle footprint. Let start-up settle, then watch for a few seconds with nothing happening.
  await sleep(3000);
  const a = await ask("stats");
  await sleep(5000);
  const b = await ask("stats");
  const cpuMs = (b.cpu.user - a.cpu.user + (b.cpu.system - a.cpu.system)) / 1000;
  const wallMs = Number(BigInt(b.t) - BigInt(a.t)) / 1e6;
  results.idleRssMb = round(b.rss / 1048576);
  results.idleCpuPct = round((cpuMs / wallMs) * 100, 2);

  // NFR-PERF-2: from a message arriving to the first piece of the answer, with a model that answers at once.
  const c = await Client.open();
  const s = (await c.call("session.create", { channel: "local", conversation: "bench", scope: "owner" })).result.session;
  await c.call("events.subscribe", { session: s.id });
  const samples = [];
  for (let i = 0; i < 300; i++) {
    const t0 = performance.now();
    const first = new Promise((resolve) => {
      c.onEvent = (f) => {
        if (f.type === "run.started" || f.type === "run.delta" || f.type === "message.outbound") {
          c.onEvent = () => {};
          resolve(performance.now() - t0);
        }
      };
    });
    await c.call("session.send", { session: s.id, text: `message ${i}` });
    samples.push(await first);
    await sleep(5);
  }
  results.overheadP50Ms = round(pct(samples, 50), 2);
  results.overheadP95Ms = round(pct(samples, 95), 2);

  // NFR-PERF-3: 50 clients watching, 20 events a second for 10 seconds; how long each event takes to arrive.
  const watchers = await Promise.all(Array.from({ length: 50 }, () => Client.open()));
  const delays = [];
  let received = 0;
  for (const w of watchers) {
    await w.call("events.subscribe", {});
    w.onEvent = (f) => {
      if (f.type !== "bench.tick") return;
      received++;
      delays.push(Date.now() - f.data.sentAt);
    };
  }
  const total = 200;
  for (let i = 0; i < total; i++) {
    child.send("emit");
    await sleep(50);
  }
  await sleep(1000);
  results.fanoutDelivered = `${received}/${total * 50}`;
  results.fanoutP95Ms = round(pct(delays, 95), 1);
  for (const w of watchers) w.ws.close();
  c.ws.close();
} finally {
  child.send("stop");
  await sleep(500);
  child.kill();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

const rows = [
  ["NFR-PERF-1 idle memory (MB)", results.idleRssMb, `<= ${TARGETS.idleRssMb}`, results.idleRssMb <= TARGETS.idleRssMb],
  ["NFR-PERF-1 idle CPU (%)", results.idleCpuPct, `<= ${TARGETS.idleCpuPct}`, results.idleCpuPct <= TARGETS.idleCpuPct],
  ["NFR-PERF-2 message to first output, p95 (ms)", results.overheadP95Ms, `<= ${TARGETS.overheadP95Ms}`, results.overheadP95Ms <= TARGETS.overheadP95Ms],
  ["NFR-PERF-3 event delivery to 50 clients at 20/s, p95 (ms)", results.fanoutP95Ms, `<= ${TARGETS.fanoutP95Ms}`, results.fanoutP95Ms <= TARGETS.fanoutP95Ms && results.fanoutDelivered === `${200 * 50}/${200 * 50}`],
];
if (asJson) console.log(JSON.stringify({ results, targets: TARGETS, rows: rows.map(([name, value, target, ok]) => ({ name, value, target, ok })) }, null, 2));
else {
  console.log(`Node ${process.version} on ${process.platform}/${process.arch}, ${(await import("node:os")).cpus().length} CPUs`);
  for (const [name, value, target, ok] of rows) console.log(`${ok ? "ok  " : "MISS"} ${name}: ${value} (target ${target})`);
  console.log(`events delivered: ${results.fanoutDelivered}; p50 message-to-first-output: ${results.overheadP50Ms} ms`);
}
if (check && rows.some((r) => !r[3])) process.exit(1);
