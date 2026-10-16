import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { PluginManifest, ToolRegistration, ArgSpec } from "@clawnexus/plugin-sdk";
import type { Risk } from "@clawnexus/policy";
import type { Db, EventLog } from "@clawnexus/store";
import type { ToolDef } from "@clawnexus/tools";
import type { ChannelAdapter } from "@clawnexus/channels";
import { PluginChannelAdapter } from "./channel.js";
import { inspectPluginDir, type Enforcement, type PluginPackage } from "./package.js";
import { PluginProcess, PluginProcessError } from "./process.js";

export type PluginStatus = "disabled" | "enabled" | "starting" | "running" | "crashed" | "degraded" | "needs_approval" | "needs_config" | "invalid";

/** Where the owner's secrets live. Values go in and out of the plugin process only; they are never listed or logged. */
export interface SecretStore {
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  delete(name: string): boolean;
  list(): string[];
  redact: { redact(text: string): string; redactDeep<T>(value: T): T };
}

export type SettingValue = string | number | boolean;

/** What the owner can set for a plugin, and what is still missing. Secret values are never included. */
export interface PluginSettings {
  id: string;
  settings: Array<{ name: string; type: string; description?: string; required: boolean; enum?: string[]; value?: SettingValue }>;
  secrets: Array<{ name: string; set: boolean }>;
  /** Human-readable list of what must still be provided before the plugin can start. */
  missing: string[];
}

export interface PluginInfo {
  id: string;
  status: PluginStatus;
  /** Why the plugin is in this state, when that is not obvious. */
  reason?: string;
  /** Always "local-unsigned" for now: there is no registry or signature check yet. */
  trust: "local-unsigned";
  name?: string;
  version?: string;
  kind?: PluginManifest["kind"];
  provides?: string[];
  permissions?: PluginManifest["permissions"];
  enforcement?: Enforcement;
  /** Lowest risk class this plugin's tools can have. */
  riskFloor?: Risk;
  /** The value `enable` must be given: it pins the exact code and permissions that were reviewed. */
  approvalToken?: string;
  tools: string[];
  /** The messaging channel this plugin provides, while it is running. */
  channel?: string;
  problems?: string[];
  /** Settings or secrets the owner still has to provide. */
  missing?: string[];
}

export class PluginError extends Error {
  constructor(
    readonly code: "BAD_ID" | "NOT_FOUND" | "INVALID" | "EXISTS" | "CHANGED" | "BUSY" | "BAD_VALUE" | "NO_SECRET_STORE",
    message: string,
    readonly remediation: string,
  ) {
    super(message);
    this.name = "PluginError";
  }
}

export interface ToolRegistry {
  addTools(owner: string, defs: readonly ToolDef<any>[]): void; // eslint-disable-line @typescript-eslint/no-explicit-any
  removeTools(owner: string): void;
}

export interface HostOptions {
  dataDir: string;
  db: Db;
  events: EventLog;
  tools: ToolRegistry;
  /** The channel router. Without it, a plugin that provides a channel cannot start. */
  channels?: { attach(adapter: ChannelAdapter): Promise<void>; detach(id: string): Promise<void> };
  /** Without it, plugins that declare secrets cannot start. */
  secrets?: SecretStore;
  now?: () => number;
  /** Compiled child shim. Defaults to the one next to this module. */
  childFile?: string;
  hostSdk?: string;
  memoryMb?: number;
  startTimeoutMs?: number;
  graceMs?: number;
  /** A plugin that crashes more than `maxRestarts` times within `windowMs` is marked degraded and left stopped. */
  restart?: { baseMs: number; maxRestarts: number; windowMs: number };
}

const ID = /^[a-z][a-z0-9-]{1,62}$/;
const DEFAULT_TOOL_TIMEOUT = 30_000;

interface Runtime {
  state: "starting" | "running" | "crashed" | "degraded" | "needs_approval" | "needs_config";
  reason?: string;
  proc?: PluginProcess;
  channelId?: string;
  crashes: number[];
  timer?: NodeJS.Timeout;
  toolNames: string[];
}

function defaultChildFile(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [join(here, "child.js"), join(here, "..", "dist", "child.js")]) if (existsSync(c)) return c;
  throw new Error("cannot find the plugin child shim (child.js); run `pnpm build`");
}

