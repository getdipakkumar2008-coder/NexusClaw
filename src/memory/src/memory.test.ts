import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalStore } from "@clawnexus/policy";
import { EventLog, openDb, type Db } from "@clawnexus/store";
import { ToolExecutor, WorkspaceGuard, type CallResult } from "@clawnexus/tools";
import { MemoryError, MemoryStore, memoryTools, renderContext, type MemoryScope, type ScopeDecision } from "./index.js";

let dir: string;
let db: Db;
let events: EventLog;
let store: MemoryStore;
const owner: MemoryScope = { kind: "owner" };
const ann: MemoryScope = { kind: "contact", channel: "telegram", contact: "1001" };
const bob: MemoryScope = { kind: "contact", channel: "telegram", contact: "1002" };
const via = { via: "owner" as const };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cn-mem-"));
  db = openDb(join(dir, "g.db"));
  events = new EventLog(db);
  store = new MemoryStore(join(dir, "memory"), { db, events });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const fails = (fn: () => unknown, code: MemoryError["code"]): void => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(MemoryError);
    expect((e as MemoryError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
};
const allEvents = (): string => JSON.stringify(events.readSince(0, { limit: 5000 }));

describe("MemoryStore", () => {
  it("keeps notes as plain Markdown files the owner can read and edit", () => {
    store.write(owner, "preferences", "Likes short answers", "replace", via);
    const file = join(dir, "memory", "owner", "preferences.md");
    expect(readFileSync(file, "utf8")).toBe("Likes short answers\n");
    // an edit made in a text editor is seen at once, with no restart
    writeFileSync(file, "Likes long answers\n");
    expect(store.read(owner, "preferences").content).toBe("Likes long answers\n");
    // and so is a note created by hand
    writeFileSync(join(dir, "memory", "owner", "handmade.md"), "typed in an editor\n");
    expect(store.list(owner).map((f) => f.name)).toEqual(["handmade", "preferences"]);
  });

  it("keeps each contact's notes apart from everyone else's", () => {
    store.write(ann, "likes", "tea", "replace", via);
    store.write(bob, "likes", "coffee", "replace", via);
    store.write(owner, "likes", "water", "replace", via);
    expect(store.read(ann, "likes").content).toBe("tea\n");
    expect(store.read(bob, "likes").content).toBe("coffee\n");
    expect(store.read(owner, "likes").content).toBe("water\n");
    expect(store.search(ann, "coffee")).toEqual([]);
    expect(store.search(owner, "tea")).toEqual([]);
    expect(store.scopes().map((s) => (s.scope.kind === "owner" ? "owner" : s.scope.contact))).toEqual(["owner", "1001", "1002"]);
  });

  it("gives ids that differ only by case, or by odd characters, separate folders", () => {
    const a: MemoryScope = { kind: "contact", channel: "slack", contact: "U1ABC" };
    const b: MemoryScope = { kind: "contact", channel: "slack", contact: "u1abc" };
    const c: MemoryScope = { kind: "contact", channel: "matrix", contact: "@x:server.org" };
    const d: MemoryScope = { kind: "contact", channel: "matrix", contact: "@x:server_org" };
    store.write(a, "n", "upper", "replace", via);
    store.write(b, "n", "lower", "replace", via);
    store.write(c, "n", "dot", "replace", via);
    store.write(d, "n", "underscore", "replace", via);
    expect(store.read(a, "n").content).toBe("upper\n");
    expect(store.read(b, "n").content).toBe("lower\n");
    expect(store.read(c, "n").content).toBe("dot\n");
    expect(store.read(d, "n").content).toBe("underscore\n");
    // every folder name is lower-case, so a case-insensitive disk cannot merge two people
    const names = (root: string): string[] => readdirSync(root, { recursive: true }).map(String);
    expect(names(join(dir, "memory")).every((n) => n === n.toLowerCase() || /%[0-9A-F]{2}/.test(n))).toBe(true);
    expect(store.scopes().map((s) => (s.scope.kind === "contact" ? `${s.scope.channel}:${s.scope.contact}` : "owner")).sort()).toEqual(["matrix:@x:server.org", "matrix:@x:server_org", "slack:U1ABC", "slack:u1abc"]);
  });

  it("refuses names and ids that could point outside the folder", () => {
    for (const bad of ["../x", "a/b", "a\\b", ".hidden", "", "UPPER", "con", "nul.txt", "a.", "x.md", "a".repeat(65), "has space"]) fails(() => store.write(owner, bad, "x", "replace", via), "INVALID");
    for (const contact of ["", "with space", "x".repeat(65), "tab\t", "naïve"]) fails(() => store.write({ kind: "contact", channel: "telegram", contact }, "n", "x", "replace", via), "INVALID");
    fails(() => store.write({ kind: "contact", channel: "../x", contact: "1" }, "n", "x", "replace", via), "INVALID");
    // characters that look like a path are legal in an id, but are escaped, so they can never leave the memory folder
    const sly: MemoryScope = { kind: "contact", channel: "telegram", contact: "../../x" };
    store.write(sly, "n", "contained", "replace", via);
    expect(store.read(sly, "n").content).toBe("contained\n");
    expect(existsSync(join(dir, "x"))).toBe(false);
    expect(readdirSync(join(dir, "memory", "contacts", "ch-telegram"))).toEqual(["c-%2E%2E%2F%2E%2E%2Fx"]);
  });

  it("appends, replaces, and enforces size and count limits", () => {
    store.write(owner, "log", "one", "append", via);
    store.write(owner, "log", "two", "append", via);
    expect(store.read(owner, "log").content).toBe("one\ntwo\n");
    store.write(owner, "log", "fresh", "replace", via);
    expect(store.read(owner, "log").content).toBe("fresh\n");
    fails(() => store.write(owner, "big", "x".repeat(40_000), "replace", via), "TOO_LARGE");
    fails(() => store.write(owner, "bin", "a\u0000b", "replace", via), "INVALID");
    const small = new MemoryStore(join(dir, "m2"), { maxFiles: 2 });
    small.write(owner, "a", "1", "replace", via);
    small.write(owner, "b", "2", "replace", via);
    fails(() => small.write(owner, "c", "3", "replace", via), "LIMIT");
    small.write(owner, "a", "again", "replace", via); // changing an existing note is still fine
  });

  it("never follows a link out of the folder, and ignores things that are not notes", () => {
    const secret = join(dir, "secret.txt");
    writeFileSync(secret, "top secret");
    mkdirSync(join(dir, "memory", "owner"), { recursive: true });
    try {
      symlinkSync(secret, join(dir, "memory", "owner", "linked.md"));
    } catch {
      return; // creating links needs privileges on some Windows set-ups; nothing to test there
    }
    writeFileSync(join(dir, "memory", "owner", "Bad Name.md"), "ignored");
    writeFileSync(join(dir, "memory", "owner", "plain.txt"), "ignored");
    mkdirSync(join(dir, "memory", "owner", "folder.md"));
    expect(store.list(owner)).toEqual([]);
    fails(() => store.read(owner, "linked"), "NOT_FOUND");
    fails(() => store.write(owner, "linked", "overwrite", "replace", via), "INVALID");
    expect(readFileSync(secret, "utf8")).toBe("top secret");
  });

  it("reads only the start of an oversized note and says so", () => {
    writeFileSync(join(dir, "m3.md"), "");
    const s = new MemoryStore(join(dir, "m3"), { maxFileBytes: 100 });
    mkdirSync(join(dir, "m3", "owner"), { recursive: true });
    writeFileSync(join(dir, "m3", "owner", "huge.md"), "é".repeat(200));
    expect(s.list(owner)[0]).toMatchObject({ name: "huge", oversized: true });
    const r = s.read(owner, "huge");
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.content)).toBeLessThanOrEqual(100);
    expect(r.content).not.toContain("�");
    fails(() => s.write(owner, "huge", "more", "append", via), "TOO_LARGE");
  });

  it("finds notes by words, best match first", () => {
    store.write(owner, "pets", "Has a dog called Rex\nAlso a cat called Tom", "replace", via);
    store.write(owner, "food", "Allergic to peanuts", "replace", via);
    const hits = store.search(owner, "cat Tom");
    expect(hits[0]).toMatchObject({ name: "pets", line: 2, text: "Also a cat called Tom" });
    expect(store.search(owner, "peanuts").map((h) => h.name)).toEqual(["food"]);
    expect(store.search(owner, "zebra")).toEqual([]);
    expect(store.search(owner, "a")).toEqual([]);
  });

  it("records who changed what, but never the content, and names a contact only by a hash", () => {
    store.write(ann, "secrets", "the combination is 1234", "replace", { via: "model" });
    const log = allEvents();
    expect(log).toContain("memory.written");
    expect(log).toContain("secrets");
    expect(log).not.toContain("1234");
    expect(log).not.toContain("1001");
  });

  it("deletes a note, and tidies up the folders of a contact with none left", () => {
    store.write(ann, "likes", "tea", "replace", via);
    store.delete(ann, "likes", via);
    fails(() => store.read(ann, "likes"), "NOT_FOUND");
    fails(() => store.delete(ann, "likes", via), "NOT_FOUND");
    expect(existsSync(join(dir, "memory", "contacts"))).toBe(false);
  });

  it("erases one contact completely, including the record of changes, and leaves the rest alone", () => {
    store.write(ann, "likes", "tea", "replace", via);
    store.write(bob, "likes", "coffee", "replace", via);
    store.write(owner, "mine", "x", "replace", via);
    const before = events.readSince(0, { limit: 5000 }).length;
    expect(store.erase(ann)).toEqual({ files: 1 });
    expect(store.list(ann)).toEqual([]);
    expect(store.read(bob, "likes").content).toBe("coffee\n");
    expect(store.read(owner, "mine").content).toBe("x\n");
    expect(events.readSince(0, { limit: 5000 }).length).toBe(before - 1);
    expect(readdirSync(join(dir, "memory", "contacts", "ch-telegram"))).toHaveLength(1);
  });

  it("erases everything and leaves nothing behind in the files or the database", () => {
    store.write(owner, "mine", "x", "replace", via);
    store.write(ann, "likes", "tea", "replace", via);
    store.write(bob, "likes", "coffee", "replace", { via: "model", session: undefined });
    expect(store.erase("all")).toEqual({ files: 3 });
    expect(existsSync(join(dir, "memory"))).toBe(false);
    expect(store.scopes()).toEqual([]);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM events WHERE type LIKE 'memory.%'").get() as { n: number };
    expect(rows.n).toBe(0);
    // and the memory still works afterwards
    store.write(owner, "again", "y", "replace", via);
    expect(store.list(owner)).toHaveLength(1);
  });

  it("exports every note of a scope", () => {
    store.write(owner, "a", "1", "replace", via);
    store.write(owner, "b", "2", "replace", via);
    expect(store.export(owner)).toEqual([
      { name: "a", content: "1\n", truncated: false },
      { name: "b", content: "2\n", truncated: false },
    ]);
  });
});

