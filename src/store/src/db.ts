import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";

// Loaded via require so bundlers/test runners (vite-node strips the `node:` prefix of `sqlite`) cannot break it.
const { DatabaseSync: Database } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export type Db = DatabaseSync;

/** Ordered schema migrations, applied by `user_version`. Append only; never edit a shipped step. */
const SCHEMA: readonly string[] = [
  `CREATE TABLE events (
     seq     INTEGER PRIMARY KEY AUTOINCREMENT,
     ts      INTEGER NOT NULL,
     type    TEXT NOT NULL,
     session TEXT,
     data    TEXT
   );
   CREATE INDEX events_session_seq ON events(session, seq);
   CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // v2: channel senders and pairing challenges (docs/05 section 2). Codes are stored only as hashes.
  `CREATE TABLE senders (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     channel     TEXT NOT NULL,
     account_id  TEXT NOT NULL,
     external_id TEXT NOT NULL,
     display     TEXT NOT NULL DEFAULT '',
     status      TEXT NOT NULL CHECK (status IN ('pending','paired','blocked')),
     role        TEXT NOT NULL DEFAULT 'guest' CHECK (role IN ('owner','guest')),
     created_at  INTEGER NOT NULL,
     paired_at   INTEGER,
     last_challenge_at INTEGER,
     UNIQUE (channel, account_id, external_id)
   );
   CREATE TABLE pairing_requests (
     code_hash TEXT PRIMARY KEY,
     sender_id INTEGER NOT NULL REFERENCES senders(id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   );
   CREATE INDEX pairing_requests_sender ON pairing_requests(sender_id);
   CREATE INDEX pairing_requests_created ON pairing_requests(created_at);`,
];

export const SCHEMA_VERSION = SCHEMA.length;

export interface OpenOptions {
  /** `FULL` is the default: an acknowledged commit survives power loss (docs/spikes/RESULTS.md spike 2). */
  synchronous?: "FULL" | "NORMAL";
}

/** Open (creating if needed) the Gateway database in WAL mode and bring the schema up to date. */
export function openDb(path: string, opts: OpenOptions = {}): Db {
  const db = new Database(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=${opts.synchronous ?? "FULL"}; PRAGMA foreign_keys=ON;`);
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  const current = row?.user_version ?? 0;
  if (current > SCHEMA_VERSION) {
    db.close();
    throw new Error(`database schema ${current} is newer than this build supports (${SCHEMA_VERSION}); upgrade the software`);
  }
  for (let v = current; v < SCHEMA_VERSION; v++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(SCHEMA[v] as string);
      db.exec(`PRAGMA user_version=${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return db;
}

/** Run `fn` in one immediate transaction; roll back on throw. */
export function inTransaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
