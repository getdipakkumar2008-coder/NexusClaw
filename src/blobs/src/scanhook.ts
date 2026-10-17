import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScanFile } from "./ingest.js";

export interface ScanHookOptions {
  /** The program to run. It gets one argument: the path of a copy of the file. */
  program: string;
  /** Arguments placed before the file path (the owner's hook takes none; this is for programs that need a script name). */
  args?: readonly string[];
  /** A private folder for the copies; each is removed as soon as the program ends. */
  workDir: string;
  /** Longer than this counts as a refusal. Default 30 seconds. */
  timeoutMs?: number;
}

const EXTENSION: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "application/pdf": ".pdf", "text/plain": ".txt" };

/** What the program said, made safe to show: one short line of printable characters. */
function oneLine(s: string): string {
  const clean = [...s].map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch)).join("").replace(/\s+/g, " ").trim();
  return clean.slice(0, 120);
}

/**
 * An owner-supplied check (for example a wrapper around an antivirus scanner) run on every file before it is kept.
 * Exit code 0 accepts the file; any other result, a timeout, or a program that cannot be started refuses it, so a
 * broken scanner never lets files through unchecked. The program runs with no shell, an empty environment apart from
 * the system paths, and only a copy of the file; it is a program the owner put in the data folder, so it runs with the
 * owner's rights, like any other thing the owner installs.
 */
export function scanHook(o: ScanHookOptions): ScanFile {
  return async ({ bytes, mime }) => {
    mkdirSync(o.workDir, { recursive: true, mode: 0o700 });
    // The copy gets a fixed name made here, never the sender's, so nothing a sender controls reaches a command line.
    const copy = join(o.workDir, `scan-${randomBytes(8).toString("hex")}${EXTENSION[mime] ?? ".bin"}`);
    writeFileSync(copy, bytes, { mode: 0o600 });
    try {
      return await new Promise<string | undefined>((resolve) => {
        const env: NodeJS.ProcessEnv = {};
        for (const k of ["PATH", "SystemRoot", "SYSTEMROOT", "TMPDIR", "TEMP", "TMP", "HOME", "USERPROFILE"]) if (process.env[k] !== undefined) env[k] = process.env[k];
        execFile(o.program, [...(o.args ?? []), copy], { timeout: o.timeoutMs ?? 30_000, env, windowsHide: true, maxBuffer: 64 * 1024, shell: false }, (error, stdout) => {
          if (!error) return resolve(undefined);
          const said = oneLine(String(stdout ?? ""));
          const code = (error as NodeJS.ErrnoException).code;
          const stopped = (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
          // Node stops a program for printing too much in the same way as for running too long; tell them apart.
          const chatty = code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
          resolve(chatty ? "the file check printed too much and was stopped" : stopped ? "the file check timed out" : typeof code === "string" ? "the file check could not be run" : said ? `the file check refused it: ${said}` : "the file check refused it");
        });
      });
    } finally {
      rmSync(copy, { force: true });
    }
  };
}

/**
 * Remove copies that a Gateway which died during a check left behind (they came from strangers' messages and were never
 * meant to outlive the check). Only files this module names are touched. Returns how many were removed.
 */
export function sweepScanTemp(workDir: string): number {
  let n = 0;
  try {
    for (const f of readdirSync(workDir)) {
      if (!/^scan-[0-9a-f]{16}.[a-z0-9]+$/.test(f)) continue;
      try {
        rmSync(join(workDir, f), { force: true });
        n++;
      } catch {
        /* in use or already gone */
      }
    }
  } catch {
    /* no folder yet */
  }
  return n;
}

/** The hook the owner installed, if any: a file named `scan` in `<data>/hooks`. */
export function findScanHook(dataDir: string): ScanHookOptions | undefined {
  const program = join(dataDir, "hooks", process.platform === "win32" ? "scan.exe" : "scan");
  try {
    if (existsSync(program) && statSync(program).isFile()) return { program, workDir: join(dataDir, "scan-tmp") };
  } catch {
    /* no hook */
  }
  return undefined;
}
