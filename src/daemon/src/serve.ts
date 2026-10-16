import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND } from "@clawnexus/brand";
import { CliError, type Io } from "@clawnexus/cli";
import { Gateway, startGateway } from "@clawnexus/gateway";
import { FakeProvider } from "@clawnexus/sessions";
import { loadConfig } from "./configfile.js";

const LOCK_FILE = "gateway.lock";
/** Locks held by this process (a pid check cannot tell two Gateways in one process apart). */
const heldHere = new Set<string>();

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** One Gateway per data directory: two writers on one database is how data gets corrupted. */
export function acquireLock(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, LOCK_FILE);
  if (heldHere.has(path)) {
    throw new CliError("ALREADY_RUNNING", `a Gateway in this process is already using ${dataDir}`, "Stop it first, or use a different --data-dir.");
  }
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && pidAlive(pid)) {
      throw new CliError("ALREADY_RUNNING", `another Gateway (process ${pid}) is using ${dataDir}`, "Stop it first, or use a different --data-dir.");
    }
  }
  writeFileSync(path, `${process.pid}\n`, { mode: 0o600 });
  heldHere.add(path);
  return () => {
    heldHere.delete(path);
    try {
      if (readFileSync(path, "utf8").trim() === String(process.pid)) rmSync(path);
    } catch {
      /* already gone */
    }
  };
}

export interface ServeOptions {
  dataDir: string;
  io: Io;
  port?: number;
  /** Use the built-in echo provider so the full path can be tried without a model. For testing only. */
  fakeProvider?: boolean;
}

export interface Running {
  gateway: Gateway;
  host: string;
  port: number;
  stop(): Promise<void>;
}

/** Start the Gateway from the on-disk config. Refuses to start on a config it cannot trust. */
export async function startFromConfig(o: ServeOptions): Promise<Running> {
  const loaded = loadConfig(o.dataDir);
  if (loaded.state !== "ok" && loaded.state !== "missing") {
    throw new CliError(
      "CONFIG_INVALID",
      loaded.problems.join("; "),
      loaded.state === "stale" ? `Run \`${BRAND.cli} doctor --fix\` to migrate it.` : `Fix the file, or run \`${BRAND.cli} doctor\` for details.`,
    );
  }
  const release = acquireLock(o.dataDir);
  try {
    const config = loaded.config;
    const started = await startGateway({
      dataDir: o.dataDir,
      config,
      ...(o.port === undefined ? {} : { port: o.port }),
      ...(o.fakeProvider ? { provider: new FakeProvider({ chunkSize: 6 }) } : {}),
    });
    let stopped = false;
    return {
      gateway: started.gateway,
      host: started.host,
      port: started.port,
      async stop() {
        if (stopped) return;
        stopped = true;
        await started.gateway.stop();
        release();
      },
    };
  } catch (e) {
    release();
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new CliError("PORT_IN_USE", "the Gateway port is already in use", "Stop the other program, or choose another port with --port.");
    }
    throw e;
  }
}

/** Foreground `gateway run`: starts, prints where it listens, and stops cleanly on Ctrl-C / SIGTERM. */
export async function runGateway(o: ServeOptions): Promise<number> {
  const g = await startFromConfig(o);
  o.io.out(`${BRAND.name} Gateway listening on ws://${g.host}:${g.port}/v1/ws (data: ${o.dataDir})\n`);
  if (o.fakeProvider) o.io.err("Warning: running with the built-in echo provider. No model is connected.\n");
  else o.io.err("Note: no model provider is configured yet; `chat` will say so. Use --fake-provider to try the flow.\n");
  await new Promise<void>((resolve) => {
    const done = (): void => resolve();
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
  o.io.out("Shutting down...\n");
  await g.stop();
  return 0;
}
