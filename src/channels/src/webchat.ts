import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import type { ChannelAdapter, ChannelCapabilities, ChannelHost, ChannelStatus, OutboundContent, SendResult, SendTarget } from "./types.js";

export const WEBCHAT_ID = "webchat";
const ACCOUNT = "default";
const SECRET = /^cnw_[A-Za-z0-9_-]{43}$/;
const LINK_CODE = /^cno_[A-Za-z0-9_-]{32}$/;
const HOST_HEADER = /^[A-Za-z0-9.[\]:-]{1,100}$/;

export interface WebChatOptions {
  /**
   * Called when an owner link is redeemed: record this browser identity as one of the owner's.
   * This is the only way WebChat produces an owner, and it needs a one-time code that only an
   * authenticated local surface can mint.
   */
  registerOwner(senderId: string, display: string): void;
  /** How the page is served; a browser's Origin header must match it. Default "http". */
  scheme?: "http" | "https";
  /** Read-only view of how the router sees a sender. */
  principalOf(senderId: string): "owner" | "guest" | "unpaired";
  now?: () => number;
  maxConnections?: number;
  maxPerSender?: number;
  linkTtlMs?: number;
  helloTimeoutMs?: number;
  /** Longest message sent to the browser in one piece (longer replies are split). */
  maxTextChars?: number;
}

/** A file being sent up from the browser in pieces. It lives in memory only, and only for a visitor who is already paired. */
interface Upload {
  name: string;
  chunks: Buffer[];
  bytes: number;
  next: number;
  done: boolean;
}

/** Browser upload limits (the Gateway applies its own, stricter file rules again when the message is delivered). */
export const UPLOAD = { chunkBytes: 192 * 1024, fileBytes: 8 * 1024 * 1024, pendingBytes: 16 * 1024 * 1024, connectionBytes: 64 * 1024 * 1024, files: 4, open: 8 } as const;

interface Conn {
  ws: WebSocket;
  senderId?: string;
  tokens: number;
  at: number;
  helloTimer?: NodeJS.Timeout;
  uploads: Map<string, Upload>;
  uploaded: number;
}

const helloFrame = z.strictObject({ t: z.literal("hello"), secret: z.string().max(100).nullable().optional(), redeem: z.string().max(100).nullable().optional() });
const upId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const messageFrame = z.strictObject({ t: z.literal("message"), id: upId, text: z.string().max(8000), files: z.array(upId).max(UPLOAD.files).optional() });
const fileFrame = z.strictObject({ t: z.literal("file"), up: upId, name: z.string().max(256), seq: z.number().int().min(0).max(100_000), last: z.boolean(), data: z.string().max(Math.ceil((UPLOAD.chunkBytes * 4) / 3) + 8) });
const pingFrame = z.strictObject({ t: z.literal("ping") });
const frame = z.discriminatedUnion("t", [helloFrame, messageFrame, fileFrame, pingFrame]);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** A frame from someone who has not said hello yet may not be large. */
const PRE_HELLO_BYTES = 16 * 1024;

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
/** A browser's identity is derived from a secret only that browser holds; nobody can claim another visitor's id. */
export const senderIdOf = (secret: string): string => `w_${sha(secret).slice(0, 32)}`;

function loadAsset(name: string): Buffer | undefined {
  try {
    return readFileSync(new URL(`../assets/${name}`, import.meta.url));
  } catch {
    return undefined;
  }
}

/**
 * The built-in browser chat (docs/05, matrix row 4). It is a channel like any other: visitors are unknown senders and
 * go through pairing; the router decides everything. What is specific to the web is who a visitor is (a secret kept in
 * their browser), which origins may connect, and how the owner proves it is them (a one-time link minted locally).
 */
export class WebChatAdapter implements ChannelAdapter {
  readonly id = WEBCHAT_ID;
  readonly capabilities: ChannelCapabilities;
  private host: ChannelHost | undefined;
  private wss: WebSocketServer | undefined;
  private readonly conns = new Set<Conn>();
  private readonly bySender = new Map<string, Set<Conn>>();
  private readonly links = new Map<string, number>();
  private state: ChannelStatus = { state: "stopped" };
  private readonly assets = new Map<string, { type: string; body: Buffer }>();
  private readonly now: () => number;

  constructor(private readonly o: WebChatOptions) {
    this.now = o.now ?? Date.now;
    this.capabilities = { typing: true, groups: false, maxTextChars: o.maxTextChars ?? 8000, files: true };
  }

  async start(host: ChannelHost): Promise<void> {
    this.host = host;
    for (const [path, file, type] of [
      ["/webchat", "webchat.html", "text/html; charset=utf-8"],
      ["/webchat/app.js", "app.js", "text/javascript; charset=utf-8"],
      ["/webchat/app.css", "app.css", "text/css; charset=utf-8"],
    ] as const) {
      const body = loadAsset(file);
      if (body) this.assets.set(path, { type, body });
    }
    this.wss = new WebSocketServer({ noServer: true, maxPayload: Math.ceil((UPLOAD.chunkBytes * 4) / 3) + 4096, perMessageDeflate: false });
    this.wss.on("connection", (ws) => this.onConnection(ws));
    this.state = this.assets.size === 3 ? { state: "connected" } : { state: "degraded", detail: "the web page files are missing" };
  }

