// Discord channel for ClawNexus. Connects to the Discord Gateway (a websocket) and the REST API, so it needs no public
// address.
//
// What it does: receives direct messages, and server messages that mention the bot or reply to it, and hands them to
// the Gateway, which decides who may talk to the assistant (pairing), applies group rules and sends replies back
// through `send`. What it never does: let a reply ping anyone, follow links, fetch a file from anywhere but Discord, or act on anything
// but ordinary messages.
//
// It asks only for the "server messages" and "direct messages" intents. Discord still includes the text of messages
// that mention the bot, so the privileged "message content" switch in the developer portal is not needed.
//
// A plugin runs in its own process and can read nothing outside its own folder, so this file imports nothing.

const GUILD_MESSAGES = 1 << 9;
const DIRECT_MESSAGES = 1 << 12;
const INTENTS = GUILD_MESSAGES | DIRECT_MESSAGES;

// Close codes after which trying again cannot help.
const FATAL_AUTH = new Set([4004]);
const FATAL_OTHER = new Map([
  [4010, "Discord rejected the shard setup"],
  [4011, "Discord says the bot needs sharding"],
  [4012, "Discord rejected the gateway version"],
  [4013, "Discord rejected the intents"],
  [4014, "a requested intent is not enabled for this bot"],
]);
// After these the old session cannot be resumed.
const NO_RESUME = new Set([1000, 1001, 4007, 4009]);

