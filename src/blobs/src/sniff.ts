/**
 * What a file really is, decided from its first bytes and nothing else. A sender's claim about the type (a file name,
 * a MIME type) is never believed: a program renamed "photo.png" is still a program. Only kinds that can be shown to a
 * model or read as text are accepted; there is no parsing of the files here, so there is nothing in this module for a
 * crafted file to attack.
 */
export type BlobMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "application/pdf" | "audio/ogg" | "audio/mpeg" | "audio/wav" | "audio/mp4" | "text/plain";

const startsWith = (b: Uint8Array, ...bytes: number[]): boolean => bytes.every((x, i) => b[i] === x);
const ascii = (b: Uint8Array, at: number, s: string): boolean => [...s].every((ch, i) => b[at + i] === ch.charCodeAt(0));

function isText(b: Uint8Array): boolean {
  if (b.length === 0) return false;
  // Look at the start only: a text file is judged by its first 8 KB, and whole-file validity is checked on the same slice.
  const head = b.subarray(0, Math.min(b.length, 8192));
  for (const x of head) if (x === 0 || (x < 32 && x !== 9 && x !== 10 && x !== 13 && x !== 12) || x === 127) return false;
  try {
    // A cut in the middle of a character at the end of the slice is not an error; a bad byte elsewhere is.
    new TextDecoder("utf-8", { fatal: true }).decode(head.length === b.length ? head : head.subarray(0, head.length - 3));
    return true;
  } catch {
    return false;
  }
}

export function sniff(b: Uint8Array): BlobMime | undefined {
  if (b.length < 4) return isText(b) ? "text/plain" : undefined;
  if (startsWith(b, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (startsWith(b, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a")) return "image/gif";
  if (b.length >= 12 && ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) return "image/webp";
  if (b.length >= 12 && ascii(b, 0, "RIFF") && ascii(b, 8, "WAVE")) return "audio/wav";
  if (ascii(b, 0, "%PDF-")) return "application/pdf";
  if (ascii(b, 0, "OggS")) return "audio/ogg";
  if (ascii(b, 0, "ID3") || (b[0] === 0xff && ((b[1] ?? 0) & 0xe6) === 0xe2)) return "audio/mpeg";
  if (b.length >= 12 && ascii(b, 4, "ftypM4A ")) return "audio/mp4";
  return isText(b) ? "text/plain" : undefined;
}

export const isImage = (m: string): boolean => m.startsWith("image/");
export const isAudio = (m: string): boolean => m.startsWith("audio/");
