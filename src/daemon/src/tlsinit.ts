import { X509Certificate, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { isIP } from "node:net";
import { join } from "node:path";
import { BRAND } from "@clawnexus/brand";
import { CliError } from "@clawnexus/cli";

/**
 * A certificate for the Gateway (docs/03 section 1, SEC-6). With `gateway.tls.enabled` the Gateway serves HTTPS and
 * secure WebSocket using `<data>/tls/cert.pem` and `key.pem`. Put a certificate you already have there, or make a
 * self-signed one here: Node can read certificates but cannot create them, so the small amount of X.509 needed is
 * written out below. The result is checked against Node's own certificate parser and TLS stack in the tests.
 */
export const TLS_DIR = "tls";
export const CERT_FILE = "cert.pem";
export const KEY_FILE = "key.pem";

// ---------------- DER, just enough ----------------

const len = (n: number): Buffer => (n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]));
const tlv = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...p: Buffer[]): Buffer => tlv(0x30, ...p);
const set = (...p: Buffer[]): Buffer => tlv(0x31, ...p);
const octets = (b: Buffer): Buffer => tlv(0x04, b);
const bits = (b: Buffer, unused = 0): Buffer => tlv(0x03, Buffer.from([unused]), b);
const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s, "utf8"));
const bool = (v: boolean): Buffer => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const explicit = (n: number, ...p: Buffer[]): Buffer => tlv(0xa0 + n, ...p);
const integer = (b: Buffer): Buffer => {
  let v = b;
  while (v.length > 1 && v[0] === 0 && (v[1]! & 0x80) === 0) v = v.subarray(1);
  return tlv(0x02, (v[0]! & 0x80) !== 0 ? Buffer.concat([Buffer.from([0]), v]) : v);
};
function oid(dotted: string): Buffer {
  const n = dotted.split(".").map(Number);
  const out: number[] = [n[0]! * 40 + n[1]!];
  for (const x of n.slice(2)) {
    const stack = [x & 0x7f];
    for (let v = x >> 7; v > 0; v >>= 7) stack.unshift((v & 0x7f) | 0x80);
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}
const two = (n: number): string => String(n).padStart(2, "0");
function utcTime(d: Date): Buffer {
  const y = d.getUTCFullYear();
  if (y >= 2050) throw new CliError("BAD_DATE", "the certificate would expire in 2050 or later", "Use a shorter --days.");
  return tlv(0x17, Buffer.from(`${two(y % 100)}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`));
}
const name = (cn: string): Buffer => seq(set(seq(oid("2.5.4.3"), utf8(cn))));
const extension = (id: string, value: Buffer, critical = false): Buffer => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));

function ipBytes(ip: string): Buffer {
  if (isIP(ip) === 4) return Buffer.from(ip.split(".").map(Number));
  // IPv6: expand "::" and read the eight groups
  const [head = "", tail = ""] = ip.split("::");
  const a = head === "" ? [] : head.split(":");
  const b = tail === "" ? [] : tail.split(":");
  const groups = ip.includes("::") ? [...a, ...Array<string>(8 - a.length - b.length).fill("0"), ...b] : a;
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(Number.parseInt(g, 16), i * 2));
  return out;
}

export interface CertOptions {
  /** Names and addresses the certificate is valid for. */
  hosts: readonly string[];
  days?: number;
  now?: () => number;
}

export function validateHosts(hosts: readonly string[]): string[] {
  const out: string[] = [];
  for (const h of hosts) {
    const host = h.trim();
    if (host === "") continue;
    if (isIP(host) === 0 && !/^(\*\.)?[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(host)) {
      throw new CliError("BAD_HOST", `"${h}" is not a host name or an IP address`, "Use names like gateway.example.org or addresses like 192.168.1.20.");
    }
    if (!out.includes(host)) out.push(host);
  }
  if (out.length === 0) throw new CliError("BAD_HOST", "no host names were given", "Name at least one host the Gateway will be reached by.");
  if (out.length > 20) throw new CliError("BAD_HOST", "too many host names (20 at most)", "Use fewer names.");
  return out;
}

/** A self-signed ECDSA P-256 certificate with the given names, and its private key, both PEM. */
export function makeSelfSigned(o: CertOptions): { certPem: string; keyPem: string } {
  const hosts = validateHosts(o.hosts);
  const days = o.days ?? 365;
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new CliError("USAGE", `--days must be between 1 and 3650, got ${days}`, "For example: --days 365");
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const start = new Date((o.now ?? Date.now)() - 5 * 60_000); // a little in the past, so a slightly slow clock elsewhere still accepts it
  const end = new Date(start.getTime() + days * 86_400_000);
  const san = seq(
    ...hosts.map((h) => (isIP(h) !== 0 ? tlv(0x87, ipBytes(h)) : tlv(0x82, Buffer.from(h, "ascii")))),
  );
  const serial = randomBytes(16);
  serial[0]! &= 0x7f; // positive
  const subject = name(`${BRAND.name} Gateway`);
  const algorithm = seq(oid("1.2.840.10045.4.3.2")); // ecdsa-with-SHA256
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))), // version 3
    integer(serial),
    algorithm,
    subject,
    seq(utcTime(start), utcTime(end)),
    subject,
    Buffer.from(spki),
    explicit(
      3,
      seq(
        extension("2.5.29.19", seq(), true), // basicConstraints: not a CA
        extension("2.5.29.15", bits(Buffer.from([0x80]), 7), true), // keyUsage: digitalSignature
        extension("2.5.29.37", seq(oid("1.3.6.1.5.5.7.3.1"))), // serverAuth
        extension("2.5.29.17", san),
      ),
    ),
  );
  const signature = sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" });
  const der = seq(tbs, algorithm, bits(signature));
  const pem = (label: string, body: Buffer): string => `-----BEGIN ${label}-----\n${body.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "")}\n-----END ${label}-----\n`;
  return { certPem: pem("CERTIFICATE", der), keyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}

