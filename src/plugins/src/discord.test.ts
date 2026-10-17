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

const PLUGIN = fileURLToPath(new URL("../../../extensions/discord", import.meta.url));
const TOKEN = "MTIzNDU2Nzg5MDEyMzQ1Njc4.Gfake1.abcdefghijklmnopqrstuvwxyz0123456789ABCD";
const BOT = { id: "900000000000000001", username: "fakebot", bot: true };

interface Sent {
  channel: string;
  content: string;
  allowed_mentions?: unknown;
  message_reference?: { message_id: string };
}

/** Just enough of Discord's REST API and Gateway to run the plugin against, plus ways to misbehave. */
class FakeDiscord {
  readonly server: Server;
  readonly sockets = new WebSocketServer({ noServer: true });
  readonly sent: Sent[] = [];
  readonly typing: string[] = [];
  readonly restAuth: Array<string | undefined> = [];
  readonly identifies: Array<Record<string, unknown>> = [];
  readonly resumes: Array<Record<string, unknown>> = [];
  readonly files = new Map<string, Buffer>();
  readonly cdnGets: Array<{ url: string; auth: string | undefined }> = [];
  connections = 0;
  validToken = TOKEN;
  failSends = 0;
  rateLimitOnce = false;
  gatewayUrlOverride: string | undefined;
  closeWith: number | undefined; // close each new connection straight away with this code
  private live = new Set<WebSocket>();
  private events: Array<{ seq: number; t: string; d: unknown }> = [];
  private seq = 0;
  private nextId = 800_000_000_000_000_000n;
  port = 0;

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.on("upgrade", (req, socket, head) => this.sockets.handleUpgrade(req, socket, head, (ws) => this.gateway(ws)));
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
  snowflake(): string {
    return String(this.nextId++);
  }

  private dispatch(t: string, d: unknown): void {
    const event = { seq: ++this.seq, t, d };
    this.events.push(event);
    for (const ws of this.live) ws.send(JSON.stringify({ op: 0, t, s: event.seq, d }));
  }
  /** A person writes a message the bot can see. */
  push(message: Record<string, unknown>): void {
    this.dispatch("MESSAGE_CREATE", { id: this.snowflake(), type: 0, timestamp: "2026-01-01T00:00:00.000Z", ...message });
  }
  /** Cut every connection without a goodbye, as a network failure would. */
  drop(): void {
    for (const ws of this.live) ws.terminate();
  }

  private gateway(ws: WebSocket): void {
    this.connections++;
    this.live.add(ws);
    ws.on("close", () => this.live.delete(ws));
    if (this.closeWith !== undefined) return ws.close(this.closeWith);
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));
    ws.on("message", (raw) => {
      const p = JSON.parse(String(raw)) as { op: number; d: Record<string, unknown> };
      if (p.op === 1) return ws.send(JSON.stringify({ op: 11 }));
      if (p.op === 2) {
        this.identifies.push(p.d);
        if (p.d["token"] !== this.validToken) return ws.close(4004, "Authentication failed");
        return ws.send(JSON.stringify({ op: 0, t: "READY", s: ++this.seq, d: { user: BOT, session_id: "sess-1", resume_gateway_url: `ws://127.0.0.1:${this.port}` } }));
      }
      if (p.op === 6) {
        this.resumes.push(p.d);
        if (p.d["token"] !== this.validToken || p.d["session_id"] !== "sess-1") return ws.send(JSON.stringify({ op: 9, d: false }));
        for (const e of this.events.filter((x) => x.seq > Number(p.d["seq"]))) ws.send(JSON.stringify({ op: 0, t: e.t, s: e.seq, d: e.d }));
        return ws.send(JSON.stringify({ op: 0, t: "RESUMED", s: ++this.seq, d: {} }));
      }
    });
  }

  private reply(res: ServerResponse, status: number, body?: unknown): void {
    if (body === undefined) {
      res.writeHead(status);
      return void res.end();
    }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw = "";
    for await (const c of req) raw += c as string;
    if (req.method === "GET" && (req.url ?? "").startsWith("/cdn/")) {
      // Discord's file hosts need no credentials; seeing one here would mean the bot token leaked to a file download.
      this.cdnGets.push({ url: req.url!, auth: req.headers["authorization"] });
      const bytes = this.files.get(req.url!.slice(5));
      res.writeHead(bytes ? 200 : 404);
      return void res.end(bytes ?? "gone");
    }
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const auth = req.headers["authorization"];
    this.restAuth.push(auth);
    if (auth !== `Bot ${this.validToken}`) return this.reply(res, 401, { message: "401: Unauthorized", code: 0 });
    if (req.method === "GET" && req.url === "/gateway/bot") return this.reply(res, 200, { url: this.gatewayUrlOverride ?? `ws://127.0.0.1:${this.port}`, shards: 1 });
    const m = /^\/channels\/([^/]+)\/(messages|typing)$/.exec(req.url ?? "");
    if (!m || req.method !== "POST") return this.reply(res, 404, { message: "Unknown", code: 0 });
    if (m[2] === "typing") {
      this.typing.push(m[1]!);
      return this.reply(res, 204);
    }
    if (this.rateLimitOnce) {
      this.rateLimitOnce = false;
      return this.reply(res, 429, { message: "You are being rate limited.", retry_after: 0.5, global: false });
    }
    if (this.failSends > 0) {
      this.failSends--;
      return this.reply(res, 500, { message: "Internal Server Error" });
    }
    this.sent.push({
      channel: m[1]!,
      content: body["content"] as string,
      allowed_mentions: body["allowed_mentions"],
      ...(body["message_reference"] ? { message_reference: body["message_reference"] as { message_id: string } } : {}),
    });
    return this.reply(res, 200, { id: this.snowflake() });
  }
}

