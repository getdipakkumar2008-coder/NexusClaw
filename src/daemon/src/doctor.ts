import { chmodSync, existsSync, mkdirSync, statSync, statfsSync } from "node:fs";
import { get } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { BRAND } from "@clawnexus/brand";
import { isLoopback } from "@clawnexus/config";
import { inspectDb } from "@clawnexus/store";
import { defaultConfig, loadConfig, migrateConfigFile, writeConfig } from "./configfile.js";

export type CheckStatus = "ok" | "warn" | "fail";
export interface Check {
  id: string;
  status: CheckStatus;
  message: string;
  /** What the operator should do. Present for every warn/fail. */
  fix?: string;
  /** Set when `--fix` repaired this. */
  fixed?: boolean;
}

export interface DoctorOptions {
  dataDir: string;
  fix: boolean;
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  /** Override the port to probe (default: from config). */
  port?: number;
}

const MIN_NODE = [22, 13];
const posix = (p: NodeJS.Platform): boolean => p !== "win32";

function probeHealth(port: number): Promise<"gateway" | "other" | "none"> {
  return new Promise((resolve) => {
    const req = get({ host: "127.0.0.1", port, path: "/healthz", timeout: 800 }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve(body.includes('"ok":true') ? "gateway" : "other"));
    });
    req.on("timeout", () => {
      req.destroy();
      resolve("other");
    });
    req.on("error", (e: NodeJS.ErrnoException) => resolve(e.code === "ECONNREFUSED" ? "none" : "other"));
  });
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

