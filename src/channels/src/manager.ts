import { PairingError, type PairingService } from "@clawnexus/pairing";
import { ingestAttachments, safeName, DEFAULT_INGEST, type AttachmentRef, type BlobStore, type IngestLimits, type ScanFile } from "@clawnexus/blobs";
import { Outbox, type OutboxFile } from "./outbox.js";
import { SessionError, type SessionManager } from "@clawnexus/sessions";
import type { Db, EventLog, StoredEvent } from "@clawnexus/store";
import {
  ADAPTER_ID,
  DEFAULT_POLICY,
  inboundSchema,
  type ChannelAdapter,
  type ChannelCapabilities,
  type ChannelHost,
  type ChannelPolicy,
  type ChannelStatus,
  type InboundMessage,
  type InboundOutcome,
  type OutboundContent,
  type SendTarget,
} from "./types.js";

/** Why a file could not be sent; the message is written for the model and the owner. */
export class ChannelFileError extends Error {}

export interface ChannelManagerOptions {
  db: Db;
  /** Where accepted attachments are kept. Without it, files are noted and dropped. */
  blobs?: BlobStore;
  /** Limits on the files taken from one message. */
  ingest?: Partial<IngestLimits>;
  /** A check run on each accepted-looking file before it is kept (see docs/05). */
  scan?: ScanFile;
  events: EventLog;
  pairing: PairingService;
  /** Absent when no model provider is configured; paired senders then get a "not ready" notice. */
  sessions: SessionManager | undefined;
  now?: () => number;
  /** One sender may send this many messages a minute, in bursts of up to `senderBurst`. */
  senderPerMinute?: number;
  senderBurst?: number;
  /** Flood guard for one channel as a whole, whatever the senders. */
  adapterPerSecond?: number;
  adapterBurst?: number;
  /** How long platform message ids are remembered for de-duplication. */
  dedupeRetentionMs?: number;
  /** Delivery attempts for one outgoing message, with exponential backoff from `baseMs`. */
  sendRetry?: { attempts: number; baseMs: number };
  /** An adapter that takes longer than this to start or send is treated as failed. */
  adapterTimeoutMs?: number;
  /** The same notice (pairing prompt, "busy", ...) is not repeated to one sender within this time. */
  noticeCooldownMs?: number;
}

export interface ChannelInfo {
  id: string;
  status: ChannelStatus;
  capabilities: ChannelCapabilities;
  policy: ChannelPolicy;
}

interface Bucket {
  tokens: number;
  at: number;
}

interface Entry {
  adapter: ChannelAdapter;
  policy: ChannelPolicy;
  status: ChannelStatus;
  bucket: Bucket;
  host: ChannelHost;
  /** True once `start` succeeded; only then is the adapter's own status report trusted. */
  started: boolean;
  /** Set when the channel is withdrawn (its plugin stopped). Nothing more is accepted from or sent through it. */
  detached?: boolean;
}

interface Tracked {
  entry: Entry;
  target: SendTarget;
  sessionId: string;
}

const NOTICE = {
  unavailable: "This assistant is not ready yet. Please try again later.",
  busy: "I am still working on your earlier messages. Please try again in a moment.",
  tooLong: "That message is too long for me to handle.",
  failed: "Sorry, I could not answer that. Please try again.",
  interrupted: "I was restarted while answering you, so that answer was lost. Please send your message again.",
  limited: "You are sending messages too quickly. Please slow down.",
} as const;

const MAX_TRACKED_RUNS = 10_000;

const scrub = (t: string): string => t.replace(/[\w-]{24,}/g, "[redacted]").replace(/\s+/g, " ").trim().slice(0, 300);

/** Remove control characters (keeping tab and newlines) that have no business in a chat message. */
function normalizeText(text: string): string {
  let out = "";
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c === 9 || c === 10) out += ch;
    else if (c === 13) out += "\n";
    else if (c >= 32 && c !== 127 && !(c >= 0x80 && c <= 0x9f)) out += ch;
  }
  return out.replace(/\n{4,}/g, "\n\n\n").trim();
}

