import { spawn, type ChildProcess } from "node:child_process";
import { childEnv, killTree } from "@clawnexus/tools";
import { planLaunch, type HarnessSpec } from "./harnesses.js";
import { JsonRpcPeer, RPC, RpcError } from "./jsonrpc.js";

export const ACP_PROTOCOL_VERSION = 1;

export class AcpError extends Error {
  constructor(
    readonly code: "HARNESS_START" | "HARNESS_PROTOCOL" | "HARNESS_AUTH" | "HARNESS_EXITED" | "HARNESS_REFUSED" | "HARNESS_LIMIT",
    message: string,
    readonly remediation: string,
  ) {
    // The run record keeps only `message`, so the fix travels with it.
    super(`${message}. Fix: ${remediation}`);
    this.name = "AcpError";
  }
}

/** A stdio MCP server the harness is asked to start (ACP `session/new` field `mcpServers`). */
export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export type PermissionAnswer = "allow_once" | "reject";

export interface PermissionInfo {
  sessionId: string;
  toolCallId?: string;
  title?: string;
  kind?: string;
  /** The MCP server the call targets, when the harness says so (it names it in the request's metadata). */
  mcpServer?: string;
}

/** Which MCP server a permission request is about. Vendor metadata first, then the common `mcp__server__tool` name. */
export function mcpServerOf(toolCall: Record<string, unknown>): string | undefined {
  const meta = isObj(toolCall["_meta"]) ? toolCall["_meta"] : {};
  const claude = isObj(meta["claudeCode"]) ? meta["claudeCode"] : {};
  const viaMeta = isObj(claude["mcpServer"]) ? str(claude["mcpServer"]["name"]) : undefined;
  if (viaMeta) return viaMeta;
  const named = str(claude["toolName"]) ?? str(toolCall["name"]);
  return named?.match(/^mcp__(.+?)__[^_]/)?.[1];
}