/** @type {import("@clawnexus/plugin-sdk").PluginDefinition} */
export default {
  setup(ctx) {
    const token = ctx.secrets.get("bot_token");
    const configured = typeof ctx.config.apiBase === "string" ? ctx.config.apiBase : "https://discord.com/api/v10";
    const apiBase = configured.replace(/\/+$/, "");

    // The token goes in a header and in the identify message, so never send it unencrypted to another machine.
    const isLocal = (u) => /^(http|ws):\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(u);
    const safeApi = apiBase.startsWith("https://") || isLocal(apiBase);
    const safeGateway = (u) => u.startsWith("wss://") || isLocal(u);

    let host;
    let me; // { id, username }
    let running = false;
    let gatewayUrl;
    let ws;
    let loop;
    let wake; // ends the current wait early (stop, or a fatal close)
    let session; // { id, resumeUrl, seq } while a session can be resumed
    let queue = Promise.resolve();
    let queued = 0;

    /** Error text with the token removed, in case a library put it in a message. */
    const clean = (e) => String(e instanceof Error ? e.message : e).split(token ?? "\u0000").join("[token]").slice(0, 200);

    async function api(method, path, body, { timeoutMs = 15_000 } = {}) {
      const res = await fetch(`${apiBase}${path}`, {
        method,
        headers: {
          authorization: `Bot ${token}`,
          // A form (a file upload) sets its own content type with the boundary.
          ...(body instanceof FormData ? {} : { "content-type": "application/json" }),
          "user-agent": "DiscordBot (https://github.com/getdipakkumar2008-coder/NexusClaw, 0.1.0)",
        },
        ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 204) return undefined;
      let json;
      try {
        json = await res.json();
      } catch {
        throw Object.assign(new Error(`Discord answered ${res.status} without a usable body`), { status: res.status });
      }
      if (!res.ok) {
        throw Object.assign(new Error(`Discord: ${json?.message ?? "error"} (${res.status})`), {
          status: res.status,
          retryAfter: typeof json?.retry_after === "number" ? json.retry_after : undefined,
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

    // Server channels we have seen, so replies there can point at the message they answer.
    const servers = new Set();

    /** Discord marks the bot in text as <@id> or <@!id>. The assistant does not need to see its own name. */
    function stripOwnMention(text) {
      return text.replace(new RegExp(`<@!?${me.id}>`, "g"), "").replace(/\s{2,}/g, " ").trim();
    }

    const MAX_FILE = 8 * 1024 * 1024; // the Gateway takes no more than this per file
    const MAX_FILES = 4;

    /**
     * Download a file the platform pointed us at: only from the platform's own file hosts, never following a name the
     * sender chose. At most MAX_FILE bytes; base64, or undefined on any problem.
     */
    async function fetchFile(url) {
      let u;
      try {
        u = new URL(String(url));
      } catch {
        return undefined;
      }
      const hosts = new Set(["cdn.discordapp.com", "media.discordapp.net", new URL(apiBase).host]);
      if (!hosts.has(u.host) || (u.protocol !== "https:" && !isLocal(`${u.protocol}//${u.host}`))) return undefined;
      const res = await fetch(u, { signal: AbortSignal.timeout(30_000) });
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

    async function filesOf(m) {
      const out = [];
      for (const a of (m.attachments ?? []).slice(0, MAX_FILES)) {
        const note = { name: String(a.filename ?? "file").slice(0, 200), ...(typeof a.content_type === "string" ? { mimeType: a.content_type.slice(0, 100) } : {}), ...(typeof a.size === "number" ? { bytes: a.size } : {}) };
        if (typeof a.size === "number" && a.size > MAX_FILE) {
          out.push(note);
          continue;
        }
        try {
          const data = await fetchFile(a.url);
          out.push(data === undefined ? note : { ...note, data });
        } catch {
          out.push(note);
        }
      }
      return out;
    }

    /** Discord message -> what the Gateway expects, or undefined when it is not for us. */
    async function toInbound(m) {
      if (!m || !m.author || m.author.bot || m.webhook_id) return undefined;
      // 0 is an ordinary message, 19 a reply, 20 a slash command; everything else is a service message.
      if (m.type !== undefined && m.type !== 0 && m.type !== 19 && m.type !== 20) return undefined;
      const isGroup = typeof m.guild_id === "string";
      if (isGroup) {
        if (servers.size >= 5000) servers.delete(servers.values().next().value);
        servers.add(String(m.channel_id));
      }
      const mentioned = (m.mentions ?? []).some((u) => u.id === me.id) || m.referenced_message?.author?.id === me.id;
      const text = stripOwnMention(typeof m.content === "string" ? m.content : "");
      const files = await filesOf(m);
      if (text === "" && files.length === 0) return undefined;
      const display = m.member?.nick ?? m.author.global_name ?? m.author.username;
      return {
        accountId: "default",
        conversationId: String(m.channel_id),
        senderId: String(m.author.id),
        ...(display ? { senderDisplay: String(display).slice(0, 200) } : {}),
        messageId: String(m.id),
        text,
        ...(m.message_reference?.message_id ? { replyTo: String(m.message_reference.message_id) } : {}),
        isGroup,
        mentionsBot: isGroup ? mentioned : true,
        ...(m.timestamp && !Number.isNaN(Date.parse(m.timestamp)) ? { ts: Date.parse(m.timestamp) } : {}),
        ...(files.length ? { attachments: files } : {}),
      };
    }

    /** Messages are handed over one at a time, in order; a flood is dropped rather than held without limit. */
    function enqueue(m) {
      if (queued >= 200) {
        ctx.log("warn", "discord: too many messages waiting; dropping one");
        return;
      }
      queued++;
      queue = queue
        .then(async () => {
          const inbound = await toInbound(m);
          if (inbound) await host.deliver(inbound);
        })
        .catch((e) => ctx.log("warn", `discord: could not hand over a message: ${clean(e)}`))
        .finally(() => queued--);
    }

    /** One connection. Resolves with how it ended. */
    function connect() {
      return new Promise((resolve) => {
        const resume = session !== undefined;
        const url = `${resume ? session.resumeUrl : gatewayUrl}${(resume ? session.resumeUrl : gatewayUrl).includes("?") ? "&" : "/?"}v=10&encoding=json`;
        let beat;
        let acked = true;
        let ready = false;
        let done = false;
        const socket = new WebSocket(url);
        ws = socket;
        const finish = (result) => {
          if (done) return;
          done = true;
          clearInterval(beat);
          clearTimeout(first);
          if (ws === socket) ws = undefined;
          try {
            socket.close();
          } catch {
            /* already closed */
          }
          resolve({ ready, ...result });
        };
        let first;
        const send = (op, d) => {
          if (socket.readyState === 1) socket.send(JSON.stringify({ op, d }));
        };
        const heartbeat = () => {
          if (!acked) return finish({ code: 4009, reason: "no heartbeat answer" }); // a dead connection: start over
          acked = false;
          send(1, session?.seq ?? null);
        };

        socket.addEventListener("message", (event) => {
          let p;
          try {
            p = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
          } catch {
            return;
          }
          if (typeof p.s === "number" && session) session.seq = p.s;
          switch (p.op) {
            case 10: {
              const every = Math.max(1000, Number(p.d?.heartbeat_interval) || 41_250);
              first = setTimeout(() => {
                heartbeat();
                beat = setInterval(heartbeat, every);
              }, every * Math.random());
              if (resume) send(6, { token, session_id: session.id, seq: session.seq ?? 0 });
              else send(2, { token, intents: INTENTS, properties: { os: process.platform, browser: "clawnexus", device: "clawnexus" } });
              break;
            }
            case 11:
              acked = true;
              break;
            case 1:
              heartbeat();
              break;
            case 7:
              finish({ code: 4000, reason: "Discord asked to reconnect", keepSession: true });
              break;
            case 9:
              finish({ code: 4007, reason: "session no longer valid", keepSession: p.d === true });
              break;
            case 0:
              if (p.t === "READY") {
                me = { id: String(p.d.user.id), username: String(p.d.user.username ?? "") };
                session = { id: p.d.session_id, resumeUrl: safeGateway(String(p.d.resume_gateway_url ?? "")) ? String(p.d.resume_gateway_url) : gatewayUrl, seq: p.s ?? null };
                ready = true;
                host.setStatus({ state: "connected", detail: me.username ? `@${me.username}` : undefined });
              } else if (p.t === "RESUMED") {
                ready = true;
                host.setStatus({ state: "connected", detail: me?.username ? `@${me.username}` : undefined });
              } else if (p.t === "MESSAGE_CREATE" && me) {
                enqueue(p.d);
              }
              break;
            default:
              break;
          }
        });
        socket.addEventListener("close", (event) => finish({ code: event.code, reason: event.reason }));
        socket.addEventListener("error", () => finish({ code: 0, reason: "connection failed" }));
        wake = () => finish({ code: 1000, reason: "stopping", stopping: true });
      });
    }

    async function run() {
      let failures = 0;
      while (running) {
        const end = await connect();
        if (!running) return;
        if (FATAL_AUTH.has(end.code)) {
          host.setStatus({ state: "auth_required", detail: "Discord rejected the bot token" });
          return;
        }
        if (FATAL_OTHER.has(end.code)) {
          host.setStatus({ state: "degraded", detail: FATAL_OTHER.get(end.code) });
          return;
        }
        if (NO_RESUME.has(end.code) && !end.keepSession) session = undefined;
        failures = end.ready ? 0 : failures + 1;
        host.setStatus({ state: "degraded", detail: end.ready ? "reconnecting" : `cannot reach Discord (${end.reason || end.code})`.slice(0, 200) });
        // Identifying is limited by Discord, so never retry in a tight loop.
        await sleep(end.ready && failures === 0 ? 1000 + Math.random() * 1000 : Math.min(60_000, 2000 * 2 ** Math.min(failures, 5)));
      }
    }

    ctx.registerChannel({
      id: "discord",
      capabilities: { typing: true, groups: true, maxTextChars: 2000, files: true },

      async start(h) {
        host = h;
        if (!token) throw new Error("the bot token is not set");
        if (!safeApi) {
          host.setStatus({ state: "degraded", detail: "apiBase must be https (or localhost)" });
          throw new Error("apiBase must use https, or point at this computer");
        }
        try {
          const info = await api("GET", "/gateway/bot");
          gatewayUrl = String(info?.url ?? "").replace(/\/+$/, "");
        } catch (e) {
          if (e.status === 401 || e.status === 403) {
            host.setStatus({ state: "auth_required", detail: "Discord rejected the bot token" });
            return;
          }
          throw new Error(clean(e));
        }
        if (!safeGateway(gatewayUrl)) {
          host.setStatus({ state: "degraded", detail: "Discord gave an unsafe gateway address" });
          throw new Error("the gateway address is not encrypted");
        }
        running = true;
        session = undefined;
        host.setStatus({ state: "starting" });
        loop = run();
        loop.catch(() => undefined);
      },

      async stop() {
        running = false;
        wake?.();
        await loop?.catch(() => undefined);
        loop = undefined;
        await queue.catch(() => undefined);
      },

      async send(target, content) {
        // allowed_mentions with nothing in it means a reply can never ping anyone, whatever the model writes.
        const body = { content: content.text, allowed_mentions: { parse: [], replied_user: false }, flags: 4 }; // 4: no link previews
        // Reply to the asking message in servers so people can tell who is being answered. Direct chats need no thread.
        if (target.replyTo && /^\d+$/.test(String(target.replyTo)) && servers.has(target.conversationId)) {
          body.message_reference = { message_id: String(target.replyTo), fail_if_not_exists: false };
        }
        const file = Array.isArray(content.files) ? content.files[0] : undefined;
        for (let attempt = 0; ; attempt++) {
          try {
            let payload = body;
            let timeoutMs = 15_000;
            if (file) {
              // The message and the file go up together as one form; the text becomes the file's caption.
              payload = new FormData();
              payload.append("payload_json", JSON.stringify({ ...body, attachments: [{ id: 0, filename: String(file.name).slice(0, 100) }] }));
              payload.append("files[0]", new Blob([Buffer.from(file.data, "base64")], { type: file.mime }), String(file.name).slice(0, 100));
              timeoutMs = 60_000;
            }
            const sent = await api("POST", `/channels/${encodeURIComponent(target.conversationId)}/messages`, payload, { timeoutMs });
            return { messageId: String(sent.id) };
          } catch (e) {
            // Discord says how long to wait when it is rate-limiting; honour short waits once, otherwise let the Gateway retry.
            if (e.status === 429 && attempt === 0 && typeof e.retryAfter === "number" && e.retryAfter <= 10) {
              await pause(e.retryAfter * 1000 + 50);
              continue;
            }
            throw new Error(clean(e));
          }
        }
      },

      async typing(target, on) {
        if (!on) return; // the indicator clears by itself after a few seconds
        await api("POST", `/channels/${encodeURIComponent(target.conversationId)}/typing`).catch(() => undefined);
      },
    });

    ctx.log("info", "discord channel registered");
  },
};
