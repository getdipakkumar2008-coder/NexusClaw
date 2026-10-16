import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { BRAND } from "@clawnexus/brand";
import {
  PROTOCOL_VERSION,
  helloParamsSchema,
  isCompatible,
  parseFrame,
  type ErrorBody,
} from "@clawnexus/protocol";
import { isLoopback, type Config } from "@clawnexus/config";
import { EventLog, CursorExpiredError, openDb, type Db, type StoredEvent } from "@clawnexus/store";
import { PairingError, PairingService } from "@clawnexus/pairing";
import { ApprovalError, ApprovalStore } from "@clawnexus/policy";

export interface GatewayOptions {
  /** Directory holding the database and token file. Created (mode 0700) if missing. */
  dataDir: string;
  /** Defaults to the config's gateway.bind / gateway.port, else 127.0.0.1:7391. Port 0 picks a free port. */
  host?: string;
  port?: number;
  config?: Pick<Config, "gateway">;
  /** Browser origins allowed to open a WebSocket. Default: none (non-browser clients only). */
  allowedOrigins?: readonly string[];
  /** Unauthenticated connections are dropped after this long without a successful hello. */
  helloTimeoutMs?: number;
  /** A connection whose outbound queue exceeds this is dropped (SLOW_CONSUMER). */
  maxBufferedBytes?: number;
  /** Per-connection request rate limit (token bucket). */
  requestsPerSecond?: number;
  now?: () => number;
  /** Failed-auth lockout: this many failures within the window blocks the remote address for the window. */
  maxAuthFailures?: number;
  authFailureWindowMs?: number;
}

const VERSION = "0.0.0";
const TOKEN_FILE = "gateway.token";
const DB_FILE = "gateway.db";

const err = (code: string, message: string, remediation: string, retryable = false): ErrorBody => ({
  code,
  message,
  remediation,
  retryable,
});

class MethodError extends Error {
  constructor(readonly body: ErrorBody) {
    super(body.message);
  }
}

interface Conn {
  ws: WebSocket;
  remote: string;
  authed: boolean;
  unsubscribe?: () => void;
  /** Runs right after the current request's response is sent (used to start event replay after the ack). */
  postReply?: () => void;
  tokens: number;
  lastRefill: number;
  helloTimer?: NodeJS.Timeout;
}

const sha = (s: string): Buffer => createHash("sha256").update(s).digest();

/**
 * Gateway control plane (docs/02, docs/03). Slice 1: HTTP health, WebSocket protocol with token auth,
 * durable event streaming with resume, pairing and approval methods. Listens on loopback only until TLS
 * support lands (SEC-6).
 */
export class Gateway {
  readonly events: EventLog;
  readonly pairing: PairingService;
  readonly approvals: ApprovalStore;
  readonly tokenPath: string;

  private readonly db: Db;
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly conns = new Set<Conn>();
  private readonly token: string;
  private readonly startedAt: number;
  private readonly authFailures = new Map<string, number[]>();
  private ready = false;
  private stopped = false;
  private boundPort = 0;
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly o: Required<Pick<GatewayOptions, "helloTimeoutMs" | "maxBufferedBytes" | "requestsPerSecond" | "maxAuthFailures" | "authFailureWindowMs">> & {
    allowedOrigins: readonly string[];
    now: () => number;
  };

