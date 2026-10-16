import { describe, expect, it } from "vitest";
import { CONFORMANCE_LIMITS, defineConformance, type ConformanceBed, type ConformanceSetup } from "./conformance.js";
import { chunkText } from "./manager.js";
import { FakeAdapter, createBed, waitFor } from "./testing.js";

async function fakeBed(setup?: ConformanceSetup): Promise<ConformanceBed> {
  const adapter = new FakeAdapter("fake", { maxTextChars: 200 });
  const bed = await createBed({
    adapters: [adapter],
    ...(setup?.noProvider ? { provider: null } : {}),
    manager: { senderBurst: CONFORMANCE_LIMITS.senderBurst, senderPerMinute: CONFORMANCE_LIMITS.senderPerMinute },
  });
  return {
    bed,
    channelId: "fake",
    maxTextChars: 200,
    groupsSupported: true,
    user: (name) => ({
      senderId: name,
      conversationId: name,
      async say(text, o = {}) {
        await adapter.inject({
          senderId: name,
          messageId: o.messageId ?? `${name}-${Math.random()}`,
          text,
          isGroup: o.isGroup ?? false,
          mentionsBot: o.mentionsBot ?? true,
          ...(o.isGroup ? { conversationId: o.groupId ?? "group-1" } : {}),
        });
      },
      received: () => adapter.sent.filter((s) => s.conversationId === name).map((s) => s.text),
    }),
    deliverRaw: (m) => adapter.host.deliver(m),
    failSends: (n) => {
      adapter.failSends = n;
    },
    teardown: () => bed.teardown(),
  };
}

defineConformance({ describe, it, expect }, "scripted platform", fakeBed);

describe("chunkText", () => {
  it("keeps short text whole and splits long text at natural boundaries", () => {
    expect(chunkText("short", 100)).toEqual(["short"]);
    const para = `${"a".repeat(60)}\n\n${"b".repeat(60)}`;
    expect(chunkText(para, 100)).toEqual(["a".repeat(60), "b".repeat(60)]);
    const words = Array.from({ length: 50 }, (_, i) => `word${i}`).join(" ");
    const parts = chunkText(words, 40);
    expect(parts.every((p) => p.length <= 40)).toBe(true);
    expect(parts.join(" ")).toBe(words);
  });
  it("cuts unbroken text hard and never splits an emoji", () => {
    const s = "😀".repeat(30);
    const parts = chunkText(s, 11);
    expect(parts.join("")).toBe(s);
    for (const p of parts) expect([...p].every((ch) => ch === "😀")).toBe(true);
    expect(chunkText("x".repeat(25), 10).map((p) => p.length)).toEqual([10, 10, 5]);
  });
  it("never returns empty pieces", () => {
    expect(chunkText("   ", 10)).toEqual([]);
    expect(chunkText("a\n\n\n\n\nb", 3)).toEqual(["a", "b"]);
  });
});