function memoryStore(): SecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  const hide = (t: string): string => [...data.entries()].reduce((acc, [n, v]) => (v.length >= 6 ? acc.split(v).join(`[REDACTED:${n}]`) : acc), t);
  return { data, get: (n) => data.get(n), set: (n, v) => void data.set(n, v), delete: (n) => data.delete(n), list: () => [...data.keys()], redact: { redact: hide, redactDeep: <T>(v: T): T => JSON.parse(hide(JSON.stringify(v))) as T } };
}

let base: string;
let fake: FakeDiscord;
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
  await host.enable("discord", host.info("discord").approvalToken!);
  if (o.configure !== false) {
    await host.setConfig("discord", { apiBase: fake.base });
    await host.setSecret("discord", "bot_token", TOKEN);
  }
  return { bed, host, store };
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "cn-dc-"));
  fake = new FakeDiscord();
  await fake.listen();
});
afterEach(async () => {
  for (const close of open.splice(0)) await close();
  await fake.close();
  rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const channelInfo = (bed: Bed) => bed.manager.list().find((c) => c.id === "discord")?.status;
const channelState = (bed: Bed): string | undefined => channelInfo(bed)?.state;
const person = (n: number): { id: string; username: string; bot: false } => ({ id: String(700_000_000_000_000_000n + BigInt(n)), username: `user${n}`, bot: false });

async function discordBed(setup?: ConformanceSetup): Promise<ConformanceBed> {
  const r = await rig(setup);
  await waitFor(() => channelState(r.bed) === "connected", 10_000);
  const people = new Map<string, ReturnType<typeof person>>();
  const channels = new Map<string, string>();
  const messages = new Map<string, string>();
  const who = (name: string) => people.get(name) ?? (people.set(name, person(people.size + 1)), people.get(name)!);
  const channelOf = (key: string): string => channels.get(key) ?? (channels.set(key, String(600_000_000_000_000_000n + BigInt(channels.size))), channels.get(key)!);
  const idOf = (key: string): string => messages.get(key) ?? (messages.set(key, String(500_000_000_000_000_000n + BigInt(messages.size))), messages.get(key)!);
  return {
    bed: r.bed,
    channelId: "discord",
    maxTextChars: 2000,
    groupsSupported: true,
    user: (name) => {
      const me = who(name);
      const dm = channelOf(`dm:${name}`);
      return {
        senderId: me.id,
        conversationId: dm,
        async say(text, o = {}) {
          const group = o.isGroup === true;
          const mention = group && o.mentionsBot !== false;
          const channel = group ? channelOf(`group:${o.groupId ?? "group-1"}`) : dm;
          fake.push({
            id: idOf(`${channel}/${o.messageId ?? Math.random()}`),
            channel_id: channel,
            ...(group ? { guild_id: "400000000000000001" } : {}),
            author: me,
            content: mention ? `<@${BOT.id}> ${text}` : text,
            mentions: mention ? [BOT] : [],
          });
          await new Promise((res) => setTimeout(res, 40));
        },
        received: () => fake.sent.filter((s) => s.channel === dm).map((s) => s.content),
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

defineConformance({ describe, it, expect }, "Discord plugin against a fake Discord", discordBed);

describe("the Discord plugin", () => {
  it("waits for its token, then connects and asks only for the unprivileged message intents", async () => {
    const r = await rig(undefined, { configure: false });
    expect(r.host.info("discord")).toMatchObject({ status: "needs_config", missing: ["secret bot_token"] });
    await r.host.setConfig("discord", { apiBase: fake.base });
    await r.host.setSecret("discord", "bot_token", TOKEN);
    await waitFor(() => channelState(r.bed) === "connected", 10_000);
    expect(channelInfo(r.bed)?.detail).toBe("@fakebot");
    // server messages (1<<9) and direct messages (1<<12) only; the privileged message-content intent (1<<15) is not requested
    expect(fake.identifies[0]?.["intents"]).toBe((1 << 9) | (1 << 12));
  });

  it("says the token was rejected, rather than retrying forever", async () => {
    fake.validToken = "somebody-else";
    const r = await rig();
    await waitFor(() => channelState(r.bed) === "auth_required", 10_000);
    expect(channelInfo(r.bed)?.detail).toMatch(/rejected/);
    const before = fake.connections;
    await new Promise((res) => setTimeout(res, 800));
    expect(fake.connections).toBe(before);
  });

  it("says so when Discord closes the connection because the token is refused after connecting", async () => {
    const r = await rig();
    await waitFor(() => channelState(r.bed) === "connected", 10_000);
    fake.validToken = "changed-later";
    fake.drop();
    await waitFor(() => channelState(r.bed) === "auth_required", 15_000);
  });

  it("only ever sends the token to the Discord address, and never writes it to the log", async () => {
    const r = await rig();
    await waitFor(() => channelState(r.bed) === "connected", 10_000);
    r.bed.pairing.registerOwner({ channel: "discord", accountId: "default", externalId: person(1).id });
    fake.push({ channel_id: "611", author: person(1), content: "hello", mentions: [] });
    await waitFor(() => fake.sent.some((s) => s.content.includes("echo: hello")));
    expect(new Set(fake.restAuth)).toEqual(new Set([`Bot ${TOKEN}`]));
    expect(JSON.stringify(r.bed.events.readSince(0, { limit: 5000 }))).not.toContain(TOKEN);
    expect(JSON.stringify(r.host.info("discord"))).not.toContain(TOKEN);
  });

  it("refuses to send the token over plain http to another machine", async () => {
    const r = await rig(undefined, { configure: false });
    await r.host.setConfig("discord", { apiBase: "http://discord.example.com/api" });
    await r.host.setSecret("discord", "bot_token", TOKEN);
    await waitFor(() => channelState(r.bed) === "degraded", 10_000);
    expect(fake.restAuth).toHaveLength(0);
  });

  it("refuses an unencrypted gateway address from the API", async () => {
    fake.gatewayUrlOverride = "ws://gateway.example.com";
    const r = await rig();
    await waitFor(() => channelState(r.bed) === "degraded", 10_000);
    expect(fake.connections).toBe(0);
    expect(fake.identifies).toHaveLength(0);
  });

  it("resumes after a dropped connection and gets what it missed exactly once", async () => {
    const r = await rig();
    await waitFor(() => channelState(r.bed) === "connected", 10_000);
    r.bed.pairing.registerOwner({ channel: "discord", accountId: "default", externalId: person(2).id });
    fake.drop();
    fake.push({ channel_id: "612", author: person(2), content: "while you were away", mentions: [] });
    await waitFor(() => fake.sent.some((s) => s.content.includes("echo: while you were away")), 20_000);
    expect(fake.resumes).toHaveLength(1);
    expect(fake.identifies).toHaveLength(1);
    expect(fake.sent.filter((s) => s.content.includes("while you were away"))).toHaveLength(1);
    await waitFor(() => channelState(r.bed) === "connected", 10_000);
  });

  it("starts a fresh session when Discord will not resume, and reports a fatal close without retrying", async () => {
    const r = await rig();
    await waitFor(() => channelState(r.bed) === "connected", 10_000);
    fake.closeWith = 4014;
    fake.drop();
    await waitFor(() => /intent/.test(channelInfo(r.bed)?.detail ?? ""), 15_000);
    const settled = fake.connections;
    await new Promise((res) => setTimeout(res, 1500));
    expect(fake.connections).toBe(settled);
  });

  it("keeps trying while Discord is unreachable and recovers", async () => {
    const r = await rig();
    await waitFor(() => channelState(r.bed) === "connected", 10_000);
    fake.closeWith = 4000;
    fake.drop();
    await waitFor(() => channelState(r.bed) === "degraded", 10_000);
    fake.closeWith = undefined;
    await waitFor(() => channelState(r.bed) === "connected", 30_000);
  });

  it("answers server messages as a reply, never lets a reply ping anyone, and ignores unaddressed chatter", async () => {
    const r = await rig();
    await waitFor(() => channelState(r.bed) === "connected", 10_000);
    const ann = person(3);
    r.bed.pairing.registerOwner({ channel: "discord", accountId: "default", externalId: ann.id });
    fake.push({ channel_id: "700", guild_id: "g", author: ann, content: "just chatting", mentions: [] });
    fake.push({ id: "5555", channel_id: "700", guild_id: "g", author: ann, content: `hey <@!${BOT.id}> what time is it @everyone`, mentions: [BOT] });
    fake.push({ channel_id: "700", guild_id: "g", author: ann, content: "<@123> hi", mentions: [{ id: "123" }] });
    await waitFor(() => fake.sent.length >= 1);
    await new Promise((res) => setTimeout(res, 400));
    expect(r.bed.provider?.calls).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({ channel: "700", message_reference: { message_id: "5555" }, allowed_mentions: { parse: [] } });
    // the assistant is not shown its own mention
    expect(fake.sent[0]?.content).toContain("echo: hey what time is it @everyone");
    // replying to something the bot said counts as addressing it
    fake.push({ channel_id: "700", guild_id: "g", author: ann, content: "and tomorrow?", mentions: [], message_reference: { message_id: "1" }, referenced_message: { author: BOT }, type: 19 });
    await waitFor(() => r.bed.provider?.calls.length === 2);
  });

  it("does not use a reply thread in direct messages", async () => {
    const r = await rig();
    await waitFor(() => channelState(r.bed) === "connected", 10_000);
    r.bed.pairing.registerOwner({ channel: "discord", accountId: "default", externalId: person(4).id });
    fake.push({ channel_id: "710", author: person(4), content: "private", mentions: [] });
    await waitFor(() => fake.sent.length === 1);
    expect(fake.sent[0]?.message_reference).toBeUndefined();
    expect(fake.typing).toContain("710");
  });

  it("ignores other bots, webhooks and service messages, and notes attachments instead of fetching them", async () => {
    const r = await rig();
    await waitFor(() => channelState(r.bed) === "connected", 10_000);
    const di = person(5);
    r.bed.pairing.registerOwner({ channel: "discord", accountId: "default", externalId: di.id });
    fake.push({ channel_id: "720", author: { id: "55", username: "robot", bot: true }, content: "I am a bot", mentions: [] });
    fake.push({ channel_id: "720", author: di, content: "from a hook", webhook_id: "9", mentions: [] });
    fake.push({ channel_id: "720", author: di, content: "", type: 7, mentions: [] });
    fake.push({ channel_id: "720", author: di, content: "", attachments: [{ filename: "a.png" }], mentions: [] });
    fake.push({ channel_id: "720", author: di, content: "what is this?", attachments: [{ filename: "b.png", url: "https://cdn.example/b.png" }], mentions: [] });
    await waitFor(() => fake.sent.some((s) => s.content.includes("echo: what is this?")));
    expect(fake.sent.some((s) => s.channel === "55")).toBe(false);
    expect(r.bed.provider?.calls).toHaveLength(1);
  });

  describe("attachments", () => {
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("....IHDR discord picture")]);
    const who = person(8);
    async function ready(): Promise<Awaited<ReturnType<typeof rig>>> {
      const r = await rig();
      await waitFor(() => channelState(r.bed) === "connected", 10_000);
      r.bed.pairing.registerOwner({ channel: "discord", accountId: "default", externalId: who.id });
      return r;
    }

    it("downloads a file from Discord's file host and the assistant gets it, with no credentials sent to the download", async () => {
      const r = await ready();
      fake.files.set("pic.png", PNG);
      fake.push({ channel_id: "740", author: who, content: "what is this?", mentions: [], attachments: [{ filename: "pic.png", content_type: "text/html", size: PNG.length, url: `${fake.base}/cdn/pic.png` }] });
      await waitFor(() => r.bed.provider?.calls.length === 1);
      const att = r.bed.provider!.calls[0]!.attachments!;
      expect(att[0]).toMatchObject({ name: "pic.png", mime: "image/png" }); // not "text/html", whatever Discord was told
      expect(att[0]!.read()).toEqual(PNG);
      expect(fake.cdnGets).toEqual([{ url: "/cdn/pic.png", auth: undefined }]);
    });

    it("will not fetch a file from an address that is not Discord's, whatever the message says", async () => {
      const r = await ready();
      fake.push({
        channel_id: "741",
        author: who,
        content: "see these",
        mentions: [],
        attachments: [
          { filename: "a.png", size: 10, url: "http://evil.example.com/a.png" },
          { filename: "b.png", size: 10, url: "https://cdn.discordapp.com.evil.example/b.png" },
          { filename: "c.png", size: 10, url: "file:///etc/passwd" },
          { filename: "d.png", size: 10, url: "http://169.254.169.254/latest/meta-data/" },
          { filename: "e.png", size: 10, url: "not a url" },
        ],
      });
      await waitFor(() => r.bed.provider?.calls.length === 1);
      const refs = r.bed.provider!.calls[0]!.messages.at(-1)!.attachments!;
      expect(refs.every((x) => x.id === undefined && /not downloaded/.test(x.dropped ?? ""))).toBe(true);
      expect(fake.cdnGets).toEqual([]);
    });

    it("does not fetch what is declared too big, and refuses a file that turns out bigger than it said", async () => {
      const r = await ready();
      fake.files.set("big.bin", Buffer.alloc(9 * 1024 * 1024, 65));
      fake.push({ channel_id: "742", author: who, content: "big", mentions: [], attachments: [{ filename: "big.bin", size: 99 * 1024 * 1024, url: `${fake.base}/cdn/big.bin` }, { filename: "liar.txt", size: 10, url: `${fake.base}/cdn/big.bin` }] });
      await waitFor(() => r.bed.provider?.calls.length === 1);
      expect(fake.cdnGets).toHaveLength(1); // only the one that claimed to be small was tried, and it was cut off
      expect(r.bed.provider!.calls[0]!.messages.at(-1)!.attachments!.every((x) => x.id === undefined)).toBe(true);
    });

    it("answers a picture with no words", async () => {
      const r = await ready();
      fake.files.set("only.png", PNG);
      fake.push({ channel_id: "743", author: who, content: "", mentions: [], attachments: [{ filename: "only.png", size: PNG.length, url: `${fake.base}/cdn/only.png` }] });
      await waitFor(() => r.bed.provider?.calls.length === 1);
      expect(r.bed.provider!.calls[0]!.attachments).toHaveLength(1);
    });
  });

  it("waits out Discord's rate limit once instead of dropping the reply", async () => {
    const r = await rig();
    await waitFor(() => channelState(r.bed) === "connected", 10_000);
    r.bed.pairing.registerOwner({ channel: "discord", accountId: "default", externalId: person(6).id });
    fake.rateLimitOnce = true;
    fake.push({ channel_id: "730", author: person(6), content: "slowly", mentions: [] });
    await waitFor(() => fake.sent.some((s) => s.content.includes("echo: slowly")), 15_000);
  });

  it("is withdrawn on disable and does not reconnect", async () => {
    const r = await rig();
    await waitFor(() => channelState(r.bed) === "connected", 10_000);
    await r.host.disable("discord");
    expect(channelState(r.bed)).toBeUndefined();
    await new Promise((res) => setTimeout(res, 800));
    const settled = fake.connections;
    await new Promise((res) => setTimeout(res, 1500));
    expect(fake.connections).toBe(settled);
  });
});