/** A strict validator built from a plugin's argument declaration, so bad input never reaches plugin code. */
export function argsSchema(args: Record<string, ArgSpec>): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, a] of Object.entries(args)) {
    let t: z.ZodType;
    switch (a.type) {
      case "string":
        t = a.enum ? z.enum(a.enum as [string, ...string[]]) : z.string().max(a.maxLength ?? 4096);
        break;
      case "integer": {
        let n = z.number().int();
        if (a.min !== undefined) n = n.min(a.min);
        if (a.max !== undefined) n = n.max(a.max);
        t = n;
        break;
      }
      case "number": {
        let n = z.number().finite();
        if (a.min !== undefined) n = n.min(a.min);
        if (a.max !== undefined) n = n.max(a.max);
        t = n;
        break;
      }
      case "boolean":
        t = z.boolean();
        break;
    }
    if (a.description) t = t.describe(a.description);
    shape[name] = a.optional ? t.optional() : t;
  }
  return z.strictObject(shape) as unknown as z.ZodType<Record<string, unknown>>;
}

/** Plugin text reaches the model's context. Keep it to one tidy line. */
// eslint-disable-next-line no-control-regex
const tidy = (s: string, max: number): string => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** On Windows a folder can stay locked for a moment after the process that used it exits. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 20 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

export class PluginHost {
  private readonly runtime = new Map<string, Runtime>();
  private readonly pluginsDir: string;
  private readonly dataRoot: string;
  private readonly now: () => number;
  private readonly restart: NonNullable<HostOptions["restart"]>;
  private childFileCache: string | undefined;
  private stopped = false;

  constructor(private readonly o: HostOptions) {
    this.pluginsDir = join(o.dataDir, "plugins");
    this.dataRoot = join(o.dataDir, "plugin-data");
    this.now = o.now ?? Date.now;
    this.restart = o.restart ?? { baseMs: 1000, maxRestarts: 3, windowMs: 5 * 60_000 };
  }

  private childFile(): string {
    return (this.childFileCache ??= this.o.childFile ?? defaultChildFile());
  }

  private audit(type: string, data: Record<string, unknown>): void {
    try {
      this.o.events.append([{ type, data }]);
    } catch {
      /* the database may be closing during shutdown */
    }
  }

  private checkId(id: string): string {
    if (typeof id !== "string" || !ID.test(id)) throw new PluginError("BAD_ID", "that is not a valid plugin id", "Plugin ids are lowercase letters, digits and dashes.");
    return id;
  }

  private row(id: string): { enabled: number; version: string; approval: string } | undefined {
    return this.o.db.prepare("SELECT enabled, version, approval FROM plugins WHERE id = ?").get(id) as { enabled: number; version: string; approval: string } | undefined;
  }

  // ---------------- reading ----------------

  list(): PluginInfo[] {
    if (!existsSync(this.pluginsDir)) return [];
    const ids = readdirSync(this.pluginsDir).filter((n) => !n.startsWith(".")).sort();
    return ids.map((id) => this.describe(id));
  }

  info(id: string): PluginInfo {
    this.checkId(id);
    if (!existsSync(join(this.pluginsDir, id))) throw new PluginError("NOT_FOUND", `no plugin named ${id}`, "List installed plugins to see their ids.");
    return this.describe(id);
  }

  private describe(id: string): PluginInfo {
    const dir = join(this.pluginsDir, id);
    const insp = inspectPluginDir(dir, { expectId: id, ...(this.o.hostSdk ? { hostSdk: this.o.hostSdk } : {}) });
    if (!insp.ok) return { id, status: "invalid", reason: insp.problems[0] ?? "invalid plugin", problems: insp.problems, trust: "local-unsigned", tools: [] };
    const pkg = insp.plugin;
    const base: PluginInfo = {
      id,
      status: "disabled",
      trust: "local-unsigned",
      name: pkg.manifest.name,
      version: pkg.manifest.version,
      kind: pkg.manifest.kind,
      provides: pkg.manifest.provides,
      permissions: pkg.manifest.permissions,
      enforcement: pkg.enforcement,
      riskFloor: pkg.riskFloor,
      approvalToken: pkg.approvalToken,
      tools: [],
    };
    const row = this.row(id);
    if (!row || row.enabled !== 1) return base;
    if (row.approval !== pkg.approvalToken) {
      return { ...base, status: "needs_approval", reason: "the plugin's code or permissions changed since it was approved; review it and enable it again" };
    }
    if (pkg.manifest.kind === "bundle") return { ...base, status: "enabled", reason: "declarative bundle; nothing runs" };
    const missing = this.missingFor(pkg);
    if (missing.length > 0) return { ...base, status: "needs_config", reason: `still needs: ${missing.join(", ")}`, missing };
    const rt = this.runtime.get(id);
    if (!rt) return { ...base, status: "starting", reason: "waiting to start" };
    return { ...base, status: rt.state, ...(rt.reason ? { reason: rt.reason } : {}), tools: rt.toolNames, ...(rt.channelId ? { channel: rt.channelId } : {}) };
  }

