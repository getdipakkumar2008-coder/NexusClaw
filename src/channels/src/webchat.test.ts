import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { CONFORMANCE_LIMITS, defineConformance, type ConformanceBed, type ConformanceSetup, type ConformanceUser } from "./conformance.js";
import { createBed, waitFor, type Bed } from "./testing.js";
import { WEBCHAT_ID, WebChatAdapter, senderIdOf, type WebChatOptions } from "./webchat.js";

interface Frame {
  t: string;
  [k: string]: unknown;
}

class Visitor {
  ws!: WebSocket;
  frames: Frame[] = [];
  closed: { code: number } | undefined;
  readonly secret: string;
  constructor(private readonly port: number, secret?: string) {
    this.secret = secret ?? `cnw_${randomBytes(32).toString("base64url")}`;
  }
  get senderId(): string {
    return senderIdOf(this.secret);
  }
  async open(headers: Record<string, string> = {}, path = "/v1/webchat"): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}${path}`, { headers });
    this.ws.on("message", (d) => this.frames.push(JSON.parse(d.toString()) as Frame));
    this.ws.on("close", (code) => (this.closed = { code }));
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
      this.ws.once("unexpected-response", (_r, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
  }
  send(f: object): void {
    this.ws.send(JSON.stringify(f));
  }
  async hello(extra: Record<string, unknown> = {}): Promise<Frame> {
    const before = this.frames.length;
    this.send({ t: "hello", secret: this.secret, redeem: null, ...extra });
    await waitFor(() => this.frames.slice(before).some((f) => f.t === "ready") || this.closed !== undefined);
    return this.frames.slice(before).find((f) => f.t === "ready") ?? { t: "none" };
  }
  async say(id: string, text: string): Promise<Frame> {
    const before = this.frames.length;
    this.send({ t: "message", id, text });
    await waitFor(() => this.frames.slice(before).some((f) => f.t === "ack" && f.id === id) || this.closed !== undefined);
    return this.frames.slice(before).find((f) => f.t === "ack" && f.id === id) ?? { t: "none" };
  }
  texts(): string[] {
    return this.frames.filter((f) => f.t === "message").map((f) => String(f.text));
  }
  close(): void {
    this.ws?.close();
  }
}

interface Rig {
  bed: Bed;
  adapter: WebChatAdapter;
  server: Server;
  port: number;
  visitors: Visitor[];
  visitor(secret?: string): Visitor;
  stop(): Promise<void>;
}

async function rig(o: { provider?: null; manager?: Parameters<typeof createBed>[0]["manager"]; web?: Partial<WebChatOptions> } = {}): Promise<Rig> {
  const ref: { bed?: Bed } = {};
  const adapter = new WebChatAdapter({
    registerOwner: (id, display) => void ref.bed!.pairing.registerOwner({ channel: WEBCHAT_ID, accountId: "default", externalId: id, display }),
    principalOf: (id) => ref.bed!.pairing.principalOf({ channel: WEBCHAT_ID, accountId: "default", externalId: id }),
    now: () => ref.bed?.clock.now ?? Date.now(),
    maxTextChars: 200,
    ...o.web,
  });
  const bed = await createBed({ adapters: [adapter], ...(o.provider === null ? { provider: null } : {}), manager: { senderBurst: CONFORMANCE_LIMITS.senderBurst, senderPerMinute: CONFORMANCE_LIMITS.senderPerMinute, ...o.manager } });
  ref.bed = bed;
  const server = createServer((req, res) => {
    if (!adapter.handleHttp(req, res)) res.writeHead(404).end();
  });
  server.on("upgrade", (req, socket) => {
    if (!adapter.handleUpgrade(req, socket)) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const visitors: Visitor[] = [];
  return {
    bed,
    adapter,
    server,
    port,
    visitors,
    visitor(secret) {
      const v = new Visitor(port, secret);
      visitors.push(v);
      return v;
    },
    async stop() {
      for (const v of visitors) v.close();
      await bed.teardown();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

// ---------------------------------------------------------------- shared conformance suite, through real sockets

async function webBed(setup?: ConformanceSetup): Promise<ConformanceBed> {
  const r = await rig(setup?.noProvider ? { provider: null } : {});
  const users = new Map<string, Visitor>();
  let failures = 0;
  const realSend = r.adapter.send.bind(r.adapter);
  r.adapter.send = async (t, c) => {
    if (failures > 0) {
      failures--;
      throw new Error("platform unavailable");
    }
    return realSend(t, c);
  };
  const connect = async (name: string): Promise<Visitor> => {
    let v = users.get(name);
    if (!v) {
      v = r.visitor();
      users.set(name, v);
      await v.open();
      await v.hello();
    }
    return v;
  };
  const ids = new Map<string, string>();
  const secretFor = (name: string): Visitor => {
    let v = [...users.entries()].find(([n]) => n === name)?.[1];
    if (!v) {
      v = r.visitor();
      users.set(name, v);
    }
    ids.set(name, v.senderId);
    return v;
  };
  return {
    bed: r.bed,
    channelId: WEBCHAT_ID,
    maxTextChars: 200,
    groupsSupported: false,
    user(name): ConformanceUser {
      const v = secretFor(name);
      return {
        senderId: v.senderId,
        conversationId: v.senderId,
        async say(text, o = {}) {
          const vis = await (async () => {
            if (!v.ws) {
              await v.open();
              await v.hello();
            }
            return v;
          })();
          const id = createHash("sha256").update(o.messageId ?? randomBytes(6).toString("hex")).digest("hex").slice(0, 32);
          await vis.say(id, text);
        },
        received: () => v.texts(),
      };
    },
    deliverRaw: (m) => (r.adapter as unknown as { host: { deliver(m: unknown): ReturnType<NonNullable<ConformanceBed["deliverRaw"]>> } }).host.deliver(m),
    failSends: (n) => {
      failures = n;
    },
    async teardown() {
      void connect;
      await r.stop();
    },
  };
}

defineConformance({ describe, it, expect }, "webchat", webBed);

// ---------------------------------------------------------------- what is specific to the web

let current: Rig | undefined;
afterEach(async () => {
  await current?.stop();
  current = undefined;
});
const get = (port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> =>
  new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });

describe("the page", () => {
  it("is served with strict security headers and no inline script", async () => {
    current = await rig();
    const page = await get(current.port, "/webchat");
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    const csp = String(page.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain(`ws://127.0.0.1:${current.port}`);
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.body).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(page.body).not.toMatch(/\son[a-z]+=/i);
    expect((await get(current.port, "/webchat/app.js")).headers["content-type"]).toContain("javascript");
    expect((await get(current.port, "/webchat/app.css")).headers["content-type"]).toContain("text/css");
    expect((await get(current.port, "/webchat/../secret")).status).toBe(404);
    expect((await get(current.port, "/webchat/nothing")).status).toBe(404);
  });

  it("never inserts text as HTML or runs strings as code", () => {
    const js = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");
    for (const bad of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "dangerouslySet"]) expect(js).not.toContain(bad);
    expect(js).toContain("textContent");
  });
});

