import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { join, resolve } from "node:path";
import { BRAND } from "@clawnexus/brand";
import { CliError } from "@clawnexus/cli";
import { inspectDb, openDb, snapshotDb } from "@clawnexus/store";
import { LocalVault, VAULT_FILE, VAULT_KEY_FILE } from "@clawnexus/vault";
import { configPath, loadConfig } from "./configfile.js";

export const BACKUP_FORMAT = 1;
const MANIFEST = "manifest.json";
const DB = "gateway.db";
const VAULT = VAULT_FILE;
/** Folders of the data directory that are part of a backup: notes, installed plugins, their state, and attachments. */
const DIRS = ["memory", "plugins", "plugin-data", "blobs"] as const;
/** Leftovers of an interrupted plugin install; never worth keeping. */
const TEMP = /^\.(install|old)-/;

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
 * the encrypted vault if present, notes, installed plugins and their state, attachments, and optionally the workspace.
 * The Gateway token is deliberately left out: a restored instance gets a fresh one, so a stolen backup never grants
 * access to a live Gateway. The vault's KEY is left out too, so a stolen backup cannot open the secrets; pass
 * `includeKey` only for a backup you will keep as safely as the key itself.
 */
export function createBackup(dataDir: string, outDir: string, opts: { includeWorkspace?: boolean; includeKey?: boolean; now?: () => number } = {}): Manifest {
  const dest = resolve(outDir);
  if (existsSync(dest)) throw new CliError("BACKUP_EXISTS", `${dest} already exists`, "Choose a new --out directory.");
  const dbPath = join(dataDir, DB);
  if (!existsSync(dbPath)) throw new CliError("NOTHING_TO_BACK_UP", `no database at ${dbPath}`, `Run \`${BRAND.cli} setup\` and use the Gateway first.`);

  mkdirSync(dest, { recursive: true, mode: 0o700 });
  try {
    snapshotDb(dbPath, join(dest, DB));
    if (existsSync(configPath(dataDir))) copyFileSync(configPath(dataDir), join(dest, BRAND.configFile));
    if (existsSync(join(dataDir, VAULT))) copyFileSync(join(dataDir, VAULT), join(dest, VAULT));
    for (const d of DIRS) {
      if (existsSync(join(dataDir, d))) cpSync(join(dataDir, d), join(dest, d), { recursive: true, filter: (p) => !TEMP.test(p.split(/[\\/]/).pop() ?? "") });
    }
    if (opts.includeKey && existsSync(join(dataDir, VAULT_KEY_FILE))) copyFileSync(join(dataDir, VAULT_KEY_FILE), join(dest, VAULT_KEY_FILE));
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

export function gatewayRunning(port: number): Promise<boolean> {
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

export interface RestoreResult {
  /** The database that was here before, kept beside the restored one. */
  movedAside?: string;
  /** Folders (notes, plugins, plugin state, attachments) that were here before, kept beside the restored ones. */
  setAside: string[];
  /** What happened to the encrypted secrets: restored and readable, set aside because they cannot be opened, or not in the backup. */
  vault: "restored" | "set-aside" | "none";
}

/**
 * Restore a verified backup into the data directory. Nothing that is here is deleted: the old database and any
 * folder the backup replaces are renamed with a `.before-restore-` suffix. Folders are replaced as a whole, because a
 * plugin folder with an extra file in it would no longer match the code the owner approved.
 */
export async function restoreBackup(backupDir: string, dataDir: string, opts: { force?: boolean; port?: number; now?: () => number } = {}): Promise<RestoreResult> {
  const manifest = verifyBackup(backupDir);
  const src = resolve(backupDir);
  const port = opts.port ?? (() => {
    const l = loadConfig(dataDir);
    return l.state === "ok" || l.state === "missing" ? l.config.gateway.port : 7391;
  })();
  if (await gatewayRunning(port)) throw new CliError("GATEWAY_RUNNING", `a Gateway is answering on port ${port}`, "Stop it before restoring.");

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const stamp = (opts.now ?? Date.now)();
  const db = join(dataDir, DB);
  let movedAside: string | undefined;
  if (existsSync(db)) {
    if (!opts.force) throw new CliError("DATA_EXISTS", `${db} already exists`, "Pass --force to replace it (the current one is kept as gateway.db.before-restore-*).");
    movedAside = `${db}.before-restore-${stamp}`;
    renameSync(db, movedAside);
  }
  // Stale WAL/SHM files belong to the old database and would corrupt the restored one.
  for (const ext of ["-wal", "-shm"]) rmSync(db + ext, { force: true });

  const setAside: string[] = [];
  for (const d of DIRS) {
    if (manifest.files.some((f) => f.name.startsWith(`${d}/`)) && existsSync(join(dataDir, d))) {
      const aside = `${join(dataDir, d)}.before-restore-${stamp}`;
      renameSync(join(dataDir, d), aside);
      setAside.push(aside);
    }
  }

  for (const f of manifest.files) {
    const to = join(dataDir, f.name);
    mkdirSync(join(to, ".."), { recursive: true });
    if (f.name !== BRAND.configFile || !existsSync(to) || opts.force) copyFileSync(join(src, f.name), to);
  }

  // Replies that were queued when the backup was made are not sent again: they answer questions from the past and may
  // already have been delivered.
  const restored = openDb(db);
  try {
    restored.prepare("DELETE FROM outbox").run();
  } finally {
    restored.close();
  }

  // The secrets are only useful with their key, which a backup leaves out unless asked. Make sure the vault that is now
  // here can really be opened; if not, set it aside so a new one can be made (secrets are then entered again).
  let vault: RestoreResult["vault"] = "none";
  if (manifest.files.some((f) => f.name === VAULT)) {
    let opens = false;
    if (existsSync(join(dataDir, VAULT_KEY_FILE))) {
      const v = new LocalVault(dataDir);
      try {
        await v.open();
        opens = true;
      } catch {
        opens = false;
      } finally {
        v.close();
      }
    }
    if (opens) vault = "restored";
    else {
      renameSync(join(dataDir, VAULT), join(dataDir, `${VAULT}.unreadable-${stamp}`));
      vault = "set-aside";
    }
  }
  return { ...(movedAside === undefined ? {} : { movedAside }), setAside, vault };
}
