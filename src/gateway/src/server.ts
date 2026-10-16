import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { isAbsolute, join } from "node:path";
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
import { BUILTIN_TOOLS, ToolExecutor, WorkspaceGuard } from "@clawnexus/tools";
import { BridgeRegistry, type BridgeGrant, type MintOptions } from "./bridge.js";
import { ChannelManager, WEBCHAT_ID, WebChatAdapter } from "@clawnexus/channels";
import { PluginError, PluginHost, type HostOptions } from "@clawnexus/plugins";
import { SessionError, SessionManager, type Provider, type SessionManagerOptions } from "@clawnexus/sessions";

export interface GatewayOptions {
  /** Directory holding the database and token file. Created (mode 0700) if missing. */
  dataDir: string;
  /** Defaults to the config's gateway.bind / gateway.port, else 127.0.0.1:7391. Port 0 picks a free port. */
  host?: string;
  port?: number;
  /** Tuning for the plugin host (mainly for tests). */
  plugins?: Partial<Pick<HostOptions, "childFile" | "restart" | "startTimeoutMs" | "graceMs" | "memoryMb" | "hostSdk">>;
  config?: Pick<Config, "gateway"> & Partial<Pick<Config, "security">>;
  /** Model runtime for session runs. Without one, `session.send` fails with PROVIDER.NOT_CONFIGURED. */
  provider?: Provider;
  /** Directory tools may read and write. Default: `<dataDir>/workspace` (created if missing). */
  workspace?: string;
  sessions?: SessionManagerOptions;
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
  /** Set when the connection authenticated with a tool-bridge credential instead of the owner token. */
  grant?: BridgeGrant;
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
  readonly sessions: SessionManager | undefined;
  readonly tools: ToolExecutor;
  readonly approvals: ApprovalStore;
  readonly bridgeGrants: BridgeRegistry;
  readonly plugins: PluginHost;
  readonly channels: ChannelManager;
  private readonly webchat: WebChatAdapter;
  private readonly profile: "standard" | "locked-down" | "trusted";
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
    this.profile = opts.config?.security?.profile ?? "standard";
    this.bridgeGrants = new BridgeRegistry(this.o.now, (g) => {
      for (const c of this.conns) if (c.grant === g) c.ws.close(4401, "credential revoked");
    });
    const workspace = opts.workspace ?? join(opts.dataDir, "workspace");
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    this.tools = new ToolExecutor({ events: this.events, approvals: this.approvals, guard: new WorkspaceGuard([workspace]), tools: BUILTIN_TOOLS });
    this.plugins = new PluginHost({ dataDir: opts.dataDir, db: this.db, events: this.events, tools: this.tools, now: this.o.now, ...opts.plugins });
    this.sessions = opts.provider ? new SessionManager(this.db, this.events, opts.provider, { now: this.o.now, ...opts.sessions }) : undefined;

