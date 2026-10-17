/** A small multipart/form-data reader for the tests' stand-ins for Telegram and Discord. Not used by the Gateway. */
export interface Part {
  name: string;
  filename?: string;
  type?: string;
  data: Buffer;
}

export function parseMultipart(body: Buffer, contentType: string): Part[] {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = Buffer.from(`--${m?.[1] ?? m?.[2] ?? ""}`);
  const parts: Part[] = [];
  let at = body.indexOf(boundary);
  while (at !== -1) {
    const start = at + boundary.length;
    if (body.subarray(start, start + 2).toString() === "--") break;
    const next = body.indexOf(boundary, start);
    if (next === -1) break;
    const raw = body.subarray(start + 2, next - 2); // skip the CRLF after the boundary and before the next one
    const split = raw.indexOf("\r\n\r\n");
    const head = raw.subarray(0, split).toString("utf8");
    const disposition = /content-disposition:[^\r\n]*/i.exec(head)?.[0] ?? "";
    const name = /\bname="([^"]*)"/.exec(disposition)?.[1] ?? "";
    const filename = /filename="([^"]*)"/.exec(disposition)?.[1];
    const type = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1];
    parts.push({ name, ...(filename !== undefined ? { filename } : {}), ...(type ? { type } : {}), data: raw.subarray(split + 4) });
    at = next;
  }
  return parts;
}
