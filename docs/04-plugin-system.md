# 04 — Plugin & Extension System

## 1. Why two tiers
Every core tool, prompt fragment and config key is paid by every operator on every request ("taxed"). Therefore: **Core is minimal; plugins are the default home for new features.**

### Core admission bar (all must be true)
1. Needed by nearly all operators for first-run or safety.
2. Cannot be a plugin without weakening security or the plugin contract.
3. Has a measured per-request cost (tokens/latency) and owner.
4. Has tests, docs, and config-migration story.
Core "tax budget" is tracked in CI (`doctor --surface`): number of core tools, system-prompt tokens, config keys. Regressions need an ADR.

## 2. Plugin styles
| | Code plugin | Bundle plugin |
|---|---|---|
| Content | JS/TS module using `plugin-sdk` | Declarative: skills (Markdown), MCP server definitions, config presets |
| Can register | channels, tools, providers, hooks, services | skills, MCP servers, config defaults |
| Executes code at install | No (executes at load, sandboxed per policy) | **Never** |
| Trust needed | High (signed / reviewed / user-approved) | Lower (but MCP servers they reference run code → surfaced at install) |
| Stability promise | SDK semver | Manifest schema semver |

## 3. Manifest (`clawnexus.plugin.json`)
```jsonc
{
  "id": "telegram", "name": "Telegram channel", "version": "1.2.0",
  "kind": "code" | "bundle",
  "sdkRange": "^1.0.0",
  "entry": "dist/index.js",
  "provides": ["channel:telegram"],
  "permissions": { "network": ["api.telegram.org"], "fs": ["data:plugins/telegram"],
                   "exec": false, "secrets": ["bot_token"] },
  "configSchema": { "mode": { "type": "string", "enum": ["polling", "webhook"] } },
  "hub": { "publisher": "clawnexus", "signature": "…", "sbom": "sbom.json" }
}
```
Permissions are **declared, shown to the operator at install, and enforced** by the Plugin Host where technically possible (process permissions / policy proxy); un-enforceable permissions are labelled "advisory".

## 4. SDK surface (`packages/plugin-sdk`) — v1 draft
- `definePlugin({ setup(ctx) })`
- `ctx.registerChannel(adapter)`, `ctx.registerTool(def)`, `ctx.registerProvider(...)`, `ctx.on(hook, fn)`
- `ctx.config`, `ctx.log` (redacting), `ctx.storage` (namespaced KV + dir), `ctx.secrets.get(name)` (scoped), `ctx.http` (policy-aware fetch)
- Hooks (typed, ordered, timeout-bounded): `message.inbound`, `before_tool_call`, `after_tool_call`, `before_prompt_build`, `run.completed`, `session.start`. Hooks may *deny* or *annotate*, never silently mutate security-relevant fields.
- Stability: only symbols exported from `plugin-sdk` are public. API Extractor report committed; CI fails on unreviewed API diff.

## 5. Lifecycle
discover → validate manifest → check sdkRange + signature → show permissions → user enable → load in isolation → health check → run → unload. Failures are contained; plugin marked `degraded` with reason; Gateway continues.

## 6. ClawNexusHub (registry)
- Index of plugins/skills with metadata, versions, publisher identity, signatures, SBOM, download counts (opt-in only; no telemetry).
- Publishing: GitHub-identity login → CI-provenance (SLSA/sigstore) → automated checks (manifest, deps audit, static scan) → listing. Tiers: **Official** (Foundation-signed), **Verified publisher**, **Community** (warn on install).
- Client: `clawnexus plugins search|install|update|remove|verify`. Install is pinned by version+hash; updates never silent for code plugins (notify + approve; auto-update opt-in for bundles).
- Takedown/revocation list fetched periodically (offline-safe) → Gateway disables revoked plugins.
- Self-hostable registry mirror supported (air-gapped users).
- **Hub backend itself is a separate project/repo**; core only ships the client and the protocol. **[Proposed]**

## 7. Providers & ACP (`extensions/acpx`)
- Implements Agent Client Protocol client; each provider is an ACP-speaking harness launched as a subprocess with a declared command and env allowlist.
- Gateway exposes its tools to harness through ACP/MCP bridge subject to policy.
- Conformance suite: prompt/response, streaming, tool call round-trip, cancellation, error mapping, usage reporting.