    this.webchat = new WebChatAdapter({
      registerOwner: (externalId, display) => void this.pairing.registerOwner({ channel: WEBCHAT_ID, accountId: "default", externalId, display }),
      principalOf: (externalId) => this.pairing.principalOf({ channel: WEBCHAT_ID, accountId: "default", externalId }),
      now: this.o.now,
    });
    this.channels = new ChannelManager({ db: this.db, events: this.events, pairing: this.pairing, sessions: this.sessions, now: this.o.now });
    this.channels.register(this.webchat);

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
    // Enabled plugins start now. A plugin that cannot start is contained and reported; it never blocks the Gateway.
    await this.plugins.startEnabled().catch(() => undefined);
    await this.channels.start();
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
    this.bridgeGrants.revokeAll();
    await this.channels.stop();
    for (const c of this.conns) {
      c.ws.close(1001, "gateway shutting down");
    }
    await this.sessions?.close();
    await this.plugins.stop();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    this.http.closeAllConnections();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
    this.db.close();
  }

  get port(): number {
    return this.boundPort;
  }

  /** Where a tool bridge connects. */
  get url(): string {
    return `ws://${this.host.includes(":") ? `[${this.host}]` : this.host}:${this.boundPort}/v1/ws`;
  }

  /** Issue a credential for one session's tool bridge. Revoke it when that session's harness goes away. */
  mintBridge(o: MintOptions): { token: string; url: string; revoke(): void } {
    const m = this.bridgeGrants.mint(o);
    return { token: m.token, url: this.url, revoke: m.revoke };
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
    if (this.webchat.handleHttp(req, res)) return;
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
    // The browser chat has its own rules (same-origin only, identity by secret), checked by the adapter.
    if (req.url === "/v1/webchat") {
      if (!this.webchat.handleUpgrade(req, socket)) reject("404 Not Found");
      return;
    }
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
    const isOwner = supplied !== undefined && timingSafeEqual(sha(supplied), sha(this.token));
    const grant = !isOwner && supplied !== undefined ? this.bridgeGrants.lookup(supplied) : undefined;
    if (!isOwner && !grant) {
      this.recordAuthFailure(c.remote);
      throw new MethodError(err("AUTH.BAD_TOKEN", "invalid or missing token", `Use the token from ${TOKEN_FILE} in the Gateway data directory.`));
    }
    c.authed = true;
    if (grant) c.grant = grant;
    clearTimeout(c.helloTimer);
    return { protocol: PROTOCOL_VERSION, server: `${BRAND.name} ${VERSION}`, role: grant ? "agent" : "owner", latestSeq: this.events.latestSeq() };
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

  /**
   * What a model's tool bridge may do: list tools, call tools as ITS session's principal, and ask about its own
   * approvals. Nothing else (no sessions, pairing, events, other people's approvals) and no way to name a
   * different principal, session or trust level.
   */
  private async agentDispatch(c: Conn, g: BridgeGrant, method: string, params: unknown): Promise<unknown> {
    if (!this.bridgeGrants.live(g)) {
      c.ws.close(4401, "credential revoked");
      throw new MethodError(err("AUTH.REVOKED", "this tool bridge credential is no longer valid", "The session ended; start a new chat."));
    }
    switch (method) {
      case "tool.list":
        return { tools: this.tools.list() };
      case "tool.call": {
        const p = z
          .strictObject({
            tool: z.string().min(1).max(128),
            args: z.unknown().default({}),
            approvalId: z.string().min(1).max(64).optional(),
          })
          .parse(params);
        return this.tools.call({
          tool: p.tool,
          args: p.args,
          principal: this.effectivePrincipal(g),
          principalId: g.principalId,
          profile: this.profile,
          // The model has read things we cannot see (files, pages, earlier tool output) and may be steered by them.
          tainted: true,
          session: g.session,
          ...(g.elevation === undefined ? {} : { elevation: g.elevation }),
          ...(p.approvalId === undefined ? {} : { approvalId: p.approvalId }),
        });
      }
      case "approval.status": {
        const p = z.strictObject({ id: z.string().min(1).max(64) }).parse(params);
        const a = this.approvals.get(p.id);
        if (!a || a.requester !== g.principalId) throw new MethodError(err("POLICY.APPROVAL", "unknown approval", "Ask for the tool call again."));
        return { state: a.state };
      }
      default:
        throw new MethodError(err("AUTH.FORBIDDEN", `method ${method} is not available to a tool bridge`, "A tool bridge may only list and call tools."));
    }
  }

  /**
   * Who the model is acting for RIGHT NOW. The session row is the truth (a sender may have been demoted since the
   * bridge was opened); a bridge minted as guest can never rise above guest; a session that no longer exists is guest.
   */
  private effectivePrincipal(g: BridgeGrant): "owner" | "guest" {
    if (g.principal === "guest") return "guest";
    if (!this.sessions) return g.principal;
    try {
      return this.sessions.get(g.session).principal;
    } catch {
      return "guest";
    }
  }

  private async dispatch(c: Conn, method: string, params: unknown): Promise<unknown> {
    if (c.grant) return this.agentDispatch(c, c.grant, method, params);
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

      case "tool.list":
        return { tools: this.tools.list() };
      case "tool.call": {
        const p = z
          .strictObject({
            tool: z.string().min(1).max(128),
            args: z.unknown().default({}),
            approvalId: z.string().min(1).max(64).optional(),
            session: z.string().min(1).max(64).optional(),
            tainted: z.boolean().default(false),
          })
          .parse(params);
        // Only the owner reaches this method in this slice; guests and channels get their own principals in WP10.
        return this.tools.call({
          tool: p.tool,
          args: p.args,
          principal: "owner",
          principalId: "owner",
          profile: this.profile,
          tainted: p.tainted,
          ...(p.approvalId === undefined ? {} : { approvalId: p.approvalId }),
          ...(p.session === undefined ? {} : { session: p.session }),
        });
      }

      case "channel.list":
        return { channels: this.channels.list() };
      case "channel.webchat.link": {
        const host = this.host.includes(":") ? `[${this.host}]` : this.host;
        return this.webchat.createOwnerLink(`http://${host}:${this.boundPort}`);
      }
      case "pairing.owner": {
        const p = z.strictObject({ channel: z.string().min(1).max(64), accountId: z.string().min(1).max(64).default("default"), id: z.string().min(1).max(256), display: z.string().max(64).optional() }).parse(params);
        try {
          return { sender: this.pairing.registerOwner({ channel: p.channel, accountId: p.accountId, externalId: p.id, ...(p.display ? { display: p.display } : {}) }) };
        } catch (e) {
          if (e instanceof PairingError) throw new MethodError(err(`POLICY.PAIRING_${e.code}`, e.message, "Check the channel and id."));
          throw e;
        }
      }

      case "plugin.list":
        return { plugins: this.plugins.list() };
      case "plugin.info":
      case "plugin.install":
      case "plugin.enable":
      case "plugin.disable":
      case "plugin.remove":
        return this.pluginMethod(method, params);

      case "session.list":
      case "session.get":
      case "session.create":
      case "session.send":
      case "session.cancel":
      case "session.export":
      case "session.import":
      case "session.delete":
        return this.sessionMethod(method, params);

      default:
        throw new MethodError(err("UNSUPPORTED.METHOD", `unknown method ${method}`, "See docs/03-gateway-protocol.md for the method list."));
    }
  }

  private async pluginMethod(method: string, params: unknown): Promise<unknown> {
    const id = z.string().min(1).max(64);
    try {
      switch (method) {
        case "plugin.info": {
          const p = z.strictObject({ id }).parse(params);
          return { plugin: this.plugins.info(p.id) };
        }
        case "plugin.install": {
          const p = z.strictObject({ path: z.string().min(1).max(1024), replace: z.boolean().optional() }).parse(params);
          if (!isAbsolute(p.path)) throw new MethodError(err("UNSUPPORTED.BAD_PARAMS", "the plugin path must be absolute", "Pass the full path of the plugin folder."));
          return { plugin: await this.plugins.install(p.path, { replace: p.replace === true }) };
        }
        case "plugin.enable": {
          const p = z.strictObject({ id, approvalToken: z.string().min(1).max(128) }).parse(params);
          return { plugin: await this.plugins.enable(p.id, p.approvalToken) };
        }
        case "plugin.disable": {
          const p = z.strictObject({ id }).parse(params);
          return { plugin: await this.plugins.disable(p.id) };
        }
        default: {
          const p = z.strictObject({ id, purgeData: z.boolean().optional() }).parse(params);
          await this.plugins.remove(p.id, { purgeData: p.purgeData === true });
          return {};
        }
      }
    } catch (e) {
      if (e instanceof PluginError) throw new MethodError(err(`PLUGIN.${e.code}`, e.message, e.remediation));
      throw e;
    }
  }

  private sessionMethod(method: string, params: unknown): unknown {
    const mgr = this.sessions;
    if (!mgr) throw new MethodError(err("PROVIDER.NOT_CONFIGURED", "no model provider is configured", "Configure a provider before using sessions."));
    const id = z.string().min(1).max(64);
    try {
      switch (method) {
        case "session.list": {
          const p = z.strictObject({ channel: z.string().min(1).optional(), limit: z.number().int().positive().optional() }).parse(params ?? {});
          return { sessions: mgr.list(p) };
        }
        case "session.get": {
          const p = z.strictObject({ session: id, limit: z.number().int().positive().optional() }).parse(params);
          return { session: mgr.get(p.session), messages: mgr.messages(p.session, p.limit === undefined ? {} : { limit: p.limit }) };
        }
        case "session.create": {
          const p = z
            .strictObject({
              channel: z.string().min(1).max(64).default("local"),
              conversation: z.string().min(1).max(256).default("main"),
              scope: z.string().min(1).max(256).default("owner"),
            })
            .parse(params ?? {});
          return { session: mgr.getOrCreate(p) };
        }
        case "session.send": {
          const p = z.strictObject({ session: id, text: z.string() }).parse(params);
          return mgr.send(p.session, p.text, { sender: "owner" });
        }
        case "session.cancel": {
          const p = z.strictObject({ session: id }).parse(params);
          mgr.get(p.session);
          return { cancelled: mgr.cancel(p.session) };
        }
        case "session.export": {
          const p = z.strictObject({ session: id, format: z.enum(["jsonl", "markdown"]).default("jsonl") }).parse(params);
          return { format: p.format, content: p.format === "jsonl" ? mgr.exportJsonl(p.session) : mgr.exportMarkdown(p.session) };
        }
        case "session.import": {
          const p = z.strictObject({ content: z.string().max(900_000) }).parse(params);
          return { session: mgr.importJsonl(p.content) };
        }
        default: {
          const p = z.strictObject({ session: id }).parse(params);
          mgr.delete(p.session);
          return {};
        }
      }
    } catch (e) {
      if (e instanceof SessionError) {
        throw new MethodError(err(`SESSION.${e.code}`, e.message, "Check the session id and the size of your input.", e.code === "QUEUE_FULL"));
      }
      throw e;
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

/** Read the owner token from `<dataDir>/gateway.token`, creating it (mode 0600) on first use. */
export function ensureGatewayToken(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return loadOrCreateToken(join(dataDir, TOKEN_FILE));
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
