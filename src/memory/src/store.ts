import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Db, EventLog } from "@clawnexus/store";

/**
 * Memory v1 (docs/01 FR-MEM, ADR 0009): plain Markdown files the operator owns.
 *
 *   <root>/owner/<name>.md                              the owner's own notes
 *   <root>/contacts/ch-<channel>/c-<id>/<name>.md       what is known about one person, on one channel
 *
 * Files are read from disk on every use, so edits made in a text editor take effect at once. Nothing about the content
 * is kept in the database; the event log records only that a write happened.
 */
export type MemoryScope = { kind: "owner" } | { kind: "contact"; channel: string; contact: string };

export class MemoryError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "INVALID" | "TOO_LARGE" | "LIMIT",
    message: string,
  ) {
    super(message);
  }
}

export interface MemoryFile {
  name: string;
  bytes: number;
  modifiedAt: number;
  /** Bigger than a note may be; only the start is ever read. */
  oversized?: boolean;
}

export interface MemoryActor {
  /** Who made the change: the owner at a terminal or editor, or the model on someone's behalf. */
  via: "owner" | "model";
  session?: string;
}

export interface MemoryHit {
  name: string;
  line: number;
  text: string;
  score: number;
}

export interface MemoryStoreOptions {
  db?: Db;
  events?: EventLog;
  now?: () => number;
  /** Largest note, in bytes. */
  maxFileBytes?: number;
  /** Most notes in one scope. */
  maxFiles?: number;
}

export const DEFAULT_MAX_FILE_BYTES = 32 * 1024;
export const DEFAULT_MAX_FILES = 100;

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CHANNEL = /^[a-z0-9][a-z0-9_-]{0,31}$/;
// Printable ASCII without spaces. Real platform ids look like this; anything else is refused rather than guessed at.
const CONTACT = /^[\x21-\x7e]{1,64}$/;
// Names the Windows file system treats as devices, with or without an extension.
const DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

