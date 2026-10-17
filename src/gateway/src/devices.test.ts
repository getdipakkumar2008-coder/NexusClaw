import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { generateDeviceKey, signDeviceChallenge, type DeviceKeyPair } from "@clawnexus/protocol";
import { FakeProvider } from "@clawnexus/sessions";
import { Gateway, startGateway, type GatewayOptions } from "./index.js";

interface Res {
  t: "res";
  id: string;
  ok: boolean;
  result?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  error?: { code: string; message: string; remediation: string; retryable: boolean };
}

class Client {
  private waiters = new Map<string, (r: Res) => void>();
  private n = 0;
  closed?: { code: number; reason: string };
  private constructor(readonly ws: WebSocket) {
    ws.on("message", (d) => {
      const f = JSON.parse(d.toString()) as Res | { t: string };
      if (f.t === "res") this.waiters.get((f as Res).id)?.(f as Res);
    });
    ws.on("close", (code, reason) => (this.closed = { code, reason: reason.toString() }));
  }
  static async open(port: number): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return new Client(ws);
  }
  call(method: string, params?: unknown): Promise<Res> {
    const id = `c-${++this.n}`;
    return new Promise((resolve) => {
      this.waiters.set(id, resolve);
      this.ws.send(JSON.stringify({ t: "req", id, method, params }));
    });
  }
  hello(auth: unknown): Promise<Res> {
    return this.call("connection.hello", { protocol: { major: 1, minor: 0 }, client: { kind: "test", version: "0" }, auth });
  }
  async until(pred: () => boolean, ms = 3000): Promise<void> {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error("timed out waiting");
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  close(): void {
    this.ws.close();
  }
}

let dir: string;
let gw: Gateway;
let port: number;
let clients: Client[];

async function boot(extra: Partial<GatewayOptions> = {}): Promise<void> {
  const started = await startGateway({ dataDir: dir, port: 0, provider: new FakeProvider(), ...extra });
  gw = started.gateway;
  port = started.port;
}
const ownerToken = (): string => readFileSync(join(dir, "gateway.token"), "utf8").trim();
async function open(): Promise<Client> {
  const c = await Client.open(port);
  clients.push(c);
  return c;
}
async function owner(): Promise<Client> {
  const c = await open();
  expect((await c.hello({ token: ownerToken() })).ok).toBe(true);
  return c;
}

