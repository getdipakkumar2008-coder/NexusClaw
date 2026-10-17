import { decide, type ApprovalStore, type PrincipalKind, type Profile, type Risk } from "@clawnexus/policy";
import type { EventLog } from "@clawnexus/store";
import { toJSONSchema, type ZodType } from "zod";
import type { WorkspaceGuard } from "./guard.js";

/** What a tool's implementation receives. */
export interface ToolEnv {
  guard: WorkspaceGuard;
  signal: AbortSignal;
  /** Who the call is for. Tools that keep per-person data (memory) scope themselves by this, never by their arguments. */
  principal: PrincipalKind;
  session?: string;
}

export interface ToolDef<A = unknown> {
  name: string;
  description: string;
  risk: Risk;
  /** Arguments are validated against this before anything else happens. Must reject unknown keys. */
  schema: ZodType<A>;
  /** Output may contain attacker-controlled text (file contents, command output, web pages). */
  outputUntrusted?: boolean;
  /** Hard upper bound on a single call. */
  timeoutMs?: number;
  run(args: A, env: ToolEnv): Promise<unknown>;
}

export interface CallRequest {
  tool: string;
  args: unknown;
  principal: PrincipalKind;
  /** Stable id of the caller; approvals are bound to it. */
  principalId: string;
  profile: Profile;
  /** Whether untrusted content is already in the run's context. */
  tainted: boolean;
  sandboxed?: boolean;
  elevation?: Risk;
  session?: string;
  /** Present when retrying a call the owner has since approved. */
  approvalId?: string;
  signal?: AbortSignal;
}

export type CallResult =
  | { status: "ok"; output: unknown; /** The run's context is now tainted. */ taints: boolean }
  | { status: "denied"; reason: string }
  | { status: "approval_required"; approvalId: string; reason: string }
  | { status: "error"; code: "UNKNOWN_TOOL" | "INVALID_ARGS" | "BAD_APPROVAL" | "FAILED" | "TIMEOUT" | "CANCELLED"; message: string };

export interface ExecutorOptions {
  events: EventLog;
  approvals: ApprovalStore;
  guard: WorkspaceGuard;
  tools: readonly ToolDef<any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  defaultTimeoutMs?: number;
  /** After a timeout or cancel, how long to wait for the tool to wind down before reporting back. */
  abortGraceMs?: number;
  /** Largest serialized tool output returned to the caller. */
  maxOutputBytes?: number;
}

/** Most approvals one caller may have waiting at once. */
const MAX_PENDING_PER_REQUESTER = 5;

const SECRET_KEY = /(token|secret|passw(or)?d|api[_-]?key|authorization|credential|private[_-]?key)/i;

/** Compact, secret-free rendering of arguments for the audit log. */
export function summarizeArgs(args: unknown): string {
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return v.length > 200 ? `${v.slice(0, 200)}...(${v.length} chars)` : v;
    if (v === null || typeof v !== "object") return v;
    if (depth > 4) return "[nested]";
    if (Array.isArray(v)) return v.slice(0, 20).map((x) => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY.test(k) ? "[redacted]" : walk(x, depth + 1);
    return out;
  };
  const text = JSON.stringify(walk(args, 0)) ?? "null";
  return text.length > 2000 ? `${text.slice(0, 2000)}...` : text;
}

/**
 * The only way tools run. Order of checks is fixed and tested: known tool, valid arguments, policy decision,
 * approval (bound to this exact call and caller), then execution with a timeout. Every outcome is audited.
 * Approvals are not awaited here: the caller gets `approval_required` and retries with `approvalId` once the
 * owner has decided, so no connection or run is held hostage by a person who walked away.
 */
export class ToolExecutor {
  private readonly tools = new Map<string, ToolDef<any>>(); // eslint-disable-line @typescript-eslint/no-explicit-any
  private readonly o: Required<Pick<ExecutorOptions, "defaultTimeoutMs" | "maxOutputBytes" | "abortGraceMs">> & ExecutorOptions;

