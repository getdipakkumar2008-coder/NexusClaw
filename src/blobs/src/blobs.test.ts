import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "@clawnexus/store";
import { BlobError, BlobStore, DEFAULT_INGEST, ingestAttachments, isBlobId, safeName, sniff } from "./index.js";

const b = (...parts: Array<number[] | string>): Buffer => Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "latin1") : Buffer.from(p))));
const PNG = b([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "....IHDR rest of a picture");
const JPEG = b([0xff, 0xd8, 0xff, 0xe0], "....JFIF....");
const GIF = b("GIF89a", [1, 0, 1, 0]);
const WEBP = b("RIFF", [0, 0, 0, 0], "WEBPVP8 ");
const WAV = b("RIFF", [0, 0, 0, 0], "WAVEfmt ");
const PDF = b("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");
const OGG = b("OggS", [0, 2, 0, 0], "....OpusHead");
const MP3_TAG = b("ID3", [3, 0, 0, 0, 0, 0, 0]);
const MP3_FRAME = b([0xff, 0xfb, 0x90, 0x00], "....");
const M4A = b([0, 0, 0, 0x20], "ftypM4A ", [0, 0, 0, 0]);

describe("sniff: what a file is, from its content", () => {
  it("recognises the accepted kinds", () => {
    expect([PNG, JPEG, GIF, WEBP, WAV, PDF, OGG, MP3_TAG, MP3_FRAME, M4A].map((x) => sniff(x))).toEqual([
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "audio/wav",
      "application/pdf",
      "audio/ogg",
      "audio/mpeg",
      "audio/mpeg",
      "audio/mp4",
    ]);
  });

  it("accepts ordinary text, in any language, and nothing that merely looks like it", () => {
    for (const t of ["hello", "héllo wörld", "日本語のテキスト", "line one\r\nline two\n\ttabbed", "\uFEFFwith a byte-order mark", "#!/bin/sh\necho this is only text to us\n", "<html><script>alert(1)</script></html>"]) {
      expect(sniff(Buffer.from(t, "utf8")), t).toBe("text/plain");
    }
    expect(sniff(Buffer.from("x".repeat(20_000)))).toBe("text/plain");
  });

  it("refuses programs, archives, documents of other kinds, and binary of any kind", () => {
    const refused: Array<[string, Buffer]> = [
      ["Windows program", b("MZ", [0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0])],
      ["Linux program", b([0x7f], "ELF", [2, 1, 1, 0])],
      ["Mac program", b([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1])],
      ["zip, jar, docx, apk", b("PK", [3, 4, 20, 0, 0, 0, 8, 0])],
      ["gzip", b([0x1f, 0x8b, 8, 0, 0, 0, 0, 0])],
      ["7z", b("7z", [0xbc, 0xaf, 0x27, 0x1c, 0, 4])],
      ["Windows shortcut", b([0x4c, 0, 0, 0, 1, 0x14, 2, 0])],
      ["SQLite database", b("SQLite format 3", [0])],
      ["Java class", b([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 0x34])],
      ["random bytes", b([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02, 0x03])],
      ["text with a NUL", b("looks fine", [0], "but is not")],
      ["Latin-1 text that is not UTF-8", b("caf", [0xe9], " au lait")],
      ["empty", Buffer.alloc(0)],
      ["a few control characters", b([1, 2, 3, 4, 5, 6])],
    ];
    for (const [what, buf] of refused) expect(sniff(buf), what).toBeUndefined();
  });

  it("goes by the first bytes, not by anything the sender claims", () => {
    // a program does not become a picture by being called one: the claim is not even an input here
    expect(sniff(b("MZ", [0x90, 0], " this.png"))).toBeUndefined();
    // and a picture header followed by anything is still only treated as a picture, never run
    expect(sniff(b([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "MZ not a picture really"))).toBe("image/png");
  });
});

describe("safeName", () => {
  it("shows a bare, printable name", () => {
    expect(safeName("../../etc/passwd", 0)).toBe("passwd");
    expect(safeName("C:\\Users\\x\\secret.pdf", 0)).toBe("secret.pdf");
    expect(safeName("  .hidden  ", 0)).toBe("hidden");
    expect(safeName("a\u0000b\nc.txt", 0)).toBe("abc.txt");
    expect(safeName('we<ird>:"name"|?*.png', 0)).toBe("weirdname.png");
    expect(safeName(undefined, 2)).toBe("file-3");
    expect(safeName("", 0)).toBe("file-1");
    expect(safeName("x".repeat(500), 0)).toHaveLength(100);
  });
});

describe("BlobStore", () => {
  let dir: string;
  let db: Db;
  let store: BlobStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cn-blob-"));
    db = openDb(join(dir, "g.db"));
    store = new BlobStore(join(dir, "blobs"), db, { maxBlobBytes: 1000, maxTotalBytes: 2500 });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("names a file by the SHA-256 of its content, stores it privately, and stores the same file once", () => {
    const { id, existed } = store.put(PNG, "image/png");
    expect(id).toBe(createHash("sha256").update(PNG).digest("hex"));
    expect(isBlobId(id)).toBe(true);
    expect(existed).toBe(false);
    expect(store.put(PNG, "image/png")).toEqual({ id, existed: true });
    expect(store.stats()).toEqual({ count: 1, bytes: PNG.length });
    expect(store.read(id)).toEqual(PNG);
    expect(store.info(id)).toMatchObject({ bytes: PNG.length, mime: "image/png" });
    if (process.platform !== "win32") expect(statSync(join(dir, "blobs", id.slice(0, 2), id)).mode & 0o077).toBe(0);
  });

  it("refuses files that are empty, too large, or would fill the store", () => {
    expect(() => store.put(Buffer.alloc(0), "text/plain")).toThrow(BlobError);
    expect(() => store.put(Buffer.alloc(1001, 65), "text/plain")).toThrow(/at most 1000/);
    store.put(Buffer.alloc(900, 1), "text/plain");
    store.put(Buffer.alloc(900, 2), "text/plain");
    expect(() => store.put(Buffer.alloc(900, 3), "text/plain")).toThrow(/full/);
    store.put(Buffer.alloc(900, 1), "text/plain"); // already there: costs nothing, so still fine
  });

  it("never hands back a file that no longer matches its name", () => {
    const { id } = store.put(PNG, "image/png");
    writeFileSync(join(dir, "blobs", id.slice(0, 2), id), "tampered");
    expect(store.read(id)).toBeUndefined();
    expect(store.read("../../g.db")).toBeUndefined();
    expect(store.read("A".repeat(64))).toBeUndefined();
    expect(store.read("0".repeat(64))).toBeUndefined();
  });

  it("removes what nothing refers to, but not what is new, and tidies stray files", () => {
    let now = 1_000_000;
    const s = new BlobStore(join(dir, "b2"), db, { now: () => now });
    const keep = s.put(Buffer.from("keep"), "text/plain").id;
    const drop = s.put(Buffer.from("drop"), "text/plain").id;
    const fresh = (() => {
      now += 7_200_000;
      return s.put(Buffer.from("fresh"), "text/plain").id;
    })();
    const r = s.gc(new Set([keep]));
    expect(r.removed).toBe(1);
    expect(s.read(drop)).toBeUndefined();
    expect(s.read(keep)).toBeDefined();
    expect(s.read(fresh)).toBeDefined(); // stored a moment ago: its message may not be written yet
    // a file the table does not know about (a crash between writing and recording) goes once it is old
    mkdirSync(join(dir, "b2", "ab"), { recursive: true });
    const stray = join(dir, "b2", "ab", "c".repeat(64));
    writeFileSync(stray, "stray");
    utimesSync(stray, new Date(0), new Date(0));
    s.gc(new Set([keep, fresh]));
    expect(existsSync(stray)).toBe(false);
    expect(readdirSync(join(dir, "b2")).length).toBeGreaterThan(0);
  });
});

describe("ingestAttachments", () => {
  let dir: string;
  let db: Db;
  let store: BlobStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cn-ing-"));
    db = openDb(join(dir, "g.db"));
    store = new BlobStore(join(dir, "blobs"), db);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const att = (buf: Buffer, name = "f", extra: Record<string, unknown> = {}) => ({ name, data: buf.toString("base64"), ...extra });

  it("stores what is acceptable and says what it is, from its content", () => {
    const refs = ingestAttachments([att(PNG, "../photo.png", { mimeType: "application/x-msdownload" }), att(Buffer.from("notes"), "n.txt")], store);
    expect(refs[0]).toMatchObject({ name: "photo.png", mime: "image/png", bytes: PNG.length }); // the claimed type is ignored
    expect(refs[1]).toMatchObject({ name: "n.txt", mime: "text/plain" });
    expect(refs.every((r) => r.id !== undefined && r.dropped === undefined)).toBe(true);
    expect(store.read(refs[0]!.id!)).toEqual(PNG);
  });

  it("drops, with a reason, what it cannot or will not take, and stores none of it", () => {
    const exe = b("MZ", [0x90, 0, 3, 0]);
    const refs = ingestAttachments(
      [
        att(Buffer.alloc(DEFAULT_INGEST.maxFileBytes + 1, 65), "huge.txt"),
        att(exe, "invoice.pdf", { mimeType: "application/pdf" }), // a program called a PDF
        { name: "no-data.png", bytes: 50 }, // never downloaded
        { name: "broken", data: "***not base64***" },
        { name: "empty", data: "" },
      ],
      store,
      { ...DEFAULT_INGEST, maxFiles: 10 },
    );
    expect(refs.map((r) => r.dropped)).toEqual([
      expect.stringMatching(/too large/),
      expect.stringMatching(/not accepted/),
      expect.stringMatching(/not downloaded/),
      expect.stringMatching(/damaged/),
      expect.stringMatching(/empty/),
    ]);
    expect(refs.every((r) => r.id === undefined)).toBe(true);
    expect(store.stats().count).toBe(0);
  });

  it("takes only the first few files and a bounded total", () => {
    const many = Array.from({ length: 6 }, (_, i) => att(Buffer.from(`file number ${i}`), `f${i}.txt`));
    const refs = ingestAttachments(many, store);
    expect(refs).toHaveLength(6);
    expect(refs.filter((r) => r.id).length).toBe(4);
    expect(refs[4]?.dropped).toMatch(/first 4/);
    const big = (n: number) => att(Buffer.alloc(n, 66), `big${n}.txt`);
    const together = ingestAttachments([big(6_000_000), big(6_000_001), big(6_000_002)], store, { ...DEFAULT_INGEST, maxMessageBytes: 13_000_000 });
    expect(together.map((r) => (r.id ? "kept" : "dropped"))).toEqual(["kept", "kept", "dropped"]);
    expect(together[2]?.dropped).toMatch(/together/);
  });

  it("says when the store is full rather than failing the message", () => {
    const small = new BlobStore(join(dir, "tiny"), db, { maxTotalBytes: 10 });
    const refs = ingestAttachments([att(Buffer.from("this is longer than ten bytes"), "t.txt")], small);
    expect(refs[0]).toMatchObject({ dropped: "the attachment store is full" });
  });

  it("does not trust a name for anything", () => {
    const refs = ingestAttachments([att(Buffer.from("x"), "../../../etc/cron.d/evil\u0000.sh")], store);
    expect(refs[0]?.name).toBe("evil.sh");
    expect(readFileSync(join(dir, "blobs", refs[0]!.id!.slice(0, 2), refs[0]!.id!), "utf8")).toBe("x"); // stored under its hash, whatever it was called
  });
});
