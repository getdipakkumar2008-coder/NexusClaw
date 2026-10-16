import type { McpBackend, McpTool } from "./mcp.js";

/** The slice of a Gateway client the bridge needs (satisfied by the CLI's GatewayClient). */
export interface GatewayCaller {
  call<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
}

export interface ToolBridgeOptions {
  /** How long to wait for the owner to decide before giving the model a "still pending" answer. */
  approvalWaitMs?: number;
  pollMs?: number;
}

interface WireTool {
  name: string;
  description: string;
  risk: number;
  inputSchema?: Record<string, unknown>;
}

type WireResult =
  | { status: "ok"; output: unknown }
  | { status: "denied"; reason: string }
  | { status: "approval_required"; approvalId: string; reason: string }
  | { status: "error"; code: string; message: string };

/** MCP tool names are restricted by many clients to letters, digits, underscore and hyphen. */
export const mcpName = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, "_");

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/**
 * Serves the Gateway's tools to a model through MCP. Nothing is decided here: every call goes to the Gateway,
 * which applies policy, approvals and auditing as the session's principal. This layer only translates, and waits
 * (bounded) for the owner when a call needs approval so the model gets a real answer instead of an instruction.
 */
export class GatewayToolBackend implements McpBackend {
  private names = new Map<string, string>();

  constructor(
    private readonly g: GatewayCaller,
    private readonly o: ToolBridgeOptions = {},
  ) {}

  async listTools(): Promise<McpTool[]> {
    const r = await this.g.call<{ tools: WireTool[] }>("tool.list", {});
    const next = new Map<string, string>();
    const out: McpTool[] = [];
    for (const t of r.tools) {
      const n = mcpName(t.name);
      if (next.has(n)) continue; // a collision would be ambiguous: expose only the first
      next.set(n, t.name);
      out.push({
        name: n,
        description: `${t.description} (risk class R${t.risk}; the owner's policy decides whether it runs, and some calls wait for the owner's approval)`,
        inputSchema: t.inputSchema ?? { type: "object" },
      });
    }
    this.names = next;
    return out;
  }

  async callTool(name: string, args: unknown, signal: AbortSignal): Promise<{ text: string; isError: boolean }> {
    if (!this.names.has(name)) await this.listTools();
    const real = this.names.get(name);
    if (!real) return { text: `Unknown tool "${name}".`, isError: true };

    let r = await this.g.call<WireResult>("tool.call", { tool: real, args });
    if (r.status === "approval_required") {
      const decided = await this.awaitOwner(r.approvalId, signal);
      if (decided !== "approved") {
        return {
          text:
            decided === "denied"
              ? "The owner denied this call. Do not retry it; tell the user what you could not do."
              : decided === "aborted"
                ? "The request was cancelled while waiting for approval."
                : `The owner has not approved this call yet (approval ${r.approvalId} is still waiting). Tell the user it needs their approval; do not retry in a loop.`,
          isError: true,
        };
      }
      r = await this.g.call<WireResult>("tool.call", { tool: real, args, approvalId: r.approvalId });
      if (r.status === "approval_required") return { text: "The approval did not apply to this call.", isError: true };
    }
    switch (r.status) {
      case "ok":
        return { text: typeof r.output === "string" ? r.output : (JSON.stringify(r.output) ?? "null"), isError: false };
      case "denied":
        return { text: `Not allowed by policy: ${r.reason}. Do not retry; tell the user what you could not do.`, isError: true };
      case "error":
        return { text: `The tool failed (${r.code}): ${r.message}`, isError: true };
      default:
        return { text: "Unexpected tool result.", isError: true };
    }
  }

  private async awaitOwner(id: string, signal: AbortSignal): Promise<"approved" | "denied" | "timeout" | "aborted"> {
    const deadline = Date.now() + (this.o.approvalWaitMs ?? 120_000);
    const poll = this.o.pollMs ?? 1000;
    while (!signal.aborted && Date.now() < deadline) {
      const { state } = await this.g.call<{ state: string }>("approval.status", { id });
      if (state === "approved") return "approved";
      if (state !== "pending") return "denied"; // denied, expired or already used
      await sleep(Math.min(poll, Math.max(0, deadline - Date.now())), signal);
    }
    return signal.aborted ? "aborted" : "timeout";
  }
}
