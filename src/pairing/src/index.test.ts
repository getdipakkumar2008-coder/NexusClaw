import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventLog, openDb, type Db } from "@clawnexus/store";
import { PairingError, PairingService, type InboundDecision, type SenderRef } from "./index.js";

let dir: string;
let db: Db;
let t: number;
let audit: EventLog;
let svc: PairingService;

const alice: SenderRef = { channel: "telegram", accountId: "bot1", externalId: "1001", display: "Alice" };
const mallory: SenderRef = { channel: "telegram", accountId: "bot1", externalId: "666", display: "Mallory" };

function challenge(d: InboundDecision): string {
  if (d.action !== "challenge") throw new Error(`expected challenge, got ${JSON.stringify(d)}`);
  return d.code;
}

function make(opts: ConstructorParameters<typeof PairingService>[1] = {}): PairingService {
  return new PairingService(db, { now: () => t, audit, ...opts });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pairing-test-"));
  db = openDb(join(dir, "gw.db"));
  t = 1_000_000;
  audit = new EventLog(db, () => t);
  svc = make();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("unknown senders", () => {
  it("get a challenge and are not allowed", () => {
    const d = svc.handleInbound(alice);
    expect(d.action).toBe("challenge");
    expect(svc.principalOf(alice)).toBe("unpaired");
  });

  it("codes are 8 chars from the safe alphabet and are never stored in plaintext", () => {
    const code = challenge(svc.handleInbound(alice));
    expect(code).toMatch(/^[2-9A-HJ-NP-Z]{8}$/);
    const dump = JSON.stringify(db.prepare("SELECT * FROM pairing_requests").all()) + JSON.stringify(db.prepare("SELECT * FROM events").all());
    expect(dump).not.toContain(code);
  });

  it("do not get a second challenge during cooldown (no spamming the sender)", () => {
    challenge(svc.handleInbound(alice));
    expect(svc.handleInbound(alice)).toEqual({ action: "ignore", reason: "cooldown" });
    t += 3_600_000 + 1;
    challenge(svc.handleInbound(alice));
  });

  it("are capped by maxPending and by the hourly global limit", () => {
    const s = make({ maxPending: 2 });
    challenge(s.handleInbound({ ...alice, externalId: "a" }));
    challenge(s.handleInbound({ ...alice, externalId: "b" }));
    expect(s.handleInbound({ ...alice, externalId: "c" })).toEqual({ action: "ignore", reason: "too_many_pending" });

    const g = make({ maxPending: 100, maxChallengesPerHour: 2 });
    g.purgeExpired();
    t += 3_700_000; // previous challenges expired and aged out
    challenge(g.handleInbound({ ...alice, externalId: "d" }));
    challenge(g.handleInbound({ ...alice, externalId: "e" }));
    expect(g.handleInbound({ ...alice, externalId: "f" })).toEqual({ action: "ignore", reason: "rate_limited" });
  });
});

describe("approval", () => {
  it("approve turns a challenge into a paired guest, once", () => {
    const code = challenge(svc.handleInbound(alice));
    const s = svc.approve(code);
    expect(s.status).toBe("paired");
    expect(s.role).toBe("guest");
    expect(svc.principalOf(alice)).toBe("guest");
    const again = svc.handleInbound(alice);
    expect(again.action).toBe("allow");
    expect(() => svc.approve(code)).toThrow(PairingError);
  });

  it("accepts lowercase and separators when the owner types the code", () => {
    const code = challenge(svc.handleInbound(alice));
    const typed = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase();
    expect(svc.approve(typed).status).toBe("paired");
  });

  it("rejects unknown, malformed and expired codes", () => {
    expect(() => svc.approve("ABCDEFGH")).toThrowError(/unknown/);
    expect(() => svc.approve("short")).toThrowError(/8 characters/);
    const code = challenge(svc.handleInbound(alice));
    t += 3_600_001;
    expect(() => svc.approve(code)).toThrowError(/expired/);
    t += 24 * 3_600_000;
    svc.purgeExpired();
    expect(svc.list()).toEqual([]); // expired pending sender cleaned up after the retention window
  });

  it("a pairing code can never create an owner", () => {
    const code = challenge(svc.handleInbound(alice));
    expect(svc.approve(code).role).toBe("guest");
  });

  it("deny blocks the sender silently", () => {
    const code = challenge(svc.handleInbound(mallory));
    svc.deny(code);
    expect(svc.handleInbound(mallory)).toEqual({ action: "ignore", reason: "blocked" });
    expect(svc.principalOf(mallory)).toBe("unpaired");
  });
});

describe("owner registration and lifecycle", () => {
  it("registerOwner makes an owner principal; allow decision reports owner", () => {
    svc.registerOwner(alice);
    expect(svc.principalOf(alice)).toBe("owner");
    const d = svc.handleInbound(alice);
    expect(d.action === "allow" && d.principal).toBe("owner");
  });

  it("registering an existing pending sender upgrades them and clears the challenge", () => {
    challenge(svc.handleInbound(alice));
    svc.registerOwner(alice);
    expect(svc.pendingRequests()).toEqual([]);
    expect(svc.principalOf(alice)).toBe("owner");
  });

  it("same external id on a different channel or account is a different identity", () => {
    svc.registerOwner(alice);
    expect(svc.principalOf({ ...alice, channel: "discord" })).toBe("unpaired");
    expect(svc.principalOf({ ...alice, accountId: "bot2" })).toBe("unpaired");
  });

  it("revoke returns the sender to unknown; block is sticky", () => {
    const s = svc.approve(challenge(svc.handleInbound(alice)));
    svc.revoke(s.id);
    expect(svc.principalOf(alice)).toBe("unpaired");
    t += 3_600_001;
    challenge(svc.handleInbound(alice));

    const m = svc.approve(challenge(svc.handleInbound(mallory)));
    svc.block(m.id);
    expect(svc.handleInbound(mallory)).toEqual({ action: "ignore", reason: "blocked" });
  });

  it("lists by status", () => {
    svc.registerOwner(alice);
    challenge(svc.handleInbound(mallory));
    expect(svc.list("paired")).toHaveLength(1);
    expect(svc.list("pending")).toHaveLength(1);
    expect(svc.pendingRequests()[0]?.sender.externalId).toBe("666");
  });
});

describe("input hygiene", () => {
  it("rejects empty, oversized and control-character identifiers", () => {
    expect(() => svc.handleInbound({ ...alice, externalId: "" })).toThrow(PairingError);
    expect(() => svc.handleInbound({ ...alice, externalId: "x".repeat(257) })).toThrow(PairingError);
    expect(() => svc.handleInbound({ ...alice, externalId: "a\u0000b" })).toThrow(PairingError);
    expect(() => svc.handleInbound({ ...alice, channel: "tele\ngram" })).toThrow(PairingError);
  });

  it("sanitises display names (bidi/control characters cannot spoof the owner's terminal)", () => {
    svc.handleInbound({ ...mallory, display: "‮evil\u0007\u001b[31m name" });
    const shown = svc.list("pending")[0]?.display ?? "";
    for (const bad of ["‮", "", ""]) expect(shown.includes(bad)).toBe(false);
    expect(shown.length).toBeLessThanOrEqual(64);
  });

  it("is safe against SQL-looking identifiers", () => {
    const evil = { ...alice, externalId: "1'); DROP TABLE senders;--" };
    expect(svc.handleInbound(evil).action).toBe("challenge");
    expect(svc.list()).toHaveLength(1);
  });
});

describe("audit trail", () => {
  it("records pairing events without codes", () => {
    const code = challenge(svc.handleInbound(alice));
    svc.approve(code);
    const types = audit.readSince(0).map((e) => e.type);
    expect(types).toEqual(["pairing.challenge", "pairing.approved"]);
    expect(JSON.stringify(audit.readSince(0))).not.toContain(code);
  });
});

describe("persistence", () => {
  it("survives reopening the database", () => {
    svc.registerOwner(alice);
    db.close();
    db = openDb(join(dir, "gw.db"));
    svc = make();
    expect(svc.principalOf(alice)).toBe("owner");
  });
});
