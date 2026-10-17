import { BlobError, type BlobStore } from "./store.js";
import { sniff } from "./sniff.js";

/** What an adapter hands over for one attached file. `data` is the file itself, base64; without it only a note can be made. */
export interface RawAttachment {
  name?: string | undefined;
  mimeType?: string | undefined;
  bytes?: number | undefined;
  data?: string | undefined;
}

/** What is kept on a message: where the file is and what it is, or why it was not accepted. Never the bytes. */
export interface AttachmentRef {
  /** SHA-256 of the file; absent when it was not accepted. */
  id?: string;
  name: string;
  /** What the file really is (from its content, not from the sender's claim). */
  mime?: string;
  bytes?: number;
  /** Why the file was not accepted, in words for the model and the owner. */
  dropped?: string;
}

export interface IngestLimits {
  /** Files taken from one message; the rest are noted as dropped. */
  maxFiles: number;
  maxFileBytes: number;
  /** All files of one message together. */
  maxMessageBytes: number;
}

export const DEFAULT_INGEST: IngestLimits = { maxFiles: 4, maxFileBytes: 8 * 1024 * 1024, maxMessageBytes: 16 * 1024 * 1024 };

/** A name that is safe to show and to log: no path, no control characters, bounded. */
export function safeName(name: string | undefined, index: number): string {
  const base = (name ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = [...base].filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127 && !"<>:\"|?*".includes(ch)).join("").trim().replace(/^\.+/, "");
  return (cleaned || `file-${index + 1}`).slice(0, 100);
}

const B64 = /^[A-Za-z0-9+/_-]*={0,2}$/;

/**
 * Decide what to do with each file that came with a message, and store the ones that are acceptable. Every file ends up
 * in the result, accepted or not, so the model and the owner can see that something was sent and what became of it.
 */
export function ingestAttachments(raw: readonly RawAttachment[], store: BlobStore, limits: IngestLimits = DEFAULT_INGEST): AttachmentRef[] {
  const out: AttachmentRef[] = [];
  let total = 0;
  raw.forEach((a, i) => {
    const name = safeName(a.name, i);
    const drop = (why: string): void => void out.push({ name, ...(a.bytes !== undefined ? { bytes: a.bytes } : {}), dropped: why });
    if (i >= limits.maxFiles) return drop(`only the first ${limits.maxFiles} files of a message are taken`);
    if (a.data === undefined) return drop("the file was not downloaded");
    if (a.data.length > Math.ceil((limits.maxFileBytes * 4) / 3) + 8) return drop("the file is too large");
    if (!B64.test(a.data)) return drop("the file's data is damaged");
    const bytes = Buffer.from(a.data, "base64");
    if (bytes.length === 0) return drop("the file is empty");
    if (bytes.length > limits.maxFileBytes) return drop("the file is too large");
    if (total + bytes.length > limits.maxMessageBytes) return drop("this message's files are too large together");
    const mime = sniff(bytes);
    if (mime === undefined) return drop("this kind of file is not accepted (images, PDF, audio and text are)");
    try {
      const { id } = store.put(bytes, mime);
      total += bytes.length;
      out.push({ id, name, mime, bytes: bytes.length });
    } catch (e) {
      if (e instanceof BlobError) return drop(e.code === "FULL" ? "the attachment store is full" : e.message);
      throw e;
    }
  });
  return out;
}
