import { describe, expect, it } from "vitest";
import { PRINCIPALS, PROFILES, RISKS, decide, type CallContext, type Risk } from "./index.js";

const ctx = (over: Partial<CallContext> = {}): CallContext => ({
  principal: "owner",
  profile: "standard",
  tainted: false,
  sandboxed: false,
  ...over,
});
const tool = (risk: Risk) => ({ name: `t${risk}`, risk });

// Every combination of the inputs that matter, including all elevation levels.
const ELEVATIONS: Array<Risk | undefined> = [undefined, 0, 1, 2, 3, 4];
function* allContexts(): Generator<{ risk: Risk; c: CallContext }> {
  for (const principal of PRINCIPALS)
    for (const profile of PROFILES)
      for (const tainted of [false, true])
        for (const sandboxed of [false, true])
          for (const elevation of ELEVATIONS)
            for (const risk of RISKS) {
              const c: CallContext = { principal, profile, tainted, sandboxed };
              if (elevation !== undefined) c.elevation = elevation;
              yield { risk, c };
            }
}

describe("security invariants (exhaustive matrix)", () => {
  it("R4 is never auto-allowed for anyone", () => {
    for (const { risk, c } of allContexts()) {
      if (risk === 4) expect(decide(tool(risk), c).effect, JSON.stringify(c)).not.toBe("allow");
    }
  });

  it("non-owners can never auto-allow anything above R0, and never reach R3/R4 at all", () => {
    for (const { risk, c } of allContexts()) {
      if (c.principal === "owner") continue;
      const d = decide(tool(risk), c);
      if (risk >= 1) expect(d.effect, JSON.stringify({ risk, c })).not.toBe("allow");
      if (risk >= 3) expect(d.effect, JSON.stringify({ risk, c })).toBe("deny");
    }
  });

  it("unpaired senders are always denied", () => {
    for (const { risk, c } of allContexts()) {
      if (c.principal === "unpaired") expect(decide(tool(risk), c).effect).toBe("deny");
    }
  });

  it("untrusted context never yields allow for R1+ (even owner, even trusted profile)", () => {
    for (const { risk, c } of allContexts()) {
      if (c.tainted && risk >= 1) expect(decide(tool(risk), c).effect, JSON.stringify({ risk, c })).not.toBe("allow");
    }
  });

  it("is deterministic and always returns a reason", () => {
    for (const { risk, c } of allContexts()) {
      const a = decide(tool(risk), c);
      expect(decide(tool(risk), c)).toEqual(a);
      expect(a.reason.length).toBeGreaterThan(0);
    }
  });

  it("rejects out-of-range risk values", () => {
    expect(decide({ name: "x", risk: 7 as Risk }, ctx()).effect).toBe("deny");
  });
});

describe("owner behaviour by profile", () => {
  it("standard: R0/R1 allow, R2/R3/R4 ask", () => {
    const e = [0, 1, 2, 3, 4].map((r) => decide(tool(r as Risk), ctx()).effect);
    expect(e).toEqual(["allow", "allow", "ask", "ask", "ask"]);
  });
  it("trusted: R0-R3 allow when context is clean, R4 still asks", () => {
    const e = [0, 1, 2, 3, 4].map((r) => decide(tool(r as Risk), ctx({ profile: "trusted" })).effect);
    expect(e).toEqual(["allow", "allow", "allow", "allow", "ask"]);
  });
  it("trusted but tainted: falls back to asking for R1+", () => {
    const e = [0, 1, 2, 3, 4].map((r) => decide(tool(r as Risk), ctx({ profile: "trusted", tainted: true })).effect);
    expect(e).toEqual(["allow", "ask", "ask", "ask", "ask"]);
  });
  it("locked-down: exec denied without a sandbox, asks with one", () => {
    expect(decide(tool(3), ctx({ profile: "locked-down" })).effect).toBe("deny");
    expect(decide(tool(3), ctx({ profile: "locked-down", sandboxed: true })).effect).toBe("ask");
  });
});

describe("guests and remote agents", () => {
  it("guest default: only R0", () => {
    expect([0, 1, 2, 3].map((r) => decide(tool(r as Risk), ctx({ principal: "guest" })).effect)).toEqual([
      "allow",
      "deny",
      "deny",
      "deny",
    ]);
  });
  it("guest elevated to R1: R1 needs approval, R2 still denied", () => {
    const c = ctx({ principal: "guest", elevation: 1 });
    expect(decide(tool(1), c).effect).toBe("ask");
    expect(decide(tool(2), c).effect).toBe("deny");
  });
  it("elevation above R2 is capped", () => {
    const c = ctx({ principal: "guest", elevation: 4 });
    expect(decide(tool(2), c).effect).toBe("ask");
    expect(decide(tool(3), c).effect).toBe("deny");
  });
  it("remote agent has nothing by default", () => {
    expect(decide(tool(0), ctx({ principal: "remote-agent" })).effect).toBe("deny");
  });
});

describe("prompt-injection scenarios", () => {
  it("a stranger asking the assistant to run a command is denied", () => {
    expect(decide(tool(3), ctx({ principal: "unpaired" })).effect).toBe("deny");
    expect(decide(tool(3), ctx({ principal: "guest" })).effect).toBe("deny");
  });
  it("owner browsing a malicious page cannot make the model exfiltrate or exec without approval", () => {
    const c = ctx({ profile: "trusted", tainted: true });
    expect(decide(tool(2), c).effect).toBe("ask");
    expect(decide(tool(3), c).effect).toBe("ask");
    expect(decide(tool(4), c).effect).toBe("ask");
  });
});
