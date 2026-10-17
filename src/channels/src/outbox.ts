import { randomBytes } from "node:crypto";
import { inTransaction, type Db } from "@clawnexus/store";
import type { SendTarget } from "./types.js";

/**
 * Replies on their way to a channel (docs/05 section 2, item 7). Each piece of text is a row, written before anything
 * is sent and deleted once the platform has accepted it, so a Gateway restart, a crashed plugin or a platform outage
 * delays an answer instead of losing it. Delivery is at-least-once: if the Gateway dies between the platform accepting a
 * message and the row being deleted, that message is sent again. The attempt is counted BEFORE sending, so a message that
 * keeps crashing the Gateway still gives up.
 */
/** A stored file waiting to go out with a reply. */
export interface OutboxFile {
  id: string;
  name: string;
  mime: string;
  bytes: number;
}

export interface OutboxRow {
  id: number;
  group: string;
  target: SendTarget;
  text: string;
  files?: OutboxFile[];
  createdAt: number;
  attempts: number;
  nextAt: number;
  state: "pending" | "failed";
  lastError?: string;
}

interface Raw {
  id: number;
  grp: string;
  channel: string;
  account_id: string;
  conversation_id: string;
  reply_to: string | null;
  text: string;
  files: string | null;
  created_at: number;
  attempts: number;
  next_at: number;
  state: "pending" | "failed";
  last_error: string | null;
}

function parseFiles(raw: string | null): OutboxFile[] | undefined {
  if (raw === null) return undefined;
  try {
    const list = (JSON.parse(raw) as unknown[]).filter((f): f is OutboxFile => {
      const x = f as Partial<OutboxFile> | null;
      return typeof x?.id === "string" && typeof x.name === "string" && typeof x.mime === "string" && typeof x.bytes === "number";
    });
    return list.length ? list : undefined;
  } catch {
    return undefined;
  }
}

const toRow = (r: Raw): OutboxRow => ({
  id: r.id,
  group: r.grp,
  target: { channel: r.channel, accountId: r.account_id, conversationId: r.conversation_id, ...(r.reply_to === null ? {} : { replyTo: r.reply_to }) },
  text: r.text,
  ...(parseFiles(r.files) ? { files: parseFiles(r.files) as OutboxFile[] } : {}),
  createdAt: r.created_at,
  attempts: r.attempts,
  nextAt: r.next_at,
  state: r.state,
  ...(r.last_error === null ? {} : { lastError: r.last_error }),
});

export interface OutboxOptions {
  now?: () => number;
  /** Rows waiting in total; beyond this new replies are refused rather than filling the disk. */
  maxPending?: number;
  /** Rows waiting for one conversation. */
  maxPerConversation?: number;
  /** A reply older than this is no longer worth sending (it answers a message from long ago). */
  expireMs?: number;
  /** How long failed rows are kept for the owner to look at. */
  keepFailedMs?: number;
}

export class Outbox {
  private readonly now: () => number;
  private readonly maxPending: number;
  private readonly maxPerConversation: number;
  private readonly expireMs: number;
  private readonly keepFailedMs: number;

  constructor(
    private readonly db: Db,
    o: OutboxOptions = {},
  ) {
    this.now = o.now ?? Date.now;
    this.maxPending = o.maxPending ?? 2000;
    this.maxPerConversation = o.maxPerConversation ?? 100;
    this.expireMs = o.expireMs ?? 24 * 3600_000;
    this.keepFailedMs = o.keepFailedMs ?? 7 * 24 * 3600_000;
  }

