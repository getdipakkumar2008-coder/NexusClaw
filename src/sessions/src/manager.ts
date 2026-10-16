import { randomBytes } from "node:crypto";
import { inTransaction, type Db, type EventLog } from "@clawnexus/store";
import type { Provider, ProviderMessage } from "./provider.js";
import { fromJsonl, toJsonl, toMarkdown, type Transcript } from "./transcript.js";

export class SessionError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "QUEUE_FULL" | "TOO_LARGE" | "EXISTS" | "INVALID" | "CLOSED",
    message: string,
  ) {
    super(message);
  }
}

export interface SessionKey {
  channel: string;
  conversation: string;
  /** Isolation scope: the sender id for per-sender sessions, or a shared label for a group session. */
  scope: string;
}

export interface Session extends SessionKey {
  id: string;
  createdAt: number;
  state: "active" | "archived";
}

export interface Message {
  id: number;
  sessionId: string;
  runId?: string;
  role: "user" | "assistant" | "system";
  sender: string;
  content: string;
  ts: number;
}

export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface SessionManagerOptions {
  /** Pending (queued, not yet running) inputs allowed per session. */
  maxQueue?: number;
  /** Runs executing at once across all sessions. */
  maxConcurrentRuns?: number;
  runTimeoutMs?: number;
  maxMessageBytes?: number;
  maxReplyBytes?: number;
  /** Most recent messages given to the provider. */
  historyLimit?: number;
  /** Streaming deltas are written to the event log at most this often (0 = every delta). */
  deltaFlushMs?: number;
  now?: () => number;
}

interface Job {
  runId: string;
  sessionId: string;
  messageId: number;
}

interface Active {
  runId: string;
  abort: AbortController;
  reason?: "cancel" | "timeout" | "shutdown";
}

const newId = (prefix: string): string => `${prefix}_${randomBytes(8).toString("hex")}`;
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

interface SessionRow {
  id: string;
  channel: string;
  conversation: string;
  scope: string;
  created_at: number;
  state: "active" | "archived";
}
interface MessageRow {
  id: number;
  session_id: string;
  run_id: string | null;
  role: Message["role"];
  sender: string;
  content: string;
  ts: number;
}

const toSession = (r: SessionRow): Session => ({
  id: r.id,
  channel: r.channel,
  conversation: r.conversation,
  scope: r.scope,
  createdAt: r.created_at,
  state: r.state,
});
const toMessage = (r: MessageRow): Message => {
  const m: Message = { id: r.id, sessionId: r.session_id, role: r.role, sender: r.sender, content: r.content, ts: r.ts };
  if (r.run_id !== null) m.runId = r.run_id;
  return m;
};

/**
 * Sessions, transcripts and runs (docs/02, FR-SES). Rules enforced here:
 * - a session is identified by (channel, conversation, scope); a provider only ever sees its own session's history;
 * - at most one run per session; further inputs queue in order (bounded);
 * - runs have a timeout and can be cancelled; a restart marks interrupted runs failed (no silent resume).
 */
export class SessionManager {
  private readonly queues = new Map<string, Job[]>();
  private readonly active = new Map<string, Active>();
  private running = 0;
  private closed = false;
  private idleWaiters: Array<() => void> = [];
  private readonly o: Required<SessionManagerOptions>;

  constructor(
    private readonly db: Db,
    private readonly events: EventLog,
    private readonly provider: Provider,
    opts: SessionManagerOptions = {},
  ) {
    this.o = {
      maxQueue: opts.maxQueue ?? 20,
      maxConcurrentRuns: opts.maxConcurrentRuns ?? 4,
      runTimeoutMs: opts.runTimeoutMs ?? 120_000,
      maxMessageBytes: opts.maxMessageBytes ?? 64 * 1024,
      maxReplyBytes: opts.maxReplyBytes ?? 128 * 1024,
      historyLimit: opts.historyLimit ?? 200,
      deltaFlushMs: opts.deltaFlushMs ?? 50,
      now: opts.now ?? Date.now,
    };
    this.recover();
  }

  // ---------------- sessions ----------------

