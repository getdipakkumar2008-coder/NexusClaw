import { z } from "zod";

export const TRANSCRIPT_VERSION = 1;
/** Import limits: a transcript file is untrusted input. */
export const MAX_IMPORT_BYTES = 16 * 1024 * 1024;
export const MAX_IMPORT_MESSAGES = 50_000;

/** A file that came with a message: what it is and where the store keeps it, or why it was not taken. Never the bytes. */
export interface TranscriptFile {
  id?: string;
  name: string;
  mime?: string;
  bytes?: number;
  dropped?: string;
}

export interface TranscriptMessage {
  role: "user" | "assistant" | "system";
  sender: string;
  content: string;
  ts: number;
  files?: TranscriptFile[];
}

export interface Transcript {
  channel: string;
  conversation: string;
  scope: string;
  createdAt: number;
  messages: TranscriptMessage[];
}

const header = z.strictObject({
  t: z.literal("session"),
  version: z.literal(TRANSCRIPT_VERSION),
  channel: z.string().min(1).max(64),
  conversation: z.string().min(1).max(256),
  scope: z.string().min(1).max(256),
  createdAt: z.number().int().nonnegative(),
});
const file = z.strictObject({
  id: z.string().max(64).optional(),
  name: z.string().max(200),
  mime: z.string().max(100).optional(),
  bytes: z.number().int().nonnegative().optional(),
  dropped: z.string().max(300).optional(),
});
const message = z.strictObject({
  t: z.literal("message"),
  role: z.enum(["user", "assistant", "system"]),
  sender: z.string().max(256),
  content: z.string().max(256 * 1024),
  ts: z.number().int().nonnegative(),
  files: z.array(file).max(32).optional(),
});

export function toJsonl(t: Transcript): string {
  const lines = [
    JSON.stringify({ t: "session", version: TRANSCRIPT_VERSION, channel: t.channel, conversation: t.conversation, scope: t.scope, createdAt: t.createdAt }),
    ...t.messages.map((m) => JSON.stringify({ t: "message", role: m.role, sender: m.sender, content: m.content, ts: m.ts, ...(m.files?.length ? { files: m.files } : {}) })),
  ];
  return lines.join("\n") + "\n";
}

export class TranscriptError extends Error {}

export function fromJsonl(text: string): Transcript {
  if (Buffer.byteLength(text, "utf8") > MAX_IMPORT_BYTES) throw new TranscriptError("transcript is too large");
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) throw new TranscriptError("transcript is empty");
  if (lines.length - 1 > MAX_IMPORT_MESSAGES) throw new TranscriptError("transcript has too many messages");
  let h: z.infer<typeof header>;
  try {
    h = header.parse(JSON.parse(lines[0] as string));
  } catch {
    throw new TranscriptError("first line is not a valid session header");
  }
  const messages = lines.slice(1).map((l, i): TranscriptMessage => {
    try {
      const m = message.parse(JSON.parse(l));
      // The files are a record of what was sent, not something to bring back: the store may not hold them here.
      return { role: m.role, sender: m.sender, content: m.content, ts: m.ts };
    } catch {
      throw new TranscriptError(`line ${i + 2} is not a valid message`);
    }
  });
  return { channel: h.channel, conversation: h.conversation, scope: h.scope, createdAt: h.createdAt, messages };
}

export function toMarkdown(t: Transcript): string {
  const out = [`# Conversation ${t.channel} / ${t.conversation}`, ""];
  for (const m of t.messages) {
    out.push(`**${m.role}${m.sender ? ` (${m.sender})` : ""}** · ${new Date(m.ts).toISOString()}`, "", m.content, "");
    for (const f of m.files ?? []) {
      const label = JSON.stringify(f.name);
      out.push(f.dropped !== undefined ? `- file ${label}: not taken (${f.dropped})` : `- file ${label} (${f.mime ?? "unknown type"}, ${f.bytes ?? "?"} bytes${f.id ? `, ${f.id.slice(0, 12)}` : ""})`);
    }
    if (m.files?.length) out.push("");
  }
  return out.join("\n");
}
