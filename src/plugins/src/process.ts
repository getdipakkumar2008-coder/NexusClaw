import { fork, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { z } from "zod";
import { LIMITS, channelRegistrationSchema, toolRegistrationSchema, type ChannelRegistration, type ToolRegistration } from "@clawnexus/plugin-sdk";
import { killTree } from "@clawnexus/tools";

export class PluginProcessError extends Error {
  constructor(
    readonly code: "START_FAILED" | "CRASHED" | "TIMEOUT" | "BUSY" | "BAD_REPLY" | "TOOL_FAILED" | "CANCELLED" | "STOPPED",
    message: string,
  ) {
    super(message);
  }
}

export interface LogLine {
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

export interface ProcessOptions {
  id: string;
  /** The plugin's folder (read-only to the plugin). */
  dir: string;
  /** Absolute path of the plugin's entry file. */
  entry: string;
  /** The plugin's private data folder (read and write), when its manifest asked for `data`. */
  dataDir?: string | undefined;
  /** Whether the manifest asked to start programs. Otherwise the process cannot. */
  exec: boolean;
  /** The owner's settings and the declared secrets this plugin receives. Nothing else is passed. */
  config?: Record<string, string | number | boolean>;
  secrets?: Record<string, string>;
  /** The plugin's channel hands an inbound message to the router. Resolves with what the router did. */
  onDeliver?(message: unknown): Promise<unknown>;
  onChannelStatus?(status: unknown): void;
  /** Absolute path of the compiled child shim. */
  childFile: string;
  memoryMb?: number;
  startTimeoutMs?: number;
  /** After a cancel or timeout, how long the plugin gets to stop before its process is ended. */
  graceMs?: number;
  maxInflight?: number;
  /** Called once when the process ends for any reason. */
  onExit(info: { expected: boolean; code: number | null; signal: string | null; detail: string }): void;
  onLog?(line: LogLine): void;
}

const messageSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("ready"), tools: z.array(z.unknown()).max(LIMITS.toolsPerPlugin), channel: z.unknown().optional() }),
  z.object({ t: z.literal("deliver"), rid: z.number().int(), message: z.unknown() }),
  z.object({ t: z.literal("chstatus"), status: z.unknown() }),
  z.object({ t: z.literal("result"), id: z.number().int(), ok: z.boolean(), value: z.unknown().optional(), error: z.string().max(1000).optional() }),
  z.object({ t: z.literal("log"), level: z.enum(["debug", "info", "warn", "error"]), message: z.string().max(2000) }),
  z.object({ t: z.literal("fatal"), message: z.string().max(1000) }),
]);

/** Variables the plugin may see. Nothing from our environment (keys, tokens, home folder) is passed along. */
function pluginEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { LANG: "C.UTF-8", TZ: process.env["TZ"] ?? "UTC" };
  // Windows networking and DNS need these to work at all.
  for (const k of ["SYSTEMROOT", "SystemRoot", "WINDIR"]) if (process.env[k]) env[k] = process.env[k];
  return env;
}

const scrub = (t: string): string => t.replace(/[\w-]{24,}/g, "[redacted]").replace(/\s+/g, " ").trim().slice(0, 400);

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  cleanup(): void;
}

/**
 * One running plugin: a child process whose abilities are fixed at spawn by Node's permission model.
 * The plugin is untrusted. Whatever it sends is validated; whatever it does wrong ends in this process
 * (and only this one) being replaced.
 */
export class PluginProcess {
  readonly tools: ToolRegistration[] = [];
  /** The channel the plugin registered, validated. */
  channel: ChannelRegistration | undefined;
  private deliverInflight = 0;
  private readonly pending = new Map<number, Pending>();
  /** Calls we stopped waiting for. If the plugin never answers them it is stuck, and its process is ended. */
  private readonly abandoned = new Set<number>();
  private nextId = 1;
  private stderrTail = "";
  private exited = false;
  private stopping = false;
  private logTokens = 20;
  private logRefill = Date.now();
  private fatal: string | undefined;
  private readyResolve?: (r: { tools: unknown[]; channel: unknown }) => void;
  private readyReject?: (e: Error) => void;

  private constructor(
    private readonly child: ChildProcess,
    private readonly o: ProcessOptions,
  ) {
    child.stderr?.on("data", (c: Buffer) => {
      this.stderrTail = (this.stderrTail + c.toString("utf8")).slice(-4096);
    });
    child.stdout?.on("data", () => undefined); // the plugin's stdout is not a channel; drain it so it can never block
    child.on("message", (m) => this.onMessage(m));
    child.on("error", (e) => this.finish(null, null, e.message));
    child.on("exit", (code, signal) => this.finish(code, signal, ""));
  }

