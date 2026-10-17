import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createSecureServer, type Server as SecureServer } from "node:https";
import { X509Certificate } from "node:crypto";
import type { Duplex } from "node:stream";
import { dirname, isAbsolute, join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { BRAND } from "@clawnexus/brand";
import {
  PROTOCOL_VERSION,
  helloParamsSchema,
  isCompatible,
  parseFrame,
  newNonce,
  verifyDeviceSignature,
  type AuthPurpose,
  type DeviceScope,
  type ErrorBody,
} from "@clawnexus/protocol";
import { DeviceError, DeviceRegistry } from "@clawnexus/devices";
import { BlobStore, findScanHook, isBlobId, scanHook } from "@clawnexus/blobs";
import { isLoopback, type Config } from "@clawnexus/config";
import { EventLog, CursorExpiredError, openDb, type Db, type StoredEvent } from "@clawnexus/store";
import { PairingError, PairingService } from "@clawnexus/pairing";
import { ApprovalError, ApprovalStore, type PrincipalKind } from "@clawnexus/policy";
import { BUILTIN_TOOLS, ToolExecutor, WorkspaceGuard } from "@clawnexus/tools";
import { BridgeRegistry, type BridgeGrant, type MintOptions } from "./bridge.js";
import { ChannelManager, WEBCHAT_ID, WebChatAdapter } from "@clawnexus/channels";
import { PluginError, PluginHost, type HostOptions } from "@clawnexus/plugins";
import { LocalVault, VaultError } from "@clawnexus/vault";
import { SessionError, SessionManager, type Provider, type Session, type SessionManagerOptions } from "@clawnexus/sessions";
import { fileSendTool } from "./filetool.js";
import { MemoryError, MemoryStore, memoryTools, renderContext, type MemoryScope, type ScopeDecision } from "@clawnexus/memory";

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
  /** TLS certificate chain and private key (PEM). Required to listen beyond loopback; allowed on loopback too. */
  tls?: { cert: string | Buffer; key: string | Buffer };
  /** Listen beyond loopback WITHOUT TLS. Only for an owner who has explicitly accepted the risk (SEC-6). */
  insecure?: boolean;
  /** How long a device's sign-in lasts before it must prove itself again (docs/03 section 3). Default 15 minutes. */
  deviceLeaseMs?: number;
  /** How long a challenge may be answered. Default 30 seconds. */
  challengeTtlMs?: number;
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
  /** Set when the connection signed in as a paired device. What it may do is limited to its scopes. */
  device?: { id: string; scopes: readonly DeviceScope[]; leaseUntil: number };
  /** A challenge sent to this connection and not yet answered. Single use, short lived. */
  challenge?: { deviceId: string; nonce: string; purpose: AuthPurpose; expiresAt: number };
  leaseTimer?: NodeJS.Timeout;
  unsubscribe?: () => void;
  /** Runs right after the current request's response is sent (used to start event replay after the ack). */
  postReply?: () => void;
  tokens: number;
  lastRefill: number;
  helloTimer?: NodeJS.Timeout;
}

const sha = (s: string): Buffer => createHash("sha256").update(s).digest();

/** What a paired device may call, and the scope that allows it. Anything not listed is the owner's alone. */
const DEVICE_METHODS: Record<string, DeviceScope> = {
  status: "read",
  "events.subscribe": "read",
  "events.unsubscribe": "read",
  "session.list": "read",
  "session.get": "read",
  "approval.list": "read",
  "session.create": "chat",
  "session.send": "chat",
  "session.cancel": "chat",
  "blob.get": "read",
  "approval.decide": "approve",
};

const isWildcard =(host: string): boolean => host === "0.0.0.0" || host === "::" || host === "[::]";

/** The names and addresses a certificate says it is valid for (its subject alternative names), lower-case. */
function certNames(cert: X509Certificate): string[] {
  const out: string[] = [];
  for (const part of (cert.subjectAltName ?? "").split(",")) {
    const m = /^\s*(DNS|IP Address):(.+?)\s*$/.exec(part);
    if (m?.[2]) out.push(m[2].toLowerCase());
  }
  return out;
}