  /** Find the session for this key or create it. The same key always yields the same session. */
  getOrCreate(key: SessionKey): Session {
    for (const [k, v] of Object.entries(key)) {
      if (typeof v !== "string" || v === "" || v.length > 256) throw new SessionError("INVALID", `session ${k} must be a non-empty string (max 256)`);
    }
    const existing = this.db
      .prepare("SELECT * FROM sessions WHERE channel = ? AND conversation = ? AND scope = ?")
      .get(key.channel, key.conversation, key.scope) as SessionRow | undefined;
    if (existing) return toSession(existing);
    const id = newId("s");
    const createdAt = this.o.now();
    inTransaction(this.db, () => {
      this.db.prepare("INSERT INTO sessions(id, channel, conversation, scope, created_at) VALUES (?, ?, ?, ?, ?)").run(id, key.channel, key.conversation, key.scope, createdAt);
      this.events.append([{ type: "session.created", session: id, data: { channel: key.channel, conversation: key.conversation } }]);
    });
    return { id, channel: key.channel, conversation: key.conversation, scope: key.scope, createdAt, state: "active" };
  }

  get(id: string): Session {
    const r = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    if (!r) throw new SessionError("NOT_FOUND", "unknown session");
    return toSession(r);
  }

  list(opts: { channel?: string; limit?: number } = {}): Session[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const rows =
      opts.channel === undefined
        ? this.db.prepare("SELECT * FROM sessions ORDER BY created_at DESC, id LIMIT ?").all(limit)
        : this.db.prepare("SELECT * FROM sessions WHERE channel = ? ORDER BY created_at DESC, id LIMIT ?").all(opts.channel, limit);
    return (rows as unknown as SessionRow[]).map(toSession);
  }

  /** Messages oldest-first. With `limit`, returns the most recent `limit`. */
  messages(sessionId: string, opts: { limit?: number } = {}): Message[] {
    this.get(sessionId);
    const limit = Math.min(Math.max(opts.limit ?? 1000, 1), 10_000);
    const rows = this.db
      .prepare("SELECT * FROM (SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id")
      .all(sessionId, limit) as unknown as MessageRow[];
    return rows.map(toMessage);
  }

  /** Remove a session, its transcript, its runs and its events. Active work is cancelled first. */
  delete(id: string): void {
    this.get(id);
    this.cancel(id);
    inTransaction(this.db, () => {
      this.db.prepare("DELETE FROM events WHERE session = ?").run(id);
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    });
  }

  // ---------------- runs ----------------

  /** Record the user's message and queue a run. Returns immediately; progress arrives as events. */
  send(sessionId: string, text: string, from: { sender: string } = { sender: "" }): { messageId: number; runId: string; queued: number } {
    if (this.closed) throw new SessionError("CLOSED", "session manager is shut down");
    this.get(sessionId);
    if (typeof text !== "string" || text.trim() === "") throw new SessionError("INVALID", "message text is empty");
    if (Buffer.byteLength(text, "utf8") > this.o.maxMessageBytes) throw new SessionError("TOO_LARGE", `message exceeds ${this.o.maxMessageBytes} bytes`);
    const queue = this.queues.get(sessionId) ?? [];
    if (queue.length >= this.o.maxQueue) throw new SessionError("QUEUE_FULL", "too many pending messages for this session");

    const runId = newId("r");
    const ts = this.o.now();
    const messageId = inTransaction(this.db, () => {
      const row = this.db
        .prepare("INSERT INTO messages(session_id, run_id, role, sender, content, ts) VALUES (?, ?, 'user', ?, ?, ?) RETURNING id")
        .get(sessionId, runId, from.sender, text, ts) as { id: number };
      this.db.prepare("INSERT INTO runs(id, session_id, provider, status, created_at) VALUES (?, ?, ?, 'queued', ?)").run(runId, sessionId, this.provider.name, ts);
      this.events.append([{ type: "message.inbound", session: sessionId, data: { messageId: row.id, runId, sender: from.sender, text } }]);
      return row.id;
    });
    const waitingBehind = queue.length + (this.active.has(sessionId) ? 1 : 0);
    queue.push({ runId, sessionId, messageId });
    this.queues.set(sessionId, queue);
    this.pump();
    return { messageId, runId, queued: waitingBehind };
  }

  /** Cancel the running run and drop queued inputs for this session. Returns how many runs were affected. */
  cancel(sessionId: string): number {
    let n = 0;
    const queued = this.queues.get(sessionId) ?? [];
    this.queues.delete(sessionId);
    for (const j of queued) {
      this.finishRun(j.runId, sessionId, "cancelled");
      n++;
    }
    const a = this.active.get(sessionId);
    if (a) {
      a.reason = "cancel";
      a.abort.abort();
      n++;
    }
    return n;
  }

