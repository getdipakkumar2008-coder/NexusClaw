import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runMcpServer, type McpBackend } from "./mcp.js";
import { GatewayToolBackend, mcpName, type GatewayCaller } from "./toolbridge.js";

interface Rpc {
  id?: number;
  result?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  error?: { code: number; message: string };
}

function harness(backend: McpBackend) {
  const input = new PassThrough();
  const output = new PassThrough();
  const server = runMcpServer({ input, output, backend, name: "t", version: "1" });
  const seen: Rpc[] = [];
  let buf = "";
  output.on("data", (d: Buffer) => {
    buf += d.toString();
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      seen.push(JSON.parse(buf.slice(0, i)) as Rpc);
      buf = buf.slice(i + 1);
    }
  });
  let n = 0;
  const send = (m: object): void => void input.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  const ask = async (method: string, params?: unknown): Promise<Rpc> => {
    const id = ++n;
    send({ id, method, params });
    for (let i = 0; i < 200; i++) {
      const r = seen.find((x) => x.id === id);
      if (r) return r;
      await new Promise((r2) => setTimeout(r2, 5));
    }
    throw new Error(`no answer to ${method}`);
  };
  return { server, input, send, ask };
}

const open: Array<{ close(): void }> = [];
afterEach(() => open.splice(0).forEach((s) => s.close()));

const echoBackend = (over: Partial<McpBackend> = {}): McpBackend => ({
  listTools: async () => [{ name: "echo", description: "d", inputSchema: { type: "object" } }],
  callTool: async (name, args) => ({ text: `${name}:${JSON.stringify(args)}`, isError: false }),
  ...over,
});

