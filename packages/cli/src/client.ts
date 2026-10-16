import WebSocket from "ws";
import { PROTOCOL_VERSION, parseFrame, type ErrorBody, type EvtFrame } from "@clawnexus/protocol";

/** An error the user can act on: what failed, why, and what to do. Never carries a stack trace to the terminal. */
export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly remediation: string,
  ) {
    super(message);
  }
}

export function fromBody(e: ErrorBody): CliError {
  return new CliError(e.code, e.message, e.remediation);
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class GatewayClient {
  private n = 0;
  private readonly pending = new Map<string, Pending>();
  private listeners = new Set<(e: EvtFrame) => void>();
  private closeError: CliError | undefined;
  private closeListeners: Array<() => void> = [];

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (data) => {
      const parsed = parseFrame(data.toString());
      if (!parsed.ok) return;
      const f = parsed.frame;
      if (f.t === "evt") {
        for (const l of [...this.listeners]) l(f);
      } else if (f.t === "res") {
        const p = this.pending.get(f.id);
        if (!p) return;
        this.pending.delete(f.id);
        clearTimeout(p.timer);
        if (f.ok) p.resolve(f.result);
        else p.reject(fromBody(f.error));
      }
    });
    ws.on("close", (code, reason) => {
      this.closeError = new CliError("CONNECTION_CLOSED", `Gateway closed the connection (${code}${reason.length ? `: ${reason.toString()}` : ""})`, "Check the Gateway is still running with `clawnexus status`.");
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(this.closeError);
        this.pending.delete(id);
      }
      for (const l of this.closeListeners) l();
    });
    ws.on("error", () => undefined);
  }

  static async connect(url: string, token: string, timeoutMs = 5_000): Promise<GatewayClient> {
    const ws = new WebSocket(url, { handshakeTimeout: timeoutMs });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (e: NodeJS.ErrnoException) =>
        reject(
          new CliError(
            "UNREACHABLE",
            e.code === "ECONNREFUSED" ? `no Gateway is listening at ${url}` : `cannot connect to ${url}: ${e.message}`,
            "Start it with `clawnexus gateway run`, or pass --url / --port if it listens elsewhere.",
          ),
        ),
      );
      ws.once("unexpected-response", (_req, res) =>
        reject(new CliError("UNREACHABLE", `${url} answered HTTP ${res.statusCode}, not a Gateway WebSocket`, "Check --url and --port.")),
      );
    });
    const c = new GatewayClient(ws);
    await c.call("connection.hello", {
      protocol: PROTOCOL_VERSION,
      client: { kind: "cli", version: "0.0.0" },
      auth: { token },
    });
    return c;
  }

  call<T = unknown>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.closeError) return Promise.reject(this.closeError);
    const id = `cli-${++this.n}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CliError("TIMEOUT", `no answer to ${method} within ${timeoutMs / 1000}s`, "Check the Gateway with `clawnexus doctor`."));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.ws.send(JSON.stringify({ t: "req", id, method, params }));
    });
  }

  /** Runs once if the connection ends (the Gateway stopped, or revoked this credential). */
  onClose(fn: () => void): void {
    if (this.closeError) fn();
    else this.closeListeners.push(fn);
  }

  onEvent(fn: (e: EvtFrame) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close(): void {
    this.ws.close();
  }
}
