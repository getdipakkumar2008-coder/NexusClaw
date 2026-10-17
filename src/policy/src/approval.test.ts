import { describe, expect, it } from "vitest";
import { ApprovalError, ApprovalStore, approvalKey, canonicalJson } from "./index.js";

const owner = { kind: "owner" as const, id: "me" };

describe("canonicalJson / approvalKey", () => {
  it("is independent of key order and ignores undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, undefined] }, z: undefined })).toBe('{"a":{"c":[3,null],"d":2},"b":1}');
    expect(approvalKey("exec", { cmd: "ls", cwd: "/" })).toBe(approvalKey("exec", { cwd: "/", cmd: "ls" }));
  });
  it("differs when tool or args differ", () => {
    expect(approvalKey("exec", { cmd: "ls" })).not.toBe(approvalKey("exec", { cmd: "rm" }));
    expect(approvalKey("a", {})).not.toBe(approvalKey("b", {}));
  });
  it("rejects non-JSON values", () => {
    expect(() => canonicalJson({ f: () => 1 })).toThrow(TypeError);
    expect(() => canonicalJson({ n: NaN })).toThrow(TypeError);
  });
});

describe("ApprovalStore", () => {
  const mk = () => {
    let t = 0;
    const store = new ApprovalStore(() => t, 1000);
    return { store, advance: (ms: number) => (t += ms) };
  };

  it("approves once for the exact call", () => {
    const { store } = mk();
    const a = store.create({ tool: "exec", args: { cmd: "ls" }, requester: "guest-1" });
    expect(store.consume(a.id, "exec", { cmd: "ls" })).toBe(false); // not decided yet
    store.decide(a.id, true, owner);
    expect(store.consume(a.id, "exec", { cmd: "ls" })).toBe(true);
    expect(store.consume(a.id, "exec", { cmd: "ls" })).toBe(false); // single use
  });

  it("does not transfer to different arguments or a different tool", () => {
    const { store } = mk();
    const a = store.create({ tool: "exec", args: { cmd: "ls" }, requester: "x" });
    store.decide(a.id, true, owner);
    expect(store.consume(a.id, "exec", { cmd: "rm -rf /" })).toBe(false);
    expect(store.consume(a.id, "fs.write", { cmd: "ls" })).toBe(false);
    expect(store.consume(a.id, "exec", { cmd: "ls" })).toBe(true);
  });

  it("only the owner can decide (no self-approval by guests or agents)", () => {
    const { store } = mk();
    const a = store.create({ tool: "exec", args: {}, requester: "guest" });
    for (const kind of ["guest", "unpaired", "remote-agent"] as const) {
      expect(() => store.decide(a.id, true, { kind, id: "g" })).toThrow(ApprovalError);
    }
    expect(store.get(a.id)?.state).toBe("pending");
  });

  it("denied approvals can never be consumed", () => {
    const { store } = mk();
    const a = store.create({ tool: "t", args: {}, requester: "x" });
    store.decide(a.id, false, owner);
    expect(store.consume(a.id, "t", {})).toBe(false);
    expect(() => store.decide(a.id, true, owner)).toThrow(/already denied/);
  });

  it("expires pending and approved entries", () => {
    const { store, advance } = mk();
    const a = store.create({ tool: "t", args: {}, requester: "x" });
    const b = store.create({ tool: "t", args: {}, requester: "x" });
    store.decide(b.id, true, owner);
    advance(1000);
    expect(store.get(a.id)?.state).toBe("expired");
    expect(store.consume(b.id, "t", {})).toBe(false);
    expect(() => store.decide(a.id, true, owner)).toThrow(/expired/);
  });

  it("ignores unknown ids", () => {
    const { store } = mk();
    expect(store.consume("nope", "t", {})).toBe(false);
    expect(store.get("nope")).toBeUndefined();
    expect(() => store.decide("nope", true, owner)).toThrow(/unknown/);
  });

  it("cannot be spent in a different conversation than the one it was asked in", () => {
    const { store } = mk();
    const a = store.create({ tool: "file.send", args: { path: "a.png" }, requester: "x", session: "s1" });
    store.decide(a.id, true, owner);
    expect(store.consume(a.id, "file.send", { path: "a.png" }, "s2")).toBe(false);
    expect(store.consume(a.id, "file.send", { path: "a.png" })).toBe(false);
    expect(store.consume(a.id, "file.send", { path: "a.png" }, "s1")).toBe(true);
  });

  it("forgets finished approvals after an hour, and never forgets one still waiting", () => {
    let t = 0;
    const store = new ApprovalStore(() => t, 2 * 3_600_000);
    const done = store.create({ tool: "t", args: {}, requester: "x" });
    store.decide(done.id, false, owner);
    const waiting = store.create({ tool: "t", args: { n: 2 }, requester: "x" });
    t += 3_600_001;
    store.create({ tool: "t", args: { n: 3 }, requester: "x" });
    expect(store.get(done.id)).toBeUndefined();
    expect(store.get(waiting.id)?.state).toBe("pending");
  });
});