describe("MCP server", () => {
  it("negotiates a supported protocol version and advertises only tools", async () => {
    const h = harness(echoBackend());
    open.push(h.server);
    const a = await h.ask("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "1" } });
    expect(a.result.protocolVersion).toBe("2025-03-26");
    expect(Object.keys(a.result.capabilities)).toEqual(["tools"]);
    const b = await h.ask("initialize", { protocolVersion: "1999-01-01" });
    expect(b.result.protocolVersion).toBe("2025-06-18");
    expect((await h.ask("ping")).result).toEqual({});
  });

  it("lists and calls tools", async () => {
    const h = harness(echoBackend());
    open.push(h.server);
    expect((await h.ask("tools/list")).result.tools[0].name).toBe("echo");
    const r = await h.ask("tools/call", { name: "echo", arguments: { a: 1 } });
    expect(r.result).toEqual({ content: [{ type: "text", text: 'echo:{"a":1}' }], isError: false });
  });

  it("rejects malformed calls and unknown methods without dying", async () => {
    const h = harness(echoBackend());
    open.push(h.server);
    expect((await h.ask("tools/call", { arguments: {} })).error?.code).toBe(-32600);
    expect((await h.ask("tools/call", "nope")).error?.code).toBe(-32600);
    expect((await h.ask("resources/list")).error?.code).toBe(-32601);
    h.input.write("garbage\n\n{}\n");
    expect((await h.ask("ping")).result).toEqual({});
  });

  it("turns a backend crash into a tool error, not a dead server", async () => {
    const h = harness(echoBackend({ callTool: async () => Promise.reject(new Error("boom")) }));
    open.push(h.server);
    const r = await h.ask("tools/call", { name: "echo" });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("boom");
    expect((await h.ask("ping")).result).toEqual({});
  });

  it("caps very large tool output", async () => {
    const h = harness(echoBackend({ callTool: async () => ({ text: "x".repeat(300_000), isError: false }) }));
    open.push(h.server);
    const r = await h.ask("tools/call", { name: "echo" });
    expect(r.result.content[0].text.length).toBeLessThan(101_000);
    expect(r.result.content[0].text).toContain("[truncated]");
  });

  it("aborts an in-flight call when the client cancels it", async () => {
    let aborted = false;
    const h = harness(
      echoBackend({
        callTool: (_n, _a, signal) =>
          new Promise((resolve) => {
            signal.addEventListener("abort", () => {
              aborted = true;
              resolve({ text: "cancelled", isError: true });
            });
          }),
      }),
    );
    open.push(h.server);
    const pending = h.ask("tools/call", { name: "echo" }); // request id 1
    await new Promise((r) => setTimeout(r, 30));
    h.send({ method: "notifications/cancelled", params: { requestId: 1 } });
    await pending;
    expect(aborted).toBe(true);
  });

  it("finishes when the harness closes the pipe", async () => {
    const h = harness(echoBackend());
    h.input.end();
    await expect(h.server.done).resolves.toBeUndefined();
  });
});

describe("GatewayToolBackend", () => {
  type Call = { method: string; params: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  function fakeGateway(handler: (c: Call, n: number) => unknown): GatewayCaller & { calls: Call[] } {
    const calls: Call[] = [];
    return {
      calls,
      async call<T>(method: string, params?: unknown): Promise<T> {
        const c = { method, params };
        calls.push(c);
        const out = handler(c, calls.length);
        if (out instanceof Error) throw out;
        return out as T;
      },
    };
  }
  const tools = { tools: [{ name: "fs.read", description: "Read", risk: 0, inputSchema: { type: "object" } }, { name: "exec.run", description: "Run", risk: 3 }] };

  it("maps dotted tool names to MCP-safe names and back", async () => {
    expect(mcpName("fs.read")).toBe("fs_read");
    const g = fakeGateway((c) => (c.method === "tool.list" ? tools : { status: "ok", output: "hello" }));
    const b = new GatewayToolBackend(g);
    const list = await b.listTools();
    expect(list.map((t) => t.name)).toEqual(["fs_read", "exec_run"]);
    expect(list[1]!.description).toContain("R3");
    expect(list[1]!.inputSchema).toEqual({ type: "object" });
    expect(await b.callTool("fs_read", { path: "a" }, new AbortController().signal)).toEqual({ text: "hello", isError: false });
    expect(g.calls.find((c) => c.method === "tool.call")?.params).toEqual({ tool: "fs.read", args: { path: "a" } });
    expect((await b.callTool("nope", {}, new AbortController().signal)).isError).toBe(true);
  });

  it("explains a policy denial in words that stop the model from looping", async () => {
    const g = fakeGateway((c) => (c.method === "tool.list" ? tools : { status: "denied", reason: "guest profile does not allow this tool" }));
    const r = await new GatewayToolBackend(g).callTool("exec_run", {}, new AbortController().signal);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("guest profile does not allow this tool");
    expect(r.text).toMatch(/do not retry/i);
  });

  it("waits for the owner, then retries with the approval id", async () => {
    let polls = 0;
    const g = fakeGateway((c) => {
      if (c.method === "tool.list") return tools;
      if (c.method === "approval.status") return { state: ++polls < 3 ? "pending" : "approved" };
      return c.params.approvalId ? { status: "ok", output: { done: true } } : { status: "approval_required", approvalId: "ap1", reason: "needs approval" };
    });
    const r = await new GatewayToolBackend(g, { pollMs: 5, approvalWaitMs: 5000 }).callTool("exec_run", { command: "x" }, new AbortController().signal);
    expect(r).toEqual({ text: '{"done":true}', isError: false });
    const calls = g.calls.filter((c) => c.method === "tool.call");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.params).toEqual({ tool: "exec.run", args: { command: "x" }, approvalId: "ap1" });
    expect(polls).toBe(3);
  });

  it("reports an owner's refusal, and never retries the call", async () => {
    const g = fakeGateway((c) => {
      if (c.method === "tool.list") return tools;
      if (c.method === "approval.status") return { state: "denied" };
      return { status: "approval_required", approvalId: "ap1", reason: "r" };
    });
    const r = await new GatewayToolBackend(g, { pollMs: 5 }).callTool("exec_run", {}, new AbortController().signal);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("denied");
    expect(g.calls.filter((c) => c.method === "tool.call")).toHaveLength(1);
  });

  it("gives up after the wait limit and says the approval is still pending", async () => {
    const g = fakeGateway((c) => {
      if (c.method === "tool.list") return tools;
      if (c.method === "approval.status") return { state: "pending" };
      return { status: "approval_required", approvalId: "ap9", reason: "r" };
    });
    const t0 = Date.now();
    const r = await new GatewayToolBackend(g, { pollMs: 10, approvalWaitMs: 80 }).callTool("exec_run", {}, new AbortController().signal);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("ap9");
    expect(g.calls.filter((c) => c.method === "tool.call")).toHaveLength(1);
  });

  it("stops waiting as soon as the call is cancelled", async () => {
    const g = fakeGateway((c) => {
      if (c.method === "tool.list") return tools;
      if (c.method === "approval.status") return { state: "pending" };
      return { status: "approval_required", approvalId: "ap1", reason: "r" };
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 40);
    const t0 = Date.now();
    const r = await new GatewayToolBackend(g, { pollMs: 1000, approvalWaitMs: 60_000 }).callTool("exec_run", {}, ac.signal);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(r.text).toMatch(/cancelled/);
  });

  it("surfaces tool failures", async () => {
    const g = fakeGateway((c) => (c.method === "tool.list" ? tools : { status: "error", code: "FAILED", message: "no such file" }));
    const r = await new GatewayToolBackend(g).callTool("fs_read", {}, new AbortController().signal);
    expect(r).toEqual({ text: "The tool failed (FAILED): no such file", isError: true });
  });
});
