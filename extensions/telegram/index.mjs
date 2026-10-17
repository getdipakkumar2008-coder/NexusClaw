// Telegram channel for ClawNexus. Talks to the Telegram Bot API by long polling, so it needs no public address.
//
// What it does: receives text messages sent to your bot and hands them to the Gateway, which decides who may talk to
// the assistant (pairing), applies group rules and sends replies back through `send`. What it never does: format
// replies (they are sent as plain text), follow links, fetch a file from anywhere but Telegram, or act on anything but ordinary messages.
//
// A plugin runs in its own process and can read nothing outside its own folder, so this file imports nothing.

/** @type {import("@clawnexus/plugin-sdk").PluginDefinition} */
export default {
  setup(ctx) {
    const token = ctx.secrets.get("bot_token");
    const configured = typeof ctx.config.apiBase === "string" ? ctx.config.apiBase : "https://api.telegram.org";
    const pollSeconds = typeof ctx.config.pollSeconds === "number" ? ctx.config.pollSeconds : 25;
    const apiBase = configured.replace(/\/+$/, "");

    // The token travels in the address of every request, so never send it over plain http to another machine.
    const local = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(apiBase);
    const safeBase = apiBase.startsWith("https://") || local;

    let host;
    let me; // { id, username }
    let running = false;
    let abort;
    let loop;
    let offset = 0;

    /** Error text with the token removed, in case a library put the address in a message. */
    const clean = (e) => String(e instanceof Error ? e.message : e).split(token ?? "\u0000").join("[token]").slice(0, 200);

    async function api(method, body, { signal, timeoutMs = 15_000 } = {}) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const res = await fetch(`${apiBase}/bot${token}/${method}`, {
        method: "POST",
        // A form (a file upload) sets its own content type with the boundary.
        ...(body instanceof FormData ? { body } : { headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      let json;
      try {
        json = await res.json();
      } catch {
        throw Object.assign(new Error(`Telegram answered ${res.status} without a usable body`), { status: res.status });
      }
      if (!json.ok) {
        throw Object.assign(new Error(`Telegram: ${json.description ?? "error"} (${json.error_code ?? res.status})`), {
          status: json.error_code ?? res.status,
          retryAfter: json.parameters?.retry_after,
        });
      }
      return json.result;
    }

    const sleep = (ms, signal) =>
      new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
      });

    /** A mention of this bot, a command addressed to it, or a reply to something it said. */
    function mentionsMe(m) {
      const text = m.text ?? m.caption ?? "";
      for (const e of m.entities ?? m.caption_entities ?? []) {
        if (e.type !== "mention" && e.type !== "bot_command") continue;
        const piece = text.slice(e.offset, e.offset + e.length).toLowerCase();
        if (e.type === "mention" && piece === `@${me.username.toLowerCase()}`) return true;
        if (e.type === "bot_command" && piece.endsWith(`@${me.username.toLowerCase()}`)) return true;
      }
      return m.reply_to_message?.from?.id === me.id;
    }

    const MAX_FILE = 8 * 1024 * 1024; // the Gateway takes no more than this per file
    const MAX_FILES = 4;

    /** Download a file from Telegram's file server, at most MAX_FILE bytes. base64, or undefined if it failed or was too big. */
    async function fetchFile(filePath) {
      const res = await fetch(`${apiBase}/file/bot${token}/${filePath}`, { signal: AbortSignal.timeout(30_000) });
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

    /** The files of a message: pictures, documents, audio and voice notes are downloaded; anything else is only noted. */
    async function filesOf(m) {
      const wanted = [];
      if (Array.isArray(m.photo) && m.photo.length) {
        // Telegram sends one picture in several sizes; take the biggest that is small enough.
        const sizes = [...m.photo].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0));
        const fits = sizes.find((p) => (p.file_size ?? 0) <= MAX_FILE) ?? sizes[0];
        wanted.push({ id: fits.file_id, name: "photo.jpg", size: fits.file_size });
      }
      if (m.document) wanted.push({ id: m.document.file_id, name: m.document.file_name ?? "document", mime: m.document.mime_type, size: m.document.file_size });
      if (m.audio) wanted.push({ id: m.audio.file_id, name: m.audio.file_name ?? "audio", mime: m.audio.mime_type, size: m.audio.file_size });
      if (m.voice) wanted.push({ id: m.voice.file_id, name: "voice.ogg", mime: m.voice.mime_type, size: m.voice.file_size });
      for (const k of ["video", "video_note", "sticker", "animation"]) if (m[k] !== undefined) wanted.push({ name: k });
      const out = [];
      for (const w of wanted.slice(0, MAX_FILES)) {
        const note = { name: w.name, ...(w.mime ? { mimeType: w.mime } : {}), ...(typeof w.size === "number" ? { bytes: w.size } : {}) };
        if (!w.id || (typeof w.size === "number" && w.size > MAX_FILE)) {
          out.push(note); // too big, or not a kind we fetch: the Gateway records that it was sent
          continue;
        }
        try {
          const info = await api("getFile", { file_id: w.id });
          const data = typeof info?.file_path === "string" ? await fetchFile(info.file_path) : undefined;
          out.push(data === undefined ? note : { ...note, data });
        } catch {
          out.push(note);
        }
      }
      return out;
    }

    /** Telegram message -> what the Gateway expects, or undefined when it is not for us. */
    async function toInbound(m) {
      if (!m || !m.chat || !m.from || m.from.is_bot) return undefined;
      const text = m.text ?? m.caption ?? "";
      const media = ["photo", "document", "audio", "voice", "video", "video_note", "sticker", "animation"].filter((k) => m[k] !== undefined);
      if (text === "" && media.length === 0) return undefined;
      const files = media.length ? await filesOf(m) : [];
      const isGroup = m.chat.type !== "private";
      const display = m.from.username ? `@${m.from.username}` : [m.from.first_name, m.from.last_name].filter(Boolean).join(" ");
      return {
        accountId: "default",
        conversationId: String(m.chat.id),
        senderId: String(m.from.id),
        ...(display ? { senderDisplay: display.slice(0, 200) } : {}),
        // Telegram message numbers repeat across chats, so the chat is part of the id.
        messageId: `${m.chat.id}:${m.message_id}`,
        text,
        ...(m.reply_to_message ? { replyTo: `${m.chat.id}:${m.reply_to_message.message_id}` } : {}),
        isGroup,
        mentionsBot: isGroup ? mentionsMe(m) : true,
        ...(typeof m.date === "number" ? { ts: m.date * 1000 } : {}),
        ...(files.length ? { attachments: files } : {}),
      };
    }

    async function poll(signal) {
      let failures = 0;
      while (running && !signal.aborted) {
        try {
          const updates = await api("getUpdates", { offset, timeout: pollSeconds, allowed_updates: ["message"] }, { signal, timeoutMs: pollSeconds * 1000 + 10_000 });
          failures = 0;
          for (const u of updates) {
            const inbound = await toInbound(u.message);
            if (inbound) await host.deliver(inbound);
            // Move on only after the Gateway has taken the message. A repeat after a restart is ignored by its message id.
            offset = Math.max(offset, u.update_id + 1);
          }
          if (updates.length) host.setStatus({ state: "connected" });
        } catch (e) {
          if (signal.aborted) return;
          const status = e.status;
          if (status === 401 || status === 404) {
            host.setStatus({ state: "auth_required", detail: "Telegram rejected the bot token" });
            return;
          }
          failures++;
          const detail = status === 409 ? "another program is polling this bot" : clean(e);
          host.setStatus({ state: "degraded", detail });
          await sleep(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)), signal);
        }
      }
    }

    const CAPTION_MAX = 1024; // what Telegram allows under a file (a message may be 4096)

    /**
     * One file, as a photo, audio or document. The Gateway has already checked what it is; Telegram only ever gets our bot's upload.
     * A caption longer than Telegram allows under a file goes as an ordinary message right after it, whole. A picture that
     * Telegram refuses as a photo (too big, or a shape it does not like) is sent again as a document.
     */
    async function sendFile(target, file, caption) {
      const [method, field] = file.mime === "image/png" || file.mime === "image/jpeg" ? ["sendPhoto", "photo"] : file.mime === "audio/mpeg" || file.mime === "audio/mp4" ? ["sendAudio", "audio"] : ["sendDocument", "document"];
      const text = caption ? String(caption) : "";
      const followUp = text.length > CAPTION_MAX;
      const form = (as) => {
        const f = new FormData();
        f.append("chat_id", String(Number(target.conversationId)));
        if (text && !followUp) f.append("caption", text);
        f.append(as, new Blob([Buffer.from(file.data, "base64")], { type: file.mime }), String(file.name).slice(0, 100));
        return f;
      };
      let sent;
      try {
        try {
          sent = await api(method, form(field), { timeoutMs: 60_000 });
        } catch (e) {
          if (method !== "sendPhoto" || e.status !== 400) throw e;
          sent = await api("sendDocument", form("document"), { timeoutMs: 60_000 });
        }
      } catch (e) {
        throw new Error(clean(e));
      }
      if (followUp) {
        // The file has arrived. If the words cannot follow, do not fail the send: the Gateway would send the file again.
        await api("sendMessage", { chat_id: Number(target.conversationId), text, disable_web_page_preview: true }).catch((e) => ctx.log("warn", `telegram: the text for a file could not be sent: ${clean(e)}`));
      }
      return { messageId: `${target.conversationId}:${sent.message_id}` };
    }

    ctx.registerChannel({
      id: "telegram",
      capabilities: { typing: true, groups: true, maxTextChars: 4096, files: true },

      async start(h) {
        host = h;
        if (!token) throw new Error("the bot token is not set");
        if (!safeBase) {
          host.setStatus({ state: "degraded", detail: "apiBase must be https (or localhost)" });
          throw new Error("apiBase must use https, or point at this computer");
        }
        try {
          const info = await api("getMe", {});
          me = { id: info.id, username: String(info.username ?? "") };
          // Polling and a webhook cannot both be active; make sure ours is the one.
          await api("deleteWebhook", { drop_pending_updates: false });
        } catch (e) {
          if (e.status === 401 || e.status === 404) {
            // Not a crash: the owner has to fix the token. Reporting it as such is clearer than a failed start.
            host.setStatus({ state: "auth_required", detail: "Telegram rejected the bot token" });
            return;
          }
          throw new Error(clean(e));
        }
        running = true;
        abort = new AbortController();
        host.setStatus({ state: "connected", detail: me.username ? `@${me.username}` : undefined });
        loop = poll(abort.signal);
        loop.catch(() => undefined);
      },

      async stop() {
        running = false;
        abort?.abort();
        await loop?.catch(() => undefined);
        loop = undefined;
      },

      async send(target, content) {
        const file = Array.isArray(content.files) ? content.files[0] : undefined;
        if (file) return sendFile(target, file, content.text);
        const body = { chat_id: Number(target.conversationId), text: content.text, disable_web_page_preview: true };
        const replyId = target.replyTo ? Number(String(target.replyTo).split(":").pop()) : NaN;
        // Reply to the asking message in groups so people can tell who is being answered; direct chats need no thread.
        if (Number.isInteger(replyId) && Number(target.conversationId) < 0) body.reply_parameters = { message_id: replyId, allow_sending_without_reply: true };
        for (let attempt = 0; ; attempt++) {
          try {
            const sent = await api("sendMessage", body);
            return { messageId: `${target.conversationId}:${sent.message_id}` };
          } catch (e) {
            // Telegram says how long to wait when it is rate-limiting; honour short waits once, otherwise let the Gateway retry.
            if (e.status === 429 && attempt === 0 && typeof e.retryAfter === "number" && e.retryAfter <= 10) {
              await sleep(e.retryAfter * 1000);
              continue;
            }
            throw new Error(clean(e));
          }
        }
      },

      async typing(target, on) {
        if (!on) return; // Telegram clears the indicator by itself after a few seconds
        await api("sendChatAction", { chat_id: Number(target.conversationId), action: "typing" }).catch(() => undefined);
      },
    });

    ctx.log("info", "telegram channel registered");
  },
};
