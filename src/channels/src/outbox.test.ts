import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PairingService } from "@clawnexus/pairing";
import { FakeProvider, SessionManager } from "@clawnexus/sessions";
import { EventLog, openDb, type Db } from "@clawnexus/store";
import { ChannelManager, FakeAdapter, Outbox, waitFor } from "./index.js";

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cn-out-"));
  db = openDb(join(dir, "g.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const T = { channel: "fake", accountId: "default", conversationId: "c1" };
const count = (where = "1=1"): number => (db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE ${where}`).get() as { n: number }).n;

describe("Outbox", () => {
  it("keeps the pieces of a reply in order and hands them out one at a time", () => {
    const o = new Outbox(db);
    expect(o.enqueue({ ...T, replyTo: "m1" }, ["one", "two", "three"])).toBe(true);
    const first = o.head("fake", "default", "c1")!;
    expect(first.text).toBe("one");
    expect(first.target.replyTo).toBe("m1"); // only the first piece points at the question
    o.done(first.id);
    const second = o.head("fake", "default", "c1")!;
    expect(second.text).toBe("two");
    expect(second.target.replyTo).toBeUndefined();
    expect(o.head("fake", "default", "other")).toBeUndefined();
  });

  it("counts an attempt before it is made, and fails the rest of a reply together", () => {
    const o = new Outbox(db);
    o.enqueue(T, ["a", "b"]);
    o.enqueue(T, ["later reply"]);
    const a = o.head("fake", "default", "c1")!;
    o.begin(a.id);
    expect(o.head("fake", "default", "c1")!.attempts).toBe(1);
    o.failGroup(a.group, "platform said no");
    expect(count("state = 'failed'")).toBe(2); // both pieces of that reply
    expect(o.head("fake", "default", "c1")!.text).toBe("later reply"); // the next reply is unaffected
  });

  it("gives up on a reply that has waited too long", () => {
    let now = 1000;
    const o = new Outbox(db, { now: () => now, expireMs: 5000 });
    o.enqueue(T, ["old news"]);
    now += 6000;
    expect(o.head("fake", "default", "c1")).toBeUndefined();
    expect(o.summary().failedRows[0]?.error).toMatch(/expired/);
  });

  it("refuses new replies when it is full, rather than growing without limit", () => {
    const o = new Outbox(db, { maxPending: 5, maxPerConversation: 3 });
    expect(o.enqueue(T, ["1", "2", "3"])).toBe(true);
    expect(o.enqueue(T, ["4"])).toBe(false); // this conversation is at its limit
    expect(o.enqueue({ ...T, conversationId: "c2" }, ["x", "y"])).toBe(true);
    expect(o.enqueue({ ...T, conversationId: "c3" }, ["z"])).toBe(false); // the outbox as a whole is full
    expect(count()).toBe(5);
  });

  it("shows the owner what failed without showing what was said", () => {
    const o = new Outbox(db);
    o.enqueue(T, ["a private answer"]);
    o.failGroup(o.head("fake", "default", "c1")!.group, "Telegram: chat not found");
    const s = o.summary();
    expect(s).toMatchObject({ pending: 0, failed: 1, byChannel: [{ channel: "fake", pending: 0, failed: 1 }] });
    expect(JSON.stringify(s)).not.toContain("private answer");
    expect(o.retryFailed()).toBe(1);
    expect(o.summary()).toMatchObject({ pending: 1, failed: 0 });
    o.failGroup(o.head("fake", "default", "c1")!.group, "again");
    expect(o.purge()).toBe(1);
    expect(count()).toBe(0);
  });

  it("forgets old failures when it starts, but not waiting replies", () => {
    let now = 1_000_000_000;
    const o = new Outbox(db, { now: () => now, keepFailedMs: 1000, expireMs: 10 ** 12 });
    o.enqueue(T, ["failed one"]);
    o.failGroup(o.head("fake", "default", "c1")!.group, "x");
    o.enqueue({ ...T, conversationId: "c2" }, ["waiting"]);
    now += 5000;
    o.sweep();
    expect(count("state = 'failed'")).toBe(0);
    expect(count("state = 'pending'")).toBe(1);
  });
});

describe("delivery that survives a restart", () => {
  function wire(adapters: FakeAdapter[], provider = new FakeProvider({ chunkSize: 1000 })): { manager: ChannelManager; events: EventLog; sessions: SessionManager; pairing: PairingService } {
    const events = new EventLog(db);
    const pairing = new PairingService(db, { audit: events });
    const sessions = new SessionManager(db, events, provider, { deltaFlushMs: 0 });
    const manager = new ChannelManager({ db, events, pairing, sessions, sendRetry: { attempts: 3, baseMs: 5 }, noticeCooldownMs: 1000 });
    for (const a of adapters) manager.register(a);
    return { manager, events, sessions, pairing };
  }

  it("delivers replies that were still waiting when the Gateway stopped, in order, once it is back", async () => {
    const a1 = new FakeAdapter("fake");
    const one = wire([a1]);
    await one.manager.start();
    // the Gateway has answered, but the platform is down and then the Gateway stops
    a1.failSends = 100;
    one.manager.outbox.enqueue(T, ["first piece", "second piece"]);
    one.manager.outbox.enqueue(T, ["a second reply"]);
    await one.manager.stop();
    one.sessions.close();
    expect(count("state = 'pending'")).toBeGreaterThan(0);

    const a2 = new FakeAdapter("fake");
    const two = wire([a2]);
    await two.manager.start();
    await waitFor(() => a2.sent.length === 3);
    expect(a2.sent.map((s) => s.text)).toEqual(["first piece", "second piece", "a second reply"]);
    expect(count()).toBe(0);
    await two.manager.stop();
  });

  it("holds replies for a channel that is not there, and sends them when it comes back", async () => {
    const a = new FakeAdapter("fake");
    const w = wire([a]);
    await w.manager.start();
    await w.manager.detach("fake"); // the plugin stopped
    w.manager.outbox.enqueue(T, ["while you were away"]);
    await new Promise((r) => setTimeout(r, 100));
    expect(a.sent).toEqual([]);
    expect(count("state = 'pending'")).toBe(1);

    const back = new FakeAdapter("fake");
    await w.manager.attach(back);
    await waitFor(() => back.sent.length === 1);
    expect(back.sent[0]?.text).toBe("while you were away");
    expect(count()).toBe(0);
    await w.manager.stop();
  });

  it("keeps order across a failure: nothing later is sent until the earlier piece gets through", async () => {
    const a = new FakeAdapter("fake");
    const w = wire([a]);
    await w.manager.start();
    a.failSends = 2;
    w.manager.outbox.enqueue(T, ["one", "two"]);
    w.manager.outbox.enqueue(T, ["three"]);
    // kick the delivery the way a reply does
    (w.manager as unknown as { resume(): void }).resume();
    await waitFor(() => a.sent.length === 3);
    expect(a.sent.map((s) => s.text)).toEqual(["one", "two", "three"]);
    await w.manager.stop();
  });

  it("gives up on a reply after the configured attempts, records it, and carries on with the next", async () => {
    const a = new FakeAdapter("fake");
    const w = wire([a]);
    await w.manager.start();
    a.failSends = 3; // exactly the three attempts for the first reply
    w.manager.outbox.enqueue(T, ["doomed"]);
    w.manager.outbox.enqueue(T, ["fine"]);
    (w.manager as unknown as { resume(): void }).resume();
    await waitFor(() => a.sent.length === 1);
    expect(a.sent[0]?.text).toBe("fine");
    expect(w.manager.outbox.summary()).toMatchObject({ pending: 0, failed: 1 });
    expect(w.events.readSince(0, { limit: 1000 }).some((e) => e.type === "channel.send_failed")).toBe(true);
    await w.manager.stop();
  });

  it("does not write pairing codes or other notices into the outbox", async () => {
    const a = new FakeAdapter("fake");
    const w = wire([a]);
    await w.manager.start();
    a.failSends = 100; // even while the platform is down
    await a.inject({ senderId: "stranger", messageId: "m1", text: "hello" });
    await new Promise((r) => setTimeout(r, 150));
    expect(count()).toBe(0);
    expect(JSON.stringify(db.prepare("SELECT * FROM outbox").all())).not.toMatch(/pairing code/i);
    await w.manager.stop();
  });

  it("answers over the outbox: the reply to a paired sender is stored before it is sent", async () => {
    const a = new FakeAdapter("fake");
    const w = wire([a]);
    await w.manager.start();
    w.pairing.registerOwner({ channel: "fake", accountId: "default", externalId: "owner1" });
    a.failSends = 1;
    await a.inject({ senderId: "owner1", messageId: "m1", text: "hi" });
    await waitFor(() => a.sent.length === 1);
    expect(a.sent[0]?.text).toContain("hi");
    expect(count()).toBe(0);
    await w.manager.stop();
  });

  it("tells people whose answer was cut short by a restart to ask again", async () => {
    const a1 = new FakeAdapter("fake");
    const hang = new FakeProvider({ hang: true });
    const one = wire([a1], hang);
    await one.manager.start();
    one.pairing.registerOwner({ channel: "fake", accountId: "default", externalId: "owner1" });
    await a1.inject({ senderId: "owner1", messageId: "m1", text: "a long question" });
    await waitFor(() => hang.calls.length === 1); // the run is under way
    await one.manager.stop(); // the Gateway goes away mid-answer
    // (the session manager of the dead process is simply abandoned, as it would be)

    const a2 = new FakeAdapter("fake");
    const two = wire([a2]); // a new process: the session manager marks the run failed
    await two.manager.start();
    await waitFor(() => a2.sent.length === 1);
    expect(a2.sent[0]).toMatchObject({ conversationId: "owner1", text: expect.stringMatching(/restarted.*send your message again/) });
    await two.manager.stop();

    // and a further restart does not tell them again
    const a3 = new FakeAdapter("fake");
    const three = wire([a3]);
    await three.manager.start();
    await new Promise((r) => setTimeout(r, 200));
    expect(a3.sent).toEqual([]);
    await three.manager.stop();
  });

  it("does not notify about runs from before it was ever running (an upgrade), or about runs that were not on a channel", async () => {
    const events = new EventLog(db);
    const sessions = new SessionManager(db, events, new FakeProvider({ hang: true }), { deltaFlushMs: 0 });
    const s = sessions.getOrCreate({ channel: "local", conversation: "main", scope: "owner" });
    sessions.send(s.id, "from the terminal");
    await new Promise((r) => setTimeout(r, 50));
    sessions.close();

    const a = new FakeAdapter("local");
    const w = wire([a]); // recovery marks the CLI run failed; there is no channel conversation to tell
    await w.manager.start();
    await new Promise((r) => setTimeout(r, 150));
    expect(a.sent).toEqual([]);
    await w.manager.stop();
  });
});
