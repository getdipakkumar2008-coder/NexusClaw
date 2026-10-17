import { X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { request as plainRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { Io } from "@clawnexus/cli";
import { GatewayClient } from "@clawnexus/cli";
import { Gateway, startGateway } from "@clawnexus/gateway";
import { FakeProvider } from "@clawnexus/sessions";
import { runDoctor } from "./doctor.js";
import { main } from "./main.js";
import { startFromConfig, type Running } from "./serve.js";
import { runSetup } from "./setup.js";
import { initTls, loadTls, makeSelfSigned, summarize, tlsFiles, tlsProblems, validateHosts } from "./tlsinit.js";

let base: string;
let dir: string;
let running: Running | undefined;
let gw: Gateway | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "cn-tls-"));
  dir = join(base, "data");
});
afterEach(async () => {
  await running?.stop();
  running = undefined;
  await gw?.stop();
  gw = undefined;
  rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const rejects = async (fn: () => unknown, code: string): Promise<void> => {
  try {
    await fn();
  } catch (e) {
    expect((e as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
};

describe("the certificate maker", () => {
  it("makes a certificate Node accepts: the right names, addresses, purpose and lifetime, signed by its own key", () => {
    const { certPem, keyPem } = makeSelfSigned({ hosts: ["localhost", "127.0.0.1", "::1", "gw.example.org", "192.168.1.20", "*.lan.example.org", "2001:db8::5"], days: 90, now: () => Date.UTC(2026, 0, 1) });
    const c = new X509Certificate(certPem);
    expect(c.verify(c.publicKey)).toBe(true); // the signature is valid
    expect(c.ca).toBe(false);
    expect(c.keyUsage).toEqual(["1.3.6.1.5.5.7.3.1"]); // server authentication only
    for (const name of ["localhost", "gw.example.org", "printer.lan.example.org"]) expect(c.checkHost(name), name).toBeTruthy();
    for (const name of ["evil.example.com", "example.org"]) expect(c.checkHost(name), name).toBeUndefined();
    for (const ip of ["127.0.0.1", "192.168.1.20", "::1", "2001:db8::5"]) expect(c.checkIP(ip), ip).toBeTruthy();
    expect(c.checkIP("10.0.0.1")).toBeUndefined();
    const s = summarize(certPem, Date.UTC(2026, 0, 2));
    expect(s.selfSigned).toBe(true);
    expect(s.daysLeft).toBeGreaterThan(87);
    expect(s.daysLeft).toBeLessThanOrEqual(90);
    expect(new Date(s.notBefore).getTime()).toBeLessThan(Date.UTC(2026, 0, 1)); // backdated a few minutes
    expect(keyPem).toMatch(/BEGIN PRIVATE KEY/);
    expect(certPem.split("\n").every((l) => l.length <= 64 || l.startsWith("-----"))).toBe(true);
  });

  it("makes a different key and serial every time", () => {
    const a = new X509Certificate(makeSelfSigned({ hosts: ["localhost"] }).certPem);
    const b = new X509Certificate(makeSelfSigned({ hosts: ["localhost"] }).certPem);
    expect(a.serialNumber).not.toBe(b.serialNumber);
    expect(a.fingerprint256).not.toBe(b.fingerprint256);
  });

  it("refuses names that are not names, too many of them, and silly lifetimes", async () => {
    for (const bad of ["a b", "exa_mple.com", "-x.com", "x..com", "http://x.com", "x.com/path", "名前.jp"]) expect(() => validateHosts([bad]), bad).toThrow(/not a host name/);
    expect(() => validateHosts([])).toThrow(/no host names/);
    expect(() => validateHosts(Array.from({ length: 21 }, (_, i) => `h${i}.example.org`))).toThrow(/too many/);
    for (const days of [0, -1, 1.5, 4000]) expect(() => makeSelfSigned({ hosts: ["localhost"], days })).toThrow(/--days/);
    expect(() => makeSelfSigned({ hosts: ["localhost"], days: 3650, now: () => Date.UTC(2045, 0, 1) })).toThrow(/2050/);
  });

  it("writes private files, and will not overwrite them without being told to", async () => {
    const r = initTls(dir, { hosts: ["gw.example.org"] });
    expect(r.names).toEqual(expect.arrayContaining(["localhost", "127.0.0.1", "gw.example.org"]));
    if (process.platform !== "win32") expect(statSync(r.keyPath).mode & 0o077).toBe(0);
    await rejects(() => initTls(dir, {}), "TLS_EXISTS");
    const again = initTls(dir, { force: true });
    expect(again.fingerprint).not.toBe(r.fingerprint);
  });

  it("loads only a certificate and key that belong together", async () => {
    await rejects(() => loadTls(dir), "TLS_MISSING");
    initTls(dir, {});
    expect(loadTls(dir).cert.length).toBeGreaterThan(100);
    const other = makeSelfSigned({ hosts: ["localhost"] });
    writeFileSync(tlsFiles(dir).keyPath, other.keyPem);
    await rejects(() => loadTls(dir), "TLS_INVALID");
    writeFileSync(tlsFiles(dir).certPath, "not a certificate");
    await rejects(() => loadTls(dir), "TLS_INVALID");
  });

  it("reports an expired or soon-to-expire certificate", () => {
    initTls(dir, { days: 10 });
    expect(tlsProblems(dir)).toEqual([expect.objectContaining({ level: "warn", message: expect.stringMatching(/expires in \d+ day/) })]);
    expect(tlsProblems(dir, Date.now() + 400 * 86_400_000)[0]).toMatchObject({ level: "fail", message: expect.stringMatching(/expired/) });
    initTls(dir, { days: 365, force: true });
    expect(tlsProblems(dir)).toEqual([]);
  });
});

describe("the Gateway over TLS", () => {
  async function boot(host = "127.0.0.1"): Promise<{ port: number; cert: string; fingerprint: string }> {
    const t = initTls(dir, {});
    const started = await startGateway({ dataDir: dir, host, port: 0, provider: new FakeProvider(), tls: loadTls(dir) });
    gw = started.gateway;
    return { port: started.port, cert: readFileSync(t.certPath, "utf8"), fingerprint: t.fingerprint };
  }
  const token = (): string => readFileSync(join(dir, "gateway.token"), "utf8").trim();
  const get = (port: number, path: string, o: { ca?: string; host?: string; secure?: boolean } = {}): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const send = o.secure === false ? plainRequest : request;
      const req = send({ host: "127.0.0.1", port, path, method: "GET", headers: o.host ? { host: o.host } : {}, ...(o.secure === false ? {} : { ca: o.ca, rejectUnauthorized: o.ca !== undefined, servername: "localhost" }) }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    });

  it("serves HTTPS and secure WebSocket to a client that trusts its certificate", async () => {
    const { port, cert } = await boot();
    expect((await get(port, "/healthz", { ca: cert })).status).toBe(200);
    const c = await GatewayClient.connect(`wss://127.0.0.1:${port}/v1/ws`, token(), { ca: cert });
    expect(((await c.call("status")) as { server: string }).server).toMatch(/ClawNexus/);
    c.close();
  });

  it("is not trusted by default: a self-signed certificate is refused unless the client was given it", async () => {
    const { port, cert, fingerprint } = await boot();
    await rejects(() => GatewayClient.connect(`wss://127.0.0.1:${port}/v1/ws`, token()), "TLS_UNTRUSTED");
    await rejects(() => get(port, "/healthz", { ca: makeSelfSigned({ hosts: ["localhost"] }).certPem }), "DEPTH_ZERO_SELF_SIGNED_CERT");
    // pinning the fingerprint is enough, and a wrong one is refused before anything is sent
    const ok = await GatewayClient.connect(`wss://127.0.0.1:${port}/v1/ws`, token(), { pin: fingerprint });
    ok.close();
    const colon = (fingerprint.toUpperCase().match(/../g) ?? []).join(":");
    (await GatewayClient.connect(`wss://127.0.0.1:${port}/v1/ws`, token(), { pin: colon })).close();
    await rejects(() => GatewayClient.connect(`wss://127.0.0.1:${port}/v1/ws`, token(), { pin: "ab".repeat(32) }), "TLS_PIN");
    await rejects(() => GatewayClient.connect(`wss://127.0.0.1:${port}/v1/ws`, token(), { pin: "nothex" }), "USAGE");
    expect(cert).toContain("BEGIN CERTIFICATE");
  });

  it("does not speak plain HTTP or WebSocket on the TLS port", async () => {
    const { port } = await boot();
    await expect(get(port, "/healthz", { secure: false })).rejects.toBeTruthy();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`);
    await new Promise<void>((resolve) => {
      ws.on("error", () => resolve());
      ws.on("close", () => resolve());
      ws.on("open", () => resolve());
    });
    expect(ws.readyState).not.toBe(WebSocket.OPEN);
  });

  it("refuses to be reached under a name it has no certificate for", async () => {
    const { port, cert } = await boot();
    expect((await get(port, "/healthz", { ca: cert, host: `localhost:${port}` })).status).toBe(200);
    expect((await get(port, "/healthz", { ca: cert, host: `evil.example.com:${port}` })).status).toBe(403);
    expect((await get(port, "/healthz", { ca: cert, host: "127.0.0.1:1" })).status).toBe(403);
  });

  it("serves the WebChat page and accepts a browser on its https origin only", async () => {
    const { port, cert } = await boot();
    const page = await get(port, "/webchat", { ca: cert });
    expect(page.status).toBe(200);
    expect(page.body).toMatch(/<html/i);
    const connect = (origin: string): Promise<"open" | "refused"> =>
      new Promise((resolve) => {
        const ws = new WebSocket(`wss://127.0.0.1:${port}/v1/webchat`, { ca: cert, headers: { origin } });
        ws.on("open", () => (ws.close(), resolve("open")));
        ws.on("unexpected-response", () => resolve("refused"));
        ws.on("error", () => resolve("refused"));
      });
    expect(await connect(`https://127.0.0.1:${port}`)).toBe("open");
    expect(await connect(`http://127.0.0.1:${port}`)).toBe("refused");
    expect(await connect("https://evil.example.com")).toBe("refused");
  });

  it("hands a tool bridge the address and the certificate to trust", async () => {
    const { port, fingerprint } = await boot();
    const m = gw!.mintBridge({ session: "s", principal: "owner" });
    expect(m.url).toBe(`wss://127.0.0.1:${port}/v1/ws`);
    expect(m.pin).toBe(fingerprint);
    const c = await GatewayClient.connect(m.url, m.token, { pin: m.pin! });
    expect(((await c.call("tool.list")) as { tools: unknown[] }).tools.length).toBeGreaterThan(0);
    c.close();
  });
});

describe("listening beyond this computer", () => {
  it("is refused without TLS, unless the owner explicitly accepts the risk", async () => {
    expect(() => new Gateway({ dataDir: dir, host: "0.0.0.0", port: 0 })).toThrow(/without TLS/);
    const g = new Gateway({ dataDir: dir, host: "0.0.0.0", port: 0, insecure: true });
    await g.stop();
  });

  it("works with TLS: reachable on a real address, and only under a name the certificate covers", async () => {
    const t = initTls(dir, { hosts: ["gw.example.org"] });
    const started = await startGateway({ dataDir: dir, host: "0.0.0.0", port: 0, provider: new FakeProvider(), tls: loadTls(dir) });
    gw = started.gateway;
    const cert = readFileSync(t.certPath, "utf8");
    const status = (host: string): Promise<number> =>
      new Promise((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port: started.port, path: "/healthz", ca: cert, headers: { host }, rejectUnauthorized: true, servername: "localhost" }, (res) => (res.resume(), resolve(res.statusCode ?? 0)));
        req.on("error", reject);
        req.end();
      });
    expect(await status(`gw.example.org:${started.port}`)).toBe(200); // a name on the certificate
    expect(await status(`localhost:${started.port}`)).toBe(200);
    expect(await status(`other.example.org:${started.port}`)).toBe(403); // a name it has no certificate for
    // a tool bridge on this computer still reaches it through the loopback address
    expect(gw.url).toBe(`wss://127.0.0.1:${started.port}/v1/ws`);
  });
});