/** Split a long reply at paragraph, line or word boundaries so each piece fits the platform's limit. */
export function chunkText(text: string, max: number): string[] {
  const limit = Math.max(1, max);
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let cut = Math.max(rest.lastIndexOf("\n\n", limit), rest.lastIndexOf("\n", limit), rest.lastIndexOf(" ", limit));
    if (cut < limit / 2) cut = limit;
    // never split a surrogate pair
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks.filter((c) => c.length > 0);
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    t.unref();
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e: unknown) => (clearTimeout(t), reject(e instanceof Error ? e : new Error(String(e)))),
    );
  });
}

/**
 * Routes messages between channels and the assistant (docs/05). The rules that matter, all enforced here and not left
 * to adapters: nobody reaches the model without pairing; inbound text is untrusted and cannot change policy; the same
 * platform message is never processed twice; one sender or one channel cannot flood the Gateway; a group is always
 * served at guest level; and an adapter can only ever speak as itself.
 */
export class ChannelManager {
  private readonly entries = new Map<string, Entry>();
  private readonly runs = new Map<string, Tracked>();
  private readonly senderBuckets = new Map<string, Bucket>();
  private readonly noticeAt = new Map<string, number>();
  private readonly sendChains = new Map<string, Promise<void>>();
  readonly outbox: Outbox;
  private readonly pumping = new Set<string>();
  private readonly wakeups = new Map<string, NodeJS.Timeout>();
  private unsubscribe: (() => void) | undefined;
  private inserts = 0;
  private stopped = false;
  private readonly now: () => number;
  private readonly o: Required<Pick<ChannelManagerOptions, "senderPerMinute" | "senderBurst" | "adapterPerSecond" | "adapterBurst" | "dedupeRetentionMs" | "adapterTimeoutMs" | "noticeCooldownMs">> & {
    sendRetry: { attempts: number; baseMs: number };
  };

  constructor(private readonly c: ChannelManagerOptions) {
    this.now = c.now ?? Date.now;
    this.outbox = new Outbox(c.db); // real time: delivery delays are real delays, whatever clock the router is given
    this.o = {
      senderPerMinute: c.senderPerMinute ?? 20,
      senderBurst: c.senderBurst ?? 8,
      adapterPerSecond: c.adapterPerSecond ?? 50,
      adapterBurst: c.adapterBurst ?? 200,
      dedupeRetentionMs: c.dedupeRetentionMs ?? 24 * 3600_000,
      adapterTimeoutMs: c.adapterTimeoutMs ?? 30_000,
      noticeCooldownMs: c.noticeCooldownMs ?? 30_000,
      sendRetry: c.sendRetry ?? { attempts: 3, baseMs: 500 },
    };
  }

  // ---------------- lifecycle ----------------

  register(adapter: ChannelAdapter, policy: Partial<ChannelPolicy> = {}): void {
    if (!ADAPTER_ID.test(adapter.id)) throw new Error(`invalid channel id "${adapter.id}"`);
    if (this.entries.has(adapter.id)) throw new Error(`channel ${adapter.id} is already registered`);
    const entry: Entry = {
      adapter,
      policy: { ...DEFAULT_POLICY, ...policy },
      status: { state: "stopped" },
      bucket: { tokens: this.o.adapterBurst, at: this.now() },
      host: undefined as never,
      started: false,
    };
    entry.host = {
      deliver: (m) => this.handleInbound(entry, m),
      setStatus: (s) => this.setStatus(entry, s),
      recent: (accountId, conversationId, senderId, limit) => this.recent(entry, accountId, conversationId, senderId, limit),
      log: (level, message) => this.audit("channel.log", { channel: adapter.id, level, message: scrub(message) }),
    };
    this.entries.set(adapter.id, entry);
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.unsubscribe = this.c.events.subscribe((evs) => this.onEvents(evs));
    await Promise.allSettled([...this.entries.values()].map((e) => this.startEntry(e)));
    try {
      this.outbox.sweep();
      this.notifyInterrupted();
    } catch {
      /* housekeeping must not stop the router */
    }
    // Replies that were waiting when the Gateway last stopped are delivered now.
    this.resume();
  }

