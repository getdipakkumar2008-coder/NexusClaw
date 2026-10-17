import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFORMANCE_LIMITS, createBed, defineConformance, waitFor, type Bed, type ConformanceBed, type ConformanceSetup } from "@clawnexus/channels";
import { PluginHost, type SecretStore } from "./host.js";

vi.setConfig({ testTimeout: 30_000 });

const PLUGIN = fileURLToPath(new URL("../../../extensions/slack", import.meta.url));
const BOT_TOKEN = "xoxb-1111111111-2222222222-fakeBotTokenABCDEFGH";
const APP_TOKEN = "xapp-1-A111-3333333333-fakeAppTokenABCDEFGHIJKLMNOP";
const BOT = "UBOT0001";

interface Sent {
  channel: string;
  text: string;
  thread_ts?: string;
  link_names?: boolean;
  mrkdwn?: boolean;
}

/** Just enough of Slack's Web API and Socket Mode to run the plugin against, plus ways to misbehave. */
class FakeSlack {
  readonly server: Server;
  readonly sockets = new WebSocketServer({ noServer: true });
  readonly sent: Sent[] = [];
  readonly auths: Array<string | undefined> = [];
  readonly acked = new Set<string>();
  readonly files = new Map<string, Buffer>();
  readonly fileGets: Array<{ url: string; auth: string | undefined }> = [];
  /** The three steps of an upload: the form that asked for an address, the bytes that went there, and the final call. */
  readonly slots: Array<{ form: Record<string, string>; auth: string | undefined }> = [];
  readonly puts: Array<{ url: string; auth: string | undefined; type: string | undefined; data: Buffer }> = [];
  readonly completes: Array<Record<string, unknown>> = [];
  /** Where the next upload address points; the default is this server. */
  uploadBase: string | undefined;
  opens = 0;
  connections = 0;
  validBot = BOT_TOKEN;
  validApp = APP_TOKEN;
  failSends = 0;
  rateLimitOnce = false;
  socketUrlOverride: string | undefined;
  private live = new Set<WebSocket>();
  private pending = new Map<string, unknown>(); // envelopes not yet acknowledged
  private nextEnvelope = 1;
  private nextTs = 1_700_000_000;
  port = 0;

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.on("upgrade", (req, socket, head) => this.sockets.handleUpgrade(req, socket, head, (ws) => this.socket(ws)));
  }

  async listen(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as { port: number }).port;
  }
  get base(): string {
    return `http://127.0.0.1:${this.port}`;
  }
  async close(): Promise<void> {
    for (const ws of this.live) ws.terminate();
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
  ts(): string {
    return `${this.nextTs++}.000100`;
  }

  /** Slack sends an event; it is resent on the next connection until the plugin acknowledges it. */
  event(event: Record<string, unknown>): void {
    const id = `env-${this.nextEnvelope++}`;
    const envelope = { type: "events_api", envelope_id: id, accepts_response_payload: false, payload: { event_id: id, event: { ts: this.ts(), ...event } } };
    this.pending.set(id, envelope);
    for (const ws of this.live) ws.send(JSON.stringify(envelope));
  }
  /** Slack asks the plugin to reconnect. */
  disconnect(reason = "refresh_requested"): void {
    for (const ws of this.live) ws.send(JSON.stringify({ type: "disconnect", reason }));
  }
  drop(): void {
    for (const ws of this.live) ws.terminate();
  }

  private socket(ws: WebSocket): void {
    this.connections++;
    this.live.add(ws);
    ws.on("close", () => this.live.delete(ws));
    ws.send(JSON.stringify({ type: "hello", num_connections: 1 }));
    for (const envelope of this.pending.values()) ws.send(JSON.stringify(envelope));
    ws.on("message", (raw) => {
      const p = JSON.parse(String(raw)) as { envelope_id?: string };
      if (p.envelope_id) {
        this.acked.add(p.envelope_id);
        this.pending.delete(p.envelope_id);
      }
    });
  }

  private reply(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const bytes = Buffer.concat(chunks);
    const raw = bytes.toString("utf8");
    const type = String(req.headers["content-type"] ?? "");
    const isForm = type.startsWith("application/x-www-form-urlencoded");
    const body = raw && type.includes("json") ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const auth = req.headers["authorization"];
    if (req.method === "POST" && (req.url ?? "").startsWith("/upload/")) {
      this.puts.push({ url: req.url!, auth, type: req.headers["content-type"], data: bytes });
      res.writeHead(200);
      return void res.end("OK");
    }
    if (req.method === "GET" && (req.url ?? "").startsWith("/files/")) {
      // Slack's private file URLs need the bot token; record what was presented.
      this.fileGets.push({ url: req.url!, auth });
      const bytes = auth === `Bearer ${this.validBot}` ? this.files.get(req.url!.slice(7)) : undefined;
      res.writeHead(bytes ? 200 : 404);
      return void res.end(bytes ?? "not found");
    }
    this.auths.push(auth);
    const method = (req.url ?? "").replace(/^\//, "");
    if (method === "apps.connections.open") {
      this.opens++;
      if (auth !== `Bearer ${this.validApp}`) return this.reply(res, 200, { ok: false, error: "invalid_auth" });
      return this.reply(res, 200, { ok: true, url: this.socketUrlOverride ?? `ws://127.0.0.1:${this.port}/link` });
    }
    if (auth !== `Bearer ${this.validBot}`) return this.reply(res, 200, { ok: false, error: "invalid_auth" });
    if (method === "auth.test") return this.reply(res, 200, { ok: true, user_id: BOT, user: "fakebot", team: "T1" });
    if (method === "files.getUploadURLExternal") {
      this.slots.push({ form: isForm ? Object.fromEntries(new URLSearchParams(raw)) : {}, auth });
      return this.reply(res, 200, { ok: true, upload_url: `${this.uploadBase ?? this.base}/upload/F${this.slots.length}`, file_id: `F${this.slots.length}` });
    }
    if (method === "files.completeUploadExternal") {
      this.completes.push(body);
      return this.reply(res, 200, { ok: true, files: [{ id: (body["files"] as Array<{ id: string }>)[0]!.id }] });
    }
    if (method === "chat.postMessage") {
      if (this.rateLimitOnce) {
        this.rateLimitOnce = false;
        return this.reply(res, 429, { ok: false, error: "ratelimited" }, { "retry-after": "1" });
      }
      if (this.failSends > 0) {
        this.failSends--;
        return this.reply(res, 500, { ok: false, error: "internal_error" });
      }
      this.sent.push({
        channel: body["channel"] as string,
        text: body["text"] as string,
        ...(body["thread_ts"] ? { thread_ts: body["thread_ts"] as string } : {}),
        link_names: body["link_names"] as boolean,
        mrkdwn: body["mrkdwn"] as boolean,
      });
      return this.reply(res, 200, { ok: true, ts: this.ts() });
    }
    return this.reply(res, 200, { ok: false, error: "unknown_method" });
  }
}

function memoryStore(): SecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  const hide = (t: string): string => [...data.entries()].reduce((acc, [n, v]) => (v.length >= 6 ? acc.split(v).join(`[REDACTED:${n}]`) : acc), t);
  return { data, get: (n) => data.get(n), set: (n, v) => void data.set(n, v), delete: (n) => data.delete(n), list: () => [...data.keys()], redact: { redact: hide, redactDeep: <T>(v: T): T => JSON.parse(hide(JSON.stringify(v))) as T } };
}