  /** Queue the pieces of one reply, in order. Returns false (and queues nothing) if the outbox is full. */
  enqueue(target: SendTarget, pieces: readonly string[]): boolean {
    if (pieces.length === 0) return true;
    const total = (this.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state = 'pending'").get() as { n: number }).n;
    const mine = (this.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state = 'pending' AND channel = ? AND account_id = ? AND conversation_id = ?").get(target.channel, target.accountId, target.conversationId) as { n: number }).n;
    if (total + pieces.length > this.maxPending || mine + pieces.length > this.maxPerConversation) return false;
    const grp = randomBytes(8).toString("hex");
    const at = this.now();
    inTransaction(this.db, () => {
      const ins = this.db.prepare("INSERT INTO outbox(grp, channel, account_id, conversation_id, reply_to, text, created_at, next_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      // Only the first piece points at the message being answered; the rest follow it.
      pieces.forEach((text, i) => ins.run(grp, target.channel, target.accountId, target.conversationId, i === 0 ? (target.replyTo ?? null) : null, text, at, at));
    });
    return true;
  }

  /** Queue one file, with an optional caption, as a single message. Returns false if the outbox is full. */
  enqueueFile(target: SendTarget, file: OutboxFile, caption = ""): string | undefined {
    const total = (this.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state = 'pending'").get() as { n: number }).n;
    const mine = (this.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state = 'pending' AND channel = ? AND account_id = ? AND conversation_id = ?").get(target.channel, target.accountId, target.conversationId) as { n: number }).n;
    if (total + 1 > this.maxPending || mine + 1 > this.maxPerConversation) return undefined;
    const at = this.now();
    const group = randomBytes(8).toString("hex");
    this.db
      .prepare("INSERT INTO outbox(grp, channel, account_id, conversation_id, reply_to, text, files, created_at, next_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(group, target.channel, target.accountId, target.conversationId, target.replyTo ?? null, caption, JSON.stringify([file]), at, at);
    return group;
  }

  /** Take a queued reply back out before anything has tried to send it. */
  discard(group: string): void {
    this.db.prepare("DELETE FROM outbox WHERE grp = ? AND state = 'pending' AND attempts = 0").run(group);
  }

  /** Ids of the stored files that rows still need (so the store does not clean them up). */
  fileIds(): string[] {
    const ids: string[] = [];
    for (const r of this.db.prepare("SELECT files FROM outbox WHERE files IS NOT NULL").all() as unknown as Array<{ files: string }>) for (const f of parseFiles(r.files) ?? []) ids.push(f.id);
    return ids;
  }

  /** The next piece to send for one conversation, if any. Expired pieces (and the rest of their reply) are failed first. */
  head(channel: string, accountId: string, conversationId: string): OutboxRow | undefined {
    for (;;) {
      const r = this.db.prepare("SELECT * FROM outbox WHERE channel = ? AND account_id = ? AND conversation_id = ? AND state = 'pending' ORDER BY id LIMIT 1").get(channel, accountId, conversationId) as Raw | undefined;
      if (!r) return undefined;
      if (this.now() - r.created_at > this.expireMs) {
        this.failGroup(r.grp, "expired before it could be delivered");
        continue;
      }
      return toRow(r);
    }
  }

  /** Count an attempt that is about to be made. */
  begin(id: number): void {
    this.db.prepare("UPDATE outbox SET attempts = attempts + 1 WHERE id = ?").run(id);
  }

  done(id: number): void {
    this.db.prepare("DELETE FROM outbox WHERE id = ?").run(id);
  }

  /** The attempt failed: try again later, or give up on this reply (and the rest of it, which would arrive out of order). */
  retryLater(id: number, nextAt: number, error: string): void {
    this.db.prepare("UPDATE outbox SET next_at = ?, last_error = ? WHERE id = ?").run(nextAt, error, id);
  }

  failGroup(grp: string, error: string): void {
    this.db.prepare("UPDATE outbox SET state = 'failed', last_error = ? WHERE grp = ? AND state = 'pending'").run(error, grp);
  }

  /** Conversations with something waiting, optionally for one channel. */
  waiting(channel?: string): Array<{ channel: string; accountId: string; conversationId: string }> {
    const rows = (channel === undefined
      ? this.db.prepare("SELECT DISTINCT channel, account_id, conversation_id FROM outbox WHERE state = 'pending'").all()
      : this.db.prepare("SELECT DISTINCT channel, account_id, conversation_id FROM outbox WHERE state = 'pending' AND channel = ?").all(channel)) as unknown as Array<{ channel: string; account_id: string; conversation_id: string }>;
    return rows.map((r) => ({ channel: r.channel, accountId: r.account_id, conversationId: r.conversation_id }));
  }

  /** Housekeeping at start-up: drop old failed rows. */
  sweep(): void {
    this.db.prepare("DELETE FROM outbox WHERE state = 'failed' AND created_at < ?").run(this.now() - this.keepFailedMs);
  }

  /** What the owner sees: counts, and the failed rows without their text (a reply can be private). */
  summary(): { pending: number; failed: number; byChannel: Array<{ channel: string; pending: number; failed: number }>; failedRows: Array<{ id: number; channel: string; createdAt: number; attempts: number; error: string }> } {
    const by = this.db.prepare("SELECT channel, SUM(state = 'pending') AS pending, SUM(state = 'failed') AS failed FROM outbox GROUP BY channel ORDER BY channel").all() as unknown as Array<{ channel: string; pending: number; failed: number }>;
    const failedRows = (this.db.prepare("SELECT id, channel, created_at, attempts, last_error FROM outbox WHERE state = 'failed' ORDER BY id DESC LIMIT 50").all() as unknown as Array<{ id: number; channel: string; created_at: number; attempts: number; last_error: string | null }>).map((r) => ({ id: r.id, channel: r.channel, createdAt: r.created_at, attempts: r.attempts, error: r.last_error ?? "" }));
    return { pending: by.reduce((n, r) => n + r.pending, 0), failed: by.reduce((n, r) => n + r.failed, 0), byChannel: by, failedRows };
  }

  /** Put failed rows back in the queue. */
  retryFailed(): number {
    const at = this.now();
    return Number(this.db.prepare("UPDATE outbox SET state = 'pending', attempts = 0, next_at = ?, created_at = ?, last_error = NULL WHERE state = 'failed'").run(at, at).changes);
  }

  /** Delete rows. Failed ones by default; everything waiting too with `all`. */
  purge(all = false): number {
    return Number(this.db.prepare(all ? "DELETE FROM outbox" : "DELETE FROM outbox WHERE state = 'failed'").run().changes);
  }
}