describe("who may connect", () => {
  it("accepts the page's own origin or no origin, and refuses web pages from anywhere else", async () => {
    current = await rig();
    const host = `127.0.0.1:${current.port}`;
    const same = current.visitor();
    await same.open({ Origin: `http://${host}` });
    expect((await same.hello()).t).toBe("ready");
    const none = current.visitor();
    await none.open();
    expect((await none.hello()).t).toBe("ready");
    for (const origin of ["http://evil.example", "https://127.0.0.1:" + current.port, `http://127.0.0.1:${current.port + 1}`, "null"]) {
      await expect(current.visitor().open({ Origin: origin }), origin).rejects.toThrow(/403/);
    }
    await expect(current.visitor().open({}, "/v1/ws")).rejects.toThrow(/404/);
  });

  it("limits total connections and connections per visitor", async () => {
    current = await rig({ web: { maxConnections: 3, maxPerSender: 2 } });
    const v = current.visitor();
    const a = current.visitor(v.secret);
    const b = current.visitor(v.secret);
    for (const x of [v, a, b]) {
      await x.open();
      await x.hello();
    }
    await waitFor(() => v.closed !== undefined);
    expect(v.closed?.code).toBe(4000); // the oldest of three for one visitor
    expect(a.closed).toBeUndefined(); // only the surplus one was ended
    const other = current.visitor();
    await other.open();
    await other.hello();
    await expect(current.visitor().open()).rejects.toThrow(/503/);
  });
});

