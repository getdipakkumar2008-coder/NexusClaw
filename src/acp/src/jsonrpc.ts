import type { Readable, Writable } from "node:stream";

/** JSON-RPC 2.0 error codes used here. */
export const RPC = { PARSE: -32700, INVALID: -32600, NO_METHOD: -32601, INTERNAL: -32603 } as const;

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export interface PeerOptions {
  input: Readable;
  output: Writable;
  /** A single message longer than this is a protocol violation and closes the connection. */
  maxLineBytes?: number;
  /** Handles a request from the other side. Throw RpcError to answer with a specific error. */
  onRequest(method: string, params: unknown): Promise<unknown>;
  onNotification(method: string, params: unknown): void;
  /** Called once when the stream ends or the peer is closed. */
  onClose(reason: Error | undefined): void;
}

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  cleanup(): void;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Newline-delimited JSON-RPC 2.0 over a pair of streams (the framing ACP uses on stdio).
 * The other side is untrusted: oversized lines, malformed messages and unknown methods never throw
 * out of here; they close the connection or produce an error response.
 */
export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<number | string, Pending>();
  private buf: Buffer[] = [];
  private bufLen = 0;
  private closed = false;
  /** Lines that were not JSON. Some programs print banners to stdout; we tolerate a few. */
  noise = 0;
  private readonly maxLine: number;

  constructor(private readonly o: PeerOptions) {
    this.maxLine = o.maxLineBytes ?? 4 * 1024 * 1024;
    o.input.on("data", (c: Buffer) => this.onData(c));
    o.input.on("end", () => this.close(undefined));
    o.input.on("error", (e) => this.close(e));
    o.output.on("error", (e) => this.close(e));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    let start = 0;
    for (let i = chunk.indexOf(10, start); i !== -1; i = chunk.indexOf(10, start)) {
      this.push(chunk.subarray(start, i));
      const line = Buffer.concat(this.buf, this.bufLen);
      this.buf = [];
      this.bufLen = 0;
      start = i + 1;
      this.handleLine(line.toString("utf8"));
      if (this.closed) return;
    }
    if (start < chunk.length) this.push(chunk.subarray(start));
  }

  private push(part: Buffer): void {
    this.buf.push(part);
    this.bufLen += part.length;
    if (this.bufLen > this.maxLine) this.close(new Error(`message longer than ${this.maxLine} bytes`));
  }

  private handleLine(line: string): void {
    const text = line.trim();
    if (text === "") return;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      if (++this.noise > 100) this.close(new Error("too many non-JSON lines on the protocol stream"));
      return;
    }
    if (!isObj(msg) || msg["jsonrpc"] !== "2.0") {
      if (++this.noise > 100) this.close(new Error("too many invalid messages"));
      return;
    }
    const { id, method } = msg;
    const hasId = typeof id === "number" || typeof id === "string";
    if (typeof method === "string") {
      if (hasId) void this.serve(id, method, msg["params"]);
      else {
        try {
          this.o.onNotification(method, msg["params"]);
        } catch {
          /* a faulty handler must not take the connection down */
        }
      }
      return;
    }
    if (hasId && ("result" in msg || "error" in msg)) {
      const p = this.pending.get(id);
      if (!p) return; // unsolicited or late response
      this.pending.delete(id);
      p.cleanup();
      if (isObj(msg["error"])) {
        const e = msg["error"];
        p.reject(new RpcError(typeof e["code"] === "number" ? e["code"] : RPC.INTERNAL, typeof e["message"] === "string" ? e["message"] : "error", e["data"]));
      } else p.resolve(msg["result"]);
    }
  }

  private async serve(id: number | string, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.o.onRequest(method, params);
      this.send({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (e) {
      if (e instanceof RpcError) this.send({ jsonrpc: "2.0", id, error: { code: e.code, message: e.message } });
      else this.send({ jsonrpc: "2.0", id, error: { code: RPC.INTERNAL, message: "internal error" } });
    }
  }

  private send(msg: unknown): void {
    if (this.closed) return;
    try {
      this.o.output.write(`${JSON.stringify(msg)}\n`);
    } catch (e) {
      this.close(e instanceof Error ? e : new Error(String(e)));
    }
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  request(method: string, params: unknown, opts: RequestOptions = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("connection closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const onAbort = (): void => {
        this.pending.delete(id);
        cleanup();
        reject(new Error("aborted"));
      };
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
      };
      if (opts.signal?.aborted) return reject(new Error("aborted"));
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          cleanup();
          reject(new Error(`${method} timed out after ${opts.timeoutMs} ms`));
        }, opts.timeoutMs);
        timer.unref();
      }
      this.pending.set(id, { resolve, reject, cleanup });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  close(reason: Error | undefined): void {
    if (this.closed) return;
    this.closed = true;
    const err = reason ?? new Error("connection closed");
    for (const p of this.pending.values()) {
      p.cleanup();
      p.reject(err);
    }
    this.pending.clear();
    this.o.onClose(reason);
  }
}
