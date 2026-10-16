import { createHash, randomInt } from "node:crypto";
import { inTransaction, type Db, type EventLog } from "@clawnexus/store";

/** 32 symbols (no 0, 1, I, O) => 5 bits per character. */
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_LENGTH = 8; // ~40 bits; approval happens locally, so this is not an online-guessing surface

export type SenderStatus = "pending" | "paired" | "blocked";
export type SenderRole = "owner" | "guest";
/** Same names as @clawnexus/policy PrincipalKind, kept as plain strings to avoid coupling the packages. */
export type Principal = "owner" | "guest" | "unpaired";

export interface SenderRef {
  channel: string;
  accountId: string;
  externalId: string;
  display?: string;
}

export interface Sender {
  id: number;
  channel: string;
  accountId: string;
  externalId: string;
  display: string;
  status: SenderStatus;
  role: SenderRole;
  createdAt: number;
  pairedAt?: number;
  lastChallengeAt?: number;
}

export type InboundDecision =
  | { action: "allow"; sender: Sender; principal: "owner" | "guest" }
  /** Send `code` to the sender once, telling them the owner must approve it. Never log or store the code. */
  | { action: "challenge"; code: string; expiresAt: number }
  /** Do not run the agent and do not reply. */
  | { action: "ignore"; reason: "blocked" | "cooldown" | "too_many_pending" | "rate_limited" };

export class PairingError extends Error {
  constructor(
    readonly code: "BAD_INPUT" | "UNKNOWN_CODE" | "EXPIRED" | "NOT_FOUND",
    message: string,
  ) {
    super(message);
  }
}

export interface PairingOptions {
  now?: () => number;
  codeTtlMs?: number;
  /** Maximum simultaneously pending (unexpired) challenges. */
  maxPending?: number;
  /** A given sender gets at most one challenge per this window. */
  perSenderCooldownMs?: number;
  /** Global cap on challenges issued per hour. */
  maxChallengesPerHour?: number;
  audit?: EventLog;
}

const HOUR = 3_600_000;
const PENDING_RETENTION_MS = 24 * HOUR;
const MAX_ID_LEN = 256;
const CONTROL_CHARS = "\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069";
const HAS_CONTROL = new RegExp(`[${CONTROL_CHARS}]`);
const STRIP_CONTROL = new RegExp(`[${CONTROL_CHARS}]`, "g");

function cleanId(label: string, v: string): string {
  const s = v.trim();
  if (s.length === 0 || s.length > MAX_ID_LEN || HAS_CONTROL.test(s)) {
    throw new PairingError("BAD_INPUT", `${label} is empty, too long or contains control characters`);
  }
  return s;
}

/** Display names are shown to the owner in terminals/UIs: strip control and bidi characters, cap length. */
function cleanDisplay(v: string | undefined): string {
  return (v ?? "").replace(STRIP_CONTROL, "").trim().slice(0, 64);
}

const hashCode = (code: string): string => createHash("sha256").update(code).digest("hex");

function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, "");
}

function newCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

interface SenderRow {
  id: number;
  channel: string;
  account_id: string;
  external_id: string;
  display: string;
  status: SenderStatus;
  role: SenderRole;
  created_at: number;
  paired_at: number | null;
  last_challenge_at: number | null;
}

function toSender(r: SenderRow): Sender {
  const s: Sender = {
    id: r.id,
    channel: r.channel,
    accountId: r.account_id,
    externalId: r.external_id,
    display: r.display,
    status: r.status,
    role: r.role,
    createdAt: r.created_at,
  };
  if (r.paired_at !== null) s.pairedAt = r.paired_at;
  if (r.last_challenge_at !== null) s.lastChallengeAt = r.last_challenge_at;
  return s;
}

/**
 * Sender pairing (docs/05 section 2, threats T2/T3). Unknown senders never reach the agent: they get a
 * rate-limited challenge code that only the authenticated local owner can approve.
 * Owners are registered only through `registerOwner`, which must be called from an authenticated local surface;
 * a pairing code can only ever produce a guest.
 */
export class PairingService {
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly maxPending: number;
  private readonly cooldown: number;
  private readonly maxPerHour: number;

  constructor(
    private readonly db: Db,
    private readonly opts: PairingOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.ttl = opts.codeTtlMs ?? HOUR;
    this.maxPending = opts.maxPending ?? 20;
    this.cooldown = opts.perSenderCooldownMs ?? HOUR;
    this.maxPerHour = opts.maxChallengesPerHour ?? 30;
  }

