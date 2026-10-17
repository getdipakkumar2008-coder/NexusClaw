import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { sniff, stripMetadata } from "@clawnexus/blobs";
import { inboundSchema } from "@clawnexus/channels";
import { validateConfig } from "@clawnexus/config";
import { errorBodySchema, frameSchema, generateDeviceKey, parseFrame, verifyDeviceSignature } from "@clawnexus/protocol";
import { FakeProvider, fromJsonl, toJsonl } from "@clawnexus/sessions";
import { Gateway, startGateway } from "./index.js";

/**
 * Fuzz targets (docs/06 sections 8 and 9). Every parser that takes bytes or text from outside is fed a large number of
 * damaged and random inputs; the property is that it answers (accepts or refuses) and never throws, hangs, or hands
 * back something that breaks its own promise. The generator is seeded, so a failure is repeatable: the message names the
 * seed and iteration. The nightly job runs far more iterations with a fresh seed (FUZZ_ITERATIONS, FUZZ_SEED).
 */
const ITERATIONS = Number(process.env["FUZZ_ITERATIONS"] ?? 1500);
const SEED = Number(process.env["FUZZ_SEED"] ?? 20261017);

/** A small deterministic generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Fuzzer {
  readonly next: () => number;
  constructor(seed: number) {
    this.next = rng(seed);
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)] as T;
  }
  bytes(n: number): Buffer {
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i++) b[i] = this.int(256);
    return b;
  }
  /** Damage a buffer: flip, overwrite with interesting values, insert, delete, truncate, duplicate a slice. */
  mutate(src: Buffer): Buffer {
    let b = Buffer.from(src);
    const rounds = 1 + this.int(6);
    const INTERESTING = [0, 1, 0x7f, 0x80, 0xff, 0xfe];
    for (let r = 0; r < rounds && b.length > 0; r++) {
      const at = this.int(b.length);
      switch (this.int(7)) {
        case 0:
          b[at] = (b[at] as number) ^ (1 << this.int(8));
          break;
        case 1:
          b[at] = this.pick(INTERESTING);
          break;
        case 2:
          b = Buffer.concat([b.subarray(0, at), this.bytes(1 + this.int(8)), b.subarray(at)]);
          break;
        case 3:
          b = Buffer.concat([b.subarray(0, at), b.subarray(at + 1 + this.int(8))]);
          break;
        case 4:
          b = b.subarray(0, at);
          break;
        case 5: {
          const len = 1 + this.int(Math.min(32, b.length - at));
          b = Buffer.concat([b.subarray(0, at), b.subarray(at, at + len), b.subarray(at, at + len), b.subarray(at + len)]);
          break;
        }
        default:
          if (b.length >= at + 4) b.writeUInt32BE(this.pick([0, 1, 0x7fffffff, 0xffffffff, b.length]), at);
      }
    }
    return b;
  }
  /** Damage JSON text by structure: swap values for odd ones, deepen, or break syntax. */
  mutateJson(v: unknown, depth = 0): unknown {
    const ODD = [null, true, false, 0, -1, 1e308, -0, "", "\u0000", "__proto__", "x".repeat(70_000), [], {}, [[]], { a: { a: {} } }, Number.MAX_SAFE_INTEGER + 2, "\ud800"];
    if (depth > 6 || this.next() < 0.25) return this.pick(ODD);
    if (Array.isArray(v)) return v.map((x) => (this.next() < 0.5 ? this.mutateJson(x, depth + 1) : x));
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (this.next() < 0.1) continue;
        out[k] = this.next() < 0.5 ? this.mutateJson(x, depth + 1) : x;
      }
      if (this.next() < 0.2) out[this.pick(["__proto__", "constructor", "extra", "t", "id"])] = this.pick(ODD);
      return out;
    }
    return this.next() < 0.5 ? this.pick(ODD) : v;
  }
}

