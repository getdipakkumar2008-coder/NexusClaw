import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";

/**
 * Device authentication (docs/03 section 3, ADR 0010). A paired device holds an Ed25519 key pair; the Gateway holds only
 * the public half. Every connection proves possession of the private key by signing a fresh, single-use challenge, so
 * there is no long-lived secret to steal from the device's network traffic or the Gateway's database.
 *
 * Wire formats, so that other implementations (phone apps) can follow them exactly:
 *   public key   32 raw bytes, base64url without padding
 *   nonce        32 random bytes, base64url without padding
 *   signature    64 bytes (Ed25519 over the message below), base64url without padding
 *   message      UTF-8 of:  "clawnexus-device-auth-v1\n" + deviceId + "\n" + nonce + "\n" + purpose
 *   purpose      "connect" when signing in, "refresh" when extending a sign-in
 */
export const DEVICE_SCOPES = ["read", "chat", "approve"] as const;
export type DeviceScope = (typeof DEVICE_SCOPES)[number];

export type AuthPurpose = "connect" | "refresh";

export const DEVICE_ID = /^dev_[a-f0-9]{16}$/;
const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const B64URL_64 = /^[A-Za-z0-9_-]{86}$/;

/** Characters for one-time pairing codes: no 0/O/1/I/L, so a code read aloud or typed from a screen is unambiguous. */
export const PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

// Encodings of the points that generate only a tiny group (zero, one, p-1, p, p+1, with either sign bit). A signature by
// such a key proves nothing, so one is never accepted as a device's key.
const WEAK_KEYS = new Set(
  ["00".repeat(32), `01${"00".repeat(31)}`, `ec${"ff".repeat(30)}7f`, `ed${"ff".repeat(30)}7f`, `ee${"ff".repeat(30)}7f`].flatMap((hex) => {
    const flipped = `${hex.slice(0, 62)}${(Number.parseInt(hex.slice(62), 16) ^ 0x80).toString(16).padStart(2, "0")}`;
    return [hex, flipped];
  }),
);
export const isWeakPublicKey = (publicKey: string): boolean => WEAK_KEYS.has(Buffer.from(publicKey, "base64url").toString("hex"));

export const isPublicKey = (s: unknown): s is string => typeof s === "string" && B64URL_32.test(s) && !isWeakPublicKey(s);
export const isSignature = (s: unknown): s is string => typeof s === "string" && B64URL_64.test(s);

export function newNonce(): string {
  return randomBytes(32).toString("base64url");
}

export function deviceAuthMessage(deviceId: string, nonce: string, purpose: AuthPurpose): Buffer {
  return Buffer.from(`clawnexus-device-auth-v1\n${deviceId}\n${nonce}\n${purpose}`, "utf8");
}

export interface DeviceKeyPair {
  /** Sent to the Gateway at pairing. */
  publicKey: string;
  /** Stays on the device. PKCS#8 PEM. */
  privateKeyPem: string;
}

export function generateDeviceKey(): DeviceKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x;
  if (typeof x !== "string") throw new Error("could not export the public key");
  return { publicKey: x, privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString() };
}

export function signDeviceChallenge(privateKeyPem: string, deviceId: string, nonce: string, purpose: AuthPurpose): string {
  return sign(null, deviceAuthMessage(deviceId, nonce, purpose), createPrivateKey(privateKeyPem)).toString("base64url");
}

/** True only for a well-formed signature by this public key over exactly this challenge. Never throws. */
export function verifyDeviceSignature(publicKey: string, deviceId: string, nonce: string, purpose: AuthPurpose, signature: string): boolean {
  if (!isPublicKey(publicKey) || !isSignature(signature) || Buffer.from(signature, "base64url").every((b) => b === 0)) return false;
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
    return verify(null, deviceAuthMessage(deviceId, nonce, purpose), key, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}
