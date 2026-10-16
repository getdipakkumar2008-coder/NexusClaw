import { createHash, randomBytes } from "node:crypto";
import type { PrincipalKind } from "./decide.js";

/** Deterministic JSON: object keys sorted recursively. Rejects values that are not plain JSON. */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new TypeError("non-finite number in tool arguments");
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : walk(x)));
    if (typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) {
        const child = (v as Record<string, unknown>)[k];
        if (child !== undefined) out[k] = walk(child);
      }
      return out;
    }
    throw new TypeError(`unsupported value of type ${typeof v} in tool arguments`);
  };
  return JSON.stringify(walk(value));
}

/** Binds an approval to the exact call: tool name plus canonical arguments. */
export function approvalKey(tool: string, args: unknown): string {
  return createHash("sha256").update(`${tool}\n${canonicalJson(args)}`).digest("hex");
}

export type ApprovalState = "pending" | "approved" | "denied" | "expired" | "consumed";

export interface Approval {
  id: string;
  key: string;
  tool: string;
  requester: string;
  state: ApprovalState;
  createdAt: number;
  expiresAt: number;
  decidedBy?: string;
}

export class ApprovalError extends Error {}

/**
 * In-memory approval ledger (persisted elsewhere via the event log). Properties enforced here:
 * only the owner can decide; an approval is bound to one exact call; single use; expires.
 */
export class ApprovalStore {
  private readonly items = new Map<string, Approval>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 5 * 60_000,
  ) {}

  create(input: { tool: string; args: unknown; requester: string }): Approval {
    const t = this.now();
    const a: Approval = {
      id: randomBytes(16).toString("hex"),
      key: approvalKey(input.tool, input.args),
      tool: input.tool,
      requester: input.requester,
      state: "pending",
      createdAt: t,
      expiresAt: t + this.ttlMs,
    };
    this.items.set(a.id, a);
    return { ...a };
  }

  /** Only a verified owner may decide; the caller passes the authenticated principal kind. */
  decide(id: string, approve: boolean, decider: { kind: PrincipalKind; id: string }): Approval {
    if (decider.kind !== "owner") throw new ApprovalError("only the owner can decide approvals");
    const a = this.live(id);
    if (a.state !== "pending") throw new ApprovalError(`approval is already ${a.state}`);
    a.state = approve ? "approved" : "denied";
    a.decidedBy = decider.id;
    return { ...a };
  }

  /** Atomically spend an approval for exactly this call. True only once, only if approved and unexpired. */
  consume(id: string, tool: string, args: unknown): boolean {
    const a = this.items.get(id);
    if (!a) return false;
    this.live(id);
    if (a.state !== "approved") return false;
    if (a.key !== approvalKey(tool, args)) return false;
    a.state = "consumed";
    return true;
  }

  /** Approvals in the given state (default: pending), oldest first. Expired entries are updated first. */
  list(state: ApprovalState = "pending"): Approval[] {
    for (const id of [...this.items.keys()]) this.live(id);
    return [...this.items.values()].filter((a) => a.state === state).sort((a, b) => a.createdAt - b.createdAt).map((a) => ({ ...a }));
  }

  get(id: string): Approval | undefined {
    const a = this.items.get(id);
    if (!a) return undefined;
    this.live(id);
    return { ...a };
  }

  private live(id: string): Approval {
    const a = this.items.get(id);
    if (!a) throw new ApprovalError("unknown approval");
    if ((a.state === "pending" || a.state === "approved") && this.now() >= a.expiresAt) a.state = "expired";
    return a;
  }
}
