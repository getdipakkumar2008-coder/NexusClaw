// Slack channel for ClawNexus. Uses Slack's "Socket Mode": the plugin opens an outbound websocket to Slack and calls
// the Web API, so it needs no public address.
//
// What it does: receives direct messages, and channel messages that mention the bot, and hands them to the Gateway,
// which decides who may talk to the assistant (pairing), applies group rules and sends replies back through `send`.
// What it never does: let a reply ping anyone or create links, fetch a file from anywhere but Slack, or act on anything but ordinary
// messages.
//
// Only two kinds of event are used, `message.im` and `app_mention`, so a message that mentions the bot in a channel
// arrives once, not twice.
//
// A plugin runs in its own process and can read nothing outside its own folder, so this file imports nothing.

// Answers that mean the token is no good, as opposed to a passing problem.
const BAD_TOKEN = new Set(["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive", "missing_scope", "invalid_token"]);

/** @type {import("@clawnexus/plugin-sdk").PluginDefinition} */
export default {
  setup(ctx) {
    const botToken = ctx.secrets.get("bot_token");
    const appToken = ctx.secrets.get("app_token");
    const configured = typeof ctx.config.apiBase === "string" ? ctx.config.apiBase : "https://slack.com/api";
    const apiBase = configured.replace(/\/+$/, "");

    // Both tokens travel in headers, so never send them unencrypted to another machine.
    const isLocal = (u) => /^(http|ws):\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(u);
    const safeApi = apiBase.startsWith("https://") || isLocal(apiBase);
    const safeSocket = (u) => u.startsWith("wss://") || isLocal(u);

    let host;
    let me; // { id, name }
    let running = false;
    let ws;
    let loop;
    let wake;
    let queue = Promise.resolve();
    let queued = 0;
    // Where a reply to a channel message goes: the thread it belongs to. Bounded.
    const threads = new Map();

    /** Error text with the tokens removed, in case a library put one in a message. */
    const clean = (e) => {
      let t = String(e instanceof Error ? e.message : e);
      for (const secret of [botToken, appToken]) if (secret) t = t.split(secret).join("[token]");
      return t.slice(0, 200);
    };

    async function api(method, token, body, { timeoutMs = 15_000 } = {}) {
      const res = await fetch(`${apiBase}/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      let json;
      try {
        json = await res.json();
      } catch {
        throw Object.assign(new Error(`Slack answered ${res.status} without a usable body`), { status: res.status });
      }
      if (!res.ok || !json.ok) {
        const retry = Number(res.headers.get("retry-after"));
        throw Object.assign(new Error(`Slack: ${json?.error ?? "error"} (${res.status})`), {
          status: res.status,
          code: json?.error,
          retryAfter: Number.isFinite(retry) && retry > 0 ? retry : undefined,
        });
      }
      return json;
    }

    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    /** A wait that stop() can cut short. */
    const sleep = (ms) =>
      new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        wake = () => (clearTimeout(t), resolve());
      });

    /** Slack writes & < > as entities, and marks people and links as <...>. Show the assistant plain text. */
    function plain(text) {
      return text
        .replace(new RegExp(`<@${me.id}(\\|[^>]*)?>`, "g"), "")
        .replace(/<(https?:[^>|]+)\|([^>]+)>/g, "$2 ($1)")
        .replace(/<(https?:[^>]+)>/g, "$1")
        .replace(/<@([A-Z0-9]+)(\|[^>]*)?>/g, "@$1")
        .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/\s{2,}/g, " ")
        .trim();
    }

    /** What we send is escaped so that nothing the model writes can mention @channel, a person or a link. */
    const escapeOut = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const MAX_FILE = 8 * 1024 * 1024; // the Gateway takes no more than this per file
    const MAX_FILES = 4;

    /**
     * Download a file the platform pointed us at: only from the platform's own file hosts, never following a name the
     * sender chose, and sending the token only to those hosts. At most MAX_FILE bytes; base64, or undefined on any problem.
     */
    async function fetchFile(url) {
      let u;
      try {
        u = new URL(String(url));
      } catch {
        return undefined;
      }
      const hosts = new Set(["files.slack.com", new URL(apiBase).host]);
      if (!hosts.has(u.host) || (u.protocol !== "https:" && !isLocal(`${u.protocol}//${u.host}`))) return undefined;
      const res = await fetch(u, { headers: { authorization: `Bearer ${botToken}` }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok || !res.body) return undefined;
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_FILE) return undefined;
      const chunks = [];
      let n = 0;
      for await (const c of res.body) {
        n += c.length;
        if (n > MAX_FILE) return undefined;
        chunks.push(c);
      }
      return Buffer.concat(chunks).toString("base64");
    }

    async function filesOf(e) {
      const out = [];
      for (const f of (e.files ?? []).slice(0, MAX_FILES)) {
        const note = { name: String(f.name ?? "file").slice(0, 200), ...(typeof f.mimetype === "string" ? { mimeType: f.mimetype.slice(0, 100) } : {}), ...(typeof f.size === "number" ? { bytes: f.size } : {}) };
        if (typeof f.size === "number" && f.size > MAX_FILE) {
          out.push(note);
          continue;
        }
        try {
          const data = await fetchFile(f.url_private_download ?? f.url_private);
          out.push(data === undefined ? note : { ...note, data });
        } catch {
          out.push(note);
        }
      }
      return out;
    }

    /** Slack event -> what the Gateway expects, or undefined when it is not for us. */
    async function toInbound(e) {
      if (!e || (e.type !== "message" && e.type !== "app_mention")) return undefined;
      const direct = e.channel_type === "im";
      // Channel messages only arrive as mentions; the plain message events for channels are never used.
      if (e.type === "message" && !direct) return undefined;
      if (e.type === "app_mention" && direct) return undefined;
      if (e.bot_id || !e.user || e.user === me.id) return undefined;
      if (e.subtype !== undefined && e.subtype !== "file_share" && e.subtype !== "thread_broadcast") return undefined;
      const text = plain(typeof e.text === "string" ? e.text : "");
      const files = await filesOf(e);
      if (text === "" && files.length === 0) return undefined;
      const messageId = `${e.channel}:${e.ts}`;
      if (!direct) {
        if (threads.size >= 2000) threads.delete(threads.keys().next().value);
        threads.set(messageId, String(e.thread_ts ?? e.ts));
      }
      const ts = Number.parseFloat(e.ts);
      return {
        accountId: "default",
        conversationId: String(e.channel),
        senderId: String(e.user),
        messageId,
        text,
        ...(e.thread_ts && e.thread_ts !== e.ts ? { replyTo: `${e.channel}:${e.thread_ts}` } : {}),
        isGroup: !direct,
        mentionsBot: true,
        ...(Number.isFinite(ts) ? { ts: Math.round(ts * 1000) } : {}),
        ...(files.length ? { attachments: files } : {}),
      };
    }

    /** Messages are handed over one at a time, in order; a flood is dropped rather than held without limit. */
    function enqueue(e) {
      if (queued >= 200) {
        ctx.log("warn", "slack: too many messages waiting; dropping one");
        return;
      }
      queued++;
      queue = queue
        .then(async () => {
          const inbound = await toInbound(e);
          if (inbound) await host.deliver(inbound);
        })
        .catch((err) => ctx.log("warn", `slack: could not hand over a message: ${clean(err)}`))
        .finally(() => queued--);
    }

    /** Ask Slack for a fresh socket address (each is good for one connection). */
    async function openAddress() {
      const info = await api("apps.connections.open", appToken);
      const url = String(info.url ?? "");
      if (!safeSocket(url)) throw Object.assign(new Error("Slack gave an unsafe socket address"), { code: "unsafe_socket" });
      return url;
    }

    /** One connection. Resolves with how it ended. */
    function connect(url) {
      return new Promise((resolve) => {
        let ready = false;
        let done = false;
        const socket = new WebSocket(url);
        ws = socket;
        const finish = (result) => {
          if (done) return;
          done = true;
          if (ws === socket) ws = undefined;
          try {
            socket.close();
          } catch {
            /* already closed */
          }
          resolve({ ready, ...result });
        };
        socket.addEventListener("message", (event) => {
          let p;
          try {
            p = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
          } catch {
            return;
          }
          // Acknowledge first: Slack resends anything not acknowledged within a few seconds, and the Gateway ignores repeats.
          if (typeof p.envelope_id === "string" && socket.readyState === 1) socket.send(JSON.stringify({ envelope_id: p.envelope_id }));
          if (p.type === "hello") {
            ready = true;
            host.setStatus({ state: "connected", detail: me.name ? `@${me.name}` : undefined });
          } else if (p.type === "disconnect") {
            finish({ reason: String(p.reason ?? "disconnect"), planned: true });
          } else if (p.type === "events_api") {
            enqueue(p.payload?.event);
          }
        });
        socket.addEventListener("close", () => finish({ reason: "connection closed" }));
        socket.addEventListener("error", () => finish({ reason: "connection failed" }));
        wake = () => finish({ reason: "stopping", stopping: true });
      });
    }

    async function run(firstUrl) {
      let failures = 0;
      while (running) {
        let end;
        try {
          const url = firstUrl ?? (await openAddress());
          firstUrl = undefined;
          end = await connect(url);
        } catch (e) {
          if (!running) return;
          if (BAD_TOKEN.has(e.code)) {
            host.setStatus({ state: "auth_required", detail: "Slack rejected the app token" });
            return;
          }
          end = { ready: false, reason: e.code === "unsafe_socket" ? "Slack gave an unsafe socket address" : clean(e), retryAfter: e.retryAfter };
        }
        if (!running) return;
        failures = end.ready ? 0 : failures + 1;
        if (!end.planned) host.setStatus({ state: "degraded", detail: (end.ready ? "reconnecting" : `cannot reach Slack (${end.reason})`).slice(0, 200) });
        // Slack asks for a new connection from time to time; that needs no waiting. Real failures back off.
        await sleep(end.planned ? 200 : end.ready ? 1000 + Math.random() * 1000 : Math.min(60_000, Math.max((end.retryAfter ?? 0) * 1000, 2000 * 2 ** Math.min(failures, 5))));
      }
    }

    ctx.registerChannel({
      id: "slack",
      capabilities: { typing: false, groups: true, maxTextChars: 3000 },

      async start(h) {
        host = h;
        if (!botToken || !appToken) throw new Error("the bot token and the app token are both required");
        if (!safeApi) {
          host.setStatus({ state: "degraded", detail: "apiBase must be https (or localhost)" });
          throw new Error("apiBase must use https, or point at this computer");
        }
        try {
          const who = await api("auth.test", botToken);
          me = { id: String(who.user_id), name: String(who.user ?? "") };
          // The app token is checked here too, so a wrong one is reported at once instead of on the first reconnect.
          const url = await openAddress();
          running = true;
          host.setStatus({ state: "starting" });
          loop = run(url);
          loop.catch(() => undefined);
        } catch (e) {
          if (BAD_TOKEN.has(e.code)) {
            host.setStatus({ state: "auth_required", detail: "Slack rejected a token" });
            return;
          }
          throw new Error(clean(e));
        }
      },

      async stop() {
        running = false;
        wake?.();
        await loop?.catch(() => undefined);
        loop = undefined;
        await queue.catch(() => undefined);
      },

      async send(target, content) {
        const body = { channel: target.conversationId, text: escapeOut(content.text), mrkdwn: false, link_names: false, unfurl_links: false, unfurl_media: false };
        // In channels, answer in the thread of the message that asked, so replies stay together.
        const thread = target.replyTo ? threads.get(String(target.replyTo)) : undefined;
        if (thread) body.thread_ts = thread;
        for (let attempt = 0; ; attempt++) {
          try {
            const sent = await api("chat.postMessage", botToken, body);
            return { messageId: `${target.conversationId}:${sent.ts}` };
          } catch (e) {
            // Slack says how long to wait when it is rate-limiting; honour short waits once, otherwise let the Gateway retry.
            if (e.status === 429 && attempt === 0 && typeof e.retryAfter === "number" && e.retryAfter <= 10) {
              await pause(e.retryAfter * 1000 + 50);
              continue;
            }
            throw new Error(clean(e));
          }
        }
      },
    });

    ctx.log("info", "slack channel registered");
  },
};