describe("identity", () => {
  it("gives a new visitor a secret once, and the same secret means the same visitor", async () => {
    current = await rig();
    const first = current.visitor();
    await first.open();
    // no valid secret supplied: the server makes one
    first.send({ t: "hello", secret: null, redeem: null });
    await waitFor(() => first.frames.some((f) => f.t === "ready"));
    const ready = first.frames.find((f) => f.t === "ready")!;
    expect(String(ready["secret"])).toMatch(/^cnw_[A-Za-z0-9_-]{43}$/);
    expect(ready["role"]).toBe("unpaired");

    const again = current.visitor(String(ready["secret"]));
    await again.open();
    const r2 = await again.hello();
    expect(r2["secret"]).toBeUndefined(); // never echoed back once the browser has it
    expect(again.senderId).toBe(senderIdOf(String(ready["secret"])));
  });

  it("treats a malformed secret as a new visitor rather than trusting it", async () => {
    current = await rig();
    const v = current.visitor();
    await v.open();
    v.send({ t: "hello", secret: "cnw_short", redeem: null });
    await waitFor(() => v.frames.some((f) => f.t === "ready"));
    expect(String(v.frames[0]!["secret"])).not.toBe("cnw_short");
  });

  it("cannot name a sender: the sender comes from the secret, and extra fields are refused", async () => {
    current = await rig();
    const v = current.visitor();
    await v.open();
    await v.hello();
    v.send({ t: "message", id: "abcdefgh12", text: "hi", senderId: "owner", role: "owner" });
    await waitFor(() => v.closed !== undefined);
    expect(v.closed?.code).toBe(1008);
    expect(current.bed.pairing.list().every((s) => s.externalId.startsWith("w_"))).toBe(true);
  });

  it("closes connections that break the protocol", async () => {
    current = await rig();
    const cases: Array<(v: Visitor) => void> = [
      (v) => v.ws.send("not json"),
      (v) => v.send({ t: "message", id: "abcdefgh12", text: "hi" }), // before hello
      (v) => v.send({ t: "mystery" }),
      (v) => v.ws.send(Buffer.from([1, 2, 3])),
      (v) => v.send({ t: "message", id: "x", text: "short id" }),
      (v) => v.ws.send("x".repeat(20_000)),
    ];
    for (const break_ of cases) {
      const v = current.visitor();
      await v.open();
      break_(v);
      await waitFor(() => v.closed !== undefined);
      expect([1003, 1008, 1009]).toContain(v.closed?.code);
    }
    const twice = current.visitor();
    await twice.open();
    await twice.hello();
    twice.send({ t: "hello", secret: null });
    await waitFor(() => twice.closed !== undefined);
    expect(twice.closed?.code).toBe(1008);
  });

  it("drops a connection that never says hello", async () => {
    current = await rig({ web: { helloTimeoutMs: 100 } });
    const v = current.visitor();
    await v.open();
    await waitFor(() => v.closed !== undefined);
    expect(v.closed?.code).toBe(4408);
  });
});