/** Run `body` many times; on a failure say exactly which seed and iteration reproduce it. */
function fuzz(name: string, body: (f: Fuzzer, i: number) => void, iterations = ITERATIONS): void {
  it(`${name} (${iterations} inputs, seed ${SEED})`, () => {
    const f = new Fuzzer(SEED);
    for (let i = 0; i < iterations; i++) {
      try {
        body(f, i);
      } catch (e) {
        throw new Error(`fuzz failure in "${name}" at iteration ${i} with seed ${SEED}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  });
}

const u16 = (n: number): number[] => [n >> 8, n & 255];
const u32 = (n: number): number[] => [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];
const chunk = (type: string, body: string): Buffer => Buffer.from([...u32(body.length), ...Buffer.from(type, "latin1"), ...Buffer.from(body, "latin1"), 0, 0, 0, 0]);
const seg = (m: number, body: string): Buffer => Buffer.from([0xff, m, ...u16(body.length + 2), ...Buffer.from(body, "latin1")]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", "0123456789012"), chunk("tEXt", "Author\0x"), chunk("eXIf", "gps"), chunk("IDAT", "pixels"), chunk("IEND", "")]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, "JFIF"), seg(0xe1, "Exif gps"), seg(0xe2, "ICC"), seg(0xfe, "comment"), Buffer.from([0xff, 0xda, 0, 4, 0, 0]), Buffer.from("scan"), Buffer.from([0xff, 0xd9])]);

describe("fuzz: files", () => {
  const SEEDS: Array<[Buffer, string]> = [
    [PNG, "image/png"],
    [JPEG, "image/jpeg"],
    [Buffer.from("GIF89a\x01\x00\x01\x00"), "image/gif"],
    [Buffer.from("RIFF\0\0\0\0WEBPVP8 "), "image/webp"],
    [Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n"), "application/pdf"],
    [Buffer.from("OggS\0\x02\0\0....OpusHead"), "audio/ogg"],
    [Buffer.from("hello, some ordinary text\n"), "text/plain"],
  ];
  fuzz("sniff always answers with a known kind or nothing, and agrees with itself", (f) => {
    const [seed] = f.pick(SEEDS);
    const input = f.next() < 0.2 ? f.bytes(f.int(64)) : f.mutate(seed);
    const kind = sniff(input);
    expect(kind === undefined || /^(image|audio|text|application)\//.test(kind)).toBe(true);
    expect(sniff(input)).toBe(kind);
  });
  fuzz("metadata removal never throws, never grows a file, and never turns a picture into something else", (f) => {
    const [seed, mime] = f.pick([[PNG, "image/png"], [JPEG, "image/jpeg"]] as const);
    const input = f.mutate(seed);
    const kind = sniff(input);
    if (kind !== mime) return;
    const out = stripMetadata(input, kind);
    expect(out.length).toBeLessThanOrEqual(input.length);
    expect(sniff(out)).toBe(kind);
    expect(stripMetadata(out, kind)).toEqual(out); // cleaning twice changes nothing more
  });
});

describe("fuzz: text formats", () => {
  const HELLO = { t: "req", id: "c-1", method: "connection.hello", params: { protocol: { major: 1, minor: 0 }, client: { kind: "t", version: "0" }, auth: { token: "x" } } };
  fuzz("protocol frames: parseFrame answers ok or a well-formed error and never throws", (f) => {
    const text = f.next() < 0.3 ? f.mutate(Buffer.from(JSON.stringify(HELLO))).toString("utf8") : JSON.stringify(f.mutateJson(HELLO));
    const r = parseFrame(text);
    expect(typeof r.ok).toBe("boolean");
    if (r.ok) expect(frameSchema.safeParse(r.frame).success).toBe(true);
    else expect(errorBodySchema.safeParse(r.error).success).toBe(true);
  });

  const INBOUND = { accountId: "default", conversationId: "c1", senderId: "u1", messageId: "m1", text: "hi", isGroup: false, mentionsBot: true, attachments: [{ name: "a.png", data: "AAAA" }] };
  fuzz("channel messages: the strict schema answers, and what it accepts has no extra or oversized parts", (f) => {
    const r = inboundSchema.safeParse(f.mutateJson(INBOUND));
    if (r.success) {
      expect(r.data.text.length).toBeLessThanOrEqual(100_000);
      expect(Object.keys(r.data).every((k) => ["accountId", "conversationId", "senderId", "senderDisplay", "messageId", "text", "replyTo", "isGroup", "mentionsBot", "ts", "attachments"].includes(k))).toBe(true);
    }
  });

  const TRANSCRIPT = toJsonl({ channel: "c", conversation: "x", scope: "s", createdAt: 1, messages: [{ role: "user", sender: "u", content: "hi", ts: 2, files: [{ name: "a.png", id: "ab" }] }] });
  fuzz("transcript import: refuses damaged files with an error of its own, never another kind", (f) => {
    const text = f.mutate(Buffer.from(TRANSCRIPT)).toString("utf8");
    try {
      const t = fromJsonl(text);
      expect(Array.isArray(t.messages)).toBe(true);
    } catch (e) {
      expect(e instanceof Error && e.name).toBeTruthy();
      expect((e as Error).constructor.name).toBe("TranscriptError");
    }
  });

  fuzz("config: validation answers ok or a list of problems, never throws, and never accepts a non-object", (f) => {
    const r = validateConfig(f.mutateJson({ version: 1, gateway: { bind: "127.0.0.1", port: 7391 }, security: { profile: "standard" } }));
    if (!r.ok) expect(Array.isArray(r.problems)).toBe(true);
    for (const junk of [null, undefined, 1, "x", [], () => 1]) expect(validateConfig(junk as never).ok).toBe(false);
  });
});

describe("fuzz: device sign-in", () => {
  const key = generateDeviceKey();
  fuzz("a signature check says no to garbage, quickly, without throwing", (f) => {
    const sig = f.next() < 0.5 ? f.bytes(f.int(100)).toString("base64url") : f.bytes(64).toString("base64url");
    const pk = f.next() < 0.3 ? f.bytes(f.int(48)).toString("base64url") : key.publicKey;
    expect(verifyDeviceSignature(pk, "dev_1", "nonce", "connect", sig)).toBe(false);
  });
});

describe("fuzz: a live Gateway", () => {
  let dir: string;
  let gw: Gateway;
  let port: number;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "gw-fuzz-"));
    const started = await startGateway({ dataDir: dir, port: 0, provider: new FakeProvider() });
    gw = started.gateway;
    port = started.port;
  });
  afterAll(async () => {
    await gw?.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  async function alive(): Promise<boolean> {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined);
    return res?.ok === true;
  }

  it("keeps serving after thousands of damaged frames, before and after sign-in attempts", async () => {
    const f = new Fuzzer(SEED);
    const total = Math.min(ITERATIONS, 600);
    let sent = 0;
    for (let batch = 0; batch < Math.ceil(total / 100); batch++) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`);
      await new Promise<void>((resolve) => {
        ws.once("open", () => resolve());
        ws.once("error", () => resolve());
      });
      ws.on("error", () => undefined);
      for (let i = 0; i < 100 && sent < total; i++, sent++) {
        if (ws.readyState !== WebSocket.OPEN) break;
        const kind = f.int(4);
        if (kind === 0) ws.send(f.bytes(f.int(200)), { binary: true });
        else if (kind === 1) ws.send(f.bytes(f.int(200)).toString("utf8"));
        else if (kind === 2) ws.send(JSON.stringify(f.mutateJson({ t: "req", id: "x", method: f.pick(["status", "connection.hello", "tool.call", "session.send", "auth.verify"]), params: { token: "nope" } })));
        else ws.send(f.mutate(Buffer.from('{"t":"req","id":"a","method":"status","params":{}}')).toString("utf8"));
      }
      ws.close();
      await new Promise((r) => setTimeout(r, 20));
      expect(await alive(), `Gateway stopped answering during batch ${batch} (seed ${SEED})`).toBe(true);
    }
    expect(sent).toBeGreaterThan(0);
  }, 120_000);

  it("closes oversized and non-text frames without keeping them", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    ws.send(Buffer.alloc(3 * 1024 * 1024, 65));
    expect([1009, 1006, 1008]).toContain(await closed);
    expect(await alive()).toBe(true);
  });
});