// ---------------- files ----------------

export interface TlsFiles {
  certPath: string;
  keyPath: string;
}
export const tlsFiles = (dataDir: string): TlsFiles => ({ certPath: join(dataDir, TLS_DIR, CERT_FILE), keyPath: join(dataDir, TLS_DIR, KEY_FILE) });

export interface CertSummary {
  names: string[];
  fingerprint: string;
  notBefore: string;
  notAfter: string;
  daysLeft: number;
  selfSigned: boolean;
}

export function summarize(certPem: string | Buffer, now = Date.now()): CertSummary {
  const c = new X509Certificate(certPem);
  const names = (c.subjectAltName ?? "").split(",").map((s) => s.trim().replace(/^(DNS|IP Address):/, "")).filter((s) => s !== "");
  return {
    names,
    fingerprint: c.fingerprint256.replace(/:/g, "").toLowerCase(),
    notBefore: new Date(c.validFrom).toISOString(),
    notAfter: new Date(c.validTo).toISOString(),
    daysLeft: Math.floor((new Date(c.validTo).getTime() - now) / 86_400_000),
    selfSigned: c.subject === c.issuer,
  };
}

export const colonFingerprint = (hex: string): string => (hex.toUpperCase().match(/../g) ?? []).join(":");

export function initTls(dataDir: string, o: { hosts?: readonly string[]; days?: number; force?: boolean; now?: () => number }): TlsFiles & CertSummary {
  const files = tlsFiles(dataDir);
  if ((existsSync(files.certPath) || existsSync(files.keyPath)) && o.force !== true) {
    throw new CliError("TLS_EXISTS", `${files.certPath} already exists`, "Keep it, or pass --force to replace it (clients that pinned the old one must be told).");
  }
  const defaults = ["localhost", "127.0.0.1", "::1", ...(hostname() ? [hostname()] : [])];
  const hosts = validateHosts([...defaults.filter((h) => { try { validateHosts([h]); return true; } catch { return false; } }), ...(o.hosts ?? [])]);
  const { certPem, keyPem } = makeSelfSigned({ hosts, ...(o.days === undefined ? {} : { days: o.days }), ...(o.now ? { now: o.now } : {}) });
  mkdirSync(join(dataDir, TLS_DIR), { recursive: true, mode: 0o700 });
  writeFileSync(files.keyPath, keyPem, { mode: 0o600 });
  writeFileSync(files.certPath, certPem, { mode: 0o644 });
  return { ...files, ...summarize(certPem, (o.now ?? Date.now)()) };
}

/** Read the certificate and key the Gateway will serve with, refusing a pair that does not belong together. */
export function loadTls(dataDir: string): { cert: Buffer; key: Buffer } {
  const f = tlsFiles(dataDir);
  if (!existsSync(f.certPath) || !existsSync(f.keyPath)) {
    throw new CliError("TLS_MISSING", `gateway.tls.enabled is set but ${f.certPath} or ${f.keyPath} is missing`, `Run \`${BRAND.cli} tls init\` to make a self-signed certificate, or put your own cert.pem and key.pem in ${join(dataDir, TLS_DIR)}.`);
  }
  const cert = readFileSync(f.certPath);
  const key = readFileSync(f.keyPath);
  try {
    const c = new X509Certificate(cert);
    if (!c.checkPrivateKey(createPrivateKey(key))) throw new Error("the key does not match the certificate");
    createPublicKey(c.publicKey.export({ type: "spki", format: "pem" }));
  } catch (e) {
    throw new CliError("TLS_INVALID", `cannot use the certificate: ${e instanceof Error ? e.message : "unreadable"}`, "Check that cert.pem and key.pem are a matching PEM pair.");
  }
  return { cert, key };
}

/** Problems worth telling the owner about, with nothing to read or write beyond the two files. */
export function tlsProblems(dataDir: string, now = Date.now(), platform: NodeJS.Platform = process.platform): Array<{ level: "warn" | "fail"; message: string; fix: string }> {
  const f = tlsFiles(dataDir);
  const out: Array<{ level: "warn" | "fail"; message: string; fix: string }> = [];
  if (!existsSync(f.certPath) || !existsSync(f.keyPath)) return [{ level: "fail", message: "TLS is enabled but the certificate or key is missing", fix: `Run \`${BRAND.cli} tls init\`.` }];
  try {
    loadTls(dataDir);
    const s = summarize(readFileSync(f.certPath), now);
    if (s.daysLeft < 0) out.push({ level: "fail", message: `the certificate expired on ${s.notAfter.slice(0, 10)}`, fix: `Run \`${BRAND.cli} tls init --force\` (or renew yours) and tell clients that pinned it.` });
    else if (s.daysLeft < 30) out.push({ level: "warn", message: `the certificate expires in ${s.daysLeft} day(s)`, fix: `Renew it before then (\`${BRAND.cli} tls init --force\` for a self-signed one).` });
  } catch (e) {
    out.push({ level: "fail", message: e instanceof CliError ? e.message : "the certificate cannot be read", fix: e instanceof CliError ? e.remediation : "Replace it." });
  }
  if (platform !== "win32" && (statSync(f.keyPath).mode & 0o077) !== 0) out.push({ level: "warn", message: "the private key can be read by other users", fix: "chmod 600 " + f.keyPath });
  return out;
}
