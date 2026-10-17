import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "@clawnexus/store";

export class BlobError extends Error {
  constructor(
    readonly code: "TOO_LARGE" | "FULL" | "INVALID",
    message: string,
  ) {
    super(message);
  }
}

export interface BlobStoreOptions {
  /** Largest single file. */
  maxBlobBytes?: number;
  /** Everything stored, together. New files are refused beyond this. */
  maxTotalBytes?: number;
  now?: () => number;
}

export const DEFAULT_MAX_BLOB_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

const ID = /^[0-9a-f]{64}$/;
export const isBlobId = (s: unknown): s is string => typeof s === "string" && ID.test(s);

/**
 * Files that came with messages, stored under the SHA-256 of their content (docs/02: `blobs/`). The same file arriving
 * twice is stored once. Nothing here interprets a file; it is bytes in, bytes out, and a read checks the bytes still
 * match their name, so a damaged or tampered file is never handed on as the original.
 */
export class BlobStore {
  private readonly maxBlob: number;
  private readonly maxTotal: number;
  private readonly now: () => number;

  constructor(
    readonly dir: string,
    private readonly db: Db,
    o: BlobStoreOptions = {},
  ) {
    this.maxBlob = o.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
    this.maxTotal = o.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.now = o.now ?? Date.now;
  }

  private path(id: string): string {
    return join(this.dir, id.slice(0, 2), id);
  }

  /** Store bytes. Returns the id (their SHA-256). Storing what is already there costs nothing. */
  put(bytes: Buffer, mime: string): { id: string; existed: boolean } {
    if (bytes.length === 0) throw new BlobError("INVALID", "an empty file is not stored");
    if (bytes.length > this.maxBlob) throw new BlobError("TOO_LARGE", `a file may be at most ${this.maxBlob} bytes`);
    const id = createHash("sha256").update(bytes).digest("hex");
    const known = this.db.prepare("SELECT 1 AS x FROM blobs WHERE id = ?").get(id);
    if (known && existsSync(this.path(id))) return { id, existed: true };
    if (this.stats().bytes + bytes.length > this.maxTotal) throw new BlobError("FULL", "the attachment store is full");
    const dest = this.path(id);
    mkdirSync(join(this.dir, id.slice(0, 2)), { recursive: true, mode: 0o700 });
    const tmp = `${dest}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes, { mode: 0o600 });
    renameSync(tmp, dest);
    try {
      chmodSync(dest, 0o600);
    } catch {
      /* not every file system has modes */
    }
    this.db.prepare("INSERT OR REPLACE INTO blobs(id, bytes, mime, created_at) VALUES (?, ?, ?, ?)").run(id, bytes.length, mime, this.now());
    return { id, existed: false };
  }

  /** The file's bytes, or undefined if it is not there or no longer matches its name. */
  read(id: string): Buffer | undefined {
    if (!isBlobId(id)) return undefined;
    try {
      const b = readFileSync(this.path(id));
      return createHash("sha256").update(b).digest("hex") === id ? b : undefined;
    } catch {
      return undefined;
    }
  }

  info(id: string): { id: string; bytes: number; mime: string; createdAt: number } | undefined {
    if (!isBlobId(id)) return undefined;
    const r = this.db.prepare("SELECT id, bytes, mime, created_at FROM blobs WHERE id = ?").get(id) as { id: string; bytes: number; mime: string; created_at: number } | undefined;
    return r ? { id: r.id, bytes: r.bytes, mime: r.mime, createdAt: r.created_at } : undefined;
  }

  stats(): { count: number; bytes: number } {
    const r = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM blobs").get() as { n: number; b: number };
    return { count: r.n, bytes: r.b };
  }

  /**
   * Delete every file nothing refers to. A file stored in the last `graceMs` is kept even if unreferenced, because the
   * message that will refer to it may not have been written yet.
   */
  gc(referenced: ReadonlySet<string>, graceMs = 3600_000): { removed: number; freed: number } {
    let removed = 0;
    let freed = 0;
    const cutoff = this.now() - graceMs;
    const rows = this.db.prepare("SELECT id, bytes, created_at FROM blobs").all() as unknown as Array<{ id: string; bytes: number; created_at: number }>;
    for (const r of rows) {
      if (referenced.has(r.id) || r.created_at > cutoff) continue;
      rmSync(this.path(r.id), { force: true });
      this.db.prepare("DELETE FROM blobs WHERE id = ?").run(r.id);
      removed++;
      freed += r.bytes;
    }
    // Files on disk the table does not know (a crash between writing and recording) are removed once they are old enough.
    if (existsSync(this.dir)) {
      for (const sub of readdirSync(this.dir)) {
        const d = join(this.dir, sub);
        let names: string[];
        try {
          names = readdirSync(d);
        } catch {
          continue;
        }
        for (const n of names) {
          if (this.db.prepare("SELECT 1 AS x FROM blobs WHERE id = ?").get(n)) continue;
          try {
            if (statSync(join(d, n)).mtimeMs < cutoff) {
              rmSync(join(d, n), { force: true });
              removed++;
            }
          } catch {
            /* gone already */
          }
        }
      }
    }
    return { removed, freed };
  }
}