  /** The single entry point for every inbound message from a channel. */
  handleInbound(ref: SenderRef): InboundDecision {
    const key = this.key(ref);
    const existing = this.find(key);

    if (existing?.status === "blocked") return { action: "ignore", reason: "blocked" };
    if (existing?.status === "paired") {
      return { action: "allow", sender: existing, principal: existing.role };
    }

    const t = this.now();
    // Pending (or unknown): possibly issue a challenge, subject to cooldown and global limits.
    if (existing?.lastChallengeAt !== undefined && t - existing.lastChallengeAt < this.cooldown) {
      return { action: "ignore", reason: "cooldown" };
    }
    this.purgeExpired();
    const pending = (this.db.prepare("SELECT COUNT(*) AS n FROM pairing_requests WHERE expires_at > ?").get(t) as { n: number }).n;
    if (pending >= this.maxPending) return { action: "ignore", reason: "too_many_pending" };
    const recent = (this.db.prepare("SELECT COUNT(*) AS n FROM pairing_requests WHERE created_at > ?").get(t - HOUR) as { n: number }).n;
    if (recent >= this.maxPerHour) return { action: "ignore", reason: "rate_limited" };

    const code = newCode();
    const expiresAt = t + this.ttl;
    inTransaction(this.db, () => {
      let id = existing?.id;
      if (id === undefined) {
        const row = this.db
          .prepare(
            "INSERT INTO senders(channel, account_id, external_id, display, status, role, created_at, last_challenge_at) VALUES (?, ?, ?, ?, 'pending', 'guest', ?, ?) RETURNING id",
          )
          .get(key.channel, key.accountId, key.externalId, cleanDisplay(ref.display), t, t) as { id: number };
        id = row.id;
      } else {
        this.db.prepare("UPDATE senders SET last_challenge_at = ? WHERE id = ?").run(t, id);
      }
      this.db.prepare("INSERT INTO pairing_requests(code_hash, sender_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
        hashCode(code),
        id,
        t,
        expiresAt,
      );
    });
    this.audit("pairing.challenge", { channel: key.channel, accountId: key.accountId, externalId: key.externalId });
    return { action: "challenge", code, expiresAt };
  }

  /** Owner approves a code (from the authenticated CLI/UI). Always yields a guest. */
  approve(rawCode: string): Sender {
    const row = this.consumeCode(rawCode);
    const t = this.now();
    this.db.prepare("UPDATE senders SET status='paired', role='guest', paired_at=? WHERE id=?").run(t, row.sender_id);
    this.db.prepare("DELETE FROM pairing_requests WHERE sender_id = ?").run(row.sender_id);
    const sender = this.byId(row.sender_id);
    this.audit("pairing.approved", { senderId: sender.id, channel: sender.channel, externalId: sender.externalId });
    return sender;
  }

  /** Owner rejects a code; the sender is blocked so they cannot keep re-challenging. */
  deny(rawCode: string): Sender {
    const row = this.consumeCode(rawCode);
    this.db.prepare("UPDATE senders SET status='blocked' WHERE id=?").run(row.sender_id);
    this.db.prepare("DELETE FROM pairing_requests WHERE sender_id = ?").run(row.sender_id);
    const sender = this.byId(row.sender_id);
    this.audit("pairing.denied", { senderId: sender.id, channel: sender.channel, externalId: sender.externalId });
    return sender;
  }

  /**
   * Register one of the owner's own identities on a channel. Call only from an authenticated local surface
   * (CLI on the host, or an authenticated owner session) — never from inbound channel traffic.
   */
  registerOwner(ref: SenderRef): Sender {
    const key = this.key(ref);
    const t = this.now();
    const existing = this.find(key);
    if (existing) {
      this.db.prepare("UPDATE senders SET status='paired', role='owner', paired_at=? WHERE id=?").run(t, existing.id);
      this.db.prepare("DELETE FROM pairing_requests WHERE sender_id = ?").run(existing.id);
    } else {
      this.db
        .prepare(
          "INSERT INTO senders(channel, account_id, external_id, display, status, role, created_at, paired_at) VALUES (?, ?, ?, ?, 'paired', 'owner', ?, ?)",
        )
        .run(key.channel, key.accountId, key.externalId, cleanDisplay(ref.display), t, t);
    }
    const sender = this.mustFind(key);
    this.audit("pairing.owner_registered", { senderId: sender.id, channel: sender.channel });
    return sender;
  }

