import { spawn } from "node:child_process";

export interface ExecOptions {
  /** Program and arguments. No shell is involved, so metacharacters in arguments are inert. */
  command: string;
  args?: readonly string[];
  cwd: string;
  timeoutMs: number;
  /** stdout and stderr are each kept up to this many bytes; the rest is dropped and `truncated` is set. */
  maxOutputBytes: number;
  signal?: AbortSignal;
  /** Extra environment variables on top of the minimal inherited set. */
  env?: Record<string, string>;
}

export interface ExecResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

/** Variables a child may inherit. Everything else (API keys, tokens, cloud credentials) is withheld. */
const INHERIT = [
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR",
  "HOME", "USERPROFILE", "LANG", "LC_ALL", "TERM", "TZ", "SHELL", "USER", "LOGNAME",
];

export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && INHERIT.includes(k.toUpperCase())) out[k] = v;
  }
  return { ...out, ...extra };
}

/** Kill the process and everything it started. */
export function killTree(pid: number): void {
  if (process.platform === "win32") {
    // taskkill /T walks the process tree; /F forces it.
    const k = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    k.on("error", () => undefined);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL"); // negative pid = the whole process group (the child leads its own group)
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

export function runCommand(o: ExecOptions): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const child = spawn(o.command, [...(o.args ?? [])], {
      cwd: o.cwd,
      env: childEnv(o.env),
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (r: Partial<ExecResult> & { exitCode: number | null; signal: string | null }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      resolvePromise({ stdout, stderr, truncated, timedOut, cancelled, durationMs: Date.now() - started, ...r });
    };

    const stop = (): void => {
      if (child.pid !== undefined) killTree(child.pid);
      // If a grandchild escaped the kill and still holds our pipes, do not wait for them forever.
      setTimeout(() => finish({ exitCode: null, signal: "SIGKILL" }), 2_000).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, o.timeoutMs);
    timer.unref();
    const onAbort = (): void => {
      cancelled = true;
      stop();
    };
    if (o.signal?.aborted) onAbort();
    else o.signal?.addEventListener("abort", onAbort, { once: true });

    const collect = (which: "out" | "err") => (chunk: Buffer) => {
      const used = which === "out" ? outBytes : errBytes;
      const room = o.maxOutputBytes - used;
      if (room <= 0) {
        truncated = true;
        return;
      }
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (piece.length < chunk.length) truncated = true;
      if (which === "out") {
        outBytes += piece.length;
        stdout += piece.toString("utf8");
      } else {
        errBytes += piece.length;
        stderr += piece.toString("utf8");
      }
    };
    child.stdout.on("data", collect("out"));
    child.stderr.on("data", collect("err"));

    child.on("error", (e) => {
      stderr += `failed to start: ${e.message}`;
      finish({ exitCode: null, signal: null });
    });
    // 'close' (not 'exit') so buffered output has been fully read.
    child.on("close", (code, signal) => finish({ exitCode: code, signal }));
  });
}
