import { BlobError, type BlobStore } from "./store.js";
import { sniff, type BlobMime } from "./sniff.js";
import { stripMetadata } from "./clean.js";

/**
 * An optional check run on every file that passed the type test, before it is kept. It returns a reason to refuse the file,
 * or undefined to accept it. If it throws, the file is refused: a check that cannot run is not a check that passed.
 */
export type ScanFile = (file: { bytes: Buffer; name: string; mime: BlobMime }) => Promise<string | undefined>;

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
export async function ingestAttachments(raw: readonly RawAttachment[], store: BlobStore, limits: IngestLimits = DEFAULT_INGEST, scan?: ScanFile): Promise<AttachmentRef[]> {
  const out: AttachmentRef[] = [];
  let total = 0;
  for (const [i, a] of raw.entries()) {
    const name = safeName(a.name, i);
    const drop = (why: string): void => void out.push({ name, ...(a.bytes !== undefined ? { bytes: a.bytes } : {}), dropped: why });
    if (i >= limits.maxFiles) {
      drop(`only the first ${limits.maxFiles} files of a message are taken`);
      continue;
    }
    if (a.data === undefined) {
      drop("the file was not downloaded");
      continue;
    }
    if (a.data.length > Math.ceil((limits.maxFileBytes * 4) / 3) + 8) {
      drop("the file is too large");
      continue;
    }
    if (!B64.test(a.data)) {
      drop("the file's data is damaged");
      continue;
    }
    const original = Buffer.from(a.data, "base64");
    if (original.length === 0) {
      drop("the file is empty");
      continue;
    }
    if (original.length > limits.maxFileBytes) {
      drop("the file is too large");
      continue;
    }
    if (total + original.length > limits.maxMessageBytes) {
      drop("this message's files are too large together");
      continue;
    }
    const mime = sniff(original);
    if (mime === undefined) {
      drop("this kind of file is not accepted (images, PDF, audio and text are)");
      continue;
    }
    // Hidden personal data in pictures (location, camera, owner name) is cut out before the file is looked at or kept.
    const bytes = stripMetadata(original, mime);
    if (scan) {
      let verdict: string | undefined;
      try {
        verdict = await scan({ bytes, name, mime });
      } catch {
        verdict = "the file check could not be run";
      }
      if (verdict !== undefined) {
        drop(verdict);
        continue;
      }
    }
    try {
      const { id } = store.put(bytes, mime);
      total += original.length;
      out.push({ id, name, mime, bytes: bytes.length });
    } catch (e) {
      if (e instanceof BlobError) drop(e.code === "FULL" ? "the attachment store is full" : e.message);
      else throw e;
    }
  }
  return out;
}
