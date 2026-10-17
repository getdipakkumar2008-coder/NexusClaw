import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliError } from "./client.js";
import { exportToFolder } from "./exportdir.js";

const ID1 = "a".repeat(64);
const ID2 = "b".repeat(64);
const line = (text: string, files: Array<{ id: string; name: string }>): string => JSON.stringify({ role: "user", sender: "u", content: text, ts: 1, files });
const JSONL = [line("one", [{ id: ID1, name: "../../evil name.png" }]), line("two", [{ id: ID2, name: "doc.txt" }])].join("\n") + "\n";

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "cn-export-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const store: Record<string, string> = { [ID1]: Buffer.from("picture").toString("base64"), [ID2]: Buffer.from("text").toString("base64") };
const call = async (method: string, params: unknown): Promise<unknown> => {
  if (method === "blob.get") {
    const data = store[(params as { id: string }).id];
    if (data === undefined) throw new Error("no such file");
    return { data };
  }
  if (method === "session.get") return { messages: [{ attachments: [{ id: ID1, name: "p.png" }, { id: ID2, name: "q.txt" }] }] };
  throw new Error("unexpected " + method);
};

describe("saving a conversation and its files to a folder", () => {
  it("writes the transcript and every file, under names made here", async () => {
    const root = join(dir, "out");
    const r = await exportToFolder({ root, format: "jsonl", content: JSONL, session: "s1", call, force: false });
    expect(r).toMatchObject({ saved: 2, missing: [] });
    expect(readFileSync(join(root, "transcript.jsonl"), "utf8")).toBe(JSONL);
    const names = readdirSync(join(root, "files")).sort();
    expect(names).toEqual([`${ID1.slice(0, 12)}-evil name.png`, `${ID2.slice(0, 12)}-doc.txt`].sort());
    expect(readFileSync(join(root, "files", `${ID2.slice(0, 12)}-doc.txt`), "utf8")).toBe("text");
  });

  it("saves the rest and says which files are gone, instead of stopping half-way", async () => {
    const root = join(dir, "out");
    const gone = async (m: string, p: unknown): Promise<unknown> => {
      if (m === "blob.get" && (p as { id: string }).id === ID1) throw new Error("no such file");
      return call(m, p);
    };
    const r = await exportToFolder({ root, format: "jsonl", content: JSONL, session: "s1", call: gone, force: false });
    expect(r.saved).toBe(1);
    expect(r.missing).toEqual([{ id: ID1, name: "../../evil name.png" }]);
    expect(readdirSync(join(root, "files"))).toEqual([`${ID2.slice(0, 12)}-doc.txt`]);
    expect(readFileSync(join(root, "transcript.jsonl"), "utf8")).toBe(JSONL); // the conversation itself is complete
  });

  it("finds the files of a Markdown export by asking for the messages", async () => {
    const root = join(dir, "out");
    const r = await exportToFolder({ root, format: "markdown", content: "# chat\n", session: "s1", call, force: false });
    expect(r.saved).toBe(2);
    expect(readdirSync(root).sort()).toEqual(["files", "transcript.md"]);
  });

  it("explains instead of failing with a raw error when the target is a file or a folder that is not empty", async () => {
    const file = join(dir, "a-file");
    writeFileSync(file, "x");
    await expect(exportToFolder({ root: file, format: "jsonl", content: JSONL, session: "s1", call, force: false })).rejects.toMatchObject({ code: "EXISTS", message: expect.stringMatching(/is a file, not a folder/) });
    const full = join(dir, "full");
    await exportToFolder({ root: full, format: "jsonl", content: JSONL, session: "s1", call, force: false });
    await expect(exportToFolder({ root: full, format: "jsonl", content: JSONL, session: "s1", call, force: false })).rejects.toBeInstanceOf(CliError);
    await expect(exportToFolder({ root: full, format: "jsonl", content: JSONL, session: "s1", call, force: true })).resolves.toMatchObject({ saved: 2 });
  });

  it("keeps the transcript as private as the files (owner only where the system has modes)", async () => {
    if (process.platform === "win32") return;
    const root = join(dir, "out");
    await exportToFolder({ root, format: "jsonl", content: JSONL, session: "s1", call, force: false });
    expect(statSync(join(root, "transcript.jsonl")).mode & 0o077).toBe(0);
    expect(statSync(join(root, "files", `${ID2.slice(0, 12)}-doc.txt`)).mode & 0o077).toBe(0);
  });

  it("tolerates a damaged line in the transcript", async () => {
    const root = join(dir, "out");
    const r = await exportToFolder({ root, format: "jsonl", content: `${JSONL}{"files": broken\n`, session: "s1", call, force: false });
    expect(r.saved).toBe(2);
  });
});
