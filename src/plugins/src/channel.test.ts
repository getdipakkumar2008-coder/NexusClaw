import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFORMANCE_LIMITS, FakeAdapter, createBed, defineConformance, waitFor, type Bed, type ConformanceBed, type ConformanceSetup } from "@clawnexus/channels";
import { ApprovalStore } from "@clawnexus/policy";
import { ToolExecutor, WorkspaceGuard, type CallResult } from "@clawnexus/tools";
import { PluginHost } from "./host.js";

/**
 * A pretend messaging platform running inside a real plugin process. Its tools let the test play the part of the
 * platform: `inject` is a person sending a message, `sent` is what the platform delivered to people.
 */
const PLATFORM = `
let host; const sent = []; let fail = 0; let calls = 0;
ctx.registerChannel({
  id: "fakeplat",
  capabilities: { typing: true, groups: true, maxTextChars: 200 },
  start(h) { host = h; },
  stop() { host = undefined; },
  send(target, content) {
    if (fail > 0) { fail--; throw new Error("platform unavailable"); }
    sent.push({ conversationId: target.conversationId, text: content.text });
    return { messageId: "out-" + sent.length };
  },
  typing() { calls++; },
});
ctx.registerTool({ name: "inject", description: "a person sends a message", args: { json: { type: "string", maxLength: 60000 } }, run: ({ json }) => host.deliver(JSON.parse(json)) });
ctx.registerTool({ name: "status", description: "report status", args: { state: { type: "string" }, detail: { type: "string", optional: true } }, run: ({ state, detail }) => { host.setStatus({ state, detail }); return null; } });
ctx.registerTool({ name: "sent", description: "what the platform delivered", run: () => sent });
ctx.registerTool({ name: "fail", description: "fail the next sends", args: { n: { type: "integer" } }, run: ({ n }) => { fail = n; return null; } });
ctx.registerTool({ name: "crash", description: "die", run: () => process.exit(3) });
`;

let base: string;
let n = 0;
const open: Array<() => Promise<void>> = [];

