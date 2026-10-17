import type { ProviderAttachment, ProviderMessage } from "@clawnexus/sessions";

/** Content blocks of an ACP prompt (the parts of the protocol this client uses). */
export type PromptBlock =
  | { type: "text"; text: string }
  | { type: "image" | "audio"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; mimeType: string; blob: string } };

/** What the harness said it can take besides text (ACP `promptCapabilities`). Text is always accepted. */
export interface PromptCaps {
  image: boolean;
  audio: boolean;
  embeddedContext: boolean;
}

type Ref = NonNullable<ProviderMessage["attachments"]>[number];

/** Text files are shown to the model in full up to this many characters, then cut. */
export const MAX_INLINE_TEXT = 20_000;

const kb = (n: number | undefined): string => (n === undefined ? "" : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
/** File names come from the sender, so they are shown as quoted data, never as running text. */
const q = (s: string): string => JSON.stringify(s);

/** One line about a file for the conversation history. */
export function describeRef(a: Ref): string {
  return a.dropped !== undefined ? `file ${q(a.name)} (not accepted: ${a.dropped})` : `file ${q(a.name)} (${a.mime ?? "unknown type"}${a.bytes === undefined ? "" : `, ${kb(a.bytes)}`})`;
}

/**
 * The prompt for a turn that has files: the text first (with a note about each file the model cannot be given), then the
 * files themselves in the forms this harness accepts. A file's content is untrusted, like the message it came with: it
 * is labelled as such, and what the model may DO is still decided by policy, not by anything written in a file.
 */
export function buildBlocks(text: string, attachments: readonly ProviderAttachment[] | undefined, caps: PromptCaps): string | PromptBlock[] {
  if (!attachments || attachments.length === 0) return text;
  const notes: string[] = [];
  const media: PromptBlock[] = [];
  const inline: string[] = [];
  for (const a of attachments) {
    if (a.dropped !== undefined) {
      notes.push(`The sender also sent ${describeRef(a)}.`);
      continue;
    }
    const bytes = a.read();
    const mime = a.mime ?? "application/octet-stream";
    if (!bytes) {
      notes.push(`The sender sent ${q(a.name)}, but it is no longer available.`);
    } else if (mime.startsWith("image/") && caps.image) {
      media.push({ type: "image", data: bytes.toString("base64"), mimeType: mime });
      notes.push(`The sender attached the image ${q(a.name)} (shown below).`);
    } else if (mime.startsWith("audio/") && caps.audio) {
      media.push({ type: "audio", data: bytes.toString("base64"), mimeType: mime });
      notes.push(`The sender attached the audio ${q(a.name)} (below).`);
    } else if (mime === "text/plain") {
      const body = bytes.toString("utf8");
      inline.push(`Contents of the text file ${q(a.name)}${body.length > MAX_INLINE_TEXT ? ` (first ${MAX_INLINE_TEXT} characters of ${body.length})` : ""}, from the sender, untrusted:\n"""\n${body.slice(0, MAX_INLINE_TEXT)}\n"""`);
    } else if (mime === "application/pdf" && caps.embeddedContext) {
      media.push({ type: "resource", resource: { uri: `attachment:///${encodeURIComponent(a.name)}`, mimeType: mime, blob: bytes.toString("base64") } });
      notes.push(`The sender attached the PDF ${q(a.name)} (below).`);
    } else {
      notes.push(`The sender attached ${describeRef(a)}, which cannot be shown to you.`);
    }
  }
  const head = notes.length ? `[${notes.join(" ")}]\n` : "";
  const tail = inline.length ? `\n\n${inline.join("\n\n")}` : "";
  const first: PromptBlock = { type: "text", text: `${head}${text}${tail}` };
  return media.length ? [first, ...media] : first.text;
}