describe("becoming the owner", () => {
  it("needs a one-time link minted locally; it works once", async () => {
    current = await rig();
    const link = current.adapter.createOwnerLink(`http://127.0.0.1:${current.port}`);
    const code = /#owner=(cno_[A-Za-z0-9_-]{32})$/.exec(link.url)![1]!;
    expect(link.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/webchat#owner=cno_/);

    const me = current.visitor();
    await me.open();
    const ready = await me.hello({ redeem: code });
    expect(ready).toMatchObject({ role: "owner", redeemed: true });
    expect(current.bed.pairing.principalOf({ channel: WEBCHAT_ID, accountId: "default", externalId: me.senderId })).toBe("owner");

    const thief = current.visitor();
    await thief.open();
    const r2 = await thief.hello({ redeem: code });
    expect(r2).toMatchObject({ role: "unpaired", redeemed: false });
  });

  it("rejects forged, expired and malformed codes, and a failed attempt costs the real link nothing", async () => {
    current = await rig({ web: { linkTtlMs: 1000 } });
    const link = current.adapter.createOwnerLink("http://127.0.0.1:1");
    const code = /#owner=(.+)$/.exec(link.url)![1]!;
    for (const bad of ["cno_" + "A".repeat(32), "nonsense", "cno_short", "", code.toLowerCase()]) {
      const v = current.visitor();
      await v.open();
      const r = await v.hello({ redeem: bad });
      expect(r["role"], bad).toBe("unpaired");
    }
    current.bed.clock.now += 5000;
    const late = current.visitor();
    await late.open();
    expect(await late.hello({ redeem: code })).toMatchObject({ role: "unpaired", redeemed: false });
  });

  it("an owner link makes only the browser that redeems it the owner", async () => {
    current = await rig();
    const link = current.adapter.createOwnerLink("http://127.0.0.1:1");
    const code = /#owner=(.+)$/.exec(link.url)![1]!;
    const owner = current.visitor();
    const guest = current.visitor();
    await owner.open();
    await guest.open();
    await owner.hello({ redeem: code });
    await guest.hello();
    expect(current.bed.pairing.principalOf({ channel: WEBCHAT_ID, accountId: "default", externalId: guest.senderId })).toBe("unpaired");
    // the owner can chat straight away and is served as the owner
    await owner.say("ownermsg1", "hello there");
    await waitFor(() => owner.texts().some((t) => t.includes("echo: hello there")));
    expect(current.bed.sessions!.list({ channel: WEBCHAT_ID })[0]?.principal).toBe("owner");
  });
});

describe("conversation", () => {
  it("shows the earlier conversation when the same browser reconnects", async () => {
    current = await rig();
    const link = current.adapter.createOwnerLink("http://127.0.0.1:1");
    const v = current.visitor();
    await v.open();
    await v.hello({ redeem: /#owner=(.+)$/.exec(link.url)![1] });
    await v.say("hist-0001", "remember this");
    await waitFor(() => v.texts().some((t) => t.includes("echo: remember this")));
    v.close();

    const back = current.visitor(v.secret);
    await back.open();
    await back.hello();
    await waitFor(() => back.frames.some((f) => f.t === "history"));
    const history = back.frames.find((f) => f.t === "history")!["messages"] as Array<{ from: string; text: string }>;
    expect(history.map((h) => h.from)).toEqual(["you", "assistant"]);
    expect(history[0]!.text).toBe("remember this");
  });

  it("walks a stranger through pairing and shows the code to them", async () => {
    current = await rig();
    const v = current.visitor();
    await v.open();
    expect(await v.hello()).toMatchObject({ role: "unpaired" });
    expect(await v.say("first-0001", "hello")).toMatchObject({ status: "pairing" });
    await waitFor(() => v.texts().length === 1);
    const code = /\b([2-9A-HJ-NP-Z]{8})\b/.exec(v.texts()[0]!)![1]!;
    current.bed.pairing.approve(code);
    expect(await v.say("second-001", "now?")).toMatchObject({ status: "accepted", role: "guest" });
    await waitFor(() => v.texts().some((t) => t.includes("echo: now?")));
  });

  it("sends typing indicators around a run", async () => {
    current = await rig();
    const link = current.adapter.createOwnerLink("http://127.0.0.1:1");
    const v = current.visitor();
    await v.open();
    await v.hello({ redeem: /#owner=(.+)$/.exec(link.url)![1] });
    await v.say("typing-001", "hi");
    await waitFor(() => v.frames.some((f) => f.t === "typing" && f.on === true) && v.frames.some((f) => f.t === "typing" && f.on === false));
  });

  it("delivers hostile text as plain data and rate-limits a single connection", async () => {
    current = await rig({ manager: { senderBurst: 1000, senderPerMinute: 100_000 } });
    const link = current.adapter.createOwnerLink("http://127.0.0.1:1");
    const v = current.visitor();
    await v.open();
    await v.hello({ redeem: /#owner=(.+)$/.exec(link.url)![1] });
    const evil = "<img src=x onerror=alert(1)><script>alert(2)</script>";
    await v.say("xss-00001", evil);
    await waitFor(() => v.texts().some((t) => t.includes("<script>")));
    expect(v.texts().find((t) => t.includes("<script>"))).toContain(evil); // verbatim; the page shows it with textContent
    const acks = await Promise.all(Array.from({ length: 40 }, (_, i) => v.say(`flood-${String(i).padStart(4, "0")}`, `m${i}`)));
    expect(acks.some((a) => a["status"] === "limited")).toBe(true);
  });
});

describe("sending files from the browser", () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("....IHDR a small picture")]);
  const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.from([0x90, 0, 3, 0, 0, 0, 4, 0])]);

  async function owner(r: Rig): Promise<Visitor> {
    const link = r.adapter.createOwnerLink("http://127.0.0.1:1");
    const v = r.visitor();
    await v.open();
    await v.hello({ redeem: /#owner=(.+)$/.exec(link.url)![1] });
    return v;
  }
  const pieces = (v: Visitor, up: string, name: string, data: Buffer, size = 10): void => {
    const n = Math.max(1, Math.ceil(data.length / size));
    for (let i = 0; i < n; i++) v.send({ t: "file", up, name, seq: i, last: i === n - 1, data: data.subarray(i * size, (i + 1) * size).toString("base64") });
  };
  const status = async (v: Visitor, up: string): Promise<string> => {
    await waitFor(() => v.frames.some((f) => f.t === "file" && f.up === up));
    return String(v.frames.find((f) => f.t === "file" && f.up === up)!["status"]);
  };

  it("puts the pieces together and hands the whole file to the Gateway with the message", async () => {
    current = await rig();
    const v = await owner(current);
    pieces(v, "up-pic-001", "pic.png", PNG);
    expect(await status(v, "up-pic-001")).toBe("ready");
    v.send({ t: "message", id: "msg-file-01", text: "what is this?", files: ["up-pic-001"] });
    await waitFor(() => v.frames.some((f) => f.t === "ack" && f.id === "msg-file-01"));
    expect(v.frames.find((f) => f.t === "ack" && f.id === "msg-file-01")!["status"]).toBe("accepted");
    expect(current.bed.blobs.stats()).toEqual({ count: 1, bytes: PNG.length });
    expect(current.bed.provider!.calls[0]!.attachments![0]).toMatchObject({ name: "pic.png", mime: "image/png" });
  });

  it("can be a message with only a file; a message with neither is a broken frame", async () => {
    current = await rig();
    const v = await owner(current);
    pieces(v, "up-pic-002", "pic.png", PNG);
    await status(v, "up-pic-002");
    v.send({ t: "message", id: "msg-file-02", text: "", files: ["up-pic-002"] });
    await waitFor(() => v.frames.some((f) => f.t === "ack" && f.id === "msg-file-02"));
    v.send({ t: "message", id: "msg-file-03", text: "  " });
    await waitFor(() => v.closed !== undefined);
    expect(v.closed?.code).toBe(1008);
  });

  it("is judged by what the file is: a program is stored by no one and the message still goes through", async () => {
    current = await rig();
    const v = await owner(current);
    pieces(v, "up-exe-001", "invoice.pdf", EXE);
    expect(await status(v, "up-exe-001")).toBe("ready"); // the browser side only assembles; the Gateway decides
    v.send({ t: "message", id: "msg-file-04", text: "open this", files: ["up-exe-001"] });
    await waitFor(() => v.frames.some((f) => f.t === "ack" && f.id === "msg-file-04"));
    expect(current.bed.blobs.stats().count).toBe(0);
  });

  it("is not available to someone who is not paired, and nothing is kept for them", async () => {
    current = await rig();
    const v = current.visitor();
    await v.open();
    await v.hello();
    pieces(v, "up-stranger", "pic.png", PNG);
    expect(await status(v, "up-stranger")).toBe("not_paired");
    v.send({ t: "message", id: "msg-file-05", text: "hi", files: ["up-stranger"] });
    await waitFor(() => v.frames.some((f) => f.t === "ack" && f.id === "msg-file-05"));
    expect(v.frames.find((f) => f.t === "ack" && f.id === "msg-file-05")!["status"]).toBe("ignored");
    expect(current.bed.blobs.stats().count).toBe(0);
  });

  it("refuses pieces out of order, damaged pieces, too many open files and files that are too big", async () => {
    current = await rig();
    const v = await owner(current);
    v.send({ t: "file", up: "up-order-01", name: "a", seq: 1, last: true, data: "AAAA" });
    expect(await status(v, "up-order-01")).toBe("bad_order");
    v.send({ t: "file", up: "up-bad64-01", name: "a", seq: 0, last: true, data: "***!" });
    expect(await status(v, "up-bad64-01")).toBe("damaged");
    for (let i = 0; i < 9; i++) v.send({ t: "file", up: `up-open-${i}00`, name: "a", seq: 0, last: false, data: "AAAA" });
    expect(await status(v, "up-open-800")).toBe("too_many");
  });

  it("stops a file that grows past the limit, and frees what it held", async () => {
    current = await rig();
    const v = await owner(current);
    const piece = Buffer.alloc(192 * 1024, 65).toString("base64");
    for (let i = 0; i < 44; i++) v.send({ t: "file", up: "up-big-0001", name: "a", seq: i, last: false, data: piece }); // 44 x 192 KB is over 8 MB
    expect(await status(v, "up-big-0001")).toBe("too_large");
    // the space is free again: a normal file still goes up
    pieces(v, "up-after-01", "pic.png", PNG);
    expect(await status(v, "up-after-01")).toBe("ready");
  });

  it("receives a file the assistant sends, in a frame of its own, and only on the browser it belongs to", async () => {
    current = await rig();
    const v = await owner(current);
    const other = await owner(current);
    await v.say("hello-0001", "hi");
    await waitFor(() => v.texts().some((t) => t.includes("echo: hi")));
    const session = current.bed.sessions!.list()[0]!.id;
    const put = current.bed.blobs.put(PNG, "image/png");
    current.bed.manager.sendFile(session, { id: put.id, name: "chart.png", mime: "image/png", bytes: PNG.length }, "here");
    await waitFor(() => v.frames.some((f) => Array.isArray(f["files"])));
    const frame = v.frames.find((f) => Array.isArray(f["files"]))!;
    expect(frame).toMatchObject({ t: "message", from: "assistant", text: "here", files: [{ name: "chart.png", mime: "image/png" }] });
    expect(Buffer.from((frame["files"] as Array<{ data: string }>)[0]!.data, "base64")).toEqual(PNG);
    expect(other.frames.some((f) => Array.isArray(f["files"]))).toBe(false);
  });

  it("closes a connection that sends a large frame before saying hello", async () => {
    current = await rig();
    const v = current.visitor();
    await v.open();
    v.send({ t: "hello", secret: "x".repeat(40_000), redeem: null });
    await waitFor(() => v.closed !== undefined);
    expect([1009, 1008]).toContain(v.closed?.code);
  });
});
