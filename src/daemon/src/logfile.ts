import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EventLog, StoredEvent } from "@clawnexus/store";

/**
 * The Gateway's operational log (docs/14 section 3): one JSON object per line, secret-free by construction and again
 * by a final scrub, size-limited by rotation. It records what happened, never what was said: message text, tool
 * arguments and model output stay out of it.
 */

// Shapes of credentials that must never reach a log, wherever they came from.
const PATTERNS: RegExp[] = [
  /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, // chat-bot tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bxapp-[A-Za-z0-9-]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bcnb_[A-Za-z0-9_-]{16,}/g, // our own tool-bridge credentials
  /\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}\b/g, // bot tokens in three parts
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b(Bearer|Bot|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b[A-Fa-f0-9]{40,}\b/g, // long hex: hashes of secrets, keys
  /[A-Za-z0-9+_-]{48,}={0,2}/g, // long base64-like runs (slashes excluded so file paths survive)
];
const SECRET_KEY = /(token|secret|passw(or)?d|api[_-]?key|authorization|credential|private[_-]?key|cookie)/i;
/** Fields that carry people's words or arguments; they are not logged at all. */
const CONTENT_KEY = /^(args|text|content|delta|body|message|prompt|reply|output|input)$/i;

export function redactText(text: string): string {
  let t = text;
  for (const p of PATTERNS) t = t.replace(p, "[redacted]");
  return t;
}

/** A copy that is safe to log: secrets and content removed, long strings cut. */
export function redactValue(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return redactText(v.length > 300 ? `${v.slice(0, 300)}...` : v);
  if (v === null || typeof v !== "object") return v;
  if (depth > 4) return "[nested]";
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => redactValue(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (CONTENT_KEY.test(k)) continue;
    out[k] = SECRET_KEY.test(k) ? "[redacted]" : redactValue(x, depth + 1);
  }
  return out;
}

export interface RotatingLogOptions {
  /** Rotate when the file would grow past this. */
  maxBytes?: number;
  /** Rotated files kept besides the current one. */
  keep?: number;
  now?: () => number;
}

export const DEFAULT_LOG_BYTES = 5 * 1024 * 1024;
export const DEFAULT_LOG_KEEP = 5;

/** Append-only JSON-lines file that rotates by size: `gateway.log`, `gateway.log.1` (newest) ... `.N` (oldest). */
export class RotatingLog {
  private size = 0;
  private readonly maxBytes: number;
  private readonly keep: number;
  private readonly now: () => number;
  private broken = false;

  constructor(
    readonly path: string,
    o: RotatingLogOptions = {},
  ) {
    this.maxBytes = o.maxBytes ?? DEFAULT_LOG_BYTES;
    this.keep = Math.max(0, o.keep ?? DEFAULT_LOG_KEEP);
    this.now = o.now ?? Date.now;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      this.size = statSync(path).size;
    } catch {
      this.size = 0;
    }
  }

  /** Write one entry. Logging must never take the Gateway down, so a failing disk silences the log instead. */
  write(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}): void {
    if (this.broken) return;
    try {
      const line = `${redactText(JSON.stringify({ ts: new Date(this.now()).toISOString(), level, msg: redactText(msg).slice(0, 500), ...(redactValue(fields) as object) }))}\n`;
      const bytes = Buffer.byteLength(line, "utf8");
      if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
      appendFileSync(this.path, line, { mode: 0o600 });
      this.size += bytes;
    } catch {
      this.broken = true;
    }
  }

  private rotate(): void {
    if (this.keep === 0) rmSync(this.path, { force: true });
    else {
      rmSync(`${this.path}.${this.keep}`, { force: true });
      for (let i = this.keep - 1; i >= 1; i--) if (existsSync(`${this.path}.${i}`)) renameSync(`${this.path}.${i}`, `${this.path}.${i + 1}`);
      renameSync(this.path, `${this.path}.1`);
    }
    this.size = 0;
  }
}

/** The last `lines` entries across the current file and its rotations, oldest first. */
export function tailLog(path: string, lines: number): string[] {
  const out: string[] = [];
  for (let i = 0; i <= DEFAULT_LOG_KEEP && out.length < lines; i++) {
    const p = i === 0 ? path : `${path}.${i}`;
    if (!existsSync(p)) break;
    const part = readFileSync(p, "utf8").split("\n").filter((l) => l !== "");
    out.unshift(...part.slice(-(lines - out.length)));
    if (out.length >= lines) break;
  }
  return out.slice(-lines);
}

/** Event types that say what the program did, not what anyone said. Others are not logged. */
const SKIP = new Set(["run.delta", "message.inbound", "message.outbound", "tool.started"]);
const LEVEL = (type: string): "info" | "warn" | "error" =>
  /(\.failed|\.error|unavailable|crashed|degraded)$/.test(type) ? "error" : /(\.denied|\.declined|\.rejected|shutting_down|auth_required)$/.test(type) ? "warn" : "info";

/** Copy the Gateway's operational events into the log. Returns a function that stops. */
export function attachOperationalLog(events: EventLog, log: RotatingLog): () => void {
  return events.subscribe((batch: StoredEvent[]) => {
    for (const e of batch) {
      if (SKIP.has(e.type)) continue;
      log.write(LEVEL(e.type), e.type, { seq: e.seq, ...(e.session === undefined ? {} : { session: e.session }), ...(e.data === undefined ? {} : { data: e.data }) });
    }
  });
}

export const logPath = (dataDir: string): string => join(dataDir, "logs", "gateway.log");
