import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from "node:crypto";
import { chmodSync, existsSync, fsyncSync, openSync, closeSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (pw: Buffer | string, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;

/**
 * Encrypted secret store (SEC-8, docs/06 section 6).
 * - AES-256-GCM, fresh random 96-bit nonce on every write, header bound as additional authenticated data.
 * - Key from a passphrase via scrypt (memory-hard; built into Node 22, unlike Argon2id which needs Node 24.7+),
 *   or supplied raw by a `KeySource` (OS keychain adapters plug in here later).
 * - Whole-file atomic replace (write temp, fsync, rename); file mode 0600 where the OS supports it.
 */
export const VAULT_FORMAT = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
const NONCE_LEN = 12;

export type VaultErrorCode = "BAD_KEY" | "CORRUPT" | "NOT_FOUND" | "EXISTS" | "BAD_NAME" | "CLOSED";
export class VaultError extends Error {
  constructor(
    readonly code: VaultErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}
/** ~128 MiB, a few hundred ms on current hardware. Tests pass a cheaper value. */
export const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };

export type KeySource =
  | { kind: "passphrase"; passphrase: string; params?: ScryptParams }
  | { kind: "raw"; key: Buffer };

interface Header {
  v: number;
  kdf: { alg: "scrypt"; N: number; r: number; p: number; salt: string } | { alg: "raw" };
}

interface FileShape {
  header: Header;
  nonce: string;
  ciphertext: string;
  tag: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const b64 = (b: Buffer): string => b.toString("base64");
const unb64 = (s: string): Buffer => Buffer.from(s, "base64");
const aad = (h: Header): Buffer => Buffer.from(JSON.stringify(h), "utf8");

async function deriveKey(src: KeySource, header: Header | undefined): Promise<{ key: Buffer; header: Header }> {
  if (src.kind === "raw") {
    if (src.key.length !== KEY_LEN) throw new VaultError("BAD_KEY", `raw key must be ${KEY_LEN} bytes`);
    return { key: Buffer.from(src.key), header: { v: VAULT_FORMAT, kdf: { alg: "raw" } } };
  }
  if (src.passphrase.length === 0) throw new VaultError("BAD_KEY", "passphrase must not be empty");
  if (header) {
    if (header.kdf.alg !== "scrypt") throw new VaultError("BAD_KEY", "vault was created with a raw key, not a passphrase");
    const { N, r, p, salt } = header.kdf;
    // The header is attacker-controllable until the AEAD check passes: bound the work it can demand.
    const okPow2 = Number.isInteger(N) && N >= 2 ** 4 && N <= 2 ** 20 && (N & (N - 1)) === 0;
    if (!okPow2 || !Number.isInteger(r) || r < 1 || r > 16 || !Number.isInteger(p) || p < 1 || p > 4 || typeof salt !== "string") {
      throw new VaultError("CORRUPT", "vault key-derivation parameters are out of range");
    }
    try {
      return { key: await stretch(src.passphrase, unb64(salt), { N, r, p }), header };
    } catch {
      throw new VaultError("CORRUPT", "vault key-derivation parameters are not usable");
    }
  }
  const params = src.params ?? DEFAULT_SCRYPT;
  const salt = randomBytes(SALT_LEN);
  const newHeader: Header = { v: VAULT_FORMAT, kdf: { alg: "scrypt", ...params, salt: b64(salt) } };
  return { key: await stretch(src.passphrase, salt, params), header: newHeader };
}

function stretch(passphrase: string, salt: Buffer, p: ScryptParams): Promise<Buffer> {
  return scrypt(passphrase.normalize("NFKC"), salt, KEY_LEN, { N: p.N, r: p.r, p: p.p, maxmem: 256 * 1024 * 1024 });
}

function encrypt(key: Buffer, header: Header, secrets: Record<string, string>): FileShape {
  const nonce = randomBytes(NONCE_LEN);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(aad(header));
  const ct = Buffer.concat([c.update(JSON.stringify(secrets), "utf8"), c.final()]);
  return { header, nonce: b64(nonce), ciphertext: b64(ct), tag: b64(c.getAuthTag()) };
}

function decrypt(key: Buffer, file: FileShape): Record<string, string> {
  try {
    const d = createDecipheriv("aes-256-gcm", key, unb64(file.nonce));
    d.setAAD(aad(file.header));
    d.setAuthTag(unb64(file.tag));
    const pt = Buffer.concat([d.update(unb64(file.ciphertext)), d.final()]).toString("utf8");
    const parsed: unknown = JSON.parse(pt);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("shape");
    return parsed as Record<string, string>;
  } catch {
    // Wrong key and tampering are deliberately indistinguishable.
    throw new VaultError("BAD_KEY", "wrong passphrase/key, or the vault file is corrupted or has been modified");
  }
}

function parseFile(path: string): FileShape {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new VaultError("CORRUPT", "vault file is not valid JSON");
  }
  const f = raw as Partial<FileShape>;
  if (
    !f ||
    typeof f.nonce !== "string" ||
    typeof f.ciphertext !== "string" ||
    typeof f.tag !== "string" ||
    typeof f.header !== "object" ||
    f.header === null ||
    f.header.v !== VAULT_FORMAT
  ) {
    throw new VaultError("CORRUPT", "vault file has an unexpected structure or version");
  }
  return f as FileShape;
}

function writeAtomic(path: string, data: string): void {
  const tmp = join(dirname(path), `.${Math.random().toString(36).slice(2)}.tmp`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* not supported on every platform/filesystem */
  }
}

/** Replaces registered secret values in text with `[REDACTED:name]`; longest values first. */
export class Redactor {
  private entries: Array<{ name: string; value: string }> = [];

  /** Values shorter than 6 characters are not registered: they would mangle ordinary text. */
  set(name: string, value: string): void {
    this.entries = this.entries.filter((e) => e.name !== name);
    if (value.length >= 6) this.entries.push({ name, value });
    this.entries.sort((a, b) => b.value.length - a.value.length);
  }
  delete(name: string): void {
    this.entries = this.entries.filter((e) => e.name !== name);
  }
  redact(text: string): string {
    let out = text;
    for (const e of this.entries) out = out.split(e.value).join(`[REDACTED:${e.name}]`);
    return out;
  }
  /** Deep-copy any JSON-like value with secrets replaced in every string (object keys included). */
  redactDeep<T>(value: T): T {
    const walk = (v: unknown, depth: number): unknown => {
      if (depth > 32) return "[TRUNCATED]";
      if (typeof v === "string") return this.redact(v);
      if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
      if (v && typeof v === "object") {
        return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [this.redact(k), walk(x, depth + 1)]));
      }
      return v;
    };
    return walk(value, 0) as T;
  }
}