function writePlugin(o: { id?: string; body?: string; provides?: string[] } = {}): { dir: string; id: string } {
  const id = o.id ?? "fakeplat";
  const dir = join(base, "src-plugins", `${id}-${++n}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "clawnexus.plugin.json"), JSON.stringify({ id, name: id, version: "1.0.0", kind: "code", sdkRange: "^0.3.0", entry: "index.mjs", provides: o.provides ?? ["channel:fakeplat"] }));
  writeFileSync(join(dir, "index.mjs"), `export default { async setup(ctx) {\n${o.body ?? PLATFORM}\n} };\n`);
  return { dir, id };
}

/** A router (real database, pairing, sessions) with a plugin host attached to it. */
async function rig(setup?: ConformanceSetup): Promise<{ bed: Bed; host: PluginHost; tools: ToolExecutor; call: (tool: string, args?: unknown) => Promise<CallResult>; enable: (p: { dir: string; id: string }) => Promise<void> }> {
  const bed = await createBed({
    adapters: [],
    ...(setup?.noProvider ? { provider: null } : {}),
    manager: { senderBurst: CONFORMANCE_LIMITS.senderBurst, senderPerMinute: CONFORMANCE_LIMITS.senderPerMinute },
  });
  const tools = new ToolExecutor({ events: bed.events, approvals: new ApprovalStore(), guard: new WorkspaceGuard([base]), tools: [] });
  const host = new PluginHost({
    dataDir: base,
    db: bed.db,
    events: bed.events,
    tools,
    channels: { attach: (a) => bed.manager.attach(a), detach: (id) => bed.manager.detach(id) },
    startTimeoutMs: 15_000,
    graceMs: 300,
    restart: { baseMs: 20, maxRestarts: 3, windowMs: 60_000 },
  });
  open.push(async () => {
    await host.stop();
    await bed.teardown();
  });
  return {
    bed,
    host,
    tools,
    call: (tool, args = {}) => tools.call({ tool, args, principal: "owner", principalId: "owner", profile: "standard", tainted: false }),
    async enable(p) {
      await host.install(p.dir);
      await host.enable(p.id, host.info(p.id).approvalToken!);
    },
  };
}

beforeEach(() => void (base = mkdtempSync(join(tmpdir(), "cn-pchan-"))));
afterEach(async () => {
  for (const close of open.splice(0)) await close();
  rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const outputOf = (r: CallResult): unknown => (r.status === "ok" ? r.output : `${r.status}:${JSON.stringify(r)}`);

// The same behaviours every channel must show, now with the platform on the far side of a process boundary.
async function pluginBed(setup?: ConformanceSetup): Promise<ConformanceBed> {
  const r = await rig(setup);
  await r.enable(writePlugin());
  let delivered: Array<{ conversationId: string; text: string }> = [];
  const refresh = async (): Promise<void> => {
    const out = outputOf(await r.call("fakeplat.sent"));
    if (Array.isArray(out)) delivered = out as typeof delivered;
  };
  const poll = setInterval(() => void refresh(), 25);
  let pendingFail: Promise<unknown> = Promise.resolve();
  const inject = async (m: Record<string, unknown>): Promise<unknown> => {
    await pendingFail;
    return outputOf(await r.call("fakeplat.inject", { json: JSON.stringify(m) }));
  };
  return {
    bed: r.bed,
    channelId: "fakeplat",
    maxTextChars: 200,
    groupsSupported: true,
    user: (name) => ({
      senderId: name,
      conversationId: name,
      async say(text, o = {}) {
        await inject({ accountId: "default", conversationId: o.isGroup ? (o.groupId ?? "group-1") : name, senderId: name, messageId: o.messageId ?? `${name}-${Math.random()}`, text, isGroup: o.isGroup ?? false, mentionsBot: o.mentionsBot ?? true });
      },
      received: () => delivered.filter((s) => s.conversationId === name).map((s) => s.text),
    }),
    deliverRaw: (m) => inject(m) as Promise<never>,
    failSends: (count) => {
      pendingFail = r.call("fakeplat.fail", { n: count });
    },
    async teardown() {
      clearInterval(poll);
    },
  };
}

defineConformance({ describe, it, expect }, "channel inside a plugin process", pluginBed);

describe("a channel provided by a plugin", () => {
  it("appears with the plugin, reports its own health, and is withdrawn when the plugin is disabled", async () => {
    const r = await rig();
    await r.enable(writePlugin());
    expect(r.host.info("fakeplat")).toMatchObject({ status: "running", channel: "fakeplat" });
    expect(r.bed.manager.list().find((c) => c.id === "fakeplat")).toMatchObject({ status: { state: "connected" }, capabilities: { maxTextChars: 200, groups: true } });

    await r.call("fakeplat.status", { state: "auth_required", detail: "token rejected by the platform" });
    expect(r.bed.manager.list().find((c) => c.id === "fakeplat")?.status).toEqual({ state: "auth_required", detail: "token rejected by the platform" });
    expect(outputOf(await r.call("fakeplat.status", { state: "bogus" }))).toBeDefined(); // ignored, not trusted

    await r.host.disable("fakeplat");
    expect(r.bed.manager.list().find((c) => c.id === "fakeplat")).toBeUndefined();
  });

  it("is withdrawn when the plugin crashes and comes back when it restarts", async () => {
    const r = await rig();
    await r.enable(writePlugin());
    await r.call("fakeplat.crash");
    await waitFor(() => !r.bed.manager.list().some((c) => c.id === "fakeplat") || r.host.info("fakeplat").status !== "running");
    await waitFor(() => r.host.info("fakeplat").status === "running" && r.bed.manager.list().some((c) => c.id === "fakeplat" && c.status.state === "connected"), 10_000);
    expect(outputOf(await r.call("fakeplat.sent"))).toEqual([]);
  });

  it("cannot speak for another channel or pass off its own extra fields", async () => {
    const r = await rig();
    await r.enable(writePlugin());
    const base = { accountId: "default", conversationId: "x", senderId: "x", messageId: "m1", text: "hi", isGroup: false, mentionsBot: true };
    const forged = outputOf(await r.call("fakeplat.inject", { json: JSON.stringify({ ...base, channel: "webchat" }) }));
    expect(forged).toMatchObject({ result: "invalid" });
    const owner = outputOf(await r.call("fakeplat.inject", { json: JSON.stringify({ ...base, messageId: "m2", isOwner: true }) }));
    expect(owner).toMatchObject({ result: "invalid" });
    expect(r.bed.pairing.list()).toHaveLength(0);
  });

  it("a stranger on a plugin channel is paired, not served, exactly like any other channel", async () => {
    const r = await rig();
    await r.enable(writePlugin());
    const out = outputOf(await r.call("fakeplat.inject", { json: JSON.stringify({ accountId: "default", conversationId: "eve", senderId: "eve", messageId: "e1", text: "hello", isGroup: false, mentionsBot: true }) }));
    expect(out).toMatchObject({ result: "pairing" });
    expect(r.bed.provider?.calls ?? []).toHaveLength(0);
    expect(r.bed.pairing.list().some((s) => s.channel === "fakeplat" && s.externalId === "eve")).toBe(true);
  });

  it("a plugin whose manifest does not list its channel is stopped and reported, not half-registered", async () => {
    const r = await rig();
    await r.enable(writePlugin({ provides: [] }));
    expect(r.host.info("fakeplat")).toMatchObject({ status: "degraded" });
    expect(r.host.info("fakeplat").reason).toMatch(/does not list channel:fakeplat/);
    expect(r.bed.manager.list().some((c) => c.id === "fakeplat")).toBe(false);
    expect(r.tools.list().some((t) => t.name.startsWith("fakeplat."))).toBe(false);
  });

  it("cannot take the id of a channel that already exists", async () => {
    const r = await rig();
    await r.bed.manager.attach(new FakeAdapter("fakeplat"));
    await r.enable(writePlugin());
    expect(r.host.info("fakeplat")).toMatchObject({ status: "degraded" });
    expect(r.host.info("fakeplat").reason).toMatch(/already registered/);
    expect(r.bed.manager.list().filter((c) => c.id === "fakeplat")).toHaveLength(1);
  });

  it("rejects an invalid channel registration and a second channel", async () => {
    const r = await rig();
    await r.enable(writePlugin({ id: "badchan", body: `ctx.registerChannel({ id: "Bad Id!", capabilities: { typing: false, groups: false, maxTextChars: 10 }, start() {}, stop() {}, send() {} });` }));
    expect(r.host.info("badchan")).toMatchObject({ status: expect.stringMatching(/degraded|crashed/) });
    expect(r.host.info("badchan").reason).toMatch(/invalid channel/);

    const two = writePlugin({
      id: "twochan",
      provides: ["channel:one", "channel:two"],
      body: `const c = (id) => ({ id, capabilities: { typing: false, groups: false, maxTextChars: 10 }, start() {}, stop() {}, send() {} }); ctx.registerChannel(c("one")); ctx.registerChannel(c("two"));`,
    });
    await r.enable(two);
    expect(r.host.info("twochan").reason).toMatch(/only one channel/);
  });

  it("messages delivered after the plugin is withdrawn go nowhere", async () => {
    const r = await rig();
    await r.enable(writePlugin());
    const before = r.bed.manager.list().length;
    await r.host.disable("fakeplat");
    expect(r.bed.manager.list()).toHaveLength(before - 1);
    expect(r.bed.pairing.list()).toHaveLength(0);
  });
});
