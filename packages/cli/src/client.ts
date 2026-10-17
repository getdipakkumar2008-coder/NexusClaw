import WebSocket from "ws";
import { PROTOCOL_VERSION, parseFrame, signDeviceChallenge, type ErrorBody, type EvtFrame } from "@clawnexus/protocol";

/** A paired device's identity: its id and the private key that proves it. */
export interface DeviceCredential {
  deviceId: string;
  privateKeyPem: string;
}

export interface ConnectOptions {
  timeoutMs?: number;
  /** SHA-256 fingerprint (hex) of the one certificate to trust, for a self-signed Gateway. */
  pin?: string;
  /** PEM certificate(s) to trust in addition to the system's. */
  ca?: string;
}

/** An error the user can act on: what failed, why, and what to do. Never carries a stack trace to the terminal. */
export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly remediation: string,
  ) {
    super(message);
  }
}

export function fromBody(e: ErrorBody): CliError {
  return new CliError(e.code, e.message, e.remediation);
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class GatewayClient {
  private n = 0;
  private readonly pending = new Map<string, Pending>();
  private listeners = new Set<(e: EvtFrame) => void>();
  private closeError: CliError | undefined;
  private closeListeners: Array<() => void> = [];

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (data) => {
      const parsed = parseFrame(data.toString());
      if (!parsed.ok) return;
      const f = parsed.frame;
      if (f.t === "evt") {
        for (const l of [...this.listeners]) l(f);
      } else if (f.t === "res") {
        const p = this.pending.get(f.id);
        if (!p) return;
        this.pending.delete(f.id);
        clearTimeout(p.timer);
        if (f.ok) p.resolve(f.result);
        else p.reject(fromBody(f.error));
      }
    });
    ws.on("close", (code, reason) => {
      this.closeError = new CliError("CONNECTION_CLOSED", `Gateway closed the connection (${code}${reason.length ? `: ${reason.toString()}` : ""})`, "Check the Gateway is still running with `clawnexus status`.");
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(this.closeError);
        this.pending.delete(id);
      }
      for (const l of this.closeListeners) l();
    });
    ws.on("error", () => undefined);
  }

  /** Open a socket, and for `wss:` decide whether to trust the server BEFORE anything is sent over it. */
  private static async open(url: string, o: ConnectOptions): Promise<WebSocket> {
    const secure = url.startsWith("wss:");
    if (!secure && !url.startsWith("ws:")) throw new CliError("USAGE", `${url} is not a ws:// or wss:// address`, "Use --url ws://host:port/v1/ws or wss://host:port/v1/ws.");
    const pin = o.pin?.replace(/[:\s]/g, "").toLowerCase();
    if (pin !== undefined && !/^[0-9a-f]{64}$/.test(pin)) throw new CliError("USAGE", "the certificate fingerprint must be 64 hex digits (SHA-256)", "Copy it from `clawnexus tls show` on the Gateway's computer.");
    const ws = new WebSocket(url, {
      handshakeTimeout: o.timeoutMs ?? 5_000,
      // A pinned certificate is trusted by its fingerprint alone (checked below); otherwise normal verification, plus any CA given.
      ...(secure ? { rejectUnauthorized: pin === undefined, ...(o.ca ? { ca: o.ca } : {}) } : {}),
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => {
        if (secure && pin !== undefined) {
          const sock = (ws as unknown as { _socket?: { getPeerCertificate(): { fingerprint256?: string } } })._socket;
          const seen = sock?.getPeerCertificate().fingerprint256?.replace(/:/g, "").toLowerCase();
          if (seen !== pin) {
            ws.terminate();
            return reject(new CliError("TLS_PIN", "the Gateway's certificate is not the one you pinned", "Check you are talking to the right computer. If its certificate was renewed, pin the new fingerprint."));
          }
        }
        resolve();
      });
      ws.once("error", (e: NodeJS.ErrnoException) =>
        reject(
          new CliError(
            /CERT|SELF_SIGNED|ERR_TLS|UNABLE_TO_VERIFY|HOSTNAME/i.test(`${e.code ?? ""} ${e.message}`) ? "TLS_UNTRUSTED" : "UNREACHABLE",
            e.code === "ECONNREFUSED"
              ? `no Gateway is listening at ${url}`
              : /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|HOSTNAME/i.test(`${e.code ?? ""} ${e.message}`)
                ? `cannot trust the Gateway's certificate at ${url}: ${e.message}`
                : `cannot connect to ${url}: ${e.message}`,
            /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|HOSTNAME/i.test(`${e.code ?? ""} ${e.message}`)
              ? "For a self-signed certificate, give its fingerprint (--fingerprint) or the certificate file (--ca)."
              : "Start it with `clawnexus gateway run`, or pass --url / --port if it listens elsewhere.",
          ),
        ),
      );
      ws.once("unexpected-response", (_req, res) =>
        reject(new CliError("UNREACHABLE", `${url} answered HTTP ${res.statusCode}, not a Gateway WebSocket`, "Check --url and --port.")),
      );
    });
    return ws;
  }

  /**
   * Connect and sign in. `credential` is the owner token (or a tool-bridge credential), or a paired device's key,
   * which signs a fresh challenge and keeps its short sign-in alive for as long as the connection is open.
   */
  static async connect(url: string, credential: string | DeviceCredential, options: number | ConnectOptions = {}): Promise<GatewayClient> {
    const o: ConnectOptions = typeof options === "number" ? { timeoutMs: options } : options;
    const ws = await GatewayClient.open(url, o);
    const c = new GatewayClient(ws);
    const hello = { protocol: PROTOCOL_VERSION, client: { kind: "cli", version: "0.0.0" } };
    try {
      if (typeof credential === "string") {
        await c.call("connection.hello", { ...hello, auth: { token: credential } });
        return c;
      }
      const first = await c.call<{ challenge?: { nonce: string } }>("connection.hello", { ...hello, auth: { device: { id: credential.deviceId } } });
      if (!first.challenge) throw new CliError("PROTOCOL", "the Gateway did not send a challenge", "Is this a ClawNexus Gateway?");
      const done = await c.call<{ leaseMs: number }>("auth.verify", { signature: signDeviceChallenge(credential.privateKeyPem, credential.deviceId, first.challenge.nonce, "connect") });
      c.keepAlive(credential, done.leaseMs);
      return c;
    } catch (e) {
      ws.terminate();
      throw e;
    }
  }

  /** Register a new device with a one-time code. The connection that results is signed in as that device. */
  static async pair(url: string, pair: { code: string; publicKey: string; name?: string }, options: ConnectOptions = {}): Promise<{ device: { id: string; name: string; scopes: string[] }; client: GatewayClient }> {
    const ws = await GatewayClient.open(url, options);
    const c = new GatewayClient(ws);
    try {
      const r = await c.call<{ device: { id: string; name: string; scopes: string[] } }>("connection.hello", { protocol: PROTOCOL_VERSION, client: { kind: "cli", version: "0.0.0" }, auth: { pair } });
      return { device: r.device, client: c };
    } catch (e) {
      ws.terminate();
      throw e;
    }
  }

  private refresh: NodeJS.Timeout | undefined;
  /** A device's sign-in lasts a short while; renew it well before it ends. */
  private keepAlive(cred: DeviceCredential, leaseMs: number): void {
    const every = Math.max(1_000, Math.floor(leaseMs * 0.6));
    this.refresh = setInterval(() => {
      void (async () => {
        const ch = await this.call<{ nonce: string }>("auth.challenge", {});
        await this.call("auth.refresh", { signature: signDeviceChallenge(cred.privateKeyPem, cred.deviceId, ch.nonce, "refresh") });
      })().catch(() => this.ws.close());
    }, every);
    this.refresh.unref();
  }

  call<T = unknown>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.closeError) return Promise.reject(this.closeError);
    const id = `cli-${++this.n}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CliError("TIMEOUT", `no answer to ${method} within ${timeoutMs / 1000}s`, "Check the Gateway with `clawnexus doctor`."));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.ws.send(JSON.stringify({ t: "req", id, method, params }));
    });
  }

  /** Runs once if the connection ends (the Gateway stopped, or revoked this credential). */
  onClose(fn: () => void): void {
    if (this.closeError) fn();
    else this.closeListeners.push(fn);
  }

  onEvent(fn: (e: EvtFrame) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close(): void {
    clearInterval(this.refresh);
    this.ws.close();
  }
}
