// Spike 4: Gateway-signed delegated send grant verified by a relay. NOT real App Attest / Play Integrity
// (those need real devices and Apple/Google services); this validates only the grant binding logic.
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";

const b64u = (b) => Buffer.from(b).toString("base64url");
const canonical = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1))));

// Keys: gateway signs grants; device registered (attested) with the relay along with the gateway pubkey.
const gw = generateKeyPairSync("ed25519");
const rogue = generateKeyPairSync("ed25519");

const relay = {
  id: "relay-1",
  registrations: new Map(), // deviceId -> { tokenHash, gatewayPub, attested }
  seenNonces: new Set(),
  perGrantCount: new Map(),
  register(deviceId, token, gatewayPub, attested) {
    if (!attested) return { ok: false, reason: "attestation_failed" };
    this.registrations.set(deviceId, { tokenHash: createHash("sha256").update(token).digest("hex"), gatewayPub, attested });
    return { ok: true };
  },
  send(grant, sig, token, nowMs) {
    const reg = this.registrations.get(grant.deviceId);
    if (!reg) return { ok: false, reason: "unknown_device" };
    if (grant.relayId !== this.id) return { ok: false, reason: "wrong_relay" };
    if (nowMs >= grant.exp) return { ok: false, reason: "expired" };
    if (grant.tokenHash !== reg.tokenHash || createHash("sha256").update(token).digest("hex") !== reg.tokenHash)
      return { ok: false, reason: "token_mismatch" };
    if (!verify(null, Buffer.from(canonical(grant)), reg.gatewayPub, Buffer.from(sig, "base64url")))
      return { ok: false, reason: "bad_signature" };
    const n = (this.perGrantCount.get(grant.nonce) ?? 0) + 1;
    this.perGrantCount.set(grant.nonce, n);
    if (n > grant.maxSends) return { ok: false, reason: "rate_limited" };
    return { ok: true };
  },
};

const token = "apns-token-abc";
const tokenHash = createHash("sha256").update(token).digest("hex");
const now = Date.now();
const grant = { deviceId: "dev-1", relayId: "relay-1", tokenHash, exp: now + 60_000, nonce: "n1", maxSends: 3 };
const mk = (g, key = gw.privateKey) => b64u(sign(null, Buffer.from(canonical(g)), key));

const results = {};
results.unattestedRegistration = relay.register("dev-x", "t", gw.publicKey, false);
relay.register("dev-1", token, gw.publicKey, true);
results.valid = relay.send(grant, mk(grant), token, now);
results.tamperedDevice = relay.send({ ...grant, deviceId: "dev-1", maxSends: 999 }, mk(grant), token, now);
results.signedByRogueGateway = relay.send(grant, mk(grant, rogue.privateKey), token, now);
results.expired = relay.send(grant, mk(grant), token, now + 120_000);
results.wrongRelay = relay.send({ ...grant, relayId: "relay-2" }, mk({ ...grant, relayId: "relay-2" }), token, now);
results.wrongToken = relay.send(grant, mk(grant), "other-token", now);
results.send2 = relay.send(grant, mk(grant), token, now);
results.send3 = relay.send(grant, mk(grant), token, now);
results.send4OverLimit = relay.send(grant, mk(grant), token, now);

const expectOk = ["valid", "send2", "send3"];
const bad = Object.entries(results).filter(([k, v]) => (expectOk.includes(k) ? !v.ok : v.ok));
console.log(JSON.stringify(results, null, 2));
console.log(bad.length ? `UNEXPECTED: ${bad.map(([k]) => k)}` : "all expectations met");
process.exit(bad.length ? 1 : 0);