describe("renderContext", () => {
  it("shows nothing when there are no notes, so an empty memory costs nothing", () => {
    expect(renderContext(store, owner)).toBeUndefined();
    store.write(owner, "empty", "   ", "replace", via);
    expect(renderContext(store, owner)).toBeUndefined();
  });

  it("labels notes as information, not instructions, and says whose they are", () => {
    store.write(owner, "prefs", "Short answers", "replace", via);
    store.write(ann, "likes", "Tea", "replace", via);
    expect(renderContext(store, owner)).toMatch(/owner keeps.*not instructions[\s\S]*## prefs\nShort answers/);
    expect(renderContext(store, ann)).toMatch(/person you are talking to[\s\S]*## likes\nTea/);
    expect(renderContext(store, ann)).not.toContain("Short answers");
  });

  it("stays within its budget and says what was left out", () => {
    for (let i = 0; i < 20; i++) store.write(owner, `note-${String(i).padStart(2, "0")}`, "word ".repeat(200), "replace", via);
    const text = renderContext(store, owner, 2000)!;
    expect(text.length).toBeLessThan(2400);
    expect(text).toMatch(/Not shown in full: note-/);
  });
});

describe("memory tools", () => {
  // The Gateway decides the scope from the session; here a table stands in for it.
  const sessions: Record<string, ScopeDecision> = {
    "s-ann": { scope: ann },
    "s-bob": { scope: bob },
    "s-group": { unavailable: "memory is not kept in group conversations" },
  };
  const exec = (): ToolExecutor =>
    new ToolExecutor({
      events,
      approvals: new ApprovalStore(),
      guard: new WorkspaceGuard([dir]),
      tools: memoryTools({
        store,
        scopeFor: (env) => (env.principal === "owner" ? { scope: owner } : env.principal === "guest" && env.session ? (sessions[env.session] ?? { unavailable: "no" }) : { unavailable: "no" }),
      }),
    });
  const call = (x: ToolExecutor, tool: string, args: unknown, who: "owner" | "guest", session?: string, tainted = false): Promise<CallResult> =>
    x.call({ tool, args, principal: who, principalId: who === "owner" ? "owner" : `agent:${session}`, profile: "standard", tainted, ...(session ? { session } : {}) });

  it("lets the owner's model read and search the owner's notes", async () => {
    const x = exec();
    store.write(owner, "prefs", "Short answers", "replace", via);
    store.write(ann, "likes", "tea", "replace", via);
    expect(await call(x, "memory.read", { name: "prefs" }, "owner")).toMatchObject({ status: "ok", output: { content: "Short answers\n" }, taints: true });
    expect(await call(x, "memory.search", {}, "owner")).toMatchObject({ output: { notes: [{ name: "prefs" }] } });
    expect(await call(x, "memory.search", { query: "tea" }, "owner")).toMatchObject({ output: { matches: [] } });
  });

  it("shows a guest only their own notes, whatever name or scope the model asks for", async () => {
    const x = exec();
    store.write(owner, "prefs", "owner private", "replace", via);
    store.write(ann, "likes", "tea", "replace", via);
    store.write(bob, "likes", "coffee", "replace", via);
    expect(await call(x, "memory.read", { name: "likes" }, "guest", "s-ann")).toMatchObject({ output: { content: "tea\n" } });
    expect(await call(x, "memory.read", { name: "likes" }, "guest", "s-bob")).toMatchObject({ output: { content: "coffee\n" } });
    expect(await call(x, "memory.read", { name: "prefs" }, "guest", "s-ann")).toMatchObject({ status: "error" });
    // there is no way to name another scope
    expect(await call(x, "memory.read", { name: "likes", scope: "owner" }, "guest", "s-ann")).toMatchObject({ status: "error", code: "INVALID_ARGS" });
    expect(await call(x, "memory.read", { name: "../owner/prefs" }, "guest", "s-ann")).toMatchObject({ status: "error" });
  });

  it("gives nothing in a group, and nothing to a caller with no conversation", async () => {
    const x = exec();
    store.write(ann, "likes", "tea", "replace", via);
    expect(await call(x, "memory.read", { name: "likes" }, "guest", "s-group")).toMatchObject({ status: "error", message: expect.stringMatching(/group/) });
    expect(await call(x, "memory.search", {}, "guest")).toMatchObject({ status: "error" });
  });

  it("applies the usual policy to writes: guests cannot, and the owner is asked while others may have influenced the model", async () => {
    const x = exec();
    expect(await call(x, "memory.write", { name: "n", content: "x" }, "guest", "s-ann")).toMatchObject({ status: "denied" });
    expect(await call(x, "memory.delete", { name: "n" }, "guest", "s-ann")).toMatchObject({ status: "denied" });
    expect(await call(x, "memory.write", { name: "n", content: "x" }, "owner", undefined, true)).toMatchObject({ status: "approval_required" });
    expect(store.list(owner)).toEqual([]);
    // an untainted owner call (typed at the terminal) goes straight through, and is recorded as the model's doing
    expect(await call(x, "memory.write", { name: "n", content: "x" }, "owner")).toMatchObject({ status: "ok", output: { name: "n" } });
    expect(store.read(owner, "n").content).toBe("x\n");
    expect(allEvents()).toContain('"via":"model"');
    expect(await call(x, "memory.delete", { name: "n" }, "owner")).toMatchObject({ status: "ok" });
    expect(store.list(owner)).toEqual([]);
  });

  it("appends by default so a careless write cannot wipe a note", async () => {
    const x = exec();
    await call(x, "memory.write", { name: "n", content: "one" }, "owner");
    await call(x, "memory.write", { name: "n", content: "two" }, "owner");
    expect(store.read(owner, "n").content).toBe("one\ntwo\n");
    await call(x, "memory.write", { name: "n", content: "three", mode: "replace" }, "owner");
    expect(store.read(owner, "n").content).toBe("three\n");
  });

  it("reports a problem in words the model can act on", async () => {
    const x = exec();
    expect(await call(x, "memory.read", { name: "missing" }, "owner")).toMatchObject({ status: "error", message: "no note called 'missing'" });
    expect(await call(x, "memory.write", { name: "Bad Name", content: "x" }, "owner")).toMatchObject({ status: "error", message: expect.stringMatching(/lower-case/) });
  });
});
