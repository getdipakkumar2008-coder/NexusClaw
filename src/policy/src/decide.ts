/**
 * Tool policy decision (docs/06 section 4). Pure and deterministic: same input, same decision.
 *
 * Risk classes:
 *   0 read-only/harmless   1 workspace write   2 network/egress
 *   3 host exec            4 irreversible or external side effects (send message, payment, delete)
 */
export type Risk = 0 | 1 | 2 | 3 | 4;
export const RISKS: readonly Risk[] = [0, 1, 2, 3, 4];

export type PrincipalKind = "owner" | "guest" | "unpaired" | "remote-agent";
export const PRINCIPALS: readonly PrincipalKind[] = ["owner", "guest", "unpaired", "remote-agent"];

export type Profile = "standard" | "locked-down" | "trusted";
export const PROFILES: readonly Profile[] = ["standard", "locked-down", "trusted"];

export interface ToolDescriptor {
  name: string;
  risk: Risk;
}

export interface CallContext {
  principal: PrincipalKind;
  profile: Profile;
  /** True when the run's context contains untrusted content (inbound from others, web pages, tool output). */
  tainted: boolean;
  /** True when the tool will execute inside a sandbox backend. */
  sandboxed: boolean;
  /**
   * Highest risk class the owner has explicitly delegated to a non-owner principal (guest or remote agent).
   * Undefined means none beyond the default (guest: R0 only; remote agent: nothing).
   */
  elevation?: Risk;
}

export type Effect = "allow" | "ask" | "deny";
export interface Decision {
  effect: Effect;
  reason: string;
}

const allow = (reason: string): Decision => ({ effect: "allow", reason });
const ask = (reason: string): Decision => ({ effect: "ask", reason });
const deny = (reason: string): Decision => ({ effect: "deny", reason });

/** Largest risk a non-owner may ever be delegated; R3/R4 can never be delegated to non-owners. */
const MAX_DELEGABLE: Risk = 2;

export function decide(tool: ToolDescriptor, ctx: CallContext): Decision {
  const r = tool.risk;
  if (!RISKS.includes(r)) return deny("unknown risk class");

  switch (ctx.principal) {
    case "unpaired":
      return deny("sender is not paired");

    case "remote-agent": {
      // Remote agents get nothing unless the owner delegated explicitly, and then only low risk, with approval.
      if (ctx.elevation === undefined) return deny("remote agents have no tool access by default");
      if (r === 0) return ctx.tainted ? ask("remote agent, untrusted context") : allow("harmless tool delegated to remote agent");
      return r <= Math.min(ctx.elevation, MAX_DELEGABLE) ? ask("delegated to remote agent; owner approval required") : deny("beyond what was delegated");
    }

    case "guest": {
      if (r === 0) return allow("harmless tool");
      const cap = Math.min(ctx.elevation ?? 0, MAX_DELEGABLE);
      return r <= cap ? ask("delegated to guest; owner approval required") : deny("guest profile does not allow this tool");
    }

    case "owner":
      return decideOwner(r, ctx);

    default:
      // A principal this code does not know is refused, never waved through (the type says it cannot happen; data from outside might).
      return deny("unknown principal");
  }
}

function decideOwner(r: Risk, ctx: CallContext): Decision {
  // R4 is never auto-allowed, under any profile or taint state.
  if (r === 4) return ask("irreversible or external side effect always needs approval");
  if (r === 0) return allow("harmless tool");

  if (r === 3) {
    if (ctx.profile === "locked-down") return ctx.sandboxed ? ask("host exec in sandbox needs approval") : deny("locked-down profile requires a sandbox for exec");
    if (ctx.profile === "trusted" && !ctx.tainted) return allow("trusted profile, trusted context");
    return ask(ctx.tainted ? "host exec after untrusted content needs approval" : "host exec needs approval");
  }

  if (r === 2) {
    if (ctx.profile === "trusted" && !ctx.tainted) return allow("trusted profile, trusted context");
    return ask(ctx.tainted ? "network access after untrusted content needs approval" : "network access needs approval");
  }

  // r === 1 (workspace write)
  if (ctx.tainted) return ask("write after untrusted content needs approval");
  if (ctx.profile === "locked-down" && !ctx.sandboxed) return ask("locked-down profile: write outside a sandbox needs approval");
  return allow("workspace write in trusted context");
}
