// Spike 3: cost and crash-containment of running plugins out of process.
import { fork } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const here = dirname(fileURLToPath(import.meta.url));
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
const ms = (ns) => Number(ns) / 1e6;

// 1. Startup time (spawn -> ready), child process vs worker thread
async function startChild() {
  const t = process.hrtime.bigint();
  const c = fork(join(here, "child.mjs"), [], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  await new Promise((r) => c.once("message", r));
  return { c, startMs: ms(process.hrtime.bigint() - t) };
}
const starts = [];
for (let i = 0; i < 10; i++) {
  const { c, startMs } = await startChild();
  starts.push(startMs);
  c.kill();
}
starts.sort((a, b) => a - b);

const wStarts = [];
for (let i = 0; i < 10; i++) {
  const t = process.hrtime.bigint();
  const w = new Worker("require('node:worker_threads').parentPort.postMessage('ready')", { eval: true });
  await new Promise((r) => w.once("message", r));
  wStarts.push(ms(process.hrtime.bigint() - t));
  await w.terminate();
}
wStarts.sort((a, b) => a - b);

// 2. Round-trip latency over IPC vs in-process call
const { c } = await startChild();
const pending = new Map();
c.on("message", (m) => pending.get(m.id)?.(m));
const N = 5000;
const rtt = [];
for (let i = 0; i < N; i++) {
  const t = process.hrtime.bigint();
  await new Promise((res) => {
    pending.set(i, res);
    c.send({ op: "echo", id: i, v: i });
  });
  rtt.push(ms(process.hrtime.bigint() - t));
}
rtt.sort((a, b) => a - b);
const inproc = [];
const fn = (v) => v;
for (let i = 0; i < N; i++) {
  const t = process.hrtime.bigint();
  await Promise.resolve(fn(i));
  inproc.push(ms(process.hrtime.bigint() - t));
}
inproc.sort((a, b) => a - b);

// 3. Crash containment: plugin throws; host must survive and observe the exit
const crashed = await new Promise((res) => {
  c.once("exit", (code, sig) => res({ code, sig }));
  c.send({ op: "crash" });
});
const mem = Math.round(process.memoryUsage().rss / 1048576);

console.log(
  JSON.stringify(
    {
      childProcessStartMs: { p50: +pct(starts, 50).toFixed(1), max: +starts.at(-1).toFixed(1) },
      workerThreadStartMs: { p50: +pct(wStarts, 50).toFixed(1), max: +wStarts.at(-1).toFixed(1) },
      ipcRoundTripMs: { p50: +pct(rtt, 50).toFixed(3), p95: +pct(rtt, 95).toFixed(3), p99: +pct(rtt, 99).toFixed(3) },
      inProcessCallMs: { p50: +pct(inproc, 50).toFixed(4), p95: +pct(inproc, 95).toFixed(4) },
      crashContained: { hostStillRunning: true, childExit: crashed },
      hostRssMB: mem,
    },
    null,
    2,
  ),
);
