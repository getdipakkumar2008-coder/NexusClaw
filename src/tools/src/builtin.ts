import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { ToolDef } from "./executor.js";
import { PathError } from "./guard.js";
import { runCommand } from "./exec.js";

export const MAX_READ_BYTES = 256 * 1024;
export const MAX_WRITE_BYTES = 1024 * 1024;

const fsRead: ToolDef<{ path: string; maxBytes?: number | undefined }> = {
  name: "fs.read",
  description: "Read a UTF-8 text file inside the workspace.",
  risk: 0,
  outputUntrusted: true,
  schema: z.strictObject({ path: z.string(), maxBytes: z.number().int().positive().max(MAX_READ_BYTES).optional() }),
  async run(a, { guard }) {
    const p = guard.resolve(a.path, "read");
    const st = lstatSync(p);
    if (!st.isFile()) throw new Error("not a regular file");
    const limit = a.maxBytes ?? MAX_READ_BYTES;
    const buf = Buffer.alloc(Math.min(limit, st.size) + 1);
    const fd = openSync(p, "r");
    let n: number;
    try {
      n = readSync(fd, buf, 0, buf.length, 0);
    } finally {
      closeSync(fd);
    }
    const truncated = n > limit;
    const data = buf.subarray(0, Math.min(n, limit));
    if (data.includes(0)) throw new Error("binary file");
    return { path: p, content: data.toString("utf8"), truncated, size: st.size };
  },
};

const fsList: ToolDef<{ path: string }> = {
  name: "fs.list",
  description: "List a directory inside the workspace.",
  risk: 0,
  outputUntrusted: true,
  schema: z.strictObject({ path: z.string().default(".") }),
  async run(a, { guard }) {
    const p = guard.resolve(a.path, "read");
    const entries = readdirSync(p, { withFileTypes: true }).slice(0, 1000);
    return { path: p, entries: entries.map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : e.isSymbolicLink() ? "symlink" : "file" })) };
  },
};

const fsWrite: ToolDef<{ path: string; content: string; overwrite?: boolean | undefined }> = {
  name: "fs.write",
  description: "Write a UTF-8 text file inside the workspace. Refuses to replace an existing file unless overwrite is true.",
  risk: 1,
  schema: z.strictObject({ path: z.string(), content: z.string(), overwrite: z.boolean().optional() }),
  async run(a, { guard }) {
    if (Buffer.byteLength(a.content, "utf8") > MAX_WRITE_BYTES) throw new Error(`content exceeds ${MAX_WRITE_BYTES} bytes`);
    const p = guard.resolve(a.path, "write");
    let existing: ReturnType<typeof lstatSync> | undefined;
    try {
      existing = lstatSync(p);
    } catch {
      existing = undefined;
    }
    if (existing) {
      if (existing.isSymbolicLink()) throw new PathError("INVALID", "refusing to write through a symbolic link");
      if (!existing.isFile()) throw new Error("not a regular file");
      if (a.overwrite !== true) throw new Error("file exists; pass overwrite: true to replace it");
    }
    mkdirSync(dirname(p), { recursive: true });
    // Write beside the target and rename, so a crash never leaves a half-written file.
    const tmp = join(dirname(p), `.${basename(p)}.${process.pid}.tmp`);
    writeFileSync(tmp, a.content, { flag: "w", mode: 0o600 });
    renameSync(tmp, p);
    return { path: p, bytes: Buffer.byteLength(a.content, "utf8") };
  },
};

const MAX_EXEC_TIMEOUT_MS = 10 * 60_000;
const execRun: ToolDef<{ command: string; args?: string[] | undefined; cwd?: string | undefined; timeoutMs?: number | undefined }> = {
  name: "exec.run",
  description: "Run a program (no shell) with arguments, in the workspace. Output is capped; the whole process tree is killed on timeout or cancel.",
  risk: 3,
  outputUntrusted: true,
  timeoutMs: MAX_EXEC_TIMEOUT_MS + 5_000,
  schema: z.strictObject({
    command: z.string().min(1).max(1024),
    args: z.array(z.string().max(8192)).max(256).optional(),
    cwd: z.string().optional(),
    timeoutMs: z.number().int().positive().max(MAX_EXEC_TIMEOUT_MS).optional(),
  }),
  async run(a, { guard, signal }) {
    const cwd = guard.resolve(a.cwd ?? ".", "read");
    const r = await runCommand({
      command: a.command,
      args: a.args ?? [],
      cwd,
      timeoutMs: a.timeoutMs ?? 60_000,
      maxOutputBytes: 64 * 1024,
      signal,
    });
    return r;
  },
};

export const BUILTIN_TOOLS = [fsRead, fsList, fsWrite, execRun] as const;