  constructor(opts: GatewayOptions) {
    this.host = opts.host ?? opts.config?.gateway.bind ?? "127.0.0.1";
    this.requestedPort = opts.port ?? opts.config?.gateway.port ?? 7391;
    if (!isLoopback(this.host)) {
      throw new Error(
        `refusing to listen on ${this.host}: only loopback is supported until TLS is implemented (SEC-6). Use a VPN or reverse proxy that terminates TLS in front of a loopback bind.`,
      );
    }
    this.o = {
      allowedOrigins: opts.allowedOrigins ?? [],
      helloTimeoutMs: opts.helloTimeoutMs ?? 5_000,
      maxBufferedBytes: opts.maxBufferedBytes ?? 5 * 1024 * 1024,
      requestsPerSecond: opts.requestsPerSecond ?? 50,
      maxAuthFailures: opts.maxAuthFailures ?? 5,
      authFailureWindowMs: opts.authFailureWindowMs ?? 60_000,
      now: opts.now ?? Date.now,
    };
    this.startedAt = this.o.now();

    mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
    this.tokenPath = join(opts.dataDir, TOKEN_FILE);
    this.token = loadOrCreateToken(this.tokenPath);
    this.db = openDb(join(opts.dataDir, DB_FILE));
    this.events = new EventLog(this.db, this.o.now);
    this.pairing = new PairingService(this.db, { now: this.o.now, audit: this.events });
    this.approvals = new ApprovalStore(this.o.now);

    this.http = createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    this.http.on("upgrade", (req, socket) => this.handleUpgrade(req, socket as Duplex));
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req));
  }

  async start(): Promise<{ host: string; port: number }> {
    await new Promise<void>((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.requestedPort, this.host, () => {
        this.http.off("error", reject);
        resolve();
      });
    });
    const addr = this.http.address();
    this.boundPort = typeof addr === "object" && addr ? addr.port : this.requestedPort;
    this.ready = true;
    this.events.append([{ type: "gateway.started", data: { version: VERSION } }]);
    return { host: this.host, port: this.boundPort };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.ready = false;
    try {
      this.events.append([{ type: "gateway.shutting_down" }]);
    } catch {
      /* database may already be closed */
    }
    for (const c of this.conns) {
      c.ws.close(1001, "gateway shutting down");
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    this.http.closeAllConnections();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
    this.db.close();
  }

  get port(): number {
    return this.boundPort;
  }

  // ---------------- HTTP ----------------

  private handleHttp(req: IncomingMessage, res: import("node:http").ServerResponse): void {
    const headers = { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" };
    if (!this.hostAllowed(req)) {
      res.writeHead(403, headers).end(JSON.stringify({ ok: false }));
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, headers).end(JSON.stringify({ ok: false }));
      return;
    }
    if (req.url === "/healthz") res.writeHead(200, headers).end(JSON.stringify({ ok: true }));
    else if (req.url === "/readyz") res.writeHead(this.ready ? 200 : 503, headers).end(JSON.stringify({ ok: this.ready }));
    else res.writeHead(404, headers).end(JSON.stringify({ ok: false }));
  }

  /** DNS-rebinding defence: the Host header must name a loopback address on our port. */
  private hostAllowed(req: IncomingMessage): boolean {
    const host = req.headers.host;
    if (!host) return false;
    const allowed = new Set([`127.0.0.1:${this.boundPort}`, `localhost:${this.boundPort}`, `[::1]:${this.boundPort}`]);
    return allowed.has(host.toLowerCase());
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex): void {
    const reject = (status: string): void => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (!this.ready) return reject("503 Service Unavailable");
    if (!this.hostAllowed(req)) return reject("403 Forbidden");
    // Cross-site WebSocket hijacking defence: a browser always sends Origin; refuse unless allow-listed.
    const origin = req.headers.origin;
    if (origin !== undefined && !this.o.allowedOrigins.includes(origin)) return reject("403 Forbidden");
    if (req.url !== "/v1/ws") return reject("404 Not Found");
    this.wss.handleUpgrade(req, socket, Buffer.alloc(0), (ws) => this.wss.emit("connection", ws, req));
  }

  // ---------------- WebSocket ----------------

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const remote = req.socket.remoteAddress ?? "unknown";
    const c: Conn = {
      ws,
      remote,
      authed: false,
      tokens: this.o.requestsPerSecond * 2,
      lastRefill: this.o.now(),
    };
    this.conns.add(c);
    c.helloTimer = setTimeout(() => ws.close(4408, "hello timeout"), this.o.helloTimeoutMs);
    ws.on("message", (data, isBinary) => {
      if (isBinary) return ws.close(1003, "text frames only");
      void this.onMessage(c, data.toString("utf8"));
    });
    ws.on("close", () => {
      clearTimeout(c.helloTimer);
      c.unsubscribe?.();
      this.conns.delete(c);
    });
    ws.on("error", () => ws.terminate());
  }

  private send(c: Conn, frame: object): void {
    if (c.ws.readyState !== c.ws.OPEN) return;
    if (c.ws.bufferedAmount > this.o.maxBufferedBytes) {
      c.ws.close(4429, "SLOW_CONSUMER");
      return;
    }
    c.ws.send(JSON.stringify(frame));
  }

  private reply(c: Conn, id: string, result: unknown): void {
    this.send(c, { t: "res", id, ok: true, result: result ?? {} });
  }
  private fail(c: Conn, id: string, error: ErrorBody): void {
    this.send(c, { t: "res", id, ok: false, error });
  }

  private takeToken(c: Conn): boolean {
    const t = this.o.now();
    const cap = this.o.requestsPerSecond * 2;
    c.tokens = Math.min(cap, c.tokens + ((t - c.lastRefill) / 1000) * this.o.requestsPerSecond);
    c.lastRefill = t;
    if (c.tokens < 1) return false;
    c.tokens -= 1;
    return true;
  }

  private async onMessage(c: Conn, raw: string): Promise<void> {
    const parsed = parseFrame(raw);
    if (!parsed.ok || parsed.frame.t !== "req") {
      c.ws.close(1008, "BAD_FRAME");
      return;
    }
    const { id, method, params } = parsed.frame;
    if (!this.takeToken(c)) {
      this.fail(c, id, err("RATE_LIMIT", "too many requests", "Slow down and retry.", true));
      return;
    }
    try {
      if (method === "connection.hello") {
        this.reply(c, id, this.hello(c, params));
        return;
      }
      if (!c.authed) {
        this.fail(c, id, err("AUTH.REQUIRED", "send connection.hello with credentials first", "Authenticate before calling methods."));
        return;
      }
      const result = await this.dispatch(c, method, params);
      this.reply(c, id, result);
      const after = c.postReply;
      delete c.postReply;
      after?.();
    } catch (e) {
      if (e instanceof MethodError) this.fail(c, id, e.body);
      else if (e instanceof z.ZodError) {
        this.fail(c, id, err("UNSUPPORTED.BAD_PARAMS", "invalid parameters", e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")));
      } else {
        this.fail(c, id, err("INTERNAL", "internal error", "Check the Gateway log.", true));
        // No stack traces to clients; logging is wired in a later slice.
      }
    }
  }

  private hello(c: Conn, params: unknown): unknown {
    if (c.authed) throw new MethodError(err("UNSUPPORTED.ALREADY_AUTHENTICATED", "already authenticated", "Open a new connection to re-authenticate."));
    const p = helloParamsSchema.parse(params);
    if (this.isLockedOut(c.remote)) {
      throw new MethodError(err("AUTH.LOCKED", "too many failed attempts", "Wait a minute and retry.", true));
    }
    if (!isCompatible(p.protocol.major)) {
      throw new MethodError(err("UNSUPPORTED.PROTOCOL", `protocol ${p.protocol.major}.x is not supported`, `This Gateway speaks ${PROTOCOL_VERSION.major}.${PROTOCOL_VERSION.minor}.`));
    }
    const supplied = p.auth?.token;
    if (supplied === undefined || !timingSafeEqual(sha(supplied), sha(this.token))) {
      this.recordAuthFailure(c.remote);
      throw new MethodError(err("AUTH.BAD_TOKEN", "invalid or missing token", `Use the token from ${TOKEN_FILE} in the Gateway data directory.`));
    }
    c.authed = true;
    clearTimeout(c.helloTimer);
    return { protocol: PROTOCOL_VERSION, server: `${BRAND.name} ${VERSION}`, role: "owner", latestSeq: this.events.latestSeq() };
  }

  private isLockedOut(remote: string): boolean {
    const now = this.o.now();
    const recent = (this.authFailures.get(remote) ?? []).filter((t) => now - t < this.o.authFailureWindowMs);
    this.authFailures.set(remote, recent);
    return recent.length >= this.o.maxAuthFailures;
  }
  private recordAuthFailure(remote: string): void {
    const list = this.authFailures.get(remote) ?? [];
    list.push(this.o.now());
    this.authFailures.set(remote, list);
  }

  // ---------------- methods (all require the owner role in this slice) ----------------

  private async dispatch(c: Conn, method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "status":
        return {
          server: `${BRAND.name} ${VERSION}`,
          protocol: PROTOCOL_VERSION,
          latestSeq: this.events.latestSeq(),
          connections: this.conns.size,
          uptimeMs: this.o.now() - this.startedAt,
          senders: { paired: this.pairing.list("paired").length, pending: this.pairing.list("pending").length },
        };

      case "events.subscribe": {
        const p = z.strictObject({ since: z.number().int().nonnegative().optional(), session: z.string().min(1).optional() }).parse(params ?? {});
        return this.subscribe(c, p.since, p.session);
      }
      case "events.unsubscribe":
        c.unsubscribe?.();
        delete c.unsubscribe;
        return {};

      case "pairing.list": {
        const p = z.strictObject({ status: z.enum(["pending", "paired", "blocked"]).optional() }).parse(params ?? {});
        return { senders: this.pairing.list(p.status) };
      }
      case "pairing.approve":
      case "pairing.deny": {
        const p = z.strictObject({ code: z.string().min(1).max(32) }).parse(params);
        try {
          const sender = method === "pairing.approve" ? this.pairing.approve(p.code) : this.pairing.deny(p.code);
          return { sender };
        } catch (e) {
          if (e instanceof PairingError) {
            throw new MethodError(err(`POLICY.PAIRING_${e.code}`, e.message, "Check the code and that it has not expired."));
          }
          throw e;
        }
      }

      case "approval.list":
        return { approvals: this.approvals.list() };
      case "approval.decide": {
        const p = z.strictObject({ id: z.string().min(1), approve: z.boolean() }).parse(params);
        try {
          const a = this.approvals.decide(p.id, p.approve, { kind: "owner", id: "owner" });
          this.events.append([{ type: "approval.decided", data: { id: a.id, state: a.state, tool: a.tool } }]);
          return { approval: a };
        } catch (e) {
          if (e instanceof ApprovalError) throw new MethodError(err("POLICY.APPROVAL", e.message, "List pending approvals and retry."));
          throw e;
        }
      }

      default:
        throw new MethodError(err("UNSUPPORTED.METHOD", `unknown method ${method}`, "See docs/03-gateway-protocol.md for the method list."));
    }
  }

  /**
   * Resume semantics (docs/03 section 6): replay everything after `since` in order, then stream live events.
   * The store is synchronous and single-process, so no event can slip between reading the backlog and
   * attaching the live listener; events appended before the replay is flushed are buffered to keep order.
   */
  private subscribe(c: Conn, since: number | undefined, session: string | undefined): unknown {
    c.unsubscribe?.();
    const deliver = (evs: StoredEvent[]): void => {
      for (const e of evs) {
        if (session !== undefined && e.session !== session) continue;
        const frame: Record<string, unknown> = { t: "evt", seq: e.seq, type: e.type };
        if (e.session !== undefined) frame["session"] = e.session;
        if (e.data !== undefined) frame["data"] = e.data;
        this.send(c, frame);
      }
    };
    const latest = this.events.latestSeq();
    let cursor = since ?? latest;
    const backlog: StoredEvent[] = [];
    try {
      for (;;) {
        const page = this.events.readSince(cursor, session === undefined ? { limit: 1000 } : { limit: 1000, session });
        if (page.length === 0) break;
        backlog.push(...page);
        cursor = page[page.length - 1]!.seq;
        if (backlog.length > 100_000) {
          throw new MethodError(err("SYNC.TOO_LARGE", "backlog too large to replay", "Subscribe with a recent cursor or re-sync via session.export.", false));
        }
      }
    } catch (e) {
      if (e instanceof CursorExpiredError) {
        throw new MethodError(err("SYNC.CURSOR_EXPIRED", e.message, "Re-sync from a fresh snapshot and subscribe from latestSeq."));
      }
      throw e;
    }
    // Live events that arrive before the replay is flushed are buffered, then sent after it, preserving order.
    let live = false;
    const buffered: StoredEvent[] = [];
    c.unsubscribe = this.events.subscribe((evs) => (live ? deliver(evs) : buffered.push(...evs)));
    c.postReply = () => {
      deliver(backlog);
      live = true;
      deliver(buffered.splice(0));
    };
    return { from: since ?? latest, latestSeq: latest, replaying: backlog.length };
  }
}

function loadOrCreateToken(path: string): string {
  if (existsSync(path)) {
    const t = readFileSync(path, "utf8").trim();
    if (t.length >= 32) return t;
  }
  const token = randomBytes(32).toString("base64url");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort on filesystems without POSIX modes */
  }
  return token;
}

export async function startGateway(opts: GatewayOptions): Promise<{ gateway: Gateway; host: string; port: number }> {
  const gateway = new Gateway(opts);
  const { host, port } = await gateway.start();
  return { gateway, host, port };
}
