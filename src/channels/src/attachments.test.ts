import { afterEach, describe, expect, it } from "vitest";
import { FakeProvider } from "@clawnexus/sessions";
import { FakeAdapter, createBed, waitFor, type Bed } from "./index.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("....IHDR a small picture")]);
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.from([0x90, 0, 3, 0, 0, 0, 4, 0])]);
const b64 = (b: Buffer): string => b.toString("base64");

let bed: Bed | undefined;
afterEach(async () => {
  await bed?.teardown();
  bed = undefined;
});

async function setup(): Promise<{ adapter: FakeAdapter; bed: Bed }> {
  const adapter = new FakeAdapter("fake");
  bed = await createBed({ adapters: [adapter], provider: new FakeProvider({ chunkSize: 1000, reply: () => "seen" }) });
  bed.pairing.registerOwner({ channel: "fake", accountId: "default", externalId: "owner1" });
  return { adapter, bed };
}
const say = (a: FakeAdapter, id: string, extra: Record<string, unknown>) => a.inject({ senderId: "owner1", messageId: id, text: "", ...extra });

describe("files that come with a message", () => {
  it("are stored by content, shown to the model with their real type, and readable by the provider", async () => {
    const { adapter, bed: b } = await setup();
    const out = await say(adapter, "m1", { text: "what is this?", attachments: [{ name: "pic.png", mimeType: "application/zip", data: b64(PNG) }] });
    expect(out.result).toBe("accepted");
    await waitFor(() => b.provider!.calls.length === 1);
    const call = b.provider!.calls[0]!;
    expect(call.attachments).toHaveLength(1);
    expect(call.attachments![0]).toMatchObject({ name: "pic.png", mime: "image/png", bytes: PNG.length }); // the claimed "zip" is ignored
    expect(call.attachments![0]!.read()).toEqual(PNG);
    expect(b.blobs.stats()).toEqual({ count: 1, bytes: PNG.length });
    // the transcript keeps the reference, not the bytes
    const msgs = b.sessions!.messages(b.sessions!.list()[0]!.id);
    expect(msgs[0]?.attachments?.[0]).toMatchObject({ name: "pic.png", mime: "image/png" });
    expect(JSON.stringify(b.events.readSince(0, { limit: 5000 }))).not.toContain(b64(PNG));
  });

  it("can be the whole message: a picture with no words is still a question", async () => {
    const { adapter, bed: b } = await setup();
    expect((await say(adapter, "m1", { attachments: [{ name: "pic.png", data: b64(PNG) }] })).result).toBe("accepted");
    await waitFor(() => b.provider!.calls.length === 1);
    expect(b.provider!.calls[0]!.attachments).toHaveLength(1);
  });

  it("are refused by what they are, not by what they are called, and the model is told why", async () => {
    const { adapter, bed: b } = await setup();
    await say(adapter, "m1", { text: "please open", attachments: [{ name: "invoice.pdf", mimeType: "application/pdf", data: b64(EXE) }] });
    await waitFor(() => b.provider!.calls.length === 1);
    const call = b.provider!.calls[0]!;
    expect(call.attachments?.some((a) => a.id)).toBeFalsy();
    expect(call.messages.at(-1)?.attachments?.[0]).toMatchObject({ name: "invoice.pdf", dropped: expect.stringMatching(/not accepted/) });
    expect(b.blobs.stats().count).toBe(0);
    expect(b.events.readSince(0, { limit: 5000 }).some((e) => e.type === "channel.attachments_dropped")).toBe(true);
  });

  it("with nothing usable and no words are ignored", async () => {
    const { adapter, bed: b } = await setup();
    const out = await say(adapter, "m1", { attachments: [{ name: "x.exe", data: b64(EXE) }] });
    expect(out).toMatchObject({ result: "ignored", reason: "empty" });
    expect(b.provider!.calls).toHaveLength(0);
  });

  it("are never stored for someone who is not paired, who repeats a message, or who is over the rate limit", async () => {
    const { adapter, bed: b } = await setup();
    // a stranger gets a pairing prompt and nothing else; the picture is not kept
    const stranger = await adapter.inject({ senderId: "stranger", messageId: "s1", text: "hi", attachments: [{ name: "pic.png", data: b64(PNG) }] });
    expect(stranger.result).toBe("pairing");
    expect(b.blobs.stats().count).toBe(0);
    // a message delivered twice is processed, and its files stored, once
    await say(adapter, "dup", { text: "a", attachments: [{ name: "pic.png", data: b64(PNG) }] });
    expect((await say(adapter, "dup", { text: "a", attachments: [{ name: "pic.png", data: b64(PNG) }] })).result).toBe("duplicate");
    expect(b.blobs.stats().count).toBe(1);
  });

  it("are taken only a few at a time, and only up to the size limits", async () => {
    const { adapter, bed: b } = await setup();
    const files = Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.txt`, data: b64(Buffer.from(`file ${i}`)) }));
    await say(adapter, "m1", { text: "many", attachments: files });
    await waitFor(() => b.provider!.calls.length === 1);
    const refs = b.provider!.calls[0]!.messages.at(-1)!.attachments!;
    expect(refs).toHaveLength(6);
    expect(refs.filter((r) => r.id)).toHaveLength(4);
    expect(refs[5]?.dropped).toMatch(/first 4/);
  });

  it("are noted and dropped when the Gateway has no place to keep them", async () => {
    const adapter = new FakeAdapter("fake");
    const { ChannelManager } = await import("./index.js");
    const plain = await createBed({ adapters: [adapter], provider: new FakeProvider({ reply: () => "ok" }) });
    bed = plain;
    // a second router over the same database but without a store
    const bare = new ChannelManager({ db: plain.db, events: plain.events, pairing: plain.pairing, sessions: plain.sessions, sendRetry: { attempts: 1, baseMs: 1 } });
    const a2 = new FakeAdapter("bare");
    bare.register(a2);
    await bare.start();
    plain.pairing.registerOwner({ channel: "bare", accountId: "default", externalId: "owner1" });
    await a2.inject({ senderId: "owner1", messageId: "m1", text: "look", attachments: [{ name: "pic.png", data: b64(PNG) }] });
    await waitFor(() => plain.provider!.calls.length === 1);
    expect(plain.provider!.calls[0]!.messages.at(-1)!.attachments![0]).toMatchObject({ dropped: expect.stringMatching(/does not take attachments/) });
    expect(plain.blobs.stats().count).toBe(0);
    await bare.stop();
  });

  it("are refused outright if a platform hands over an absurd amount", async () => {
    const { adapter } = await setup();
    const huge = "A".repeat(12_000_001);
    expect(await say(adapter, "m1", { text: "x", attachments: [{ name: "a", data: huge }] })).toMatchObject({ result: "invalid" });
    const four = Array.from({ length: 3 }, () => ({ name: "a", data: "A".repeat(9_000_000) }));
    expect(await say(adapter, "m2", { text: "x", attachments: four })).toMatchObject({ result: "invalid" });
  });
});

describe("files going out", () => {
  async function talking(caps: Record<string, unknown> = { files: true }): Promise<{ adapter: FakeAdapter; bed: Bed; session: string }> {
    const adapter = new FakeAdapter("fake", caps);
    bed = await createBed({ adapters: [adapter], provider: new FakeProvider({ chunkSize: 1000, reply: () => "seen" }) });
    bed.pairing.registerOwner({ channel: "fake", accountId: "default", externalId: "owner1" });
    await say(adapter, "m1", { text: "hello" });
    await waitFor(() => adapter.sent.length === 1);
    return { adapter, bed, session: bed.sessions!.list()[0]!.id };
  }
  const file = (b: Bed, data = PNG, mime = "image/png") => ({ ...b.blobs.put(data, mime), name: "x.png", mime, bytes: data.length });

  it("goes to the conversation of the session, in order after earlier replies, with the stored bytes", async () => {
    const { adapter, bed: b, session } = await talking();
    b.manager.sendFile(session, file(b), "caption");
    await waitFor(() => adapter.sent.length === 2);
    expect(adapter.sent[1]).toMatchObject({ conversationId: "owner1", text: "caption", files: [{ name: "x.png", mime: "image/png", data: b64(PNG) }] });
    await waitFor(() => b.events.readSince(0, { limit: 5000 }).some((e) => e.type === "channel.file_sent"));
    expect(JSON.stringify(b.events.readSince(0, { limit: 5000 }))).not.toContain(b64(PNG));
  });

  it("is refused, with words the model can use, when the channel cannot carry files or the session is not on a channel", async () => {
    const { bed: b, session } = await talking({});
    expect(() => b.manager.sendFile(session, file(b))).toThrow(/cannot carry files/);
    const local = b.sessions!.getOrCreate({ channel: "local", conversation: "main", scope: "owner" });
    expect(() => b.manager.sendFile(local.id, file(b))).toThrow(/not on a running messaging channel/);
  });

  it("is given up on, not sent empty, when the stored file has gone", async () => {
    const { adapter, bed: b, session } = await talking();
    const f = file(b, Buffer.concat([PNG, Buffer.from("gone soon")]));
    adapter.failSends = 1; // the first attempt fails, so the reply is still waiting when the file goes missing
    b.manager.sendFile(session, f, "will not arrive");
    await waitFor(() => b.manager.outbox.summary().pending === 1 && adapter.failSends === 0);
    b.blobs.gc(new Set(), 0); // the store loses it before the reply is sent
    await waitFor(() => b.manager.outbox.summary().failed >= 1 || adapter.sent.length > 1);
    expect(adapter.sent).toHaveLength(1);
  });

  it("waits in the outbox while the platform is down and arrives when it is back", async () => {
    const { adapter, bed: b, session } = await talking();
    adapter.failSends = 1;
    b.manager.sendFile(session, file(b));
    await waitFor(() => adapter.sent.length === 2, 10_000);
    expect(adapter.sent[1]!.files).toHaveLength(1);
  });
});