export async function runDoctor(o: DoctorOptions): Promise<Check[]> {
  const platform = o.platform ?? process.platform;
  const checks: Check[] = [];
  const add = (c: Check): void => void checks.push(c);

  // Node version
  const [maj, min] = (o.nodeVersion ?? process.versions.node).split(".").map(Number) as [number, number];
  const nodeOk = maj > MIN_NODE[0]! || (maj === MIN_NODE[0] && min >= MIN_NODE[1]!);
  add(
    nodeOk
      ? { id: "node", status: "ok", message: `Node.js ${o.nodeVersion ?? process.versions.node}` }
      : { id: "node", status: "fail", message: `Node.js ${o.nodeVersion ?? process.versions.node} is too old`, fix: `Install Node.js ${MIN_NODE.join(".")} or newer.` },
  );

  // Data directory
  if (!existsSync(o.dataDir)) {
    if (o.fix) {
      mkdirSync(o.dataDir, { recursive: true, mode: 0o700 });
      add({ id: "data-dir", status: "ok", message: `created ${o.dataDir}`, fixed: true });
    } else add({ id: "data-dir", status: "warn", message: `${o.dataDir} does not exist yet`, fix: `Run \`${BRAND.cli} setup\`, or \`${BRAND.cli} doctor --fix\`.` });
  } else {
    if (posix(platform)) {
      const mode = statSync(o.dataDir).mode & 0o777;
      if (mode & 0o077) {
        if (o.fix) {
          chmodSync(o.dataDir, 0o700);
          add({ id: "data-dir", status: "ok", message: `tightened permissions on ${o.dataDir} to 0700`, fixed: true });
        } else add({ id: "data-dir", status: "fail", message: `${o.dataDir} is accessible to other users (mode ${mode.toString(8)})`, fix: `Run \`${BRAND.cli} doctor --fix\` or \`chmod 700\` it.` });
      } else add({ id: "data-dir", status: "ok", message: `${o.dataDir} is private` });
    } else add({ id: "data-dir", status: "ok", message: `${o.dataDir} exists` });
  }

  // Config
  const loaded = existsSync(o.dataDir) ? loadConfig(o.dataDir) : { state: "missing" as const, config: defaultConfig() };
  let config = loaded.state === "missing" || loaded.state === "ok" ? loaded.config : defaultConfig();
  if (loaded.state === "missing") {
    if (o.fix && existsSync(o.dataDir)) {
      writeConfig(o.dataDir, config);
      add({ id: "config", status: "ok", message: "wrote a default config.json", fixed: true });
    } else add({ id: "config", status: "warn", message: "no config.json; built-in defaults apply", fix: `Run \`${BRAND.cli} setup\`.` });
  } else if (loaded.state === "ok") {
    add({ id: "config", status: "ok", message: "config.json is valid" });
  } else if (loaded.state === "stale" && loaded.raw) {
    if (o.fix) {
      const r = migrateConfigFile(o.dataDir, loaded.raw);
      if (r.ok) {
        add({ id: "config", status: "ok", message: "migrated config.json (previous copy kept as config.json.bak)", fixed: true });
        const again = loadConfig(o.dataDir);
        if (again.state === "ok") config = again.config;
      } else add({ id: "config", status: "fail", message: `could not migrate config.json: ${r.problems.join("; ")}`, fix: "Edit the file by hand." });
    } else add({ id: "config", status: "fail", message: loaded.problems.join("; "), fix: `Run \`${BRAND.cli} doctor --fix\` to migrate it.` });
  } else {
    add({ id: "config", status: "fail", message: loaded.problems.join("; "), fix: "Edit config.json to fix the problem above. doctor will not overwrite a file it cannot read." });
  }

  // Exposure
  const g = config.gateway;
  if (isLoopback(g.bind)) add({ id: "exposure", status: "ok", message: `Gateway listens on loopback only (${g.bind}:${g.port})` });
  else if (g.tls.enabled && g.auth.required) add({ id: "exposure", status: "warn", message: `Gateway is reachable beyond this machine (${g.bind}:${g.port}) with TLS and auth`, fix: "Confirm this is intended and the port is firewalled." });
  else add({ id: "exposure", status: "fail", message: `Gateway is exposed beyond loopback (${g.bind}) without TLS and auth`, fix: "Set gateway.bind to 127.0.0.1, or enable gateway.tls and gateway.auth." });

  // Token file
  const tokenPath = join(o.dataDir, "gateway.token");
  if (!existsSync(tokenPath)) add({ id: "token", status: "warn", message: "no Gateway token yet (created on first start)", fix: `Run \`${BRAND.cli} setup\`.` });
  else if (posix(platform) && statSync(tokenPath).mode & 0o077) {
    if (o.fix) {
      chmodSync(tokenPath, 0o600);
      add({ id: "token", status: "ok", message: "tightened permissions on gateway.token to 0600", fixed: true });
    } else add({ id: "token", status: "fail", message: "gateway.token is readable by other users", fix: `Run \`${BRAND.cli} doctor --fix\`.` });
  } else add({ id: "token", status: "ok", message: "gateway.token present and private" });

  // Database
  const dbPath = join(o.dataDir, "gateway.db");
  if (!existsSync(dbPath)) add({ id: "database", status: "ok", message: "no database yet (created on first start)" });
  else {
    try {
      const i = inspectDb(dbPath);
      if (i.integrity !== "ok") add({ id: "database", status: "fail", message: `database integrity check failed: ${i.integrity.slice(0, 200)}`, fix: `Stop the Gateway and restore the latest backup with \`${BRAND.cli} restore\`.` });
      else if (i.userVersion > i.supportedVersion) add({ id: "database", status: "fail", message: `database schema ${i.userVersion} is newer than this build (${i.supportedVersion})`, fix: "Upgrade the software, or restore a backup made by this version." });
      else add({ id: "database", status: "ok", message: `database healthy (schema ${i.userVersion}${i.userVersion < i.supportedVersion ? `, will upgrade to ${i.supportedVersion} on start` : ""})` });
    } catch (e) {
      add({ id: "database", status: "fail", message: `cannot open the database: ${e instanceof Error ? e.message : "unknown error"}`, fix: `If the Gateway is running that is normal for a moment; otherwise restore a backup with \`${BRAND.cli} restore\`.` });
    }
  }

  // Disk space
  try {
    const probe = existsSync(o.dataDir) ? o.dataDir : join(o.dataDir, "..");
    const st = statfsSync(probe);
    const freeMb = Math.floor((Number(st.bavail) * Number(st.bsize)) / (1024 * 1024));
    if (freeMb < 50) add({ id: "disk", status: "fail", message: `only ${freeMb} MB free`, fix: "Free some disk space; the database cannot be written safely." });
    else if (freeMb < 500) add({ id: "disk", status: "warn", message: `${freeMb} MB free`, fix: "Free some disk space, or compact old events." });
    else add({ id: "disk", status: "ok", message: `${freeMb} MB free` });
  } catch {
    add({ id: "disk", status: "warn", message: "could not read free disk space" });
  }

  // Port / running state
  const port = o.port ?? g.port;
  const state = await probeHealth(port);
  if (state === "gateway") add({ id: "port", status: "ok", message: `a Gateway is running on port ${port}` });
  else if (state === "other" || !(await portFree(port))) add({ id: "port", status: "warn", message: `port ${port} is in use by another program`, fix: `Stop it, or set gateway.port to a free port.` });
  else add({ id: "port", status: "ok", message: `port ${port} is free` });

  return checks;
}

export function formatChecks(checks: readonly Check[]): string {
  const icon: Record<CheckStatus, string> = { ok: "ok  ", warn: "WARN", fail: "FAIL" };
  const lines = checks.flatMap((c) => [`${icon[c.status]} ${c.id.padEnd(10)} ${c.message}${c.fixed ? "  [fixed]" : ""}`, ...(c.fix && c.status !== "ok" ? [`     fix: ${c.fix}`] : [])]);
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  lines.push("", fails ? `${fails} problem(s) need attention.` : warns ? `Healthy, with ${warns} warning(s).` : "All checks passed.");
  return `${lines.join("\n")}\n`;
}
