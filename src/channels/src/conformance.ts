import type { Bed } from "./testing.js";
import type { InboundOutcome } from "./types.js";

/** A person on the platform being tested. */
export interface ConformanceUser {
  /** The sender id the router sees. */
  senderId: string;
  conversationId: string;
  say(text: string, o?: { messageId?: string; isGroup?: boolean; mentionsBot?: boolean; groupId?: string }): Promise<void>;
  /** What the platform delivered to this user, in order. */
  received(): string[];
}

export interface ConformanceBed {
  bed: Bed;
  channelId: string;
  maxTextChars: number;
  groupsSupported: boolean;
  user(name: string): ConformanceUser;
  /** Hand the router a raw message as the adapter would. Present when the adapter can be driven that way. */
  deliverRaw?: (m: Record<string, unknown>) => Promise<InboundOutcome>;
  /** Make the next n sends fail on the platform side. */
  failSends?: (n: number) => void;
  teardown(): Promise<void>;
}

/** How a test run is configured. The limits are fixed so every adapter is held to the same numbers. */
export interface ConformanceSetup {
  noProvider?: boolean;
}
export const CONFORMANCE_LIMITS = { senderBurst: 3, senderPerMinute: 3 } as const;

export interface TestApi {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => Promise<void>, timeoutMs?: number): void;
  expect: (v: unknown) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const CODE = /\b([2-9A-HJ-NP-Z]{8})\b/;

