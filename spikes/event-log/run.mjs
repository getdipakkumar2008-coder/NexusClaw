// Spike 2: crash-safe append + cursor resume. Kills the writer hard at random moments, then checks invariants.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
const ITER = Number(process.env.ITER ?? 30);

async function runMode(syncMode) {
  const dir = mkdtempSync(join(tmpdir(), "evlog-"));
  const dbPath = join(dir, "events.db");
  let nextIdx = 0;
  let lastAcked = -1;
  let ackedTotal = 0;
  let violations = [];
  const t0 = Date.now();

  for (let it = 0; it < ITER; it++) {
    const child = spawn(process.execPath, ["--no-warnings", join(here, "writer.mjs"), dbPath, syncMode, String(nextIdx)], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const l of lines) if (l) lastAcked = Number(l);
    });
    await new Promise((r) => setTimeout(r, 150 + Math.random() * 350));
    child.kill("SIGKILL");
    await new Promise((r) => child.on("exit", r));

    const db = new DatabaseSync(dbPath);
    const rows = db.prepare("SELECT seq, idx FROM events ORDER BY seq").all();
    db.close();
    // Invariants: seq contiguous from 1; idx contiguous from 0 (no dup, no gap); every acked idx present.
    rows.forEach((r, k) => {
      if (r.seq !== k + 1) violations.push(`it${it}: seq gap at row ${k} (seq ${r.seq})`);
      if (r.idx !== k) violations.push(`it${it}: idx mismatch at row ${k} (idx ${r.idx})`);
    });
    if (rows.length - 1 < lastAcked) violations.push(`it${it}: acked idx ${lastAcked} lost (max stored ${rows.length - 1})`);
    nextIdx = rows.length; // writer resumes from what is durably stored
    ackedTotal = Math.max(ackedTotal, lastAcked + 1);

    // Resume semantics: a client with cursor `since` receives each later event exactly once.
    const since = Math.max(0, Math.floor(rows.length / 2));
    const db2 = new DatabaseSync(dbPath);
    const got = db2.prepare("SELECT seq FROM events WHERE seq > ? ORDER BY seq").all(since).map((r) => r.seq);
    db2.close();
    if (got.length !== rows.length - since || new Set(got).size !== got.length) violations.push(`it${it}: resume returned wrong set`);
  }

  const secs = (Date.now() - t0) / 1000;
  rmSync(dir, { recursive: true, force: true });
  return { syncMode, kills: ITER, events: nextIdx, throughputPerSec: Math.round(nextIdx / secs), violations };
}

for (const mode of ["FULL", "NORMAL"]) {
  const r = await runMode(mode);
  console.log(JSON.stringify(r));
}
