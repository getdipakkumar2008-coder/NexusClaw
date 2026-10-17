import type { ToolDef, ToolEnv } from "@clawnexus/tools";
import { z } from "zod";
import { MemoryError, type MemoryScope, type MemoryStore } from "./store.js";

/** Which notes a call may touch, or why none. Decided by the Gateway from the session, never by the model's arguments. */
export type ScopeDecision = { scope: MemoryScope } | { unavailable: string };

export interface MemoryToolDeps {
  store: MemoryStore;
  scopeFor(env: ToolEnv): ScopeDecision;
}

const name = z.string().min(1).max(64);

/**
 * The model's view of memory. There is no argument that chooses a scope: the notes it sees are the owner's when it
 * acts for the owner, the contact's own when it talks to a guest, and none in a group, where several people share the
 * conversation. Writes are low-risk workspace writes under the usual policy: the owner is asked while the context may
 * be influenced by others, and guests cannot write at all.
 */
export function memoryTools(deps: MemoryToolDeps): Array<ToolDef<any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const scoped = <T>(env: ToolEnv, use: (scope: MemoryScope) => T): T => {
    const d = deps.scopeFor(env);
    if ("unavailable" in d) throw new Error(d.unavailable);
    try {
      return use(d.scope);
    } catch (e) {
      // Say what went wrong in words the model can act on.
      if (e instanceof MemoryError) throw new Error(e.message);
      throw e;
    }
  };
  const actor = (env: ToolEnv) => ({ via: "model" as const, ...(env.session === undefined ? {} : { session: env.session }) });

  const search: ToolDef<{ query?: string | undefined; limit?: number | undefined }> = {
    name: "memory.search",
    description: "Search your saved notes for a word or phrase. With no query, lists the notes.",
    risk: 0,
    outputUntrusted: true,
    schema: z.strictObject({ query: z.string().max(200).optional(), limit: z.number().int().min(1).max(20).optional() }),
    async run(a, env) {
      return scoped(env, (scope) => {
        if (a.query === undefined || a.query.trim() === "") return { notes: deps.store.list(scope).map((f) => ({ name: f.name, bytes: f.bytes })) };
        return { matches: deps.store.search(scope, a.query, a.limit ?? 10) };
      });
    },
  };

  const read: ToolDef<{ name: string }> = {
    name: "memory.read",
    description: "Read one saved note.",
    risk: 0,
    outputUntrusted: true,
    schema: z.strictObject({ name }),
    async run(a, env) {
      return scoped(env, (scope) => {
        const r = deps.store.read(scope, a.name);
        return { name: r.name, content: r.content, truncated: r.truncated };
      });
    },
  };

  const write: ToolDef<{ name: string; content: string; mode?: "append" | "replace" | undefined }> = {
    name: "memory.write",
    description: "Save a note for later. Appends to the note by default; mode 'replace' overwrites it. Keep notes short and factual.",
    risk: 1,
    schema: z.strictObject({ name, content: z.string().min(1).max(40_000), mode: z.enum(["append", "replace"]).optional() }),
    async run(a, env) {
      return scoped(env, (scope) => {
        const r = deps.store.write(scope, a.name, a.content, a.mode ?? "append", actor(env));
        return { name: r.name, bytes: r.bytes };
      });
    },
  };

  const remove: ToolDef<{ name: string }> = {
    name: "memory.delete",
    description: "Delete one saved note.",
    risk: 1,
    schema: z.strictObject({ name }),
    async run(a, env) {
      return scoped(env, (scope) => {
        deps.store.delete(scope, a.name, actor(env));
        return { deleted: a.name };
      });
    },
  };

  return [search, read, write, remove];
}
