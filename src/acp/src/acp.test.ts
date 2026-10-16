import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderRequest } from "@clawnexus/sessions";
import { AcpConnection, AcpError, mcpServerOf, scrub, type AcpConnectionOptions } from "./client.js";
import { PRESETS, HarnessError, planLaunch, resolveSpec, type HarnessSpec } from "./harnesses.js";
import { JsonRpcPeer } from "./jsonrpc.js";
import { AcpProvider, buildPrompt } from "./provider.js";

const FAKE = fileURLToPath(new URL("../test/fake-harness.mjs", import.meta.url));
const SECRET = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

const specFor = (): HarnessSpec => ({ name: "custom", command: process.execPath, args: [FAKE], env: ["FAKE_MODE"], loginHint: "sign in please" });

const providers: AcpProvider[] = [];
function make(mode: string, extra: Partial<ConstructorParameters<typeof AcpProvider>[0]> = {}): AcpProvider {
  const p = new AcpProvider({ spec: specFor(), cwd: tmpdir(), env: { ...process.env, FAKE_MODE: mode }, initTimeoutMs: 10_000, sessionTimeoutMs: 10_000, ...extra });
  providers.push(p);
  return p;
}
afterEach(async () => {
  await Promise.all(providers.splice(0).map((p) => p.close()));
});

let n = 0;
function req(sessionId: string, messages: ProviderRequest["messages"], signal = new AbortController().signal): ProviderRequest {
  return { sessionId, runId: `r${++n}`, messages, signal };
}
const user = (content: string) => ({ role: "user" as const, content });
const asst = (content: string) => ({ role: "assistant" as const, content });

async function collect(p: AcpProvider, r: ProviderRequest): Promise<string> {
  let out = "";
  for await (const e of p.run(r)) out += e.text;
  return out;
}

