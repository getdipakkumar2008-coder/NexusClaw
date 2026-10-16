import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalStore } from "@clawnexus/policy";
import { EventLog, openDb, type Db } from "@clawnexus/store";
import { BUILTIN_TOOLS, PathError, ToolExecutor, WorkspaceGuard, childEnv, runCommand, summarizeArgs, type CallRequest } from "./index.js";

let base: string;
let ws: string;
let outside: string;
let db: Db;
let log: EventLog;
let approvals: ApprovalStore;
let guard: WorkspaceGuard;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "cn-tools-"));
  ws = join(base, "ws");
  outside = join(base, "outside");
  mkdirSync(ws);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "TOP-SECRET");
  db = openDb(join(base, "t.db"), { synchronous: "NORMAL" });
  log = new EventLog(db);
  approvals = new ApprovalStore();
  guard = new WorkspaceGuard([ws]);
});
afterEach(() => {
  db.close();
  rmSync(base, { recursive: true, force: true });
});

const node = process.execPath;
// Windows junctions need no special privilege; plain symlinks do, so the dangling-link test may be skipped there.
const dirLink = process.platform === "win32" ? "junction" : "dir";
const canSymlink = ((): boolean => {
  const d = mkdtempSync(join(tmpdir(), "cn-sym-"));
  try {
    symlinkSync(d, join(d, "l"), "file");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
})();

describe("WorkspaceGuard (T14)", () => {
  it("accepts paths inside the root, existing or not", () => {
    writeFileSync(join(ws, "a.txt"), "x");
    expect(guard.resolve("a.txt")).toBe(join(guard.primaryRoot, "a.txt"));
    expect(guard.resolve("new/dir/file.txt", "write")).toBe(join(guard.primaryRoot, "new", "dir", "file.txt"));
    expect(guard.resolve(".")).toBe(guard.primaryRoot);
  });

  it("rejects traversal and absolute paths outside the root", () => {
    for (const p of ["../outside/secret.txt", "a/../../outside/secret.txt", join(outside, "secret.txt"), "..", "../ws-evil"]) {
      expect(() => guard.resolve(p), p).toThrow(PathError);
    }
  });

  it("rejects malformed paths", () => {
    expect(() => guard.resolve("")).toThrow(/empty/);
    expect(() => guard.resolve("a\0b")).toThrow(/NUL/);
    expect(() => guard.resolve("x".repeat(5000))).toThrow(/too long/);
  });

  it.runIf(process.platform === "win32")("rejects Windows device paths and alternate data streams", () => {
    expect(() => guard.resolve("\\\\?\\C:\\Windows")).toThrow(/device/);
    expect(() => guard.resolve("file.txt:hidden")).toThrow(/':'/);
  });

  it("does not follow a symlink out of the workspace", () => {
    symlinkSync(outside, join(ws, "link"), dirLink);
    expect(() => guard.resolve("link/secret.txt")).toThrow(/outside/);
    expect(() => guard.resolve("link/new.txt", "write")).toThrow(/outside/);
  });

  it.runIf(canSymlink)("refuses a dangling symlink instead of writing through it", () => {
    symlinkSync(join(outside, "does-not-exist"), join(ws, "dangling"), "file");
    expect(() => guard.resolve("dangling", "write")).toThrow(PathError);
  });

  it("denies sensitive and write-protected segments", () => {
    mkdirSync(join(ws, ".ssh"));
    mkdirSync(join(ws, ".git"));
    expect(() => guard.resolve(".ssh/id_rsa")).toThrow(/not allowed/);
    if (process.platform === "win32" || process.platform === "darwin") expect(() => guard.resolve(".SSH/id_rsa")).toThrow(/not allowed/);
    expect(guard.resolve(".git/config")).toContain(".git"); // readable
    expect(() => guard.resolve(".git/hooks/pre-commit", "write")).toThrow(/writing/);
  });
});

describe("runCommand", () => {
  const opts = { cwd: process.cwd(), timeoutMs: 10_000, maxOutputBytes: 1024 };

  it("captures output and exit code, with no shell interpretation", async () => {
    const r = await runCommand({ ...opts, command: node, args: ["-e", "console.log(process.argv[1]); process.exit(3)", "a; echo injected $(id)"] });
    expect(r.exitCode).toBe(3);
    expect(r.stdout.trim()).toBe("a; echo injected $(id)");
  });

  it("truncates runaway output", async () => {
    const r = await runCommand({ ...opts, command: node, args: ["-e", "process.stdout.write('x'.repeat(100000))"] });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBe(1024);
  });

  it("times out and kills the process", async () => {
    const r = await runCommand({ ...opts, timeoutMs: 300, command: node, args: ["-e", "setInterval(()=>{},1000)"] });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode === 0).toBe(false);
    expect(r.durationMs).toBeLessThan(5000);
  });

  it("kills the whole process tree", async () => {
    const marker = join(base, "grandchild-alive");
    const grandchild = `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'x'),1500)`;
    const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'inherit'}); setInterval(()=>{},1000)`;
    const r = await runCommand({ ...opts, timeoutMs: 400, command: node, args: ["-e", parent] });
    expect(r.timedOut).toBe(true);
    await new Promise((res) => setTimeout(res, 2200));
    expect(existsSync(marker)).toBe(false);
  });

  it("stops on abort", async () => {
    const ac = new AbortController();
    const p = runCommand({ ...opts, command: node, args: ["-e", "setInterval(()=>{},1000)"], signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    expect((await p).cancelled).toBe(true);
  });

  it("reports a missing program instead of throwing", async () => {
    const r = await runCommand({ ...opts, command: "definitely-not-a-real-program-xyz" });
    expect(r.exitCode).toBeNull();
    expect(r.stderr).toMatch(/failed to start/);
  });

  it("does not leak secrets from the parent environment", async () => {
    process.env.CLAWNEXUS_TEST_SECRET = "s3cr3t";
    try {
      expect(childEnv().CLAWNEXUS_TEST_SECRET).toBeUndefined();
      const r = await runCommand({ ...opts, command: node, args: ["-e", "console.log(process.env.CLAWNEXUS_TEST_SECRET ?? 'unset')"] });
      expect(r.stdout.trim()).toBe("unset");
    } finally {
      delete process.env.CLAWNEXUS_TEST_SECRET;
    }
  });
});

describe("ToolExecutor", () => {
  const make = (): ToolExecutor => new ToolExecutor({ events: log, approvals, guard, tools: BUILTIN_TOOLS });
  const owner = (over: Partial<CallRequest> & Pick<CallRequest, "tool" | "args">): CallRequest => ({
    principal: "owner",
    principalId: "owner",
    profile: "standard",
    tainted: false,
    ...over,
  });
  const types = (): string[] => log.readSince(0).map((e) => e.type);

  it("rejects unknown tools and invalid arguments before anything else", async () => {
    const x = make();
    expect(await x.call(owner({ tool: "nope", args: {} }))).toMatchObject({ status: "error", code: "UNKNOWN_TOOL" });
    expect(await x.call(owner({ tool: "fs.read", args: { path: "a", extra: 1 } }))).toMatchObject({ status: "error", code: "INVALID_ARGS" });
    expect(await x.call(owner({ tool: "fs.read", args: {} }))).toMatchObject({ status: "error", code: "INVALID_ARGS" });
    expect(approvals.list()).toHaveLength(0);
  });

  it("owner reads and writes in the workspace without prompts (R0/R1)", async () => {
    const x = make();
    const w = await x.call(owner({ tool: "fs.write", args: { path: "notes/a.txt", content: "hello" } }));
    expect(w).toMatchObject({ status: "ok" });
    const r = await x.call(owner({ tool: "fs.read", args: { path: "notes/a.txt" } }));
    expect(r).toMatchObject({ status: "ok", taints: true, output: { content: "hello", truncated: false } });
    expect(readFileSync(join(ws, "notes", "a.txt"), "utf8")).toBe("hello");
    expect(types()).toEqual(["tool.started", "tool.completed", "tool.started", "tool.completed"]);
  });

  it("fs.write refuses to clobber unless asked, and never touches .git", async () => {
    const x = make();
    await x.call(owner({ tool: "fs.write", args: { path: "a.txt", content: "1" } }));
    expect(await x.call(owner({ tool: "fs.write", args: { path: "a.txt", content: "2" } }))).toMatchObject({ status: "error", code: "FAILED" });
    expect(await x.call(owner({ tool: "fs.write", args: { path: "a.txt", content: "2", overwrite: true } }))).toMatchObject({ status: "ok" });
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("2");
    expect(await x.call(owner({ tool: "fs.write", args: { path: ".git/hooks/x", content: "evil" } }))).toMatchObject({ status: "error" });
    expect(existsSync(join(ws, ".git"))).toBe(false);
  });

  it("file tools cannot leave the workspace", async () => {
    const x = make();
    const r = await x.call(owner({ tool: "fs.read", args: { path: "../outside/secret.txt" } }));
    expect(r).toMatchObject({ status: "error", code: "FAILED" });
    expect(JSON.stringify(r)).not.toContain("TOP-SECRET");
  });

  it("fs.read truncates and rejects binary files", async () => {
    writeFileSync(join(ws, "big.txt"), "y".repeat(5000));
    writeFileSync(join(ws, "bin.dat"), Buffer.from([1, 2, 0, 3]));
    const x = make();
    const big = await x.call(owner({ tool: "fs.read", args: { path: "big.txt", maxBytes: 100 } }));
    expect(big).toMatchObject({ status: "ok", output: { truncated: true } });
    expect((big as { output: { content: string } }).output.content).toHaveLength(100);
    expect(await x.call(owner({ tool: "fs.read", args: { path: "bin.dat" } }))).toMatchObject({ status: "error" });
  });

  it("exec needs approval; the approval is single use and bound to the exact call", async () => {
    const x = make();
    const args = { command: node, args: ["-e", "console.log('hi')"] };
    const first = await x.call(owner({ tool: "exec.run", args }));
    expect(first.status).toBe("approval_required");
    const id = (first as { approvalId: string }).approvalId;
    expect(types()).toContain("approval.requested");

    // still pending
    expect((await x.call(owner({ tool: "exec.run", args, approvalId: id }))).status).toBe("approval_required");

    approvals.decide(id, true, { kind: "owner", id: "owner" });
    // different arguments -> rejected, approval not spent
    const other = await x.call(owner({ tool: "exec.run", args: { command: node, args: ["-e", "console.log('evil')"] }, approvalId: id }));
    expect(other).toMatchObject({ status: "error", code: "BAD_APPROVAL" });

    const ok = await x.call(owner({ tool: "exec.run", args, approvalId: id }));
    expect(ok).toMatchObject({ status: "ok", taints: true });
    expect((ok as { output: { stdout: string } }).output.stdout.trim()).toBe("hi");

    // replay -> rejected
    expect(await x.call(owner({ tool: "exec.run", args, approvalId: id }))).toMatchObject({ status: "error", code: "BAD_APPROVAL" });
  });

  it("a denied approval stops the call", async () => {
    const x = make();
    const args = { command: node, args: ["-e", "1"] };
    const id = ((await x.call(owner({ tool: "exec.run", args }))) as { approvalId: string }).approvalId;
    approvals.decide(id, false, { kind: "owner", id: "owner" });
    expect(await x.call(owner({ tool: "exec.run", args, approvalId: id }))).toMatchObject({ status: "denied" });
  });

  it("an approval cannot be used by a different caller", async () => {
    const x = make();
    const args = { command: node, args: ["-e", "1"] };
    const id = ((await x.call(owner({ tool: "exec.run", args }))) as { approvalId: string }).approvalId;
    approvals.decide(id, true, { kind: "owner", id: "owner" });
    const stolen = await x.call({ ...owner({ tool: "exec.run", args, approvalId: id }), principalId: "someone-else" });
    expect(stolen).toMatchObject({ status: "error", code: "BAD_APPROVAL" });
  });

  it("guests and unpaired senders cannot run anything above R0", async () => {
    const x = make();
    const guest = (tool: string, args: unknown): CallRequest => ({ tool, args, principal: "guest", principalId: "g1", profile: "standard", tainted: true });
    expect(await x.call(guest("fs.write", { path: "a", content: "x" }))).toMatchObject({ status: "denied" });
    expect(await x.call(guest("exec.run", { command: node }))).toMatchObject({ status: "denied" });
    expect(await x.call({ ...guest("fs.read", { path: "a" }), principal: "unpaired" })).toMatchObject({ status: "denied" });
    expect(approvals.list()).toHaveLength(0);
    expect(existsSync(join(ws, "a"))).toBe(false);
  });

  it("after untrusted content, a workspace write needs approval", async () => {
    const x = make();
    const r = await x.call(owner({ tool: "fs.write", args: { path: "a.txt", content: "x" }, tainted: true }));
    expect(r.status).toBe("approval_required");
    expect(existsSync(join(ws, "a.txt"))).toBe(false);
  });

  it("times out a slow tool and can be cancelled", async () => {
    const slow = {
      name: "slow",
      description: "",
      risk: 0 as const,
      timeoutMs: 100,
      schema: z.strictObject({}),
      run: () => new Promise<never>(() => undefined),
    };
    const x = new ToolExecutor({ events: log, approvals, guard, tools: [slow], abortGraceMs: 50 });
    expect(await x.call(owner({ tool: "slow", args: {} }))).toMatchObject({ status: "error", code: "TIMEOUT" });
    const ac = new AbortController();
    const p = new ToolExecutor({ events: log, approvals, guard, tools: [{ ...slow, timeoutMs: 10_000 }], abortGraceMs: 50 }).call(owner({ tool: "slow", args: {}, signal: ac.signal }));
    setTimeout(() => ac.abort(), 50);
    expect(await p).toMatchObject({ status: "error", code: "CANCELLED" });
  });

  it("exec through the executor kills the process on cancel", async () => {
    const x = make();
    const args = { command: node, args: ["-e", "setInterval(()=>{},1000)"] };
    const id = ((await x.call(owner({ tool: "exec.run", args }))) as { approvalId: string }).approvalId;
    approvals.decide(id, true, { kind: "owner", id: "owner" });
    const ac = new AbortController();
    const p = x.call(owner({ tool: "exec.run", args, approvalId: id, signal: ac.signal }));
    setTimeout(() => ac.abort(), 200);
    expect(await p).toMatchObject({ status: "error", code: "CANCELLED" });
  });

  it("audits every outcome and redacts secrets in arguments", async () => {
    const x = make();
    await x.call(owner({ tool: "fs.write", args: { path: "a.txt", content: "x" }, session: "s_1" }));
    await x.call({ tool: "fs.write", args: { path: "a", content: "x" }, principal: "guest", principalId: "g", profile: "standard", tainted: false });
    expect(types()).toEqual(["tool.started", "tool.completed", "tool.denied"]);
    expect(log.readSince(0, { session: "s_1" })).toHaveLength(2);
    const s = summarizeArgs({ path: "p", apiKey: "sk-123", nested: { password: "hunter2", note: "ok" }, big: "z".repeat(500) });
    expect(s).not.toContain("sk-123");
    expect(s).not.toContain("hunter2");
    expect(s).toContain("[redacted]");
    expect(s).toContain("500 chars");
  });

  it("rejects duplicate tool names", () => {
    expect(() => new ToolExecutor({ events: log, approvals, guard, tools: [BUILTIN_TOOLS[0], BUILTIN_TOOLS[0]] })).toThrow(/duplicate/);
  });
});