  get alive(): boolean {
    return !this.exited;
  }

  get inflight(): number {
    return this.pending.size;
  }

  diagnostics(): string {
    return this.fatal ?? scrub(this.stderrTail);
  }

  static async start(opts: ProcessOptions): Promise<PluginProcess> {
    // Node checks permissions against real paths, so grant real paths. (On macOS the temp folder /var is a link to
    // /private/var; granting the linked name would deny the plugin access to its own folder.)
    const real = (p: string): string => realpathSync.native(p);
    const o: ProcessOptions = { ...opts, dir: real(opts.dir), entry: real(opts.entry), childFile: real(opts.childFile), dataDir: opts.dataDir ? real(opts.dataDir) : undefined };
    const args = ["--permission", `--allow-fs-read=${o.childFile}`, `--allow-fs-read=${o.dir}`, `--max-old-space-size=${o.memoryMb ?? 128}`];
    if (o.dataDir) args.push(`--allow-fs-read=${o.dataDir}`, `--allow-fs-write=${o.dataDir}`);
    if (o.exec) args.push("--allow-child-process");
    let child: ChildProcess;
    try {
      child = fork(o.childFile, [], {
        execArgv: args,
        cwd: o.dir,
        env: pluginEnv(),
        serialization: "json",
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (e) {
      throw new PluginProcessError("START_FAILED", `could not start the plugin process: ${e instanceof Error ? e.message : String(e)}`);
    }
    const p = new PluginProcess(child, o);
    const ready = new Promise<{ tools: unknown[]; channel: unknown }>((resolve, reject) => {
      p.readyResolve = resolve;
      p.readyReject = reject;
    });
    const timer = setTimeout(() => p.readyReject?.(new PluginProcessError("TIMEOUT", `the plugin did not finish starting within ${(o.startTimeoutMs ?? 10_000) / 1000} s`)), o.startTimeoutMs ?? 10_000);
    timer.unref();
    child.send({ t: "init", pluginId: o.id, entry: o.entry, dataDir: o.dataDir, config: o.config ?? {}, secrets: o.secrets ?? {} });
    try {
      const raw = await ready;
      if (raw.channel !== undefined) {
        const c = channelRegistrationSchema.safeParse(raw.channel);
        if (!c.success) throw new PluginProcessError("BAD_REPLY", `the plugin registered an invalid channel: ${c.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 300)}`);
        p.channel = c.data;
      }
      for (const t of raw.tools) {
        const parsed = toolRegistrationSchema.safeParse(t);
        if (!parsed.success) {
          throw new PluginProcessError("BAD_REPLY", `the plugin registered an invalid tool: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 300)}`);
        }
        if (p.tools.some((x) => x.name === parsed.data.name)) throw new PluginProcessError("BAD_REPLY", `tool ${parsed.data.name} is registered twice`);
        p.tools.push(parsed.data);
      }
    } catch (e) {
      p.stopping = true;
      p.kill();
      await p.exitedWithin(3000); // do not report failure while the process still holds its folder
      throw e;
    } finally {
      clearTimeout(timer);
    }
    return p;
  }

  private onMessage(raw: unknown): void {
    const parsed = messageSchema.safeParse(raw);
    if (!parsed.success) return; // ignore garbage; a plugin that only sends garbage will fail its calls
    const m = parsed.data;
    switch (m.t) {
      case "ready":
        this.readyResolve?.({ tools: m.tools, channel: m.channel });
        return;
      case "chstatus":
        this.o.onChannelStatus?.(m.status);
        return;
      case "deliver": {
        // A channel can deliver many messages at once; do not let a flood pile up in the Gateway.
        const reply = (outcome: unknown): void => {
          try {
            this.child.send({ t: "deliverResult", rid: m.rid, outcome });
          } catch {
            /* the plugin is gone */
          }
        };
        if (!this.o.onDeliver || this.deliverInflight >= 32) return reply({ result: this.o.onDeliver ? "limited" : "unavailable" });
        this.deliverInflight++;
        this.o.onDeliver(m.message).then(reply, () => reply({ result: "unavailable" })).finally(() => void this.deliverInflight--);
        return;
      }
      case "fatal":
        this.fatal = scrub(m.message);
        this.readyReject?.(new PluginProcessError("START_FAILED", this.fatal));
        return;
      case "log": {
        const now = Date.now();
        this.logTokens = Math.min(20, this.logTokens + ((now - this.logRefill) / 1000) * 20);
        this.logRefill = now;
        if (this.logTokens < 1) return; // a chatty plugin cannot flood the log
        this.logTokens -= 1;
        this.o.onLog?.({ level: m.level, message: scrub(m.message) });
        return;
      }
      case "result": {
        if (this.abandoned.delete(m.id)) return; // a late answer to a call nobody waits for any more
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        p.cleanup();
        if (!m.ok) return p.reject(new PluginProcessError("TOOL_FAILED", scrub(m.error ?? "the tool failed")));
        const size = Buffer.byteLength(JSON.stringify(m.value ?? null), "utf8");
        if (size > LIMITS.resultBytes) return p.reject(new PluginProcessError("BAD_REPLY", `the result is larger than ${LIMITS.resultBytes} bytes`));
        p.resolve(m.value ?? null);
      }
    }
  }

  call(tool: string, args: unknown, o: { signal?: AbortSignal; timeoutMs: number }): Promise<unknown> {
    if (this.exited) return Promise.reject(new PluginProcessError("CRASHED", "the plugin is not running"));
    if (this.pending.size >= (this.o.maxInflight ?? 8)) return Promise.reject(new PluginProcessError("BUSY", "the plugin is busy with too many calls"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timers: { call?: NodeJS.Timeout; grace?: NodeJS.Timeout } = {};
      const cleanup = (): void => {
        if (timers.call) clearTimeout(timers.call);
        if (timers.grace) clearTimeout(timers.grace);
        o.signal?.removeEventListener("abort", onAbort);
      };
      const giveUp = (code: "TIMEOUT" | "CANCELLED", msg: string): void => {
        // Ask politely, then end the process if the plugin is stuck. Either way the caller is released now.
        try {
          this.child.send({ t: "cancel", id });
        } catch {
          /* already gone */
        }
        this.pending.delete(id);
        this.abandoned.add(id);
        cleanup();
        reject(new PluginProcessError(code, msg));
        timers.grace = setTimeout(() => {
          if (this.abandoned.has(id)) this.kill(); // it never wound the call down: it is stuck
        }, this.o.graceMs ?? 3000);
        timers.grace.unref();
      };
      const onAbort = (): void => giveUp("CANCELLED", "cancelled");
      if (o.signal?.aborted) return reject(new PluginProcessError("CANCELLED", "cancelled"));
      o.signal?.addEventListener("abort", onAbort, { once: true });
      timers.call = setTimeout(() => giveUp("TIMEOUT", `the plugin tool timed out after ${o.timeoutMs} ms`), o.timeoutMs);
      timers.call.unref();
      this.pending.set(id, { resolve, reject, cleanup });
      try {
        this.child.send({ t: "call", id, tool, args });
      } catch (e) {
        this.pending.delete(id);
        cleanup();
        reject(new PluginProcessError("CRASHED", `could not reach the plugin: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  }

  private finish(code: number | null, signal: string | null, detail: string): void {
    if (this.exited) return;
    this.exited = true;
    const err = new PluginProcessError(this.stopping ? "STOPPED" : "CRASHED", this.stopping ? "the plugin was stopped" : `the plugin process ended unexpectedly${code != null ? ` (exit ${code})` : ""}`);
    this.readyReject?.(this.fatal ? new PluginProcessError("START_FAILED", this.fatal) : err);
    for (const p of this.pending.values()) {
      p.cleanup();
      p.reject(err);
    }
    this.pending.clear();
    this.o.onExit({ expected: this.stopping, code, signal, detail: detail || this.diagnostics() });
  }

  /** Resolves once the process is gone, or after `ms` if it is not. */
  exitedWithin(ms: number): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref();
      this.child.once("exit", () => (clearTimeout(t), resolve()));
    });
  }

  kill(): void {
    if (this.child.pid !== undefined && !this.exited) killTree(this.child.pid);
  }

  /** Ask the plugin to clean up, then make sure it is gone. */
  async stop(graceMs = 2000): Promise<void> {
    if (this.exited) return;
    this.stopping = true;
    try {
      this.child.send({ t: "dispose" });
    } catch {
      /* already gone */
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.kill();
        setTimeout(resolve, 300).unref();
      }, graceMs);
      t.unref();
      this.child.once("exit", () => (clearTimeout(t), resolve()));
    });
  }
}
