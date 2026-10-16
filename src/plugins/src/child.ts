/**
 * Runs INSIDE the plugin's own process, under Node's permission model (see process.ts for the flags).
 * Deliberately self-contained: it may import only node: built-ins, because the process can read nothing but this
 * file and the plugin's folder. Everything it receives from the host is data; everything it sends is validated again
 * on the other side.
 */
import { pathToFileURL } from "node:url";

interface Registered {
  name: string;
  description: string;
  risk?: number;
  args?: Record<string, unknown>;
  timeoutMs?: number;
  run(args: Record<string, unknown>, call: { signal: AbortSignal }): unknown;
}
interface PluginModule {
  setup(ctx: unknown): unknown;
  dispose?(): unknown;
}

const send = (m: object): void => void process.send?.(m);
interface ChannelDef {
  id: string;
  capabilities: unknown;
  start(host: unknown): unknown;
  stop(): unknown;
  send(target: unknown, content: unknown): unknown;
  typing?(target: unknown, on: boolean): unknown;
}
const tools = new Map<string, Registered>();
let channel: ChannelDef | undefined;
const awaitingDeliver = new Map<number, (outcome: unknown) => void>();
let nextDeliver = 1;
const channelHost = {
  deliver: (message: unknown): Promise<unknown> =>
    new Promise((resolve) => {
      const rid = nextDeliver++;
      awaitingDeliver.set(rid, resolve);
      send({ t: "deliver", rid, message });
    }),
  setStatus: (status: unknown): void => send({ t: "chstatus", status }),
};
const running = new Map<number, AbortController>();
let def: PluginModule | undefined;
let sealed = false;
let pluginId = "";

const fail = (message: string): never => {
  send({ t: "fatal", message: message.slice(0, 500) });
  process.exit(1);
};

async function init(m: { pluginId: string; entry: string; dataDir?: string; config?: Record<string, string | number | boolean>; secrets?: Record<string, string> }): Promise<void> {
  pluginId = m.pluginId;
  let mod: { default?: PluginModule; plugin?: PluginModule };
  try {
    mod = (await import(pathToFileURL(m.entry).href)) as typeof mod;
  } catch (e) {
    return fail(`could not load the plugin: ${e instanceof Error ? e.message : String(e)}`);
  }
  const candidate = mod.default ?? mod.plugin;
  if (!candidate || typeof candidate.setup !== "function") return fail("the plugin must export a default object with a setup(ctx) function");
  def = candidate;
  const secrets = new Map(Object.entries(m.secrets ?? {}));
  const ctx = {
    pluginId,
    dataDir: m.dataDir,
    config: Object.freeze({ ...(m.config ?? {}) }),
    secrets: Object.freeze({ get: (name: string): string | undefined => secrets.get(String(name)) }),
    log(level: string, message: string, fields?: unknown): void {
      send({ t: "log", level, message: String(message).slice(0, 2000), fields });
    },
    registerChannel(c: ChannelDef): void {
      if (sealed) throw new Error("the channel can only be registered during setup");
      if (channel) throw new Error("a plugin can register only one channel");
      if (!c || typeof c.id !== "string" || typeof c.start !== "function" || typeof c.stop !== "function" || typeof c.send !== "function") throw new Error("registerChannel needs an id and start, stop and send functions");
      channel = c;
    },
    registerTool(t: Registered): void {
      if (sealed) throw new Error("tools can only be registered during setup");
      if (!t || typeof t.name !== "string" || typeof t.run !== "function") throw new Error("registerTool needs a name and a run function");
      if (tools.has(t.name)) throw new Error(`tool ${t.name} is registered twice`);
      tools.set(t.name, t);
    },
  };
  try {
    await candidate.setup(ctx);
  } catch (e) {
    return fail(`setup failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  sealed = true;
  send({
    t: "ready",
    channel: channel ? { id: channel.id, capabilities: channel.capabilities } : undefined,
    tools: [...tools.values()].map((x) => ({ name: x.name, description: x.description, risk: x.risk, args: x.args, timeoutMs: x.timeoutMs })),
  });
}

/** Calls from the Gateway to this plugin's channel. The `channel:` prefix cannot clash with a tool name. */
async function channelCall(op: string, args: Record<string, unknown>): Promise<unknown> {
  if (!channel) throw new Error("this plugin has no channel");
  switch (op) {
    case "start":
      await channel.start(channelHost);
      return null;
    case "stop":
      await channel.stop();
      return null;
    case "send": {
      const r = (await channel.send(args["target"], args["content"])) as { messageId?: unknown } | undefined | void;
      return { messageId: r && typeof r.messageId === "string" ? r.messageId.slice(0, 256) : undefined };
    }
    case "typing":
      await channel.typing?.(args["target"], args["on"] === true);
      return null;
    default:
      throw new Error(`unknown channel operation ${op}`);
  }
}

async function call(m: { id: number; tool: string; args: Record<string, unknown> }): Promise<void> {
  if (m.tool.startsWith("channel:")) {
    try {
      const value = await channelCall(m.tool.slice(8), m.args);
      send({ t: "result", id: m.id, ok: true, value: JSON.parse(JSON.stringify(value ?? null)) });
    } catch (e) {
      send({ t: "result", id: m.id, ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 500) });
    }
    return;
  }
  const t = tools.get(m.tool);
  if (!t) return send({ t: "result", id: m.id, ok: false, error: `no such tool ${m.tool}` });
  const ac = new AbortController();
  running.set(m.id, ac);
  try {
    const value = await t.run(m.args, { signal: ac.signal });
    const text = JSON.stringify(value ?? null);
    if (text === undefined) throw new Error("the result is not JSON-serialisable");
    send({ t: "result", id: m.id, ok: true, value: JSON.parse(text) });
  } catch (e) {
    send({ t: "result", id: m.id, ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 500) });
  } finally {
    running.delete(m.id);
  }
}

process.on("message", (m: { t?: string } & Record<string, unknown>) => {
  switch (m.t) {
    case "init":
      void init(m as never);
      break;
    case "call":
      void call(m as never);
      break;
    case "deliverResult": {
      const done = awaitingDeliver.get(m["rid"] as number);
      awaitingDeliver.delete(m["rid"] as number);
      done?.(m["outcome"]);
      break;
    }
    case "cancel":
      running.get(m["id"] as number)?.abort();
      break;
    case "dispose":
      void Promise.resolve(def?.dispose?.()).finally(() => process.exit(0));
      break;
  }
});
// The host owns our lifetime: if it goes away, so do we.
process.on("disconnect", () => process.exit(0));
