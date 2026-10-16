import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AcpProvider, resolveSpec, type ToolBridge } from "@clawnexus/acp";
import { BRAND } from "@clawnexus/brand";
import { CliError, type Io } from "@clawnexus/cli";
import { Gateway, startGateway } from "@clawnexus/gateway";
import { FakeProvider } from "@clawnexus/sessions";
import { loadConfig } from "./configfile.js";
import { BRIDGE_ENV } from "./mcpbridge.js";

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
  /** Offer the Gateway's tools to the model (default true). Off = the model can only talk. */
  bridgeTools?: boolean;
}

export interface Running {
  gateway: Gateway;
  hasProvider: boolean;
  host: string;
  port: number;
  stop(): Promise<void>;
}

/** The program the model's harness runs to reach our tools: this same binary with `mcp-bridge`. */
function bridgeEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [join(here, "main.js"), join(here, "..", "dist", "main.js")]) if (existsSync(c)) return c;
  throw new CliError("INTERNAL", "cannot find the clawnexus program to start the tool bridge", "Run `pnpm build`, or set provider.tools to false.");
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
    const workspace = join(o.dataDir, "workspace");
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const live: { gateway?: Gateway } = {}; // set once the Gateway is listening; bridges are only opened during chats, after that
    const bridge: ToolBridge | undefined =
      config.provider && o.bridgeTools !== false
        ? {
            async open(session) {
              if (!live.gateway) return undefined;
              const m = live.gateway.mintBridge({ session, principal: "owner" });
              return {
                mcpServers: [
                  {
                    // unguessable, so only THIS session's bridge can match the harness permission shortcut
                    name: `clawnexus-${randomBytes(6).toString("hex")}`,
                    command: process.execPath,
                    args: [bridgeEntry(), "mcp-bridge"],
                    env: [
                      { name: BRIDGE_ENV.url, value: m.url },
                      { name: BRIDGE_ENV.token, value: m.token },
                    ],
                  },
                ],
                close: m.revoke,
              };
            },
          }
        : undefined;
    const acp = !o.fakeProvider && config.provider ? new AcpProvider({ spec: resolveSpec(config.provider), cwd: workspace,
          onDeclined: (what) => live.gateway?.events.append([{ type: "provider.declined", data: { what: what.slice(0, 700) } }]),
          ...(bridge ? { bridge } : {}),
        }) : undefined;
    const provider = o.fakeProvider ? new FakeProvider({ chunkSize: 6 }) : acp;
    const started = await startGateway({
      dataDir: o.dataDir,
      config,
      ...(o.port === undefined ? {} : { port: o.port }),
      ...(provider ? { provider } : {}),
    }).catch(async (e: unknown) => {
      await acp?.close();
      throw e;
    });
    live.gateway = started.gateway;
    let stopped = false;
    return {
      gateway: started.gateway,
      hasProvider: provider !== undefined,
      host: started.host,
      port: started.port,
      async stop() {
        if (stopped) return;
        stopped = true;
        await started.gateway.stop();
        await acp?.close();
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
  else if (g.hasProvider) o.io.out("Model provider: the configured harness starts on the first chat.\n");
  else o.io.err(`Note: no model provider is configured; \`chat\` will say so. Run \`${BRAND.cli} setup --harness claude\` (or codex, cursor, gemini), or use --fake-provider to try the flow.\n`);
  await new Promise<void>((resolve) => {
    const done = (): void => resolve();
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
  o.io.out("Shutting down...\n");
  await g.stop();
  return 0;
}
