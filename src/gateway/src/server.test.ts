import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { FakeProvider } from "@clawnexus/sessions";
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

describe("sessions over the wire (milestone M1)", () => {
  it("fails clearly when no provider is configured", async () => {
    await boot();
    const c = await authed();
    const r = await c.call("session.list");
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("PROVIDER.NOT_CONFIGURED");
  });

  it("client -> gateway -> fake provider -> streamed reply, then export", async () => {
    await boot({ provider: new FakeProvider({ chunkSize: 4 }), sessions: { deltaFlushMs: 0 } });
    const c = await authed();
    await c.call("events.subscribe");
    const created = await c.call("session.create", {});
    expect(created.ok).toBe(true);
    const sid = created.result.session.id as string;
    const sent = await c.call("session.send", { session: sid, text: "hello there" });
    expect(sent.ok).toBe(true);
    await c.waitFor(() => c.events.some((e) => e.type === "run.completed"));
    const types = c.events.filter((e) => e.session === sid).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["message.inbound", "run.started", "run.delta", "message.outbound", "run.completed"]));
    const got = await c.call("session.get", { session: sid });
    expect(got.result.messages.map((m: { content: string }) => m.content)).toEqual(["hello there", "echo: hello there"]);
    const exp = await c.call("session.export", { session: sid });
    expect(exp.result.content).toContain("echo: hello there");
    const md = await c.call("session.export", { session: sid, format: "markdown" });
    expect(md.result.content).toContain("echo: hello there");
    expect((await c.call("session.delete", { session: sid })).ok).toBe(true);
    expect((await c.call("session.get", { session: sid })).error?.code).toBe("SESSION.NOT_FOUND");
  });

  it("session.create is idempotent per key and validates input", async () => {
    await boot({ provider: new FakeProvider() });
    const c = await authed();
    const a = await c.call("session.create", { scope: "x" });
    const b = await c.call("session.create", { scope: "x" });
    expect(a.result.session.id).toBe(b.result.session.id);
    expect((await c.call("session.create", { scope: "" })).ok).toBe(false);
    expect((await c.call("session.create", { bogus: 1 })).ok).toBe(false);
    expect((await c.call("session.send", { session: a.result.session.id, text: "  " })).error?.code).toBe("SESSION.INVALID");
  });

  it("cancels a long run", async () => {
    await boot({ provider: new FakeProvider({ hang: true }) });
    const c = await authed();
    await c.call("events.subscribe");
    const sid = (await c.call("session.create", {})).result.session.id as string;
    await c.call("session.send", { session: sid, text: "x" });
    expect((await c.call("session.cancel", { session: sid })).result.cancelled).toBe(1);
    await c.waitFor(() => c.events.some((e) => e.type === "run.cancelled"));
  });

  it("imports an exported transcript", async () => {
    await boot({ provider: new FakeProvider(), sessions: { deltaFlushMs: 0 } });
    const c = await authed();
    const sid = (await c.call("session.create", {})).result.session.id as string;
    await c.call("session.send", { session: sid, text: "keep me" });
    await c.waitFor(() => gw.sessions?.messages(sid).length === 2);
    const content = (await c.call("session.export", { session: sid })).result.content as string;
    await c.call("session.delete", { session: sid });
    const imp = await c.call("session.import", { content });
    expect(imp.ok).toBe(true);
    const back = await c.call("session.get", { session: imp.result.session.id });
    expect(back.result.messages).toHaveLength(2);
    expect((await c.call("session.import", { content: "garbage" })).error?.code).toBe("SESSION.INVALID");
  });
});

describe("tools over the wire", () => {
  it("lists tools, runs R0/R1 directly and gates exec behind owner approval", async () => {
    await boot();
    const c = await authed();
    await c.call("events.subscribe");
    expect((await c.call("tool.list")).result.tools.map((t: { name: string }) => t.name)).toEqual(["fs.read", "fs.list", "fs.write", "exec.run"]);

    const w = await c.call("tool.call", { tool: "fs.write", args: { path: "hello.txt", content: "hi" } });
    expect(w.result.status).toBe("ok");
    expect(readFileSync(join(dir, "workspace", "hello.txt"), "utf8")).toBe("hi");
    const r = await c.call("tool.call", { tool: "fs.read", args: { path: "hello.txt" } });
    expect(r.result.output.content).toBe("hi");

    const escape = await c.call("tool.call", { tool: "fs.read", args: { path: "../gateway.token" } });
    expect(escape.result.status).toBe("error");
    expect(JSON.stringify(escape)).not.toContain(token());

    const args = { command: process.execPath, args: ["-e", "console.log(40+2)"] };
    const first = await c.call("tool.call", { tool: "exec.run", args });
    expect(first.result.status).toBe("approval_required");
    const id = first.result.approvalId as string;
    await c.waitFor(() => c.events.some((e) => e.type === "approval.requested"));
    expect((await c.call("approval.list")).result.approvals.map((a: { id: string }) => a.id)).toContain(id);
    expect((await c.call("approval.decide", { id, approve: true })).ok).toBe(true);
    const done = await c.call("tool.call", { tool: "exec.run", args, approvalId: id });
    expect(done.result.status).toBe("ok");
    expect(done.result.output.stdout.trim()).toBe("42");
    expect((await c.call("tool.call", { tool: "exec.run", args, approvalId: id })).result.code).toBe("BAD_APPROVAL");
  });
});