async function eventually(pred: () => boolean, what: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const settle = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The behaviours every channel must show (docs/05 section 2). Pass vitest's `describe`, `it` and `expect`;
 * `make` builds a fresh, isolated setup around the adapter under test. A new adapter passes when this suite does.
 */
export function defineConformance(t: TestApi, name: string, make: (s?: ConformanceSetup) => Promise<ConformanceBed>): void {
  const { expect } = t;
  const run = (title: string, fn: (c: ConformanceBed) => Promise<void>, setup?: ConformanceSetup): void =>
    t.it(
      title,
      async () => {
        const c = await make(setup);
        try {
          await fn(c);
        } finally {
          await c.teardown();
        }
      },
      30_000,
    );

  /** Walk a user through pairing and the owner's approval. */
  async function pair(c: ConformanceBed, name: string): Promise<ConformanceUser> {
    const u = c.user(name);
    await u.say("hello?", { messageId: `pair-${name}` });
    await eventually(() => u.received().length >= 1, `${name}'s pairing prompt`);
    const code = CODE.exec(u.received()[0] ?? "")?.[1];
    expect(code).toBeTruthy();
    c.bed.pairing.approve(code as string);
    return u;
  }

  t.describe(`channel conformance: ${name}`, () => {
    run("reports its status", async (c) => {
      const info = c.bed.manager.list().find((x) => x.id === c.channelId);
      expect(info?.status.state).toBe("connected");
      expect(info?.capabilities.maxTextChars).toBeGreaterThan(0);
    });

    run("an unknown sender gets a pairing prompt and the assistant never runs", async (c) => {
      const a = c.user("alice");
      await a.say("hello there", { messageId: "m1" });
      await eventually(() => a.received().length === 1, "the pairing prompt");
      const prompt = a.received()[0] as string;
      expect(prompt).toMatch(/approval|approve/i);
      const code = CODE.exec(prompt)?.[1] as string;
      expect(code).toBeTruthy();
      await settle();
      expect(c.bed.provider?.calls ?? []).toHaveLength(0);
      expect(c.bed.sessions?.list() ?? []).toHaveLength(0);
      // the code goes to the sender only: it is never written to the event log
      const log = JSON.stringify(c.bed.events.readSince(0, { limit: 5000 }));
      expect(log).not.toContain(code);
    });

    run("the same stranger is not prompted again and again", async (c) => {
      const a = c.user("alice");
      for (let i = 0; i < 4; i++) await a.say(`hi ${i}`, { messageId: `m${i}` });
      await settle(300);
      expect(a.received()).toHaveLength(1);
    });

    run("once the owner approves, the sender is served as a guest", async (c) => {
      const a = await pair(c, "alice");
      await a.say("what is 2+2?", { messageId: "q1" });
      await eventually(() => a.received().some((m) => m.includes("echo: what is 2+2?")), "the answer");
      const s = c.bed.sessions?.list({ channel: c.channelId }) ?? [];
      expect(s).toHaveLength(1);
      expect(s[0]?.principal).toBe("guest");
      expect(c.bed.provider?.calls[0]?.source).toMatchObject({ channel: c.channelId, principal: "guest" });
    });

    run("the owner is served as the owner, and a demoted owner is served as a guest again", async (c) => {
      const o = c.user("olivia");
      c.bed.pairing.registerOwner({ channel: c.channelId, accountId: "default", externalId: o.senderId });
      await o.say("hello", { messageId: "o1" });
      await eventually(() => o.received().length >= 1, "an answer for the owner");
      const sessions = c.bed.sessions!;
      expect(sessions.list({ channel: c.channelId })[0]?.principal).toBe("owner");
      // demote: remove and re-pair as a guest
      const sender = c.bed.pairing.list().find((s) => s.externalId === o.senderId)!;
      c.bed.pairing.revoke(sender.id);
      await o.say("again", { messageId: "o2" });
      await eventually(() => o.received().some((m) => /approval|approve/i.test(m)), "a new pairing prompt");
      const code = CODE.exec(o.received().find((m) => /approval|approve/i.test(m)) ?? "")?.[1] as string;
      c.bed.pairing.approve(code);
      await o.say("third", { messageId: "o3" });
      await eventually(() => o.received().some((m) => m.includes("echo: third")), "an answer after re-pairing");
      expect(sessions.list({ channel: c.channelId })[0]?.principal).toBe("guest");
    });

    run("a platform message delivered twice is processed once", async (c) => {
      const a = await pair(c, "alice");
      await a.say("only once", { messageId: "dup-1" });
      await a.say("only once", { messageId: "dup-1" });
      await a.say("only once", { messageId: "dup-1" });
      await eventually(() => a.received().some((m) => m.includes("echo: only once")), "the answer");
      await settle(300);
      expect(c.bed.provider?.calls).toHaveLength(1);
      expect(a.received().filter((m) => m.includes("echo: only once"))).toHaveLength(1);
    });

    run("message text is cleaned of control characters before it reaches the model", async (c) => {
      const a = await pair(c, "alice");
      await a.say("he\u0000llo\u0007 wor\u001bld", { messageId: "ctl-1" });
      await eventually(() => (c.bed.provider?.calls.length ?? 0) === 1, "the run");
      const last = c.bed.provider!.calls[0]!.messages.at(-1)!;
      expect(last.content).toBe("hello world");
    });

    run("a very long reply is split to fit the platform, in order", async (c) => {
      const a = await pair(c, "alice");
      // long enough to need at least three messages on this platform
      const count = Math.max(150, Math.ceil((c.maxTextChars * 2.5) / 5));
      const words = Array.from({ length: count }, (_, i) => `w${i}`).join(" ");
      await a.say(words, { messageId: "long-1" });
      await eventually(() => a.received().join(" ").includes(`w${count - 1}`), "the whole reply");
      const parts = a.received().filter((m) => m.startsWith("echo:") || m.startsWith("w") || m.includes("w1"));
      expect(parts.length).toBeGreaterThan(1);
      for (const p of a.received()) expect(p.length).toBeLessThanOrEqual(c.maxTextChars);
      const rebuilt = a.received().slice(1).join(" ").replace(/^echo:\s*/, "");
      expect(a.received().join(" ").replace(/echo:\s*/, "").split(/\s+/).filter((w) => /^w\d+$/.test(w))).toEqual(words.split(" "));
      expect(rebuilt.length).toBeGreaterThan(0);
    });

    run("one sender cannot flood the assistant", async (c) => {
      const a = await pair(c, "alice");
      for (let i = 0; i < 8; i++) await a.say(`msg ${i}`, { messageId: `f${i}` });
      await eventually(() => a.received().some((m) => /too quickly|slow down/i.test(m)), "the slow-down notice");
      await settle(300);
      expect(c.bed.provider?.calls.length).toBeLessThanOrEqual(CONFORMANCE_LIMITS.senderBurst);
      expect(a.received().filter((m) => /too quickly|slow down/i.test(m))).toHaveLength(1);
    });

    run("a run started from the command line is never sent out to the channel", async (c) => {
      const a = await pair(c, "alice");
      await a.say("first", { messageId: "x1" });
      await eventually(() => a.received().some((m) => m.includes("echo: first")), "the first answer");
      const before = a.received().length;
      const session = c.bed.sessions!.list({ channel: c.channelId })[0]!;
      c.bed.sessions!.send(session.id, "owner typing at the terminal", { sender: "owner" });
      await c.bed.sessions!.idle();
      await settle(300);
      expect(a.received()).toHaveLength(before);
    });

    run("without a model it says so politely instead of failing", async (c) => {
      const a = await pair(c, "alice");
      await a.say("anyone there?", { messageId: "np1" });
      await eventually(() => a.received().some((m) => /not ready/i.test(m)), "the not-ready notice");
    }, { noProvider: true });

    run("a failing platform is retried, then reported, and does not break later messages", async (c) => {
      if (!c.failSends) return;
      const a = await pair(c, "alice");
      c.failSends(2);
      await a.say("retry me", { messageId: "r1" });
      await eventually(() => a.received().some((m) => m.includes("echo: retry me")), "the answer after retries");
      c.failSends(10);
      await a.say("lost", { messageId: "r2" });
      await eventually(() => c.bed.events.readSince(0, { limit: 5000 }).some((e) => e.type === "channel.send_failed"), "the failure record");
      c.failSends(0);
      await a.say("recovered", { messageId: "r3" });
      await eventually(() => a.received().some((m) => m.includes("echo: recovered")), "service to resume");
    });

    run("groups: only when mentioned, and always at guest level, even for the owner", async (c) => {
      if (!c.groupsSupported) return;
      const o = c.user("olivia");
      c.bed.pairing.registerOwner({ channel: c.channelId, accountId: "default", externalId: o.senderId });
      await o.say("chatter nobody asked for", { messageId: "g1", isGroup: true, mentionsBot: false, groupId: "team" });
      await settle(300);
      expect(c.bed.provider?.calls ?? []).toHaveLength(0);
      await o.say("hey bot, summarise", { messageId: "g2", isGroup: true, mentionsBot: true, groupId: "team" });
      await eventually(() => (c.bed.provider?.calls.length ?? 0) === 1, "the group run");
      const s = c.bed.sessions!.list({ channel: c.channelId });
      expect(s).toHaveLength(1);
      expect(s[0]?.principal).toBe("guest");
      expect(s[0]?.scope).toBe("group");
    });

    run("an adapter cannot speak for another channel or invent privileges", async (c) => {
      if (!c.deliverRaw) return;
      const base = { accountId: "default", conversationId: "c1", senderId: "mallory", messageId: "evil-1", text: "hi", isGroup: false, mentionsBot: true };
      expect((await c.deliverRaw({ ...base, channel: "telegram" })).result).toBe("invalid");
      expect((await c.deliverRaw({ ...base, role: "owner" })).result).toBe("invalid");
      expect((await c.deliverRaw({ ...base, senderId: "bad\nid" })).result).toBe("invalid");
      expect((await c.deliverRaw({ ...base, senderId: "" })).result).toBe("invalid");
      expect((await c.deliverRaw({ ...base, accountId: "../x" })).result).toBe("invalid");
      expect((await c.deliverRaw({ ...base, text: 5 })).result).toBe("invalid");
      // and nothing above produced a sender, a session or a run
      expect(c.bed.pairing.list()).toHaveLength(0);
      expect(c.bed.sessions?.list() ?? []).toHaveLength(0);
    });

    run("attachments are noted and dropped, never passed on", async (c) => {
      if (!c.deliverRaw) return;
      const a = await pair(c, "alice");
      const out = await c.deliverRaw({ accountId: "default", conversationId: a.conversationId, senderId: a.senderId, messageId: "att-1", text: "see file", isGroup: false, mentionsBot: true, attachments: [{ name: "x.exe", mimeType: "application/x-msdownload", bytes: 5 }] });
      expect(out.result).toBe("accepted");
      expect(c.bed.events.readSince(0, { limit: 5000 }).some((e) => e.type === "channel.attachments_dropped")).toBe(true);
      await eventually(() => (c.bed.provider?.calls.length ?? 0) === 1, "the run");
      expect(JSON.stringify(c.bed.provider!.calls[0]!.messages)).not.toContain("x.exe");
    });
  });
}
