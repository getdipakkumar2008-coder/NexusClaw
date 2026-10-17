import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { FakeAdapter, waitFor } from "@clawnexus/channels";
import { FakeProvider } from "@clawnexus/sessions";
import { Gateway, startGateway } from "./index.js";

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
  private constructor(readonly ws: WebSocket) {
    ws.on("message", (d) => {
      const f = JSON.parse(d.toString()) as Res | { t: string };
      if (f.t === "res") this.waiters.get((f as Res).id)?.(f as Res);
    });
  }
  static async open(port: number, token: string): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const c = new Client(ws);
    const r = await c.call("connection.hello", { protocol: { major: 1, minor: 0 }, client: { kind: "test", version: "0" }, auth: { token } });
    if (!r.ok) throw new Error("hello failed");
    return c;
  }
  call(method: string, params?: unknown): Promise<Res> {
    const id = `c-${++this.n}`;
    return new Promise((resolve) => {
      this.waiters.set(id, resolve);
      this.ws.send(JSON.stringify({ t: "req", id, method, params }));
    });
  }
  close(): void {
    this.ws.close();
  }
}

// A picture made of real chunks, as every PNG is (a file that cannot be followed is not sent: see the test below).
const chunk = (type: string, body: string): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  return Buffer.concat([len, Buffer.from(type, "latin1"), Buffer.from(body, "latin1"), Buffer.alloc(4)]);
};
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG = Buffer.concat([SIGNATURE, chunk("IHDR", "0123456789012"), chunk("IDAT", "gateway picture"), chunk("IEND", "")]);

let dir: string;
let gw: Gateway;
let port: number;
let clients: Client[];
let adapter: FakeAdapter;

