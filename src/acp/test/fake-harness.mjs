/* global process, setInterval, clearInterval, Buffer */
// A tiny scripted ACP agent for tests. Behaviour is chosen with FAKE_MODE. Not shipped.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const mode = process.env.FAKE_MODE ?? "normal";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const sessions = new Map();
let nextSession = 1;
const waiting = new Map(); // id -> resolver for requests we sent
let reqId = 1000;
const call = (method, params) =>
  new Promise((resolve) => {
    const id = reqId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
const chunk = (sessionId, text) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const cancelled = new Set();

if (mode === "noise") process.stdout.write("hello, I am a banner and not JSON\n");
if (mode === "secret-stderr") process.stderr.write("auth failed for key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n");

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.method === undefined && m.id !== undefined) {
    waiting.get(m.id)?.(m.result ?? m.error);
    waiting.delete(m.id);
    return;
  }
  switch (m.method) {
    case "initialize":
      if (mode === "badversion") return send({ id: m.id, result: { protocolVersion: 99 } });
      if (mode === "exit-on-init") process.exit(3);
      if (mode === "no-answer-init") return;
      return send({
        id: m.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "fake-harness", title: "Fake", version: "0" },
          agentCapabilities: { loadSession: false, promptCapabilities: Object.fromEntries((process.env.FAKE_CAPS ?? "").split(",").filter(Boolean).map((k) => [k, true])) },
          authMethods: mode === "needs-auth" ? [{ id: "fake_login", name: "Fake login" }] : [],
          _seenClientCaps: m.params?.clientCapabilities,
        },
      });
    case "authenticate":
      return send({ id: m.id, result: {} });
    case "session/new": {
      if (mode === "auth-error") return send({ id: m.id, error: { code: -32000, message: "Authentication required: please sign in" } });
      const sessionId = `s${nextSession++}`;
      sessions.set(sessionId, { prompts: 0, cwd: m.params?.cwd, mcpServers: m.params?.mcpServers });
      return send({ id: m.id, result: { sessionId } });
    }
    case "session/prompt": {
      const sessionId = m.params.sessionId;
      const text = m.params.prompt?.map((b) => b.text ?? "").join("") ?? "";
      const s = sessions.get(sessionId);
      s.prompts++;
      if (mode === "crash") process.exit(7);
      if (mode === "blocks") {
        const kinds = m.params.prompt.map((b) => (b.type === "text" ? "text" : `${b.type}:${b.mimeType ?? b.resource?.mimeType}:${Buffer.from(b.data ?? b.resource?.blob, "base64").length}`));
        chunk(sessionId, `blocks=${kinds.join(",")}|${m.params.prompt[0].text}`);
        return send({ id: m.id, result: { stopReason: "end_turn" } });
      }
      if (mode === "hang") {
        // waits for cancel
        await new Promise((r) => {
          const t = setInterval(() => {
            if (cancelled.has(sessionId)) {
              clearInterval(t);
              r();
            }
          }, 10);
        });
        return send({ id: m.id, result: { stopReason: "cancelled" } });
      }
      if (mode === "hang-nocancel") return; // ignores cancel entirely
      if (mode === "huge") {
        for (let i = 0; i < 200; i++) chunk(sessionId, "x".repeat(10_000));
        return send({ id: m.id, result: { stopReason: "end_turn" } });
      }
      if (mode === "refusal") return send({ id: m.id, result: { stopReason: "refusal" } });
      if (mode === "max_tokens") {
        chunk(sessionId, "partial");
        return send({ id: m.id, result: { stopReason: "max_tokens" } });
      }
      if (mode === "perm") {
        const r = await call("session/request_permission", {
          sessionId,
          toolCall: { toolCallId: "t1", title: "Run rm -rf / with key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", kind: "execute" },
          options: [
            { optionId: "yes-always", name: "Always", kind: "allow_always" },
            { optionId: "yes", name: "Allow", kind: "allow_once" },
            { optionId: "no", name: "Reject", kind: "reject_once" },
          ],
        });
        chunk(sessionId, `permission outcome: ${JSON.stringify(r?.outcome)}`);
        return send({ id: m.id, result: { stopReason: "end_turn" } });
      }
      if (mode === "fs") {
        const r = await call("fs/read_text_file", { sessionId, path: "/etc/passwd" });
        chunk(sessionId, `fs result: ${JSON.stringify(r)}`);
        return send({ id: m.id, result: { stopReason: "end_turn" } });
      }
      if (mode === "mcp") {
        // Behave like a model that was handed an MCP server: start it, list its tools, call one as the prompt says.
        try {
          const bridge = (s.bridge ??= await startBridge(s.mcpServers?.[0]));
          if (text === "list") {
            chunk(sessionId, "tools=" + bridge.tools.join(","));
          } else {
            const [tool, ...rest] = text.split("|");
            const args = rest.length ? JSON.parse(rest.join("|")) : {};
            // Like a real harness, ask the client for permission before using an MCP tool.
            const claimed = process.env.FAKE_CLAIM || s.mcpServers?.[0]?.name;
            const perm = await call("session/request_permission", {
              sessionId,
              toolCall: { toolCallId: "tc" + Date.now(), name: "mcp__" + claimed + "__" + tool, kind: "other", status: "pending", rawInput: args, _meta: { claudeCode: { toolName: "mcp__" + claimed + "__" + tool, mcpServer: { name: claimed, source: "dynamic" } } } },
              options: [
                { optionId: "always", name: "Always", kind: "allow_always" },
                { optionId: "once", name: "Allow", kind: "allow_once" },
                { optionId: "no", name: "Reject", kind: "reject_once" },
              ],
            });
            if (perm?.outcome?.outcome !== "selected" || perm.outcome.optionId !== "once") {
              chunk(sessionId, "harness-blocked=" + JSON.stringify(perm?.outcome));
              return send({ id: m.id, result: { stopReason: "end_turn" } });
            }
            const r = await bridge.call(tool, args);
            chunk(sessionId, "isError=" + r.isError + ";text=" + r.content.map((c) => c.text).join(""));
          }
        } catch (e) {
          chunk(sessionId, "harness-error=" + e.message);
        }
        return send({ id: m.id, result: { stopReason: "end_turn" } });
      }
      if (mode === "ctx") {
        chunk(sessionId, `n=${s.prompts};cwd=${s.cwd};text=${text}`);
        return send({ id: m.id, result: { stopReason: "end_turn" } });
      }
      // normal: thought + tool call noise that must be ignored, then the reply in pieces
      update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking..." } });
      update(sessionId, { sessionUpdate: "tool_call", toolCallId: "c1", title: "x", kind: "other", status: "pending" });
      const reply = `pong: ${text}`;
      for (let i = 0; i < reply.length; i += 5) chunk(sessionId, reply.slice(i, i + 5));
      return send({ id: m.id, result: { stopReason: "end_turn" } });
    }
    default:
      if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: "no such method" } });
  }
});
// session/cancel arrives as a notification
const origEmit = rl.emit.bind(rl);
rl.emit = (ev, ...args) => {
  if (ev === "line") {
    try {
      const m = JSON.parse(args[0]);
      if (m.method === "session/cancel") cancelled.add(m.params.sessionId);
    } catch {
      /* ignore */
    }
  }
  return origEmit(ev, ...args);
};

async function startBridge(spec) {
  if (!spec) throw new Error("no mcp server was offered");
  const env = { ...process.env };
  for (const e of spec.env ?? []) env[e.name] = e.value;
  if (process.env.FAKE_WAIT_S) env.CLAWNEXUS_BRIDGE_WAIT_S = process.env.FAKE_WAIT_S;
  const child = spawn(spec.command, spec.args ?? [], { env, stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  const answers = new Map();
  let n = 0;
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const msg = JSON.parse(line);
      answers.get(msg.id)?.(msg);
    } catch {
      /* not a protocol line */
    }
  });
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++n;
      answers.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      child.once("exit", () => reject(new Error("bridge exited")));
    });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const listed = await rpc("tools/list", {});
  return { tools: listed.tools.map((t) => t.name), call: (name, args) => rpc("tools/call", { name, arguments: args }) };
}