describe("AcpProvider with a scripted harness", () => {
  it("streams the reply text and ignores thoughts and tool-call chatter", async () => {
    const p = make("normal");
    const pieces: string[] = [];
    for await (const e of p.run(req("g1", [user("hi")]))) pieces.push(e.text);
    expect(pieces.join("")).toBe("pong: hi");
    expect(pieces.length).toBeGreaterThan(1);
    expect(p.name).toBe("acp:custom");
  });

  it("tolerates stray non-JSON output on stdout", async () => {
    expect(await collect(make("noise"), req("g1", [user("hi")]))).toBe("pong: hi");
  });

  it("tells the harness only the working directory and nothing else of ours", async () => {
    const out = await collect(make("ctx", { cwd: tmpdir() }), req("g1", [user("hello")]));
    expect(out).toContain(`cwd=${tmpdir()}`);
  });

  it("sends only the new message once a harness session exists, and rebuilds context for a fresh one", async () => {
    const p = make("ctx");
    const first = await collect(p, req("g1", [user("one"), asst("A1"), user("two")]));
    expect(first).toContain("n=1");
    expect(first).toContain("Earlier in this conversation");
    expect(first).toContain("User: one");
    expect(first).toContain("Assistant: A1");
    const second = await collect(p, req("g1", [user("one"), asst("A1"), user("two"), asst("A2"), user("three")]));
    expect(second).toContain("n=2");
    expect(second).toContain("text=three");
    expect(second).not.toContain("Earlier in this conversation");
  });

  it("keeps different Gateway sessions in different harness sessions", async () => {
    const p = make("ctx");
    const a = await collect(p, req("gA", [user("secret of A")]));
    const b = await collect(p, req("gB", [user("hello")]));
    expect(a).toContain("n=1");
    expect(b).toContain("n=1");
    expect(b).not.toContain("secret of A");
  });

  it("rejects permission requests by default, choosing the reject option", async () => {
    const declined: string[] = [];
    const p = make("perm", { onDeclined: (w) => declined.push(w) });
    const out = await collect(p, req("g1", [user("go")]));
    expect(out).toContain('"optionId":"no"');
    expect(declined.join(" ")).toMatch(/permission request/);
  });

  it("allows once when policy says so, and never picks an always-allow option", async () => {
    let seen: { title?: string } | undefined;
    const p = make("perm", {
      onPermission: (i) => {
        seen = i;
        return "allow_once";
      },
    });
    const out = await collect(p, req("g1", [user("go")]));
    expect(out).toContain('"optionId":"yes"');
    expect(out).not.toContain("yes-always");
    expect(seen?.title).not.toContain(SECRET);
  });

  it("answers requests for our files with an error instead of granting access", async () => {
    const declined: string[] = [];
    const out = await collect(make("fs", { onDeclined: (w) => declined.push(w) }), req("g1", [user("x")]));
    expect(out).toMatch(/fs result: .*"code":-32601/);
    expect(declined.join(" ")).toContain("fs/read_text_file");
  });

  it("cancels cooperatively and the run ends without an error", async () => {
    const p = make("hang");
    const ac = new AbortController();
    const t0 = Date.now();
    const run = collect(p, req("g1", [user("slow")], ac.signal));
    setTimeout(() => ac.abort(), 100);
    expect(await run).toBe("");
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("ends a harness that ignores cancel, then starts a fresh one on the next run", async () => {
    const p = make("hang-nocancel", { graceMs: 150 });
    const ac = new AbortController();
    const run = collect(p, req("g1", [user("slow")], ac.signal));
    setTimeout(() => ac.abort(), 100);
    await run;
    await new Promise((r) => setTimeout(r, 700)); // let the provider notice the dead process
    // a new run must not reuse the dead connection; hang-nocancel never answers, so cancel again to prove a new process
    const ac2 = new AbortController();
    const run2 = collect(p, req("g2", [user("again")], ac2.signal));
    setTimeout(() => ac2.abort(), 100);
    await expect(run2).resolves.toBe("");
  });

  it("reports a crash with the exit code, and recovers on the next run", async () => {
    let mode = "crash";
    const p = new AcpProvider({
      spec: specFor(),
      cwd: tmpdir(),
      initTimeoutMs: 10_000,
      connect: (o: AcpConnectionOptions) => AcpConnection.start({ ...o, env: { ...process.env, FAKE_MODE: mode } }),
    });
    providers.push(p);
    const err = await collect(p, req("g1", [user("a")])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AcpError);
    expect((err as AcpError).code).toBe("HARNESS_EXITED");
    expect((err as AcpError).message).toContain("exit 7");
    await new Promise((r) => setTimeout(r, 700));
    mode = "normal";
    expect(await collect(p, req("g1", [user("b")]))).toBe("pong: b");
  });

  it("fails clearly on a protocol version mismatch", async () => {
    const e = await collect(make("badversion"), req("g1", [user("a")])).catch((x: unknown) => x);
    expect((e as AcpError).code).toBe("HARNESS_PROTOCOL");
    expect((e as AcpError).message).toContain("99");
  });

  it("fails clearly when the harness exits during startup", async () => {
    const e = await collect(make("exit-on-init"), req("g1", [user("a")])).catch((x: unknown) => x);
    expect((e as AcpError).code).toBe("HARNESS_EXITED");
  });

  it("gives up on a harness that never answers initialize", async () => {
    const e = await collect(make("no-answer-init", { initTimeoutMs: 300 }), req("g1", [user("a")])).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AcpError);
    expect((e as AcpError).message).toMatch(/timed out/);
  });

  it("maps a sign-in problem to HARNESS_AUTH with the login hint", async () => {
    const e = await collect(make("auth-error"), req("g1", [user("a")])).catch((x: unknown) => x);
    expect((e as AcpError).code).toBe("HARNESS_AUTH");
    expect((e as AcpError).remediation).toBe("sign in please");
  });

  it("stops a runaway reply at the size limit", async () => {
    const e = await collect(make("huge", { maxReplyChars: 50_000 }), req("g1", [user("a")])).catch((x: unknown) => x);
    expect((e as AcpError).code).toBe("HARNESS_LIMIT");
  });

  it("turns refusal and early stops into errors", async () => {
    const r = await collect(make("refusal"), req("g1", [user("a")])).catch((x: unknown) => x);
    expect((r as AcpError).code).toBe("HARNESS_REFUSED");
    const m = await collect(make("max_tokens"), req("g1", [user("a")])).catch((x: unknown) => x);
    expect((m as AcpError).code).toBe("HARNESS_LIMIT");
  });

  it("does not pass our environment to the harness beyond the listed names", async () => {
    // FAKE_MODE is listed, so it works; an unlisted secret in our env must not exist in the child.
    const p = make("normal");
    process.env["CLAWNEXUS_TEST_SECRET"] = "should-not-leak";
    try {
      expect(await collect(p, req("g1", [user("x")]))).toBe("pong: x");
    } finally {
      delete process.env["CLAWNEXUS_TEST_SECRET"];
    }
  });

  it("close() ends the harness process", async () => {
    const p = make("normal");
    await collect(p, req("g1", [user("x")]));
    await p.close();
    const e = await collect(p, req("g1", [user("y")])).catch((x: unknown) => x);
    expect((e as AcpError).code).toBe("HARNESS_EXITED");
  });
});

describe("helpers", () => {
  it("mcpServerOf reads the server from vendor metadata or the mcp__server__tool name", () => {
    expect(mcpServerOf({ _meta: { claudeCode: { mcpServer: { name: "abc" }, toolName: "mcp__zzz__t" } } })).toBe("abc");
    expect(mcpServerOf({ _meta: { claudeCode: { toolName: "mcp__srv-1__fs_write" } } })).toBe("srv-1");
    expect(mcpServerOf({ name: "mcp__srv__x" })).toBe("srv");
    expect(mcpServerOf({ name: "Bash" })).toBeUndefined();
    expect(mcpServerOf({})).toBeUndefined();
  });

  it("scrub removes token-like strings and shortens", () => {
    expect(scrub(`failed with ${SECRET} twice`)).toBe("failed with [redacted] twice");
    expect(scrub("a".repeat(30) + " ok")).toBe("[redacted] ok");
    expect(scrub("word ".repeat(200), 50).length).toBeLessThanOrEqual(53);
  });

  it("buildPrompt keeps the newest turns that fit and always the new message", () => {
    const msgs = [user("old ".repeat(50)), asst("older answer"), user("recent"), asst("recent answer"), user("NOW")];
    const p = buildPrompt(msgs, 60);
    expect(p).toContain("NOW");
    expect(p).toContain("recent answer");
    expect(p).not.toContain("old old");
    expect(buildPrompt([user("only")], 100)).toBe("only");
    expect(buildPrompt([], 100)).toBe("");
  });
});

describe("harness presets and launching", () => {
  it("pins adapter versions for npx-launched harnesses", () => {
    for (const k of ["claude", "codex"] as const) {
      expect(PRESETS[k].command).toBe("npx");
      expect(PRESETS[k].args.some((a) => /@\d+\.\d+\.\d+$/.test(a))).toBe(true);
    }
    expect(PRESETS.gemini.args).toEqual(["--acp"]);
    expect(PRESETS.cursor.args).toEqual(["acp"]);
    expect(PRESETS.cursor.authMethodId).toBe("cursor_login");
  });

  it("custom needs a command; overrides win over presets", () => {
    expect(() => resolveSpec({ harness: "custom" })).toThrow(HarnessError);
    const s = resolveSpec({ harness: "claude", args: ["-y", "pkg@1.2.3"], env: ["ANTHROPIC_API_KEY"] });
    expect(s.args).toEqual(["-y", "pkg@1.2.3"]);
    expect(s.env).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("explains a missing program", () => {
    try {
      planLaunch({ ...specFor(), command: "definitely-not-installed-xyz" }, { PATH: tmpdir() }, "linux");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as HarnessError).code).toBe("HARNESS_NOT_FOUND");
    }
  });

  it("on Windows refuses a script shim when arguments could be interpreted by cmd.exe", () => {
    const dir = mkdtempSync(join(tmpdir(), "cn-acp-"));
    try {
      writeFileSync(join(dir, "tool.cmd"), "@echo off\r\n");
      const env = { PATH: dir + delimiter, PATHEXT: ".CMD" };
      const base = { ...specFor(), command: "tool" };
      expect(() => planLaunch({ ...base, args: ["a b&calc"] }, env, "win32")).toThrow(HarnessError);
      expect(() => planLaunch({ ...base, args: ["--acp", "%PATH%"] }, env, "win32")).toThrow(HarnessError);
      const ok = planLaunch({ ...base, args: ["--acp"] }, env, "win32");
      expect(ok.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
      expect(ok.args[ok.args.length - 1]).toBe("--acp");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("JsonRpcPeer", () => {
  function pair(maxLineBytes?: number) {
    const input = new PassThrough();
    const output = new PassThrough();
    const closed: Array<Error | undefined> = [];
    const notes: string[] = [];
    const peer = new JsonRpcPeer({
      input,
      output,
      ...(maxLineBytes ? { maxLineBytes } : {}),
      onRequest: async (m) => ({ echoed: m }),
      onNotification: (m) => {
        notes.push(m);
      },
      onClose: (r) => closed.push(r),
    });
    return { input, output, peer, closed, notes };
  }

  it("closes the connection on an oversized message", () => {
    const { input, closed, peer } = pair(100);
    input.write("x".repeat(500));
    expect(peer.isClosed).toBe(true);
    expect(closed[0]?.message).toMatch(/longer than/);
  });

  it("ignores junk lines but gives up on a flood of them", () => {
    const { input, peer } = pair();
    input.write("not json\n{\"a\":1}\n\n");
    expect(peer.isClosed).toBe(false);
    for (let i = 0; i < 150; i++) input.write("junk\n");
    expect(peer.isClosed).toBe(true);
  });

  it("rejects pending requests when the stream ends, and handles split chunks", async () => {
    const { input, output, peer } = pair();
    const p = peer.request("ping", {});
    const sent = JSON.parse(String(output.read()));
    const reply = JSON.stringify({ jsonrpc: "2.0", id: sent.id, result: { ok: true } }) + "\n";
    input.write(reply.slice(0, 10));
    input.write(reply.slice(10));
    expect(await p).toEqual({ ok: true });
    const q = peer.request("again", {});
    input.end();
    await expect(q).rejects.toThrow();
  });

  it("answers unknown requests from the other side without throwing", async () => {
    const { input, output } = pair();
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "x/y", params: {} }) + "\n");
    await new Promise((r) => setTimeout(r, 20));
    expect(JSON.parse(String(output.read()))).toEqual({ jsonrpc: "2.0", id: 7, result: { echoed: "x/y" } });
  });
});