export interface AcpConnectionOptions {
  spec: HarnessSpec;
  /** Working directory for the harness; it is the only directory we tell it about. */
  cwd: string;
  /** Gateway-side policy hook. Without one, every permission request from the harness is rejected. */
  onPermission?: (p: PermissionInfo) => PermissionAnswer;
  /** Called with every request the harness made that we declined (for the audit log). */
  onDeclined?: (what: string) => void;
  initTimeoutMs?: number;
  sessionTimeoutMs?: number;
  /** Environment to read pass-through variables from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  clientVersion?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Keep error text short and free of anything that looks like a token. */
export function scrub(text: string, max = 400): string {
  const t = text.replace(/[\w-]{24,}/g, "[redacted]").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

type UpdateListener = (update: Record<string, unknown>) => void;

/**
 * A live connection to one ACP harness process. We are the *client*: we grant the harness no file-system or
 * terminal access of ours (we advertise no such capabilities) and answer permission requests through policy.
 * Whatever the harness does with its own built-in tools is governed by what it asks permission for; see docs/15.
 */
export class AcpConnection {
  private readonly listeners = new Map<string, UpdateListener>();
  private stderrTail = "";
  private exited: { code: number | null; signal: string | null } | undefined;
  private closedError: Error | undefined;
  private readonly exitSeen: Promise<void>;
  readonly peer: JsonRpcPeer;
  agentName = "unknown";
  /** What the harness can be sent besides text. Nothing until it says so. */
  promptCaps: { image: boolean; audio: boolean; embeddedContext: boolean } = { image: false, audio: false, embeddedContext: false };
  authMethods: Array<{ id: string; name: string }> = [];

  private constructor(
    private readonly child: ChildProcess,
    private readonly o: AcpConnectionOptions,
  ) {
    child.stderr?.on("data", (c: Buffer) => {
      this.stderrTail = (this.stderrTail + c.toString("utf8")).slice(-4096);
    });
    this.exitSeen = new Promise<void>((resolve) => {
      child.on("exit", (code, signal) => {
        this.exited = { code, signal };
        resolve();
      });
    });
    this.peer = new JsonRpcPeer({
      input: child.stdout!,
      output: child.stdin!,
      onRequest: (m, p) => this.onRequest(m, p),
      onNotification: (m, p) => this.onNotification(m, p),
      onClose: (reason) => {
        this.closedError = reason ?? new Error("the harness closed the connection");
        this.listeners.clear();
        this.kill();
      },
    });
    child.on("close", () => this.peer.close(new Error("the harness process ended")));
  }

  get alive(): boolean {
    return !this.peer.isClosed && this.exited === undefined;
  }

  /** What the harness said on stderr just before it ended, for the operator. Scrubbed and short. */
  diagnostics(): string {
    return scrub(this.stderrTail);
  }

  static async start(o: AcpConnectionOptions): Promise<AcpConnection> {
    const plan = planLaunch(o.spec, o.env ?? process.env);
    const pass: Record<string, string> = {};
    for (const name of o.spec.env) {
      const v = (o.env ?? process.env)[name];
      if (v !== undefined) pass[name] = v;
    }
    let child: ChildProcess;
    try {
      child = spawn(plan.file, plan.args, {
        cwd: o.cwd,
        env: childEnv(pass),
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      throw new AcpError("HARNESS_START", `could not start ${o.spec.command}: ${(e as Error).message}`, "Check provider.command and that the program is executable.");
    }
    const started = new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (e) => reject(new AcpError("HARNESS_START", `could not start ${o.spec.command}: ${e.message}`, "Check provider.command and that the program is executable.")));
    });
    await started;
    const conn = new AcpConnection(child, o);
    try {
      await conn.initialize();
    } catch (e) {
      conn.kill();
      throw e;
    }
    return conn;
  }

  private async initialize(): Promise<void> {
    let r: unknown;
    try {
      r = await this.peer.request(
        "initialize",
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          // No fs, no terminal: the harness gets nothing of ours.
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "clawnexus", title: "ClawNexus", version: this.o.clientVersion ?? "0.0.0" },
        },
        { timeoutMs: this.o.initTimeoutMs ?? 120_000 },
      );
    } catch (e) {
      throw await this.explain(e, "initialize");
    }
    if (!isObj(r) || r["protocolVersion"] !== ACP_PROTOCOL_VERSION) {
      throw new AcpError(
        "HARNESS_PROTOCOL",
        `the harness speaks ACP version ${isObj(r) ? String(r["protocolVersion"]) : "unknown"}, this build supports ${ACP_PROTOCOL_VERSION}`,
        "Use a harness/adapter version that supports ACP v1, or upgrade ClawNexus.",
      );
    }
    if (isObj(r["agentInfo"])) this.agentName = str(r["agentInfo"]["name"]) ?? this.agentName;
    const caps = isObj(r["agentCapabilities"]) && isObj(r["agentCapabilities"]["promptCapabilities"]) ? r["agentCapabilities"]["promptCapabilities"] : {};
    this.promptCaps = { image: caps["image"] === true, audio: caps["audio"] === true, embeddedContext: caps["embeddedContext"] === true };
    if (Array.isArray(r["authMethods"])) {
      this.authMethods = r["authMethods"].filter(isObj).flatMap((m) => (str(m["id"]) ? [{ id: str(m["id"])!, name: str(m["name"]) ?? str(m["id"])! }] : []));
    }
    const want = this.o.spec.authMethodId;
    if (want !== undefined && this.authMethods.some((m) => m.id === want)) {
      try {
        await this.peer.request("authenticate", { methodId: want }, { timeoutMs: this.o.sessionTimeoutMs ?? 60_000 });
      } catch (e) {
        throw await this.explain(e, "authenticate");
      }
    }
  }

  async newSession(mcpServers: McpServerSpec[] = []): Promise<string> {
    let r: unknown;
    try {
      r = await this.peer.request("session/new", { cwd: this.o.cwd, mcpServers }, { timeoutMs: this.o.sessionTimeoutMs ?? 60_000 });
    } catch (e) {
      throw await this.explain(e, "session/new");
    }
    const id = isObj(r) ? str(r["sessionId"]) : undefined;
    if (!id) throw new AcpError("HARNESS_PROTOCOL", "the harness did not return a session id", "Report this with the harness name and version.");
    return id;
  }

  /**
   * Send one prompt and stream the reply text. Resolves with the stop reason.
   * On abort we ask the harness to cancel and, if it does not stop within `graceMs`, we end the process.
   */
  async prompt(sessionId: string, input: string | Array<Record<string, unknown>>, o: { onText(t: string): void; signal?: AbortSignal; graceMs?: number }): Promise<string> {
    this.listeners.set(sessionId, (u) => {
      if (u["sessionUpdate"] === "agent_message_chunk" && isObj(u["content"]) && u["content"]["type"] === "text") {
        const t = str(u["content"]["text"]);
        if (t) o.onText(t);
      }
      // Thoughts, plans, tool-call progress and usage are deliberately not forwarded in this slice.
    });
    let grace: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      this.peer.notify("session/cancel", { sessionId });
      grace = setTimeout(() => this.kill(), o.graceMs ?? 3000);
      grace.unref();
    };
    if (o.signal?.aborted) onAbort();
    else o.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const r = await this.peer.request("session/prompt", { sessionId, prompt: typeof input === "string" ? [{ type: "text", text: input }] : input });
      const reason = isObj(r) ? str(r["stopReason"]) : undefined;
      if (!reason) throw new AcpError("HARNESS_PROTOCOL", "the harness ended a turn without a stop reason", "Report this with the harness name and version.");
      return reason;
    } catch (e) {
      throw await this.explain(e, "session/prompt");
    } finally {
      if (grace) clearTimeout(grace);
      o.signal?.removeEventListener("abort", onAbort);
      this.listeners.delete(sessionId);
    }
  }

  private async explain(e: unknown, step: string): Promise<Error> {
    if (e instanceof AcpError) return e;
    // The pipe can close a moment before the exit code is reported; give it a short chance so errors can name it.
    if (!(e instanceof RpcError) && this.exited === undefined) await Promise.race([this.exitSeen, new Promise((r) => setTimeout(r, 300).unref())]);
    const detail = this.diagnostics();
    if (e instanceof RpcError) {
      const authish = /auth|login|sign.?in|credential|api key|unauthor/i.test(e.message);
      if (authish || e.code === -32000) {
        return new AcpError("HARNESS_AUTH", `the harness is not signed in (${step}: ${scrub(e.message)})`, this.o.spec.loginHint);
      }
      return new AcpError("HARNESS_PROTOCOL", `${step} failed: ${scrub(e.message)} (code ${e.code})`, "Report this with the harness name and version.");
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (!this.alive) {
      return new AcpError(
        "HARNESS_EXITED",
        `the harness stopped during ${step}${this.exited?.code != null ? ` (exit ${this.exited.code})` : ""}${detail ? `: ${detail}` : ""}`,
        `Run the harness by hand to see why. ${this.o.spec.loginHint}`,
      );
    }
    return new AcpError("HARNESS_PROTOCOL", `${step}: ${scrub(msg)}`, "Check the harness version, or try again.");
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== "session/update" || !isObj(params)) return;
    const sid = str(params["sessionId"]);
    const update = params["update"];
    if (sid && isObj(update)) this.listeners.get(sid)?.(update);
  }

  private async onRequest(method: string, params: unknown): Promise<unknown> {
    if (method === "session/request_permission" && isObj(params)) {
      const options = Array.isArray(params["options"]) ? params["options"].filter(isObj) : [];
      const toolCall = isObj(params["toolCall"]) ? params["toolCall"] : {};
      const sessionId = str(params["sessionId"]) ?? "";
      const info: PermissionInfo = { sessionId };
      const tcid = str(toolCall["toolCallId"]);
      if (tcid) info.toolCallId = tcid;
      const title = str(toolCall["title"]);
      if (title) info.title = scrub(title, 120);
      const kind = str(toolCall["kind"]);
      if (kind) info.kind = kind;
      const server = mcpServerOf(toolCall);
      if (server) info.mcpServer = server;
      const answer: PermissionAnswer = this.o.onPermission ? this.o.onPermission(info) : "reject";
      const pick = (kinds: string[]): string | undefined => {
        for (const k of kinds) {
          const opt = options.find((x) => x["kind"] === k);
          if (opt && str(opt["optionId"])) return str(opt["optionId"]);
        }
        return undefined;
      };
      // Never choose an "always" option on the user's behalf: grants must stay one call at a time.
      const chosen = answer === "allow_once" ? pick(["allow_once"]) : pick(["reject_once", "reject_always"]);
      if (answer === "reject" || chosen === undefined) this.o.onDeclined?.(`permission request${info.title ? `: ${info.title}` : ""}${info.mcpServer ? ` (mcp server ${info.mcpServer})` : ""}`);
      return chosen === undefined ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId: chosen } };
    }
    this.o.onDeclined?.(`unsupported request ${method.slice(0, 60)}`);
    throw new RpcError(RPC.NO_METHOD, "method not supported by this client");
  }

  kill(): void {
    if (this.child.pid !== undefined && this.exited === undefined) killTree(this.child.pid);
  }

  close(): void {
    this.peer.close(undefined);
    this.kill();
  }

  /** Close and wait (briefly) until the process is really gone, so its working directory is released. */
  async closeAndWait(timeoutMs = 3000): Promise<void> {
    this.close();
    if (this.exited === undefined) await Promise.race([this.exitSeen, new Promise((r) => setTimeout(r, timeoutMs).unref())]);
  }

  get error(): Error | undefined {
    return this.closedError;
  }
}
