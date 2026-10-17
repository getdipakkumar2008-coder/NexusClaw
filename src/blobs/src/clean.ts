/**
 * Take the hidden personal data out of a picture before it is kept: the location, camera, time and owner name a phone
 * writes into every photo, and free-text comments. Only metadata blocks are cut; the pixels are never decoded or
 * re-encoded, so there is nothing here for a crafted picture to attack and no quality is lost. A picture that does not
 * parse cleanly is returned unchanged (it is still only ever shown to the model, never opened by the Gateway).
 *
 * JPEG: removes EXIF/XMP (APP1), IPTC (APP13), other application blocks except the colour-profile (APP2) and Adobe
 * colour (APP14) ones, and comments. PNG: removes text chunks (tEXt, zTXt, iTXt), EXIF (eXIf) and the time stamp (tIME).
 * The EXIF "rotate this picture" hint goes with the rest, so a few phone photos may show turned.
 * Other formats are kept as they are: GIF, WebP, PDF and audio are not cleaned.
 */
import type { BlobMime } from "./sniff.js";

const MAX_STEPS = 100_000;

function cleanJpeg(b: Buffer): Buffer {
  if (b[0] !== 0xff || b[1] !== 0xd8) return b;
  const parts: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  for (let step = 0; step < MAX_STEPS; step++) {
    if (i + 4 > b.length || b[i] !== 0xff) return b;
    let m = b[i + 1] as number;
    while (m === 0xff) {
      i++; // fill bytes
      if (i + 1 >= b.length) return b;
      m = b[i + 1] as number;
    }
    if (m === 0xda) {
      parts.push(b.subarray(i)); // start of scan: the picture data follows, copy everything that is left
      return Buffer.concat(parts);
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd9)) {
      parts.push(b.subarray(i, i + 2)); // markers without a length
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) return b;
    const keep = !((m >= 0xe1 && m <= 0xef && m !== 0xe2 && m !== 0xee) || m === 0xfe);
    if (keep) parts.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return b;
}

const PNG_DROP = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);

function cleanPng(b: Buffer): Buffer {
  const parts: Buffer[] = [b.subarray(0, 8)];
  let i = 8;
  for (let step = 0; step < MAX_STEPS; step++) {
    if (i + 12 > b.length) return b;
    const len = b.readUInt32BE(i);
    if (len > 0x7fffffff || i + 12 + len > b.length) return b;
    const type = b.toString("latin1", i + 4, i + 8);
    if (!PNG_DROP.has(type)) parts.push(b.subarray(i, i + 12 + len));
    i += 12 + len;
    if (type === "IEND") return i === b.length ? Buffer.concat(parts) : b; // anything after the end means it is not a plain picture
  }
  return b;
}

export function stripMetadata(bytes: Buffer, mime: BlobMime): Buffer {
  try {
    if (mime === "image/jpeg") return cleanJpeg(bytes);
    if (mime === "image/png") return cleanPng(bytes);
  } catch {
    /* fall through: keep the file as it came */
  }
  return bytes;
}
