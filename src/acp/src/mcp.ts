import type { Readable, Writable } from "node:stream";
import { JsonRpcPeer, RPC, RpcError } from "./jsonrpc.js";

/** MCP protocol revisions this server can speak, newest first. */
export const MCP_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
const MAX_TEXT = 100_000;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpBackend {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: unknown, signal: AbortSignal): Promise<{ text: string; isError: boolean }>;
}

export interface McpServerOptions {
  input: Readable;
  output: Writable;
  backend: McpBackend;
  name: string;
  version: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A minimal Model Context Protocol server over stdio (tools only), written from the public MCP specification.
 * The peer on the other end is the model's harness: untrusted, so every message is validated and a backend
 * failure becomes a tool error result rather than a crash.
 */
export function runMcpServer(o: McpServerOptions): { done: Promise<void>; close(): void } {
  const inflight = new Map<string | number, AbortController>();
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));
  const peer: JsonRpcPeer = new JsonRpcPeer({
    input: o.input,
    output: o.output,
    onRequest: async (method, params, id) => {
      switch (method) {
        case "initialize": {
          const asked = isObj(params) && typeof params["protocolVersion"] === "string" ? params["protocolVersion"] : "";
          const version = (MCP_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_VERSIONS[0];
          return { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: { name: o.name, version: o.version } };
        }
        case "ping":
          return {};
        case "tools/list":
          return { tools: await o.backend.listTools() };
        case "tools/call": {
          if (!isObj(params) || typeof params["name"] !== "string") throw new RpcError(RPC.INVALID, "tools/call needs a tool name");
          const args = params["arguments"] ?? {};
          const ac = new AbortController();
          inflight.set(id, ac);
          try {
            const r = await o.backend.callTool(params["name"], args, ac.signal);
            const text = r.text.length > MAX_TEXT ? `${r.text.slice(0, MAX_TEXT)}\n[truncated]` : r.text;
            return { content: [{ type: "text", text }], isError: r.isError };
          } catch (e) {
            return { content: [{ type: "text", text: `The tool bridge failed: ${e instanceof Error ? e.message.slice(0, 300) : "unknown error"}` }], isError: true };
          } finally {
            inflight.delete(id);
          }
        }
        default:
          throw new RpcError(RPC.NO_METHOD, "method not supported");
      }
    },
    onNotification: (method, params) => {
      if (method === "notifications/cancelled" && isObj(params)) {
        const rid = params["requestId"];
        if (typeof rid === "string" || typeof rid === "number") inflight.get(rid)?.abort();
      }
    },
    onClose: () => {
      for (const ac of inflight.values()) ac.abort();
      finish();
    },
  });
  return { done, close: () => peer.close(undefined) };
}
