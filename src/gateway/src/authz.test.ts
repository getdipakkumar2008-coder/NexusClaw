import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { generateDeviceKey, signDeviceChallenge } from "@clawnexus/protocol";
import { FakeProvider } from "@clawnexus/sessions";
import { Gateway, startGateway } from "./index.js";

/**
 * The authorisation matrix (docs/06 section 9). Every method the Gateway answers is listed here with who may call it.
 * The test finds the methods by reading the server's source, so a method added without a row in this table fails the
 * build: nobody can add a door and forget to say who may use it.
 */
type Who = "owner" | "device:read" | "device:chat" | "device:approve" | "bridge";

/** Methods that may be called by more than the owner. Everything not listed here is the owner's alone. */
const ALSO_ALLOWED: Record<string, Who[]> = {
  status: ["device:read"],
  "events.subscribe": ["device:read"],
  "events.unsubscribe": ["device:read"],
  "session.list": ["device:read"],
  "session.get": ["device:read"],
  "approval.list": ["device:read"],
  "blob.get": ["device:read"],
  "session.create": ["device:chat"],
  "session.send": ["device:chat"],
  "session.cancel": ["device:chat"],
  "approval.decide": ["device:approve"],
  "tool.list": ["bridge"],
  "tool.call": ["bridge"],
  "approval.status": ["bridge"],
};

/** Methods that are part of signing in, not of the matrix. */
const HANDSHAKE = new Set(["connection.hello", "auth.verify", "auth.challenge", "auth.refresh"]);

interface Res {
  t: "res";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}
