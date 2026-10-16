import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFORMANCE_LIMITS, createBed, defineConformance, waitFor, type Bed, type ConformanceBed, type ConformanceSetup } from "@clawnexus/channels";
import { PluginHost, type SecretStore } from "./host.js";

vi.setConfig({ testTimeout: 30_000 });

const PLUGIN = fileURLToPath(new URL("../../../extensions/telegram", import.meta.url));
const TOKEN = "123456789:AAFake-token_ABCDEFGHIJKLMNOPQRSTUVWXYZ0";
const BOT = { id: 999, is_bot: true, username: "fakebot" };

interface Update {
  update_id: number;
  message?: Record<string, unknown>;
}

/** Just enough of the Telegram Bot API to run the plugin against: the methods it calls, plus ways to misbehave. */
class FakeTelegram {
  readonly server: Server;
  readonly sent: Array<{ chat_id: number; text: string; reply_parameters?: { message_id: number } }> = [];
  readonly calls: Array<{ method: string; token: string; body: Record<string, unknown> }> = [];
  readonly actions: number[] = [];
  private queue: Update[] = [];
  private waiters: Array<() => void> = [];
  private nextUpdate = 1;
  private nextMessage = 5000;
  validToken = TOKEN;
  failSends = 0;
  rateLimitOnce = false;
  conflict = false;
  confirmedUpTo = 0;
  port = 0;

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  async listen(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as { port: number }).port;
  }
  get base(): string {
    return `http://127.0.0.1:${this.port}`;
  }
  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** A person sends the bot a message. */
  push(message: Record<string, unknown>): void {
    this.queue.push({ update_id: this.nextUpdate++, message: { message_id: this.nextMessage++, date: 1_700_000_000, ...message } });
    for (const w of this.waiters.splice(0)) w();
  }

  private reply(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw = "";
    for await (const c of req) raw += c as string;
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? "");
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (!m) return this.reply(res, 404, { ok: false, error_code: 404, description: "Not Found" });
    const [, token, method] = m as unknown as [string, string, string];
    this.calls.push({ method, token, body });
    if (token !== this.validToken) return this.reply(res, 401, { ok: false, error_code: 401, description: "Unauthorized" });
    switch (method) {
      case "getMe":
        return this.reply(res, 200, { ok: true, result: BOT });
      case "deleteWebhook":
        return this.reply(res, 200, { ok: true, result: true });
      case "getUpdates": {
        if (this.conflict) return this.reply(res, 409, { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" });
        const offset = Number(body["offset"] ?? 0);
        this.confirmedUpTo = Math.max(this.confirmedUpTo, offset);
        this.queue = this.queue.filter((u) => u.update_id >= offset);
        if (this.queue.length === 0) {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 600);
            this.waiters.push(() => (clearTimeout(t), resolve()));
            res.on("close", resolve);
          });
        }
        if (res.destroyed) return;
        return this.reply(res, 200, { ok: true, result: this.queue.filter((u) => u.update_id >= offset) });
      }
      case "sendMessage": {
        if (this.rateLimitOnce) {
          this.rateLimitOnce = false;
          return this.reply(res, 429, { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 1 } });
        }
        if (this.failSends > 0) {
          this.failSends--;
          return this.reply(res, 500, { ok: false, error_code: 500, description: "Internal Server Error" });
        }
        this.sent.push({ chat_id: body["chat_id"] as number, text: body["text"] as string, ...(body["reply_parameters"] ? { reply_parameters: body["reply_parameters"] as { message_id: number } } : {}) });
        return this.reply(res, 200, { ok: true, result: { message_id: this.nextMessage++ } });
      }
      case "sendChatAction":
        this.actions.push(body["chat_id"] as number);
        return this.reply(res, 200, { ok: true, result: true });
      default:
        return this.reply(res, 404, { ok: false, error_code: 404, description: "Not Found" });
    }
  }
}

function memoryStore(): SecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  const hide = (t: string): string => [...data.entries()].reduce((acc, [n, v]) => (v.length >= 6 ? acc.split(v).join(`[REDACTED:${n}]`) : acc), t);
  return { data, get: (n) => data.get(n), set: (n, v) => void data.set(n, v), delete: (n) => data.delete(n), list: () => [...data.keys()], redact: { redact: hide, redactDeep: <T>(v: T): T => JSON.parse(hide(JSON.stringify(v))) as T } };
}