## 8. Anti-duplication rule (non-goal OOS-5)
Before accepting a new channel/MCP path, check the "existing infrastructure" list; PR template requires justification of why existing bridge is insufficient.

## 9. Acceptance
Plugin conformance kit; crash-isolation test; permission-enforcement tests; signature-verification tests (tampered package must fail); SDK API-diff gate; sample plugins (hello-tool, hello-channel, hello-bundle) built in CI.

## 10. Implementation status (WP9 slice 1, 2026-10-16)
What exists today (see docs/15 for the full decision note):
- **Code plugins with tools, settings and secrets.** `definePlugin`/`ctx.registerTool` with a typed argument spec, `ctx.config` and `ctx.secrets`; `ctx.registerChannel`; providers, hooks, services, `ctx.http` and `ctx.storage` are not built yet. SDK version 0.3.0 (pre-1.0: caret ranges need the same minor).
- **Manifest rules actually enforced:** `permissions.fs` is only `["data"]`; `permissions.exec` starts programs; `permissions.network` is a declaration only; `permissions.secrets` lists the secret names the plugin needs (lowercase, e.g. `bot_token`). `entry` must be an ES module inside the folder.
- **Enforcement:** file access and program/worker creation are enforced by Node's permission model (`--permission`), measured on Node 24 (Windows) and checked in CI on Node 22. Network is advisory. This closes the open question in the isolation spike for file and exec permissions.
- **Trust:** installing is a copy plus checks; enabling needs the approval code for the exact code and permissions; any change forces a new approval. There are no signatures, tiers or registry yet, so every plugin is shown as `local-unsigned`.
- **Settings and secrets (WP9 slice 2):** `configSchema` declares the owner's settings with the same small vocabulary as tool arguments (string/enum, integer, number, boolean; required unless `optional`). The host validates every value before storing it (table `plugin_config`) and hands the plugin only declared settings, frozen, as `ctx.config`. Secrets declared in `permissions.secrets` are stored in the encrypted vault under `plugin.<id>.<name>` and handed over only by name as `ctx.secrets.get(name)`; every declared secret is required. A plugin that is enabled but missing a required setting or secret is `needs_config`, runs nothing, and starts by itself as soon as the owner provides the rest; changing a setting or secret restarts a running plugin. The owner sets secrets with `plugins secret ID set NAME`, which asks for the value without echo (or reads it from a pipe) and never takes it from the command line; values never appear in config, the database, the audit log, `plugin.settings` replies, or `info`. A plugin's tool results and errors are scrubbed of its own secret values before the model sees them. Removing a plugin deletes its settings and secrets. **What this does not do:** the plugin's code can read its secrets, and because the network is not enforced it could send them anywhere, so a secret is only as safe as the plugin is trustworthy; the review screen says so. The vault key is a random file (`vault.key`, owner-only) beside the vault, so a copy of `secrets.vault` alone is useless, but anyone who can read the whole data folder can open it; an OS-keychain key source is the planned upgrade. A backup copies the vault but not the key, so a restore on another machine needs the key kept separately.
- **Channels (WP10 slice 2):** a plugin may call `ctx.registerChannel({ id, capabilities, start(host), stop(), send(target, content), typing? })` once during `setup`, and its manifest must list `channel:<id>` in `provides`. The channel runs inside the plugin process (same isolation, settings and secrets as any plugin); the Gateway wraps it in an adapter that speaks the same contract as WebChat, so the router does the safety work: strict message schema with the channel id stamped by the Gateway (a plugin cannot speak for another channel, and extra fields such as an owner flag are rejected), pairing for strangers, group rules, de-duplication, rate limits, chunking, retry. The plugin gets only `host.deliver(message)` (resolves with what the router did) and `host.setStatus(...)`. The channel is attached when the plugin runs and withdrawn when it is disabled, stopped, or crashes (messages in flight are dropped; it returns on restart). A channel id that is already taken, or not listed in `provides`, stops the plugin with `degraded` and a reason. At most 32 inbound messages per plugin are awaiting the router at once. **Trust:** a channel plugin vouches for who is writing on its own platform, so a malicious one could claim the id of someone you registered as owner on that channel; install channel plugins only from sources you trust, and register as owner only identities on platforms you trust. The shared conformance suite runs against a channel inside a real plugin process (`src/plugins/src/channel.test.ts`).
- **Slack (WP10 slice 5):** `extensions/slack`, a channel plugin using Socket Mode: an outbound websocket plus the Web API (no public address). Two secrets, `bot_token` and `app_token`, both required (the plugin is `needs_config` until both are set); permits `slack.com` and `*.slack.com`. Only the `message.im` and `app_mention` events are used, so a channel mention arrives once and ordinary channel chatter is never seen. Each event is acknowledged first (Slack resends anything unacknowledged, and the router's persisted de-duplication absorbs repeats), then handed over one at a time in order with a bounded backlog. Slack's periodic `disconnect` is followed by a fresh connection (each socket address is single-use); real failures back off, and a rejected token (`invalid_auth` and friends) shows `auth_required`. Direct messages count as addressed; channel replies go in the thread of the asking message. Outgoing text is escaped (`&`, `<`, `>`) and sent with `mrkdwn:false`, `link_names:false` and no unfurling, so model output can never mention `@channel`, a person or a link. Capped at 3000 characters; no typing indicator. Files are noted, never downloaded; bots, edits, deletions and the app's own messages are ignored. Tokens go only to the configured API address, and the socket address must be `wss://` (or loopback). Tested against a fake Slack (Web API and Socket Mode) through the shared conformance suite in a real plugin process; **not yet verified against real Slack**.
- **Discord (WP10 slice 4):** `extensions/discord`, a channel plugin that holds an outbound Gateway websocket plus the REST API (no public address). One secret (`bot_token`); permits `discord.com` and `gateway.discord.gg`. It asks only for the server-message and direct-message intents, not the privileged message-content one, because Discord still includes the text of messages that mention the bot. It validates the token through the REST API (a rejection, or a later close code 4004, shows `auth_required` and stops), connects, heartbeats, and on a dropped connection resumes the session so missed messages arrive once; fatal close codes (bad intents, sharding) are reported without retrying. Messages are handed over one at a time in order with a bounded backlog. Direct messages count as addressed; in servers a message counts only if it mentions the bot or replies to it, and the bot's own mention is removed from the text. Replies are plain text, capped at 2000 characters, and carry `allowed_mentions: {parse: []}` so model output can never ping `@everyone`, roles or people. Files (up to 8 MB each, four per message) are downloaded from Discord's own file hosts (cdn.discordapp.com, media.discordapp.net) with no credentials, and the Gateway accepts only what the content shows to be an image, PDF, audio or text; the assistant's files go up with the message as one form. Bots, webhooks and service messages are ignored. The token is sent only to the configured API address and to a `wss://` (or loopback) gateway address. Tested against a fake Discord (REST and Gateway) through the shared conformance suite in a real plugin process; **not yet verified against real Discord**.
- **Sending files (SDK 0.3.2):** a channel declares `files: true` in its capabilities and then receives `content.files` (at most one `{name, mime, data}`, `data` base64, 8 MB at most) in `send`; `text` may be empty and is then a caption. The Gateway has already checked the file's type from its content and removed picture metadata. A plugin must upload only to the platform's own hosts. The Gateway allows a send with a file up to 130 seconds (text: 30), so a plugin may take up to that long, and must not itself give up and start again. Telegram, Discord and Slack plugins (0.3.0, `sdkRange ^0.3.2`) do; Slack needs the `files:write` bot scope. See docs/05.
- **Telegram (WP10 slice 3):** `extensions/telegram`, a channel plugin using long polling (no public address). It needs one secret (`bot_token`) and permits `api.telegram.org`. It validates the token with `getMe` (a rejected token shows `auth_required` and polling stops), clears any webhook, then polls; an update is acknowledged only after the Gateway has taken it, and the router's persisted de-duplication absorbs repeats after a restart. Direct messages count as addressed to the bot; in groups a message counts only if it mentions the bot, is a command addressed to it, or replies to it. Replies are plain text (no formatting, so model output cannot inject markup), capped at 4096 characters, and answer the asking message in groups. Pictures, documents, audio and voice notes (8 MB each, four per message) are downloaded from Telegram's file server and the Gateway accepts only what the content shows to be an image, PDF, audio or text; videos and stickers are noted only; other bots, edits and service messages are ignored. It waits out a short Telegram rate limit once, otherwise lets the router retry. The token is sent only to the Bot API address and never over plain http to another machine. Tested against a fake Bot API through the shared conformance suite in a real plugin process; **not yet verified against real Telegram**.
- **Sample:** `extensions/hello-tool`. `hello-channel` and `hello-bundle` come with channels and bundle support.