  async stop(): Promise<void> {
    for (const c of this.conns) c.ws.close(1001, "shutting down");
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
    this.wss = undefined;
    this.conns.clear();
    this.bySender.clear();
    this.links.clear();
    this.state = { state: "stopped" };
  }

  status(): ChannelStatus {
    return this.state;
  }

  // ---------------- owner links ----------------

  /** Mint a one-time link that makes the browser which opens it the owner. Valid for a few minutes, usable once. */
  createOwnerLink(origin: string): { url: string; expiresAt: number } {
    const t = this.now();
    for (const [h, exp] of this.links) if (exp <= t) this.links.delete(h);
    while (this.links.size >= 20) {
      const oldest = this.links.keys().next().value;
      if (oldest === undefined) break;
      this.links.delete(oldest);
    }
    const code = `cno_${randomBytes(24).toString("base64url")}`;
    const expiresAt = t + (this.o.linkTtlMs ?? 5 * 60_000);
    this.links.set(sha(code), expiresAt);
    // The code sits after the # so it is never sent to a server, written to an access log or passed as a Referer.
    return { url: `${origin}/webchat#owner=${code}`, expiresAt };
  }

  private redeem(code: string): boolean {
    if (!LINK_CODE.test(code)) return false;
    const h = sha(code);
    const exp = this.links.get(h);
    if (exp === undefined) return false;
    this.links.delete(h); // single use, valid or not
    return exp > this.now();
  }

  // ---------------- HTTP ----------------