  runStatus(runId: string): { status: RunStatus; error?: string } | undefined {
    const r = this.db.prepare("SELECT status, error FROM runs WHERE id = ?").get(runId) as { status: RunStatus; error: string | null } | undefined;
    if (!r) return undefined;
    return r.error === null ? { status: r.status } : { status: r.status, error: r.error };
  }

  /** Resolves when no run is queued or executing. */
  idle(): Promise<void> {
    if (this.running === 0 && this.totalQueued() === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Stop accepting work, abort active runs and drop queued ones. */
  async close(): Promise<void> {
    this.closed = true;
    for (const id of [...this.queues.keys()]) this.cancel(id);
    for (const a of this.active.values()) {
      a.reason = "shutdown";
      a.abort.abort();
    }
    await this.idle();
  }

  // ---------------- transcripts ----------------

  exportTranscript(sessionId: string): Transcript {
    const s = this.get(sessionId);
    return {
      channel: s.channel,
      conversation: s.conversation,
      scope: s.scope,
      createdAt: s.createdAt,
      messages: this.messages(sessionId, { limit: 10_000 }).map((m) => ({ role: m.role, sender: m.sender, content: m.content, ts: m.ts })),
    };
  }

  exportJsonl(sessionId: string): string {
    return toJsonl(this.exportTranscript(sessionId));
  }

  exportMarkdown(sessionId: string): string {
    return toMarkdown(this.exportTranscript(sessionId));
  }

  /** Create a session from an exported transcript. Fails if a session with the same key already exists. */
  importJsonl(text: string): Session {
    let t: Transcript;
    try {
      t = fromJsonl(text);
    } catch (e) {
      throw new SessionError("INVALID", e instanceof Error ? e.message : "invalid transcript");
    }
    const taken = this.db
      .prepare("SELECT 1 AS x FROM sessions WHERE channel = ? AND conversation = ? AND scope = ?")
      .get(t.channel, t.conversation, t.scope);
    if (taken) throw new SessionError("EXISTS", "a session with this key already exists");
    const id = newId("s");
    inTransaction(this.db, () => {
      this.db.prepare("INSERT INTO sessions(id, channel, conversation, scope, created_at) VALUES (?, ?, ?, ?, ?)").run(id, t.channel, t.conversation, t.scope, t.createdAt);
      const ins = this.db.prepare("INSERT INTO messages(session_id, role, sender, content, ts) VALUES (?, ?, ?, ?, ?)");
      for (const m of t.messages) ins.run(id, m.role, m.sender, m.content, m.ts);
      this.events.append([{ type: "session.created", session: id, data: { channel: t.channel, conversation: t.conversation, imported: true } }]);
    });
    return this.get(id);
  }

  // ---------------- internals ----------------

  private totalQueued(): number {
    let n = 0;
    for (const q of this.queues.values()) n += q.length;
    return n;
  }

  private notifyIdle(): void {
    if (this.running === 0 && this.totalQueued() === 0) {
      const w = this.idleWaiters;
      this.idleWaiters = [];
      for (const r of w) r();
    }
  }

  /** Start queued jobs for sessions that have no active run, within the global concurrency cap. */
  private pump(): void {
    for (const [sessionId, queue] of [...this.queues]) {
      if (this.running >= this.o.maxConcurrentRuns) break;
      if (this.active.has(sessionId)) continue;
      const job = queue.shift();
      if (!job) {
        this.queues.delete(sessionId);
        continue;
      }
      if (queue.length === 0) this.queues.delete(sessionId);
      this.running++;
      const a: Active = { runId: job.runId, abort: new AbortController() };
      this.active.set(sessionId, a);
      void this.execute(job, a).finally(() => {
        this.active.delete(sessionId);
        this.running--;
        this.pump();
        this.notifyIdle();
      });
    }
    this.notifyIdle();
  }

  private async execute(job: Job, a: Active): Promise<void> {
    const { runId, sessionId } = job;
    const timer = setTimeout(() => {
      a.reason = "timeout";
      a.abort.abort();
    }, this.o.runTimeoutMs);
    timer.unref();
    let text = "";
    let pending = "";
    let lastFlush = 0;
    const flush = (): void => {
      if (pending === "") return;
      this.events.append([{ type: "run.delta", session: sessionId, data: { runId, text: pending } }]);
      pending = "";
      lastFlush = this.o.now();
    };
    try {
      this.db.prepare("UPDATE runs SET status = 'running', started_at = ? WHERE id = ?").run(this.o.now(), runId);
      this.events.append([{ type: "run.started", session: sessionId, data: { runId, provider: this.provider.name } }]);

      const history = (
        this.db
          .prepare("SELECT role, content FROM (SELECT id, role, content FROM messages WHERE session_id = ? AND id <= ? ORDER BY id DESC LIMIT ?) ORDER BY id")
          .all(sessionId, job.messageId, this.o.historyLimit) as unknown as ProviderMessage[]
      ).map((m) => ({ role: m.role, content: m.content }));

      const aborted = new Promise<"aborted">((resolve) => a.abort.signal.addEventListener("abort", () => resolve("aborted"), { once: true }));
      const it = this.provider.run({ sessionId, runId, messages: history, signal: a.abort.signal })[Symbol.asyncIterator]();
      let stopped = false;
      for (;;) {
        const step = await Promise.race([it.next(), aborted]);
        if (step === "aborted") {
          stopped = true;
          void Promise.resolve(it.return?.()).catch(() => undefined);
          break;
        }
        if (step.done) break;
        text += step.value.text;
        if (Buffer.byteLength(text, "utf8") > this.o.maxReplyBytes) {
          void Promise.resolve(it.return?.()).catch(() => undefined);
          throw new Error(`reply exceeded ${this.o.maxReplyBytes} bytes`);
        }
        pending += step.value.text;
        if (this.o.deltaFlushMs === 0 || this.o.now() - lastFlush >= this.o.deltaFlushMs) flush();
      }
      flush();
      if (stopped) {
        if (a.reason === "timeout") this.finishRun(runId, sessionId, "failed", "run timed out");
        else this.finishRun(runId, sessionId, "cancelled", a.reason === "shutdown" ? "gateway shutting down" : undefined);
        return;
      }
      this.complete(job, text);
    } catch (e) {
      try {
        flush();
      } catch {
        /* the failure below is what matters */
      }
      this.finishRun(runId, sessionId, "failed", clip(e instanceof Error ? e.message : "provider error", 500));
    } finally {
      clearTimeout(timer);
    }
  }

  /** Persist the assistant reply and mark the run completed in one transaction. */
  private complete(job: Job, text: string): void {
    const ts = this.o.now();
    inTransaction(this.db, () => {
      const row = this.db
        .prepare("INSERT INTO messages(session_id, run_id, role, sender, content, ts) VALUES (?, ?, 'assistant', '', ?, ?) RETURNING id")
        .get(job.sessionId, job.runId, text, ts) as { id: number };
      this.db.prepare("UPDATE runs SET status = 'completed', ended_at = ? WHERE id = ?").run(ts, job.runId);
      this.events.append([
        { type: "message.outbound", session: job.sessionId, data: { messageId: row.id, runId: job.runId, text } },
        { type: "run.completed", session: job.sessionId, data: { runId: job.runId } },
      ]);
    });
  }

  private finishRun(runId: string, sessionId: string, status: "failed" | "cancelled", error?: string): void {
    // The session may have been deleted while this run was winding down; then there is nothing to record.
    if (!this.db.prepare("SELECT 1 AS x FROM sessions WHERE id = ?").get(sessionId)) return;
    inTransaction(this.db, () => {
      this.db.prepare("UPDATE runs SET status = ?, ended_at = ?, error = ? WHERE id = ?").run(status, this.o.now(), error ?? null, runId);
      this.events.append([{ type: `run.${status}`, session: sessionId, data: error === undefined ? { runId } : { runId, error } }]);
    });
  }

  /** After a crash or restart, work that was queued or running is marked failed rather than silently replayed. */
  private recover(): void {
    const stale = this.db.prepare("SELECT id, session_id FROM runs WHERE status IN ('queued','running')").all() as unknown as Array<{ id: string; session_id: string }>;
    for (const r of stale) this.finishRun(r.id, r.session_id, "failed", "interrupted by restart");
  }
}
