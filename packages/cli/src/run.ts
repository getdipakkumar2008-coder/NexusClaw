import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BRAND } from "@clawnexus/brand";
import { PROTOCOL_VERSION } from "@clawnexus/protocol";
import { parseArgs, strFlag, type Parsed } from "./args.js";
import { CliError, GatewayClient } from "./client.js";
import { DEFAULT_PORT, TOKEN_FILE, defaultDataDir } from "./paths.js";

export interface Io {
  out(text: string): void;
  err(text: string): void;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  home: string;
}

export function systemIo(): Io {
  return {
    out: (s) => void process.stdout.write(s),
    err: (s) => void process.stderr.write(s),
    env: process.env,
    platform: process.platform,
    home: homedir(),
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
  plugins list|info|install|enable|disable|remove [ID | PATH]  [--yes] [--replace] [--purge-data]

Options
  --json            machine-readable output
  --url URL         Gateway WebSocket URL (default ws://127.0.0.1:${DEFAULT_PORT}/v1/ws)
  --port N          shorthand for the port on 127.0.0.1
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

function resolveToken(c: Context): string {
  const flag = strFlag(c.p, "token");
  if (flag) return flag;
  const env = c.io.env[`${BRAND.envPrefix}TOKEN`];
  if (env) return env;
  const path = join(c.dataDir, TOKEN_FILE);
  try {
    const t = readFileSync(path, "utf8").trim();
    if (t) return t;
  } catch {
    /* handled below */
  }
  throw new CliError(
    "NO_TOKEN",
    `no Gateway token found at ${path}`,
    `Run \`${BRAND.cli} setup\` (or start the Gateway) on this machine, or set ${BRAND.envPrefix}TOKEN for a remote Gateway.`,
  );
}

function resolveUrl(c: Context): string {
  const url = strFlag(c.p, "url");
  if (url) return url;
  const port = strFlag(c.p, "port") ?? c.io.env[`${BRAND.envPrefix}PORT`] ?? String(DEFAULT_PORT);
  if (!/^\d{1,5}$/.test(port)) throw new CliError("USAGE", `invalid port ${port}`, "Use a number between 1 and 65535.");
  return `ws://127.0.0.1:${port}/v1/ws`;
}

async function withClient<T>(c: Context, fn: (g: GatewayClient) => Promise<T>): Promise<T> {
  const g = await GatewayClient.connect(resolveUrl(c), resolveToken(c));
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
  problems?: string[];
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
      `    secrets:  ${perm.secrets.length ? `${perm.secrets.join(", ")} - not available yet; none will be given` : "none"}`,
      `  its tools are never rated below risk class R${p.riskFloor ?? 0}, and their output is treated as untrusted`,
    );
  }
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
      const path = resolve(need(c.p, 2, "plugin folder"));
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
      return r.plugin.status === "running" || r.plugin.status === "enabled" ? 0 : 1;
    } else if (sub === "disable") {
      const r = await g.call<{ plugin: PluginView }>("plugin.disable", { id: need(c.p, 2, "plugin id") });
      show(c, r, () => `Disabled ${r.plugin.id}.\n`);
    } else if (sub === "remove") {
      const id = need(c.p, 2, "plugin id");
      const purge = c.p.flags["purge-data"] === true;
      const r = await g.call("plugin.remove", { id, purgeData: purge });
      show(c, r, () => `Removed ${id}.${purge ? "" : " Its data folder was kept; add --purge-data to delete it too."}\n`);
    } else throw new CliError("USAGE", `unknown plugins command ${sub}`, "Use list, info, install, enable, disable or remove.");
    return 0;
  });

const HANDLERS: Record<string, Handler> = { status, chat, sessions, pairing, approvals, tool, plugins, channels, webchat };
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
