import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { errorBodySchema, generateDeviceKey, signDeviceChallenge } from "@clawnexus/protocol";
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

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("....IHDR gateway picture")]);

let dir: string;
let gw: Gateway;
let port: number;
let clients: Client[];
let clock: number;
let provider: FakeProvider;

async function boot(): Promise<void> {
  provider = new FakeProvider();
  const started = await startGateway({ dataDir: dir, port: 0, provider, now: () => clock });
  gw = started.gateway;
  port = started.port;
}
const token = (): string => readFileSync(join(dir, "gateway.token"), "utf8").trim();
async function owner(): Promise<Client> {
  const c = await Client.open(port);
  clients.push(c);
  expect((await c.hello({ token: token() })).ok).toBe(true);
  return c;
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gw-blob-"));
  clients = [];
  clock = Date.now();
});
afterEach(async () => {
  for (const c of clients) c.close();
  await gw?.stop();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function messageWithPicture(): Promise<{ sessionId: string; id: string }> {
  const { id } = gw.blobs.put(PNG, "image/png");
  const s = gw.sessions!.getOrCreate({ channel: "local", conversation: "main", scope: "owner" });
  gw.sessions!.send(s.id, "what is this?", { sender: "owner", attachments: [{ id, name: "pic.png", mime: "image/png", bytes: PNG.length }] });
  await gw.sessions!.idle();
  return { sessionId: s.id, id };
}

describe("attachments over the protocol", () => {
  it("lists them on a session's messages and lets the owner fetch the bytes", async () => {
    await boot();
    const o = await owner();
    const { sessionId, id } = await messageWithPicture();
    const msgs = (await o.call("session.get", { session: sessionId })).result.messages as Array<{ role: string; attachments?: Array<{ id: string; name: string }> }>;
    expect(msgs.find((m) => m.role === "user")?.attachments?.[0]).toMatchObject({ id, name: "pic.png" });
    const got = await o.call("blob.get", { id });
    expect(got.ok).toBe(true);
    expect(got.result).toMatchObject({ id, mime: "image/png", bytes: PNG.length });
    expect(Buffer.from(got.result.data, "base64")).toEqual(PNG);
    // the model was handed it too
    expect(provider.calls[0]?.attachments?.[0]?.read()).toEqual(PNG);
  });

  it("says no clearly for an unknown or malformed id", async () => {
    await boot();
    const o = await owner();
    for (const bad of ["0".repeat(64), "../../gateway.db", "short", "G".repeat(64)]) {
      const r = await o.call("blob.get", { id: bad });
      expect(r.error?.code, bad).toBe("SESSION.NOT_FOUND");
      expect(errorBodySchema.safeParse(r.error).success).toBe(true);
    }
  });

  it("is open to a device that may read, and closed to a tool bridge", async () => {
    await boot();
    const o = await owner();
    const { id } = await messageWithPicture();
    const begin = (await o.call("device.pair.begin", { scopes: ["read"] })).result;
    const key = generateDeviceKey();
    const pairing = await Client.open(port);
    clients.push(pairing);
    const paired = await pairing.hello({ pair: { code: begin.code, publicKey: key.publicKey } });
    const deviceId = paired.result.device.id as string;
    const d = await Client.open(port);
    clients.push(d);
    const h = await d.hello({ device: { id: deviceId } });
    await d.call("auth.verify", { signature: signDeviceChallenge(key.privateKeyPem, deviceId, h.result.challenge.nonce, "connect") });
    expect((await d.call("blob.get", { id })).ok).toBe(true);

    const bridge = await Client.open(port);
    clients.push(bridge);
    await bridge.hello({ token: gw.mintBridge({ session: "s", principal: "owner" }).token });
    expect((await bridge.call("blob.get", { id })).error?.code).toBe("AUTH.FORBIDDEN");
  });
});

describe("keeping files tidy", () => {
  it("deletes a file when the last session that used it is deleted, and keeps one still in use", async () => {
    await boot();
    const o = await owner();
    const first = await messageWithPicture();
    // a second session uses the same picture
    const s2 = gw.sessions!.getOrCreate({ channel: "local", conversation: "two", scope: "owner" });
    gw.sessions!.send(s2.id, "again", { sender: "owner", attachments: [{ id: first.id, name: "pic.png", mime: "image/png" }] });
    await gw.sessions!.idle();
    clock += 2 * 3600_000; // past the grace period for new files

    await o.call("session.delete", { session: first.sessionId });
    expect(gw.blobs.read(first.id)).toBeDefined(); // the other session still needs it
    await o.call("session.delete", { session: s2.id });
    expect(gw.blobs.read(first.id)).toBeUndefined();
    expect(gw.blobs.stats().count).toBe(0);
  });

  it("keeps a new file for a while even if no message mentions it yet", async () => {
    await boot();
    const { id } = gw.blobs.put(PNG, "image/png");
    expect(gw.gcBlobs().removed).toBe(0);
    expect(gw.blobs.read(id)).toBeDefined();
    clock += 2 * 3600_000;
    expect(gw.gcBlobs().removed).toBe(1);
  });

  it("clears out files nothing refers to when it starts", async () => {
    await boot();
    const { id } = gw.blobs.put(PNG, "image/png");
    await gw.stop();
    clock += 3 * 3600_000;
    await boot();
    expect(gw.blobs.read(id)).toBeUndefined();
    expect(existsSync(join(dir, "blobs", id.slice(0, 2), id))).toBe(false);
  });
});

describe("exporting a conversation that has files", () => {
  it("records which files came with each message, in both formats, without their bytes", async () => {
    await boot();
    const o = await owner();
    const { sessionId, id } = await messageWithPicture();
    const jsonl = (await o.call("session.export", { session: sessionId, format: "jsonl" })).result.content as string;
    const userLine = jsonl.split("\n").map((l) => (l ? JSON.parse(l) : null)).find((m) => m?.role === "user");
    expect(userLine.files).toEqual([{ id, name: "pic.png", mime: "image/png", bytes: PNG.length }]);
    expect(jsonl).not.toContain(PNG.toString("base64"));
    const md = (await o.call("session.export", { session: sessionId, format: "markdown" })).result.content as string;
    expect(md).toContain(`- file "pic.png" (image/png, ${PNG.length} bytes, ${id.slice(0, 12)})`);
  });

  it("can be imported again; the record of files is read but not brought back as files", async () => {
    await boot();
    const o = await owner();
    const { sessionId } = await messageWithPicture();
    const jsonl = (await o.call("session.export", { session: sessionId, format: "jsonl" })).result.content as string;
    await o.call("session.delete", { session: sessionId });
    const imported = await o.call("session.import", { content: jsonl });
    expect(imported.ok).toBe(true);
    const msgs = (await o.call("session.get", { session: imported.result.session.id })).result.messages as Array<{ attachments?: unknown }>;
    expect(msgs.every((m) => m.attachments === undefined)).toBe(true);
  });
});
