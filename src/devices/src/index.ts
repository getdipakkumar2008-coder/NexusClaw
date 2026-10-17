import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { DEVICE_SCOPES, PAIRING_CODE_ALPHABET, isPublicKey, type DeviceScope } from "@clawnexus/protocol";
import { inTransaction, type Db, type EventLog } from "@clawnexus/store";

export class DeviceError extends Error {
  constructor(
    readonly code: "BAD_CODE" | "BAD_KEY" | "LIMIT" | "NOT_FOUND" | "EXISTS" | "INVALID",
    message: string,
  ) {
    super(message);
  }
}

export interface Device {
  id: string;
  name: string;
  publicKey: string;
  scopes: DeviceScope[];
  createdAt: number;
  lastSeenAt?: number;
  revokedAt?: number;
}

interface Row {
  id: string;
  name: string;
  public_key: string;
  scopes: string;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
}

const toDevice = (r: Row): Device => ({
  id: r.id,
  name: r.name,
  publicKey: r.public_key,
  scopes: (JSON.parse(r.scopes) as string[]).filter((s): s is DeviceScope => (DEVICE_SCOPES as readonly string[]).includes(s)),
  createdAt: r.created_at,
  ...(r.last_seen_at === null ? {} : { lastSeenAt: r.last_seen_at }),
  ...(r.revoked_at === null ? {} : { revokedAt: r.revoked_at }),
});

export interface DeviceRegistryOptions {
  now?: () => number;
  events?: EventLog;
  /** Devices that may be paired and not revoked at once. */
  maxDevices?: number;
  /** How long a pairing code lives. */
  codeTtlMs?: number;
  /** Wrong codes tolerated, across everyone, before every outstanding code is cancelled. */
  maxCodeFailures?: number;
}

interface PendingCode {
  hash: Buffer;
  name: string;
  scopes: DeviceScope[];
  expiresAt: number;
}

const hash = (s: string): Buffer => createHash("sha256").update(s).digest();
export const normaliseCode = (s: string): string => s.toUpperCase().replace(/[\s-]/g, "");

/**
 * Paired devices (ADR 0010). The owner starts a pairing and gets a one-time code; a device presents the code with its
 * public key and becomes known. After that it signs in with its private key (see packages/protocol/src/device.ts).
 *
 * Codes live only in memory and are stored hashed, so a restart cancels them and a read of memory or the database does
 * not reveal one. A code works once, for a few minutes. Wrong guesses are limited globally, not just per address, so
 * spreading guesses over many addresses does not help.
 */
export class DeviceRegistry {
  private readonly codes = new Map<string, PendingCode>();
  private failures = 0;
  private readonly now: () => number;
  private readonly maxDevices: number;
  private readonly ttl: number;
  private readonly maxFailures: number;

  constructor(
    private readonly db: Db,
    private readonly o: DeviceRegistryOptions = {},
  ) {
    this.now = o.now ?? Date.now;
    this.maxDevices = o.maxDevices ?? 20;
    this.ttl = o.codeTtlMs ?? 5 * 60_000;
    this.maxFailures = o.maxCodeFailures ?? 10;
  }

  /** Make a one-time code for a new device. At most a few may wait at once. */
  beginPairing(name: string | undefined, scopes: readonly DeviceScope[] = ["read", "chat"]): { code: string; expiresAt: number; scopes: DeviceScope[] } {
    this.sweep();
    const clean = [...new Set(scopes)];
    if (clean.length === 0 || clean.some((s) => !(DEVICE_SCOPES as readonly string[]).includes(s))) throw new DeviceError("INVALID", `scopes must be some of: ${DEVICE_SCOPES.join(", ")}`);
    if (this.active().length >= this.maxDevices) throw new DeviceError("LIMIT", `${this.maxDevices} devices are already paired; revoke one first`);
    if (this.codes.size >= 5) throw new DeviceError("LIMIT", "too many pairing codes are waiting; use or let them expire first");
    let code = "";
    for (let i = 0; i < 10; i++) code += PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)];
    const expiresAt = this.now() + this.ttl;
    // Only the hash is kept, so the plain code is not retained anywhere in the Gateway.
    this.codes.set(hash(code).toString("hex"), { hash: hash(code), name: (name ?? "device").slice(0, 64), scopes: clean as DeviceScope[], expiresAt });
    return { code, expiresAt, scopes: clean as DeviceScope[] };
  }

  /** Pairing windows currently open. */
  pending(): number {
    this.sweep();
    return this.codes.size;
  }

  /** Exchange a code for a registered device. The code is spent whether or not the rest succeeds. */
  completePairing(code: string, publicKey: string, name?: string): Device {
    this.sweep();
    const key = hash(normaliseCode(code)).toString("hex");
    const found = this.codes.get(key);
    if (!found || !timingSafeEqual(found.hash, hash(normaliseCode(code)))) {
      if (++this.failures >= this.maxFailures) {
        this.codes.clear();
        this.failures = 0;
        this.o.events?.append([{ type: "device.pairing_cancelled", data: { reason: "too many wrong codes" } }]);
      }
      throw new DeviceError("BAD_CODE", "that pairing code is wrong or has expired");
    }
    this.codes.delete(key);
    if (!isPublicKey(publicKey)) throw new DeviceError("BAD_KEY", "the public key must be 32 bytes, base64url");
    if (this.active().length >= this.maxDevices) throw new DeviceError("LIMIT", `${this.maxDevices} devices are already paired`);
    const existing = this.db.prepare("SELECT id FROM devices WHERE public_key = ?").get(publicKey) as { id: string } | undefined;
    if (existing) throw new DeviceError("EXISTS", "a device with this key is already known; make a new key for a new pairing");
    const id = `dev_${randomBytes(8).toString("hex")}`;
    const at = this.now();
    const label = (name ?? found.name).slice(0, 64);
    inTransaction(this.db, () => {
      this.db.prepare("INSERT INTO devices(id, name, public_key, scopes, created_at) VALUES (?, ?, ?, ?, ?)").run(id, label, publicKey, JSON.stringify(found.scopes), at);
      this.o.events?.append([{ type: "device.paired", data: { id, name: label, scopes: found.scopes } }]);
    });
    return this.get(id)!;
  }

  get(id: string): Device | undefined {
    const r = this.db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as Row | undefined;
    return r ? toDevice(r) : undefined;
  }

  /** A device that may sign in: known and not revoked. */
  usable(id: string): Device | undefined {
    const d = this.get(id);
    return d && d.revokedAt === undefined ? d : undefined;
  }

  list(): Device[] {
    return (this.db.prepare("SELECT * FROM devices ORDER BY created_at, id").all() as unknown as Row[]).map(toDevice);
  }

  private active(): Device[] {
    return this.list().filter((d) => d.revokedAt === undefined);
  }

  touch(id: string): void {
    this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(this.now(), id);
  }

  /** Cut a device off for good. Its record stays, marked revoked, so the history is complete. */
  revoke(id: string): Device {
    const d = this.get(id);
    if (!d) throw new DeviceError("NOT_FOUND", "no such device");
    if (d.revokedAt === undefined) {
      inTransaction(this.db, () => {
        this.db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(this.now(), id);
        this.o.events?.append([{ type: "device.revoked", data: { id, name: d.name } }]);
      });
    }
    return this.get(id)!;
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, v] of this.codes) if (v.expiresAt <= t) this.codes.delete(k);
  }
}