  /** Serve the page. Returns true if the request was for WebChat. The caller has already checked the Host header. */
  handleHttp(req: IncomingMessage, res: ServerResponse): boolean {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const normalized = path === "/webchat/" ? "/webchat" : path;
    if (!normalized.startsWith("/webchat")) return false;
    const asset = this.assets.get(normalized);
    if (!asset) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }).end("not found");
      return true;
    }
    const host = String(req.headers.host ?? "");
    const ws = HOST_HEADER.test(host) ? `ws://${host} wss://${host}` : "";
    res
      .writeHead(200, {
        "content-type": asset.type,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "x-frame-options": "DENY",
        "cross-origin-opener-policy": "same-origin",
        "content-security-policy": `default-src 'none'; script-src 'self'; style-src 'self'; connect-src ${ws}; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      })
      .end(asset.body);
    return true;
  }

  // ---------------- WebSocket ----------------

  /** Returns false if the path is not ours. The caller has already checked the Host header. */
  handleUpgrade(req: IncomingMessage, socket: Duplex): boolean {
    if (req.url !== "/v1/webchat") return false;
    const reject = (status: string): true => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
      return true;
    };
    if (!this.wss || this.state.state !== "connected") return reject("503 Service Unavailable");
    // Only the page we serve may connect from a browser: a web page on another site must not be able to open this socket.
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (origin !== undefined && (host === undefined || origin.toLowerCase() !== `${this.o.scheme ?? "http"}://${host.toLowerCase()}`)) return reject("403 Forbidden");
    if (this.conns.size >= (this.o.maxConnections ?? 100)) return reject("503 Service Unavailable");
    this.wss.handleUpgrade(req, socket, Buffer.alloc(0), (ws) => this.wss?.emit("connection", ws, req));
    return true;
  }

  private onConnection(ws: WebSocket): void {
    const c: Conn = { ws, tokens: 10, at: this.now(), uploads: new Map(), uploaded: 0 };
    this.conns.add(c);
    c.helloTimer = setTimeout(() => ws.close(4408, "hello timeout"), this.o.helloTimeoutMs ?? 5000);
    ws.on("message", (data, isBinary) => {
      if (isBinary) return ws.close(1003, "text only");
      void this.onFrame(c, data.toString("utf8")).catch(() => ws.close(1011, "error"));
    });
    ws.on("close", () => this.drop(c));
    ws.on("error", () => ws.terminate());
  }

  private drop(c: Conn): void {
    clearTimeout(c.helloTimer);
    this.conns.delete(c);
    if (c.senderId) {
      const set = this.bySender.get(c.senderId);
      set?.delete(c);
      if (set?.size === 0) this.bySender.delete(c.senderId);
    }
  }

  private out(c: Conn, f: object): void {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(f));
  }

  private async onFrame(c: Conn, raw: string): Promise<void> {
    if (!c.senderId && raw.length > PRE_HELLO_BYTES) return void c.ws.close(1009, "too large");
    let parsed;
    try {
      parsed = frame.safeParse(JSON.parse(raw));
    } catch {
      return void c.ws.close(1008, "bad frame");
    }
    if (!parsed.success) return void c.ws.close(1008, "bad frame");
    const f = parsed.data;
    const host = this.host;
    if (!host) return void c.ws.close(1013, "not ready");

    if (f.t === "ping") return;

    if (f.t === "hello") {
      if (c.senderId) return void c.ws.close(1008, "already said hello");
      clearTimeout(c.helloTimer);
      const supplied = typeof f.secret === "string" && SECRET.test(f.secret) ? f.secret : undefined;
      const secret = supplied ?? `cnw_${randomBytes(32).toString("base64url")}`;
      const senderId = senderIdOf(secret);
      c.senderId = senderId;
      const redeemed = typeof f.redeem === "string" && f.redeem !== "" ? this.redeem(f.redeem) : undefined;
      if (redeemed) this.o.registerOwner(senderId, "Owner (web)");

      let set = this.bySender.get(senderId);
      if (!set) this.bySender.set(senderId, (set = new Set()));
      set.add(c);
      // Over the per-visitor limit: end only the oldest surplus connections (the set keeps insertion order).
      let surplus = set.size - (this.o.maxPerSender ?? 5);
      for (const old of set) {
        if (surplus <= 0) break;
        if (old === c) continue;
        old.ws.close(4000, "replaced by a newer connection");
        surplus--;
      }

      const role = this.o.principalOf(senderId);
      this.out(c, { t: "ready", role, ...(supplied ? {} : { secret }), ...(redeemed === undefined ? {} : { redeemed }) });
      if (role !== "unpaired") {
        const messages = host.recent(ACCOUNT, senderId, senderId, 50);
        if (messages.length > 0) this.out(c, { t: "history", messages });
      }
      return;
    }

    if (!c.senderId) return void c.ws.close(1008, "say hello first");

    if (f.t === "file") return this.onFile(c, f);

    // f.t === "message"
    if (f.text.trim() === "" && !(f.files && f.files.length > 0)) return void c.ws.close(1008, "bad frame");
    const t = this.now();
    c.tokens = Math.min(10, c.tokens + ((t - c.at) / 1000) * 5);
    c.at = t;
    if (c.tokens < 1) return this.out(c, { t: "ack", id: f.id, status: "limited" });
    c.tokens -= 1;
    // Files named by the message must be complete uploads of this connection; they are used once.
    const attachments: Array<{ name: string; bytes: number; data: string }> = [];
    for (const up of new Set(f.files ?? [])) {
      const u = c.uploads.get(up);
      if (!u?.done) return this.out(c, { t: "ack", id: f.id, status: "ignored" });
      attachments.push({ name: u.name, bytes: u.bytes, data: Buffer.concat(u.chunks).toString("base64") });
      c.uploads.delete(up);
    }
    const outcome = await host.deliver({
      accountId: ACCOUNT,
      conversationId: c.senderId,
      senderId: c.senderId,
      senderDisplay: "Web visitor",
      messageId: f.id,
      text: f.text,
      ...(attachments.length ? { attachments } : {}),
      isGroup: false,
      mentionsBot: true,
      ts: t,
    });
    this.out(c, { t: "ack", id: f.id, status: outcome.result, role: this.o.principalOf(c.senderId) });
  }

  /** One piece of a file. Only paired visitors may upload, so a stranger never makes the Gateway hold a byte. */
  private onFile(c: Conn, f: z.infer<typeof fileFrame>): void {
    const fail = (status: string): void => {
      c.uploads.delete(f.up);
      this.out(c, { t: "file", up: f.up, status });
    };
    if (!c.senderId || this.o.principalOf(c.senderId) === "unpaired") return fail("not_paired");
    let u = c.uploads.get(f.up);
    if (!u) {
      if (f.seq !== 0) return fail("bad_order");
      if (c.uploads.size >= UPLOAD.open) return fail("too_many");
      u = { name: f.name, chunks: [], bytes: 0, next: 0, done: false };
      c.uploads.set(f.up, u);
    }
    if (u.done || f.seq !== u.next) return fail("bad_order");
    if (!BASE64.test(f.data) || f.data.length % 4 !== 0) return fail("damaged");
    const piece = Buffer.from(f.data, "base64");
    if (piece.length > UPLOAD.chunkBytes) return fail("too_large");
    let pending = 0;
    for (const x of c.uploads.values()) pending += x.bytes;
    if (u.bytes + piece.length > UPLOAD.fileBytes || pending + piece.length > UPLOAD.pendingBytes) return fail("too_large");
    if (c.uploaded + piece.length > UPLOAD.connectionBytes) return fail("limited");
    c.uploaded += piece.length;
    u.chunks.push(piece);
    u.bytes += piece.length;
    u.next++;
    if (f.last) {
      if (u.bytes === 0) return fail("empty");
      u.done = true;
      this.out(c, { t: "file", up: f.up, status: "ready" });
    }
  }

  // ---------------- outbound ----------------

  async send(target: SendTarget, content: OutboundContent): Promise<SendResult> {
    for (const c of this.bySender.get(target.conversationId) ?? []) this.out(c, { t: "message", from: "assistant", text: content.text, ts: this.now(), ...(content.files?.length ? { files: content.files } : {}) });
    return {};
  }

  async typing(target: SendTarget, on: boolean): Promise<void> {
    for (const c of this.bySender.get(target.conversationId) ?? []) this.out(c, { t: "typing", on });
  }

  /** How many browsers are connected (for status displays and tests). */
  get connections(): number {
    return this.conns.size;
  }
}
