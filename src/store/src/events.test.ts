import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CursorExpiredError, EventLog, MAX_EVENT_BYTES, openDb, type Db } from "./index.js";

let dir: string;
let db: Db;
let clock: number;
let log: EventLog;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "store-test-"));
  db = openDb(join(dir, "gw.db"));
  clock = 1_000;
  log = new EventLog(db, () => clock);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("EventLog.append / readSince", () => {
  it("assigns contiguous increasing seq and round-trips data", () => {
    const a = log.append([{ type: "a", data: { n: 1 } }, { type: "b", session: "s1" }]);
    const b = log.append([{ type: "c" }]);
    expect([...a, ...b].map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(log.readSince(0)).toEqual([
      { seq: 1, ts: 1000, type: "a", data: { n: 1 } },
      { seq: 2, ts: 1000, type: "b", session: "s1" },
      { seq: 3, ts: 1000, type: "c" },
    ]);
    expect(log.latestSeq()).toBe(3);
  });

  it("resumes exactly after a cursor, with limit and session filter", () => {
    log.append([{ type: "x", session: "s1" }, { type: "y", session: "s2" }, { type: "z", session: "s1" }]);
    expect(log.readSince(1).map((e) => e.seq)).toEqual([2, 3]);
    expect(log.readSince(0, { limit: 2 }).map((e) => e.seq)).toEqual([1, 2]);
    expect(log.readSince(0, { session: "s1" }).map((e) => e.seq)).toEqual([1, 3]);
    expect(log.readSince(3)).toEqual([]);
  });

  it("is atomic: a bad event in a batch stores nothing and notifies nobody", () => {
    const seen: number[] = [];
    log.subscribe((evs) => seen.push(...evs.map((e) => e.seq)));
    expect(() => log.append([{ type: "ok" }, { type: "" }])).toThrow();
    expect(log.readSince(0)).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("rejects oversized payloads and invalid cursors", () => {
    expect(() => log.append([{ type: "big", data: "x".repeat(MAX_EVENT_BYTES + 1) }])).toThrow(/exceeds/);
    expect(() => log.readSince(-1)).toThrow(RangeError);
    expect(() => log.readSince(1.5)).toThrow(RangeError);
  });

  it("persists across reopen and keeps counting from the last seq", () => {
    log.append([{ type: "a" }, { type: "b" }]);
    db.close();
    db = openDb(join(dir, "gw.db"));
    log = new EventLog(db, () => clock);
    expect(log.latestSeq()).toBe(2);
    expect(log.append([{ type: "c" }])[0]?.seq).toBe(3);
    expect(log.readSince(0)).toHaveLength(3);
  });
});

describe("subscribe", () => {
  it("delivers committed events in order, once, and isolates faulty listeners", () => {
    const got: number[] = [];
    log.subscribe(() => {
      throw new Error("bad listener");
    });
    const unsub = log.subscribe((evs) => got.push(...evs.map((e) => e.seq)));
    log.append([{ type: "a" }, { type: "b" }]);
    log.append([{ type: "c" }]);
    expect(got).toEqual([1, 2, 3]);
    unsub();
    log.append([{ type: "d" }]);
    expect(got).toEqual([1, 2, 3]);
  });
});

describe("compaction", () => {
  it("removes old events, never reuses seq, and expires stale cursors", () => {
    log.append([{ type: "old1" }, { type: "old2" }]);
    clock = 10_000;
    log.append([{ type: "new" }]);
    expect(log.compact(5_000)).toBe(2);
    expect(log.compactedThrough()).toBe(2);
    expect(log.readSince(2).map((e) => e.type)).toEqual(["new"]);
    expect(() => log.readSince(0)).toThrow(CursorExpiredError);
    expect(() => log.readSince(1)).toThrow(CursorExpiredError);
    expect(log.append([{ type: "later" }])[0]?.seq).toBe(4);
    expect(log.compact(5_000)).toBe(0);
  });
});

describe("schema", () => {
  it("refuses a database from a newer version", () => {
    db.exec("PRAGMA user_version=99");
    db.close();
    expect(() => openDb(join(dir, "gw.db"))).toThrow(/newer/);
    db = openDb(join(dir, "other.db"));
  });
});
