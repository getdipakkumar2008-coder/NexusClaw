import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND } from "@clawnexus/brand";
import { CliError, type Io } from "@clawnexus/cli";
import { gatewayRunning } from "./backup.js";
import { loadConfig } from "./configfile.js";
import { logPath, tailLog } from "./logfile.js";
import { controlService, installService, planService, runSystem, serviceStatus, uninstallService, type RunCmd, type ServiceOptions } from "./service.js";

export interface ServiceCommandOptions {
  sub: string | undefined;
  dataDir: string;
  io: Io;
  json: boolean;
  port?: number;
  /** Test seams: how system tools are run, and which program the service should start. */
  run?: RunCmd;
  node?: string;
  script?: string;
  uid?: number;
}

/** The entry script of the installed program (this file sits beside main.js). */
export function entryScript(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "main.js");
}

function options(o: ServiceCommandOptions): ServiceOptions {
  return {
    platform: o.io.platform,
    home: o.io.home || homedir(),
    env: o.io.env,
    node: o.node ?? process.execPath,
    script: o.script ?? entryScript(),
    dataDir: resolve(o.dataDir),
    ...(o.port === undefined ? {} : { port: o.port }),
    ...(o.uid !== undefined ? { uid: o.uid } : typeof process.getuid === "function" ? { uid: process.getuid() } : {}),
  };
}

function gatewayPort(o: ServiceCommandOptions): number {
  if (o.port !== undefined) return o.port;
  const l = loadConfig(o.dataDir);
  return l.state === "ok" || l.state === "missing" ? l.config.gateway.port : 7391;
}

export async function runServiceCommand(o: ServiceCommandOptions): Promise<number> {
  const run = o.run ?? runSystem;
  const so = options(o);
  const say = (value: unknown, human: string): void => o.io.out(o.json ? `${JSON.stringify(value, null, 2)}\n` : human);
  const sub = o.sub ?? "status";

  if (sub === "install") {
    if (!existsSync(join(so.dataDir, "gateway.token")) && !existsSync(join(so.dataDir, BRAND.configFile))) {
      throw new CliError("NOT_SET_UP", `${so.dataDir} has not been set up`, `Run \`${BRAND.cli} setup\` first, then install the service.`);
    }
    planService(so); // refuse a bad path or an unsupported system before touching anything
    const manual = await gatewayRunning(gatewayPort(o));
    const r = await installService(so, run);
    say(
      { ...r, gatewayAlreadyRunning: manual },
      `Installed the ${r.kind} service "${r.name}" and started it.\n  Definition: ${r.files.join(", ")}\n  It runs as you, starts when you sign in, and restarts if it stops.\n${manual ? `  Note: a Gateway was already answering on port ${gatewayPort(o)} (started by hand?). Stop that one; the service cannot start while it runs.\n` : ""}${r.hints.map((h) => `  ${h}\n`).join("")}  Check on it with \`${BRAND.cli} service status\`.\n`,
    );
    return 0;
  }
  if (sub === "uninstall") {
    const r = await uninstallService(so, run);
    say(r, r.wasInstalled ? `Removed the background service. Your data in ${so.dataDir} was not touched.\n` : "The background service was not installed.\n");
    return 0;
  }
  if (sub === "start" || sub === "stop" || sub === "restart") {
    if (sub !== "start") await controlService("stop", so, run).catch((e: unknown) => (sub === "restart" ? undefined : Promise.reject(e)));
    if (sub !== "stop") await controlService("start", so, run);
    say({ [sub]: true }, `${sub === "stop" ? "Stopped" : sub === "start" ? "Started" : "Restarted"} the background service.\n`);
    return 0;
  }
  if (sub === "status") {
    const st = await serviceStatus(so, run);
    const answering = await gatewayRunning(gatewayPort(o));
    say(
      { ...st, gatewayAnswering: answering },
      `Background service (${st.kind}): ${st.installed ? "installed" : `not installed. Install it with \`${BRAND.cli} service install\``}\nGateway: ${answering ? `answering on port ${gatewayPort(o)}` : "not answering"}\n${st.problems.map((p) => `Problem: ${p}. Run \`${BRAND.cli} service install\` again to fix it.\n`).join("")}`,
    );
    return st.problems.length > 0 ? 1 : 0;
  }
  throw new CliError("USAGE", `unknown service command ${sub}`, "Use install, uninstall, status, start, stop or restart.");
}

export function runLogsCommand(o: { dataDir: string; io: Io; json: boolean; lines: number }): number {
  const lines = tailLog(logPath(resolve(o.dataDir)), Math.min(Math.max(o.lines, 1), 1000));
  if (lines.length === 0) {
    o.io.out(o.json ? "" : `No log yet at ${logPath(resolve(o.dataDir))}. It is written while the Gateway runs.\n`);
    return 0;
  }
  if (o.json) o.io.out(`${lines.join("\n")}\n`);
  else
    for (const l of lines) {
      try {
        const e = JSON.parse(l) as { ts: string; level: string; msg: string } & Record<string, unknown>;
        const { ts, level, msg, ...rest } = e;
        o.io.out(`${ts} ${level.toUpperCase().padEnd(5)} ${msg}${Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : ""}\n`);
      } catch {
        o.io.out(`${l}\n`);
      }
    }
  return 0;
}