let base: string;
let fake: FakeTelegram;
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
  await host.enable("telegram", host.info("telegram").approvalToken!);
  if (o.configure !== false) {
    await host.setConfig("telegram", { apiBase: fake.base, pollSeconds: 1 });
    await host.setSecret("telegram", "bot_token", TOKEN);
  }
  return { bed, host, store };
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "cn-tg-"));
  fake = new FakeTelegram();
  await fake.listen();
});
afterEach(async () => {
  for (const close of open.splice(0)) await close();
  await fake.close();
  rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const channelState = (bed: Bed): string | undefined => bed.manager.list().find((c) => c.id === "telegram")?.status.state;

// People and messages are named in the shared suite; Telegram needs numbers, so map them consistently.
async function telegramBed(setup?: ConformanceSetup): Promise<ConformanceBed> {
  const r = await rig(setup);
  await waitFor(() => channelState(r.bed) === "connected", 10_000);
  const people = new Map<string, number>();
  const chats = new Map<string, number>();
  const messages = new Map<string, number>();
  const idOf = (name: string): number => (people.has(name) ? people.get(name)! : (people.set(name, 1000 + people.size), people.get(name)!));
  const groupOf = (name: string): number => (chats.has(name) ? chats.get(name)! : (chats.set(name, -(1_000_000 + chats.size)), chats.get(name)!));
  const numberOf = (key: string): number => (messages.has(key) ? messages.get(key)! : (messages.set(key, 100 + messages.size), messages.get(key)!));
  return {
    bed: r.bed,
    channelId: "telegram",
    maxTextChars: 4096,
    groupsSupported: true,
    user: (name) => {
      const id = idOf(name);
      return {
        senderId: String(id),
        conversationId: String(id),
        async say(text, o = {}) {
          const group = o.isGroup === true;
          const mention = group && o.mentionsBot !== false;
          const full = mention ? `@fakebot ${text}` : text;
          fake.push({
            message_id: numberOf(`${group ? o.groupId ?? "group-1" : id}/${o.messageId ?? Math.random()}`),
            from: { id, is_bot: false, first_name: name },
            chat: group ? { id: groupOf(o.groupId ?? "group-1"), type: "supergroup" } : { id, type: "private" },
            text: full,
            ...(mention ? { entities: [{ type: "mention", offset: 0, length: 8 }] } : {}),
          });
          // the shared suite expects the message to have been taken once `say` returns
          await new Promise((res) => setTimeout(res, 40));
        },
        received: () => fake.sent.filter((s) => s.chat_id === id).map((s) => s.text),
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

defineConformance({ describe, it, expect }, "Telegram plugin against a fake Bot API", telegramBed);

describe("the Telegram plugin", () => {
  it("waits for its token, then connects", async () => {
    const r = await rig(undefined, { configure: false });
    expect(r.host.info("telegram")).toMatchObject({ status: "needs_config", missing: ["secret bot_token"] });
    await r.host.setConfig("telegram", { apiBase: fake.base, pollSeconds: 1 });
    await r.host.setSecret("telegram", "bot_token", TOKEN);
    await waitFor(() => channelState(r.bed) === "connected", 10_000);
    expect(r.bed.manager.list().find((c) => c.id === "telegram")?.status.detail).toBe("@fakebot");
    expect(fake.calls.map((c) => c.method).slice(0, 2)).toEqual(["getMe", "deleteWebhook"]);
  });

  it("says the token was rejected, rather than retrying forever", async () => {
    fake.validToken = "somebody-else";
    const r = await rig();
    await waitFor(() => channelState(r.bed) === "auth_required", 10_000);
    expect(r.bed.manager.list().find((c) => c.id === "telegram")?.status.detail).toMatch(/rejected/);
    const before = fake.calls.length;
    await new Promise((res) => setTimeout(res, 800));
    expect(fake.calls.length).toBe(before);
  });

  it("only ever sends the token to the Bot API address, and never writes it to the log", async () => {
    const r = await rig();
    await waitFor(() => channelState(r.bed) === "connected", 10_000);
    r.bed.pairing.registerOwner({ channel: "telegram", accountId: "default", externalId: "42" });
    fake.push({ from: { id: 42, is_bot: false, first_name: "Ann" }, chat: { id: 42, type: "private" }, text: "hello" });
    await waitFor(() => fake.sent.some((s) => s.text.includes("echo: hello")));
    expect(new Set(fake.calls.map((c) => c.token))).toEqual(new Set([TOKEN]));
    expect(JSON.stringify(r.bed.events.readSince(0, { limit: 5000 }))).not.toContain(TOKEN);
    expect(JSON.stringify(r.host.info("telegram"))).not.toContain(TOKEN);
  });

  it("refuses to send the token over plain http to another machine", async () => {
    const r = await rig(undefined, { configure: false });
    await r.host.setConfig("telegram", { apiBase: "http://telegram.example.com", pollSeconds: 1 });
    await r.host.setSecret("telegram", "bot_token", TOKEN);
    await waitFor(() => channelState(r.bed) === "degraded", 10_000);
    expect(fake.calls).toHaveLength(0);
  });

  it("recovers from a conflict and from server errors, with the status telling the owner", async () => {
    const r = await rig();
    await waitFor(() => channelState(r.bed) === "connected", 10_000);
    fake.conflict = true;
    await waitFor(() => r.bed.manager.list().find((c) => c.id === "telegram")?.status.detail === "another program is polling this bot", 10_000);
    fake.conflict = false;
    r.bed.pairing.registerOwner({ channel: "telegram", accountId: "default", externalId: "7" });
    fake.push({ from: { id: 7, is_bot: false, first_name: "Bo" }, chat: { id: 7, type: "private" }, text: "back?" });
    await waitFor(() => fake.sent.some((s) => s.text.includes("echo: back?")), 15_000);
    expect(channelState(r.bed)).toBe("connected");
  });

  it("waits out Telegram's rate limit once instead of dropping the reply", async () => {
    const r = await rig();
    await waitFor(() => channelState(r.bed) === "connected", 10_000);
    r.bed.pairing.registerOwner({ channel: "telegram", accountId: "default", externalId: "8" });
    fake.rateLimitOnce = true;
    fake.push({ from: { id: 8, is_bot: false, first_name: "Cy" }, chat: { id: 8, type: "private" }, text: "slowly" });
    await waitFor(() => fake.sent.some((s) => s.text.includes("echo: slowly")), 15_000);
  });

  it("ignores other bots, edits and service messages, and notes media instead of fetching it", async () => {
    const r = await rig();
    await waitFor(() => channelState(r.bed) === "connected", 10_000);
    r.bed.pairing.registerOwner({ channel: "telegram", accountId: "default", externalId: "9" });
    fake.push({ from: { id: 55, is_bot: true, first_name: "Robot" }, chat: { id: 55, type: "private" }, text: "I am a bot" });
    fake.push({ from: { id: 9, is_bot: false, first_name: "Di" }, chat: { id: 9, type: "private" }, new_chat_members: [] });
    fake.push({ from: { id: 9, is_bot: false, first_name: "Di" }, chat: { id: 9, type: "private" }, photo: [{ file_id: "x" }] });
    fake.push({ from: { id: 9, is_bot: false, first_name: "Di" }, chat: { id: 9, type: "private" }, photo: [{ file_id: "y" }], caption: "what is this?" });
    await waitFor(() => fake.sent.some((s) => s.text.includes("echo: what is this?")));
    expect(fake.sent.some((s) => s.chat_id === 55)).toBe(false);
    expect(r.bed.provider?.calls).toHaveLength(1);
    expect(fake.calls.some((c) => c.method === "getFile")).toBe(false);
  });

  it("answers group messages as a reply to the asking message, and only when mentioned or replied to", async () => {
    const r = await rig();
    await waitFor(() => channelState(r.bed) === "connected", 10_000);
    r.bed.pairing.registerOwner({ channel: "telegram", accountId: "default", externalId: "10" });
    const from = { id: 10, is_bot: false, first_name: "Em" };
    fake.push({ from, chat: { id: -500, type: "group" }, text: "just chatting" });
    fake.push({ message_id: 7777, from, chat: { id: -500, type: "group" }, text: "hey @fakebot what time is it", entities: [{ type: "mention", offset: 4, length: 8 }] });
    fake.push({ from, chat: { id: -500, type: "group" }, text: "@someoneelse hi", entities: [{ type: "mention", offset: 0, length: 12 }] });
    await waitFor(() => fake.sent.length >= 1);
    await new Promise((res) => setTimeout(res, 400));
    expect(r.bed.provider?.calls).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({ chat_id: -500, reply_parameters: { message_id: 7777 } });
    // a reply to something the bot said counts as addressing it
    fake.push({ from, chat: { id: -500, type: "group" }, text: "and tomorrow?", reply_to_message: { message_id: 1, from: BOT } });
    await waitFor(() => r.bed.provider?.calls.length === 2);
  });

  it("is withdrawn on disable and does not keep polling", async () => {
    const r = await rig();
    await waitFor(() => channelState(r.bed) === "connected", 10_000);
    await r.host.disable("telegram");
    expect(channelState(r.bed)).toBeUndefined();
    await new Promise((res) => setTimeout(res, 900));
    const settled = fake.calls.length;
    await new Promise((res) => setTimeout(res, 900));
    expect(fake.calls.length).toBe(settled);
  });

  it("does not lose a message that arrives while a restart is happening", async () => {
    const r = await rig();
    await waitFor(() => channelState(r.bed) === "connected", 10_000);
    r.bed.pairing.registerOwner({ channel: "telegram", accountId: "default", externalId: "11" });
    await r.host.setConfig("telegram", { pollSeconds: 2 }); // restarts the plugin
    fake.push({ from: { id: 11, is_bot: false, first_name: "Fe" }, chat: { id: 11, type: "private" }, text: "during restart" });
    await waitFor(() => fake.sent.some((s) => s.text.includes("echo: during restart")), 15_000);
    expect(fake.sent.filter((s) => s.text.includes("echo: during restart"))).toHaveLength(1);
  });
});