/** Escape every character that is not a lower-case letter, digit or hyphen, so two ids can never share a folder, even on a case-insensitive disk. */
function encode(raw: string): string {
  let out = "";
  for (const ch of raw) out += /[a-z0-9-]/.test(ch) ? ch : `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
  return out;
}
function decode(seg: string): string | undefined {
  if (/[^a-z0-9%A-F-]/.test(seg)) return undefined;
  try {
    return seg.replace(/%([0-9A-F]{2})/g, (_m, h: string) => String.fromCharCode(Number.parseInt(h, 16)));
  } catch {
    return undefined;
  }
}

export function checkName(name: unknown): string {
  if (typeof name !== "string" || !NAME.test(name) || name.endsWith(".") || name.endsWith(".md") || DEVICE.test(name.split(".")[0] ?? "")) {
    throw new MemoryError("INVALID", "a note name is 1 to 64 characters: lower-case letters, digits, '.', '_' or '-', starting with a letter or digit (for example 'preferences')");
  }
  return name;
}

export function checkScope(scope: MemoryScope): MemoryScope {
  if (scope.kind === "owner") return { kind: "owner" };
  if (scope.kind !== "contact" || typeof scope.channel !== "string" || !CHANNEL.test(scope.channel) || typeof scope.contact !== "string" || !CONTACT.test(scope.contact)) {
    throw new MemoryError("INVALID", "a contact is a channel (such as 'telegram') and the person's id on it (printable characters, no spaces, up to 64)");
  }
  return { kind: "contact", channel: scope.channel, contact: scope.contact };
}

const refOf = (scope: MemoryScope): string => (scope.kind === "owner" ? "owner" : createHash("sha256").update(`${scope.channel}\0${scope.contact}`).digest("hex").slice(0, 16));

export class MemoryStore {
  private readonly o: Required<Pick<MemoryStoreOptions, "maxFileBytes" | "maxFiles" | "now">> & MemoryStoreOptions;

  constructor(
    readonly root: string,
    opts: MemoryStoreOptions = {},
  ) {
    this.o = { maxFileBytes: DEFAULT_MAX_FILE_BYTES, maxFiles: DEFAULT_MAX_FILES, now: Date.now, ...opts };
  }

  // ---------------- paths ----------------

  private dir(scope: MemoryScope): string {
    return scope.kind === "owner" ? join(this.root, "owner") : join(this.root, "contacts", `ch-${encode(scope.channel)}`, `c-${encode(scope.contact)}`);
  }

  private path(scope: MemoryScope, name: string): string {
    return join(this.dir(scope), `${name}.md`);
  }

  // ---------------- reading ----------------

  /** Notes in a scope, by name. Files that are not ordinary notes (odd names, links, folders) are ignored. */
  list(scope: MemoryScope): MemoryFile[] {
    const s = checkScope(scope);
    const dir = this.dir(s);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    const out: MemoryFile[] = [];
    for (const f of names.sort()) {
      if (!f.endsWith(".md")) continue;
      const name = f.slice(0, -3);
      try {
        checkName(name);
        const st = lstatSync(join(dir, f));
        if (!st.isFile()) continue;
        out.push({ name, bytes: st.size, modifiedAt: Math.round(st.mtimeMs), ...(st.size > this.o.maxFileBytes ? { oversized: true } : {}) });
      } catch {
        continue;
      }
    }
    return out;
  }

  read(scope: MemoryScope, name: string): MemoryFile & { content: string; truncated: boolean } {
    const s = checkScope(scope);
    checkName(name);
    const p = this.path(s, name);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      throw new MemoryError("NOT_FOUND", `no note called '${name}'`);
    }
    if (!st.isFile()) throw new MemoryError("NOT_FOUND", `no note called '${name}'`);
    const raw = readFileSync(p);
    const cut = raw.length > this.o.maxFileBytes;
    // Never cut in the middle of a character.
    const text = raw.subarray(0, this.o.maxFileBytes).toString("utf8").replace(/\uFFFD$/, "").replace(/^\uFEFF/, "");
    return { name, bytes: st.size, modifiedAt: Math.round(st.mtimeMs), content: text, truncated: cut, ...(cut ? { oversized: true } : {}) };
  }

  /** Simple word search over one scope: notes that contain more of the words rank higher. */
  search(scope: MemoryScope, query: string, limit = 10): MemoryHit[] {
    const words = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2))].slice(0, 12);
    if (words.length === 0) return [];
    const hits: MemoryHit[] = [];
    for (const f of this.list(scope)) {
      let text: string;
      try {
        text = this.read(scope, f.name).content;
      } catch {
        continue;
      }
      const lower = text.toLowerCase();
      const covered = words.filter((w) => lower.includes(w)).length;
      if (covered === 0) continue;
      const lines = text.split(/\r?\n/);
      let best = { line: 0, score: 0 };
      lines.forEach((l, i) => {
        const ll = l.toLowerCase();
        const score = words.filter((w) => ll.includes(w)).length;
        if (score > best.score) best = { line: i, score };
      });
      hits.push({ name: f.name, line: best.line + 1, text: (lines[best.line] ?? "").trim().slice(0, 200), score: covered * 10 + best.score });
    }
    return hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, Math.min(Math.max(limit, 1), 50));
  }

  /** Every scope that has notes: the owner's and each contact's. */
  scopes(): Array<{ scope: MemoryScope; files: number; bytes: number }> {
    const out: Array<{ scope: MemoryScope; files: number; bytes: number }> = [];
    const add = (scope: MemoryScope): void => {
      const files = this.list(scope);
      if (files.length) out.push({ scope, files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) });
    };
    add({ kind: "owner" });
    const contacts = join(this.root, "contacts");
    let channels: string[] = [];
    try {
      channels = readdirSync(contacts);
    } catch {
      return out;
    }
    for (const chDir of channels.sort()) {
      if (!chDir.startsWith("ch-")) continue;
      const channel = decode(chDir.slice(3));
      if (channel === undefined || !CHANNEL.test(channel)) continue;
      let people: string[] = [];
      try {
        people = readdirSync(join(contacts, chDir));
      } catch {
        continue;
      }
      for (const pDir of people.sort()) {
        if (!pDir.startsWith("c-")) continue;
        const contact = decode(pDir.slice(2));
        if (contact === undefined || !CONTACT.test(contact)) continue;
        add({ kind: "contact", channel, contact });
      }
    }
    return out;
  }

  /** The notes of one scope with their text, for copying out. */
  export(scope: MemoryScope): Array<{ name: string; content: string; truncated: boolean }> {
    return this.list(scope).map((f) => {
      const r = this.read(scope, f.name);
      return { name: r.name, content: r.content, truncated: r.truncated };
    });
  }

  // ---------------- changing ----------------

  write(scope: MemoryScope, name: string, content: string, mode: "replace" | "append", actor: MemoryActor): MemoryFile {
    const s = checkScope(scope);
    checkName(name);
    if (typeof content !== "string") throw new MemoryError("INVALID", "content must be text");
    if (content.includes("\u0000")) throw new MemoryError("INVALID", "notes are text; binary content is not allowed");
    const existing = this.list(s);
    const prior = existing.find((f) => f.name === name);
    if (!prior && existing.length >= this.o.maxFiles) throw new MemoryError("LIMIT", `this scope already has ${this.o.maxFiles} notes; delete or merge some first`);
    let next = content;
    if (mode === "append" && prior) {
      const before = this.read(s, name);
      if (before.truncated) throw new MemoryError("TOO_LARGE", `'${name}' is larger than a note may be; trim it before adding to it`);
      next = `${before.content}${before.content === "" || before.content.endsWith("\n") ? "" : "\n"}${content}`;
    }
    if (next !== "" && !next.endsWith("\n")) next += "\n";
    const bytes = Buffer.byteLength(next, "utf8");
    if (bytes > this.o.maxFileBytes) throw new MemoryError("TOO_LARGE", `a note may hold at most ${this.o.maxFileBytes} bytes; this would be ${bytes}`);

    const dir = this.dir(s);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = this.path(s, name);
    try {
      if (lstatSync(target).isSymbolicLink()) throw new MemoryError("INVALID", "refusing to write through a symbolic link");
    } catch (e) {
      if (e instanceof MemoryError) throw e;
    }
    // Write beside the target and rename, so a crash never leaves a half-written note.
    const tmp = join(dir, `.${basename(target)}.${process.pid}.tmp`);
    writeFileSync(tmp, next, { mode: 0o600 });
    renameSync(tmp, target);
    this.audit("memory.written", s, actor, { name, bytes, mode });
    return { name, bytes, modifiedAt: this.o.now() };
  }

  delete(scope: MemoryScope, name: string, actor: MemoryActor): void {
    const s = checkScope(scope);
    checkName(name);
    const p = this.path(s, name);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      throw new MemoryError("NOT_FOUND", `no note called '${name}'`);
    }
    if (!st.isFile() && !st.isSymbolicLink()) throw new MemoryError("NOT_FOUND", `no note called '${name}'`);
    rmSync(p, { force: true });
    this.tidy(s);
    this.audit("memory.deleted", s, actor, { name });
  }

  /**
   * Remove everything kept for one scope, or for all of them, including the audit trail of writes to it.
   * After this nothing about the notes remains in the files or the database (FR-MEM-3).
   */
  erase(target: MemoryScope | "all"): { files: number } {
    if (target === "all") {
      const files = this.scopes().reduce((n, s) => n + s.files, 0);
      rmSync(this.root, { recursive: true, force: true });
      this.forget(undefined);
      return { files };
    }
    const s = checkScope(target);
    const files = this.list(s).length;
    rmSync(this.dir(s), { recursive: true, force: true });
    this.tidy(s);
    this.forget(refOf(s));
    return { files };
  }

  // ---------------- internals ----------------

  /** Remove folders left empty, so a deleted contact leaves no trace in the layout either. */
  private tidy(scope: MemoryScope): void {
    if (scope.kind !== "contact") return;
    const person = this.dir(scope);
    const channel = join(person, "..");
    for (const d of [person, channel, join(channel, "..")]) {
      try {
        if (existsSync(d) && readdirSync(d).length === 0) rmSync(d, { recursive: true, force: true });
      } catch {
        /* leave it */
      }
    }
  }

  private audit(type: string, scope: MemoryScope, actor: MemoryActor, data: Record<string, unknown>): void {
    // The audit trail names the note and who changed it, never the content, and refers to a contact only by a hash.
    this.o.events?.append([{ type, ...(actor.session === undefined ? {} : { session: actor.session }), data: { scope: scope.kind, ref: refOf(scope), via: actor.via, ...data } }]);
  }

  private forget(ref: string | undefined): void {
    const db = this.o.db;
    if (!db) return;
    if (ref === undefined) db.prepare("DELETE FROM events WHERE type LIKE 'memory.%'").run();
    else db.prepare("DELETE FROM events WHERE type LIKE 'memory.%' AND json_extract(data, '$.ref') = ?").run(ref);
  }
}
