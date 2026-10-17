import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "./client.js";

type Call = (method: string, params: unknown) => Promise<unknown>;

export interface ExportResult {
  saved: number;
  /** Files the conversation mentions that the Gateway no longer has (cleaned up since). */
  missing: Array<{ id: string; name: string }>;
}

/**
 * Save a conversation and the files that came with it into a folder, so nothing in it is left behind. A file the Gateway
 * no longer holds is reported and skipped; it does not stop the rest from being saved. File names are made here, never
 * taken from the sender.
 */
export async function exportToFolder(o: { root: string; format: string; content: string; session: string; call: Call; force: boolean }): Promise<ExportResult> {
  const { root } = o;
  if (existsSync(root)) {
    if (!statSync(root).isDirectory()) throw new CliError("EXISTS", `${root} is a file, not a folder`, "Choose a folder name that does not exist yet.");
    if (readdirSync(root).length > 0 && !o.force) throw new CliError("EXISTS", `${root} is not empty`, "Choose a new folder, or pass --force.");
  }
  mkdirSync(join(root, "files"), { recursive: true });
  writeFileSync(join(root, o.format === "markdown" ? "transcript.md" : "transcript.jsonl"), o.content, { mode: 0o600 });

  const ids = new Map<string, string>();
  if (o.format === "jsonl") {
    for (const line of o.content.split(String.fromCharCode(10))) {
      if (!line.includes('"files"')) continue;
      try {
        for (const f of (JSON.parse(line) as { files?: Array<{ id?: string; name: string }> }).files ?? []) if (f.id) ids.set(f.id, f.name);
      } catch {
        /* a damaged line has no files to save */
      }
    }
  } else {
    const m = (await o.call("session.get", { session: o.session })) as { messages: Array<{ attachments?: Array<{ id?: string; name: string }> }> };
    for (const msg of m.messages) for (const f of msg.attachments ?? []) if (f.id) ids.set(f.id, f.name);
  }

  const result: ExportResult = { saved: 0, missing: [] };
  for (const [id, name] of ids) {
    let data: string;
    try {
      data = ((await o.call("blob.get", { id })) as { data: string }).data;
    } catch {
      result.missing.push({ id, name });
      continue;
    }
    const bare = (name.split(/[\\/]/).pop() ?? "file").replace(/[^\w. -]/g, "_") || "file";
    writeFileSync(join(root, "files", `${id.slice(0, 12)}-${bare}`), Buffer.from(data, "base64"), { mode: 0o600 });
    result.saved++;
  }
  return result;
}
