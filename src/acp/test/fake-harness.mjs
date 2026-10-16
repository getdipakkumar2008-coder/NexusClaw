/* global process, setInterval, clearInterval */
// A tiny scripted ACP agent for tests. Behaviour is chosen with FAKE_MODE. Not shipped.
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
          agentCapabilities: { loadSession: false },
          authMethods: mode === "needs-auth" ? [{ id: "fake_login", name: "Fake login" }] : [],
          _seenClientCaps: m.params?.clientCapabilities,
        },
      });
    case "authenticate":
      return send({ id: m.id, result: {} });
    case "session/new": {
      if (mode === "auth-error") return send({ id: m.id, error: { code: -32000, message: "Authentication required: please sign in" } });
      const sessionId = `s${nextSession++}`;
      sessions.set(sessionId, { prompts: 0, cwd: m.params?.cwd });
      return send({ id: m.id, result: { sessionId } });
    }
    case "session/prompt": {
      const sessionId = m.params.sessionId;
      const text = m.params.prompt?.map((b) => b.text ?? "").join("") ?? "";
      const s = sessions.get(sessionId);
      s.prompts++;
      if (mode === "crash") process.exit(7);
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
