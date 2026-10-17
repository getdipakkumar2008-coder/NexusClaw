import { z } from "zod";

/** What a channel can do. The router uses this to decide how to shape what it sends. */
export interface ChannelCapabilities {
  /** Can show a "typing" indicator. */
  typing: boolean;
  /** Messages can arrive from group chats (the router then applies the mention rules). */
  groups: boolean;
  /** Longest single message the platform accepts; longer replies are split. */
  maxTextChars: number;
  /** Can deliver a file with a message (pictures, documents, audio). Absent means no. */
  files?: boolean;
}

export type ChannelState = "starting" | "connected" | "degraded" | "auth_required" | "stopped";

export interface ChannelStatus {
  state: ChannelState;
  /** Short, human-readable, free of secrets. */
  detail?: string;
}

export interface SendTarget {
  channel: string;
  accountId: string;
  conversationId: string;
  /** Platform message id being replied to, when the platform supports threading. */
  replyTo?: string;
}

/** A file on its way out. Already checked by the Gateway (type from content, size, metadata removed). */
export interface OutboundFile {
  name: string;
  mime: string;
  /** The file itself, base64. */
  data: string;
}

export interface OutboundContent {
  /** May be empty when a file is sent on its own. */
  text: string;
  /** At most one file per message. */
  files?: OutboundFile[];
}

export interface SendResult {
  /** Platform id of the message that was sent, when the platform reports one. */
  messageId?: string;
}

const hasControl = (s: string): boolean => [...s].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);
const clean = (max: number) => z.string().min(1).max(max).refine((s) => !hasControl(s), "must not contain control characters");

/**
 * The one shape every channel hands to the router (docs/05 section 1). Strict: unknown fields are rejected, so an
 * adapter cannot smuggle extra data (such as a pre-made "this sender is the owner" flag) into the router.
 * `raw` platform payloads are deliberately absent: they never reach the model.
 */
export const inboundSchema = z.strictObject({
  accountId: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, "account ids are letters, digits, dot, dash, underscore"),
  conversationId: clean(256),
  senderId: clean(256),
  senderDisplay: z.string().max(200).optional(),
  /** Platform message id: the key for de-duplication. */
  messageId: clean(256),
  text: z.string().max(200_000),
  replyTo: clean(256).optional(),
  isGroup: z.boolean(),
  mentionsBot: z.boolean(),
  ts: z.number().int().nonnegative().optional(),
  /**
   * Files that came with the message. `data` is the file itself, base64; without it the file is only noted. The router
   * decides what is accepted from the content (never from `mimeType`), and only for senders it has already let through.
   */
  attachments: z
    .array(
      z.strictObject({
        name: z.string().max(256).optional(),
        mimeType: z.string().max(128).optional(),
        bytes: z.number().int().nonnegative().optional(),
        data: z.string().max(12_000_000).optional(),
      }),
    )
    .max(32)
    .optional(),
}).refine((m) => (m.attachments ?? []).reduce((n, a) => n + (a.data?.length ?? 0), 0) <= 24_000_000, "attachments are too large together");
export type InboundMessage = z.infer<typeof inboundSchema> & { channel: string };

export type InboundOutcome =
  | { result: "accepted"; sessionId: string; runId: string }
  | { result: "pairing"; }
  | { result: "ignored"; reason: string }
  | { result: "duplicate" }
  | { result: "limited" }
  | { result: "busy" }
  | { result: "unavailable" }
  | { result: "invalid"; reason: string };

/** What the router offers an adapter. An adapter gets no other way into the Gateway. */
export interface ChannelHost {
  /** Hand over one inbound message. The router stamps the channel id itself, so an adapter cannot speak for another channel. */
  deliver(message: unknown): Promise<InboundOutcome>;
  /** Report health. Shown to the owner and recorded. Must not contain secrets. */
  setStatus(status: ChannelStatus): void;
  /** Most recent exchange for a conversation, oldest first, for adapters that show history on reconnect. */
  recent(accountId: string, conversationId: string, senderId: string, limit: number): Array<{ from: "you" | "assistant"; text: string; ts: number }>;
  log(level: "info" | "warn" | "error", message: string): void;
}

export interface ChannelAdapter {
  /** Stable, lowercase id: `webchat`, `telegram`. Becomes the `channel` of every sender and session it produces. */
  readonly id: string;
  readonly capabilities: ChannelCapabilities;
  start(host: ChannelHost): Promise<void>;
  stop(): Promise<void>;
  status(): ChannelStatus;
  send(target: SendTarget, content: OutboundContent): Promise<SendResult>;
  typing?(target: SendTarget, on: boolean): Promise<void>;
}

export const ADAPTER_ID = /^[a-z][a-z0-9-]{1,30}$/;

/** Settings the router applies for one channel. */
export interface ChannelPolicy {
  /** Group chats: ignore everything ("off"), only messages that mention the bot ("mention"), or all messages ("all"). */
  groups: "off" | "mention" | "all";
  /** If non-empty, only these group ids are served. */
  allowedGroups: string[];
}

export const DEFAULT_POLICY: ChannelPolicy = { groups: "mention", allowedGroups: [] };
