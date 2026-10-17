import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateDeviceKey } from "@clawnexus/protocol";
import { EventLog, openDb, type Db } from "@clawnexus/store";
import { DeviceError, DeviceRegistry } from "./index.js";

let dir: string;
let db: Db;
let events: EventLog;
let now: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cn-dev-"));
  db = openDb(join(dir, "g.db"));
  events = new EventLog(db);
  now = 1_000_000;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
const make = (o: ConstructorParameters<typeof DeviceRegistry>[1] = {}): DeviceRegistry => new DeviceRegistry(db, { now: () => now, events, ...o });
const code = (e: unknown): string | undefined => (e instanceof DeviceError ? e.code : undefined);
const tryIt = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return code(e);
  }
  return undefined;
};

describe("pairing a device", () => {
  it("turns a one-time code and a public key into a device with the scopes the owner chose", () => {
    const r = make();
    const k = generateDeviceKey();
    const { code: c, scopes } = r.beginPairing("Ann's phone", ["read", "approve"]);
    expect(c).toMatch(/^[2-9A-HJKMNP-Z]{10}$/);
    expect(scopes).toEqual(["read", "approve"]);
    const d = r.completePairing(c, k.publicKey);
    expect(d).toMatchObject({ name: "Ann's phone", scopes: ["read", "approve"], publicKey: k.publicKey });
    expect(d.id).toMatch(/^dev_[0-9a-f]{16}$/);
    expect(r.usable(d.id)?.id).toBe(d.id);
    expect(events.readSince(0).some((e) => e.type === "device.paired")).toBe(true);
  });

  it("works once, accepts the code however it is typed, and expires", () => {
    const r = make();
    const { code: c } = r.beginPairing("one");
    expect(tryIt(() => r.completePairing(`${c.slice(0, 5).toLowerCase()} - ${c.slice(5)}`, generateDeviceKey().publicKey))).toBeUndefined();
    expect(tryIt(() => r.completePairing(c, generateDeviceKey().publicKey))).toBe("BAD_CODE");
    const { code: later } = r.beginPairing("two");
    now += 6 * 60_000;
    expect(tryIt(() => r.completePairing(later, generateDeviceKey().publicKey))).toBe("BAD_CODE");
    expect(r.pending()).toBe(0);
  });

  it("spends the code even when the key is bad, and refuses a key already in use", () => {
    const r = make();
    const first = r.beginPairing("a");
    expect(tryIt(() => r.completePairing(first.code, "not-a-key"))).toBe("BAD_KEY");
    expect(tryIt(() => r.completePairing(first.code, generateDeviceKey().publicKey))).toBe("BAD_CODE");
    const k = generateDeviceKey();
    r.completePairing(r.beginPairing("b").code, k.publicKey);
    expect(tryIt(() => r.completePairing(r.beginPairing("c").code, k.publicKey))).toBe("EXISTS");
  });

  it("cancels every waiting code after too many wrong guesses from anyone", () => {
    const r = make({ maxCodeFailures: 4 });
    const real = r.beginPairing("real");
    for (let i = 0; i < 4; i++) expect(tryIt(() => r.completePairing("AAAAAAAAAA", generateDeviceKey().publicKey))).toBe("BAD_CODE");
    expect(r.pending()).toBe(0);
    expect(tryIt(() => r.completePairing(real.code, generateDeviceKey().publicKey))).toBe("BAD_CODE");
    expect(events.readSince(0).some((e) => e.type === "device.pairing_cancelled")).toBe(true);
  });

  it("limits devices and waiting codes, and checks the scopes asked for", () => {
    const r = make({ maxDevices: 2 });
    for (let i = 0; i < 2; i++) r.completePairing(r.beginPairing(`d${i}`).code, generateDeviceKey().publicKey);
    expect(tryIt(() => r.beginPairing("third"))).toBe("LIMIT");
    const r2 = make({ maxDevices: 50 });
    for (let i = 0; i < 5; i++) r2.beginPairing(`w${i}`);
    expect(tryIt(() => r2.beginPairing("sixth"))).toBe("LIMIT");
    expect(tryIt(() => make().beginPairing("x", ["root" as never]))).toBe("INVALID");
    expect(tryIt(() => make().beginPairing("x", []))).toBe("INVALID");
  });

  it("keeps neither the code nor any private key", () => {
    const r = make();
    const k = generateDeviceKey();
    const { code: c } = r.beginPairing("phone");
    r.completePairing(c, k.publicKey);
    const dump = JSON.stringify([db.prepare("SELECT * FROM devices").all(), events.readSince(0)]);
    expect(dump).not.toContain(c);
    expect(dump).not.toContain("PRIVATE KEY");
    expect(dump).toContain(k.publicKey);
  });
});

describe("revoking a device", () => {
  it("makes it unusable for good but keeps the record", () => {
    const r = make();
    const d = r.completePairing(r.beginPairing("lost phone").code, generateDeviceKey().publicKey);
    expect(r.revoke(d.id).revokedAt).toBe(now);
    expect(r.usable(d.id)).toBeUndefined();
    expect(r.get(d.id)).toBeDefined();
    expect(r.list()).toHaveLength(1);
    expect(r.revoke(d.id).revokedAt).toBe(now); // doing it twice is harmless
    expect(tryIt(() => r.revoke("dev_00000000000000aa"))).toBe("NOT_FOUND");
    expect(events.readSince(0).filter((e) => e.type === "device.revoked")).toHaveLength(1);
  });

  it("frees the place of a revoked device", () => {
    const r = make({ maxDevices: 1 });
    const d = r.completePairing(r.beginPairing("a").code, generateDeviceKey().publicKey);
    expect(tryIt(() => r.beginPairing("b"))).toBe("LIMIT");
    r.revoke(d.id);
    expect(tryIt(() => r.beginPairing("b"))).toBeUndefined();
  });

  it("notes when a device last connected", () => {
    const r = make();
    const d = r.completePairing(r.beginPairing("a").code, generateDeviceKey().publicKey);
    expect(d.lastSeenAt).toBeUndefined();
    now += 5000;
    r.touch(d.id);
    expect(r.get(d.id)?.lastSeenAt).toBe(now);
  });
});

describe("storage", () => {
  it("survives a restart of the registry", () => {
    const a = make();
    const k = generateDeviceKey();
    const d = a.completePairing(a.beginPairing("phone", ["chat"]).code, k.publicKey);
    const b = make();
    expect(b.usable(d.id)).toMatchObject({ publicKey: k.publicKey, scopes: ["chat"] });
    expect(readFileSync(join(dir, "g.db")).length).toBeGreaterThan(0);
  });
});