/** File the Gateway writes so a client on this computer finds it and knows how to trust it. */
export const ENDPOINT_FILE = "gateway.endpoint";

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
  private readonly vault: LocalVault;
  readonly memory: MemoryStore;
  readonly devices: DeviceRegistry;
  readonly blobs: BlobStore;
  private readonly tls: { cert: string | Buffer; key: string | Buffer } | undefined;
  /** Host names the certificate is valid for, lower-case. Browsers only reach us under one of these. */
  private readonly certHosts: string[] = [];
  /** SHA-256 fingerprint of our certificate, for clients that pin it. */
  readonly certFingerprint: string | undefined;
  readonly channels: ChannelManager;
  private readonly webchat: WebChatAdapter;
  private readonly profile: "standard" | "locked-down" | "trusted";
  readonly tokenPath: string;

  private readonly db: Db;
  private readonly http: Server | SecureServer;
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
  private readonly o: Required<Pick<GatewayOptions, "helloTimeoutMs" | "maxBufferedBytes" | "requestsPerSecond" | "maxAuthFailures" | "authFailureWindowMs" | "deviceLeaseMs" | "challengeTtlMs">> & {
    allowedOrigins: readonly string[];
    now: () => number;
  };

  constructor(opts: GatewayOptions) {
    this.host = opts.host ?? opts.config?.gateway.bind ?? "127.0.0.1";
    this.requestedPort = opts.port ?? opts.config?.gateway.port ?? 7391;
    this.tls = opts.tls;
    if (!isLoopback(this.host) && !this.tls && opts.insecure !== true) {
      throw new Error(
        `refusing to listen on ${this.host} without TLS (SEC-6). Turn on gateway.tls and run \`${BRAND.cli} tls init\`, keep the bind on loopback behind a VPN or a proxy that terminates TLS, or accept the risk with gateway.insecureAcknowledged.`,
      );
    }
    if (this.tls) {
      // Reading the certificate here also proves it parses before anything listens.
      const cert = new X509Certificate(this.tls.cert);
      this.certFingerprint = cert.fingerprint256.replace(/:/g, "").toLowerCase();
      this.certHosts = certNames(cert);
    }
    this.o = {
      allowedOrigins: opts.allowedOrigins ?? [],
      helloTimeoutMs: opts.helloTimeoutMs ?? 5_000,
      maxBufferedBytes: opts.maxBufferedBytes ?? 5 * 1024 * 1024,
      requestsPerSecond: opts.requestsPerSecond ?? 50,
      maxAuthFailures: opts.maxAuthFailures ?? 5,
      authFailureWindowMs: opts.authFailureWindowMs ?? 60_000,
      deviceLeaseMs: opts.deviceLeaseMs ?? 15 * 60_000,
      challengeTtlMs: opts.challengeTtlMs ?? 30_000,
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
    this.memory = new MemoryStore(join(opts.dataDir, "memory"), { db: this.db, events: this.events, now: this.o.now });
    this.tools = new ToolExecutor({
      events: this.events,
      approvals: this.approvals,
      guard: new WorkspaceGuard([workspace]),
      tools: [...BUILTIN_TOOLS, ...memoryTools({ store: this.memory, scopeFor: (env) => this.memoryScopeFor(env.principal, env.session) }), fileSendTool({ channels: () => this.channels, sessions: () => this.sessions, blobs: () => this.blobs })],
    });
    this.vault = new LocalVault(opts.dataDir);
    this.plugins = new PluginHost({ dataDir: opts.dataDir, db: this.db, events: this.events, tools: this.tools, secrets: this.vault, channels: { attach: (a) => this.channels.attach(a), detach: (id) => this.channels.detach(id) }, now: this.o.now, ...opts.plugins });
    this.blobs = new BlobStore(join(opts.dataDir, "blobs"), this.db, { now: this.o.now });
    this.sessions = opts.provider ? new SessionManager(this.db, this.events, opts.provider, { now: this.o.now, context: (s) => this.memoryContext(s), blobReader: (id) => this.blobs.read(id), ...opts.sessions }) : undefined;

    this.devices = new DeviceRegistry(this.db, { now: this.o.now, events: this.events });
    this.webchat = new WebChatAdapter({
      scheme: this.tls ? "https" : "http",
      registerOwner: (externalId, display) => void this.pairing.registerOwner({ channel: WEBCHAT_ID, accountId: "default", externalId, display }),
      principalOf: (externalId) => this.pairing.principalOf({ channel: WEBCHAT_ID, accountId: "default", externalId }),
      now: this.o.now,
    });
    const scanner = findScanHook(opts.dataDir);
    this.channels = new ChannelManager({ db: this.db, events: this.events, pairing: this.pairing, sessions: this.sessions, blobs: this.blobs, ...(scanner ? { scan: scanHook(scanner) } : {}), now: this.o.now });
    this.channels.register(this.webchat);

    const handler = (req: IncomingMessage, res: import("node:http").ServerResponse): void => this.handleHttp(req, res);
    this.http = this.tls ? createSecureServer({ cert: this.tls.cert, key: this.tls.key, minVersion: "TLSv1.2" }, handler) : createServer(handler);
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
    // The secret store opens first: plugins read their secrets at start. If it cannot open, plugins that need secrets wait; nothing else does.
    await this.vault.open().catch((e: unknown) => {
      this.events.append([{ type: "vault.unavailable", data: { reason: e instanceof VaultError ? e.message : "could not open the secret store" } }]);
    });
    // Enabled plugins start now. A plugin that cannot start is contained and reported; it never blocks the Gateway.
    await this.plugins.startEnabled().catch(() => undefined);
    await this.channels.start();
    this.ready = true;
    this.gcBlobs();
    try {
      writeFileSync(
        join(dirname(this.tokenPath), ENDPOINT_FILE),
        `${JSON.stringify({ url: `${this.tls ? "wss" : "ws"}://${this.selfHost()}:${this.boundPort}/v1/ws`, ...(this.certFingerprint ? { fingerprint: this.certFingerprint } : {}), pid: process.pid })}\n`,
        { mode: 0o600 },
      );
    } catch {
      /* clients can still be told the address by hand */
    }
    this.events.append([{ type: "gateway.started", data: { version: VERSION, tls: this.tls !== undefined } }]);
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
    try {
      const p = join(dirname(this.tokenPath), ENDPOINT_FILE);
      if ((JSON.parse(readFileSync(p, "utf8")) as { pid?: number }).pid === process.pid) rmSync(p, { force: true });
    } catch {
      /* not there, or not ours */
    }
    await this.channels.stop();
    for (const c of this.conns) {
      clearTimeout(c.leaseTimer);
      c.ws.close(1001, "gateway shutting down");
    }
    await this.sessions?.close();
    await this.plugins.stop();
    this.vault.close();
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
    return `${this.tls ? "wss" : "ws"}://${this.selfHost()}:${this.boundPort}/v1/ws`;
  }

  /** Issue a credential for one session's tool bridge. Revoke it when that session's harness goes away. */
  mintBridge(o: MintOptions): { token: string; url: string; pin?: string; revoke(): void } {
    const m = this.bridgeGrants.mint(o);
    // The bridge runs on this computer and trusts exactly our certificate, whatever names it carries.
    return { token: m.token, url: this.url, ...(this.certFingerprint ? { pin: this.certFingerprint } : {}), revoke: m.revoke };
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

  /**
   * DNS-rebinding defence: the Host header must name this machine on our port: a loopback name, the address we are
   * bound to, or (with TLS) a name our certificate is valid for. A page on another site cannot get a browser to send
   * any of those to us for a name it controls.
   */
  private hostAllowed(req: IncomingMessage): boolean {
    const host = req.headers.host;
    if (!host) return false;
    const names = ["127.0.0.1", "localhost", "[::1]", ...this.certHosts.map((h) => (h.includes(":") ? `[${h}]` : h))];
    if (!isWildcard(this.host)) names.push(this.host.includes(":") ? `[${this.host}]` : this.host);
    return names.some((n) => `${n.toLowerCase()}:${this.boundPort}` === host.toLowerCase());
  }

  /** An address on this computer that reaches us, whatever we are bound to. */
  private selfHost(): string {
    const h = isWildcard(this.host) ? (this.host.includes(":") ? "::1" : "127.0.0.1") : this.host;
    return h.includes(":") ? `[${h}]` : h;
  }

  /** Where clients on this computer reach us, e.g. `https://127.0.0.1:7391`. */
  get origin(): string {
    return `${this.tls ? "https" : "http"}://${this.selfHost()}:${this.boundPort}`;
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
      clearTimeout(c.leaseTimer);
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
      if (method === "auth.verify") {
        this.reply(c, id, this.verifyDevice(c, params));
        return;
      }
      if (!c.authed) {
        this.fail(c, id, err("AUTH.REQUIRED", "send connection.hello with credentials first", "Authenticate before calling methods."));
        return;
      }
      if (c.device && this.o.now() > c.device.leaseUntil) {
        c.ws.close(4401, "device authorization expired");
        return;
      }
      if (c.device && method === "auth.challenge") {
        this.reply(c, id, this.newChallenge(c, c.device.id, "refresh"));
        return;
      }
      if (c.device && method === "auth.refresh") {
        const d = this.checkAnswer(c, params, "refresh");
        if (d.id !== c.device.id) throw new MethodError(err("AUTH.BAD_SIGNATURE", "the signature does not match", "Check the device's key."));
        this.setLease(c);
        this.reply(c, id, { leaseMs: this.o.deviceLeaseMs });
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
    if (p.auth?.device) return this.helloDevice(c, p.auth.device.id);
    if (p.auth?.pair) return this.helloPair(c, p.auth.pair);
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

  /** Remove stored files that no message refers to any more (a session was deleted, a message never got written). */
  gcBlobs(): { removed: number; freed: number } {
    try {
      const referenced = new Set<string>();
      for (const r of this.db.prepare("SELECT attachments FROM messages WHERE attachments IS NOT NULL").all() as unknown as Array<{ attachments: string }>) {
        try {
          for (const a of JSON.parse(r.attachments) as Array<{ id?: unknown }>) if (typeof a.id === "string") referenced.add(a.id);
        } catch {
          /* a damaged row refers to nothing */
        }
      }
      for (const id of this.channels.outboxFileIds()) referenced.add(id); // files still waiting to be sent
      return this.blobs.gc(referenced);
    } catch {
      return { removed: 0, freed: 0 };
    }
  }

  // ---------------- device sign-in (docs/03 section 3, ADR 0010) ----------------

  private newChallenge(c: Conn, deviceId: string, purpose: AuthPurpose): { nonce: string; expiresInMs: number } {
    const nonce = newNonce();
    c.challenge = { deviceId, nonce, purpose, expiresAt: this.o.now() + this.o.challengeTtlMs };
    return { nonce, expiresInMs: this.o.challengeTtlMs };
  }

  /** A known device asks to sign in: send it something fresh to sign. Nothing is granted yet. */
  private helloDevice(c: Conn, id: string): unknown {
    const d = this.devices.get(id);
    if (!d || d.revokedAt !== undefined) {
      this.recordAuthFailure(c.remote);
      throw d
        ? new MethodError(err("AUTH.REVOKED", "this device has been revoked", "Pair it again from the owner's computer if you trust it."))
        : new MethodError(err("AUTH.BAD_DEVICE", "this device is not paired", "Pair it again from the owner's computer."));
    }
    return { protocol: PROTOCOL_VERSION, server: `${BRAND.name} ${VERSION}`, challenge: this.newChallenge(c, id, "connect") };
  }

  /** A new device presents a one-time code and its public key. */
  private helloPair(c: Conn, pair: { code: string; publicKey: string; name?: string | undefined }): unknown {
    try {
      const d = this.devices.completePairing(pair.code, pair.publicKey, pair.name);
      this.signIn(c, d);
      return { protocol: PROTOCOL_VERSION, server: `${BRAND.name} ${VERSION}`, role: "device", device: { id: d.id, name: d.name, scopes: d.scopes }, leaseMs: this.o.deviceLeaseMs, latestSeq: this.events.latestSeq() };
    } catch (e) {
      if (!(e instanceof DeviceError)) throw e;
      if (e.code === "BAD_CODE") {
        this.recordAuthFailure(c.remote);
        throw new MethodError(err("AUTH.BAD_PAIRING_CODE", e.message, "Ask the owner for a new code (`devices pair`)."));
      }
      throw new MethodError(err("AUTH.PAIRING", e.message, "Check the key, or ask the owner to revoke an old device."));
    }
  }

  private signIn(c: Conn, d: { id: string; scopes: readonly DeviceScope[] }): void {
    c.authed = true;
    c.device = { id: d.id, scopes: d.scopes, leaseUntil: 0 };
    clearTimeout(c.helloTimer);
    this.setLease(c);
  }

  /** A device's sign-in lasts a short while; it must prove itself again to keep going. */
  private setLease(c: Conn): void {
    if (!c.device) return;
    clearTimeout(c.leaseTimer);
    c.device.leaseUntil = this.o.now() + this.o.deviceLeaseMs;
    c.leaseTimer = setTimeout(() => c.ws.close(4401, "device authorization expired"), this.o.deviceLeaseMs);
    c.leaseTimer.unref();
  }

  /** Check the answer to the challenge this connection was given. A challenge works once, whatever the outcome. */
  private checkAnswer(c: Conn, params: unknown, purpose: AuthPurpose): { id: string; scopes: readonly DeviceScope[] } {
    const p = z.strictObject({ signature: z.string().min(1).max(200) }).parse(params);
    const ch = c.challenge;
    delete c.challenge;
    if (!ch || ch.purpose !== purpose) throw new MethodError(err("AUTH.NO_CHALLENGE", "there is no challenge to answer", "Ask for one first."));
    if (this.isLockedOut(c.remote)) throw new MethodError(err("AUTH.LOCKED", "too many failed attempts", "Wait a minute and retry.", true));
    if (this.o.now() > ch.expiresAt) throw new MethodError(err("AUTH.CHALLENGE_EXPIRED", "the challenge took too long to answer", "Ask for a new one.", true));
    const d = this.devices.usable(ch.deviceId);
    if (!d || !verifyDeviceSignature(d.publicKey, d.id, ch.nonce, purpose, p.signature)) {
      this.recordAuthFailure(c.remote);
      this.events.append([{ type: "device.auth_failed", data: { id: ch.deviceId, reason: d ? "bad signature" : "device revoked" } }]);
      throw new MethodError(err("AUTH.BAD_SIGNATURE", "the signature does not match", "Check the device's key, or pair it again."));
    }
    return d;
  }

  private verifyDevice(c: Conn, params: unknown): unknown {
    if (c.authed) throw new MethodError(err("UNSUPPORTED.ALREADY_AUTHENTICATED", "already authenticated", "Open a new connection to re-authenticate."));
    const d = this.checkAnswer(c, params, "connect");
    this.devices.touch(d.id);
    this.signIn(c, d);
    return { role: "device", device: { id: d.id, scopes: d.scopes }, leaseMs: this.o.deviceLeaseMs, latestSeq: this.events.latestSeq() };
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

  // ---------------- memory ----------------

  /**
   * Which notes a caller may see. The owner's own, when acting for the owner; the contact's own, when talking to a
   * guest one-to-one; none in a group (several people share it, so nothing personal belongs there). The session row is
   * the truth, never the model's arguments.
   */
  private memoryScopeFor(principal: PrincipalKind, sessionId: string | undefined): ScopeDecision {
    if (principal === "owner") return { scope: { kind: "owner" } };
    if (principal !== "guest") return { unavailable: "memory is not available to this caller" };
    let s: Session | undefined;
    try {
      s = sessionId === undefined ? undefined : this.sessions?.get(sessionId);
    } catch {
      s = undefined;
    }
    if (!s) return { unavailable: "memory is not available outside a conversation" };
    const scope = this.memoryScopeOfSession(s);
    return scope ? { scope } : { unavailable: "memory is not kept in group conversations" };
  }

  private memoryScopeOfSession(s: Session): MemoryScope | undefined {
    if (s.principal === "owner") return { kind: "owner" };
    if (s.scope === "group") return undefined;
    return { kind: "contact", channel: s.channel, contact: s.scope };
  }

  private memoryContext(s: Session): string | undefined {
    const scope = this.memoryScopeOfSession(s);
    return scope ? renderContext(this.memory, scope) : undefined;
  }

  private memoryMethod(method: string, params: unknown): unknown {
    const scope = z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("owner") }),
      z.strictObject({ kind: z.literal("contact"), channel: z.string().min(1).max(64), contact: z.string().min(1).max(256) }),
    ]);
    const name = z.string().min(1).max(64);
    const owner = { via: "owner" as const };
    try {
      switch (method) {
        case "memory.list": {
          const p = z.strictObject({ scope }).parse(params);
          return { files: this.memory.list(p.scope) };
        }
        case "memory.read": {
          const p = z.strictObject({ scope, name }).parse(params);
          return { note: this.memory.read(p.scope, p.name) };
        }
        case "memory.write": {
          const p = z.strictObject({ scope, name, content: z.string().max(200_000), mode: z.enum(["replace", "append"]).default("replace") }).parse(params);
          return { note: this.memory.write(p.scope, p.name, p.content, p.mode, owner) };
        }
        case "memory.delete": {
          const p = z.strictObject({ scope, name }).parse(params);
          this.memory.delete(p.scope, p.name, owner);
          return {};
        }
        case "memory.export": {
          const p = z.strictObject({ scope }).parse(params);
          return { files: this.memory.export(p.scope) };
        }
        default: {
          const p = z.strictObject({ scope: z.union([scope, z.literal("all")]) }).parse(params);
          return this.memory.erase(p.scope);
        }
      }
    } catch (e) {
      if (e instanceof MemoryError) throw new MethodError(err(`MEMORY.${e.code}`, e.message, "Check the note name and size."));
      throw e;
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
    if (c.device) {
      // A paired device does only what its scopes allow; everything else (plugins, memory, tools, pairing, other
      // devices) stays with the owner's own connection.
      const need = DEVICE_METHODS[method];
      if (need === undefined || !c.device.scopes.includes(need)) {
        throw new MethodError(err("AUTH.FORBIDDEN", `this device may not call ${method}`, need === undefined ? "That action is only available from the owner's computer." : `The owner can allow it by pairing the device with the "${need}" scope.`));
      }
    }
    switch (method) {
      case "device.pair.begin": {
        const p = z.strictObject({ name: z.string().min(1).max(64).optional(), scopes: z.array(z.enum(["read", "chat", "approve"])).min(1).max(3).optional() }).parse(params ?? {});
        try {
          const r = this.devices.beginPairing(p.name, p.scopes);
          return { ...r, url: `${this.tls ? "wss" : "ws"}://${this.selfHost()}:${this.boundPort}/v1/ws`, ...(this.certFingerprint ? { fingerprint: this.certFingerprint } : {}) };
        } catch (e) {
          if (e instanceof DeviceError) throw new MethodError(err(`AUTH.PAIRING`, e.message, "Revoke a device, or wait for pending codes to expire."));
          throw e;
        }
      }
      case "device.list":
        return { devices: this.devices.list().map((d) => ({ id: d.id, name: d.name, scopes: d.scopes, createdAt: d.createdAt, ...(d.lastSeenAt === undefined ? {} : { lastSeenAt: d.lastSeenAt }), ...(d.revokedAt === undefined ? {} : { revokedAt: d.revokedAt }) })), pendingCodes: this.devices.pending() };
      case "device.revoke": {
        const p = z.strictObject({ id: z.string().min(1).max(64) }).parse(params);
        try {
          const d = this.devices.revoke(p.id);
          for (const x of this.conns) if (x.device?.id === d.id) x.ws.close(4401, "device revoked");
          return { device: { id: d.id, name: d.name, revokedAt: d.revokedAt } };
        } catch (e) {
          if (e instanceof DeviceError) throw new MethodError(err("AUTH.BAD_DEVICE", e.message, "List devices to see their ids."));
          throw e;
        }
      }
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
          const a = this.approvals.decide(p.id, p.approve, { kind: "owner", id: c.device ? `device:${c.device.id}` : "owner" });
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

      case "memory.scopes":
        return { scopes: this.memory.scopes() };
      case "memory.list":
      case "memory.read":
      case "memory.write":
      case "memory.delete":
      case "memory.export":
      case "memory.erase":
        return this.memoryMethod(method, params);

      case "blob.get": {
        const p = z.strictObject({ id: z.string().min(1).max(100) }).parse(params);
        const info = isBlobId(p.id) ? this.blobs.info(p.id) : undefined;
        const bytes = info ? this.blobs.read(p.id) : undefined;
        if (!info || !bytes) throw new MethodError(err("SESSION.NOT_FOUND", "no such attachment", "Attachments are listed on the messages of a session."));
        return { id: info.id, mime: info.mime, bytes: bytes.length, data: bytes.toString("base64") };
      }
      case "channel.list":
        return { channels: this.channels.list() };
      case "channel.outbox":
        return this.channels.outbox.summary();
      case "channel.outbox.retry":
        return { count: this.channels.retryOutbox() };
      case "channel.outbox.purge": {
        const p = z.strictObject({ all: z.boolean().default(false) }).parse(params ?? {});
        return { count: this.channels.outbox.purge(p.all) };
      }
      case "channel.webchat.link": {
        return this.webchat.createOwnerLink(this.origin);
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
      case "plugin.settings":
      case "plugin.config.set":
      case "plugin.secret.set":
      case "plugin.secret.delete":
        return this.pluginMethod(method, params);

      case "session.list":
      case "session.get":
      case "session.create":
      case "session.send":
      case "session.cancel":
      case "session.export":
      case "session.import":
      case "session.delete":
        return this.sessionMethod(method, params, c.device ? `device:${c.device.id}` : "owner");

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
        case "plugin.settings": {
          const p = z.strictObject({ id }).parse(params);
          return { settings: this.plugins.settings(p.id) };
        }
        case "plugin.config.set": {
          const p = z.strictObject({ id, values: z.record(z.string().max(64), z.union([z.string().max(65_536), z.number().finite(), z.boolean(), z.null()])) }).parse(params);
          return { settings: await this.plugins.setConfig(p.id, p.values) };
        }
        case "plugin.secret.set": {
          const p = z.strictObject({ id, name: z.string().min(1).max(64), value: z.string().min(1).max(8192) }).parse(params);
          return { settings: await this.plugins.setSecret(p.id, p.name, p.value) };
        }
        case "plugin.secret.delete": {
          const p = z.strictObject({ id, name: z.string().min(1).max(64) }).parse(params);
          return { settings: await this.plugins.deleteSecret(p.id, p.name) };
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

  private sessionMethod(method: string, params: unknown, sender = "owner"): unknown {
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
          return mgr.send(p.session, p.text, { sender });
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
          this.gcBlobs();
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