const token = (): string => readFileSync(join(dir, "gateway.token"), "utf8").trim();
async function connect(t = token()): Promise<Client> {
  const c = await Client.open(port, t);
  clients.push(c);
  return c;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "gw-send-"));
  clients = [];
  const started = await startGateway({ dataDir: dir, port: 0, provider: new FakeProvider() });
  gw = started.gateway;
  port = started.port;
  adapter = new FakeAdapter("fake", { files: true });
  await gw.channels.attach(adapter);
});
afterEach(async () => {
  for (const c of clients) c.close();
  await gw?.stop();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function conversation(principal: "owner" | "guest", channel = "fake"): string {
  return gw.sessions!.getOrCreate({ channel, conversation: "default|u1", scope: "u1" }, principal).id;
}
/** Ask, have the owner approve, and ask again: how a model's call goes through when approval is needed. */
async function approvedCall(session: string, principal: "owner" | "guest", args: Record<string, unknown>): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const bridge = await connect(gw.mintBridge({ session, principal }).token);
  const first = (await bridge.call("tool.call", { tool: "file.send", args })).result;
  if (first.status !== "approval_required") return first;
  await (await connect()).call("approval.decide", { id: first.approvalId, approve: true });
  return (await bridge.call("tool.call", { tool: "file.send", args, approvalId: first.approvalId })).result;
}
const put = (data: Buffer, name: string): string => {
  mkdirSync(join(dir, "workspace"), { recursive: true });
  writeFileSync(join(dir, "workspace", name), data);
  return name;
};

describe("the assistant sending a file", () => {
  it("asks the owner first, then sends a workspace picture to the conversation it belongs to, and notes it in the transcript", async () => {
    const session = conversation("owner");
    const bridge = await connect(gw.mintBridge({ session, principal: "owner" }).token);
    const first = (await bridge.call("tool.call", { tool: "file.send", args: { path: put(PNG, "chart.png") } })).result;
    expect(first.status).toBe("approval_required");
    expect(adapter.sent).toEqual([]);

    const r = await approvedCall(session, "owner", { path: "chart.png", caption: "here you go" });
    expect(r).toMatchObject({ status: "ok", output: { queued: true, name: "chart.png", type: "image/png", bytes: PNG.length } });
    await waitFor(() => adapter.sent.length === 1);
    expect(adapter.sent[0]).toMatchObject({ conversationId: "u1", text: "here you go" });
    expect(Buffer.from(adapter.sent[0]!.files![0]!.data, "base64")).toEqual(PNG);
    expect(adapter.sent[0]!.files![0]).toMatchObject({ name: "chart.png", mime: "image/png" });

    const o = await connect();
    const msgs = (await o.call("session.get", { session })).result.messages as Array<{ role: string; content: string; attachments?: Array<{ name: string; mime: string }> }>;
    expect(msgs.at(-1)).toMatchObject({ role: "assistant", attachments: [{ name: "chart.png", mime: "image/png" }] });
    expect(gw.blobs.stats().count).toBe(1);
  });

  it("can send back a file that came in with the conversation, and refuses one that did not", async () => {
    const session = conversation("owner");
    const { id } = gw.blobs.put(PNG, "image/png");
    const other = gw.blobs.put(Buffer.from("belongs to nobody here"), "text/plain").id;
    gw.sessions!.send(session, "look", { sender: "u1", attachments: [{ id, name: "in.png", mime: "image/png", bytes: PNG.length }] });
    await gw.sessions!.idle();
    expect((await approvedCall(session, "owner", { attachment: id, name: "back.png" })).status).toBe("ok");
    await waitFor(() => adapter.sent.length === 1);
    expect(adapter.sent[0]!.files![0]!.name).toBe("back.png");
    const refused = await approvedCall(session, "owner", { attachment: other });
    expect(refused).toMatchObject({ status: "error", message: expect.stringMatching(/not part of this conversation/) });
  });

  it("is not available to a guest at all", async () => {
    const session = conversation("guest");
    const bridge = await connect(gw.mintBridge({ session, principal: "guest" }).token);
    expect((await bridge.call("tool.call", { tool: "file.send", args: { path: put(PNG, "g.png") } })).result.status).toBe("denied");
    expect(adapter.sent).toEqual([]);
  });

  it("says plainly when there is nobody to send to, or the channel cannot carry files", async () => {
    const local = gw.sessions!.getOrCreate({ channel: "local", conversation: "main", scope: "owner" }, "owner").id;
    expect(await approvedCall(local, "owner", { path: put(PNG, "a.png") })).toMatchObject({ status: "error", message: expect.stringMatching(/not on a running messaging channel/) });
    const plain = new FakeAdapter("plain");
    await gw.channels.attach(plain);
    const s = conversation("owner", "plain");
    expect(await approvedCall(s, "owner", { path: "a.png" })).toMatchObject({ status: "error", message: expect.stringMatching(/cannot carry files/) });
  });

  it("only sends what could also be received: by content, in the workspace, within the size limit", async () => {
    const session = conversation("owner");
    put(Buffer.concat([Buffer.from("MZ"), Buffer.from([0x90, 0, 3, 0])]), "photo.png");
    expect(await approvedCall(session, "owner", { path: "photo.png" })).toMatchObject({ status: "error", message: expect.stringMatching(/only pictures, PDF, audio and text/) });
    expect(await approvedCall(session, "owner", { path: "../gateway.token" })).toMatchObject({ status: "error" });
    expect(await approvedCall(session, "owner", { path: "does-not-exist.txt" })).toMatchObject({ status: "error", message: expect.stringMatching(/cannot be read/) });
    put(Buffer.alloc(8 * 1024 * 1024 + 1, 65), "big.txt");
    expect(await approvedCall(session, "owner", { path: "big.txt" })).toMatchObject({ status: "error", message: expect.stringMatching(/too large/) });
    const bridge = await connect(gw.mintBridge({ session, principal: "owner" }).token);
    const both = (await bridge.call("tool.call", { tool: "file.send", args: { path: "a", attachment: "0".repeat(64) } })).result;
    expect(both.status).toBe("error");
    expect(adapter.sent).toEqual([]);
  });

  it("removes hidden location data from a picture on the way out", async () => {
    const session = conversation("owner");
    const seg = (m: number, t: string): Buffer => Buffer.concat([Buffer.from([0xff, m, 0, t.length + 2]), Buffer.from(t, "latin1")]);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, "JFIF"), seg(0xe1, "Exif GPS 51.5N"), Buffer.from([0xff, 0xda, 0, 4, 0, 0]), Buffer.from("PIXELS"), Buffer.from([0xff, 0xd9])]);
    expect((await approvedCall(session, "owner", { path: put(jpeg, "p.jpg") })).status).toBe("ok");
    await waitFor(() => adapter.sent.length === 1);
    const sent = Buffer.from(adapter.sent[0]!.files![0]!.data, "base64").toString("latin1");
    expect(sent).not.toContain("GPS");
    expect(sent).toContain("PIXELS");
  });

  it("cuts what is appended to a picture, and refuses a picture whose hidden data cannot be removed", async () => {
    const session = conversation("owner");
    const appended = Buffer.concat([PNG, Buffer.from("EXIF GPS 51.5N hidden after the end")]);
    expect((await approvedCall(session, "owner", { path: put(appended, "tail.png") })).status).toBe("ok");
    await waitFor(() => adapter.sent.length === 1);
    expect(Buffer.from(adapter.sent[0]!.files![0]!.data, "base64")).toEqual(PNG);

    // starts like a JPEG but cannot be followed to its end: the location in it might be anywhere
    const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]), Buffer.from("Exif GPS 51.5N, and no end")]);
    const refused = await approvedCall(session, "owner", { path: put(broken, "broken.jpg") });
    expect(refused).toMatchObject({ status: "error", message: expect.stringMatching(/hidden data.*could not be removed/) });
    expect(adapter.sent).toHaveLength(1);
    expect(gw.blobs.stats().count).toBe(1); // nothing of the refused file was kept
  });

  it("keeps a file that is waiting to be sent when the store is cleaned", async () => {
    const session = conversation("owner");
    adapter.failSends = 100; // the platform is down: the file waits in the outbox
    expect((await approvedCall(session, "owner", { path: put(PNG, "wait.png") })).status).toBe("ok");
    expect(gw.blobs.stats().count).toBe(1);
    expect(gw.channels.outboxFileIds()).toHaveLength(1);
    expect(gw.gcBlobs().removed).toBe(0);
  });
});
