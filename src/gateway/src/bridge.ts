import { createHash, randomBytes } from "node:crypto";
import type { Risk } from "@clawnexus/policy";

/**
 * What a tool bridge is allowed to be. A grant belongs to ONE Gateway session and carries that session's
 * principal, so a model that is steered by untrusted text can never do more than the person it works for
 * could do through the same policy, and never more than one session's worth.
 */
export interface BridgeGrant {
  readonly session: string;
  readonly principal: "owner" | "guest";
  readonly elevation?: Risk;
  /** Approvals are bound to this id, so one session's approval cannot be spent by another. */
  readonly principalId: string;
  readonly expiresAt: number;
  revoked: boolean;
}

export interface MintOptions {
  session: string;
  principal: "owner" | "guest";
  elevation?: Risk;
  ttlMs?: number;
}

const MAX_LIVE = 256;
const hash = (token: string): string => createHash("sha256").update(token).digest("hex");

/** Per-session, short-lived, revocable credentials for the model's tool bridge. Held in memory only. */
export class BridgeRegistry {
  private readonly byHash = new Map<string, BridgeGrant>();

  constructor(
    private readonly now: () => number,
    private readonly onRevoke: (g: BridgeGrant) => void,
  ) {}

  mint(o: MintOptions): { token: string; grant: BridgeGrant; revoke(): void } {
    this.prune();
    if (this.byHash.size >= MAX_LIVE) throw new Error("too many live tool bridges");
    const token = `cnb_${randomBytes(32).toString("base64url")}`;
    const grant: BridgeGrant = {
      session: o.session,
      principal: o.principal,
      ...(o.elevation === undefined ? {} : { elevation: o.elevation }),
      principalId: `agent:${o.session}`,
      expiresAt: this.now() + (o.ttlMs ?? 24 * 3600_000),
      revoked: false,
    };
    this.byHash.set(hash(token), grant);
    return { token, grant, revoke: () => this.revoke(grant) };
  }

  /** The grant for a presented token, or undefined if unknown, revoked or expired. */
  lookup(token: string): BridgeGrant | undefined {
    const g = this.byHash.get(hash(token));
    return g && this.live(g) ? g : undefined;
  }

  live(g: BridgeGrant): boolean {
    return !g.revoked && this.now() < g.expiresAt;
  }

  revoke(g: BridgeGrant): void {
    if (g.revoked) return;
    g.revoked = true;
    this.onRevoke(g);
  }

  revokeAll(): void {
    for (const g of this.byHash.values()) this.revoke(g);
    this.byHash.clear();
  }

  private prune(): void {
    for (const [h, g] of this.byHash) if (!this.live(g)) this.byHash.delete(h);
  }

  get size(): number {
    return this.byHash.size;
  }
}