describe("TLS from the config and the command line", () => {
  const io = (): Io & { text: string } => {
    const x = { text: "", out: (s: string) => void (x.text += s), err: (s: string) => void (x.text += s), env: {} as Record<string, string | undefined>, platform: process.platform, home: base };
    return x;
  };
  const cli = async (args: string[], d = dir): Promise<{ code: number; text: string }> => {
    const i = io();
    const code = await main([...args, "--data-dir", d], i);
    return { code, text: i.text };
  };
  const enableTls = (): void => {
    const f = join(dir, "config.json");
    const cfg = JSON.parse(readFileSync(f, "utf8")) as { gateway: { tls: { enabled: boolean } } };
    cfg.gateway.tls.enabled = true;
    writeFileSync(f, JSON.stringify(cfg, null, 2));
  };

  it("makes and shows a certificate", async () => {
    await runSetup({ dataDir: dir, out: () => undefined });
    expect((await cli(["tls", "show"])).text).toMatch(/TLS_MISSING/);
    const made = await cli(["tls", "init", "--host", "gw.example.org,10.0.0.5", "--days", "30"]);
    expect(made.code).toBe(0);
    expect(made.text).toMatch(/gw.example.org, 10.0.0.5/);
    expect(made.text).toMatch(/fingerprint: [0-9A-F]{2}(:[0-9A-F]{2}){31}/);
    expect((await cli(["tls", "init"])).text).toMatch(/TLS_EXISTS/);
    const shown = await cli(["tls", "show", "--json"]);
    expect(JSON.parse(shown.text)).toMatchObject({ selfSigned: true, names: expect.arrayContaining(["gw.example.org", "10.0.0.5"]) });
    expect((await cli(["tls", "bogus"])).text).toMatch(/USAGE/);
  });

  it("will not start with TLS turned on and no certificate, and says what to do", async () => {
    await runSetup({ dataDir: dir, out: () => undefined });
    enableTls();
    await rejects(() => startFromConfig({ dataDir: dir, io: io(), port: 0, fakeProvider: true }), "TLS_MISSING");
  });

  it("starts with TLS, and every command finds it without being told: the address, the scheme and the certificate", async () => {
    await runSetup({ dataDir: dir, out: () => undefined });
    initTls(dir, {});
    enableTls();
    running = await startFromConfig({ dataDir: dir, io: io(), port: 0, fakeProvider: true });
    const endpoint = JSON.parse(readFileSync(join(dir, "gateway.endpoint"), "utf8")) as { url: string; fingerprint: string };
    expect(endpoint.url).toBe(`wss://127.0.0.1:${running.port}/v1/ws`);
    expect(endpoint.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const st = await cli(["status"]);
    expect(st.code, st.text).toBe(0);
    expect((await cli(["chat", "hello"])).text).toContain("echo: hello");
    const doctor = await runDoctor({ dataDir: dir, fix: false, port: running.port });
    expect(doctor.find((c) => c.id === "tls")?.status).toBe("ok");
    await running.stop();
    running = undefined;
    expect(existsSync(join(dir, "gateway.endpoint"))).toBe(false); // gone with the Gateway, so nothing points at a dead address
  });

  it("pairs another computer over TLS, which then works as a limited device until the owner revokes it", async () => {
    await runSetup({ dataDir: dir, out: () => undefined });
    const t = initTls(dir, {});
    enableTls();
    running = await startFromConfig({ dataDir: dir, io: io(), port: 0, fakeProvider: true });
    const url = `wss://127.0.0.1:${running.port}/v1/ws`;

    const pair = await cli(["devices", "pair", "--name", "laptop", "--scopes", "read,chat"]);
    expect(pair.code, pair.text).toBe(0);
    const code = /Pairing code: ([2-9A-HJKMNP-Z]{10})/.exec(pair.text)![1]!;
    expect(pair.text).toContain(`--fingerprint ${t.fingerprint}`);
    expect(pair.text).toMatch(/devices enroll --url wss:\/\/HOST:\d+\/v1\/ws/);

    // The other computer has its own data directory and no token. A wrong certificate is refused; the right one is enough.
    const other = join(base, "other");
    const bad = await cli(["devices", "enroll", "--url", url, "--code", code, "--fingerprint", "ab".repeat(32)], other);
    expect(bad.text).toMatch(/TLS_PIN/);
    const noTrust = await cli(["devices", "enroll", "--url", url, "--code", code], other);
    expect(noTrust.text).toMatch(/TLS_UNTRUSTED/);
    const enrolled = await cli(["devices", "enroll", "--url", url, "--code", code, "--name", "work laptop", "--fingerprint", t.fingerprint], other);
    expect(enrolled.code, enrolled.text).toBe(0);
    expect(enrolled.text).toMatch(/Paired as dev_[0-9a-f]{16} \("work laptop"\) with these permissions: read, chat/);
    const saved = JSON.parse(readFileSync(join(other, "device.json"), "utf8")) as { privateKeyPem: string; deviceId: string };
    expect(saved.privateKeyPem).toMatch(/PRIVATE KEY/);
    if (process.platform !== "win32") expect(statSync(join(other, "device.json")).mode & 0o077).toBe(0);
    expect((await cli(["devices", "enroll", "--url", url, "--code", code, "--fingerprint", t.fingerprint], other)).text).toMatch(/ALREADY_ENROLLED/);
    expect(readFileSync(join(dir, "gateway.db")).includes(Buffer.from("PRIVATE KEY"))).toBe(false);

    // As a device: it can look and chat, and nothing more.
    expect((await cli(["status"], other)).code).toBe(0);
    expect((await cli(["chat", "from my laptop"], other)).text).toContain("echo: from my laptop");
    const denied = await cli(["plugins", "list"], other);
    expect(denied.code).toBe(1);
    expect(denied.text).toMatch(/AUTH.FORBIDDEN/);
    expect((await cli(["memory", "list"], other)).text).toMatch(/AUTH.FORBIDDEN/);
    expect((await cli(["devices", "pair"], other)).text).toMatch(/AUTH.FORBIDDEN/);

    // The owner sees it and cuts it off.
    const listed = await cli(["devices", "list"]);
    expect(listed.text).toMatch(new RegExp(`${saved.deviceId}\\s+active\\s+work laptop\\s+read,chat`));
    expect((await cli(["devices", "revoke", saved.deviceId])).text).toMatch(/Revoked/);
    const after = await cli(["status"], other);
    expect(after.code).toBe(1);
    expect(after.text).toMatch(/AUTH.REVOKED/);
    expect((await cli(["devices", "list"])).text).toMatch(/revoked/);
  }, 60_000);

  it("keeps working for a remote Gateway you own, given only its address, token and fingerprint", async () => {
    await runSetup({ dataDir: dir, out: () => undefined });
    const t = initTls(dir, {});
    enableTls();
    running = await startFromConfig({ dataDir: dir, io: io(), port: 0, fakeProvider: true });
    const remoteView = join(base, "remote"); // a computer with no copy of the data directory
    mkdirSync(remoteView, { recursive: true });
    const i = io();
    i.env["CLAWNEXUS_TOKEN"] = readFileSync(join(dir, "gateway.token"), "utf8").trim();
    const code = await main(["status", "--data-dir", remoteView, "--url", `wss://127.0.0.1:${running.port}/v1/ws`, "--fingerprint", t.fingerprint], i);
    expect(code, i.text).toBe(0);
  });
});

describe("the doctor on a bad certificate", () => {
  it("fails when TLS is on and the files are missing or expired", async () => {
    await runSetup({ dataDir: dir, out: () => undefined });
    const f = join(dir, "config.json");
    const cfg = JSON.parse(readFileSync(f, "utf8")) as { gateway: { tls: { enabled: boolean } } };
    cfg.gateway.tls.enabled = true;
    writeFileSync(f, JSON.stringify(cfg));
    const missing = (await runDoctor({ dataDir: dir, fix: false, port: 59981 })).find((c) => c.id === "tls");
    expect(missing).toMatchObject({ status: "fail", fix: expect.stringMatching(/tls init/) });
    initTls(dir, { days: 1 });
    mkdirSync(join(dir, "tls"), { recursive: true });
    expect((await runDoctor({ dataDir: dir, fix: false, port: 59981 })).find((c) => c.id === "tls")?.status).toBe("warn");
  });
});
