import { describe, expect, it } from "vitest";
import { DEVICE_ID, PAIRING_CODE_ALPHABET, deviceAuthMessage, generateDeviceKey, isPublicKey, isSignature, newNonce, signDeviceChallenge, verifyDeviceSignature } from "./index.js";

const ID = "dev_0123456789abcdef";

describe("device keys and challenges", () => {
  it("makes a 32-byte public key and a 64-byte signature in url-safe base64", () => {
    const k = generateDeviceKey();
    expect(isPublicKey(k.publicKey)).toBe(true);
    expect(Buffer.from(k.publicKey, "base64url")).toHaveLength(32);
    const sig = signDeviceChallenge(k.privateKeyPem, ID, newNonce(), "connect");
    expect(isSignature(sig)).toBe(true);
    expect(Buffer.from(sig, "base64url")).toHaveLength(64);
    expect(k.privateKeyPem).toMatch(/BEGIN PRIVATE KEY/);
  });

  it("accepts only the right key, device, challenge and purpose", () => {
    const a = generateDeviceKey();
    const b = generateDeviceKey();
    const nonce = newNonce();
    const sig = signDeviceChallenge(a.privateKeyPem, ID, nonce, "connect");
    expect(verifyDeviceSignature(a.publicKey, ID, nonce, "connect", sig)).toBe(true);
    expect(verifyDeviceSignature(b.publicKey, ID, nonce, "connect", sig)).toBe(false); // someone else's key
    expect(verifyDeviceSignature(a.publicKey, "dev_ffffffffffffffff", nonce, "connect", sig)).toBe(false); // another device's name
    expect(verifyDeviceSignature(a.publicKey, ID, newNonce(), "connect", sig)).toBe(false); // an old answer to a new question
    expect(verifyDeviceSignature(a.publicKey, ID, nonce, "refresh", sig)).toBe(false); // a sign-in answer cannot extend a sign-in
  });

  it("never throws on garbage", () => {
    const k = generateDeviceKey();
    for (const bad of ["", "x", "!!!", "A".repeat(86), "A".repeat(200)]) expect(verifyDeviceSignature(k.publicKey, ID, "n", "connect", bad)).toBe(false);
    expect(verifyDeviceSignature("short", ID, "n", "connect", "A".repeat(86))).toBe(false);
    expect(verifyDeviceSignature("A".repeat(43), ID, "n", "connect", "A".repeat(86))).toBe(false);
  });

  it("refuses keys that would make a signature meaningless, and the all-zero signature", () => {
    const zero = Buffer.alloc(32).toString("base64url");
    const one = Buffer.concat([Buffer.from([1]), Buffer.alloc(31)]).toString("base64url");
    for (const weak of [zero, one]) {
      expect(isPublicKey(weak)).toBe(false);
      expect(verifyDeviceSignature(weak, ID, "n", "connect", Buffer.alloc(64).toString("base64url"))).toBe(false);
    }
    const k = generateDeviceKey();
    expect(verifyDeviceSignature(k.publicKey, ID, "n", "connect", Buffer.alloc(64).toString("base64url"))).toBe(false);
  });

  it("fixes the exact bytes that are signed, so other implementations can follow", () => {
    expect(deviceAuthMessage(ID, "NONCE", "connect").toString("utf8")).toBe(`clawnexus-device-auth-v1\n${ID}\nNONCE\nconnect`);
  });

  it("gives every challenge 256 fresh bits", () => {
    const seen = new Set(Array.from({ length: 200 }, () => newNonce()));
    expect(seen.size).toBe(200);
    expect(Buffer.from([...seen][0]!, "base64url")).toHaveLength(32);
  });

  it("uses pairing code characters that cannot be mistaken for one another", () => {
    expect(PAIRING_CODE_ALPHABET).not.toMatch(/[01OIL]/);
    expect(new Set(PAIRING_CODE_ALPHABET).size).toBe(PAIRING_CODE_ALPHABET.length);
    expect(DEVICE_ID.test(ID)).toBe(true);
    expect(DEVICE_ID.test("dev_xyz")).toBe(false);
  });
});
