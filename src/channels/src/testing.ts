import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore } from "@clawnexus/blobs";
import { PairingService } from "@clawnexus/pairing";
import { FakeProvider, SessionManager, type Provider } from "@clawnexus/sessions";
import { EventLog, openDb, type Db } from "@clawnexus/store";
import { ChannelManager, type ChannelManagerOptions } from "./manager.js";
import type { ChannelAdapter, ChannelCapabilities, ChannelHost, ChannelStatus, InboundOutcome, OutboundContent, SendResult, SendTarget } from "./types.js";

/** Everything a test needs: a real database, pairing, sessions and router, around the adapter under test. */
export interface Bed {
  dir: string;
  db: Db;
  events: EventLog;
  pairing: PairingService;
  sessions: SessionManager | undefined;
  manager: ChannelManager;
  blobs: BlobStore;
  provider: FakeProvider | undefined;
  /** The fake clock the router and pairing use, so tests can move time. */
  clock: { now: number };
  teardown(): Promise<void>;
}

export interface BedOptions {
  adapters: ChannelAdapter[];
  /** `null` = no model configured. */
  provider?: Provider | null;
  manager?: Partial<ChannelManagerOptions>;
  group?: Partial<import("./types.js").ChannelPolicy>;
}

export async function createBed(o: BedOptions): Promise<Bed> {
  const dir = mkdtempSync(join(tmpdir(), "cn-chan-"));
  const clock = { now: 1_700_000_000_000 };
  const now = (): number => clock.now;
  const db = openDb(join(dir, "gateway.db"));
  const events = new EventLog(db, now);
  const pairing = new PairingService(db, { now, audit: events });
  const fake = o.provider === null ? undefined : ((o.provider as FakeProvider | undefined) ?? new FakeProvider({ chunkSize: 1000, reply: (m) => `echo: ${[...m].reverse().find((x) => x.role === "user")?.content ?? ""}` }));
  const blobs = new BlobStore(join(dir, "blobs"), db, { now });
  const sessions = fake ? new SessionManager(db, events, fake, { now, deltaFlushMs: 0, blobReader: (id) => blobs.read(id) }) : undefined;
  const manager = new ChannelManager({ db, events, pairing, sessions, blobs, now, sendRetry: { attempts: 3, baseMs: 5 }, noticeCooldownMs: 1000, ...o.manager });
  for (const a of o.adapters) manager.register(a, o.group ?? {});
  await manager.start();
  return {
    dir,
    db,
    events,
    pairing,
    sessions,
    manager,
    blobs,
    provider: fake instanceof FakeProvider ? fake : undefined,
    clock,
    async teardown() {
      await manager.stop();
      await sessions?.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A scripted platform: records what the router sends, can be told to fail, and delivers messages on request. */
export class FakeAdapter implements ChannelAdapter {
  readonly id: string;
  readonly capabilities: ChannelCapabilities;
  host!: ChannelHost;
  readonly sent: Array<{ conversationId: string; text: string; files?: Array<{ name: string; mime: string; data: string }> }> = [];
  readonly typingLog: Array<{ conversationId: string; on: boolean }> = [];
  /** Fail this many upcoming sends. */
  failSends = 0;
  private state: ChannelStatus = { state: "stopped" };

  constructor(id = "fake", caps: Partial<ChannelCapabilities> = {}) {
    this.id = id;
    this.capabilities = { typing: true, groups: true, maxTextChars: 200, ...caps };
  }

  async start(host: ChannelHost): Promise<void> {
    this.host = host;
    this.state = { state: "connected" };
  }
  async stop(): Promise<void> {
    this.state = { state: "stopped" };
  }
  status(): ChannelStatus {
    return this.state;
  }
  async send(target: SendTarget, content: OutboundContent): Promise<SendResult> {
    if (this.failSends > 0) {
      this.failSends--;
      throw new Error("platform unavailable");
    }
    this.sent.push({ conversationId: target.conversationId, text: content.text, ...(content.files ? { files: content.files } : {}) });
    return { messageId: `out-${this.sent.length}` };
  }
  async typing(target: SendTarget, on: boolean): Promise<void> {
    this.typingLog.push({ conversationId: target.conversationId, on });
  }

  /** Deliver a message as if the platform had just sent it. */
  inject(m: Record<string, unknown>): Promise<InboundOutcome> {
    return this.host.deliver({ accountId: "default", conversationId: m["senderId"], isGroup: false, mentionsBot: true, ...m });
  }
}

export async function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}