  constructor(opts: ExecutorOptions) {
    for (const t of opts.tools) {
      if (this.tools.has(t.name)) throw new Error(`duplicate tool ${t.name}`);
      this.tools.set(t.name, t);
    }
    this.o = { defaultTimeoutMs: 30_000, abortGraceMs: 3_000, maxOutputBytes: 256 * 1024, ...opts };
  }

  /** Tool names grouped by who added them, so a plugin's tools can be withdrawn together. */
  private readonly owned = new Map<string, string[]>();

  /**
   * Add tools on behalf of an owner (a plugin). A name that is already taken is an error: a plugin can never
   * replace or shadow a built-in tool, nor another plugin's. All-or-nothing.
   */
  addTools(owner: string, defs: readonly ToolDef<any>[]): void { // eslint-disable-line @typescript-eslint/no-explicit-any
    const names = new Set<string>();
    const mine = new Set(this.owned.get(owner));
    for (const d of defs) {
      if ((this.tools.has(d.name) && !mine.has(d.name)) || names.has(d.name)) throw new Error(`tool ${d.name} already exists`);
      names.add(d.name);
    }
    this.removeTools(owner);
    for (const d of defs) this.tools.set(d.name, d);
    this.owned.set(owner, [...names]);
  }

  removeTools(owner: string): void {
    for (const n of this.owned.get(owner) ?? []) {
      this.tools.delete(n);
      this.schemas.delete(n);
    }
    this.owned.delete(owner);
  }

  list(): Array<{ name: string; description: string; risk: Risk; inputSchema: Record<string, unknown> }> {
    return [...this.tools.values()].map((t) => ({ name: t.name, description: t.description, risk: t.risk, inputSchema: this.jsonSchema(t) }));
  }

  private readonly schemas = new Map<string, Record<string, unknown>>();
  private jsonSchema(t: ToolDef<any>): Record<string, unknown> { // eslint-disable-line @typescript-eslint/no-explicit-any
    let s = this.schemas.get(t.name);
    if (!s) {
      try {
        s = { ...(toJSONSchema(t.schema) as Record<string, unknown>) };
        delete s["$schema"];
      } catch {
        s = { type: "object" };
      }
      this.schemas.set(t.name, s);
    }
    return s;
  }

