import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Gateway, startGateway, type GatewayOptions } from "./index.js";

interface Res {
  t: "res";
  id: string;
  ok: boolean;
  result?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  error?: { code: string; message: string; remediation: string; retryable: boolean };
}
interface Evt {
  t: "evt";
  seq: number;
  type: string;
  session?: string;
  data?: unknown;
}

class Client {
  readonly events: Evt[] = [];
  private waiters = new Map<string, (r: Res) => void>();
  private n = 0;
  closed?: { code: number; reason: string };
  private constructor(readonly ws: WebSocket) {
    ws.on("message", (d) => {
      const f = JSON.parse(d.toString()) as Res | Evt;
      if (f.t === "res") this.waiters.get(f.id)?.(f);
      else this.events.push(f);
    });
    ws.on("close", (code, reason) => (this.closed = { code, reason: reason.toString() }));
  }
  static async open(port: number, headers: Record<string, string> = {}, path = "/v1/ws"): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
      ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
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
  async hello(token: string, major = 1): Promise<Res> {
    return this.call("connection.hello", { protocol: { major, minor: 0 }, client: { kind: "test", version: "0" }, auth: { token } });
  }
  async waitFor(pred: () => boolean, ms = 2000): Promise<void> {
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
  const started = await startGateway({ dataDir: dir, port: 0, ...extra });
  gw = started.gateway;
  port = started.port;
}
const token = (): string => readFileSync(join(dir, "gateway.token"), "utf8").trim();
async function authed(): Promise<Client> {
  const c = await Client.open(port);
  clients.push(c);
  expect((await c.hello(token())).ok).toBe(true);
  return c;
}
function httpGet(path: string, host?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers: host ? { host } : {} }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gw-test-"));
  clients = [];
});
afterEach(async () => {
  for (const c of clients) c.close();
  await gw?.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("HTTP", () => {
  it("serves health and readiness, rejects other methods/paths", async () => {
    await boot();
    expect(await httpGet("/healthz")).toEqual({ status: 200, body: '{"ok":true}' });
    expect((await httpGet("/readyz")).status).toBe(200);
    expect((await httpGet("/nope")).status).toBe(404);
  });

  it("rejects a foreign Host header (DNS rebinding)", async () => {
    await boot();
    expect((await httpGet("/healthz", "evil.example.com")).status).toBe(403);
    expect((await httpGet("/healthz", `localhost:${port}`)).status).toBe(200);
  });
});

describe("startup safety", () => {
  it("refuses non-loopback binds until TLS exists", () => {
    expect(() => new Gateway({ dataDir: dir, host: "0.0.0.0", port: 0 })).toThrow(/loopback/);
  });

  it("creates a private token once and reuses it across restarts, keeping event numbering", async () => {
    await boot();
    const t1 = token();
    expect(t1.length).toBeGreaterThanOrEqual(32);
    if (process.platform !== "win32") expect(statSync(join(dir, "gateway.token")).mode & 0o077).toBe(0);
    const seq1 = gw.events.latestSeq();
    await gw.stop();
    await boot();
    expect(token()).toBe(t1);
    expect(gw.events.latestSeq()).toBeGreaterThan(seq1);
  });
});

describe("WebSocket upgrade", () => {
  it("rejects browser origins that are not allow-listed (cross-site hijack)", async () => {
    await boot();
    await expect(Client.open(port, { Origin: "https://evil.example.com" })).rejects.toThrow(/403/);
  });

  it("accepts an allow-listed origin and rejects other paths", async () => {
    await boot({ allowedOrigins: ["http://localhost:5173"] });
    clients.push(await Client.open(port, { Origin: "http://localhost:5173" }));
    await expect(Client.open(port, {}, "/other")).rejects.toThrow(/404/);
  });
});

describe("authentication", () => {
  it("requires hello before any method", async () => {
    await boot();
    const c = await Client.open(port);
    clients.push(c);
    const r = await c.call("status");
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("AUTH.REQUIRED");
  });

  it("accepts the right token and rejects wrong, missing and incompatible-protocol hellos", async () => {
    await boot();
    const c = await Client.open(port);
    clients.push(c);
    expect((await c.hello("wrong")).error?.code).toBe("AUTH.BAD_TOKEN");
    expect((await c.call("connection.hello", { protocol: { major: 1, minor: 0 }, client: { kind: "t", version: "0" } })).error?.code).toBe("AUTH.BAD_TOKEN");
    expect((await c.hello(token(), 2)).error?.code).toBe("UNSUPPORTED.PROTOCOL");
    const ok = await c.hello(token());
    expect(ok.ok).toBe(true);
    expect(ok.result.role).toBe("owner");
    expect((await c.hello(token())).error?.code).toBe("UNSUPPORTED.ALREADY_AUTHENTICATED");
  });

  it("locks out an address after repeated failures, even for the right token", async () => {
    await boot({ maxAuthFailures: 3 });
    const c = await Client.open(port);
    clients.push(c);
    for (let i = 0; i < 3; i++) await c.hello("nope");
    expect((await c.hello(token())).error?.code).toBe("AUTH.LOCKED");
  });

  it("drops connections that never authenticate", async () => {
    await boot({ helloTimeoutMs: 100 });
    const c = await Client.open(port);
    await c.waitFor(() => c.closed !== undefined);
    expect(c.closed?.code).toBe(4408);
  });
});

describe("protocol hygiene", () => {
  it("closes on malformed frames, binary frames and oversized frames", async () => {
    await boot();
    const bad = await Client.open(port);
    bad.ws.send("{not json");
    await bad.waitFor(() => bad.closed !== undefined);
    expect(bad.closed?.code).toBe(1008);

    const bin = await Client.open(port);
    bin.ws.send(Buffer.from([1, 2, 3]));
    await bin.waitFor(() => bin.closed !== undefined);
    expect(bin.closed?.code).toBe(1003);

    const big = await Client.open(port);
    big.ws.send("x".repeat(1024 * 1024 + 10));
    await big.waitFor(() => big.closed !== undefined);
    expect([1009, 1006]).toContain(big.closed?.code); // 1009 "too big"; some stacks surface the abrupt close as 1006
  });

  it("rate limits requests per connection", async () => {
    await boot({ requestsPerSecond: 2 });
    const c = await authed();
    const results = await Promise.all(Array.from({ length: 12 }, () => c.call("status")));
    expect(results.some((r) => r.error?.code === "RATE_LIMIT")).toBe(true);
  });

  it("reports unknown methods and bad params without leaking internals", async () => {
    await boot();
    const c = await authed();
    expect((await c.call("nope.nope")).error?.code).toBe("UNSUPPORTED.METHOD");
    const bad = await c.call("events.subscribe", { since: -1 });
    expect(bad.error?.code).toBe("UNSUPPORTED.BAD_PARAMS");
    const extra = await c.call("pairing.list", { status: "pending", surprise: 1 });
    expect(extra.ok).toBe(false);
  });
});

describe("status", () => {
  it("reports server state", async () => {
    await boot();
    const c = await authed();
    const r = await c.call("status");
    expect(r.result.protocol).toEqual({ major: 1, minor: 0 });
    expect(r.result.connections).toBe(1);
    expect(r.result.senders).toEqual({ paired: 0, pending: 0 });
  });
});

describe("event streaming", () => {
  it("replays after a cursor then streams live, in order, exactly once", async () => {
    await boot();
    const base = gw.events.latestSeq();
    gw.events.append([{ type: "a" }, { type: "b" }, { type: "c" }]);
    const c = await authed();
    const sub = await c.call("events.subscribe", { since: base + 1 });
    expect(sub.ok).toBe(true);
    expect(sub.result.replaying).toBe(2);
    gw.events.append([{ type: "d" }]);
    gw.events.append([{ type: "e" }, { type: "f" }]);
    await c.waitFor(() => c.events.length >= 5);
    expect(c.events.map((e) => e.type)).toEqual(["b", "c", "d", "e", "f"]);
    const seqs = c.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("with no cursor, delivers only new events", async () => {
    await boot();
    gw.events.append([{ type: "old" }]);
    const c = await authed();
    expect((await c.call("events.subscribe")).result.replaying).toBe(0);
    gw.events.append([{ type: "new" }]);
    await c.waitFor(() => c.events.length >= 1);
    expect(c.events.map((e) => e.type)).toEqual(["new"]);
  });

  it("resumes after reconnect without gaps or duplicates", async () => {
    await boot();
    const c1 = await authed();
    await c1.call("events.subscribe");
    gw.events.append([{ type: "e1" }, { type: "e2" }]);
    await c1.waitFor(() => c1.events.length >= 2);
    const last = c1.events.at(-1)!.seq;
    c1.close();
    gw.events.append([{ type: "while-away-1" }, { type: "while-away-2" }]);
    const c2 = await authed();
    await c2.call("events.subscribe", { since: last });
    gw.events.append([{ type: "after" }]);
    await c2.waitFor(() => c2.events.length >= 3);
    expect(c2.events.map((e) => e.type)).toEqual(["while-away-1", "while-away-2", "after"]);
  });

  it("filters by session", async () => {
    await boot();
    const c = await authed();
    await c.call("events.subscribe", { session: "s1" });
    gw.events.append([{ type: "x", session: "s2" }, { type: "y", session: "s1" }]);
    await c.waitFor(() => c.events.length >= 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(c.events.map((e) => e.type)).toEqual(["y"]);
  });

  it("tells clients with a compacted cursor to re-sync", async () => {
    let now = 1_000;
    await boot({ now: () => now });
    gw.events.append([{ type: "old" }]);
    now = 10_000_000;
    gw.events.append([{ type: "new" }]);
    gw.events.compact(1_000);
    const c = await authed();
    const r = await c.call("events.subscribe", { since: 0 });
    expect(r.error?.code).toBe("SYNC.CURSOR_EXPIRED");
  });

  it("stops streaming after unsubscribe", async () => {
    await boot();
    const c = await authed();
    await c.call("events.subscribe");
    await c.call("events.unsubscribe");
    gw.events.append([{ type: "ignored" }]);
    await new Promise((r) => setTimeout(r, 50));
    expect(c.events).toEqual([]);
  });

  it("drops a slow consumer instead of buffering without bound", async () => {
    await boot({ maxBufferedBytes: 1 });
    const base = gw.events.latestSeq();
    gw.events.append(Array.from({ length: 50 }, (_, i) => ({ type: "big", data: { i, pad: "x".repeat(100_000) } })));
    const c = await authed();
    await c.call("events.subscribe", { since: base });
    await c.waitFor(() => c.closed !== undefined, 5000);
    expect(c.closed?.code).toBe(4429);
  });
});

describe("pairing over the protocol", () => {
  it("lists, approves and denies by code; audit events are streamed", async () => {
    await boot();
    const c = await authed();
    await c.call("events.subscribe");

    const stranger = { channel: "telegram", accountId: "bot", externalId: "42", display: "Eve" };
    const d = gw.pairing.handleInbound(stranger);
    if (d.action !== "challenge") throw new Error("expected challenge");

    expect(((await c.call("pairing.list", { status: "pending" })).result.senders as unknown[]).length).toBe(1);
    const bad = await c.call("pairing.approve", { code: "ZZZZZZZZ" });
    expect(bad.error?.code).toBe("POLICY.PAIRING_UNKNOWN_CODE");
    const ok = await c.call("pairing.approve", { code: d.code });
    expect(ok.result.sender.status).toBe("paired");
    expect(ok.result.sender.role).toBe("guest");
    expect(gw.pairing.principalOf(stranger)).toBe("guest");

    await c.waitFor(() => c.events.some((e) => e.type === "pairing.approved"));
    expect(JSON.stringify(c.events)).not.toContain(d.code);

    const other = gw.pairing.handleInbound({ ...stranger, externalId: "43" });
    if (other.action !== "challenge") throw new Error("expected challenge");
    const denied = await c.call("pairing.deny", { code: other.code });
    expect(denied.result.sender.status).toBe("blocked");
  });
});

describe("approvals over the protocol", () => {
  it("lists pending approvals and lets the owner decide once", async () => {
    await boot();
    const c = await authed();
    const a = gw.approvals.create({ tool: "exec", args: { cmd: "ls" }, requester: "guest-1" });
    const listed = await c.call("approval.list");
    expect((listed.result.approvals as Array<{ id: string }>).map((x) => x.id)).toEqual([a.id]);
    const decided = await c.call("approval.decide", { id: a.id, approve: true });
    expect(decided.result.approval.state).toBe("approved");
    expect(gw.approvals.consume(a.id, "exec", { cmd: "ls" })).toBe(true);
    const again = await c.call("approval.decide", { id: a.id, approve: false });
    expect(again.error?.code).toBe("POLICY.APPROVAL");
  });
});