  // ---------------- changing ----------------

  /** Copy a plugin folder into the plugins directory after checking it. Runs none of its code and enables nothing. */
  async install(srcDir: string, o: { replace?: boolean } = {}): Promise<PluginInfo> {
    const src = resolve(srcDir);
    const insp = inspectPluginDir(src);
    if (!insp.ok) throw new PluginError("INVALID", `that folder is not a valid plugin: ${insp.problems.slice(0, 3).join("; ")}`, "Fix the problems above and try again.");
    const id = this.checkId(insp.plugin.manifest.id);
    mkdirSync(this.pluginsDir, { recursive: true, mode: 0o700 });
    const rel = relative(resolve(this.pluginsDir), src);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) throw new PluginError("INVALID", "the source folder is inside the plugins folder", "Install from the folder you built or downloaded the plugin into.");

    const dest = join(this.pluginsDir, id);
    if (existsSync(dest) && !o.replace) throw new PluginError("EXISTS", `plugin ${id} is already installed`, "Use --replace to install a new version over it.");

    const tmp = join(this.pluginsDir, `.install-${randomBytes(6).toString("hex")}`);
    try {
      cpSync(src, tmp, { recursive: true, dereference: false, errorOnExist: true });
      const again = inspectPluginDir(tmp, { expectId: undefined as never });
      if (!again.ok || again.plugin.treeHash !== insp.plugin.treeHash) {
        throw new PluginError("CHANGED", "the plugin changed while it was being copied", "Try again once nothing is modifying that folder.");
      }
      if (existsSync(dest)) {
        await this.stopOne(id);
        const old = join(this.pluginsDir, `.old-${randomBytes(6).toString("hex")}`);
        await renameWithRetry(dest, old);
        await renameWithRetry(tmp, dest);
        rmSync(old, { recursive: true, force: true });
      } else renameSync(tmp, dest);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    this.audit("plugin.installed", { id, version: insp.plugin.manifest.version, files: insp.plugin.files, replaced: o.replace === true });
    return this.describe(id);
  }

  /**
   * Turn a plugin on. `approvalToken` must be the one `info` showed: it covers the exact code and permissions, so
   * anything that changed since the owner looked makes this fail instead of silently running different code.
   */
  async enable(id: string, approvalToken: string): Promise<PluginInfo> {
    this.checkId(id);
    const pkg = this.load(id);
    if (approvalToken !== pkg.approvalToken) {
      throw new PluginError("CHANGED", "the plugin or its permissions changed since you reviewed it", "Look at the plugin again and enable it with the new approval code.");
    }
    this.o.db.prepare("INSERT INTO plugins (id, enabled, version, approval, approved_at) VALUES (?, 1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET enabled = 1, version = excluded.version, approval = excluded.approval, approved_at = excluded.approved_at").run(id, pkg.manifest.version, pkg.approvalToken, this.now());
    this.audit("plugin.enabled", { id, version: pkg.manifest.version, permissions: pkg.manifest.permissions, approval: pkg.approvalToken.slice(0, 12) });
    await this.stopOne(id);
    this.runtime.delete(id);
    if (pkg.manifest.kind === "code") await this.startOne(pkg);
    return this.describe(id);
  }

  async disable(id: string): Promise<PluginInfo> {
    this.checkId(id);
    if (!existsSync(join(this.pluginsDir, id)) && !this.row(id)) throw new PluginError("NOT_FOUND", `no plugin named ${id}`, "List installed plugins to see their ids.");
    this.o.db.prepare("UPDATE plugins SET enabled = 0 WHERE id = ?").run(id);
    await this.stopOne(id);
    this.runtime.delete(id);
    this.audit("plugin.disabled", { id });
    return existsSync(join(this.pluginsDir, id)) ? this.describe(id) : { id, status: "disabled", trust: "local-unsigned", tools: [] };
  }

