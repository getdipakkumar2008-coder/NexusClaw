import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Redactor, Vault, VaultError, type KeySource } from "./index.js";

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const pass = (passphrase: string): KeySource => ({ kind: "passphrase", passphrase, params: FAST });

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vault-test-"));
  path = join(dir, "vault.enc");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("storage", () => {
  it("round-trips secrets across close/reopen", async () => {
    const v = await Vault.create(path, pass("correct horse"));
    v.set("telegram.bot-token", "123456:ABC-DEF-secret");
    v.set("anthropic.key", "sk-test-0123456789");
    v.close();
    const r = await Vault.open(path, pass("correct horse"));
    expect(r.get("telegram.bot-token")).toBe("123456:ABC-DEF-secret");
    expect(r.list()).toEqual(["anthropic.key", "telegram.bot-token"]);
    expect(r.get("missing")).toBeUndefined();
    expect(r.delete("anthropic.key")).toBe(true);
    expect(r.delete("anthropic.key")).toBe(false);
    r.close();
    expect((await Vault.open(path, pass("correct horse"))).list()).toEqual(["telegram.bot-token"]);
  });

  it("never writes plaintext secrets, names or values, to disk", async () => {
    const v = await Vault.create(path, pass("pw"));
    v.set("very.secret-name", "TOP-SECRET-VALUE-123");
    const bytes = readFileSync(path).toString("latin1");
    expect(bytes).not.toContain("TOP-SECRET-VALUE-123");
    expect(bytes).not.toContain("very.secret-name");
    expect(readdirSync(dir)).toEqual(["vault.enc"]); // no leftover temp files
  });

  it("uses a fresh nonce for every write", async () => {
    const v = await Vault.create(path, pass("pw"));
    v.set("a", "value-one");
    const n1 = JSON.parse(readFileSync(path, "utf8")).nonce;
    v.set("b", "value-two");
    const n2 = JSON.parse(readFileSync(path, "utf8")).nonce;
    expect(n1).not.toBe(n2);
  });

  it("refuses to overwrite an existing vault and to open a missing one", async () => {
    await Vault.create(path, pass("pw"));
    await expect(Vault.create(path, pass("pw"))).rejects.toMatchObject({ code: "EXISTS" });
    await expect(Vault.open(join(dir, "nope"), pass("pw"))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("validates secret names (no prototype tricks)", async () => {
    const v = await Vault.create(path, pass("pw"));
    for (const bad of ["", "__proto__", "Upper", "has space", "-lead", "x".repeat(129)]) {
      expect(() => v.set(bad, "value-123"), bad).toThrow(VaultError);
    }
    v.set("constructor", "value-123");
    expect(v.get("constructor")).toBe("value-123");
    expect(v.get("toString")).toBeUndefined();
  });
});

describe("authentication", () => {
  it("rejects a wrong passphrase", async () => {
    await Vault.create(path, pass("right"));
    await expect(Vault.open(path, pass("wrong"))).rejects.toMatchObject({ code: "BAD_KEY" });
    await expect(Vault.open(path, { kind: "passphrase", passphrase: "" })).rejects.toMatchObject({ code: "BAD_KEY" });
  });

  it("detects tampering with ciphertext, tag, nonce and header", async () => {
    const v = await Vault.create(path, pass("pw"));
    v.set("k", "secret-value-1");
    const original = readFileSync(path, "utf8");
    type Doc = { ciphertext: string; tag: string; nonce: string; header: { kdf: { salt: string } } };
    const mutate = (fn: (o: Doc) => void): string => {
      const o = JSON.parse(original) as Doc;
      fn(o);
      return JSON.stringify(o);
    };
    const flip = (b64: string): string => {
      const b = Buffer.from(b64, "base64");
      b[0] = (b[0] ?? 0) ^ 1;
      return b.toString("base64");
    };
    const cases: Record<string, string> = {
      ciphertext: mutate((o) => (o.ciphertext = flip(o.ciphertext))),
      tag: mutate((o) => (o.tag = flip(o.tag))),
      nonce: mutate((o) => (o.nonce = flip(o.nonce))),
      salt: mutate((o) => (o.header.kdf.salt = flip(o.header.kdf.salt))),
    };
    for (const [name, text] of Object.entries(cases)) {
      writeFileSync(path, text);
      await expect(Vault.open(path, pass("pw")), name).rejects.toBeInstanceOf(VaultError);
    }
    writeFileSync(path, original);
    expect((await Vault.open(path, pass("pw"))).get("k")).toBe("secret-value-1");
  });

  it("bounds the work an attacker-modified header can demand", async () => {
    await Vault.create(path, pass("pw"));
    const o = JSON.parse(readFileSync(path, "utf8"));
    o.header.kdf.N = 2 ** 30;
    writeFileSync(path, JSON.stringify(o));
    await expect(Vault.open(path, pass("pw"))).rejects.toMatchObject({ code: "CORRUPT" });
  });

  it("reports garbage files as corrupt", async () => {
    writeFileSync(path, "not json");
    await expect(Vault.open(path, pass("pw"))).rejects.toMatchObject({ code: "CORRUPT" });
    writeFileSync(path, JSON.stringify({ header: { v: 99 } }));
    await expect(Vault.open(path, pass("pw"))).rejects.toMatchObject({ code: "CORRUPT" });
  });
});

describe("raw key source (OS keychain adapters)", () => {
  it("works with a 32-byte key and rejects other sizes or a passphrase", async () => {
    const key = randomBytes(32);
    const v = await Vault.create(path, { kind: "raw", key });
    v.set("k", "secret-value-1");
    v.close();
    expect((await Vault.open(path, { kind: "raw", key })).get("k")).toBe("secret-value-1");
    await expect(Vault.open(path, { kind: "raw", key: randomBytes(32) })).rejects.toMatchObject({ code: "BAD_KEY" });
    await expect(Vault.open(path, pass("pw"))).rejects.toBeInstanceOf(VaultError);
    await expect(Vault.create(join(dir, "v2"), { kind: "raw", key: randomBytes(16) })).rejects.toMatchObject({ code: "BAD_KEY" });
  });
});

describe("rotation and lifecycle", () => {
  it("changePassphrase re-keys: old fails, new works, salt changes", async () => {
    const v = await Vault.create(path, pass("old"));
    v.set("k", "secret-value-1");
    const salt1 = JSON.parse(readFileSync(path, "utf8")).header.kdf.salt;
    await v.changePassphrase("new", FAST);
    const salt2 = JSON.parse(readFileSync(path, "utf8")).header.kdf.salt;
    expect(salt1).not.toBe(salt2);
    v.close();
    await expect(Vault.open(path, pass("old"))).rejects.toMatchObject({ code: "BAD_KEY" });
    expect((await Vault.open(path, pass("new"))).get("k")).toBe("secret-value-1");
  });

  it("is unusable after close", async () => {
    const v = await Vault.create(path, pass("pw"));
    v.set("k", "secret-value-1");
    v.close();
    expect(() => v.get("k")).toThrow(/closed/);
    expect(() => v.set("k", "x")).toThrow(/closed/);
  });
});

describe("Redactor", () => {
  it("masks registered values in strings and nested structures, longest first", async () => {
    const v = await Vault.create(path, pass("pw"));
    v.set("short", "abcdef");
    v.set("long", "abcdef-and-more");
    const out = v.redact.redactDeep({ msg: "token=abcdef-and-more and abcdef", nested: [{ ["abcdef"]: 1 }], n: 5 });
    expect(JSON.stringify(out)).not.toContain("abcdef");
    expect(out.msg).toBe("token=[REDACTED:long] and [REDACTED:short]");
    expect(out.n).toBe(5);
  });

  it("tracks set and delete, ignores too-short values, and handles regex metacharacters literally", () => {
    const r = new Redactor();
    r.set("tiny", "abc");
    r.set("re", "a.b*c(d)+e");
    expect(r.redact("abc a.b*c(d)+e aXbbcde")).toBe("abc [REDACTED:re] aXbbcde");
    r.delete("re");
    expect(r.redact("a.b*c(d)+e")).toBe("a.b*c(d)+e");
  });

  it("stays current after vault.set", async () => {
    const v = await Vault.create(path, pass("pw"));
    expect(v.redact.redact("sk-123456")).toBe("sk-123456");
    v.set("k", "sk-123456");
    expect(v.redact.redact("key is sk-123456")).toBe("key is [REDACTED:k]");
  });
});
