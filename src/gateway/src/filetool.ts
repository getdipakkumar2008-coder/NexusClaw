import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { BlobError, safeName, sniff, stripMetadata, type BlobStore } from "@clawnexus/blobs";
import type { ChannelManager } from "@clawnexus/channels";
import { ChannelFileError } from "@clawnexus/channels";
import type { SessionManager } from "@clawnexus/sessions";
import type { ToolDef } from "@clawnexus/tools";
import { z } from "zod";

export interface FileToolDeps {
  channels(): ChannelManager;
  sessions(): SessionManager | undefined;
  blobs(): BlobStore;
}

/** Biggest file the assistant may send (the same cap as for files coming in). */
export const MAX_SEND_BYTES = 8 * 1024 * 1024;

const EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "application/pdf": ".pdf", "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/mp4": ".m4a", "text/plain": ".txt" };

/**
 * The assistant sending a file to the person it is talking with. There is deliberately no destination argument: the
 * file goes into this session's own conversation and nowhere else. It is a network action (risk 2), so the owner's
 * approval is asked unless the owner has chosen the trusted profile and nothing untrusted is in the conversation, and a
 * guest cannot send files at all. What can be sent is limited the same way as what can be received: pictures, PDF, audio
 * and text, by content, up to 8 MB; pictures lose their hidden location and camera data on the way out.
 */
export function fileSendTool(deps: FileToolDeps): ToolDef<{ attachment?: string | undefined; path?: string | undefined; name?: string | undefined; caption?: string | undefined }> {
  return {
    name: "file.send",
    description:
      "Send a file to the person you are talking with, in this conversation. Give either `attachment` (the id of a file from this conversation) or `path` (a file in the workspace). Pictures, PDF, audio and text files up to 8 MB can be sent. `caption` is an optional short message to go with it.",
    risk: 2,
    schema: z
      .strictObject({
        attachment: z.string().regex(/^[0-9a-f]{64}$/, "an attachment id is 64 hexadecimal characters").optional(),
        path: z.string().min(1).max(500).optional(),
        name: z.string().min(1).max(100).optional(),
        caption: z.string().max(1000).optional(),
      })
      .refine((a) => (a.attachment === undefined) !== (a.path === undefined), "give exactly one of attachment or path"),
    async run(a, env) {
      const sessions = deps.sessions();
      if (!sessions || env.session === undefined) throw new Error("there is no conversation to send a file to");
      const blobs = deps.blobs();

      let bytes: Buffer;
      let name: string;
      if (a.attachment !== undefined) {
        if (!sessions.hasFile(env.session, a.attachment)) throw new Error("that file is not part of this conversation");
        const stored = blobs.read(a.attachment);
        if (stored === undefined) throw new Error("that file is no longer stored");
        bytes = stored;
        name = a.name ?? "file";
      } else {
        const abs = env.guard.resolve(a.path as string, "read");
        let size: number;
        try {
          const st = statSync(abs);
          if (!st.isFile()) throw new Error("that is not a file");
          size = st.size;
        } catch (e) {
          throw new Error(e instanceof Error && e.message === "that is not a file" ? e.message : "that file cannot be read");
        }
        if (size > MAX_SEND_BYTES) throw new Error(`the file is too large to send (${size} bytes; the limit is ${MAX_SEND_BYTES})`);
        bytes = readFileSync(abs);
        name = a.name ?? basename(abs);
      }
      if (bytes.length === 0) throw new Error("the file is empty");
      if (bytes.length > MAX_SEND_BYTES) throw new Error("the file is too large to send");
      const mime = sniff(bytes);
      if (mime === undefined) throw new Error("only pictures, PDF, audio and text files can be sent");
      bytes = stripMetadata(bytes, mime);
      let cleanName = safeName(name, 0);
      if (!/\.[A-Za-z0-9]{1,5}$/.test(cleanName)) cleanName += EXT[mime] ?? "";

      let id: string;
      try {
        id = blobs.put(bytes, mime).id;
      } catch (e) {
        if (e instanceof BlobError) throw new Error(e.code === "FULL" ? "the attachment store is full" : e.message);
        throw e;
      }
      const ref = { id, name: cleanName, mime, bytes: bytes.length };
      try {
        deps.channels().sendFile(env.session, ref, a.caption ?? "");
      } catch (e) {
        if (e instanceof ChannelFileError) throw new Error(e.message);
        throw e;
      }
      sessions.recordFileSent(env.session, ref, a.caption ?? "");
      return { queued: true, name: cleanName, type: mime, bytes: bytes.length };
    },
  };
}