export class Vault {
  private secrets: Record<string, string>;
  private key: Buffer | undefined;
  private readonly redactor = new Redactor();

  private constructor(
    private readonly path: string,
    key: Buffer,
    private header: Header,
    secrets: Record<string, string>,
  ) {
    this.key = key;
    this.secrets = secrets;
    for (const [n, v] of Object.entries(secrets)) this.redactor.set(n, v);
  }

  /** Create a new, empty vault. Refuses to overwrite an existing file. */
  static async create(path: string, source: KeySource): Promise<Vault> {
    if (existsSync(path)) throw new VaultError("EXISTS", "a vault already exists at this path");
    const { key, header } = await deriveKey(source, undefined);
    const v = new Vault(path, key, header, {});
    v.flush();
    return v;
  }

  static async open(path: string, source: KeySource): Promise<Vault> {
    if (!existsSync(path)) throw new VaultError("NOT_FOUND", "no vault at this path");
    const file = parseFile(path);
    const { key } = await deriveKey(source, file.header);
    return new Vault(path, key, file.header, decrypt(key, file));
  }

  get(name: string): string | undefined {
    this.assertOpen();
    return Object.hasOwn(this.secrets, name) ? this.secrets[name] : undefined;
  }

  set(name: string, value: string): void {
    this.assertOpen();
    if (!NAME_RE.test(name)) throw new VaultError("BAD_NAME", "secret names are lowercase letters, digits, '.', '_' or '-' (max 128)");
    this.secrets = { ...this.secrets, [name]: value };
    this.redactor.set(name, value);
    this.flush();
  }

  delete(name: string): boolean {
    this.assertOpen();
    if (!Object.hasOwn(this.secrets, name)) return false;
    const { [name]: _removed, ...rest } = this.secrets;
    void _removed;
    this.secrets = rest;
    this.redactor.delete(name);
    this.flush();
    return true;
  }

  /** Names only, never values. */
  list(): string[] {
    this.assertOpen();
    return Object.keys(this.secrets).sort();
  }

  /** Re-encrypts under a new passphrase with a fresh salt (key rotation). */
  async changePassphrase(passphrase: string, params?: ScryptParams): Promise<void> {
    this.assertOpen();
    const src: KeySource = params ? { kind: "passphrase", passphrase, params } : { kind: "passphrase", passphrase };
    const { key, header } = await deriveKey(src, undefined);
    this.key?.fill(0);
    this.key = key;
    this.header = header;
    this.flush();
  }

  /** Shared redactor for logs/diagnostics; stays current as secrets change. */
  get redact(): Redactor {
    return this.redactor;
  }

  /** Zero the in-memory key. The instance is unusable afterwards. */
  close(): void {
    this.key?.fill(0);
    this.key = undefined;
    this.secrets = {};
  }

  private assertOpen(): void {
    if (!this.key) throw new VaultError("CLOSED", "vault is closed");
  }

  private flush(): void {
    if (!this.key) throw new VaultError("CLOSED", "vault is closed");
    writeAtomic(this.path, JSON.stringify(encrypt(this.key, this.header, this.secrets)));
  }
}
