import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { PluginManifest, ToolRegistration, ArgSpec } from "@clawnexus/plugin-sdk";
import type { Risk } from "@clawnexus/policy";
import type { Db, EventLog } from "@clawnexus/store";
import type { ToolDef } from "@clawnexus/tools";
import { inspectPluginDir, type Enforcement, type PluginPackage } from "./package.js";
import { PluginProcess, PluginProcessError } from "./process.js";

export type PluginStatus = "disabled" | "enabled" | "starting" | "running" | "crashed" | "degraded" | "needs_approval" | "invalid";

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
  problems?: string[];
}

export class PluginError extends Error {
  constructor(
    readonly code: "BAD_ID" | "NOT_FOUND" | "INVALID" | "EXISTS" | "CHANGED" | "BUSY",
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
  state: "starting" | "running" | "crashed" | "degraded" | "needs_approval";
  reason?: string;
  proc?: PluginProcess;
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
    const rt = this.runtime.get(id);
    if (!rt) return { ...base, status: "starting", reason: "waiting to start" };
    return { ...base, status: rt.state, ...(rt.reason ? { reason: rt.reason } : {}), tools: rt.toolNames };
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
        renameSync(dest, old);
        renameSync(tmp, dest);
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
    await Promise.allSettled([...this.runtime.keys()].map((id) => this.stopOne(id)));
  }

  // ---------------- running ----------------

  private load(id: string): PluginPackage {
    const dir = join(this.pluginsDir, id);
    if (!existsSync(dir)) throw new PluginError("NOT_FOUND", `no plugin named ${id}`, "List installed plugins to see their ids.");
    const insp = inspectPluginDir(dir, { expectId: id, ...(this.o.hostSdk ? { hostSdk: this.o.hostSdk } : {}) });
    if (!insp.ok) throw new PluginError("INVALID", `plugin ${id} is not valid: ${insp.problems.slice(0, 3).join("; ")}`, "Fix the plugin or reinstall it.");
    return insp.plugin;
  }

  private async startOne(pkg: PluginPackage): Promise<void> {
    if (this.stopped) return;
    const id = pkg.manifest.id;
    const rt: Runtime = this.runtime.get(id) ?? { state: "starting", crashes: [], toolNames: [] };
    rt.state = "starting";
    delete rt.reason;
    this.runtime.set(id, rt);
    const dataDir = pkg.manifest.permissions.fs.length > 0 ? join(this.dataRoot, id) : undefined;
    if (dataDir) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    try {
      const proc = await PluginProcess.start({
        id,
        dir: pkg.dir,
        entry: join(pkg.dir, pkg.manifest.entry ?? ""),
        dataDir,
        exec: pkg.manifest.permissions.exec,
        childFile: this.childFile(),
        ...(this.o.memoryMb ? { memoryMb: this.o.memoryMb } : {}),
        ...(this.o.startTimeoutMs ? { startTimeoutMs: this.o.startTimeoutMs } : {}),
        ...(this.o.graceMs ? { graceMs: this.o.graceMs } : {}),
        onLog: (l) => {
          if (l.level === "warn" || l.level === "error") this.audit("plugin.log", { id, level: l.level, message: l.message });
        },
        onExit: (info) => this.onExit(id, info),
      });
      if (this.stopped) {
        await proc.stop();
        return;
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
      this.audit("plugin.started", { id, tools: rt.toolNames });
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
        return proc.call(reg.name, args, { signal: env.signal, timeoutMs });
      },
    };
  }

  private onExit(id: string, info: { expected: boolean; code: number | null; detail: string }): void {
    const rt = this.runtime.get(id);
    if (!rt || info.expected || this.stopped) return;
    this.o.tools.removeTools(id);
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

  private async stopOne(id: string): Promise<void> {
    const rt = this.runtime.get(id);
    if (!rt) return;
    if (rt.timer) clearTimeout(rt.timer);
    rt.timer = undefined;
    this.o.tools.removeTools(id);
    const p = rt.proc;
    rt.proc = undefined;
    rt.toolNames = [];
    await p?.stop();
  }
}
