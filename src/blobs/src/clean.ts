/**
 * Take the hidden personal data out of a picture before it is kept: the location, camera, time and owner name a phone
 * writes into every photo, and free-text comments. Only metadata blocks are cut; the pixels are never decoded or
 * re-encoded, so there is nothing here for a crafted picture to attack and no quality is lost. A picture that does not
 * parse cleanly is returned unchanged and reported as `failed`, so that something about to leave the machine can be
 * refused instead of leaking what was never removed. Whatever is appended after the end of the picture (a second picture,
 * a video, a note) is cut, because it carries its own metadata and is not part of the picture.
 *
 * JPEG: removes EXIF/XMP (APP1), IPTC (APP13), other application blocks except the colour-profile (APP2) and Adobe
 * colour (APP14) ones, and comments. PNG: removes text chunks (tEXt, zTXt, iTXt), EXIF (eXIf) and the time stamp (tIME).
 * The EXIF "rotate this picture" hint goes with the rest, so a few phone photos may show turned.
 * Other formats are kept as they are: GIF, WebP, PDF and audio are not cleaned.
 */
import type { BlobMime } from "./sniff.js";

const MAX_STEPS = 100_000;

export interface CleanedPicture {
  bytes: Buffer;
  /** True for a JPEG or PNG that could not be followed exactly: the bytes are the original, hidden data included. */
  failed: boolean;
}

/** From the start of scan data at `i`, the position of the next real marker (not a stuffed zero, restart or fill byte). */
function nextMarker(b: Buffer, i: number): number {
  for (let k = i; k + 1 < b.length; k++) {
    if (b[k] !== 0xff) continue;
    const m = b[k + 1] as number;
    if (m === 0x00 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) continue;
    return k;
  }
  return b.length;
}

function cleanJpeg(b: Buffer): CleanedPicture {
  const fail = { bytes: b, failed: true };
  if (b[0] !== 0xff || b[1] !== 0xd8) return fail;
  const parts: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  for (let step = 0; step < MAX_STEPS; step++) {
    if (i + 2 > b.length) return fail;
    if (b[i] !== 0xff) return fail;
    let m = b[i + 1] as number;
    while (m === 0xff) {
      i++; // fill bytes
      if (i + 1 >= b.length) return fail;
      m = b[i + 1] as number;
    }
    if (m === 0xd9) {
      parts.push(b.subarray(i, i + 2)); // end of the picture: whatever follows is not part of it
      return { bytes: Buffer.concat(parts), failed: false };
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) {
      parts.push(b.subarray(i, i + 2)); // markers without a length
      i += 2;
      continue;
    }
    if (i + 4 > b.length) return fail;
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) return fail;
    const keep = !((m >= 0xe1 && m <= 0xef && m !== 0xe2 && m !== 0xee) || m === 0xfe);
    if (keep) parts.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
    if (m === 0xda) {
      // The compressed picture data follows the scan header, up to the next marker (a progressive picture has several scans).
      const end = nextMarker(b, i);
      parts.push(b.subarray(i, end));
      if (end >= b.length) return { bytes: Buffer.concat(parts), failed: false }; // cut short: nothing more to look at
      i = end;
    }
  }
  return fail;
}

const PNG_DROP = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);

function cleanPng(b: Buffer): CleanedPicture {
  const fail = { bytes: b, failed: true };
  const parts: Buffer[] = [b.subarray(0, 8)];
  let i = 8;
  for (let step = 0; step < MAX_STEPS; step++) {
    if (i + 12 > b.length) return fail;
    const len = b.readUInt32BE(i);
    if (len > 0x7fffffff || i + 12 + len > b.length) return fail;
    const type = b.toString("latin1", i + 4, i + 8);
    if (!PNG_DROP.has(type)) parts.push(b.subarray(i, i + 12 + len));
    i += 12 + len;
    if (type === "IEND") return { bytes: Buffer.concat(parts), failed: false }; // anything after the end is cut
  }
  return fail;
}

/** The picture with its hidden data removed, and whether that worked. Other kinds of file are returned as they are, not marked failed. */
export function cleanPicture(bytes: Buffer, mime: BlobMime): CleanedPicture {
  try {
    if (mime === "image/jpeg") return cleanJpeg(bytes);
    if (mime === "image/png") return cleanPng(bytes);
    return { bytes, failed: false };
  } catch {
    return { bytes, failed: mime === "image/jpeg" || mime === "image/png" };
  }
}

export function stripMetadata(bytes: Buffer, mime: BlobMime): Buffer {
  return cleanPicture(bytes, mime).bytes;
}
