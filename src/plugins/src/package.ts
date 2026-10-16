import { createHash } from "node:crypto";
import { lstatSync, openSync, closeSync, readFileSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { manifestSchema, sdkRangeSatisfied, SDK_VERSION, type PluginManifest } from "@clawnexus/plugin-sdk";
import { canonicalJson, type Risk } from "@clawnexus/policy";

export const MANIFEST_FILE = "clawnexus.plugin.json";

/** Bounds on what a plugin directory may contain. A plugin is third-party code on the owner's machine. */
export const PACKAGE_LIMITS = {
  files: 5000,
  totalBytes: 50 * 1024 * 1024,
  fileBytes: 20 * 1024 * 1024,
  depth: 20,
  manifestBytes: 64 * 1024,
} as const;

/** Ids that would collide with built-in tool prefixes or Gateway method families. */
export const RESERVED_IDS: ReadonlySet<string> = new Set(["fs", "exec", "tool", "plugin", "plugins", "session", "approval", "pairing", "status", "events", "connection", "gateway", "system", "core"]);

/** What the host can and cannot hold a plugin to. Shown to the owner before they enable anything. */
export interface Enforcement {
  fs: "enforced" | "none";
  exec: "enforced" | "none";
  network: "advisory" | "none";
  secrets: "unavailable" | "none";
}

export interface PluginPackage {
  dir: string;
  manifest: PluginManifest;
  /** Hash of every file in the directory: a changed byte anywhere is a different plugin. */
  treeHash: string;
  files: number;
  bytes: number;
  /** What the owner approves: id, version, exact code and permissions. Enabling must present this value. */
  approvalToken: string;
  /** Lowest risk class any tool of this plugin may have, implied by the permissions it asked for. */
  riskFloor: Risk;
  enforcement: Enforcement;
}

export type InspectResult = { ok: true; plugin: PluginPackage } | { ok: false; problems: string[] };

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

interface Walked {
  files: Array<{ rel: string; hash: string; size: number }>;
  bytes: number;
}

/** Walk a plugin directory without following links. Anything that is not a plain file or directory is a problem. */
function walk(root: string, problems: string[]): Walked {
  const out: Walked = { files: [], bytes: 0 };
  const visit = (abs: string, rel: string, depth: number): void => {
    if (problems.length > 0 && out.files.length > PACKAGE_LIMITS.files) return;
    if (depth > PACKAGE_LIMITS.depth) {
      problems.push(`directory nesting deeper than ${PACKAGE_LIMITS.depth} at ${rel}`);
      return;
    }
    let names: string[];
    try {
      names = readdirSync(abs).sort();
    } catch (e) {
      problems.push(`cannot read ${rel || "."}: ${(e as NodeJS.ErrnoException).code ?? "error"}`);
      return;
    }
    for (const name of names) {
      if (name.includes("\0")) {
        problems.push("a file name contains a NUL byte");
        continue;
      }
      const a = join(abs, name);
      const r = rel === "" ? name : `${rel}/${name}`;
      let st;
      try {
        st = lstatSync(a);
      } catch {
        problems.push(`cannot stat ${r}`);
        continue;
      }
      if (st.isSymbolicLink()) problems.push(`${r} is a symbolic link; plugins may not contain links`);
      else if (st.isDirectory()) visit(a, r, depth + 1);
      else if (st.isFile()) {
        if (out.files.length >= PACKAGE_LIMITS.files) {
          problems.push(`more than ${PACKAGE_LIMITS.files} files`);
          return;
        }
        if (st.size > PACKAGE_LIMITS.fileBytes) {
          problems.push(`${r} is larger than ${PACKAGE_LIMITS.fileBytes / 1024 / 1024} MiB`);
          continue;
        }
        out.bytes += st.size;
        if (out.bytes > PACKAGE_LIMITS.totalBytes) {
          problems.push(`plugin is larger than ${PACKAGE_LIMITS.totalBytes / 1024 / 1024} MiB`);
          return;
        }
        out.files.push({ rel: r, hash: hashFile(a), size: st.size });
      } else problems.push(`${r} is not a regular file`);
    }
  };
  visit(root, "", 0);
  return out;
}

function hashFile(path: string): string {
  const h = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    for (let n = readSync(fd, buf, 0, buf.length, null); n > 0; n = readSync(fd, buf, 0, buf.length, null)) h.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return h.digest("hex");
}

const HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

/**
 * Read and judge a plugin directory without running anything in it. Never executes plugin code.
 * `expectId` is set when the directory is already inside the plugins folder (its name must match the manifest).
 */
export function inspectPluginDir(dir: string, o: { expectId?: string; hostSdk?: string } = {}): InspectResult {
  const problems: string[] = [];
  let top;
  try {
    top = lstatSync(dir);
  } catch {
    return { ok: false, problems: [`${dir} does not exist`] };
  }
  if (top.isSymbolicLink() || !top.isDirectory()) return { ok: false, problems: [`${dir} is not a plain directory`] };

  const walked = walk(dir, problems);
  const manifestEntry = walked.files.find((f) => f.rel === MANIFEST_FILE);
  if (!manifestEntry) problems.push(`${MANIFEST_FILE} is missing`);
  else if (manifestEntry.size > PACKAGE_LIMITS.manifestBytes) problems.push(`${MANIFEST_FILE} is larger than ${PACKAGE_LIMITS.manifestBytes} bytes`);
  if (problems.length > 0 || !manifestEntry) return { ok: false, problems };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8"));
  } catch {
    return { ok: false, problems: [`${MANIFEST_FILE} is not valid JSON`] };
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((i) => `${MANIFEST_FILE}: ${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  const m = parsed.data;

  if (RESERVED_IDS.has(m.id)) problems.push(`plugin id "${m.id}" is reserved`);
  if (o.expectId !== undefined && m.id !== o.expectId) problems.push(`directory is named "${o.expectId}" but the manifest id is "${m.id}"`);
  if (!sdkRangeSatisfied(m.sdkRange, o.hostSdk ?? SDK_VERSION)) {
    problems.push(`needs plugin SDK ${m.sdkRange}, but this Gateway provides ${o.hostSdk ?? SDK_VERSION}`);
  }

  if (m.kind === "code") {
    const entry = m.entry ?? "";
    const norm = entry.replaceAll("\\", "/");
    if (norm.startsWith("/") || /^[a-zA-Z]:/.test(norm) || norm.split("/").some((seg) => seg === ".." || seg === "." || seg === "")) {
      problems.push(`entry "${entry}" must be a plain relative path inside the plugin`);
    } else if (!walked.files.some((f) => f.rel === norm)) {
      problems.push(`entry "${entry}" does not exist in the plugin`);
    } else if (!norm.endsWith(".mjs")) {
      // Node decides ES-module vs CommonJS from the nearest package.json; keep that lookup inside the plugin.
      let ok = false;
      try {
        ok = norm.endsWith(".js") && (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { type?: string }).type === "module";
      } catch {
        ok = false;
      }
      if (!ok) problems.push(`entry "${entry}" must be an .mjs file, or a .js file with a package.json containing "type": "module" in the plugin folder`);
    }
  }

  for (const f of m.permissions.fs) {
    if (f !== "data") problems.push(`fs permission "${f}" is not supported; the only value is "data" (the plugin's own data folder)`);
  }
  for (const h of m.permissions.network) {
    if (!HOST.test(h) || h === "*") problems.push(`network permission "${h}" is not a host name (use e.g. api.example.com or *.example.com)`);
  }

  if (problems.length > 0) return { ok: false, problems };

  const permissions = {
    network: [...m.permissions.network].sort(),
    fs: [...new Set(m.permissions.fs)].sort(),
    exec: m.permissions.exec,
    secrets: [...m.permissions.secrets].sort(),
  };
  const treeHash = sha(walked.files.map((f) => `${f.rel}\0${f.size}\0${f.hash}`).join("\n"));
  const riskFloor: Risk = permissions.exec ? 3 : permissions.network.length > 0 ? 2 : permissions.fs.length > 0 ? 1 : 0;
  return {
    ok: true,
    plugin: {
      dir,
      manifest: m,
      treeHash,
      files: walked.files.length,
      bytes: walked.bytes,
      approvalToken: sha(canonicalJson({ id: m.id, version: m.version, kind: m.kind, entry: m.entry ?? null, treeHash, permissions })),
      riskFloor,
      enforcement: {
        fs: permissions.fs.length > 0 ? "enforced" : "none",
        exec: permissions.exec ? "enforced" : "none",
        network: permissions.network.length > 0 ? "advisory" : "none",
        secrets: permissions.secrets.length > 0 ? "unavailable" : "none",
      },
    },
  };
}
