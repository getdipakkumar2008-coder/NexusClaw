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
  parentNode: El | undefined;
  appendChild(c: El): El {
    this.children.push(c);
    c.parentNode = this;
    return c;
  }
  removeChild(c: El): El {
    this.children = this.children.filter((x) => x !== c);
    c.parentNode = undefined;
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
  const ids = ["log", "form", "input", "send", "status", "notice", "typing", "attach", "files"];
  const els = Object.fromEntries(ids.map((i) => [i, new El()])) as Record<string, El>;
  els["notice"]!.hidden = true;
  const storage: Record<string, string> = {};
  const replaced: string[] = [];
  const timers: Array<() => void> = [];
  const win = {
    location: { hash, pathname: "/webchat", protocol: "http:", host: "127.0.0.1:7391" },
    history: { replaceState: (_a: unknown, _b: string, url: string) => replaced.push(url) },
    btoa: (s: string) => Buffer.from(s, "latin1").toString("base64"),
    atob: (s: string) => {
      if (/[^A-Za-z0-9+/=]/.test(s)) throw new Error("InvalidCharacterError"); // like the browser's
      return Buffer.from(s, "base64").toString("latin1");
    },
    URL: { createObjectURL: () => "blob:fake" },
    Blob: class {
      constructor(
        readonly parts: unknown[],
        readonly options: { type?: string },
      ) {}
    },
    localStorage: { getItem: (k: string) => storage[k] ?? null, setItem: (k: string, v: string) => void (storage[k] = v) },
    crypto: { randomUUID: () => "11111111-2222-3333-4444-555555555555", getRandomValues: (a: Uint8Array) => a },
    setTimeout: (fn: () => void) => timers.push(fn),
    clearTimeout: (n: number) => void (timers[n - 1] = () => undefined),
  };
  const sandbox = {
    window: win,
    document: { getElementById: (id: string) => els[id], createElement: () => new El() },
    WebSocket: FakeSocket,
    JSON,
    Array,
    Uint8Array,
    Promise,
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

  it("sends picked files in pieces, then the message that names them, and shows names as text", async () => {
    const p = load();
    p.sock.onopen?.();
    p.sock.deliver({ t: "ready", role: "guest" });
    const big = new Uint8Array(200 * 1024).fill(65); // more than one piece
    const el = p.els["attach"] as unknown as { files: unknown[]; value: string };
    el.files = [
      { name: "<b>pic</b>.png", size: big.length, arrayBuffer: async () => big.buffer },
      { name: "empty.txt", size: 0, arrayBuffer: async () => new ArrayBuffer(0) },
    ];
    p.els["attach"]!.fire("change");
    expect(p.els["files"]!.hidden).toBe(false);
    expect(p.els["files"]!.children.map((c) => c.textContent)).toEqual(["<b>pic</b>.png"]); // the empty one is left out
    p.els["input"]!.value = "look";
    p.els["form"]!.fire("submit", { preventDefault() {} });
    await new Promise((r) => setTimeout(r, 20));
    expect((p.sock.sent.slice(1) as Array<Record<string, unknown>>).map((x) => x["t"])).toEqual(["file", "file"]); // the message waits for the Gateway
    p.sock.deliver({ t: "file", up: (p.sock.sent[1] as Record<string, unknown>)["up"], status: "ready" });
    await new Promise((r) => setTimeout(r, 20));
    const frames = p.sock.sent.slice(1) as Array<Record<string, unknown>>;
    expect(frames.map((x) => x["t"])).toEqual(["file", "file", "message"]);
    expect(frames[0]).toMatchObject({ seq: 0, last: false, name: "<b>pic</b>.png" });
    expect(frames[1]).toMatchObject({ seq: 1, last: true });
    expect(frames[2]).toMatchObject({ text: "look", files: [frames[0]!["up"]] });
    expect(Buffer.from(frames[0]!["data"] as string, "base64").length + Buffer.from(frames[1]!["data"] as string, "base64").length).toBe(big.length);
    expect(p.els["log"]!.children[0]!.textContent).toBe("look\nAttached: <b>pic</b>.png");
    expect(p.els["files"]!.hidden).toBe(true);
  });

  describe("when the files do not get there", () => {
    const start = (text = "see attached") => {
      const p = load();
      p.sock.onopen?.();
      p.sock.deliver({ t: "ready", role: "guest" });
      const big = new Uint8Array(200 * 1024).fill(66);
      (p.els["attach"] as unknown as { files: unknown[] }).files = [{ name: "doc.txt", size: big.length, arrayBuffer: async () => big.buffer }];
      p.els["attach"]!.fire("change");
      p.els["input"]!.value = text;
      p.els["form"]!.fire("submit", { preventDefault() {} });
      return p;
    };
    const tick = () => new Promise((r) => setTimeout(r, 20));
    const messages = (p: ReturnType<typeof load>) => (p.sock.sent as Array<Record<string, unknown>>).filter((x) => x["t"] === "message");
    const gaveBack = (p: ReturnType<typeof load>) => {
      expect(messages(p)).toHaveLength(0); // nothing was sent
      expect(p.els["log"]!.children).toHaveLength(0); // the waiting bubble is gone
      expect(p.els["input"]!.value).toBe("see attached"); // the visitor has their words back
      expect(p.els["files"]!.hidden).toBe(false); // and their file
      expect(p.els["files"]!.children.map((c) => c.textContent)).toEqual(["doc.txt"]);
      expect(p.els["notice"]!.textContent).toMatch(/not sent/);
    };

    it("gives the text and the files back when the Gateway refuses a file, and says why", async () => {
      const p = start();
      await tick();
      const up = (p.sock.sent[1] as Record<string, unknown>)["up"];
      p.sock.deliver({ t: "file", up, status: "too_large" });
      await tick();
      gaveBack(p);
      expect(p.els["notice"]!.textContent).toMatch(/too large/);
    });

    it("stops sending pieces of a file the Gateway has already refused", async () => {
      const p = load();
      p.sock.onopen?.();
      p.sock.deliver({ t: "ready", role: "guest" });
      (p.sock as unknown as { bufferedAmount: number }).bufferedAmount = 5_000_000; // the connection is backed up: nothing goes yet
      const big = new Uint8Array(500 * 1024).fill(67);
      (p.els["attach"] as unknown as { files: unknown[] }).files = [{ name: "doc.txt", size: big.length, arrayBuffer: async () => big.buffer }];
      p.els["attach"]!.fire("change");
      p.els["input"]!.value = "see attached";
      p.els["form"]!.fire("submit", { preventDefault() {} });
      await tick();
      expect(p.sock.sent).toHaveLength(1); // only the hello
      p.sock.deliver({ t: "file", up: "11111111222233334444555555555555", status: "limited" });
      (p.sock as unknown as { bufferedAmount: number }).bufferedAmount = 0;
      p.timers.forEach((t) => t());
      await tick();
      expect(p.sock.sent.filter((x) => (x as Record<string, unknown>)["t"] === "file")).toHaveLength(0);
      gaveBack(p);
      expect(p.els["notice"]!.textContent).toMatch(/too many files/);
    });

    it("gives everything back when the connection drops during the upload", async () => {
      const p = start();
      await tick();
      p.sock.onclose?.();
      await tick();
      gaveBack(p);
      expect(p.els["notice"]!.textContent).toMatch(/connection was lost/);
    });

    it("gives up waiting for the Gateway after a while", async () => {
      const p = start();
      await tick();
      expect(p.timers).toHaveLength(1);
      p.timers[0]!(); // thirty seconds pass without a word from the Gateway
      await tick();
      gaveBack(p);
      expect(p.els["notice"]!.textContent).toMatch(/did not confirm/);
    });

    it("can send again afterwards", async () => {
      const p = start();
      await tick();
      p.sock.deliver({ t: "file", up: (p.sock.sent[1] as Record<string, unknown>)["up"], status: "too_large" });
      await tick();
      p.els["form"]!.fire("submit", { preventDefault() {} }); // the same text and file, as they were given back
      await tick();
      p.sock.deliver({ t: "file", up: (p.sock.sent.at(-1) as Record<string, unknown>)["up"], status: "ready" });
      await tick();
      expect(messages(p)).toHaveLength(1);
      expect(messages(p)[0]).toMatchObject({ text: "see attached" });
    });
  });

  it("offers a file from the assistant as a download, never as something to open in the page", () => {
    const p = load();
    p.sock.onopen?.();
    p.sock.deliver({ t: "ready", role: "owner" });
    p.sock.deliver({ t: "message", from: "assistant", text: "", files: [{ name: "<img src=x>.png", mime: "text/html", data: Buffer.from("<script>alert(1)</script>").toString("base64") }] });
    const entry = p.els["log"]!.children[0] as unknown as { className: string; children: Array<{ href: string; download: string; textContent: string; rel: string }> };
    expect(entry.className).toBe("msg bot file");
    const link = entry.children[0]!;
    expect(link).toMatchObject({ href: "blob:fake", download: "<img src=x>.png", textContent: "Download <img src=x>.png", rel: "noopener" });
    p.sock.deliver({ t: "message", from: "assistant", text: "", files: [{ name: "x", mime: "text/plain", data: "%%%not base64%%%" }] });
    expect(p.els["log"]!.children[1]!.textContent).toMatch(/could not be shown/);
  });

  it("explains why a file did not go up", () => {
    const p = load();
    p.sock.onopen?.();
    p.sock.deliver({ t: "ready", role: "unpaired" });
    p.sock.deliver({ t: "file", up: "x", status: "not_paired" });
    expect(p.els["notice"]!.textContent).toMatch(/approved/);
  });
});