describe("router details", () => {
  it("serves several senders without mixing their conversations", async () => {
    const adapter = new FakeAdapter();
    const bed = await createBed({ adapters: [adapter] });
    try {
      for (const n of ["ann", "bob"]) bed.pairing.registerOwner({ channel: "fake", accountId: "default", externalId: n });
      await adapter.inject({ senderId: "ann", messageId: "1", text: "my secret is plum" });
      await adapter.inject({ senderId: "bob", messageId: "2", text: "what did ann say?" });
      await waitFor(() => adapter.sent.length === 2);
      expect(bed.provider!.calls).toHaveLength(2);
      const bobsView = JSON.stringify(bed.provider!.calls.find((c) => JSON.stringify(c.messages).includes("what did ann say"))!.messages);
      expect(bobsView).not.toContain("plum");
      expect(bed.sessions!.list({ channel: "fake" })).toHaveLength(2);
    } finally {
      await bed.teardown();
    }
  });

  it("platform message ids are scoped to the account, and forgotten after the retention period", async () => {
    const adapter = new FakeAdapter();
    const bed = await createBed({ adapters: [adapter], manager: { dedupeRetentionMs: 1000, senderBurst: 100_000, senderPerMinute: 1_000_000, adapterBurst: 100_000, adapterPerSecond: 100_000 } });
    try {
      bed.pairing.registerOwner({ channel: "fake", accountId: "default", externalId: "ann" });
      bed.pairing.registerOwner({ channel: "fake", accountId: "other", externalId: "ann" });
      expect((await adapter.inject({ senderId: "ann", messageId: "same", text: "one" })).result).toBe("accepted");
      expect((await adapter.inject({ senderId: "ann", messageId: "same", text: "one" })).result).toBe("duplicate");
      expect((await adapter.inject({ senderId: "ann", accountId: "other", messageId: "same", text: "one" })).result).toBe("accepted");
      // the cleanup runs every 200 inserts; push past that after the retention period has elapsed
      bed.clock.now += 5000;
      for (let i = 0; i < 205; i++) await adapter.inject({ senderId: "ann", messageId: `filler-${i}`, text: `f${i}` });
      await bed.sessions!.idle();
      expect((await adapter.inject({ senderId: "ann", messageId: "same", text: "one again" })).result).toBe("accepted");
    } finally {
      await bed.teardown();
    }
  });

  it("a message with only control characters is ignored without side effects", async () => {
    const adapter = new FakeAdapter();
    const bed = await createBed({ adapters: [adapter] });
    try {
      bed.pairing.registerOwner({ channel: "fake", accountId: "default", externalId: "ann" });
      expect(await adapter.inject({ senderId: "ann", messageId: "e1", text: "\u0000\u0007  \n" })).toEqual({ result: "ignored", reason: "empty" });
      expect(bed.provider!.calls).toHaveLength(0);
    } finally {
      await bed.teardown();
    }
  });

  it("an oversized message gets a polite notice", async () => {
    const adapter = new FakeAdapter();
    const bed = await createBed({ adapters: [adapter] });
    try {
      bed.pairing.registerOwner({ channel: "fake", accountId: "default", externalId: "ann" });
      const out = await adapter.inject({ senderId: "ann", messageId: "big", text: "x".repeat(190_000) });
      expect(out).toMatchObject({ result: "invalid", reason: "too_long" });
      await waitFor(() => adapter.sent.some((s) => /too long/i.test(s.text)));
    } finally {
      await bed.teardown();
    }
  });

  it("a channel that fails to start is reported as degraded and the others still work", async () => {
    const bad = new FakeAdapter("broken");
    bad.start = async () => {
      throw new Error("bad token sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123");
    };
    const good = new FakeAdapter("fine");
    const bed = await createBed({ adapters: [bad, good] });
    try {
      const info = bed.manager.list();
      expect(info.find((i) => i.id === "broken")?.status.state).toBe("degraded");
      expect(JSON.stringify(info)).not.toContain("sk-ant-api03");
      expect(info.find((i) => i.id === "fine")?.status.state).toBe("connected");
      bed.pairing.registerOwner({ channel: "fine", accountId: "default", externalId: "ann" });
      expect((await good.inject({ senderId: "ann", messageId: "1", text: "hi" })).result).toBe("accepted");
    } finally {
      await bed.teardown();
    }
  });

  it("a stuck adapter cannot hold up shutdown", async () => {
    const slow = new FakeAdapter("slow");
    slow.send = () => new Promise(() => undefined);
    const bed = await createBed({ adapters: [slow], manager: { adapterTimeoutMs: 100 } });
    bed.pairing.registerOwner({ channel: "slow", accountId: "default", externalId: "ann" });
    await slow.inject({ senderId: "ann", messageId: "1", text: "hi" });
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    await bed.teardown();
    expect(Date.now() - t0).toBeLessThan(8000);
  });

  it("group policy can be turned off or limited to listed groups", async () => {
    const adapter = new FakeAdapter();
    const bed = await createBed({ adapters: [adapter], group: { groups: "all", allowedGroups: ["team"] } });
    try {
      bed.pairing.registerOwner({ channel: "fake", accountId: "default", externalId: "ann" });
      expect((await adapter.inject({ senderId: "ann", conversationId: "other", isGroup: true, messageId: "1", text: "hi", mentionsBot: false })).result).toBe("ignored");
      expect((await adapter.inject({ senderId: "ann", conversationId: "team", isGroup: true, messageId: "2", text: "hi", mentionsBot: false })).result).toBe("accepted");
      bed.manager.setPolicy("fake", { groups: "off" });
      expect((await adapter.inject({ senderId: "ann", conversationId: "team", isGroup: true, messageId: "3", text: "hi", mentionsBot: true })).result).toBe("ignored");
    } finally {
      await bed.teardown();
    }
  });

  it("a channel without group support ignores group traffic whatever the policy says", async () => {
    const adapter = new FakeAdapter("dm-only", { groups: false });
    const bed = await createBed({ adapters: [adapter], group: { groups: "all" } });
    try {
      bed.pairing.registerOwner({ channel: "dm-only", accountId: "default", externalId: "ann" });
      expect((await adapter.inject({ senderId: "ann", conversationId: "g", isGroup: true, messageId: "1", text: "hi" })).result).toBe("ignored");
    } finally {
      await bed.teardown();
    }
  });

  it("registration rejects bad or duplicate channel ids", async () => {
    const bed = await createBed({ adapters: [new FakeAdapter("ok-one")] });
    try {
      expect(() => bed.manager.register(new FakeAdapter("ok-one"))).toThrow(/already registered/);
      expect(() => bed.manager.register(new FakeAdapter("Bad Id"))).toThrow(/invalid channel id/);
      expect(() => bed.manager.register(new FakeAdapter("../x"))).toThrow(/invalid channel id/);
    } finally {
      await bed.teardown();
    }
  });

  it("a flood on one channel is cut off before it reaches pairing", async () => {
    const adapter = new FakeAdapter();
    const bed = await createBed({ adapters: [adapter], manager: { adapterBurst: 5, adapterPerSecond: 1 } });
    try {
      const outcomes = await Promise.all(Array.from({ length: 50 }, (_, i) => adapter.inject({ senderId: `s${i}`, messageId: `m${i}`, text: "hi" })));
      expect(outcomes.filter((o) => o.result === "limited").length).toBeGreaterThan(40);
      expect(bed.pairing.list().length).toBeLessThanOrEqual(6);
    } finally {
      await bed.teardown();
    }
  });
});