describe("tool bridge credentials (model-driven tool calls)", () => {
  async function agent(session = "sess-A", principal: "owner" | "guest" = "owner"): Promise<{ c: Client; revoke: () => void; token: string }> {
    const m = gw.mintBridge({ session, principal });
    const c = await Client.open(port);
    clients.push(c);
    const h = await c.hello(m.token);
    expect(h.ok).toBe(true);
    expect(h.result.role).toBe("agent");
    return { c, revoke: m.revoke, token: m.token };
  }

  it("authenticates as an agent, never as the owner, and the owner token still works", async () => {
    await boot();
    const a = await agent();
    expect(a.token.startsWith("cnb_")).toBe(true);
    const o = await authed();
    expect((await o.call("status")).ok).toBe(true);
    const bad = await Client.open(port);
    clients.push(bad);
    expect((await bad.hello("cnb_not-a-real-credential")).error?.code).toBe("AUTH.BAD_TOKEN");
  });

  it("lists tools with JSON schemas the model can use", async () => {
    await boot();
    const { c } = await agent();
    const tools = (await c.call("tool.list")).result.tools as Array<{ name: string; inputSchema: { type: string; properties: Record<string, unknown> } }>;
    expect(tools.map((t) => t.name)).toEqual(["fs.read", "fs.list", "fs.write", "exec.run"]);
    expect(tools.find((t) => t.name === "fs.write")?.inputSchema.properties).toHaveProperty("content");
    expect(JSON.stringify(tools)).not.toContain("$schema");
  });

  it("can use nothing but tools: every other method is forbidden", async () => {
    await boot();
    const { c } = await agent();
    for (const m of ["status", "session.list", "session.send", "session.create", "approval.list", "approval.decide", "pairing.list", "pairing.approve", "events.subscribe", "session.export"]) {
      const r = await c.call(m, { id: "x", approve: true, code: "x", session: "x", text: "x" });
      expect(r.ok, m).toBe(false);
      expect(r.error?.code, m).toBe("AUTH.FORBIDDEN");
    }
  });

  it("cannot choose its own principal, trust level or session", async () => {
    await boot();
    const { c } = await agent();
    for (const extra of [{ principal: "owner" }, { tainted: false }, { session: "other" }, { profile: "trusted" }]) {
      const r = await c.call("tool.call", { tool: "fs.read", args: { path: "." }, ...extra });
      expect(r.error?.code, JSON.stringify(extra)).toBe("UNSUPPORTED.BAD_PARAMS");
    }
  });

  it("treats the model as tainted: reads run, writes and exec wait for the owner", async () => {
    await boot();
    const o = await authed();
    expect((await o.call("tool.call", { tool: "fs.write", args: { path: "seed.txt", content: "seed" } })).result.status).toBe("ok");
    const { c } = await agent("sess-A");
    expect((await c.call("tool.call", { tool: "fs.read", args: { path: "seed.txt" } })).result.output.content).toBe("seed");
    const w = await c.call("tool.call", { tool: "fs.write", args: { path: "new.txt", content: "x" } });
    expect(w.result.status).toBe("approval_required");
    const x = await c.call("tool.call", { tool: "exec.run", args: { command: process.execPath, args: ["-e", "1"] } });
    expect(x.result.status).toBe("approval_required");
    expect(() => readFileSync(join(dir, "workspace", "new.txt"))).toThrow();
  });

  it("an approval is for one session, one exact call, one use", async () => {
    await boot();
    const o = await authed();
    const a = await agent("sess-A");
    const b = await agent("sess-B");
    const args = { path: "n.txt", content: "one" };
    const first = await a.c.call("tool.call", { tool: "fs.write", args });
    const id = first.result.approvalId as string;

    // the agent cannot approve itself, and cannot see the owner's list
    expect((await a.c.call("approval.decide", { id, approve: true })).error?.code).toBe("AUTH.FORBIDDEN");
    expect((await a.c.call("approval.status", { id })).result.state).toBe("pending");
    // another session cannot even see it, let alone use it
    expect((await b.c.call("approval.status", { id })).error?.code).toBe("POLICY.APPROVAL");

    expect((await o.call("approval.decide", { id, approve: true })).ok).toBe(true);
    expect((await a.c.call("approval.status", { id })).result.state).toBe("approved");
    expect((await b.c.call("tool.call", { tool: "fs.write", args, approvalId: id })).result.code).toBe("BAD_APPROVAL");
    // different arguments with the same approval id
    expect((await a.c.call("tool.call", { tool: "fs.write", args: { path: "n.txt", content: "TWO" }, approvalId: id })).result.code).toBe("BAD_APPROVAL");
    // the right call works exactly once
    expect((await a.c.call("tool.call", { tool: "fs.write", args, approvalId: id })).result.status).toBe("ok");
    expect(readFileSync(join(dir, "workspace", "n.txt"), "utf8")).toBe("one");
    expect((await a.c.call("tool.call", { tool: "fs.write", args, approvalId: id })).result.code).toBe("BAD_APPROVAL");
  });

  it("records who asked, for which session, in the audit log", async () => {
    await boot();
    const o = await authed();
    await o.call("events.subscribe");
    const { c } = await agent("sess-audit");
    await c.call("tool.call", { tool: "fs.list", args: { path: "." } });
    await c.call("tool.call", { tool: "fs.write", args: { path: "q.txt", content: "z" } });
    await o.waitFor(() => o.events.some((e) => e.type === "approval.requested"));
    const mine = o.events.filter((e) => e.session === "sess-audit");
    expect(mine.some((e) => e.type === "tool.completed")).toBe(true);
    const req = mine.find((e) => e.type === "approval.requested");
    expect((req?.data as { requester: string }).requester).toBe("agent:sess-audit");
  });

  it("a guest session can read but never write or run programs, even with approval", async () => {
    await boot();
    const { c } = await agent("sess-G", "guest");
    expect((await c.call("tool.call", { tool: "fs.list", args: { path: "." } })).result.status).toBe("ok");
    expect((await c.call("tool.call", { tool: "fs.write", args: { path: "g.txt", content: "z" } })).result.status).toBe("denied");
    expect((await c.call("tool.call", { tool: "exec.run", args: { command: process.execPath } })).result.status).toBe("denied");
  });

  it("follows the configured security profile (locked-down refuses exec without a sandbox)", async () => {
    await boot({ config: { gateway: { bind: "127.0.0.1", port: 0, tls: { enabled: false }, auth: { required: true }, insecureAcknowledged: false }, security: { profile: "locked-down" } } });
    const { c } = await agent();
    const r = await c.call("tool.call", { tool: "exec.run", args: { command: process.execPath, args: ["-e", "1"] } });
    expect(r.result.status).toBe("denied");
    expect(r.result.reason).toMatch(/sandbox/);
  });

  it("limits how many approvals one session can pile up", async () => {
    await boot();
    const o = await authed();
    const { c } = await agent("sess-spam");
    const results: string[] = [];
    for (let i = 0; i < 7; i++) results.push((await c.call("tool.call", { tool: "fs.write", args: { path: `s${i}.txt`, content: "x" } })).result.status);
    expect(results.filter((s) => s === "approval_required")).toHaveLength(5);
    expect(results.filter((s) => s === "denied")).toHaveLength(2);
    expect((await o.call("approval.list")).result.approvals).toHaveLength(5);
  });

  it("revoking a credential closes its connection and it can never log in again", async () => {
    await boot();
    const a = await agent("sess-R");
    expect((await a.c.call("tool.list")).ok).toBe(true);
    a.revoke();
    await a.c.waitFor(() => a.c.closed !== undefined);
    expect(a.c.closed?.code).toBe(4401);
    const again = await Client.open(port);
    clients.push(again);
    expect((await again.hello(a.token)).error?.code).toBe("AUTH.BAD_TOKEN");
  });

  it("credentials expire", async () => {
    let now = 1_000_000;
    await boot({ now: () => now });
    const m = gw.mintBridge({ session: "s", principal: "owner" });
    now += 25 * 3600_000;
    const c = await Client.open(port);
    clients.push(c);
    expect((await c.hello(m.token)).error?.code).toBe("AUTH.BAD_TOKEN");
  });

  it("stopping the Gateway revokes everything", async () => {
    await boot();
    const m = gw.mintBridge({ session: "s", principal: "owner" });
    await gw.stop();
    expect(gw.bridgeGrants.lookup(m.token)).toBeUndefined();
  });
});
