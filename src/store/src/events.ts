import { afterCommit, inTransaction, type Db } from "./db.js";

export interface NewEvent {
  type: string;
  session?: string;
  data?: unknown;
}

export interface StoredEvent {
  seq: number;
  ts: number;
  type: string;
  session?: string;
  data?: unknown;
}

/** Largest serialized event payload; bigger content must be stored as a blob and referenced. */
export const MAX_EVENT_BYTES = 256 * 1024;

/** Thrown when a client's cursor points before events that were compacted away; it must re-sync. */
export class CursorExpiredError extends Error {
  constructor(
    readonly since: number,
    readonly compactedThrough: number,
  ) {
    super(`cursor ${since} is older than the oldest retained event (compacted through ${compactedThrough})`);
  }
}

interface Row {
  seq: number;
  ts: number;
  type: string;
  session: string | null;
  data: string | null;
}

function toEvent(r: Row): StoredEvent {
  const e: StoredEvent = { seq: r.seq, ts: r.ts, type: r.type };
  if (r.session !== null) e.session = r.session;
  if (r.data !== null) e.data = JSON.parse(r.data) as unknown;
  return e;
}

export type Listener = (events: StoredEvent[]) => void;

/**
 * Append-only, totally ordered, durable event log (docs/03 section 6).
 * `seq` is AUTOINCREMENT so numbers are never reused, even after compaction.
 */
export class EventLog {
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** Atomically append a batch. Either every event is stored (and listeners notified) or none. */
  append(events: readonly NewEvent[]): StoredEvent[] {
    if (events.length === 0) return [];
    const ts = this.now();
    const prepared = events.map((e) => {
      if (!e.type) throw new Error("event type is required");
      const data = e.data === undefined ? null : JSON.stringify(e.data);
      if (data !== null && Buffer.byteLength(data, "utf8") > MAX_EVENT_BYTES) {
        throw new Error(`event payload exceeds ${MAX_EVENT_BYTES} bytes; store it as a blob`);
      }
      return { type: e.type, session: e.session ?? null, data };
    });

    const stored = inTransaction(this.db, () => {
      const ins = this.db.prepare("INSERT INTO events(ts, type, session, data) VALUES (?, ?, ?, ?) RETURNING seq");
      return prepared.map((p): StoredEvent => {
        const row = ins.get(ts, p.type, p.session, p.data) as { seq: number };
        const out: StoredEvent = { seq: row.seq, ts, type: p.type };
        if (p.session !== null) out.session = p.session;
        if (p.data !== null) out.data = JSON.parse(p.data) as unknown;
        return out;
      });
    });

    // Notify only after COMMIT (the outermost one, if the caller opened a transaction); a faulty listener
    // must never affect durability or other listeners.
    afterCommit(this.db, () => {
      for (const l of [...this.listeners]) {
        try {
          l(stored);
        } catch {
          /* isolated by design */
        }
      }
    });
    return stored;
  }

  /** Events with seq > `since`, in order. `since = 0` means from the beginning. */
  readSince(since: number, opts: { limit?: number; session?: string } = {}): StoredEvent[] {
    if (!Number.isInteger(since) || since < 0) throw new RangeError("since must be a non-negative integer");
    const through = this.compactedThrough();
    if (since < through) throw new CursorExpiredError(since, through);
    const limit = Math.min(Math.max(opts.limit ?? 1000, 1), 10_000);
    const rows =
      opts.session === undefined
        ? this.db.prepare("SELECT seq, ts, type, session, data FROM events WHERE seq > ? ORDER BY seq LIMIT ?").all(since, limit)
        : this.db
            .prepare("SELECT seq, ts, type, session, data FROM events WHERE seq > ? AND session = ? ORDER BY seq LIMIT ?")
            .all(since, opts.session, limit);
    return (rows as unknown as Row[]).map(toEvent);
  }

  latestSeq(): number {
    const r = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get() as { seq: number } | undefined;
    return r?.seq ?? 0;
  }

  /** Highest seq that has been deleted by compaction (0 if none). */
  compactedThrough(): number {
    const r = this.db.prepare("SELECT value FROM meta WHERE key = 'compacted_through'").get() as { value: string } | undefined;
    return r ? Number(r.value) : 0;
  }

  /** Delete events older than `olderThanMs` (by timestamp). Returns how many were removed. */
  compact(olderThanMs: number): number {
    return inTransaction(this.db, () => {
      const cutoff = this.now() - olderThanMs;
      const max = this.db.prepare("SELECT MAX(seq) AS m FROM events WHERE ts < ?").get(cutoff) as { m: number | null };
      if (max.m === null) return 0;
      const res = this.db.prepare("DELETE FROM events WHERE seq <= ?").run(max.m);
      this.db
        .prepare("INSERT INTO meta(key, value) VALUES ('compacted_through', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(String(max.m));
      return Number(res.changes);
    });
  }

  /** Subscribe to committed events. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
