export interface ProviderMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ProviderRequest {
  sessionId: string;
  runId: string;
  /** Only this session's history, oldest first, ending with the message being answered. */
  messages: ProviderMessage[];
  /** Aborted on cancel or timeout; providers must stop promptly (the manager also stops listening). */
  signal: AbortSignal;
  /** Where the message being answered came from. External senders are untrusted and the model should be told so. */
  source?: { channel: string; sender: string; principal: "owner" | "guest" };
  /** Notes to show the model this turn (memory). Recomputed every turn, so a provider that keeps its own conversation should resend it only when it changes. Absent when there is nothing to show. */
  system?: string;
}

export type ProviderEvent = { type: "delta"; text: string };

/** The seam between the Gateway and a model runtime (an ACP client in WP7, a fake in tests). */
export interface Provider {
  readonly name: string;
  run(req: ProviderRequest): AsyncIterable<ProviderEvent>;
}

export interface FakeProviderOptions {
  /** Maps the last user message to the reply text. Default: `echo: <text>`. */
  reply?: (messages: ProviderMessage[]) => string;
  /** Reply is emitted in chunks of this many characters. */
  chunkSize?: number;
  /** Delay before each chunk (ms). */
  delayMs?: number;
  /** Throw this error after the first chunk. */
  failWith?: string;
  /** Never produce anything (to test timeouts and cancellation). */
  hang?: boolean;
}

/** Deterministic provider for tests and for the first end-to-end milestone. No network, no model. */
export class FakeProvider implements Provider {
  readonly name = "fake";
  /** Every request seen, for isolation assertions. */
  readonly calls: ProviderRequest[] = [];

  constructor(private readonly o: FakeProviderOptions = {}) {}

  async *run(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.calls.push(req);
    if (this.o.hang) await new Promise<never>(() => undefined);
    const last = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const text = this.o.reply ? this.o.reply(req.messages) : `echo: ${last}`;
    const size = Math.max(1, this.o.chunkSize ?? 8);
    for (let i = 0; i < text.length; i += size) {
      if (this.o.delayMs) await new Promise((r) => setTimeout(r, this.o.delayMs));
      yield { type: "delta", text: text.slice(i, i + size) };
      if (this.o.failWith !== undefined && i === 0) throw new Error(this.o.failWith);
    }
  }
}
