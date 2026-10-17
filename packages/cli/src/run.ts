import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND } from "@clawnexus/brand";
import { PROTOCOL_VERSION, generateDeviceKey } from "@clawnexus/protocol";
import { parseArgs, strFlag, type Parsed } from "./args.js";
import { CliError, GatewayClient, type ConnectOptions, type DeviceCredential } from "./client.js";
import { DEFAULT_PORT, TOKEN_FILE, defaultDataDir } from "./paths.js";

export interface Io {
  out(text: string): void;
  err(text: string): void;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  home: string;
  /** Read one secret without showing it: typed with no echo at a terminal, or the first line of piped input. Never taken from the command line. */
  readSecret?(prompt: string): Promise<string>;
}

/** Read a secret from this process's own terminal or pipe. */
async function readSecretFromStdin(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let data = "";
    stdin.setEncoding("utf8");
    for await (const chunk of stdin) {
      data += chunk as string;
      if (data.includes("\n") || data.length > 20_000) break;
    }
    return (data.split(/\r?\n/)[0] ?? "").trim();
  }
  process.stderr.write(prompt);
  return new Promise<string>((resolvePromise, reject) => {
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          done();
          return resolvePromise(value.trim());
        }
        if (ch === "\u0003") {
          done();
          return reject(new CliError("CANCELLED", "cancelled", "Run the command again when you are ready."));
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

export function systemIo(): Io {
  return {
    out: (s) => void process.stdout.write(s),
    err: (s) => void process.stderr.write(s),
    env: process.env,
    platform: process.platform,
    home: homedir(),
    readSecret: readSecretFromStdin,
  };
}

export function versionLine(): string {
  return `${BRAND.cli} (protocol ${PROTOCOL_VERSION.major}.${PROTOCOL_VERSION.minor})`;
}

export const USAGE = `${BRAND.name} — your self-hosted personal assistant

Usage: ${BRAND.cli} <command> [options]

Run the Gateway
  gateway run [--fake-provider]   start the Gateway in this terminal
  setup [--profile P] [--yes]     create the data directory, config and token
  doctor [--fix]                  check this installation and (with --fix) repair what is safe to repair
  devices pair [--name N] [--scopes read,chat,approve]   one-time code for a phone or another computer
  devices list | devices revoke ID
  devices enroll --url wss://HOST:PORT/v1/ws --code CODE [--fingerprint HEX | --ca FILE]   make THIS computer a device of another Gateway
  tls init [--host a,b] [--days N] [--force] | tls show   make or inspect the Gateway's certificate
  service install|uninstall|status|start|stop|restart   run the Gateway in the background, started when you sign in
  logs [--lines N]                show the Gateway's log (secret-free, rotated)
  backup [--out DIR]              write a verified snapshot of your data
  restore <DIR> [--force]         restore a snapshot (Gateway must be stopped)

Talk to a running Gateway
  status                          show Gateway health
  chat <text>                     send a message and stream the reply  [--session ID]
  sessions list|show|export|delete [ID]  [--format jsonl|markdown]
  pairing list|approve|deny [CODE]  |  pairing owner <channel> <your-id>
  webchat link                    one-time link that makes a browser the owner (opens the chat page)
  channels                        show channels and their health
  approvals list|approve|deny [ID]
  tool list | tool call <name> --args '<json>' [--approval ID]
  memory list|contacts|show|write|delete|export|erase|path   your saved notes (plain Markdown files)
    memory list [--contact CHANNEL:ID]   memory show NAME   memory write NAME (--text T | --file F) [--append]
    memory export DIR   memory erase (--all | --owner | --contact CHANNEL:ID) --yes   memory path
  plugins list|info|install|enable|disable|remove [ID | PATH | NAME]   (NAME: telegram, discord, slack, hello-tool ship with the program)  [--yes] [--replace] [--purge-data]
  plugins config ID [set KEY=VALUE... | unset KEY...]   a plugin's settings
  plugins secret ID [set NAME | delete NAME]            a plugin's secrets (the value is asked for, never typed on the command line)

Options
  --json            machine-readable output
  --url URL         Gateway WebSocket URL (default ws://127.0.0.1:${DEFAULT_PORT}/v1/ws)
  --port N          shorthand for the port on 127.0.0.1
  --fingerprint HEX trust only the Gateway certificate with this SHA-256 fingerprint (self-signed Gateways)
  --ca FILE         also trust this certificate file
  --device          sign in with this computer's paired-device key even if a token is available
  --data-dir DIR    data directory (default: per-OS; env ${BRAND.envPrefix}DATA_DIR)
  --help, --version
`;

export interface Context {
  p: Parsed;
  io: Io;
  json: boolean;
  dataDir: string;
}

const need = (p: Parsed, i: number, what: string): string => {
  const v = p.positionals[i];
  if (v === undefined) throw new CliError("USAGE", `missing ${what}`, `Run \`${BRAND.cli} --help\` to see how to use this command.`);
  return v;
};

/** What `devices enroll` saves: where the Gateway is, who this device is, and how to trust the Gateway's certificate. */
interface DeviceFile {
  url: string;
  deviceId: string;
  privateKeyPem: string;
  fingerprint?: string;
  ca?: string;
}
export const DEVICE_FILE = "device.json";

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

const pidAlive = (pid: unknown): boolean => {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Where a running Gateway on this computer says it is (and the certificate it uses). Ignored if that Gateway is gone. */
function localEndpoint(c: Context): { url: string; fingerprint?: string } | undefined {
  const e = readJson<{ url?: string; fingerprint?: string; pid?: number }>(join(c.dataDir, "gateway.endpoint"));
  return e?.url && pidAlive(e.pid) ? { url: e.url, ...(e.fingerprint ? { fingerprint: e.fingerprint } : {}) } : undefined;
}

interface Connection {
  url: string;
  credential: string | DeviceCredential;
  options: ConnectOptions;
}

function resolveConnection(c: Context): Connection {
  const urlFlag = strFlag(c.p, "url");
  const caFile = strFlag(c.p, "ca");
  let ca: string | undefined;
  if (caFile) {
    try {
      ca = readFileSync(resolve(caFile), "utf8");
    } catch {
      throw new CliError("NO_FILE", `cannot read ${caFile}`, "Check the path of the certificate file.");
    }
  }
  const pinFlag = strFlag(c.p, "fingerprint") ?? c.io.env[`${BRAND.envPrefix}FINGERPRINT`];

  // Who we are: the owner's token if this computer has it (or it was given), otherwise a paired device's key.
  const tokenFlag = strFlag(c.p, "token") ?? c.io.env[`${BRAND.envPrefix}TOKEN`];
  let token = c.p.flags["device"] === true ? undefined : tokenFlag;
  if (token === undefined && c.p.flags["device"] !== true) {
    const t = (() => {
      try {
        return readFileSync(join(c.dataDir, TOKEN_FILE), "utf8").trim();
      } catch {
        return "";
      }
    })();
    if (t) token = t;
  }
  const device = token === undefined ? readJson<DeviceFile>(join(c.dataDir, DEVICE_FILE)) : undefined;
  if (token === undefined && !device?.deviceId) {
    throw new CliError(
      "NO_TOKEN",
      `no Gateway token found at ${join(c.dataDir, TOKEN_FILE)} and this computer is not paired as a device`,
      `Run \`${BRAND.cli} setup\` (or start the Gateway) on this machine; set ${BRAND.envPrefix}TOKEN for a remote Gateway you own; or pair this computer with \`${BRAND.cli} devices enroll --url wss://HOST:PORT/v1/ws --code CODE\`.`,
    );
  }

  // Where the Gateway is.
  let url = urlFlag;
  let pin = pinFlag;
  if (url === undefined) {
    if (device && token === undefined) {
      url = device.url;
      pin ??= device.fingerprint;
      ca ??= device.ca;
    } else {
      const portText = strFlag(c.p, "port") ?? c.io.env[`${BRAND.envPrefix}PORT`];
      if (portText !== undefined && !/^\d{1,5}$/.test(portText)) throw new CliError("USAGE", `invalid port ${portText}`, "Use a number between 1 and 65535.");
      const e = localEndpoint(c);
      if (e && (portText === undefined || new URL(e.url).port === portText)) {
        url = e.url;
        pin ??= e.fingerprint;
      } else url = `ws://127.0.0.1:${portText ?? String(DEFAULT_PORT)}/v1/ws`;
    }
  } else if (device && token === undefined) {
    // an explicit address for a paired device: keep its saved trust only if it is the same server
    if (new URL(url).host === new URL(device.url).host) {
      pin ??= device.fingerprint;
      ca ??= device.ca;
    }
  }
  return {
    url,
    credential: token ?? { deviceId: device!.deviceId, privateKeyPem: device!.privateKeyPem },
    options: { ...(pin ? { pin } : {}), ...(ca ? { ca } : {}) },
  };
}

async function withClient<T>(c: Context, fn: (g: GatewayClient) => Promise<T>): Promise<T> {
  const conn = resolveConnection(c);
  const g = await GatewayClient.connect(conn.url, conn.credential, conn.options);
  try {
    return await fn(g);
  } finally {
    g.close();
  }
}

const show = (c: Context, value: unknown, human: () => string): void => c.io.out(c.json ? `${JSON.stringify(value, null, 2)}\n` : human());

// ---------------- commands ----------------

type Handler = (c: Context) => Promise<number>;

const status: Handler = (c) =>
  withClient(c, async (g) => {
    const s = await g.call<{ server: string; latestSeq: number; connections: number; uptimeMs: number; senders: { paired: number; pending: number } }>("status");
    show(c, s, () =>
      [
        `${s.server}`,
        `  uptime        ${Math.round(s.uptimeMs / 1000)}s`,
        `  connections   ${s.connections}`,
        `  latest event  ${s.latestSeq}`,
        `  senders       ${s.senders.paired} paired, ${s.senders.pending} waiting for approval`,
        "",
      ].join("\n"),
    );
    return 0;
  });

const chat: Handler = (c) =>
  withClient(c, async (g) => {
    const text = c.p.positionals.slice(1).join(" ");
    if (!text.trim()) throw new CliError("USAGE", "nothing to send", `Usage: ${BRAND.cli} chat <text>`);
    let session = strFlag(c.p, "session");
    if (!session) session = (await g.call<{ session: { id: string } }>("session.create", {})).session.id;

    const run: { id?: string } = {};
    const buffered: Array<{ type: string; data: { runId?: string; text?: string; error?: string } }> = [];
    let reply = "";
    let failure: string | undefined;
    const done = new Promise<void>((resolve) => {
      g.onEvent((e) => {
        if (e.session !== session) return;
        if (e.type === "approval.requested") {
          // The model is waiting for the owner. Say exactly what it wants and how to answer.
          const a = (e.data ?? {}) as { id?: string; tool?: string; args?: string; reason?: string };
          c.io.err(
            `\n[approval needed] ${a.tool ?? "a tool"} ${(a.args ?? "").slice(0, 300)}\n  why: ${a.reason ?? "policy"}\n  allow: ${BRAND.cli} approvals approve ${a.id}\n  refuse: ${BRAND.cli} approvals deny ${a.id}\n`,
          );
          return;
        }
        const data = (e.data ?? {}) as { runId?: string; text?: string; error?: string };
        if (run.id === undefined) {
          buffered.push({ type: e.type, data });
          return;
        }
        if (data.runId !== run.id) return;
        if (e.type === "run.delta" && data.text) {
          reply += data.text;
          if (!c.json) c.io.out(data.text);
        } else if (e.type === "run.completed") resolve();
        else if (e.type === "run.failed" || e.type === "run.cancelled") {
          failure = data.error ?? e.type.slice(4);
          resolve();
        }
      });
    });
    await g.call("events.subscribe", {});
    const sent = await g.call<{ runId: string; queued: number }>("session.send", { session, text });
    run.id = sent.runId;
    const runId = sent.runId;
    // Replay whatever arrived between subscribe and learning our run id.
    const early = buffered.splice(0);
    for (const e of early) {
      if (e.data.runId !== runId) continue;
      if (e.type === "run.delta" && e.data.text) {
        reply += e.data.text;
        if (!c.json) c.io.out(e.data.text);
      }
    }
    const finished = early.find((e) => e.data.runId === runId && (e.type === "run.completed" || e.type === "run.failed" || e.type === "run.cancelled"));
    if (finished && finished.type !== "run.completed") failure = finished.data.error ?? finished.type.slice(4);
    if (!finished) {
      const timeoutMs = Number(strFlag(c.p, "timeout") ?? 180) * 1000;
      await Promise.race([
        done,
        new Promise<void>((_, rej) => setTimeout(() => rej(new CliError("TIMEOUT", "the run did not finish in time", "Use `sessions show` later, or raise --timeout (seconds).")), timeoutMs).unref()),
      ]);
    }
    if (c.json) c.io.out(`${JSON.stringify({ session, runId, reply, ...(failure ? { error: failure } : {}) }, null, 2)}\n`);
    else c.io.out("\n");
    if (failure) {
      c.io.err(`The run did not complete: ${failure}\n`);
      return 1;
    }
    return 0;
  });

const sessions: Handler = (c) =>
  withClient(c, async (g) => {
    const sub = c.p.positionals[1] ?? "list";
    if (sub === "list") {
      const r = await g.call<{ sessions: Array<{ id: string; channel: string; conversation: string; scope: string; createdAt: number }> }>("session.list", {});
      show(c, r, () => (r.sessions.length ? r.sessions.map((s) => `${s.id}  ${s.channel}/${s.conversation}/${s.scope}  ${new Date(s.createdAt).toISOString()}`).join("\n") + "\n" : "No sessions yet.\n"));
    } else if (sub === "show") {
      const r = await g.call<{ messages: Array<{ role: string; sender: string; content: string }> }>("session.get", { session: need(c.p, 2, "session id") });
      show(c, r, () => r.messages.map((m) => `[${m.role}${m.sender ? ` ${m.sender}` : ""}] ${m.content}`).join("\n") + "\n");
    } else if (sub === "export") {
      const format = strFlag(c.p, "format") ?? "jsonl";
      const r = await g.call<{ content: string }>("session.export", { session: need(c.p, 2, "session id"), format });
      c.io.out(r.content);
    } else if (sub === "delete") {
      await g.call("session.delete", { session: need(c.p, 2, "session id") });
      show(c, { deleted: true }, () => "Deleted.\n");
    } else throw new CliError("USAGE", `unknown sessions command ${sub}`, "Use list, show, export or delete.");
    return 0;
  });

const pairing: Handler = (c) =>
  withClient(c, async (g) => {
    const sub = c.p.positionals[1] ?? "list";
    if (sub === "list") {
      const status = strFlag(c.p, "status");
      const r = await g.call<{ senders: Array<{ channel: string; externalId: string; display: string; status: string; role: string }> }>("pairing.list", status ? { status } : {});
      show(c, r, () => (r.senders.length ? r.senders.map((s) => `${s.status.padEnd(8)} ${s.role.padEnd(6)} ${s.channel}:${s.externalId} ${s.display}`).join("\n") + "\n" : "No senders.\n"));
    } else if (sub === "approve" || sub === "deny") {
      const r = await g.call<{ sender: { channel: string; externalId: string; status: string } }>(`pairing.${sub}`, { code: need(c.p, 2, "pairing code") });
      show(c, r, () => `${sub === "approve" ? "Approved" : "Denied"} ${r.sender.channel}:${r.sender.externalId} (${r.sender.status}).\n`);
    } else if (sub === "owner") {
      // Register one of YOUR OWN identities on a channel (e.g. your Telegram user id). Only this local command can do it.
      const channel = need(c.p, 2, "channel");
      const id = need(c.p, 3, "your id on that channel");
      const account = strFlag(c.p, "account");
      const r = await g.call<{ sender: { channel: string; externalId: string } }>("pairing.owner", { channel, id, ...(account ? { accountId: account } : {}) });
      show(c, r, () => `Registered ${r.sender.channel}:${r.sender.externalId} as an owner identity. Messages from it are served with your full authority.\n`);
    } else throw new CliError("USAGE", `unknown pairing command ${sub}`, "Use list, approve, deny or owner.");
    return 0;
  });

const channels: Handler = (c) =>
  withClient(c, async (g) => {
    const r = await g.call<{ channels: Array<{ id: string; status: { state: string; detail?: string } }> }>("channel.list", {});
    show(c, r, () => (r.channels.length ? `${r.channels.map((x) => `${x.id.padEnd(14)} ${x.status.state.padEnd(14)} ${x.status.detail ?? ""}`).join("\n")}\n` : "No channels.\n"));
    return 0;
  });

const webchat: Handler = (c) =>
  withClient(c, async (g) => {
    const sub = c.p.positionals[1] ?? "link";
    if (sub !== "link") throw new CliError("USAGE", `unknown webchat command ${sub}`, "Use `webchat link`.");
    const r = await g.call<{ url: string; expiresAt: number }>("channel.webchat.link", {});
    show(
      c,
      r,
      () =>
        `Open this link in the browser you want to use as the owner:\n\n  ${r.url}\n\n` +
        `It works once and expires at ${new Date(r.expiresAt).toLocaleTimeString()}. Whoever opens it first becomes the owner, so do not share it.\n` +
        `Other people who open ${r.url.split("#")[0]} get a pairing code that you approve with \`${BRAND.cli} pairing approve <code>\`.\n`,
    );
    return 0;
  });

const approvals: Handler = (c) =>
  withClient(c, async (g) => {
    const sub = c.p.positionals[1] ?? "list";
    if (sub === "list") {
      const r = await g.call<{ approvals: Array<{ id: string; tool: string; requester: string; expiresAt: number }> }>("approval.list", {});
      show(c, r, () => (r.approvals.length ? r.approvals.map((a) => `${a.id}  ${a.tool}  requested by ${a.requester}  expires ${new Date(a.expiresAt).toISOString()}`).join("\n") + "\n" : "Nothing waiting for approval.\n"));
    } else if (sub === "approve" || sub === "deny") {
      const r = await g.call<{ approval: { state: string } }>("approval.decide", { id: need(c.p, 2, "approval id"), approve: sub === "approve" });
      show(c, r, () => `Approval ${r.approval.state}.\n`);
    } else throw new CliError("USAGE", `unknown approvals command ${sub}`, "Use list, approve or deny.");
    return 0;
  });

const tool: Handler = (c) =>
  withClient(c, async (g) => {
    const sub = c.p.positionals[1] ?? "list";
    if (sub === "list") {
      const r = await g.call<{ tools: Array<{ name: string; risk: number; description: string }> }>("tool.list", {});
      show(c, r, () => r.tools.map((t) => `${t.name.padEnd(10)} R${t.risk}  ${t.description}`).join("\n") + "\n");
    } else if (sub === "call") {
      const name = need(c.p, 2, "tool name");
      let args: unknown = {};
      const raw = strFlag(c.p, "args");
      if (raw !== undefined) {
        try {
          args = JSON.parse(raw);
        } catch {
          throw new CliError("USAGE", "--args is not valid JSON", `Example: --args '{"path":"notes.txt"}'`);
        }
      }
      const approvalId = strFlag(c.p, "approval");
      const r = await g.call<{ status: string; approvalId?: string; reason?: string; message?: string; code?: string; output?: unknown }>("tool.call", { tool: name, args, ...(approvalId ? { approvalId } : {}) });
      show(c, r, () => {
        if (r.status === "approval_required") {
          return `Approval needed (${r.reason}).\n  1. ${BRAND.cli} approvals approve ${r.approvalId}\n  2. ${BRAND.cli} tool call ${name} --args '...' --approval ${r.approvalId}\n`;
        }
        if (r.status === "denied") return `Denied: ${r.reason}\n`;
        if (r.status === "error") return `Failed (${r.code}): ${r.message}\n`;
        return `${JSON.stringify(r.output, null, 2)}\n`;
      });
      return r.status === "ok" || r.status === "approval_required" ? 0 : 1;
    } else throw new CliError("USAGE", `unknown tool command ${sub}`, "Use list or call.");
    return 0;
  });

interface PluginView {
  id: string;
  status: string;
  reason?: string;
  trust: string;
  name?: string;
  version?: string;
  kind?: string;
  permissions?: { network: string[]; fs: string[]; exec: boolean; secrets: string[] };
  enforcement?: { fs: string; exec: string; network: string; secrets: string };
  riskFloor?: number;
  approvalToken?: string;
  tools: string[];
  channel?: string;
  provides?: string[];
  problems?: string[];
  missing?: string[];
}

interface SettingsView {
  id: string;
  settings: Array<{ name: string; type: string; description?: string; required: boolean; enum?: string[]; value?: string | number | boolean }>;
  secrets: Array<{ name: string; set: boolean }>;
  missing: string[];
}

function describeSettings(s: SettingsView): string {
  const lines = [s.id];
  if (s.settings.length === 0 && s.secrets.length === 0) lines.push("  This plugin has no settings and needs no secrets.");
  for (const x of s.settings) {
    const shown = x.value === undefined ? "(not set)" : String(x.value);
    lines.push("  setting " + x.name.padEnd(18) + " " + shown + (x.required ? "" : "  (optional)") + "   " + x.type + (x.enum ? " one of " + x.enum.join("/") : "") + (x.description ? " - " + x.description : ""));
  }
  for (const x of s.secrets) lines.push("  secret  " + x.name.padEnd(18) + " " + (x.set ? "set" : "NOT SET"));
  if (s.missing.length) lines.push("  still needed: " + s.missing.join(", "));
  return lines.join("\n") + "\n";
}

/** What the owner is agreeing to, in plain words, with honesty about what the system can and cannot hold the plugin to. */
function describePlugin(p: PluginView): string {
  const perm = p.permissions;
  const lines = [
    `${p.id}${p.name ? `  (${p.name}${p.version ? ` ${p.version}` : ""})` : ""}`,
    `  status:   ${p.status}${p.reason ? ` - ${p.reason}` : ""}`,
    `  trust:    ${p.trust} (not signed, not from a registry; only install code you trust)`,
  ];
  if (p.problems && p.problems.length > 1) lines.push(...p.problems.map((x) => `  problem:  ${x}`));
  if (perm) {
    lines.push(
      "  it will be allowed to:",
      `    files:    ${perm.fs.length ? "read and write its own data folder (enforced)" : "no file access beyond its own code (enforced)"}`,
      `    programs: ${perm.exec ? "start other programs (enforced) - treat as full access to this computer" : "cannot start programs (enforced)"}`,
      `    network:  ${perm.network.length ? `${perm.network.join(", ")} - declared only; NOT enforced, the plugin could reach other hosts` : "none declared (not enforced: a plugin can still try to reach the network)"}`,
      `    secrets:  ${perm.secrets.length ? `${perm.secrets.join(", ")} - only these are given to it; its code can read them and, since the network is not enforced, could send them anywhere` : "none"}`,
      `  its tools are never rated below risk class R${p.riskFloor ?? 0}, and their output is treated as untrusted`,
    );
  }
  const channels = (p.provides ?? []).filter((x) => x.startsWith("channel:"));
  if (channels.length) lines.push(`  channel:  ${channels.join(", ")} - connects a messaging platform. It tells the Gateway who is writing, so it can claim to be anyone on its own channel (never on another); you still approve each person by pairing code.`);
  if (p.tools.length) lines.push(`  tools:    ${p.tools.join(", ")}`);
  return `${lines.join("\n")}\n`;
}

const plugins: Handler = (c) =>
  withClient(c, async (g) => {
    const sub = c.p.positionals[1] ?? "list";
    if (sub === "list") {
      const r = await g.call<{ plugins: PluginView[] }>("plugin.list", {});
      show(c, r, () =>
        r.plugins.length
          ? `${r.plugins.map((p) => `${p.id.padEnd(22)} ${p.status.padEnd(15)} ${p.version ?? ""}${p.reason && p.status !== "disabled" ? `   ${p.reason}` : ""}`).join("\n")}\n`
          : `No plugins installed. Install one with \`${BRAND.cli} plugins install <folder>\`.\n`,
      );
    } else if (sub === "info") {
      const r = await g.call<{ plugin: PluginView }>("plugin.info", { id: need(c.p, 2, "plugin id") });
      show(c, r, () => describePlugin(r.plugin));
    } else if (sub === "install") {
      const given = need(c.p, 2, "plugin folder or name");
      // A bare name means the plugin of that name that ships with this program; use ./name for a folder here.
      const path = bundledPlugin(given) ?? resolve(given);
      const r = await g.call<{ plugin: PluginView }>("plugin.install", { path, replace: c.p.flags.replace === true });
      show(c, r, () => `Installed ${r.plugin.id}. Nothing has been run and it is not enabled.\n\n${describePlugin(r.plugin)}\nTo enable it: ${BRAND.cli} plugins enable ${r.plugin.id} --yes\n`);
    } else if (sub === "enable") {
      const id = need(c.p, 2, "plugin id");
      const { plugin } = await g.call<{ plugin: PluginView }>("plugin.info", { id });
      if (plugin.status === "invalid") throw new CliError("PLUGIN.INVALID", plugin.reason ?? "invalid plugin", "Fix the plugin or reinstall it.");
      const pinned = strFlag(c.p, "approval");
      if (c.p.flags.yes !== true && c.p.flags.y !== true) {
        c.io.out(describePlugin(plugin));
        throw new CliError("CONFIRM_REQUIRED", "enabling a plugin lets its code run on this computer", `Review the above, then run: ${BRAND.cli} plugins enable ${id} --yes`);
      }
      const r = await g.call<{ plugin: PluginView }>("plugin.enable", { id, approvalToken: pinned ?? plugin.approvalToken ?? "" });
      show(c, r, () => `Enabled ${id}: ${r.plugin.status}${r.plugin.reason ? ` - ${r.plugin.reason}` : ""}\n${r.plugin.tools.length ? `Tools: ${r.plugin.tools.join(", ")}\n` : ""}`);
      return r.plugin.status === "running" || r.plugin.status === "enabled" || r.plugin.status === "needs_config" ? 0 : 1;
    } else if (sub === "disable") {
      const r = await g.call<{ plugin: PluginView }>("plugin.disable", { id: need(c.p, 2, "plugin id") });
      show(c, r, () => `Disabled ${r.plugin.id}.\n`);
    } else if (sub === "remove") {
      const id = need(c.p, 2, "plugin id");
      const purge = c.p.flags["purge-data"] === true;
      const r = await g.call("plugin.remove", { id, purgeData: purge });
      show(c, r, () => `Removed ${id}.${purge ? "" : " Its data folder was kept; add --purge-data to delete it too."}\n`);
    } else if (sub === "config") {
      const id = need(c.p, 2, "plugin id");
      const action = c.p.positionals[3];
      const rest = c.p.positionals.slice(4);
      if (action === undefined) {
        const r = await g.call<{ settings: SettingsView }>("plugin.settings", { id });
        show(c, r, () => describeSettings(r.settings));
      } else if (action === "set" || action === "unset") {
        if (rest.length === 0) throw new CliError("USAGE", "plugins config " + id + " " + action + " needs " + (action === "set" ? "KEY=VALUE" : "a KEY"), "Run `plugins config ID` to see the settings.");
        const { settings } = await g.call<{ settings: SettingsView }>("plugin.settings", { id });
        const values: Record<string, string | number | boolean | null> = {};
        for (const item of rest) {
          if (action === "unset") {
            values[item] = null;
            continue;
          }
          const eq = item.indexOf("=");
          if (eq < 1) throw new CliError("USAGE", item + " is not KEY=VALUE", "For example: plugins config ID set mode=fast");
          const key = item.slice(0, eq);
          const raw = item.slice(eq + 1);
          const type = settings.settings.find((x) => x.name === key)?.type;
          if (type === "integer" || type === "number") {
            if (raw.trim() === "" || Number.isNaN(Number(raw))) throw new CliError("USAGE", key + " must be a number", "Give a number, such as 5.");
            values[key] = Number(raw);
          } else if (type === "boolean") {
            if (raw !== "true" && raw !== "false") throw new CliError("USAGE", key + " must be true or false", "Use true or false.");
            values[key] = raw === "true";
          } else values[key] = raw;
        }
        const r = await g.call<{ settings: SettingsView }>("plugin.config.set", { id, values });
        show(c, r, () => "Saved. A running plugin was restarted to use it.\n\n" + describeSettings(r.settings));
      } else throw new CliError("USAGE", "unknown plugins config command " + action, "Use set or unset.");
    } else if (sub === "secret") {
      const id = need(c.p, 2, "plugin id");
      const action = c.p.positionals[3];
      if (action === undefined) {
        const r = await g.call<{ settings: SettingsView }>("plugin.settings", { id });
        show(c, r, () => (r.settings.secrets.length ? r.settings.secrets.map((x) => x.name.padEnd(20) + " " + (x.set ? "set" : "NOT SET")).join("\n") : "This plugin declares no secrets.") + "\n");
      } else if (action === "set") {
        const name = need(c.p, 4, "secret name");
        if (!c.io.readSecret) throw new CliError("UNSUPPORTED", "this terminal cannot read a secret safely", "Pipe the value in on standard input.");
        const value = await c.io.readSecret("Value for " + id + " " + name + " (not shown): ");
        if (!value) throw new CliError("USAGE", "no value was given", "Type or pipe the secret.");
        const r = await g.call<{ settings: SettingsView }>("plugin.secret.set", { id, name, value });
        show(c, r, () => "Stored " + name + " for " + id + " in the encrypted vault. It is not shown again.\n" + (r.settings.missing.length ? "Still needed: " + r.settings.missing.join(", ") + "\n" : ""));
      } else if (action === "delete") {
        const name = need(c.p, 4, "secret name");
        const r = await g.call<{ settings: SettingsView }>("plugin.secret.delete", { id, name });
        show(c, r, () => "Deleted " + name + " for " + id + ".\n");
      } else throw new CliError("USAGE", "unknown plugins secret command " + action, "Use set or delete.");
    } else throw new CliError("USAGE", `unknown plugins command ${sub}`, "Use list, info, install, enable, disable, remove, config or secret.");
    return 0;
  });

/** The folder of a plugin that ships with this program, found by walking up from this file (installed or in the repository). */
export function bundledPlugin(name: string, from: string = dirname(fileURLToPath(import.meta.url))): string | undefined {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) return undefined;
  let dir = from;
  for (let i = 0; i < 4; i++) {
    const p = join(dir, "extensions", name);
    if (existsSync(join(p, "clawnexus.plugin.json"))) return p;
    dir = dirname(dir);
  }
  return undefined;
}

type MemScope ={ kind: "owner" } | { kind: "contact"; channel: string; contact: string };

/** `--contact telegram:12345` names one person on one channel; without it, the owner's own notes. */
function memoryScope(c: Context): MemScope {
  const raw = strFlag(c.p, "contact");
  if (raw === undefined) return { kind: "owner" };
  const i = raw.indexOf(":");
  if (i < 1 || i === raw.length - 1) throw new CliError("USAGE", `--contact needs CHANNEL:ID, got ${raw}`, "For example: --contact telegram:123456789");
  return { kind: "contact", channel: raw.slice(0, i), contact: raw.slice(i + 1) };
}
const scopeLabel = (s: MemScope): string => (s.kind === "owner" ? "your notes" : `notes about ${s.channel}:${s.contact}`);
/** A folder name that is safe on every system for an arbitrary id. */
const safeSegment = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);

const memory: Handler = async (c) => {
  if (c.p.positionals[1] === "path") {
    const dir = join(c.dataDir, "memory");
    show(c, { path: dir }, () => `${dir}\nThese are plain Markdown files. Edit them with any text editor; the Gateway reads them fresh each time.\n`);
    return 0;
  }
  return withClient(c, async (g) => {
    const sub = c.p.positionals[1] ?? "list";
    if (sub === "list") {
      const scope = memoryScope(c);
      const r = await g.call<{ files: Array<{ name: string; bytes: number; oversized?: boolean }> }>("memory.list", { scope });
      show(c, r, () => (r.files.length ? `${r.files.map((f) => `${f.name.padEnd(30)} ${String(f.bytes).padStart(7)} bytes${f.oversized ? "  (too large; only the start is used)" : ""}`).join("\n")}\n` : `No ${scopeLabel(scope)} yet.\n`));
    } else if (sub === "contacts") {
      const r = await g.call<{ scopes: Array<{ scope: MemScope; files: number; bytes: number }> }>("memory.scopes", {});
      show(c, r, () => (r.scopes.length ? `${r.scopes.map((s) => `${(s.scope.kind === "owner" ? "(you)" : `${s.scope.channel}:${s.scope.contact}`).padEnd(34)} ${String(s.files).padStart(3)} notes ${String(s.bytes).padStart(8)} bytes`).join("\n")}\n` : "No memory is kept yet.\n"));
    } else if (sub === "show") {
      const scope = memoryScope(c);
      const r = await g.call<{ note: { name: string; content: string; truncated: boolean } }>("memory.read", { scope, name: need(c.p, 2, "note name") });
      show(c, r, () => r.note.content);
    } else if (sub === "write") {
      const scope = memoryScope(c);
      const name = need(c.p, 2, "note name");
      const text = strFlag(c.p, "text");
      const file = strFlag(c.p, "file");
      if ((text === undefined) === (file === undefined)) throw new CliError("USAGE", "give the text with exactly one of --text or --file", "For example: memory write preferences --text \"Prefers short answers\" --append");
      let content = text ?? "";
      if (file !== undefined) {
        try {
          content = readFileSync(resolve(file), "utf8");
        } catch {
          throw new CliError("NO_FILE", `cannot read ${file}`, "Check the path.");
        }
      }
      const r = await g.call<{ note: { name: string; bytes: number } }>("memory.write", { scope, name, content, mode: c.p.flags["append"] === true ? "append" : "replace" });
      show(c, r, () => `Saved ${r.note.name} (${r.note.bytes} bytes) in ${scopeLabel(scope)}.\n`);
    } else if (sub === "delete") {
      const scope = memoryScope(c);
      const name = need(c.p, 2, "note name");
      await g.call("memory.delete", { scope, name });
      show(c, { deleted: name }, () => `Deleted ${name} from ${scopeLabel(scope)}.\n`);
    } else if (sub === "export") {
      const out = resolve(need(c.p, 2, "folder to write to"));
      if (existsSync(out) && readdirSync(out).length > 0) throw new CliError("EXISTS", `${out} is not empty`, "Choose a new or empty folder.");
      const all = await g.call<{ scopes: Array<{ scope: MemScope }> }>("memory.scopes", {});
      let written = 0;
      for (const { scope } of all.scopes) {
        const r = await g.call<{ files: Array<{ name: string; content: string }> }>("memory.export", { scope });
        const dir = scope.kind === "owner" ? join(out, "owner") : join(out, "contacts", safeSegment(scope.channel), safeSegment(scope.contact));
        mkdirSync(dir, { recursive: true });
        for (const f of r.files) {
          writeFileSync(join(dir, `${f.name}.md`), f.content);
          written++;
        }
      }
      show(c, { exported: written, to: out }, () => `Exported ${written} notes to ${out}.\n`);
    } else if (sub === "erase") {
      const all = c.p.flags["all"] === true;
      const owner = c.p.flags["owner"] === true;
      const contact = strFlag(c.p, "contact");
      if ([all, owner, contact !== undefined].filter(Boolean).length !== 1) throw new CliError("USAGE", "say what to erase with exactly one of --all, --owner or --contact CHANNEL:ID", "For example: memory erase --contact telegram:123456789 --yes");
      const scope: MemScope | "all" = all ? "all" : memoryScope(c);
      const label = scope === "all" ? "ALL notes (yours and every contact's)" : scopeLabel(scope);
      if (c.p.flags["yes"] !== true) throw new CliError("CONFIRM_REQUIRED", `this permanently deletes ${label}`, "Run it again with --yes. Consider `memory export` first.");
      const r = await g.call<{ files: number }>("memory.erase", { scope });
      show(c, r, () => `Erased ${r.files} notes (${label}), including the record of changes to them.\n`);
    } else throw new CliError("USAGE", `unknown memory command ${sub}`, "Use list, contacts, show, write, delete, export, erase or path.");
    return 0;
  });
};

/** `devices`: phones, tablets and other computers that sign in with their own key instead of the owner token. */
const devices: Handler = async (c) => {
  const sub = c.p.positionals[1] ?? "list";
  if (sub === "enroll") {
    // This computer becomes a device of a remote Gateway. It needs no token: the one-time code from the owner is the proof.
    const url = strFlag(c.p, "url");
    const code = strFlag(c.p, "code");
    if (!url || !code) throw new CliError("USAGE", "enroll needs --url and --code", `Ask the owner to run \`${BRAND.cli} devices pair\`, then: ${BRAND.cli} devices enroll --url wss://HOST:PORT/v1/ws --code CODE [--fingerprint HEX]`);
    const caFile = strFlag(c.p, "ca");
    let ca: string | undefined;
    if (caFile) {
      try {
        ca = readFileSync(resolve(caFile), "utf8");
      } catch {
        throw new CliError("NO_FILE", `cannot read ${caFile}`, "Check the path of the certificate file.");
      }
    }
    const pin = strFlag(c.p, "fingerprint")?.replace(/[:\s]/g, "").toLowerCase();
    if (existsSync(join(c.dataDir, DEVICE_FILE)) && c.p.flags["force"] !== true) {
      throw new CliError("ALREADY_ENROLLED", `this computer is already paired (${join(c.dataDir, DEVICE_FILE)})`, "Use --force to pair again; the old pairing stays valid on the Gateway until the owner revokes it.");
    }
    const key = generateDeviceKey();
    const name = strFlag(c.p, "name");
    const { device: d, client } = await GatewayClient.pair(url, { code, publicKey: key.publicKey, ...(name ? { name } : {}) }, { ...(pin ? { pin } : {}), ...(ca ? { ca } : {}) });
    client.close();
    mkdirSync(c.dataDir, { recursive: true, mode: 0o700 });
    const file: DeviceFile = { url, deviceId: d.id, privateKeyPem: key.privateKeyPem, ...(pin ? { fingerprint: pin } : {}), ...(ca ? { ca } : {}) };
    writeFileSync(join(c.dataDir, DEVICE_FILE), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    show(c, { device: d }, () => `Paired as ${d.id} ("${d.name}") with these permissions: ${d.scopes.join(", ")}.\nThe key is stored in ${join(c.dataDir, DEVICE_FILE)}; keep that file private. Commands here now talk to ${url}.\n`);
    return 0;
  }
  return withClient(c, async (g) => {
    if (sub === "pair") {
      const name = strFlag(c.p, "name");
      const scopesText = strFlag(c.p, "scopes");
      const scopes = scopesText ? scopesText.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      const r = await g.call<{ code: string; expiresAt: number; scopes: string[]; url: string; fingerprint?: string }>("device.pair.begin", { ...(name ? { name } : {}), ...(scopes ? { scopes } : {}) });
      const where = r.url.replace(/\/\/(127\.0\.0\.1|\[::1\])/, "//HOST");
      const mins = Math.max(1, Math.round((r.expiresAt - Date.now()) / 60_000));
      show(
        c,
        r,
        () =>
          `Pairing code: ${r.code}   (works once, for about ${mins} minutes)\nThe device will be allowed to: ${r.scopes.join(", ")}.\n\nOn the other computer run:\n  ${BRAND.cli} devices enroll --url ${where} --code ${r.code}${r.fingerprint ? ` --fingerprint ${r.fingerprint}` : ""}\n` +
          (where.includes("HOST") ? "Replace HOST with this computer's address as the other device sees it.\n" : "") +
          "A phone or tablet app takes the same code and address.\n",
      );
    } else if (sub === "list") {
      const r = await g.call<{ devices: Array<{ id: string; name: string; scopes: string[]; createdAt: number; lastSeenAt?: number; revokedAt?: number }>; pendingCodes: number }>("device.list", {});
      show(
        c,
        r,
        () =>
          (r.devices.length
            ? `${r.devices.map((d) => `${d.id}  ${d.revokedAt ? "revoked" : "active "}  ${d.name.padEnd(22)} ${d.scopes.join(",").padEnd(18)} ${d.lastSeenAt ? `last seen ${new Date(d.lastSeenAt).toISOString().slice(0, 16).replace("T", " ")}` : "never connected"}`).join("\n")}\n`
            : "No devices are paired. Pair one with `devices pair`.\n") + (r.pendingCodes ? `${r.pendingCodes} pairing code(s) waiting.\n` : ""),
      );
    } else if (sub === "revoke") {
      const r = await g.call<{ device: { id: string; name: string } }>("device.revoke", { id: need(c.p, 2, "device id") });
      show(c, r, () => `Revoked ${r.device.id} ("${r.device.name}"). It is disconnected now and cannot sign in again.\n`);
    } else throw new CliError("USAGE", `unknown devices command ${sub}`, "Use pair, list, revoke or enroll.");
    return 0;
  });
};

const HANDLERS: Record<string, Handler> = { status, chat, sessions, pairing, approvals, tool, plugins, channels, webchat, memory, devices };
export const CLIENT_COMMANDS = Object.keys(HANDLERS);

/** Print an error the way users should see it: code, cause, fix. No stack traces. */
export function reportError(io: Io, e: unknown, json: boolean): number {
  const err = e instanceof CliError ? e : new CliError("INTERNAL", e instanceof Error ? e.message : "unexpected error", `Run \`${BRAND.cli} doctor\`; if it persists, report it with the error text above.`);
  if (json) io.err(`${JSON.stringify({ error: { code: err.code, message: err.message, remediation: err.remediation } })}\n`);
  else io.err(`Error ${err.code}: ${err.message}\n  Fix: ${err.remediation}\n`);
  return err.code === "USAGE" ? 2 : 1;
}

/** Run a Gateway-client command. Returns the process exit code. */
export async function runCli(argv: readonly string[], io: Io = systemIo()): Promise<number> {
  const p = parseArgs(argv);
  const json = p.flags.json === true;
  if (p.flags.version === true || p.positionals[0] === "version") {
    io.out(`${versionLine()}\n`);
    return 0;
  }
  const cmd = p.positionals[0];
  if (cmd === undefined || cmd === "help" || p.flags.help === true || p.flags.h === true) {
    io.out(USAGE);
    return 0;
  }
  const handler = HANDLERS[cmd];
  if (!handler) return reportError(io, new CliError("USAGE", `unknown command ${cmd}`, `Run \`${BRAND.cli} --help\` for the list of commands.`), json);
  const dataDir = strFlag(p, "data-dir") ?? defaultDataDir({ platform: io.platform, env: io.env, home: io.home });
  try {
    return await handler({ p, io, json, dataDir });
  } catch (e) {
    return reportError(io, e, json);
  }
}