let base: string;
let fake: FakeSlack;
const open: Array<() => Promise<void>> = [];

async function rig(setup?: ConformanceSetup, o: { configure?: boolean } = {}): Promise<{ bed: Bed; host: PluginHost; store: ReturnType<typeof memoryStore> }> {
  const bed = await createBed({
    adapters: [],
    ...(setup?.noProvider ? { provider: null } : {}),
    manager: { senderBurst: CONFORMANCE_LIMITS.senderBurst, senderPerMinute: CONFORMANCE_LIMITS.senderPerMinute },
  });
  const { ToolExecutor, WorkspaceGuard } = await import("@clawnexus/tools");
  const { ApprovalStore } = await import("@clawnexus/policy");
  const store = memoryStore();
  const host = new PluginHost({
    dataDir: base,
    db: bed.db,
    events: bed.events,
    tools: new ToolExecutor({ events: bed.events, approvals: new ApprovalStore(), guard: new WorkspaceGuard([base]), tools: [] }),
    secrets: store,
    channels: { attach: (a) => bed.manager.attach(a), detach: (id) => bed.manager.detach(id) },
    startTimeoutMs: 15_000,
    graceMs: 300,
    restart: { baseMs: 20, maxRestarts: 3, windowMs: 60_000 },
  });
  open.push(async () => {
    await host.stop();
    await bed.teardown();
  });
  await host.install(PLUGIN);
  await host.enable("slack", host.info("slack").approvalToken!);
  if (o.configure !== false) {
    await host.setConfig("slack", { apiBase: fake.base });
    await host.setSecret("slack", "bot_token", BOT_TOKEN);
    await host.setSecret("slack", "app_token", APP_TOKEN);
  }
  return { bed, host, store };
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "cn-sl-"));
  fake = new FakeSlack();
  await fake.listen();
});
afterEach(async () => {
  for (const close of open.splice(0)) await close();
  await fake.close();
  rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const channelInfo = (bed: Bed) => bed.manager.list().find((c) => c.id === "slack")?.status;
const channelState = (bed: Bed): string | undefined => channelInfo(bed)?.state;
const userId = (n: number): string => `U${String(n).padStart(8, "0")}`;

async function slackBed(setup?: ConformanceSetup): Promise<ConformanceBed> {
  const r = await rig(setup);
  await waitFor(() => channelState(r.bed) === "connected", 10_000);
  const people = new Map<string, string>();
  const channels = new Map<string, string>();
  const stamps = new Map<string, string>();
  const who = (name: string): string => people.get(name) ?? (people.set(name, userId(people.size + 1)), people.get(name)!);
  const channelOf = (key: string, prefix: string): string => channels.get(key) ?? (channels.set(key, `${prefix}${String(channels.size).padStart(6, "0")}`), channels.get(key)!);
  const stampOf = (key: string): string => stamps.get(key) ?? (stamps.set(key, `1600000000.${String(stamps.size).padStart(6, "0")}`), stamps.get(key)!);
  return {
    bed: r.bed,
    channelId: "slack",
    maxTextChars: 3000,
    groupsSupported: true,
    user: (name) => {
      const me = who(name);
      const dm = channelOf(`dm:${name}`, "D");
      return {
        senderId: me,
        conversationId: dm,
        async say(text, o = {}) {
          const group = o.isGroup === true;
          if (group && o.mentionsBot === false) {
            // Slack never tells the bot about channel chatter it was not mentioned in (no such event is subscribed to).
            await new Promise((res) => setTimeout(res, 40));
            return;
          }
          const channel = group ? channelOf(`group:${o.groupId ?? "group-1"}`, "C") : dm;
          fake.event({
            type: group ? "app_mention" : "message",
            ...(group ? {} : { channel_type: "im" }),
            ts: stampOf(`${channel}/${o.messageId ?? Math.random()}`),
            channel,
            user: me,
            text: group ? `<@${BOT}> ${text}` : text,
          });
          await new Promise((res) => setTimeout(res, 40));
        },
        received: () => fake.sent.filter((s) => s.channel === dm).map((s) => s.text),
      };
    },
    failSends: (n) => {
      fake.failSends = n;
    },
    async teardown() {
      /* the rig closes everything afterwards */
    },
  };
}

defineConformance({ describe, it, expect }, "Slack plugin against a fake Slack", slackBed);

describe("the Slack plugin", () => {
  it("waits for both tokens, then connects", async () => {
    const r = await rig(undefined, { configure: false });
    expect(r.host.info("slack")).toMatchObject({ status: "needs_config", missing: ["secret bot_token", "secret app_token"] });
    await r.host.setConfig("slack", { apiBase: fake.base });
    await r.host.setSecret("slack", "bot_token", BOT_TOKEN);
    await new Promise((res) => setTimeout(res, 300));
    expect(fake.auths).toHaveLength(0); // one token is not enough to start
    await r.host.setSecret("slack", "app_token", APP_TOKEN);
    await waitFor(() => channelState(r.bed) === "connected", 10_000);
    expect(channelInfo(r.bed)?.detail).toBe("@fakebot");
  });

  it("says a token was rejected, rather than retrying forever", async () => {
    fake.validApp = "somebody-else";
    const r = await rig();
    await waitFor(() => channelState(r.bed) === "auth_required", 10_000);
    const before = fake.opens;
    await new Promise((res) => setTimeout(res, 800));
    expect(fake.opens).toBe(before);

    fake.validApp = APP_TOKEN;
    fake.validBot = "somebody-else";
    await r.host.setSecret("slack", "app_token", APP_TOKEN); // any change restarts the plugin
    await waitFor(() => channelState(r.bed) === "auth_required", 10_000);
    expect(fake.connections).toBe(0);
  });

  it("sends each token only to the Slack address, and never writes either to the log", async () => {
    const r = await rig();
    await waitFor(() => channelState(r.bed) === "connected", 10_000);
    r.bed.pairing.registerOwner({ channel: "slack", accountId: "default", externalId: userId(50) });
    fake.event({ type: "message", channel_type: "im", channel: "D500", user: userId(50), text: "hello" });
    await waitFor(() => fake.sent.some((s) => s.text.includes("echo: hello")));
    expect(new Set(fake.auths)).toEqual(new Set([`Bearer ${BOT_TOKEN}`, `Bearer ${APP_TOKEN}`]));
    const log = JSON.stringify(r.bed.events.readSince(0, { limit: 5000 }));
    expect(log).not.toContain(BOT_TOKEN);
    expect(log).not.toContain(APP_TOKEN);
    expect(JSON.stringify(r.host.info("slack"))).not.toContain(APP_TOKEN);
  });

  it("refuses to send tokens over plain http to another machine, or to connect to an unencrypted socket", async () => {
    const r = await rig(undefined, { configure: false });
    await r.host.setConfig("slack", { apiBase: "http://slack.example.com/api" });
    await r.host.setSecret("slack", "bot_token", BOT_TOKEN);
    await r.host.setSecret("slack", "app_token", APP_TOKEN);
    await waitFor(() => channelState(r.bed) === "degraded", 10_000);
    expect(fake.auths).toHaveLength(0);
  });

  it("refuses an unencrypted socket address from Slack", async () => {
    fake.socketUrlOverride = "ws://socket.example.com/link";
    const r = await rig();
    await waitFor(() => channelState(r.bed) === "degraded" || fake.opens > 0, 10_000);
    await new Promise((res) => setTimeout(res, 400));
    expect(fake.connections).toBe(0);
  });

  it("reconnects when Slack asks, and a message it never acknowledged arrives once", async () => {
    const r = await rig();
    await waitFor(() => channelState(r.bed) === "connected", 10_000);
    r.bed.pairing.registerOwner({ channel: "slack", accountId: "default", externalId: userId(51) });
    fake.disconnect();
    await waitFor(() => fake.connections >= 2, 10_000);
    fake.event({ type: "message", channel_type: "im", channel: "D510", user: userId(51), text: "after refresh" });
    await waitFor(() => fake.sent.some((s) => s.text.includes("echo: after refresh")));
    expect(fake.opens).toBeGreaterThanOrEqual(2); // each connection needs a fresh address
    expect(fake.sent.filter((s) => s.text.includes("after refresh"))).toHaveLength(1);
  });

  it("recovers from a dropped connection and does not process a resent event twice", async () => {
    const r = await rig();
    await waitFor(() => channelState(r.bed) === "connected", 10_000);
    r.bed.pairing.registerOwner({ channel: "slack", accountId: "default", externalId: userId(52) });
    fake.event({ type: "message", channel_type: "im", channel: "D520", ts: "1600000001.000001", user: userId(52), text: "once only" });
    await waitFor(() => fake.sent.length === 1);
    // Slack resends an event whose acknowledgement it never saw
    const resent = { type: "events_api", envelope_id: "env-resend", payload: { event: { type: "message", channel_type: "im", channel: "D520", ts: "1600000001.000001", user: userId(52), text: "once only" } } };
    fake.drop();
    await waitFor(() => channelState(r.bed) === "connected" && fake.connections >= 2, 20_000);
    (fake as unknown as { pending: Map<string, unknown> }).pending.set("env-resend", resent);
    fake.drop();
    await waitFor(() => fake.acked.has("env-resend"), 20_000);
    await new Promise((res) => setTimeout(res, 400));
    expect(fake.sent).toHaveLength(1);
  });

  it("answers channel mentions in a thread, never lets a reply mention or link anyone, and ignores chatter", async () => {
    const r = await rig();
    await waitFor(() => channelState(r.bed) === "connected", 10_000);
    const ann = userId(53);
    r.bed.pairing.registerOwner({ channel: "slack", accountId: "default", externalId: ann });
    // plain channel messages are not an event the plugin uses
    fake.event({ type: "message", channel_type: "channel", channel: "C700", user: ann, text: "just chatting" });
    fake.event({ type: "app_mention", channel: "C700", ts: "1600000002.000002", user: ann, text: `hey <@${BOT}> say <!channel> &amp; <https://evil.example|click>` });
    await waitFor(() => fake.sent.length >= 1);
    await new Promise((res) => setTimeout(res, 300));
    expect(r.bed.provider?.calls).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({ channel: "C700", thread_ts: "1600000002.000002", link_names: false, mrkdwn: false });
    // the assistant saw plain text (its echo shows the link as words and the entities undone), and what we send back is escaped
    expect(fake.sent[0]?.text).toContain("echo: hey say &lt;!channel&gt; &amp; click (https://evil.example)");
    expect(fake.sent[0]?.text).not.toContain("<!channel>");
    expect(fake.sent[0]?.text).not.toContain("<https");
  });

  it("keeps a conversation inside an existing thread", async () => {
    const r = await rig();
    await waitFor(() => channelState(r.bed) === "connected", 10_000);
    const ann = userId(54);
    r.bed.pairing.registerOwner({ channel: "slack", accountId: "default", externalId: ann });
    fake.event({ type: "app_mention", channel: "C710", ts: "1600000003.000003", thread_ts: "1600000000.000009", user: ann, text: `<@${BOT}> in a thread` });
    await waitFor(() => fake.sent.length === 1);
    expect(fake.sent[0]?.thread_ts).toBe("1600000000.000009");
  });

  it("does not thread direct messages", async () => {
    const r = await rig();
    await waitFor(() => channelState(r.bed) === "connected", 10_000);
    r.bed.pairing.registerOwner({ channel: "slack", accountId: "default", externalId: userId(55) });
    fake.event({ type: "message", channel_type: "im", channel: "D720", user: userId(55), text: "private" });
    await waitFor(() => fake.sent.length === 1);
    expect(fake.sent[0]?.thread_ts).toBeUndefined();
  });

  it("ignores bots, edits, deletions and the bot's own messages, and notes files instead of fetching them", async () => {
    const r = await rig();
    await waitFor(() => channelState(r.bed) === "connected", 10_000);
    const di = userId(56);
    r.bed.pairing.registerOwner({ channel: "slack", accountId: "default", externalId: di });
    const dm = { type: "message", channel_type: "im", channel: "D730" };
    fake.event({ ...dm, bot_id: "B1", user: "UOTHER", text: "I am a bot" });
    fake.event({ ...dm, user: BOT, text: "my own echo" });
    fake.event({ ...dm, user: di, subtype: "message_changed", text: "edited" });
    fake.event({ ...dm, user: di, subtype: "message_deleted", text: "gone" });
    fake.event({ ...dm, user: di, text: "", files: [{ name: "a.png" }], subtype: "file_share" });
    fake.event({ ...dm, user: di, text: "what is this?", files: [{ name: "b.png", url_private: "https://files.example/b.png" }], subtype: "file_share" });
    await waitFor(() => fake.sent.some((s) => s.text.includes("echo: what is this?")));
    expect(fake.sent.every((s) => s.channel === "D730")).toBe(true);
    expect(r.bed.provider?.calls).toHaveLength(1);
  });

  describe("files", () => {
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("....IHDR slack picture")]);
    const who = userId(58);
    async function ready(): Promise<Awaited<ReturnType<typeof rig>>> {
      const r = await rig();
      await waitFor(() => channelState(r.bed) === "connected", 10_000);
      r.bed.pairing.registerOwner({ channel: "slack", accountId: "default", externalId: who });
      return r;
    }
    const dm = { type: "message", channel_type: "im", channel: "D750", user: who, subtype: "file_share" };

    it("downloads a private file with the bot token, and the assistant gets it", async () => {
      const r = await ready();
      fake.files.set("pic.png", PNG);
      fake.event({ ...dm, text: "what is this?", files: [{ name: "pic.png", mimetype: "application/zip", size: PNG.length, url_private_download: `${fake.base}/files/pic.png` }] });
      await waitFor(() => r.bed.provider?.calls.length === 1);
      const att = r.bed.provider!.calls[0]!.attachments!;
      expect(att[0]).toMatchObject({ name: "pic.png", mime: "image/png" });
      expect(att[0]!.read()).toEqual(PNG);
      expect(fake.fileGets).toEqual([{ url: "/files/pic.png", auth: `Bearer ${BOT_TOKEN}` }]);
    });

    describe("sending a file out", () => {
      async function talking(): Promise<{ r: Awaited<ReturnType<typeof rig>>; session: string }> {
        const r = await ready();
        fake.event({ ...dm, subtype: undefined, text: "hello" });
        await waitFor(() => fake.sent.some((s) => s.text.includes("echo: hello")));
        return { r, session: r.bed.sessions!.list()[0]!.id };
      }
      const stored = (r: Awaited<ReturnType<typeof rig>>, data: Buffer, mime: string, name: string) => ({ ...r.bed.blobs.put(data, mime), name, mime, bytes: data.length });

      it("asks for an address, sends the bytes there, then shares the file into the conversation", async () => {
        const { r, session } = await talking();
        r.bed.manager.sendFile(session, stored(r, PNG, "image/png", "chart.png"), "here <you> go");
        await waitFor(() => fake.completes.length === 1);
        expect(fake.slots[0]).toEqual({ form: { filename: "chart.png", length: String(PNG.length) }, auth: `Bearer ${BOT_TOKEN}` });
        expect(fake.puts).toHaveLength(1);
        expect(fake.puts[0]!.data).toEqual(PNG);
        expect(fake.puts[0]!.auth).toBeUndefined(); // the bot token goes to the API, not to the upload address
        expect(fake.completes[0]).toMatchObject({ files: [{ id: "F1", title: "chart.png" }], channel_id: "D750", initial_comment: "here &lt;you&gt; go" });
      });

      it("will not upload to an address that is not Slack's, and never sends the token or the file there", async () => {
        const { r, session } = await talking();
        const seen: Array<string | undefined> = [];
        const evil = createServer((req, res) => (seen.push(req.headers["authorization"]), res.writeHead(200).end("x")));
        await new Promise<void>((resolve) => evil.listen(0, "127.0.0.1", resolve));
        try {
          fake.uploadBase = `http://127.0.0.1:${(evil.address() as { port: number }).port}`;
          r.bed.manager.sendFile(session, stored(r, PNG, "image/png", "chart.png"));
          await waitFor(() => fake.slots.length >= 1);
          await new Promise((resolve) => setTimeout(resolve, 300));
          expect(seen).toEqual([]);
          expect(fake.completes).toEqual([]);
        } finally {
          evil.closeAllConnections();
          await new Promise<void>((resolve) => evil.close(() => resolve()));
        }
      });
    });

    it("never sends the bot token to an address that is not Slack's, however a file is described", async () => {
      const r = await ready();
      // a second server standing in for an attacker's host: it must see no request at all
      const seen: Array<string | undefined> = [];
      const evil = createServer((req, res) => (seen.push(req.headers["authorization"]), res.writeHead(200).end("x")));
      await new Promise<void>((resolve) => evil.listen(0, "127.0.0.1", resolve));
      const evilBase = `http://127.0.0.1:${(evil.address() as { port: number }).port}`;
      try {
        fake.event({
          ...dm,
          text: "look",
          files: [
            { name: "a.png", size: 5, url_private: `${evilBase}/a.png` },
            { name: "b.png", size: 5, url_private_download: "https://files.slack.com.evil.example/b.png" },
            { name: "c.png", size: 5, url_private: "file:///etc/passwd" },
          ],
        });
        await waitFor(() => r.bed.provider?.calls.length === 1);
        await new Promise((res) => setTimeout(res, 200));
        expect(seen).toEqual([]);
        expect(fake.fileGets).toEqual([]);
        expect(r.bed.provider!.calls[0]!.messages.at(-1)!.attachments!.every((x) => x.id === undefined)).toBe(true);
      } finally {
        evil.closeAllConnections();
        await new Promise<void>((resolve) => evil.close(() => resolve()));
      }
    });

    it("answers a file with no words, and notes one it could not get", async () => {
      const r = await ready();
      fake.files.set("only.png", PNG);
      fake.event({ ...dm, text: "", files: [{ name: "only.png", size: PNG.length, url_private_download: `${fake.base}/files/only.png` }, { name: "missing.png", size: 5, url_private_download: `${fake.base}/files/missing.png` }] });
      await waitFor(() => r.bed.provider?.calls.length === 1);
      const refs = r.bed.provider!.calls[0]!.messages.at(-1)!.attachments!;
      expect(refs.map((x) => (x.id ? "kept" : "dropped"))).toEqual(["kept", "dropped"]);
    });
  });

  it("waits out Slack's rate limit once instead of dropping the reply", async () => {
    const r = await rig();
    await waitFor(() => channelState(r.bed) === "connected", 10_000);
    r.bed.pairing.registerOwner({ channel: "slack", accountId: "default", externalId: userId(57) });
    fake.rateLimitOnce = true;
    fake.event({ type: "message", channel_type: "im", channel: "D740", user: userId(57), text: "slowly" });
    await waitFor(() => fake.sent.some((s) => s.text.includes("echo: slowly")), 15_000);
  });

  it("is withdrawn on disable and does not reconnect", async () => {
    const r = await rig();
    await waitFor(() => channelState(r.bed) === "connected", 10_000);
    await r.host.disable("slack");
    expect(channelState(r.bed)).toBeUndefined();
    await new Promise((res) => setTimeout(res, 800));
    const settled = fake.connections;
    await new Promise((res) => setTimeout(res, 1500));
    expect(fake.connections).toBe(settled);
  });
});
