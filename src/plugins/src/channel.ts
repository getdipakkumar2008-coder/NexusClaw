import { channelStatusSchema } from "@clawnexus/plugin-sdk";
import type { ChannelAdapter, ChannelCapabilities, ChannelHost, ChannelStatus, InboundOutcome, OutboundContent, SendResult, SendTarget } from "@clawnexus/channels";
import type { PluginProcess } from "./process.js";

/** A send that carries a file may take far longer than a line of text (Slack uploads in three steps). Matches the router's limit. */
const FILE_CALL_MS = 130_000;

const clip = (s: unknown, n: number): string | undefined => (typeof s === "string" ? s.slice(0, n) : undefined);

/**
 * The router's view of a channel that lives inside a plugin process. Everything the plugin says is validated on this
 * side: the router checks every inbound message again, and what the plugin returns from `send` is reduced to a short id.
 */
export class PluginChannelAdapter implements ChannelAdapter {
  readonly id: string;
  readonly capabilities: ChannelCapabilities;
  private host: ChannelHost | undefined;
  private reported: ChannelStatus = { state: "starting" };
  private reportedByPlugin = false;

  constructor(
    reg: { id: string; capabilities: ChannelCapabilities },
    private readonly proc: PluginProcess,
    private readonly timeoutMs = 30_000,
  ) {
    this.id = reg.id;
    this.capabilities = reg.capabilities;
  }

  async start(host: ChannelHost): Promise<void> {
    this.host = host;
    this.reportedByPlugin = false;
    await this.proc.call("channel:start", {}, { timeoutMs: this.timeoutMs });
    if (!this.reportedByPlugin) this.reported = { state: "connected" };
  }

  async stop(): Promise<void> {
    this.host = undefined;
    try {
      await this.proc.call("channel:stop", {}, { timeoutMs: 5000 });
    } catch {
      /* the plugin may already be gone; the process is ended next */
    }
    this.reported = { state: "stopped" };
  }

  status(): ChannelStatus {
    if (!this.proc.alive) return { state: "degraded", detail: "the plugin is not running" };
    return this.reported;
  }

  async send(target: SendTarget, content: OutboundContent): Promise<SendResult> {
    const r = (await this.proc.call(
      "channel:send",
      { target: { accountId: target.accountId, conversationId: target.conversationId, ...(target.replyTo ? { replyTo: target.replyTo } : {}) }, content: { text: content.text, ...(content.files?.length ? { files: content.files } : {}) } },
      { timeoutMs: content.files?.length ? Math.max(this.timeoutMs, FILE_CALL_MS) : this.timeoutMs },
    )) as { messageId?: unknown } | null;
    const messageId = clip(r?.messageId, 256);
    return messageId ? { messageId } : {};
  }

  async typing(target: SendTarget, on: boolean): Promise<void> {
    if (!this.capabilities.typing) return;
    await this.proc.call("channel:typing", { target: { accountId: target.accountId, conversationId: target.conversationId }, on }, { timeoutMs: 10_000 });
  }

  /** An inbound message from the plugin, on its way to the router. */
  inbound(message: unknown): Promise<InboundOutcome> {
    return this.host ? this.host.deliver(message) : Promise.resolve({ result: "unavailable" });
  }

  /** The plugin reported its own health. */
  report(raw: unknown): void {
    const s = channelStatusSchema.safeParse(raw);
    if (!s.success) return;
    this.reportedByPlugin = true;
    this.reported = { state: s.data.state, ...(s.data.detail ? { detail: s.data.detail } : {}) };
    this.host?.setStatus(this.reported);
  }
}