  async remove(id: string, o: { purgeData?: boolean } = {}): Promise<void> {
    this.checkId(id);
    await this.disable(id).catch(() => undefined);
    rmSync(join(this.pluginsDir, id), { recursive: true, force: true });
    if (o.purgeData) rmSync(join(this.dataRoot, id), { recursive: true, force: true });
    this.o.db.prepare("DELETE FROM plugins WHERE id = ?").run(id);
    this.o.db.prepare("DELETE FROM plugin_config WHERE id = ?").run(id);
    // Credentials are not left behind for a plugin that is gone.
    for (const n of this.o.secrets?.list() ?? []) if (n.startsWith(`plugin.${id}.`)) this.o.secrets?.delete(n);
    this.runtime.delete(id);
    this.audit("plugin.removed", { id, purgedData: o.purgeData === true });
  }

  /** Start everything the owner has enabled. A plugin that fails to start is contained and reported, never fatal. */
  async startEnabled(): Promise<void> {
    const rows = this.o.db.prepare("SELECT id FROM plugins WHERE enabled = 1").all() as Array<{ id: string }>;
    await Promise.allSettled(
      rows.map(async ({ id }) => {
        const info = this.describe(id);
        if (info.status === "invalid" || info.status === "needs_approval") {
          this.audit("plugin.not_started", { id, status: info.status, reason: info.reason });
          return;
        }
        if (info.kind === "bundle") return;
        const pkg = this.load(id);
        await this.startOne(pkg);
      }),
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.starting]);
    await Promise.allSettled([...this.runtime.keys()].map((id) => this.stopOne(id)));
  }

  // ---------------- settings and secrets ----------------

  private secretName(id: string, name: string): string {
    return `plugin.${id}.${name}`;
  }

  private hide(text: string): string {
    return this.o.secrets ? this.o.secrets.redact.redact(text) : text;
  }

  private storedConfig(id: string): Record<string, SettingValue> {
    const row = this.o.db.prepare("SELECT json FROM plugin_config WHERE id = ?").get(id) as { json: string } | undefined;
    if (!row) return {};
    try {
      const v: unknown = JSON.parse(row.json);
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, SettingValue>) : {};
    } catch {
      return {};
    }
  }

  /** What is still needed before the plugin can start: required settings and every declared secret. */
  private missingFor(pkg: PluginPackage): string[] {
    const out: string[] = [];
    const have = this.storedConfig(pkg.manifest.id);
    for (const [name, spec] of Object.entries(pkg.manifest.configSchema ?? {})) {
      if (!spec.optional && have[name] === undefined) out.push(`setting ${name}`);
    }
    for (const name of pkg.manifest.permissions.secrets) {
      if (this.o.secrets?.get(this.secretName(pkg.manifest.id, name)) === undefined) out.push(`secret ${name}`);
    }
    return out;
  }

  /** The values handed to the plugin: only declared settings that validate, only declared secrets. */
  private inputsFor(pkg: PluginPackage): { config: Record<string, SettingValue>; secrets: Record<string, string> } {
    const id = pkg.manifest.id;
    const have = this.storedConfig(id);
    const config: Record<string, SettingValue> = {};
    for (const name of Object.keys(pkg.manifest.configSchema ?? {})) if (have[name] !== undefined) config[name] = have[name];
    const secrets: Record<string, string> = {};
    for (const name of pkg.manifest.permissions.secrets) {
      const v = this.o.secrets?.get(this.secretName(id, name));
      if (v !== undefined) secrets[name] = v;
    }
    return { config, secrets };
  }

  /** The plugin's settings (with current values) and which secrets are set. Never returns a secret value. */
  settings(id: string): PluginSettings {
    this.checkId(id);
    const pkg = this.load(id);
    const have = this.storedConfig(id);
    const settings = Object.entries(pkg.manifest.configSchema ?? {}).map(([name, spec]) => ({
      name,
      type: spec.type,
      ...(spec.description ? { description: tidy(spec.description, 200) } : {}),
      required: !spec.optional,
      ...(spec.type === "string" && spec.enum ? { enum: spec.enum } : {}),
      ...(have[name] !== undefined ? { value: have[name] } : {}),
    }));
    const secrets = pkg.manifest.permissions.secrets.map((name) => ({ name, set: this.o.secrets?.get(this.secretName(id, name)) !== undefined }));
    return { id, settings, secrets, missing: this.missingFor(pkg) };
  }

  /** Change settings. A `null` value removes one. Everything is checked against the plugin's declaration first. */
  async setConfig(id: string, values: Record<string, SettingValue | null>): Promise<PluginSettings> {
    this.checkId(id);
    const pkg = this.load(id);
    const declared = pkg.manifest.configSchema ?? {};
    const next = { ...this.storedConfig(id) };
    for (const [name, v] of Object.entries(values)) {
      const spec = declared[name];
      if (!spec) throw new PluginError("BAD_VALUE", `plugin ${id} has no setting named ${name}`, "Run `plugins config <id>` to see the settings it declares.");
      if (v === null) {
        delete next[name];
        continue;
      }
      const ok = argsSchema({ [name]: { ...spec, optional: true } }).safeParse({ [name]: v });
      if (!ok.success) throw new PluginError("BAD_VALUE", `${name}: ${ok.error.issues[0]?.message ?? "not a valid value"}`, "Check the type and limits the plugin declares for this setting.");
      next[name] = v;
    }
    this.o.db.prepare("INSERT INTO plugin_config (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at").run(id, JSON.stringify(next), this.now());
    // Names only: a setting can be a user name or an address.
    this.audit("plugin.config_changed", { id, keys: Object.keys(values).sort() });
    await this.restartIfEnabled(id);
    return this.settings(id);
  }

  /** Store a secret the plugin declared. The value goes into the vault and is never returned, logged or audited. */
  async setSecret(id: string, name: string, value: string): Promise<PluginSettings> {
    this.checkId(id);
    const pkg = this.load(id);
    if (!this.o.secrets) throw new PluginError("NO_SECRET_STORE", "the secret store is not available", "Restart the Gateway; if this persists run the doctor command.");
    if (!pkg.manifest.permissions.secrets.includes(name)) throw new PluginError("BAD_VALUE", `plugin ${id} does not declare a secret named ${name}`, "Only secrets listed in the plugin's permissions can be stored for it.");
    // eslint-disable-next-line no-control-regex
    if (value.length === 0 || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) throw new PluginError("BAD_VALUE", "a secret must be 1 to 8192 characters on one line", "Check what you pasted; trailing newlines are removed for you.");
    try {
      this.o.secrets.set(this.secretName(id, name), value);
    } catch {
      throw new PluginError("NO_SECRET_STORE", "the secret store could not be opened, so nothing was saved", "Check the Gateway log for `vault.unavailable`, then restart it.");
    }
    this.audit("plugin.secret_set", { id, name });
    await this.restartIfEnabled(id);
    return this.settings(id);
  }

  async deleteSecret(id: string, name: string): Promise<PluginSettings> {
    this.checkId(id);
    const pkg = this.load(id);
    if (!pkg.manifest.permissions.secrets.includes(name)) throw new PluginError("BAD_VALUE", `plugin ${id} does not declare a secret named ${name}`, "Only secrets listed in the plugin's permissions can be removed.");
    this.o.secrets?.delete(this.secretName(id, name));
    this.audit("plugin.secret_deleted", { id, name });
    await this.restartIfEnabled(id);
    return this.settings(id);
  }

  /** A plugin only reads its settings at start, so a change takes effect by starting it again. */
  private async restartIfEnabled(id: string): Promise<void> {
    const row = this.row(id);
    if (!row || row.enabled !== 1) return;
    const pkg = this.load(id);
    if (row.approval !== pkg.approvalToken || pkg.manifest.kind !== "code") return;
    await this.stopOne(id);
    const rt = this.runtime.get(id);
    if (rt) rt.crashes = [];
    await this.startOne(pkg);
  }

  // ---------------- running ----------------

  private load(id: string): PluginPackage {
    const dir = join(this.pluginsDir, id);
    if (!existsSync(dir)) throw new PluginError("NOT_FOUND", `no plugin named ${id}`, "List installed plugins to see their ids.");
    const insp = inspectPluginDir(dir, { expectId: id, ...(this.o.hostSdk ? { hostSdk: this.o.hostSdk } : {}) });
    if (!insp.ok) throw new PluginError("INVALID", `plugin ${id} is not valid: ${insp.problems.slice(0, 3).join("; ")}`, "Fix the plugin or reinstall it.");
    return insp.plugin;
  }

  /** Starts that have not finished. Shutdown waits for them so no plugin process outlives the Gateway. */
  private readonly starting = new Set<Promise<void>>();

  private startOne(pkg: PluginPackage): Promise<void> {
    const p = this.doStart(pkg).finally(() => this.starting.delete(p));
    this.starting.add(p);
    return p;
  }

  private async doStart(pkg: PluginPackage): Promise<void> {
    if (this.stopped) return;
    const id = pkg.manifest.id;
    const rt: Runtime = this.runtime.get(id) ?? { state: "starting", crashes: [], toolNames: [] };
    rt.state = "starting";
    delete rt.reason;
    this.runtime.set(id, rt);
    const dataDir = pkg.manifest.permissions.fs.length > 0 ? join(this.dataRoot, id) : undefined;
    if (dataDir) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const missing = this.missingFor(pkg);
    if (missing.length > 0) {
      // Not a failure: the plugin simply is not set up yet. It starts as soon as the owner provides the rest.
      rt.state = "needs_config";
      rt.reason = `still needs: ${missing.join(", ")}`;
      this.audit("plugin.needs_config", { id, missing });
      return;
    }
    const inputs = this.inputsFor(pkg);
    const chan: { adapter?: PluginChannelAdapter } = {};
    try {
      const proc = await PluginProcess.start({
        id,
        dir: pkg.dir,
        entry: join(pkg.dir, pkg.manifest.entry ?? ""),
        dataDir,
        exec: pkg.manifest.permissions.exec,
        config: inputs.config,
        secrets: inputs.secrets,
        childFile: this.childFile(),
        ...(this.o.memoryMb ? { memoryMb: this.o.memoryMb } : {}),
        ...(this.o.startTimeoutMs ? { startTimeoutMs: this.o.startTimeoutMs } : {}),
        ...(this.o.graceMs ? { graceMs: this.o.graceMs } : {}),
        onDeliver: (m) => chan.adapter?.inbound(m) ?? Promise.resolve({ result: "unavailable" }),
        onChannelStatus: (s) => chan.adapter?.report(s),
        onLog: (l) => {
          if (l.level === "warn" || l.level === "error") this.audit("plugin.log", { id, level: l.level, message: this.hide(l.message) });
        },
        onExit: (info) => this.onExit(id, info),
      });
      if (this.stopped) {
        await proc.stop();
        return;
      }
      if (proc.channel) {
        const problem = !pkg.manifest.provides.includes(`channel:${proc.channel.id}`)
          ? `the plugin registered channel "${proc.channel.id}" but its manifest does not list channel:${proc.channel.id} in provides`
          : !this.o.channels
            ? "this Gateway has no channel router"
            : undefined;
        if (problem) {
          await proc.stop();
          rt.state = "degraded";
          rt.reason = problem;
          this.audit("plugin.degraded", { id, reason: problem });
          return;
        }
        chan.adapter = new PluginChannelAdapter(proc.channel, proc);
      }
      const defs = proc.tools.map((t) => this.toolDef(id, pkg, t, rt));
      try {
        this.o.tools.addTools(id, defs);
      } catch (e) {
        await proc.stop();
        rt.state = "degraded";
        rt.reason = e instanceof Error ? e.message : "could not register tools";
        this.audit("plugin.degraded", { id, reason: rt.reason });
        return;
      }
      rt.proc = proc;
      rt.state = "running";
      rt.toolNames = defs.map((d) => d.name);
      if (chan.adapter) {
        try {
          await this.o.channels?.attach(chan.adapter);
          rt.channelId = chan.adapter.id;
        } catch (e) {
          // For instance another channel already uses that id. The plugin is stopped rather than left half-working.
          this.o.tools.removeTools(id);
          rt.proc = undefined;
          rt.toolNames = [];
          await proc.stop();
          rt.state = "degraded";
          rt.reason = e instanceof Error ? e.message.slice(0, 200) : "could not register the channel";
          this.audit("plugin.degraded", { id, reason: rt.reason });
          return;
        }
      }
      this.audit("plugin.started", { id, tools: rt.toolNames, ...(rt.channelId ? { channel: rt.channelId } : {}) });
    } catch (e) {
      rt.proc = undefined;
      this.noteFailure(id, rt, e instanceof PluginProcessError || e instanceof Error ? e.message : "failed to start");
    }
  }

  private toolDef(id: string, pkg: PluginPackage, reg: ToolRegistration, rt: Runtime): ToolDef {
    const timeoutMs = reg.timeoutMs ?? DEFAULT_TOOL_TIMEOUT;
    return {
      name: `${id}.${reg.name}`,
      description: tidy(`${reg.description} (provided by plugin ${id})`, 600),
      // A plugin may ask for more caution than its permissions imply, never for less.
      risk: Math.max(reg.risk, pkg.riskFloor) as Risk,
      schema: argsSchema(reg.args),
      outputUntrusted: true,
      timeoutMs,
      run: async (args, env) => {
        const proc = rt.proc;
        if (!proc || !proc.alive) throw new Error(`plugin ${id} is not running`);
        try {
          // A plugin holds its own secrets, so a careless one could echo them into the model's context. Hide them.
          return this.o.secrets ? this.o.secrets.redact.redactDeep(await proc.call(reg.name, args, { signal: env.signal, timeoutMs })) : await proc.call(reg.name, args, { signal: env.signal, timeoutMs });
        } catch (e) {
          if (e instanceof Error) e.message = this.hide(e.message);
          throw e;
        }
      },
    };
  }

  private onExit(id: string, info: { expected: boolean; code: number | null; detail: string }): void {
    const rt = this.runtime.get(id);
    if (!rt || info.expected || this.stopped) return;
    this.o.tools.removeTools(id);
    this.withdrawChannel(rt);
    rt.proc = undefined;
    rt.toolNames = [];
    this.audit("plugin.crashed", { id, exitCode: info.code, detail: info.detail.slice(0, 300) });
    this.noteFailure(id, rt, `the plugin process ended unexpectedly${info.code != null ? ` (exit ${info.code})` : ""}${info.detail ? `: ${info.detail}` : ""}`);
  }

  /** Count a failure; restart with backoff, or give up and mark the plugin degraded. */
  private noteFailure(id: string, rt: Runtime, reason: string): void {
    const t = this.now();
    rt.crashes = rt.crashes.filter((c) => t - c < this.restart.windowMs);
    rt.crashes.push(t);
    rt.reason = reason.slice(0, 400);
    if (this.stopped) return;
    if (rt.crashes.length > this.restart.maxRestarts) {
      rt.state = "degraded";
      this.o.tools.removeTools(id);
      this.audit("plugin.degraded", { id, reason: rt.reason, failures: rt.crashes.length });
      return;
    }
    rt.state = "crashed";
    const delay = this.restart.baseMs * 2 ** (rt.crashes.length - 1);
    rt.timer = setTimeout(() => {
      rt.timer = undefined;
      if (this.stopped) return;
      // Re-check the code on disk before running it again: a restart is not a free pass for a modified plugin.
      let pkg: PluginPackage;
      try {
        pkg = this.load(id);
      } catch (e) {
        rt.state = "degraded";
        rt.reason = e instanceof Error ? e.message : "plugin is no longer valid";
        return;
      }
      const row = this.row(id);
      if (!row || row.enabled !== 1 || row.approval !== pkg.approvalToken) {
        rt.state = "needs_approval";
        rt.reason = "the plugin changed since it was approved";
        return;
      }
      void this.startOne(pkg);
    }, delay);
    rt.timer.unref();
  }

  /** Take a crashed plugin out of the router so nothing is routed to a dead process. */
  private withdrawChannel(rt: Runtime): void {
    const leaving = rt.channelId;
    rt.channelId = undefined;
    if (leaving) void this.o.channels?.detach(leaving);
  }

  private async stopOne(id: string): Promise<void> {
    const rt = this.runtime.get(id);
    if (!rt) return;
    if (rt.timer) clearTimeout(rt.timer);
    rt.timer = undefined;
    this.o.tools.removeTools(id);
    const leaving = rt.channelId;
    rt.channelId = undefined;
    if (leaving) await this.o.channels?.detach(leaving);
    const p = rt.proc;
    rt.proc = undefined;
    rt.toolNames = [];
    await p?.stop();
  }
}
