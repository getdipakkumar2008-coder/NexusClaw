import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventLog, openDb, type Db } from "@clawnexus/store";
import { FakeProvider, type Provider, SessionError, SessionManager, type SessionManagerOptions } from "./index.js";

let dir: string;
let db: Db;
let log: EventLog;
let mgr: SessionManager | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cn-sessions-"));
  db = openDb(join(dir, "t.db"), { synchronous: "NORMAL" });
  log = new EventLog(db);
});
afterEach(async () => {
  await mgr?.close();
  mgr = undefined;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const make = (p: Provider = new FakeProvider(), o: SessionManagerOptions = {}): SessionManager => {
  mgr = new SessionManager(db, log, p, { deltaFlushMs: 0, ...o });
  return mgr;
};
const key = (scope: string) => ({ channel: "test", conversation: "c1", scope });
const types = (session?: string): string[] => log.readSince(0, session === undefined ? {} : { session }).map((e) => e.type);

describe("sessions", () => {
  it("returns the same session for the same key and different ones otherwise", () => {
    const m = make();
    const a = m.getOrCreate(key("alice"));
    expect(m.getOrCreate(key("alice")).id).toBe(a.id);
    expect(m.getOrCreate(key("bob")).id).not.toBe(a.id);
    expect(m.list()).toHaveLength(2);
  });

  it("rejects malformed keys", () => {
    const m = make();
    expect(() => m.getOrCreate({ channel: "", conversation: "c", scope: "s" })).toThrow(SessionError);
    expect(() => m.getOrCreate({ channel: "x", conversation: "c", scope: "s".repeat(300) })).toThrow(SessionError);
  });

  it("unknown sessions are NOT_FOUND", () => {
    const m = make();
    expect(() => m.get("s_nope")).toThrow(/unknown session/);
    expect(() => m.send("s_nope", "hi")).toThrow(SessionError);
  });
});

describe("context for the model", () => {
  it("is asked for per session on every run and handed to the provider", async () => {
    const p = new FakeProvider();
    const m = make(p, { context: (s) => (s.scope === "alice" ? "Alice likes tea" : undefined) });
    const a = m.getOrCreate(key("alice"));
    const b = m.getOrCreate(key("bob"));
    m.send(a.id, "hi");
    m.send(b.id, "hi");
    await m.idle();
    expect(p.calls.find((c) => c.sessionId === a.id)?.system).toBe("Alice likes tea");
    expect(p.calls.find((c) => c.sessionId === b.id)).not.toHaveProperty("system");
  });

  it("never stops a run when the context cannot be produced", async () => {
    const p = new FakeProvider();
    const m = make(p, {
      context: () => {
        throw new Error("disk on fire");
      },
    });
    const s = m.getOrCreate(key("alice"));
    const { runId } = m.send(s.id, "hi");
    await m.idle();
    expect(m.runStatus(runId)?.status).toBe("completed");
    expect(p.calls[0]).not.toHaveProperty("system");
  });
});

describe("runs", () => {
  it("runs a message to completion and stores the transcript and events", async () => {
    const m = make();
    const s = m.getOrCreate(key("alice"));
    const r = m.send(s.id, "hello", { sender: "alice" });
    expect(r.queued).toBe(0);
    await m.idle();
    expect(m.runStatus(r.runId)?.status).toBe("completed");
    const msgs = m.messages(s.id);
    expect(msgs.map((x) => [x.role, x.content])).toEqual([
      ["user", "hello"],
      ["assistant", "echo: hello"],
    ]);
    expect(msgs[0]?.sender).toBe("alice");
    expect(types(s.id)).toEqual(["session.created", "message.inbound", "run.started", "run.delta", "run.delta", "message.outbound", "run.completed"]);
  });

  it("streams deltas in order that add up to the reply", async () => {
    const m = make(new FakeProvider({ reply: () => "abcdefghijklmnopqrstuvwxyz", chunkSize: 5 }));
    const s = m.getOrCreate(key("a"));
    m.send(s.id, "x");
    await m.idle();
    const deltas = log
      .readSince(0, { session: s.id })
      .filter((e) => e.type === "run.delta")
      .map((e) => (e.data as { text: string }).text);
    expect(deltas.join("")).toBe("abcdefghijklmnopqrstuvwxyz");
    expect(deltas.length).toBe(6);
  });

  it("coalesces deltas when the flush interval is long", async () => {
    const m = make(new FakeProvider({ reply: () => "abcdefghijklmnopqrstuvwxyz", chunkSize: 2 }), { deltaFlushMs: 60_000, now: () => 1000 });
    const s = m.getOrCreate(key("a"));
    m.send(s.id, "x");
    await m.idle();
    const deltas = log.readSince(0, { session: s.id }).filter((e) => e.type === "run.delta");
    expect(deltas.length).toBeLessThanOrEqual(2);
    expect(deltas.map((e) => (e.data as { text: string }).text).join("")).toBe("abcdefghijklmnopqrstuvwxyz");
  });

  it("runs one at a time per session, in order, with later inputs queued", async () => {
    const order: string[] = [];
    const p = new FakeProvider({
      delayMs: 5,
      reply: (msgs) => {
        order.push(msgs[msgs.length - 1]?.content ?? "");
        return "ok";
      },
    });
    const m = make(p);
    const s = m.getOrCreate(key("a"));
    const r1 = m.send(s.id, "one");
    const r2 = m.send(s.id, "two");
    const r3 = m.send(s.id, "three");
    expect([r1.queued, r2.queued, r3.queued]).toEqual([0, 1, 2]);
    await m.idle();
    expect(order).toEqual(["one", "two", "three"]);
    // each run only saw messages up to its own input
    expect(p.calls.map((c) => c.messages.filter((x) => x.role === "user").length)).toEqual([1, 2, 3]);
    const started = log.readSince(0, { session: s.id }).filter((e) => e.type === "run.started").map((e) => (e.data as { runId: string }).runId);
    expect(started).toEqual([r1.runId, r2.runId, r3.runId]);
  });

  it("bounds the queue", () => {
    const m = make(new FakeProvider({ hang: true }), { maxQueue: 2 });
    const s = m.getOrCreate(key("a"));
    m.send(s.id, "1"); // starts running
    m.send(s.id, "2");
    m.send(s.id, "3");
    expect(() => m.send(s.id, "4")).toThrow(/too many pending/);
  });

  it("limits concurrent runs across sessions", async () => {
    let live = 0;
    let peak = 0;
    const p: Provider = {
      name: "counting",
      async *run() {
        live++;
        peak = Math.max(peak, live);
        try {
          await new Promise((r) => setTimeout(r, 15));
          yield { type: "delta", text: "ok" };
        } finally {
          live--;
        }
      },
    };
    const m = make(p, { maxConcurrentRuns: 2 });
    for (let i = 0; i < 6; i++) m.send(m.getOrCreate(key(`u${i}`)).id, "hi");
    await m.idle();
    expect(m.list().every((s) => m.messages(s.id).length === 2)).toBe(true);
    expect(peak).toBe(2);
  });

  it("marks a failing run failed and keeps the session usable", async () => {
    let n = 0;
    const m = make(
      new FakeProvider({
        reply: () => "partial reply",
        failWith: "model exploded",
      }),
    );
    const s = m.getOrCreate(key("a"));
    const r = m.send(s.id, "x");
    await m.idle();
    n++;
    expect(m.runStatus(r.runId)).toEqual({ status: "failed", error: "model exploded" });
    expect(m.messages(s.id).map((x) => x.role)).toEqual(["user"]); // no assistant message stored
    expect(types(s.id)).toContain("run.failed");
    expect(n).toBe(1);
    expect(() => m.send(s.id, "again")).not.toThrow();
  });

  it("times out a hung provider", async () => {
    const m = make(new FakeProvider({ hang: true }), { runTimeoutMs: 30 });
    const s = m.getOrCreate(key("a"));
    const r = m.send(s.id, "x");
    await m.idle();
    expect(m.runStatus(r.runId)).toEqual({ status: "failed", error: "run timed out" });
  });

  it("cancels the running run and drops queued ones", async () => {
    const m = make(new FakeProvider({ hang: true }));
    const s = m.getOrCreate(key("a"));
    const r1 = m.send(s.id, "1");
    const r2 = m.send(s.id, "2");
    expect(m.cancel(s.id)).toBe(2);
    await m.idle();
    expect(m.runStatus(r1.runId)?.status).toBe("cancelled");
    expect(m.runStatus(r2.runId)?.status).toBe("cancelled");
    // next message works
    const m2 = m.send(s.id, "3");
    expect(m2.queued).toBe(0);
    m.cancel(s.id);
  });

  it("passes an abort signal to the provider", async () => {
    const p = new FakeProvider({ hang: true });
    const m = make(p);
    const s = m.getOrCreate(key("a"));
    m.send(s.id, "x");
    expect(p.calls[0]?.signal.aborted).toBe(false);
    m.cancel(s.id);
    await m.idle();
    expect(p.calls[0]?.signal.aborted).toBe(true);
  });

  it("fails a reply that exceeds the size cap", async () => {
    const m = make(new FakeProvider({ reply: () => "x".repeat(1000) }), { maxReplyBytes: 100 });
    const s = m.getOrCreate(key("a"));
    const r = m.send(s.id, "x");
    await m.idle();
    expect(m.runStatus(r.runId)?.status).toBe("failed");
    expect(m.messages(s.id)).toHaveLength(1);
  });

  it("rejects empty and oversized messages", () => {
    const m = make(new FakeProvider(), { maxMessageBytes: 10 });
    const s = m.getOrCreate(key("a"));
    expect(() => m.send(s.id, "   ")).toThrow(/empty/);
    expect(() => m.send(s.id, "x".repeat(11))).toThrow(/exceeds/);
  });

  it("marks interrupted runs failed on restart instead of replaying them", async () => {
    const m1 = make(new FakeProvider({ hang: true }));
    const s = m1.getOrCreate(key("a"));
    const r = m1.send(s.id, "x");
    // simulate a crash: a fresh manager over the same database while the old run is still 'running'
    const m2 = new SessionManager(db, log, new FakeProvider(), { deltaFlushMs: 0 });
    expect(m2.runStatus(r.runId)).toEqual({ status: "failed", error: "interrupted by restart" });
    await m2.close();
  });

  it("refuses new work after close", async () => {
    const m = make();
    const s = m.getOrCreate(key("a"));
    await m.close();
    expect(() => m.send(s.id, "x")).toThrow(/shut down/);
  });
});

describe("isolation", () => {
  it("never shows one session's history to another (FR-SES-1)", async () => {
    const p = new FakeProvider();
    const m = make(p);
    const alice = m.getOrCreate(key("alice"));
    const bob = m.getOrCreate(key("bob"));
    m.send(alice.id, "alice-secret-123", { sender: "alice" });
    await m.idle();
    m.send(bob.id, "hello from bob", { sender: "bob" });
    await m.idle();
    const bobCall = p.calls.find((c) => c.sessionId === bob.id);
    expect(JSON.stringify(bobCall?.messages)).not.toContain("alice-secret");
    expect(m.messages(bob.id).some((x) => x.content.includes("alice-secret"))).toBe(false);
    expect(types(bob.id).length).toBeGreaterThan(0);
    expect(JSON.stringify(log.readSince(0, { session: bob.id }))).not.toContain("alice-secret");
  });

  it("limits the history handed to the provider", async () => {
    const p = new FakeProvider();
    const m = make(p, { historyLimit: 3 });
    const s = m.getOrCreate(key("a"));
    for (let i = 0; i < 4; i++) {
      m.send(s.id, `m${i}`);
      await m.idle();
    }
    expect(p.calls[3]?.messages.map((x) => x.content)).toEqual(["m2", "echo: m2", "m3"]);
  });
});

describe("transcripts", () => {
  it("round-trips through JSONL export and import (FR-SES-2)", async () => {
    const m = make();
    const s = m.getOrCreate(key("alice"));
    m.send(s.id, 'say "hi"\nand a second line, with unicode: héllo ✓', { sender: "alice" });
    await m.idle();
    const text = m.exportJsonl(s.id);
    const before = m.exportTranscript(s.id);
    m.delete(s.id);
    const again = m.importJsonl(text);
    expect(m.exportTranscript(again.id)).toEqual(before);
    expect(() => m.importJsonl(text)).toThrow(/already exists/);
  });

  it("rejects malformed or oversized imports", () => {
    const m = make();
    expect(() => m.importJsonl("")).toThrow(SessionError);
    expect(() => m.importJsonl("not json")).toThrow(/header/);
    const head = JSON.stringify({ t: "session", version: 1, channel: "c", conversation: "c", scope: "s", createdAt: 1 });
    expect(() => m.importJsonl(`${head}\n{"t":"message","role":"root","sender":"","content":"x","ts":1}`)).toThrow(/line 2/);
    expect(() => m.importJsonl(`${head}\n{"t":"message","role":"user","sender":"","content":"x","ts":1,"extra":1}`)).toThrow(/line 2/);
  });

  it("exports Markdown", async () => {
    const m = make();
    const s = m.getOrCreate(key("a"));
    m.send(s.id, "hi", { sender: "a" });
    await m.idle();
    const md = m.exportMarkdown(s.id);
    expect(md).toContain("**user (a)**");
    expect(md).toContain("echo: hi");
  });

  it("deleting a session leaves no messages, runs or events behind", async () => {
    const m = make();
    const s = m.getOrCreate(key("a"));
    m.send(s.id, "private-text");
    await m.idle();
    m.delete(s.id);
    expect(() => m.get(s.id)).toThrow(SessionError);
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 0 });
    expect(JSON.stringify(log.readSince(0))).not.toContain("private-text");
  });

  it("deleting a session while a run is active is safe", async () => {
    const m = make(new FakeProvider({ hang: true }));
    const s = m.getOrCreate(key("a"));
    m.send(s.id, "x");
    m.delete(s.id);
    await m.idle();
    expect(m.list()).toHaveLength(0);
  });
});