class Client {
  private waiters = new Map<string, (r: Res) => void>();
  private n = 0;
  private constructor(readonly ws: WebSocket) {
    ws.on("message", (d) => {
      const f = JSON.parse(d.toString()) as Res | { t: string };
      if (f.t === "res") this.waiters.get((f as Res).id)?.(f as Res);
    });
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
  close(): void {
    this.ws.close();
  }
}

let dir: string;
let gw: Gateway;
let port: number;
let clients: Client[];

const token = (): string => readFileSync(join(dir, "gateway.token"), "utf8").trim();
async function open(): Promise<Client> {
  const c = await Client.open(port);
  clients.push(c);
  return c;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "gw-authz-"));
  clients = [];
  const started = await startGateway({ dataDir: dir, port: 0, provider: new FakeProvider() });
  gw = started.gateway;
  port = started.port;
});
afterEach(async () => {
  for (const c of clients) c.close();
  await gw?.stop();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** Methods named in the server's source, so the table cannot fall behind. */
function methodsInSource(): string[] {
  const src = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
  const found = new Set<string>();
  for (const m of src.matchAll(/case "([a-z]+(?:\.[a-z]+)+|status)"/g)) found.add(m[1] as string);
  return [...found].filter((m) => !HANDSHAKE.has(m)).sort();
}

async function signedInDevice(scopes: Array<"read" | "chat" | "approve">): Promise<Client> {
  const o = await open();
  await o.hello({ token: token() });
  const begin = (await o.call("device.pair.begin", { scopes })).result as { code: string };
  const key = generateDeviceKey();
  const pairing = await open();
  const paired = await pairing.hello({ pair: { code: begin.code, publicKey: key.publicKey } });
  const deviceId = (paired.result as { device: { id: string } }).device.id;
  const d = await open();
  const h = await d.hello({ device: { id: deviceId } });
  const nonce = (h.result as { challenge: { nonce: string } }).challenge.nonce;
  expect((await d.call("auth.verify", { signature: signDeviceChallenge(key.privateKeyPem, deviceId, nonce, "connect") })).ok).toBe(true);
  return d;
}

async function as(who: Who): Promise<Client> {
  if (who === "owner") {
    const c = await open();
    expect((await c.hello({ token: token() })).ok).toBe(true);
    return c;
  }
  if (who === "bridge") {
    const s = gw.sessions!.getOrCreate({ channel: "local", conversation: "authz", scope: "owner" }, "owner");
    const c = await open();
    expect((await c.hello({ token: gw.mintBridge({ session: s.id, principal: "owner" }).token })).ok).toBe(true);
    return c;
  }
  return signedInDevice([who.slice(7) as "read" | "chat" | "approve"]);
}

const forbidden = (r: Res): boolean => r.ok === false && r.error?.code === "AUTH.FORBIDDEN";

describe("the authorisation matrix", () => {
  const methods = methodsInSource();

  it("finds the methods in the source, and every one of them has a row (an unlisted method is the owner's alone)", () => {
    expect(methods.length).toBeGreaterThan(40);
    for (const m of Object.keys(ALSO_ALLOWED)) expect(methods, `the table names ${m}, which the server does not answer`).toContain(m);
  });

  it("lets each kind of caller reach exactly the methods the table says, and no others", async () => {
    const who: Who[] = ["owner", "device:read", "device:chat", "device:approve", "bridge"];
    const mismatches: string[] = [];
    for (const w of who) {
      const c = await as(w);
      for (const m of methods) {
        const allowed = w === "owner" || (ALSO_ALLOWED[m] ?? []).includes(w);
        // Empty parameters: a method that is allowed fails on its own validation (or succeeds); one that is not allowed must say FORBIDDEN first.
        const r = await c.call(m, {});
        if (forbidden(r) === allowed) mismatches.push(`${w} ${allowed ? "was refused" : "was let through"} on ${m}`);
        if (c.ws.readyState !== WebSocket.OPEN) break;
      }
      c.close();
    }
    expect(mismatches).toEqual([]);
  }, 120_000);

  it("refuses every method to a caller who has not signed in", async () => {
    const c = await open();
    const leaks: string[] = [];
    for (const m of methods) {
      const r = await c.call(m, {});
      if (r.ok || !/^AUTH\./.test(r.error?.code ?? "")) leaks.push(`${m}: ${JSON.stringify(r.ok ? "ok" : r.error?.code)}`);
    }
    expect(leaks).toEqual([]);
  });

  it("refuses a wrong token, an empty one and a malformed one, and sends nothing a stranger could use", async () => {
    for (const bad of ["", "x", "cnt_" + "0".repeat(43), token().slice(0, -1), token() + "x", "Bearer " + token()]) {
      const c = await open();
      const r = await c.hello({ token: bad });
      expect(r.ok, bad).toBe(false);
      expect(JSON.stringify(r)).not.toContain(token());
      c.close();
    }
  });

  it("cuts off a device when it is revoked, and a revoked device cannot sign in again", async () => {
    const o = await as("owner");
    const begin = (await o.call("device.pair.begin", { scopes: ["read", "chat", "approve"] })).result as { code: string };
    const key = generateDeviceKey();
    const pairing = await open();
    const deviceId = ((await pairing.hello({ pair: { code: begin.code, publicKey: key.publicKey } })).result as { device: { id: string } }).device.id;
    const d = await open();
    const nonce = ((await d.hello({ device: { id: deviceId } })).result as { challenge: { nonce: string } }).challenge.nonce;
    await d.call("auth.verify", { signature: signDeviceChallenge(key.privateKeyPem, deviceId, nonce, "connect") });
    const closed = new Promise<number>((resolve) => d.ws.once("close", (code) => resolve(code)));
    await o.call("device.revoke", { id: deviceId });
    expect(await closed).toBe(4401);
    const again = await open();
    const h = await again.hello({ device: { id: deviceId } });
    if (h.ok) {
      const n2 = (h.result as { challenge: { nonce: string } }).challenge.nonce;
      expect((await again.call("auth.verify", { signature: signDeviceChallenge(key.privateKeyPem, deviceId, n2, "connect") })).ok).toBe(false);
    }
  });

  it("does not let a tool bridge name another session, principal or trust level", async () => {
    const guest = gw.sessions!.getOrCreate({ channel: "telegram", conversation: "default|u1", scope: "u1" }, "guest");
    const c = await open();
    await c.hello({ token: gw.mintBridge({ session: guest.id, principal: "owner" }).token });
    for (const extra of [{ principal: "owner" }, { session: "someone-else" }, { profile: "trusted" }, { tainted: false }, { sandboxed: true }, { elevation: 4 }]) {
      const r = await c.call("tool.call", { tool: "fs.write", args: { path: "x", content: "y" }, ...extra });
      expect(r.ok && (r.result as { status?: string }).status === "ok", JSON.stringify(extra)).toBe(false);
    }
  });
});
