import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { join, resolve } from "node:path";
import { BRAND } from "@clawnexus/brand";
import { CliError } from "@clawnexus/cli";
import { inspectDb, snapshotDb } from "@clawnexus/store";
import { configPath, loadConfig } from "./configfile.js";

export const BACKUP_FORMAT = 1;
const MANIFEST = "manifest.json";
const DB = "gateway.db";
const VAULT = "secrets.vault";

export interface ManifestFile {
  name: string;
  bytes: number;
  sha256: string;
}
export interface Manifest {
  format: number;
  createdAt: number;
  schemaVersion: number;
  files: ManifestFile[];
}

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * Snapshot the data directory into `outDir` (must not exist). Contents: a consistent database copy, the config,
 * the encrypted vault if present, and optionally the workspace. The Gateway token is deliberately left out:
 * a restored instance gets a fresh one, so a stolen backup never grants access to a live Gateway.
 */
export function createBackup(dataDir: string, outDir: string, opts: { includeWorkspace?: boolean; now?: () => number } = {}): Manifest {
  const dest = resolve(outDir);
  if (existsSync(dest)) throw new CliError("BACKUP_EXISTS", `${dest} already exists`, "Choose a new --out directory.");
  const dbPath = join(dataDir, DB);
  if (!existsSync(dbPath)) throw new CliError("NOTHING_TO_BACK_UP", `no database at ${dbPath}`, `Run \`${BRAND.cli} setup\` and use the Gateway first.`);

  mkdirSync(dest, { recursive: true, mode: 0o700 });
  try {
    snapshotDb(dbPath, join(dest, DB));
    if (existsSync(configPath(dataDir))) copyFileSync(configPath(dataDir), join(dest, BRAND.configFile));
    if (existsSync(join(dataDir, VAULT))) copyFileSync(join(dataDir, VAULT), join(dest, VAULT));
    if (existsSync(join(dataDir, "memory"))) cpSync(join(dataDir, "memory"), join(dest, "memory"), { recursive: true });
    if (opts.includeWorkspace &&existsSync(join(dataDir, "workspace"))) cpSync(join(dataDir, "workspace"), join(dest, "workspace"), { recursive: true });

    const files: ManifestFile[] = [];
    const walk = (dir: string, prefix: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) walk(join(dir, e.name), rel);
        else if (e.isFile() && rel !== MANIFEST) files.push({ name: rel, bytes: statSync(join(dest, rel)).size, sha256: sha256(join(dest, rel)) });
      }
    };
    walk(dest, "");
    const manifest: Manifest = { format: BACKUP_FORMAT, createdAt: (opts.now ?? Date.now)(), schemaVersion: inspectDb(join(dest, DB)).userVersion, files: files.sort((a, b) => a.name.localeCompare(b.name)) };
    writeFileSync(join(dest, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    verifyBackup(dest);
    return manifest;
  } catch (e) {
    rmSync(dest, { recursive: true, force: true });
    throw e;
  }
}

/** Check a backup directory: manifest present, every file present with the recorded size and hash, database healthy. */
export function verifyBackup(dir: string): Manifest {
  const src = resolve(dir);
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(join(src, MANIFEST), "utf8")) as Manifest;
  } catch {
    throw new CliError("BAD_BACKUP", `${src} has no readable ${MANIFEST}`, "Point at a directory created by `backup`.");
  }
  if (manifest.format !== BACKUP_FORMAT) throw new CliError("BAD_BACKUP", `unsupported backup format ${String(manifest.format)}`, "Use the version of the software that made this backup.");
  for (const f of manifest.files) {
    // The manifest is untrusted input: refuse anything that could point outside the backup directory.
    if (f.name.includes("..") || f.name.startsWith("/") || f.name.includes("\\") || /^[a-zA-Z]:/.test(f.name)) throw new CliError("BAD_BACKUP", `unsafe file name in manifest: ${f.name}`, "The backup is damaged or tampered with.");
    const p = join(src, f.name);
    if (!existsSync(p) || statSync(p).size !== f.bytes || sha256(p) !== f.sha256) {
      throw new CliError("BAD_BACKUP", `${f.name} is missing or does not match its checksum`, "This backup is damaged; use another one.");
    }
  }
  if (!manifest.files.some((f) => f.name === DB)) throw new CliError("BAD_BACKUP", "backup contains no database", "Use a different backup.");
  const i = inspectDb(join(src, DB));
  if (i.integrity !== "ok") throw new CliError("BAD_BACKUP", "the backed-up database fails its integrity check", "Use another backup.");
  if (i.userVersion > i.supportedVersion) throw new CliError("BAD_BACKUP", `backup schema ${i.userVersion} is newer than this build supports (${i.supportedVersion})`, "Upgrade the software first.");
  return manifest;
}

function gatewayRunning(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const req = get({ host: "127.0.0.1", port, path: "/healthz", timeout: 800 }, (res) => {
      res.resume();
      resolvePromise(true);
    });
    req.on("timeout", () => {
      req.destroy();
      resolvePromise(false);
    });
    req.on("error", () => resolvePromise(false));
  });
}

/** Restore a verified backup into the data directory. The existing database is set aside, never deleted. */
export async function restoreBackup(backupDir: string, dataDir: string, opts: { force?: boolean; port?: number; now?: () => number } = {}): Promise<{ movedAside?: string }> {
  const manifest = verifyBackup(backupDir);
  const src = resolve(backupDir);
  const port = opts.port ?? (() => {
    const l = loadConfig(dataDir);
    return l.state === "ok" || l.state === "missing" ? l.config.gateway.port : 7391;
  })();
  if (await gatewayRunning(port)) throw new CliError("GATEWAY_RUNNING", `a Gateway is answering on port ${port}`, "Stop it before restoring.");

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = join(dataDir, DB);
  let movedAside: string | undefined;
  if (existsSync(db)) {
    if (!opts.force) throw new CliError("DATA_EXISTS", `${db} already exists`, "Pass --force to replace it (the current one is kept as gateway.db.before-restore-*).");
    movedAside = `${db}.before-restore-${(opts.now ?? Date.now)()}`;
    renameSync(db, movedAside);
  }
  // Stale WAL/SHM files belong to the old database and would corrupt the restored one.
  for (const ext of ["-wal", "-shm"]) rmSync(db + ext, { force: true });

  for (const f of manifest.files) {
    const to = join(dataDir, f.name);
    mkdirSync(join(to, ".."), { recursive: true });
    if (f.name !== BRAND.configFile || !existsSync(to) || opts.force) copyFileSync(join(src, f.name), to);
  }
  return movedAside === undefined ? {} : { movedAside };
}
