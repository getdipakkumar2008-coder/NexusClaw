import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "@clawnexus/store";
import { BlobError, BlobStore, DEFAULT_INGEST, ingestAttachments, isBlobId, safeName, scanHook, sniff, stripMetadata } from "./index.js";

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

  it("stores what is acceptable and says what it is, from its content", async () => {
    const refs = await ingestAttachments([att(PNG, "../photo.png", { mimeType: "application/x-msdownload" }), att(Buffer.from("notes"), "n.txt")], store);
    expect(refs[0]).toMatchObject({ name: "photo.png", mime: "image/png", bytes: PNG.length }); // the claimed type is ignored
    expect(refs[1]).toMatchObject({ name: "n.txt", mime: "text/plain" });
    expect(refs.every((r) => r.id !== undefined && r.dropped === undefined)).toBe(true);
    expect(store.read(refs[0]!.id!)).toEqual(PNG);
  });

  it("drops, with a reason, what it cannot or will not take, and stores none of it", async () => {
    const exe = b("MZ", [0x90, 0, 3, 0]);
    const refs = await ingestAttachments(
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

  it("takes only the first few files and a bounded total", async () => {
    const many = Array.from({ length: 6 }, (_, i) => att(Buffer.from(`file number ${i}`), `f${i}.txt`));
    const refs = await ingestAttachments(many, store);
    expect(refs).toHaveLength(6);
    expect(refs.filter((r) => r.id).length).toBe(4);
    expect(refs[4]?.dropped).toMatch(/first 4/);
    const big = (n: number) => att(Buffer.alloc(n, 66), `big${n}.txt`);
    const together = await ingestAttachments([big(6_000_000), big(6_000_001), big(6_000_002)], store, { ...DEFAULT_INGEST, maxMessageBytes: 13_000_000 });
    expect(together.map((r) => (r.id ? "kept" : "dropped"))).toEqual(["kept", "kept", "dropped"]);
    expect(together[2]?.dropped).toMatch(/together/);
  });

  it("says when the store is full rather than failing the message", async () => {
    const small = new BlobStore(join(dir, "tiny"), db, { maxTotalBytes: 10 });
    const refs = await ingestAttachments([att(Buffer.from("this is longer than ten bytes"), "t.txt")], small);
    expect(refs[0]).toMatchObject({ dropped: "the attachment store is full" });
  });

  it("does not trust a name for anything", async () => {
    const refs = await ingestAttachments([att(Buffer.from("x"), "../../../etc/cron.d/evil\u0000.sh")], store);
    expect(refs[0]?.name).toBe("evil.sh");
    expect(readFileSync(join(dir, "blobs", refs[0]!.id!.slice(0, 2), refs[0]!.id!), "utf8")).toBe("x"); // stored under its hash, whatever it was called
  });
});

const u16 = (n: number): number[] => [n >> 8, n & 255];
const u32 = (n: number): number[] => [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];
const jpegSeg = (marker: number, body: string): Buffer => b([0xff, marker], u16(body.length + 2), body);
const pngChunk = (type: string, body: string): Buffer => b(u32(body.length), type, body, [0, 0, 0, 0]);

describe("stripMetadata: personal data out of pictures", () => {
  const jpeg = (...segs: Buffer[]): Buffer => Buffer.concat([b([0xff, 0xd8]), ...segs, b([0xff, 0xda], u16(4), [0, 0], "SCANDATA", [0xff, 0xd9])]);
  const png = (...chunks: Buffer[]): Buffer => Buffer.concat([b([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", "0123456789012"), ...chunks, pngChunk("IDAT", "pixels"), pngChunk("IEND", "")]);

  it("removes location, camera and comments from a JPEG and keeps the picture and its colour profile", () => {
    const dirty = jpeg(jpegSeg(0xe0, "JFIF-ok"), jpegSeg(0xe1, "Exif GPS 51.5N 0.1W"), jpegSeg(0xe1, "XMP owner name"), jpegSeg(0xe2, "ICC-profile"), jpegSeg(0xed, "IPTC caption"), jpegSeg(0xfe, "a comment"));
    const clean = stripMetadata(dirty, "image/jpeg");
    const text = clean.toString("latin1");
    for (const gone of ["GPS", "XMP", "IPTC", "comment"]) expect(text).not.toContain(gone);
    for (const kept of ["JFIF-ok", "ICC-profile", "SCANDATA"]) expect(text).toContain(kept);
    expect(sniff(clean)).toBe("image/jpeg");
  });

  it("removes text, EXIF and time chunks from a PNG and keeps the rest intact", () => {
    const dirty = png(pngChunk("tEXt", "Author Someone"), pngChunk("eXIf", "GPS data"), pngChunk("tIME", "1234567"), pngChunk("iCCP", "profile"), pngChunk("zTXt", "x"), pngChunk("iTXt", "y"));
    const clean = stripMetadata(dirty, "image/png");
    const text = clean.toString("latin1");
    for (const gone of ["tEXt", "eXIf", "tIME", "zTXt", "iTXt", "Someone"]) expect(text).not.toContain(gone);
    for (const kept of ["IHDR", "iCCP", "IDAT", "IEND"]) expect(text).toContain(kept);
    expect(clean.length).toBeLessThan(dirty.length);
  });

  it("returns anything it cannot follow exactly as it came, and never throws", () => {
    const odd: Array<[Buffer, "image/jpeg" | "image/png"]> = [
      [b([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff], "short"), "image/jpeg"], // a block longer than the file
      [b([0xff, 0xd8]), "image/jpeg"],
      [PNG, "image/png"], // not made of chunks
      [Buffer.concat([png(), b("trailing bytes")]), "image/png"], // data after the end
      [b([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], u32(0xffffffff), "IHDR"), "image/png"],
    ];
    for (const [file, mime] of odd) expect(stripMetadata(file, mime)).toEqual(file);
    expect(stripMetadata(GIF, "image/jpeg")).toEqual(GIF);
  });

  it("is applied before a picture is kept, so the stored copy has none of it", async () => {
    const dir2 = mkdtempSync(join(tmpdir(), "cn-clean-"));
    const db2 = openDb(join(dir2, "g.db"));
    try {
      const store2 = new BlobStore(join(dir2, "blobs"), db2);
      const dirty = jpeg(jpegSeg(0xe1, "Exif GPS 51.5N"));
      const [ref] = await ingestAttachments([{ name: "p.jpg", data: dirty.toString("base64") }], store2);
      expect(ref?.id).toBeDefined();
      expect(store2.read(ref!.id!)?.toString("latin1")).not.toContain("GPS");
      expect(ref?.bytes).toBe(store2.read(ref!.id!)?.length);
    } finally {
      db2.close();
      rmSync(dir2, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

describe("the file check", () => {
  it("can refuse a file, is told what it is, and a check that fails refuses too", async () => {
    const dir2 = mkdtempSync(join(tmpdir(), "cn-scan-"));
    const db2 = openDb(join(dir2, "g.db"));
    try {
      const store2 = new BlobStore(join(dir2, "blobs"), db2);
      const seen: string[] = [];
      const files = [{ name: "a.txt", data: Buffer.from("fine").toString("base64") }, { name: "b.txt", data: Buffer.from("bad one").toString("base64") }, { name: "c.txt", data: Buffer.from("boom").toString("base64") }];
      const refs = await ingestAttachments(files, store2, DEFAULT_INGEST, async (f) => {
        seen.push(`${f.name}:${f.mime}`);
        if (f.bytes.toString() === "bad one") return "the file check refused it";
        if (f.bytes.toString() === "boom") throw new Error("scanner crashed");
        return undefined;
      });
      expect(seen).toEqual(["a.txt:text/plain", "b.txt:text/plain", "c.txt:text/plain"]);
      expect(refs.map((r) => r.dropped)).toEqual([undefined, "the file check refused it", "the file check could not be run"]);
      expect(store2.stats().count).toBe(1);
    } finally {
      db2.close();
      rmSync(dir2, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

describe("an installed file check program", () => {
  let dir2: string;
  beforeEach(() => void (dir2 = mkdtempSync(join(tmpdir(), "cn-hook-"))));
  afterEach(() => rmSync(dir2, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const program = (code: string): { program: string; args: string[]; workDir: string } => {
    const script = join(dir2, "scan.cjs");
    writeFileSync(script, code);
    return { program: process.execPath, args: [script], workDir: join(dir2, "work") };
  };
  const file = { bytes: Buffer.from("hello"), name: "n.txt", mime: "text/plain" as const };

  it("accepts on exit 0, refuses otherwise with a short printable reason, and gets only a copy under a name made here", async () => {
    const seen = join(dir2, "seen.txt");
    const code = [
      'const fs = require("fs");',
      "const p = process.argv[2];",
      "const body = fs.readFileSync(p, 'utf8');",
      `fs.appendFileSync(${JSON.stringify(seen)}, p + '|' + body + '\\n');`,
      "if (body === 'virus') { console.log('Eicar\\u0007 found'); process.exit(1); }",
    ].join("\n");
    const scan = scanHook(program(code));
    expect(await scan(file)).toBeUndefined();
    expect(await scan({ ...file, bytes: Buffer.from("virus"), name: "../../etc/passwd" })).toBe("the file check refused it: Eicar found");
    const lines = readFileSync(seen, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l.split("|")[0]).toMatch(/scan-[0-9a-f]{16}\.txt$/); // never the name the sender gave
    expect(readdirSync(join(dir2, "work"))).toEqual([]); // copies are removed
  });

  it("refuses when the program is missing or takes too long", async () => {
    expect(await scanHook({ program: join(dir2, "nope"), workDir: join(dir2, "w") })(file)).toBe("the file check could not be run");
    const slow = scanHook({ ...program("setTimeout(() => {}, 60000)"), timeoutMs: 300 });
    expect(await slow(file)).toBe("the file check timed out");
  });
});