  async call(req: CallRequest): Promise<CallResult> {
    const def = this.tools.get(req.tool);
    if (!def) return this.finish(req, "error", { status: "error", code: "UNKNOWN_TOOL", message: `unknown tool ${req.tool}` });

    const parsed = def.schema.safeParse(req.args);
    if (!parsed.success) {
      const why = parsed.error.issues.map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`).join("; ");
      return this.finish(req, "error", { status: "error", code: "INVALID_ARGS", message: why.slice(0, 500) }, def);
    }
    const args = parsed.data;

    const decision = decide(
      { name: def.name, risk: def.risk },
      {
        principal: req.principal,
        profile: req.profile,
        tainted: req.tainted,
        sandboxed: req.sandboxed ?? false,
        ...(req.elevation === undefined ? {} : { elevation: req.elevation }),
      },
    );
    if (decision.effect === "deny") return this.finish(req, "denied", { status: "denied", reason: decision.reason }, def);

    if (decision.effect === "ask") {
      const gate = this.checkApproval(req, def, args, decision.reason);
      if (gate) return gate;
    }

    return this.execute(req, def, args);
  }

  private checkApproval(req: CallRequest, def: ToolDef<any>, args: unknown, reason: string): CallResult | undefined { // eslint-disable-line @typescript-eslint/no-explicit-any
    const { approvals } = this.o;
    if (req.approvalId === undefined) {
      // A confused or hijacked caller must not be able to bury the owner in requests.
      if (approvals.list().filter((x) => x.requester === req.principalId).length >= MAX_PENDING_PER_REQUESTER) {
        return this.finish(req, "denied", { status: "denied", reason: "too many approvals are already waiting for the owner" }, def);
      }
      const a = approvals.create({ tool: def.name, args, requester: req.principalId });
      this.o.events.append([
        {
          type: "approval.requested",
          ...(req.session === undefined ? {} : { session: req.session }),
          data: { id: a.id, tool: def.name, risk: def.risk, requester: req.principalId, reason, args: summarizeArgs(args), expiresAt: a.expiresAt },
        },
      ]);
      return { status: "approval_required", approvalId: a.id, reason };
    }
    const existing = approvals.get(req.approvalId);
    if (!existing || existing.requester !== req.principalId) {
      return this.finish(req, "error", { status: "error", code: "BAD_APPROVAL", message: "unknown approval" }, def);
    }
    if (existing.state === "pending") return { status: "approval_required", approvalId: existing.id, reason: "still waiting for the owner" };
    if (existing.state === "denied") return this.finish(req, "denied", { status: "denied", reason: "the owner denied this call" }, def);
    // approved: spend it. Fails if it is for different arguments, expired or already used.
    if (!approvals.consume(req.approvalId, def.name, args)) {
      return this.finish(req, "error", { status: "error", code: "BAD_APPROVAL", message: `approval is ${existing.state} or does not match this call` }, def);
    }
    return undefined;
  }

  private async execute(req: CallRequest, def: ToolDef<any>, args: unknown): Promise<CallResult> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const abort = new AbortController();
    const onCallerAbort = (): void => abort.abort("cancelled");
    if (req.signal?.aborted) onCallerAbort();
    else req.signal?.addEventListener("abort", onCallerAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort("timeout");
    }, def.timeoutMs ?? this.o.defaultTimeoutMs);
    timer.unref();
    const aborted = new Promise<"aborted">((r) => abort.signal.addEventListener("abort", () => r("aborted"), { once: true }));

    this.audit(req, def, "tool.started", { args: summarizeArgs(args) });
    try {
      const running = def.run(args, { guard: this.o.guard, signal: abort.signal, principal: req.principal, ...(req.session === undefined ? {} : { session: req.session }) });
      running.catch(() => undefined);
      const out = await Promise.race([running, aborted]);
      if (out === "aborted") {
        // Give the tool a moment to honour the abort (e.g. kill its process tree) before reporting back.
        await Promise.race([running.then(() => undefined, () => undefined), new Promise((r) => setTimeout(r, this.o.abortGraceMs).unref())]);
        return timedOut
          ? this.finish(req, "error", { status: "error", code: "TIMEOUT", message: "tool timed out" }, def)
          : this.finish(req, "error", { status: "error", code: "CANCELLED", message: "cancelled" }, def);
      }
      const text = JSON.stringify(out) ?? "null";
      if (Buffer.byteLength(text, "utf8") > this.o.maxOutputBytes) {
        return this.finish(req, "error", { status: "error", code: "FAILED", message: `tool output exceeds ${this.o.maxOutputBytes} bytes` }, def);
      }
      return this.finish(req, "ok", { status: "ok", output: out, taints: def.outputUntrusted === true }, def);
    } catch (e) {
      return this.finish(req, "error", { status: "error", code: "FAILED", message: (e instanceof Error ? e.message : "tool failed").slice(0, 500) }, def);
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onCallerAbort);
    }
  }

  private audit(req: CallRequest, def: ToolDef<any> | undefined, type: string, extra: Record<string, unknown>): void { // eslint-disable-line @typescript-eslint/no-explicit-any
    this.o.events.append([
      {
        type,
        ...(req.session === undefined ? {} : { session: req.session }),
        data: { tool: req.tool, risk: def?.risk, principal: req.principal, principalId: req.principalId, ...extra },
      },
    ]);
  }

  private finish(req: CallRequest, kind: "ok" | "denied" | "error", result: CallResult, def?: ToolDef<any>): CallResult { // eslint-disable-line @typescript-eslint/no-explicit-any
    const detail =
      result.status === "denied" ? { reason: result.reason } : result.status === "error" ? { code: result.code, message: result.message } : { taints: result.status === "ok" ? result.taints : false };
    this.audit(req, def, kind === "ok" ? "tool.completed" : kind === "denied" ? "tool.denied" : "tool.failed", detail);
    return result;
  }
}
