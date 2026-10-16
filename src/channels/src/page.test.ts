import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

/**
 * Runs the real browser script against a stand-in page. It cannot judge how the page looks, but it does check what the
 * script does with what the server sends: that text is shown as text, that the owner link is consumed, and so on.
 */
class El {
  private text = "";
  get textContent(): string {
    return this.text;
  }
  set textContent(v: string) {
    this.text = v;
    this.children = []; // like a real element, assigning text replaces the content
  }
  className = "";
  hidden = false;
  disabled = false;
  value = "";
  scrollTop = 0;
  scrollHeight = 0;
  children: El[] = [];
  listeners: Record<string, Array<(e: unknown) => void>> = {};
  classList = {
    remove: (c: string) => void (this.className = this.className.split(" ").filter((x) => x !== c).join(" ")),
    add: (c: string) => void (this.className = `${this.className} ${c}`.trim()),
  };
  appendChild(c: El): El {
    this.children.push(c);
    return c;
  }
  addEventListener(name: string, fn: (e: unknown) => void): void {
    (this.listeners[name] ??= []).push(fn);
  }
  focus(): void {
    /* no-op */
  }
  fire(name: string, e: unknown = {}): void {
    for (const fn of this.listeners[name] ?? []) fn(e);
  }
}

class FakeSocket {
  static last: FakeSocket | undefined;
  sent: unknown[] = [];
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  send(s: string): void {
    this.sent.push(JSON.parse(s));
  }
  deliver(f: object): void {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
}

function load(hash = "") {
  const ids = ["log", "form", "input", "send", "status", "notice", "typing"];
  const els = Object.fromEntries(ids.map((i) => [i, new El()])) as Record<string, El>;
  els["notice"]!.hidden = true;
  const storage: Record<string, string> = {};
  const replaced: string[] = [];
  const timers: Array<() => void> = [];
  const win = {
    location: { hash, pathname: "/webchat", protocol: "http:", host: "127.0.0.1:7391" },
    history: { replaceState: (_a: unknown, _b: string, url: string) => replaced.push(url) },
    localStorage: { getItem: (k: string) => storage[k] ?? null, setItem: (k: string, v: string) => void (storage[k] = v) },
    crypto: { randomUUID: () => "11111111-2222-3333-4444-555555555555", getRandomValues: (a: Uint8Array) => a },
    setTimeout: (fn: () => void) => timers.push(fn),
  };
  const sandbox = {
    window: win,
    document: { getElementById: (id: string) => els[id], createElement: () => new El() },
    WebSocket: FakeSocket,
    JSON,
    Array,
    Uint8Array,
  };
  FakeSocket.last = undefined;
  vm.runInNewContext(readFileSync(new URL("../assets/app.js", import.meta.url), "utf8"), sandbox);
  const sock = FakeSocket.last!;
  return { els, sock, storage, replaced, timers };
}

describe("the browser page script", () => {
  it("connects to the chat socket on its own host and says hello with what it has stored", () => {
    const p = load();
    expect(p.sock.url).toBe("ws://127.0.0.1:7391/v1/webchat");
    p.sock.onopen?.();
    expect(p.sock.sent[0]).toEqual({ t: "hello", secret: null, redeem: null });
  });

  it("keeps the secret it is given and presents it next time", () => {
    const p = load();
    p.sock.onopen?.();
    p.sock.deliver({ t: "ready", role: "unpaired", secret: "cnw_abc" });
    expect(p.storage["clawnexus.webchat.secret"]).toBe("cnw_abc");
    expect(p.els["input"]!.disabled).toBe(false);
    expect(p.els["notice"]!.hidden).toBe(false);
    expect(p.els["notice"]!.textContent).toMatch(/pairing code/);
    const again = load();
    again.storage["clawnexus.webchat.secret"] = "cnw_abc";
  });

  it("takes the owner code from the address, removes it from the address bar, and offers it once", () => {
    const code = "cno_" + "A".repeat(32);
    const p = load(`#owner=${code}`);
    expect(p.replaced).toEqual(["/webchat"]);
    p.sock.onopen?.();
    expect(p.sock.sent[0]).toMatchObject({ t: "hello", redeem: code });
    p.sock.deliver({ t: "ready", role: "owner", redeemed: true });
    expect(p.els["status"]!.textContent).toBe("Connected as the owner");
    expect(p.els["notice"]!.hidden).toBe(true);
  });

  it("tells the user when an owner link did not work", () => {
    const p = load("#owner=" + "B".repeat(20));
    p.sock.onopen?.();
    p.sock.deliver({ t: "ready", role: "unpaired", redeemed: false });
    expect(p.els["notice"]!.textContent).toMatch(/invalid or has expired/);
  });

  it("shows every message, from either side, as plain text", () => {
    const p = load();
    p.sock.onopen?.();
    p.sock.deliver({ t: "ready", role: "guest" });
    const evil = "<img src=x onerror=alert(1)>";
    p.sock.deliver({ t: "message", from: "assistant", text: evil });
    p.sock.deliver({ t: "history", messages: [{ from: "you", text: "<b>old</b>" }, { from: "assistant", text: evil }] });
    const shown = p.els["log"]!.children.map((c) => [c.className, c.textContent]);
    expect(shown).toEqual([
      ["msg you", "<b>old</b>"],
      ["msg bot", evil],
    ]);
  });

  it("sends the typed message with a fresh id, clears the box, and marks it delivered on acknowledgement", () => {
    const p = load();
    p.sock.onopen?.();
    p.sock.deliver({ t: "ready", role: "guest" });
    p.els["input"]!.value = "  hello  ";
    p.els["form"]!.fire("submit", { preventDefault() {} });
    expect(p.sock.sent[1]).toEqual({ t: "message", id: "11111111222233334444555555555555", text: "hello" });
    expect(p.els["input"]!.value).toBe("");
    const mine = p.els["log"]!.children[0]!;
    expect(mine.className).toContain("pending");
    p.sock.deliver({ t: "ack", id: "11111111222233334444555555555555", status: "accepted", role: "guest" });
    expect(mine.className).not.toContain("pending");
    expect(p.els["notice"]!.hidden).toBe(true);
  });

  it("ignores empty input, sends on Enter but not Shift+Enter", () => {
    const p = load();
    p.sock.onopen?.();
    p.sock.deliver({ t: "ready", role: "guest" });
    p.els["form"]!.fire("submit", { preventDefault() {} });
    expect(p.sock.sent).toHaveLength(1); // only the hello
    p.els["input"]!.value = "line one";
    let prevented = false;
    p.els["input"]!.fire("keydown", { key: "Enter", shiftKey: true, preventDefault: () => (prevented = true) });
    expect(prevented).toBe(false);
    p.els["input"]!.fire("keydown", { key: "Enter", shiftKey: false, isComposing: false, preventDefault: () => (prevented = true) });
    expect(prevented).toBe(true);
    expect(p.sock.sent).toHaveLength(2);
  });

  it("explains pairing, rate limits and busy states, and shows the typing indicator", () => {
    const p = load();
    p.sock.onopen?.();
    p.sock.deliver({ t: "ready", role: "guest" });
    p.sock.deliver({ t: "ack", id: "x", status: "pairing" });
    expect(p.els["notice"]!.textContent).toMatch(/owner has to approve/);
    p.sock.deliver({ t: "ack", id: "x", status: "limited" });
    expect(p.els["notice"]!.textContent).toMatch(/too quickly/);
    p.sock.deliver({ t: "ack", id: "x", status: "busy" });
    expect(p.els["notice"]!.textContent).toMatch(/busy/);
    p.sock.deliver({ t: "typing", on: true });
    expect(p.els["typing"]!.hidden).toBe(false);
    p.sock.deliver({ t: "message", from: "assistant", text: "done" });
    expect(p.els["typing"]!.hidden).toBe(true);
  });

  it("disables input and reconnects with backoff when the connection drops", () => {
    const p = load();
    p.sock.onopen?.();
    p.sock.deliver({ t: "ready", role: "guest" });
    p.sock.onclose?.();
    expect(p.els["input"]!.disabled).toBe(true);
    expect(p.els["status"]!.textContent).toMatch(/Reconnecting/);
    expect(p.timers).toHaveLength(1);
    const first = p.sock;
    p.timers[0]!();
    expect(FakeSocket.last).not.toBe(first);
  });

  it("ignores garbage from the server", () => {
    const p = load();
    p.sock.onopen?.();
    p.sock.onmessage?.({ data: "not json" });
    p.sock.deliver({ t: "unknown-frame", x: 1 });
    expect(p.els["log"]!.children).toHaveLength(0);
  });
});