  private async startEntry(e: Entry): Promise<void> {
    this.setStatus(e, { state: "starting" });
    try {
      await withTimeout(e.adapter.start(e.host), this.o.adapterTimeoutMs, `starting ${e.adapter.id}`);
      if (e.detached) return;
      e.started = true;
      this.setStatus(e, this.statusOf(e));
    } catch (err) {
      this.setStatus(e, { state: "degraded", detail: scrub(err instanceof Error ? err.message : "failed to start") });
    }
  }

  /** Add a channel while the Gateway is running (a plugin came up). It is started now if the router is already running. */
  async attach(adapter: ChannelAdapter, policy: Partial<ChannelPolicy> = {}): Promise<void> {
    this.register(adapter, policy);
    if (this.unsubscribe) {
      const e = this.entries.get(adapter.id);
      if (e) await this.startEntry(e);
      // a plugin that came back up gets the replies that were waiting for it
      this.resume(adapter.id);
    }
  }

  /** Withdraw a channel (its plugin stopped or crashed). Messages in flight for it are dropped. */
  async detach(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e) return;
    e.detached = true;
    this.entries.delete(id);
    for (const [runId, t] of this.runs) if (t.entry === e) this.runs.delete(runId);
    try {
      await withTimeout(e.adapter.stop(), 5000, `stopping ${id}`);
    } catch {
      /* the plugin may already be gone */
    }
    e.started = false;
    e.status = { state: "stopped" };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.wakeups.values()) clearTimeout(t);
    this.wakeups.clear();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await Promise.allSettled(
      [...this.entries.values()].map(async (e) => {
        try {
          await withTimeout(e.adapter.stop(), 5000, `stopping ${e.adapter.id}`);
        } catch {
          /* a stuck adapter must not block shutdown */
        }
        e.started = false;
        e.status = { state: "stopped" };
      }),
    );
    this.runs.clear();
  }

  list(): ChannelInfo[] {
    return [...this.entries.values()].map((e) => ({ id: e.adapter.id, status: this.statusOf(e), capabilities: e.adapter.capabilities, policy: e.policy }));
  }

  setPolicy(id: string, policy: Partial<ChannelPolicy>): void {
    const e = this.entries.get(id);
    if (!e) throw new Error(`no channel ${id}`);
    e.policy = { ...e.policy, ...policy };
  }

  private statusOf(e: Entry): ChannelStatus {
    if (!e.started) return e.status;
    try {
      const s = e.adapter.status();
      return { state: s.state, ...(s.detail ? { detail: scrub(s.detail) } : {}) };
    } catch {
      return { state: "degraded", detail: "status unavailable" };
    }
  }

  private setStatus(e: Entry, s: ChannelStatus): void {
    const next: ChannelStatus = { state: s.state, ...(s.detail ? { detail: scrub(s.detail) } : {}) };
    if (e.status.state === next.state && e.status.detail === next.detail) return;
    e.status = next;
    this.audit("channel.status", { channel: e.adapter.id, ...next });
  }

  // ---------------- inbound ----------------

  async handleInbound(entry: Entry, raw: unknown): Promise<InboundOutcome> {
    if (this.stopped || entry.detached) return { result: "unavailable" };
    const parsed = inboundSchema.safeParse(raw);
    if (!parsed.success) return { result: "invalid", reason: parsed.error.issues[0]?.message?.slice(0, 120) ?? "invalid message" };
    // The channel is whatever adapter is delivering. Nothing in the message can choose it.
    const msg: InboundMessage = { ...parsed.data, channel: entry.adapter.id };

    if (!this.take(entry.bucket, this.o.adapterPerSecond, this.o.adapterBurst, 1000)) return { result: "limited" };

    const text = normalizeText(msg.text);
    if (text === "" && !msg.attachments?.some((a) => a.data !== undefined)) return { result: "ignored", reason: "empty" };
    const target: SendTarget = { channel: msg.channel, accountId: msg.accountId, conversationId: msg.conversationId, replyTo: msg.messageId };

    // 1. Who is this? Unknown senders never get past here.
    let decision;
    try {
      decision = this.c.pairing.handleInbound({ channel: msg.channel, accountId: msg.accountId, externalId: msg.senderId, ...(msg.senderDisplay ? { display: msg.senderDisplay } : {}) });
    } catch (e) {
      if (e instanceof PairingError) return { result: "invalid", reason: "sender identity rejected" };
      throw e;
    }
    if (decision.action === "ignore") return { result: "ignored", reason: decision.reason };
    if (decision.action === "challenge") {
      this.audit("channel.challenge", { channel: msg.channel, accountId: msg.accountId, sender: msg.senderId });
      const minutes = Math.max(1, Math.round((decision.expiresAt - this.now()) / 60_000));
      this.queueSend(entry, target, `To talk to this assistant you first need the owner's approval. Your pairing code is ${decision.code} (valid for about ${minutes} minutes). Ask the owner to approve it.`);
      return { result: "pairing" };
    }

    // 2. Groups: only where and when they are meant to be served. A group is always served at guest level.
    if (msg.isGroup) {
      const p = entry.policy;
      if (!entry.adapter.capabilities.groups || p.groups === "off") return { result: "ignored", reason: "groups_off" };
      if (p.allowedGroups.length > 0 && !p.allowedGroups.includes(msg.conversationId)) return { result: "ignored", reason: "group_not_allowed" };
      if (p.groups === "mention" && !msg.mentionsBot) return { result: "ignored", reason: "not_mentioned" };
    }

    // 3. The same platform message is processed once, however often the platform delivers it.
    if (!this.markSeen(msg)) return { result: "duplicate" };

    // 4. One sender cannot monopolise the assistant.
    if (!this.take(this.senderBucket(msg), this.o.senderPerMinute, this.o.senderBurst, 60_000)) {
      this.notice(entry, target, msg.senderId, "limited");
      return { result: "limited" };
    }

    const sessions = this.c.sessions;
    if (!sessions) {
      this.notice(entry, target, msg.senderId, "unavailable");
      return { result: "unavailable" };
    }

    // 5. Files, only now: someone who is not paired, was rate-limited or repeated a message never gets a byte stored.
    let refs: AttachmentRef[] = [];
    if (msg.attachments && msg.attachments.length > 0) {
      const blobs = this.c.blobs;
      refs = blobs
        ? await ingestAttachments(msg.attachments, blobs, { ...DEFAULT_INGEST, ...this.c.ingest }, this.c.scan)
        : msg.attachments.map((a, i) => ({ name: safeName(a.name, i), dropped: "this Gateway does not take attachments" }));
      const kept = refs.filter((r) => r.id !== undefined).length;
      if (kept < refs.length) this.audit("channel.attachments_dropped", { channel: msg.channel, count: refs.length - kept, reasons: [...new Set(refs.flatMap((r) => (r.dropped ? [r.dropped] : [])))].slice(0, 5) });
      if (kept > 0) this.audit("channel.attachments_stored", { channel: msg.channel, count: kept });
    }
    if (text === "" && !refs.some((r) => r.id !== undefined)) return { result: "ignored", reason: "empty" };

    const principal = msg.isGroup ? "guest" : decision.principal;
    let sessionId: string;
    let sent;
    try {
      const session = sessions.getOrCreate(
        { channel: msg.channel, conversation: `${msg.accountId}|${msg.conversationId}`, scope: msg.isGroup ? "group" : msg.senderId },
        principal,
      );
      if (session.principal !== principal) sessions.setPrincipal(session.id, principal);
      sessionId = session.id;
      sent = sessions.send(session.id, text, { sender: msg.senderId, ...(refs.length ? { attachments: refs } : {}) });
    } catch (e) {
      if (e instanceof SessionError) {
        if (e.code === "QUEUE_FULL") {
          this.notice(entry, target, msg.senderId, "busy");
          return { result: "busy" };
        }
        if (e.code === "TOO_LARGE") {
          this.notice(entry, target, msg.senderId, "tooLong");
          return { result: "invalid", reason: "too_long" };
        }
        return { result: "invalid", reason: "session_error" };
      }
      throw e;
    }

    this.track(sent.runId, { entry, target, sessionId });
    void this.safe(() => entry.adapter.typing?.(target, true));
    return { result: "accepted", sessionId, runId: sent.runId };
  }

  private markSeen(m: InboundMessage): boolean {
    const t = this.now();
    const r = this.c.db.prepare("INSERT OR IGNORE INTO channel_seen(channel, account_id, message_id, ts) VALUES (?, ?, ?, ?)").run(m.channel, m.accountId, m.messageId, t);
    if (++this.inserts % 200 === 0) this.c.db.prepare("DELETE FROM channel_seen WHERE ts < ?").run(t - this.o.dedupeRetentionMs);
    return Number(r.changes) === 1;
  }

  private senderBucket(m: InboundMessage): Bucket {
    const key = `${m.channel}|${m.accountId}|${m.senderId}`;
    let b = this.senderBuckets.get(key);
    if (!b) {
      if (this.senderBuckets.size > 5000) for (const [k, v] of this.senderBuckets) if (this.now() - v.at > 600_000) this.senderBuckets.delete(k);
      b = { tokens: this.o.senderBurst, at: this.now() };
      this.senderBuckets.set(key, b);
    }
    return b;
  }

  /** Token bucket: `perWindow` tokens per `windowMs`, up to `burst`. */
  private take(b: Bucket, perWindow: number, burst: number, windowMs: number): boolean {
    const t = this.now();
    b.tokens = Math.min(burst, b.tokens + ((t - b.at) / windowMs) * perWindow);
    b.at = t;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  private recent(entry: Entry, accountId: string, conversationId: string, senderId: string, limit: number): Array<{ from: "you" | "assistant"; text: string; ts: number }> {
    const sessions = this.c.sessions;
    if (!sessions) return [];
    const s = sessions.find({ channel: entry.adapter.id, conversation: `${accountId}|${conversationId}`, scope: senderId });
    if (!s) return [];
    return sessions
      .messages(s.id, { limit: Math.min(Math.max(limit, 1), 200) })
      .filter((m) => m.role !== "system")
      .map((m) => ({ from: m.role === "assistant" ? ("assistant" as const) : ("you" as const), text: m.content, ts: m.ts }));
  }

  // ---------------- outbound ----------------

  private track(runId: string, t: Tracked): void {
    if (this.runs.size >= MAX_TRACKED_RUNS) {
      const oldest = this.runs.keys().next().value;
      if (oldest !== undefined) this.runs.delete(oldest);
    }
    this.runs.set(runId, t);
  }

  private onEvents(evs: StoredEvent[]): void {
    for (const e of evs) {
      const runId = (e.data as { runId?: string } | undefined)?.runId;
      if (!runId) continue;
      const t = this.runs.get(runId);
      if (!t) continue; // not ours: a run started from the CLI is never sent out to a channel
      if (e.type === "message.outbound") {
        const text = (e.data as { text?: string }).text ?? "";
        if (text.trim() !== "") this.queueSend(t.entry, t.target, text, true);
      } else if (e.type === "run.completed" || e.type === "run.failed" || e.type === "run.cancelled") {
        this.runs.delete(runId);
        void this.safe(() => t.entry.adapter.typing?.(t.target, false));
        if (e.type === "run.failed") this.queueSend(t.entry, t.target, NOTICE.failed, true);
      }
    }
  }

  /**
   * Same-conversation sends happen one after another, in order. Answers (`persist`) go through the outbox and survive a
   * restart. Everything else (pairing prompts, "busy", "slow down") is sent once, best effort: a pairing code must not
   * be written down in plain text, and the others are worthless by the time they could be retried.
   */
  private queueSend(entry: Entry, target: SendTarget, text: string, persist = false): void {
    if (this.stopped || entry.detached) return;
    if (persist) {
      try {
        const pieces = chunkText(text, entry.adapter.capabilities.maxTextChars);
        if (!this.outbox.enqueue(target, pieces)) {
          this.audit("channel.outbox_full", { channel: target.channel, accountId: target.accountId });
          return;
        }
        void this.pump(target.channel, target.accountId, target.conversationId);
      } catch {
        /* the database may be closing */
      }
      return;
    }
    const key = `${target.channel}|${target.accountId}|${target.conversationId}`;
    const prev = this.sendChains.get(key) ?? Promise.resolve();
    const next = prev.then(() => this.deliver(entry, target, text)).catch(() => undefined);
    this.sendChains.set(key, next);
    void next.then(() => {
      if (this.sendChains.get(key) === next) this.sendChains.delete(key);
    });
  }

  private async deliver(entry: Entry, target: SendTarget, text: string): Promise<void> {
    for (const chunk of chunkText(text, entry.adapter.capabilities.maxTextChars)) {
      let lastError = "";
      let ok = false;
      for (let attempt = 0; attempt < this.o.sendRetry.attempts && !this.stopped; attempt++) {
        try {
          await withTimeout(entry.adapter.send(target, { text: chunk }), this.o.adapterTimeoutMs, `sending on ${entry.adapter.id}`);
          ok = true;
          break;
        } catch (e) {
          lastError = scrub(e instanceof Error ? e.message : "send failed");
          if (attempt + 1 < this.o.sendRetry.attempts) await new Promise((r) => setTimeout(r, this.o.sendRetry.baseMs * 2 ** attempt).unref());
        }
      }
      if (!ok) {
        this.audit("channel.send_failed", { channel: target.channel, accountId: target.accountId, error: lastError });
        return; // later pieces would arrive out of order
      }
    }
  }

  // ---------------- files out ----------------

  /**
   * Send one already-stored file to the conversation a session belongs to. There is no destination argument: a file can
   * only go back to the people the session is with. Throws a ChannelFileError whose message is fit to show the model.
   */
  sendFile(sessionId: string, file: OutboxFile, caption = ""): void {
    const sessions = this.c.sessions;
    if (!sessions) throw new ChannelFileError("the assistant is not ready");
    const s = sessions.get(sessionId);
    const bar = s.conversation.indexOf("|");
    const entry = this.entries.get(s.channel);
    if (bar < 1 || !entry || entry.detached || !entry.started) throw new ChannelFileError("this conversation is not on a running messaging channel, so there is nobody to send a file to");
    if (!entry.adapter.capabilities.files) throw new ChannelFileError(`the ${s.channel} channel cannot carry files`);
    const target: SendTarget = { channel: s.channel, accountId: s.conversation.slice(0, bar), conversationId: s.conversation.slice(bar + 1) };
    if (!this.outbox.enqueueFile(target, file, caption.slice(0, entry.adapter.capabilities.maxTextChars))) throw new ChannelFileError("too many messages are waiting to be delivered");
    void this.pump(target.channel, target.accountId, target.conversationId);
  }

  /** Stored files that waiting replies still need. */
  outboxFileIds(): string[] {
    return this.outbox.fileIds();
  }

  // ---------------- outbox ----------------

  /** Put the replies that gave up back in the queue and try again. */
  retryOutbox(): number {
    const n = this.outbox.retryFailed();
    this.resume();
    return n;
  }

  /** Start delivering whatever is waiting, for one channel or all of them. */
  private resume(channel?: string): void {
    try {
      for (const w of this.outbox.waiting(channel)) void this.pump(w.channel, w.accountId, w.conversationId);
    } catch {
      /* the database may be closing */
    }
  }

  private wakeLater(key: string, delayMs: number, w: { channel: string; accountId: string; conversationId: string }): void {
    clearTimeout(this.wakeups.get(key));
    const t = setTimeout(() => {
      this.wakeups.delete(key);
      void this.pump(w.channel, w.accountId, w.conversationId);
    }, Math.max(0, delayMs));
    t.unref();
    this.wakeups.set(key, t);
  }

  /** Deliver one conversation's waiting pieces, oldest first, one at a time. Gives up on a reply after the configured attempts. */
  private async pump(channel: string, accountId: string, conversationId: string): Promise<void> {
    const key = `${channel}|${accountId}|${conversationId}`;
    if (this.pumping.has(key)) return; // the running loop will see anything added meanwhile
    this.pumping.add(key);
    clearTimeout(this.wakeups.get(key));
    this.wakeups.delete(key);
    try {
      while (!this.stopped) {
        const entry = this.entries.get(channel);
        if (!entry || entry.detached || !entry.started) return; // delivered when the channel is (back) up
        const row = this.outbox.head(channel, accountId, conversationId);
        if (!row) return;
        const wait = row.nextAt - Date.now();
        if (wait > 0) {
          this.wakeLater(key, wait, { channel, accountId, conversationId });
          return;
        }
        let content: OutboundContent = { text: row.text };
        if (row.files) {
          const f = row.files[0] as OutboxFile;
          const bytes = entry.adapter.capabilities.files ? this.c.blobs?.read(f.id) : undefined;
          if (bytes === undefined) {
            this.outbox.failGroup(row.group, entry.adapter.capabilities.files ? "the file is no longer stored" : "this channel cannot carry files");
            this.audit("channel.send_failed", { channel, accountId, error: "file could not be read" });
            continue;
          }
          content = { text: row.text, files: [{ name: f.name, mime: f.mime, data: bytes.toString("base64") }] };
        }
        this.outbox.begin(row.id);
        try {
          await withTimeout(entry.adapter.send(row.target, content), this.o.adapterTimeoutMs, `sending on ${channel}`);
          this.outbox.done(row.id);
          if (row.files) this.audit("channel.file_sent", { channel, accountId, mime: row.files[0]?.mime, bytes: row.files[0]?.bytes });
        } catch (e) {
          if (this.stopped) return;
          const error = scrub(e instanceof Error ? e.message : "send failed");
          if (row.attempts + 1 >= this.o.sendRetry.attempts) {
            this.outbox.failGroup(row.group, error);
            this.audit("channel.send_failed", { channel, accountId, error });
          } else {
            const delay = this.o.sendRetry.baseMs * 2 ** row.attempts;
            this.outbox.retryLater(row.id, Date.now() + delay, error);
            this.wakeLater(key, delay, { channel, accountId, conversationId });
            return;
          }
        }
      }
    } catch {
      /* the database may be closing */
    } finally {
      this.pumping.delete(key);
    }
  }

  /** Runs that a restart cut short: tell the people who were waiting for an answer, once. */
  private notifyInterrupted(): void {
    const db = this.c.db;
    const KEY = "channels_interrupted_seq";
    const latest = this.c.events.latestSeq();
    const seen = db.prepare("SELECT value FROM meta WHERE key = ?").get(KEY) as { value: string } | undefined;
    if (seen !== undefined) {
      const rows = db.prepare("SELECT session, data FROM events WHERE type = 'run.failed' AND seq > ? ORDER BY seq").all(Number(seen.value)) as unknown as Array<{ session: string | null; data: string | null }>;
      for (const r of rows) {
        let error: unknown;
        try {
          error = (JSON.parse(r.data ?? "{}") as { error?: unknown }).error;
        } catch {
          continue;
        }
        if (error !== "interrupted by restart" || r.session === null) continue;
        const s = db.prepare("SELECT channel, conversation FROM sessions WHERE id = ?").get(r.session) as { channel: string; conversation: string } | undefined;
        const bar = s?.conversation.indexOf("|") ?? -1;
        if (!s || bar < 1 || !this.entries.has(s.channel)) continue; // not a channel conversation (a CLI session, say)
        this.outbox.enqueue({ channel: s.channel, accountId: s.conversation.slice(0, bar), conversationId: s.conversation.slice(bar + 1) }, [NOTICE.interrupted]);
      }
    }
    db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, String(latest));
  }

  /** Tell a sender something, but not the same thing over and over. */
  private notice(entry: Entry, target: SendTarget, senderId: string, kind: keyof typeof NOTICE): void {
    const key = `${target.channel}|${target.accountId}|${senderId}|${kind}`;
    const t = this.now();
    const last = this.noticeAt.get(key);
    if (last !== undefined && t - last < this.o.noticeCooldownMs) return;
    if (this.noticeAt.size > 5000) for (const [k, v] of this.noticeAt) if (t - v > this.o.noticeCooldownMs) this.noticeAt.delete(k);
    this.noticeAt.set(key, t);
    this.queueSend(entry, target, NOTICE[kind]);
  }

  private async safe(fn: () => Promise<unknown> | undefined): Promise<void> {
    try {
      await withTimeout(Promise.resolve(fn()), this.o.adapterTimeoutMs, "adapter call");
    } catch {
      /* adapters are allowed to fail; the router carries on */
    }
  }

  private audit(type: string, data: Record<string, unknown>): void {
    try {
      this.c.events.append([{ type, data }]);
    } catch {
      /* the database may be closing */
    }
  }
}