interface Paired {
  id: string;
  key: DeviceKeyPair;
}
/** The owner makes a code; a new device uses it. Returns who the device is. */
async function pairDevice(scopes: string[] = ["read", "chat"], name = "test phone"): Promise<Paired> {
  const o = await owner();
  const begin = await o.call("device.pair.begin", { name, scopes });
  expect(begin.ok).toBe(true);
  const key = generateDeviceKey();
  const d = await open();
  const r = await d.hello({ pair: { code: begin.result.code, publicKey: key.publicKey } });
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  expect(r.result).toMatchObject({ role: "device", device: { name, scopes } });
  d.close();
  return { id: r.result.device.id, key };
}
/** Sign in as an existing device, the way a client does. */
async function signIn(p: Paired, tamper?: (sig: string) => string): Promise<{ c: Client; verify: Res }> {
  const c = await open();
  const h = await c.hello({ device: { id: p.id } });
  expect(h.ok, JSON.stringify(h.error)).toBe(true);
  const sig = signDeviceChallenge(p.key.privateKeyPem, p.id, h.result.challenge.nonce, "connect");
  const verify = await c.call("auth.verify", { signature: tamper ? tamper(sig) : sig });
  return { c, verify };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gw-dev-"));
  clients = [];
});
afterEach(async () => {
  for (const c of clients) c.close();
  await gw?.stop();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("pairing and signing in", () => {
  it("pairs with a one-time code, then signs in by signing a fresh challenge", async () => {
    await boot();
    const p = await pairDevice();
    const { c, verify } = await signIn(p);
    expect(verify.ok).toBe(true);
    expect(verify.result).toMatchObject({ role: "device", device: { id: p.id, scopes: ["read", "chat"] }, leaseMs: 15 * 60_000 });
    expect((await c.call("status")).ok).toBe(true);
    // the owner sees the device and when it last connected
    const list = (await (await owner()).call("device.list")).result;
    expect(list.devices).toHaveLength(1);
    expect(list.devices[0]).toMatchObject({ id: p.id, scopes: ["read", "chat"] });
    expect(list.devices[0].lastSeenAt).toBeGreaterThan(0);
    expect(JSON.stringify(list)).not.toContain(p.key.publicKey); // the list shows who, not key material
  });

  it("will not take a wrong, reused or expired code", async () => {
    await boot();
    const o = await owner();
    const { result } = await o.call("device.pair.begin", {});
    const k = generateDeviceKey();
    const a = await open();
    expect((await a.hello({ pair: { code: "AAAAAAAAAA", publicKey: k.publicKey } })).error?.code).toBe("AUTH.BAD_PAIRING_CODE");
    const b = await open();
    expect((await b.hello({ pair: { code: result.code, publicKey: k.publicKey } })).ok).toBe(true);
    const c = await open();
    expect((await c.hello({ pair: { code: result.code, publicKey: generateDeviceKey().publicKey } })).error?.code).toBe("AUTH.BAD_PAIRING_CODE");
  });

  it("rejects a malformed key, a weak key, and a hello that offers more than one proof", async () => {
    await boot();
    const o = await owner();
    const code = (await o.call("device.pair.begin", {})).result.code;
    const a = await open();
    expect((await a.hello({ pair: { code, publicKey: "short" } })).ok).toBe(false);
    const weak = Buffer.alloc(32).toString("base64url");
    const b = await open();
    expect((await b.hello({ pair: { code: (await o.call("device.pair.begin", {})).result.code, publicKey: weak } })).error?.code).toBe("AUTH.PAIRING");
    const c = await open();
    expect((await c.hello({ token: ownerToken(), device: { id: "dev_0123456789abcdef" } })).ok).toBe(false);
  });

  it("refuses an unknown device, a wrong signature and a signature made over someone else's challenge", async () => {
    await boot();
    const p = await pairDevice();
    const unknown = await open();
    expect((await unknown.hello({ device: { id: "dev_0123456789abcdef" } })).error?.code).toBe("AUTH.BAD_DEVICE");

    const wrongKey = await signIn({ id: p.id, key: generateDeviceKey() });
    expect(wrongKey.verify.error?.code).toBe("AUTH.BAD_SIGNATURE");
    expect(wrongKey.c.closed).toBeUndefined();
    expect((await wrongKey.c.call("status")).error?.code).toBe("AUTH.REQUIRED"); // still not signed in

    // a signature for the "refresh" purpose cannot be used to sign in
    const c = await open();
    const h = await c.hello({ device: { id: p.id } });
    const asRefresh = signDeviceChallenge(p.key.privateKeyPem, p.id, h.result.challenge.nonce, "refresh");
    expect((await c.call("auth.verify", { signature: asRefresh })).error?.code).toBe("AUTH.BAD_SIGNATURE");
  });

  it("a recorded sign-in cannot be replayed: each challenge is new and works once", async () => {
    await boot();
    const p = await pairDevice();
    const first = await open();
    const h1 = await first.hello({ device: { id: p.id } });
    const sig1 = signDeviceChallenge(p.key.privateKeyPem, p.id, h1.result.challenge.nonce, "connect");
    expect((await first.call("auth.verify", { signature: sig1 })).ok).toBe(true);

    // an eavesdropper replays that exact answer on a new connection
    const replay = await open();
    const h2 = await replay.hello({ device: { id: p.id } });
    expect(h2.result.challenge.nonce).not.toBe(h1.result.challenge.nonce);
    expect((await replay.call("auth.verify", { signature: sig1 })).error?.code).toBe("AUTH.BAD_SIGNATURE");
    // and the challenge is spent even by a failed try
    const again = signDeviceChallenge(p.key.privateKeyPem, p.id, h2.result.challenge.nonce, "connect");
    expect((await replay.call("auth.verify", { signature: again })).error?.code).toBe("AUTH.NO_CHALLENGE");
    // answering twice on the first connection is also refused
    expect((await first.call("auth.verify", { signature: sig1 })).error?.code).toBe("UNSUPPORTED.ALREADY_AUTHENTICATED");
  });

  it("refuses a challenge answered too late", async () => {
    await boot({ challengeTtlMs: 150 });
    const p = await pairDevice();
    const c = await open();
    const h = await c.hello({ device: { id: p.id } });
    await new Promise((r) => setTimeout(r, 300));
    const sig = signDeviceChallenge(p.key.privateKeyPem, p.id, h.result.challenge.nonce, "connect");
    expect((await c.call("auth.verify", { signature: sig })).error?.code).toBe("AUTH.CHALLENGE_EXPIRED");
  });

  it("locks out an address that keeps failing", async () => {
    await boot({ maxAuthFailures: 3 });
    const p = await pairDevice();
    for (let i = 0; i < 3; i++) expect((await signIn({ id: p.id, key: generateDeviceKey() })).verify.error?.code).toBe("AUTH.BAD_SIGNATURE");
    const c = await open();
    expect((await c.hello({ device: { id: p.id } })).error?.code).toBe("AUTH.LOCKED");
    expect((await (await open()).hello({ token: ownerToken() })).error?.code).toBe("AUTH.LOCKED"); // shared by address, as before
  });
});

describe("what a device may do", () => {
  it("is limited to its scopes, and everything else stays with the owner", async () => {
    await boot();
    const reader = await signIn(await pairDevice(["read"]));
    expect((await reader.c.call("session.list")).ok).toBe(true);
    expect((await reader.c.call("approval.list")).ok).toBe(true);
    for (const [method, params] of [
      ["session.create", {}],
      ["session.send", { session: "s_x", text: "hi" }],
      ["approval.decide", { id: "a", approve: true }],
    ] as const) {
      const r = await reader.c.call(method, params);
      expect(r.error?.code, method).toBe("AUTH.FORBIDDEN");
      expect(r.error?.remediation).toMatch(/scope/);
    }
    // owner-only whatever the scopes
    const all = await signIn(await pairDevice(["read", "chat", "approve"], "everything"));
    for (const [method, params] of [
      ["plugin.list", {}],
      ["tool.call", { tool: "fs.list", args: {} }],
      ["tool.list", {}],
      ["memory.scopes", {}],
      ["memory.erase", { scope: "all" }],
      ["pairing.owner", { channel: "telegram", id: "1" }],
      ["pairing.list", {}],
      ["channel.webchat.link", {}],
      ["device.list", {}],
      ["device.pair.begin", {}],
      ["device.revoke", { id: "dev_0123456789abcdef" }],
      ["session.delete", { session: "s_x" }],
      ["session.import", { content: "" }],
      ["session.export", { session: "s_x" }],
    ] as const) {
      expect((await all.c.call(method, params)).error?.code, method).toBe("AUTH.FORBIDDEN");
    }
  });

  it("can chat with the scope 'chat', and its messages are recorded as coming from that device", async () => {
    await boot();
    const p = await pairDevice(["read", "chat"]);
    const { c } = await signIn(p);
    const s = (await c.call("session.create", { channel: "app", conversation: "phone", scope: "owner" })).result.session;
    expect((await c.call("session.send", { session: s.id, text: "hello from the phone" })).ok).toBe(true);
    await gw.sessions!.idle();
    const m = (await c.call("session.get", { session: s.id })).result.messages as Array<{ role: string; sender: string; content: string }>;
    expect(m.find((x) => x.role === "user")).toMatchObject({ sender: `device:${p.id}`, content: "hello from the phone" });
    expect(m.find((x) => x.role === "assistant")?.content).toContain("echo: hello from the phone");
  });

  it("can decide approvals only with the scope 'approve', and the decision names the device", async () => {
    await boot();
    const o = await owner();
    const p = await pairDevice(["read", "approve"]);
    const { c } = await signIn(p);
    const asked = (await o.call("tool.call", { tool: "fs.write", args: { path: "a.txt", content: "x" }, tainted: true })).result;
    expect(asked.status).toBe("approval_required");
    expect((await c.call("approval.list")).result.approvals).toHaveLength(1);
    expect((await c.call("approval.decide", { id: asked.approvalId, approve: true })).ok).toBe(true);
    expect(gw.approvals.get(asked.approvalId)).toMatchObject({ state: "approved", decidedBy: `device:${p.id}` });
  });
});

describe("how long a sign-in lasts", () => {
  it("ends after the lease unless the device proves itself again", async () => {
    await boot({ deviceLeaseMs: 400 });
    const { c } = await signIn(await pairDevice());
    expect((await c.call("status")).ok).toBe(true);
    await c.until(() => c.closed !== undefined, 2000);
    expect(c.closed).toMatchObject({ code: 4401, reason: expect.stringMatching(/expired/) });
  });

  it("is extended by answering a fresh challenge, and only by the same device", async () => {
    await boot({ deviceLeaseMs: 500 });
    const p = await pairDevice();
    const { c } = await signIn(p);
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const ch = await c.call("auth.challenge");
      expect(ch.ok).toBe(true);
      const r = await c.call("auth.refresh", { signature: signDeviceChallenge(p.key.privateKeyPem, p.id, ch.result.nonce, "refresh") });
      expect(r.ok, JSON.stringify(r.error)).toBe(true);
    }
    expect(c.closed).toBeUndefined(); // well past the original lease
    expect((await c.call("status")).ok).toBe(true);

    // a refresh answer made with another key is refused, and a sign-in answer cannot extend a sign-in
    const ch = await c.call("auth.challenge");
    expect((await c.call("auth.refresh", { signature: signDeviceChallenge(generateDeviceKey().privateKeyPem, p.id, ch.result.nonce, "refresh") })).error?.code).toBe("AUTH.BAD_SIGNATURE");
    const ch2 = await c.call("auth.challenge");
    expect((await c.call("auth.refresh", { signature: signDeviceChallenge(p.key.privateKeyPem, p.id, ch2.result.nonce, "connect") })).error?.code).toBe("AUTH.BAD_SIGNATURE");
  });

  it("is not available on the owner's own connection", async () => {
    await boot();
    const o = await owner();
    expect((await o.call("auth.challenge")).ok).toBe(false);
    expect((await o.call("auth.refresh", { signature: "x" })).ok).toBe(false);
  });
});

describe("revoking", () => {
  it("disconnects the device at once and keeps it out", async () => {
    await boot();
    const p = await pairDevice();
    const { c } = await signIn(p);
    expect((await c.call("status")).ok).toBe(true);
    const o = await owner();
    expect((await o.call("device.revoke", { id: p.id })).ok).toBe(true);
    await c.until(() => c.closed !== undefined);
    expect(c.closed).toMatchObject({ code: 4401, reason: "device revoked" });

    const again = await open();
    expect((await again.hello({ device: { id: p.id } })).error?.code).toBe("AUTH.REVOKED");
    expect((await o.call("device.list")).result.devices[0].revokedAt).toBeGreaterThan(0);
    expect((await o.call("device.revoke", { id: "dev_0123456789abcdef" })).error?.code).toBe("AUTH.BAD_DEVICE");
  });

  it("also stops a connection whose challenge was issued before the revoke", async () => {
    await boot();
    const p = await pairDevice();
    const c = await open();
    const h = await c.hello({ device: { id: p.id } });
    await (await owner()).call("device.revoke", { id: p.id });
    const sig = signDeviceChallenge(p.key.privateKeyPem, p.id, h.result.challenge.nonce, "connect");
    expect((await c.call("auth.verify", { signature: sig })).error?.code).toBe("AUTH.BAD_SIGNATURE");
  });
});

describe("what is stored", () => {
  it("holds public keys and a record of what happened, and no private key or code", async () => {
    await boot();
    const o = await owner();
    const begin = (await o.call("device.pair.begin", { name: "tablet" })).result;
    const key = generateDeviceKey();
    await (await open()).hello({ pair: { code: begin.code, publicKey: key.publicKey } });
    const events = JSON.stringify(gw.events.readSince(0, { limit: 5000 }));
    expect(events).toContain("device.paired");
    expect(events).not.toContain(begin.code);
    expect(events).not.toContain("PRIVATE KEY");
    const db = readFileSync(join(dir, "gateway.db"));
    expect(db.includes(Buffer.from(begin.code))).toBe(false);
  });

  it("limits how many devices and pending codes exist", async () => {
    await boot();
    const o = await owner();
    for (let i = 0; i < 5; i++) expect((await o.call("device.pair.begin", {})).ok).toBe(true);
    expect((await o.call("device.pair.begin", {})).error?.code).toBe("AUTH.PAIRING");
    expect((await o.call("device.list")).result.pendingCodes).toBe(5);
  });
});
