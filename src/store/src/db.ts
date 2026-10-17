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
  // v3: sessions, transcript messages and runs (docs/02 section 7, FR-SES). Deleting a session cascades.
  `CREATE TABLE sessions (
     id           TEXT PRIMARY KEY,
     channel      TEXT NOT NULL,
     conversation TEXT NOT NULL,
     scope        TEXT NOT NULL,
     created_at   INTEGER NOT NULL,
     state        TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','archived')),
     UNIQUE (channel, conversation, scope)
   );
   CREATE TABLE messages (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     run_id     TEXT,
     role       TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
     sender     TEXT NOT NULL DEFAULT '',
     content    TEXT NOT NULL,
     ts         INTEGER NOT NULL
   );
   CREATE INDEX messages_session ON messages(session_id, id);
   CREATE TABLE runs (
     id         TEXT PRIMARY KEY,
     session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     provider   TEXT NOT NULL,
     status     TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled')),
     created_at INTEGER NOT NULL,
     started_at INTEGER,
     ended_at   INTEGER,
     error      TEXT
   );
   CREATE INDEX runs_session ON runs(session_id, created_at);`,
  // v4: plugin trust. A row exists only for a plugin the owner has approved; the hash pins the exact code and permissions.
  `CREATE TABLE plugins (
     id           TEXT PRIMARY KEY,
     enabled      INTEGER NOT NULL DEFAULT 0,
     version      TEXT NOT NULL,
     approval     TEXT NOT NULL,
     approved_at  INTEGER NOT NULL
   );`,
  // v5: who a session is talking to (drives what the model may do for it), and channel message de-duplication.
  `ALTER TABLE sessions ADD COLUMN principal TEXT NOT NULL DEFAULT 'owner' CHECK (principal IN ('owner','guest'));
   CREATE TABLE channel_seen (
     channel    TEXT NOT NULL,
     account_id TEXT NOT NULL,
     message_id TEXT NOT NULL,
     ts         INTEGER NOT NULL,
     PRIMARY KEY (channel, account_id, message_id)
   ) WITHOUT ROWID;
   CREATE INDEX channel_seen_ts ON channel_seen(ts);`,
  // v6: the owner's (non-secret) settings for a plugin. Secrets never go here; they live in the vault.
  `CREATE TABLE plugin_config (
     id         TEXT PRIMARY KEY,
     json       TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   );`,
  // v7: paired devices (docs/03 section 3). Only the PUBLIC key is stored; a revoked device stays as a record.
  `CREATE TABLE devices (
     id           TEXT PRIMARY KEY,
     name         TEXT NOT NULL,
     public_key   TEXT NOT NULL UNIQUE,
     scopes       TEXT NOT NULL,
     created_at   INTEGER NOT NULL,
     last_seen_at INTEGER,
     revoked_at   INTEGER
   );`,
  // v8: replies waiting to be delivered to a channel, one row per piece of text, so a restart or a platform outage
  // does not lose an answer. A row is deleted when it has been sent; "failed" rows stay for the owner to see.
  `CREATE TABLE outbox (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     grp             TEXT NOT NULL,
     channel         TEXT NOT NULL,
     account_id      TEXT NOT NULL,
     conversation_id TEXT NOT NULL,
     reply_to        TEXT,
     text            TEXT NOT NULL,
     created_at      INTEGER NOT NULL,
     attempts        INTEGER NOT NULL DEFAULT 0,
     next_at         INTEGER NOT NULL,
     state           TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','failed')),
     last_error      TEXT
   );
   CREATE INDEX outbox_conv ON outbox(channel, account_id, conversation_id, state, id);`,
  // v9: attachments. Files live in <data>/blobs under the SHA-256 of their content; this table records them so the
  // total can be limited and unused ones cleaned up. A message lists the attachments it carries (names and ids, no bytes).
  `CREATE TABLE blobs (
     id         TEXT PRIMARY KEY,
     bytes      INTEGER NOT NULL,
     mime       TEXT NOT NULL,
     created_at INTEGER NOT NULL
   ) WITHOUT ROWID;
   ALTER TABLE messages ADD COLUMN attachments TEXT;`,
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

interface TxState {
  depth: number;
  hooks: Array<() => void>;
}
const txState = new WeakMap<Db, TxState>();
const stateOf = (db: Db): TxState => {
  let st = txState.get(db);
  if (!st) txState.set(db, (st = { depth: 0, hooks: [] }));
  return st;
};

/** True while `fn` of an `inTransaction` call is running on this connection. */
export function inTx(db: Db): boolean {
  return stateOf(db).depth > 0;
}

/** Run `fn` once the outermost transaction commits (immediately if none is open). Dropped on rollback. */
export function afterCommit(db: Db, fn: () => void): void {
  const st = stateOf(db);
  if (st.depth === 0) fn();
  else st.hooks.push(fn);
}

/**
 * Run `fn` in one immediate transaction; roll back on throw. Calls nest: an inner call is a savepoint, so
 * a failing inner step rolls back only its own work, and `afterCommit` hooks run after the outermost COMMIT.
 */
export function inTransaction<T>(db: Db, fn: () => T): T {
  const st = stateOf(db);
  if (st.depth > 0) {
    const sp = `sp_${st.depth}`;
    db.exec(`SAVEPOINT ${sp}`);
    st.depth++;
    const mark = st.hooks.length;
    try {
      const out = fn();
      db.exec(`RELEASE ${sp}`);
      return out;
    } catch (e) {
      db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
      st.hooks.length = mark;
      throw e;
    } finally {
      st.depth--;
    }
  }
  db.exec("BEGIN IMMEDIATE");
  st.depth = 1;
  try {
    const out = fn();
    db.exec("COMMIT");
    st.depth = 0;
    const hooks = st.hooks;
    st.hooks = [];
    for (const h of hooks) h();
    return out;
  } catch (e) {
    st.depth = 0;
    st.hooks = [];
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back by SQLite */
    }
    throw e;
  }
}

export interface DbInspection {
  userVersion: number;
  supportedVersion: number;
  /** Result of SQLite's `PRAGMA integrity_check`; "ok" when healthy. */
  integrity: string;
}

/** Read-only health check that never creates, migrates or locks the database for writing. */
export function inspectDb(path: string): DbInspection {
  const db = new Database(path, { readOnly: true });
  try {
    const v = db.prepare("PRAGMA user_version").get() as { user_version: number };
    const ic = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    return { userVersion: v.user_version, supportedVersion: SCHEMA_VERSION, integrity: ic.map((r) => r.integrity_check).join("; ") };
  } finally {
    db.close();
  }
}

/** Write a consistent copy of the database to `dest` (which must not exist), safe while the Gateway runs. */
export function snapshotDb(path: string, dest: string): void {
  const db = new Database(path, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}
