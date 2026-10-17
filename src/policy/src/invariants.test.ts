import { describe, expect, it } from "vitest";
import { PRINCIPALS, PROFILES, RISKS, decide, type CallContext, type Risk } from "./index.js";

/**
 * Properties that must hold for EVERY combination of principal, tool risk, profile, taint, sandbox and delegation
 * (docs/06 section 9: a non-owner can never reach a risky tool). The space is small enough to check completely.
 */
const ELEVATIONS: Array<Risk | undefined> = [undefined, 0, 1, 2, 3, 4];

function* everything(): Generator<{ risk: Risk; ctx: CallContext }> {
  for (const risk of RISKS)
    for (const principal of PRINCIPALS)
      for (const profile of PROFILES)
        for (const tainted of [false, true])
          for (const sandboxed of [false, true])
            for (const elevation of ELEVATIONS) yield { risk, ctx: { principal, profile, tainted, sandboxed, ...(elevation === undefined ? {} : { elevation }) } };
}

const label = (risk: Risk, c: CallContext): string => `risk ${risk} ${JSON.stringify(c)}`;

describe("policy invariants over the whole input space", () => {
  it("covers a few thousand combinations", () => {
    expect([...everything()].length).toBe(5 * 4 * 3 * 2 * 2 * 6);
  });

  it("an unpaired sender gets nothing, whatever it claims", () => {
    for (const { risk, ctx } of everything()) if (ctx.principal === "unpaired") expect(decide({ name: "t", risk }, ctx).effect, label(risk, ctx)).toBe("deny");
  });

  it("a guest or remote agent never reaches host execution or irreversible actions, even when delegated everything", () => {
    for (const { risk, ctx } of everything()) if ((ctx.principal === "guest" || ctx.principal === "remote-agent") && risk >= 3) expect(decide({ name: "t", risk }, ctx).effect, label(risk, ctx)).toBe("deny");
  });

  it("a guest or remote agent is never allowed to write or use the network without the owner's approval", () => {
    for (const { risk, ctx } of everything()) if ((ctx.principal === "guest" || ctx.principal === "remote-agent") && risk >= 1) expect(decide({ name: "t", risk }, ctx).effect, label(risk, ctx)).not.toBe("allow");
  });

  it("without delegation a guest gets only harmless tools and a remote agent nothing", () => {
    for (const { risk, ctx } of everything()) {
      if (ctx.elevation !== undefined) continue;
      if (ctx.principal === "guest" && risk >= 1) expect(decide({ name: "t", risk }, ctx).effect, label(risk, ctx)).toBe("deny");
      if (ctx.principal === "remote-agent") expect(decide({ name: "t", risk }, ctx).effect, label(risk, ctx)).toBe("deny");
    }
  });

  it("delegation above what was granted does not help", () => {
    for (const { risk, ctx } of everything()) {
      if ((ctx.principal === "guest" || ctx.principal === "remote-agent") && ctx.elevation !== undefined && risk > ctx.elevation && risk >= 1) {
        expect(decide({ name: "t", risk }, ctx).effect, label(risk, ctx)).toBe("deny");
      }
    }
  });

  it("the owner is always asked about irreversible actions", () => {
    for (const { risk, ctx } of everything()) if (ctx.principal === "owner" && risk === 4) expect(decide({ name: "t", risk }, ctx).effect, label(risk, ctx)).toBe("ask");
  });

  it("untrusted content in the conversation means the owner is asked before anything but a harmless tool runs", () => {
    for (const { risk, ctx } of everything()) if (ctx.principal === "owner" && ctx.tainted && risk >= 1) expect(decide({ name: "t", risk }, ctx).effect, label(risk, ctx)).not.toBe("allow");
  });

  it("host execution is allowed only on the trusted profile with a clean conversation, and never when locked down without a sandbox", () => {
    for (const { risk, ctx } of everything()) {
      if (ctx.principal !== "owner" || risk !== 3) continue;
      const e = decide({ name: "t", risk }, ctx).effect;
      if (e === "allow") expect(ctx.profile === "trusted" && !ctx.tainted, label(risk, ctx)).toBe(true);
      if (ctx.profile === "locked-down" && !ctx.sandboxed) expect(e, label(risk, ctx)).toBe("deny");
    }
  });

  it("a risk class that does not exist is refused for everyone", () => {
    for (const bad of [5, -1, 1.5, Number.NaN, Infinity, "1", null, undefined, {}, [], true]) {
      for (const principal of PRINCIPALS) {
        const d = decide({ name: "t", risk: bad as unknown as Risk }, { principal, profile: "trusted", tainted: false, sandboxed: true, elevation: 4 });
        expect(d.effect, `${String(bad)} for ${principal}`).toBe("deny");
      }
    }
  });

  it("is a pure function: the same input always gives the same answer, and does not change its input", () => {
    for (const { risk, ctx } of everything()) {
      const copy = JSON.stringify(ctx);
      const a = decide({ name: "t", risk }, ctx);
      expect(decide({ name: "t", risk }, ctx)).toEqual(a);
      expect(JSON.stringify(ctx)).toBe(copy);
    }
  });

  it("an unknown principal, profile or hostile context value is refused or treated as the least trusted", () => {
    for (const principal of ["", "root", "OWNER", "Owner ", "__proto__", "constructor", null, undefined, 1]) {
      for (const risk of RISKS) {
        const d = decide({ name: "t", risk }, { principal: principal as never, profile: "trusted", tainted: false, sandboxed: true, elevation: 4 });
        expect(d.effect, `${String(principal)} risk ${risk}`).not.toBe("allow");
      }
    }
  });
});