  /** Remove access; the sender returns to unknown (can be challenged again). */
  revoke(senderId: number): void {
    const s = this.byId(senderId);
    this.db.prepare("DELETE FROM senders WHERE id = ?").run(senderId);
    this.audit("pairing.revoked", { senderId, channel: s.channel, externalId: s.externalId });
  }

  block(senderId: number): void {
    const s = this.byId(senderId);
    this.db.prepare("UPDATE senders SET status='blocked' WHERE id = ?").run(senderId);
    this.db.prepare("DELETE FROM pairing_requests WHERE sender_id = ?").run(senderId);
    this.audit("pairing.blocked", { senderId, channel: s.channel, externalId: s.externalId });
  }

  /** Principal for policy decisions: only paired senders have one. */
  principalOf(ref: SenderRef): Principal {
    const s = this.find(this.key(ref));
    return s?.status === "paired" ? s.role : "unpaired";
  }

  list(status?: SenderStatus): Sender[] {
    const rows = (
      status
        ? this.db.prepare("SELECT * FROM senders WHERE status = ? ORDER BY id").all(status)
        : this.db.prepare("SELECT * FROM senders ORDER BY id").all()
    ) as unknown as SenderRow[];
    return rows.map(toSender);
  }

  /** Pending challenges that are still valid (never exposes codes). */
  pendingRequests(): Array<{ sender: Sender; expiresAt: number }> {
    this.purgeExpired();
    const rows = this.db
      .prepare("SELECT s.*, r.expires_at AS expires_at FROM pairing_requests r JOIN senders s ON s.id = r.sender_id ORDER BY r.created_at")
      .all() as unknown as Array<SenderRow & { expires_at: number }>;
    return rows.map((r) => ({ sender: toSender(r), expiresAt: r.expires_at }));
  }

  /**
   * Drop expired challenges. Pending senders are kept for a retention window so the per-sender cooldown
   * keeps working after a code expires, then removed to bound table growth.
   */
  purgeExpired(): number {
    const t = this.now();
    const res = this.db.prepare("DELETE FROM pairing_requests WHERE expires_at <= ?").run(t);
    this.db
      .prepare(
        "DELETE FROM senders WHERE status = 'pending' AND id NOT IN (SELECT sender_id FROM pairing_requests) AND COALESCE(last_challenge_at, created_at) < ?",
      )
      .run(t - PENDING_RETENTION_MS);
    return Number(res.changes);
  }

  // ---- internals ----

  private key(ref: SenderRef): { channel: string; accountId: string; externalId: string } {
    return {
      channel: cleanId("channel", ref.channel),
      accountId: cleanId("accountId", ref.accountId),
      externalId: cleanId("externalId", ref.externalId),
    };
  }

  private find(k: { channel: string; accountId: string; externalId: string }): Sender | undefined {
    const r = this.db
      .prepare("SELECT * FROM senders WHERE channel = ? AND account_id = ? AND external_id = ?")
      .get(k.channel, k.accountId, k.externalId) as unknown as SenderRow | undefined;
    return r ? toSender(r) : undefined;
  }

  private mustFind(k: { channel: string; accountId: string; externalId: string }): Sender {
    const s = this.find(k);
    if (!s) throw new PairingError("NOT_FOUND", "sender not found");
    return s;
  }

  private byId(id: number): Sender {
    const r = this.db.prepare("SELECT * FROM senders WHERE id = ?").get(id) as unknown as SenderRow | undefined;
    if (!r) throw new PairingError("NOT_FOUND", `no sender with id ${id}`);
    return toSender(r);
  }

  private consumeCode(raw: string): { sender_id: number } {
    const code = normalizeCode(raw);
    if (code.length !== CODE_LENGTH) throw new PairingError("BAD_INPUT", `a pairing code has ${CODE_LENGTH} characters`);
    const row = this.db
      .prepare("SELECT sender_id, expires_at FROM pairing_requests WHERE code_hash = ?")
      .get(hashCode(code)) as { sender_id: number; expires_at: number } | undefined;
    if (!row) throw new PairingError("UNKNOWN_CODE", "unknown or already used pairing code");
    if (this.now() >= row.expires_at) {
      this.purgeExpired();
      throw new PairingError("EXPIRED", "this pairing code has expired; ask the sender to message again");
    }
    return row;
  }

  private audit(type: string, data: Record<string, unknown>): void {
    this.opts.audit?.append([{ type, data }]);
  }
}
