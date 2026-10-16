import type { Provider, ProviderEvent, ProviderMessage, ProviderRequest } from "@clawnexus/sessions";
import { AcpConnection, AcpError, type AcpConnectionOptions } from "./client.js";

export interface AcpProviderOptions extends Omit<AcpConnectionOptions, "spec"> {
  spec: AcpConnectionOptions["spec"];
  /** Reply text beyond this many characters ends the run with an error (a runaway harness). */
  maxReplyChars?: number;
  /** Largest history preamble sent when a harness session has to be rebuilt. */
  maxContextChars?: number;
  graceMs?: number;
  /** For tests: replace how connections are made. */
  connect?: (o: AcpConnectionOptions) => Promise<AcpConnection>;
}

/** Rebuild context for a brand-new harness session: most recent turns that fit, oldest first. */
export function buildPrompt(messages: readonly ProviderMessage[], maxChars: number): string {
  const lastUser = [...messages].map((m, i) => ({ m, i })).reverse().find((x) => x.m.role === "user");
  if (!lastUser) return "";
  const earlier = messages.slice(0, lastUser.i).filter((m) => m.role !== "system");
  if (earlier.length === 0) return lastUser.m.content;
  const lines: string[] = [];
  let used = lastUser.m.content.length;
  for (let i = earlier.length - 1; i >= 0; i--) {
    const m = earlier[i]!;
    const line = `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`;
    if (used + line.length > maxChars) break;
    used += line.length;
    lines.unshift(line);
  }
  if (lines.length === 0) return lastUser.m.content;
  return `Earlier in this conversation:\n${lines.join("\n")}\n\nContinue the conversation. The user's new message:\n${lastUser.m.content}`;
}

/**
 * Provider backed by an ACP harness. One harness process is shared by all sessions (started on first use,
 * restarted after a crash); each Gateway session gets its own harness session, so conversations stay separate.
 */
export class AcpProvider implements Provider {
  readonly name: string;
  private conn: Promise<AcpConnection> | undefined;
  private readonly sessions = new Map<string, string>();
  private closed = false;

  constructor(private readonly o: AcpProviderOptions) {
    this.name = `acp:${o.spec.name}`;
  }

  private connection(): Promise<AcpConnection> {
    if (this.closed) return Promise.reject(new AcpError("HARNESS_EXITED", "the provider was shut down", "Restart the Gateway."));
    if (!this.conn) {
      const make = this.o.connect ?? AcpConnection.start;
      const p = make(this.o);
      this.conn = p;
      p.then(
        (c) => {
          // When the process dies, forget it and its sessions so the next run starts fresh.
          const watch = setInterval(() => {
            if (!c.alive) {
              clearInterval(watch);
              if (this.conn === p) {
                this.conn = undefined;
                this.sessions.clear();
              }
            }
          }, 500);
          watch.unref();
        },
        () => {
          if (this.conn === p) this.conn = undefined;
        },
      );
    }
    return this.conn;
  }

  async *run(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const conn = await this.connection();
    if (!conn.alive) {
      this.conn = undefined;
      this.sessions.clear();
      return yield* this.run(req);
    }
    let sid = this.sessions.get(req.sessionId);
    const fresh = sid === undefined;
    if (sid === undefined) {
      sid = await conn.newSession();
      this.sessions.set(req.sessionId, sid);
    }
    const text = fresh ? buildPrompt(req.messages, this.o.maxContextChars ?? 24_000) : [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    if (text === "") return;

    // Bridge the callback into an async iterator.
    const queue: string[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    let failure: unknown;
    let total = 0;
    const limit = this.o.maxReplyChars ?? 1_000_000;
    const stop = new AbortController();
    const forward = (): void => stop.abort();
    req.signal.addEventListener("abort", forward, { once: true });
    if (req.signal.aborted) stop.abort();

    const turn = conn
      .prompt(sid, text, {
        signal: stop.signal,
        graceMs: this.o.graceMs ?? 3000,
        onText: (t) => {
          total += t.length;
          if (total > limit) {
            failure = new AcpError("HARNESS_LIMIT", `the harness produced more than ${limit} characters in one reply`, "Cancel and try a narrower request.");
            stop.abort();
            return;
          }
          queue.push(t);
          wake?.();
        },
      })
      .then(
        (reason) => {
          if (reason === "refusal") failure ??= new AcpError("HARNESS_REFUSED", "the model declined to answer", "Rephrase the request.");
          else if (reason === "max_tokens" || reason === "max_turn_requests") {
            failure ??= new AcpError("HARNESS_LIMIT", `the model stopped early (${reason})`, "Ask for a shorter answer, or split the task.");
          }
        },
        (e) => {
          failure ??= e;
        },
      )
      .finally(() => {
        done = true;
        wake?.();
      });

    try {
      for (;;) {
        while (queue.length > 0) yield { type: "delta", text: queue.shift()! };
        if (done) break;
        await new Promise<void>((r) => {
          wake = r;
          if (queue.length > 0 || done) r();
        });
      }
      await turn;
      if (failure && !req.signal.aborted) throw failure;
    } finally {
      req.signal.removeEventListener("abort", forward);
      if (!done) stop.abort(); // consumer stopped listening: tell the harness
    }
  }

  /** Stop the harness. Safe to call more than once. */
  async close(): Promise<void> {
    this.closed = true;
    const c = this.conn;
    this.conn = undefined;
    this.sessions.clear();
    await (await c?.catch(() => undefined))?.closeAndWait();
  }
}
