# 05 — Channels

## 1. Adapter contract (`ChannelAdapter`)
```ts
interface ChannelAdapter {
  id: string; capabilities: { threads, reactions, attachments, edits, typing, groups, voiceNotes, … };
  start(ctx): Promise<void>; stop(): Promise<void>;
  status(): ChannelStatus;                       // connected | degraded | auth_required | stopped
  onInbound(handler: (msg: InboundMessage) => void): void;
  send(target: Target, content: OutboundContent): Promise<SendResult>;
  // optional: edit, react, typing, fetchHistory, resolveIdentity
}
```
Normalised `InboundMessage`: `{channel, accountId, conversationId, senderId, senderDisplay, text, attachments[], replyTo?, isGroup, mentionsBot, ts, raw?}`. `raw` is never passed to the model.

## 2. Mandatory behaviours (conformance suite)
1. Inbound is **untrusted** (SEC-3): marked as such in prompt assembly; no instruction in message content can change policy.
2. Unknown sender → no agent run; pairing challenge (rate limit: 1/sender/hour, global cap) → owner runs `clawnexus pairing approve <code>`; codes expire in 1 h; max pending N.
3. Group chats: respond only when mentioned/allowed; per-group allowlist.
4. Idempotent delivery (dedupe by platform message id).
5. Reconnect with backoff+jitter; surface `auth_required` clearly.
6. Attachment size/type limits, content-type sniffing, AV hook point.
7. Outbound rate-limit awareness (platform quotas).
8. No credential leakage into logs.

## 3. Channel matrix (target: ≥20 *external messaging platforms* by v1.0, excluding WebChat, generic webhook and A2A)
Tier A = official bot/API (stable). Tier B = unofficial/reverse-engineered or host-bound (fragile, may violate ToS) — ship as opt-in community-labelled plugins with explicit warning.

| # | Channel | Integration | Tier | Phase | Notes / risk |
|---|---|---|---|---|---|
| 1 | Telegram | Bot API | A | 1 | |
| 2 | Discord | Bot gateway | A | 1 | Message-content intent approval |
| 3 | Slack | Bolt/Socket Mode | A | 1 | |
| 4 | WebChat | Gateway-native | A | 1 | |
| 5 | Microsoft Teams | Bot Framework | A | 2 | Azure app reg complexity |
| 6 | Google Chat | Chat API | A | 2 | Workspace admin |
| 7 | A2A v1.0 | A2A protocol | A | 2 | Agent-to-agent trust rules (§5) |
| 8 | Matrix | CS API | A | 2 | |
| 9 | Email (IMAP/SMTP) | standard | A | 2 | Spam/loop guards |
| 10 | WhatsApp | Cloud API (A) / Web multi-device (B) | A/B | 2 | Business API needs Meta account; Web mode ToS risk |
| 11 | Signal | signal-cli | B | 2 | Unofficial; JVM dep |
| 12 | iMessage | macOS Messages/BlueBubbles | B | 3 | Requires a Mac host, Apple ToS grey |
| 13 | SMS | Twilio/other | A | 3 | Cost |
| 14 | IRC | RFC | A | 3 | |
| 15 | Mattermost | API | A | 3 | |
| 16 | Rocket.Chat | API | A | 3 | |
| 17 | LINE | Messaging API | A | 3 | |
| 18 | Viber | Bot API | A | 3 | |
| 19 | WeChat Work / Feishu | API | A | 3 | Regional |
| 20 | Twitch chat | IRC/API | A | 3 | |
| 21 | Nextcloud Talk | API | A | 3 | |
| 22 | Zulip | API | A | 3 | |
| 23 | Generic inbound/outbound webhook | HTTP | A | 2 | Not a "platform"; enables long tail |
| 24 | Voice (SIP/telephony) | plugin | A | 4 | |
Count check (review 2): rows 1–22 minus WebChat, A2A = 20 external platforms in Phases 1–3 (3 of them Tier B), meeting "20+" only if Tier-B channels count; with Tier A only it is 17 — so reaching 20+ Tier A needs more candidates (Q-4). (Earlier draft counted WebChat/A2A and the Phase-4 voice row, overstating the total.)
The exact 20+ list is **[Proposed]**; only 8 were named in `req.odt` — see Q-4.

## 4. Platform risk register
- ToS/legal: Tier B channels may break; each Tier B plugin ships a README stating risk; project does not bundle them in "official" builds **[Proposed, Q-5]**.
- Breakage cadence: Tier B expected to break on platform changes; owners assigned per channel; CI includes smoke tests against recorded fixtures (live tests are manual/nightly with test accounts).
- Privacy: message content from channels is personal data; stays local; see `06`.

## 5. A2A channel specifics
- Inbound agents are untrusted principals; require explicit trust (pair by Agent Card + key). Capabilities exposed to remote agents are an explicit allowlist (default: none beyond chat).
- Outbound: Gateway acts as A2A client; remote responses treated as untrusted tool output.
- Loop/recursion protection (hop count, budget).
- Conformance against the published A2A v1.0 spec/test kit.

## 6. Acceptance per channel
Adapter conformance suite 100% pass · E2E test using sandbox account/mocks · documented setup < 5 min · failure modes documented.

## 7. Implementation status (WP10 slice 1, 2026-10-16)
- Built: the adapter contract (`ChannelAdapter` with a host-injected `deliver`), the router that enforces section 2 items 1-4 and 7 centrally, a shared conformance suite that every adapter runs (`defineConformance`), and the built-in WebChat. Telegram, Discord and Slack come next as plugins, which needs plugin config and secrets first.
- Conformance items covered today: untrusted inbound and pairing (1, 2), groups (3), de-duplication (4), reconnect/status reporting (5, adapter-side), outbound limits and splitting (7), no credential leakage in logs (8). Attachments (6) and the persistent outbox are described below.
- Not built: per-channel allow/deny lists beyond pairing and group allow-lists, re-encoding of pictures or PDFs (only hidden metadata is cut out of JPEG and PNG), sending several files in one message.

### Attachments (inbound)
- **Who and when.** Files are handled only after a message has passed pairing, group rules, de-duplication and the sender's rate limit, so a stranger, a repeat or a flooder never causes a byte to be stored.
- **What is accepted is decided from the content, never from the sender's claim.** The first bytes must be a PNG, JPEG, GIF or WebP picture, a PDF, OGG/MP3/WAV/M4A audio, or UTF-8 text with no control characters. Programs, archives, documents of other kinds and any binary are refused with a reason. The declared type and the file name are never believed; names are reduced to a bare printable name. No file is parsed or executed by the Gateway.
- **Limits.** Four files per message, 8 MB each, 16 MB per message, 1 GB in the store; extra or oversized files are noted as not taken. An adapter may send at most 24 MB of file data in one message.
- **Storage.** `<data>/blobs/<aa>/<sha256>`, mode 0600, one copy of identical files; a read checks the bytes still match the name. Messages hold references (id, name, real type, size, or the reason a file was refused), never bytes. Files nothing refers to (a session was deleted) are removed, with a one-hour grace for new ones. They are part of a backup.
- **The model.** The newest message's files go to the harness as ACP content blocks where it said it accepts them (images, audio, embedded PDF); text files are shown inline (first 20 000 characters) as untrusted content; anything else, and every refused file, is described in the message so the model knows something was sent. File names appear as quoted data. Files are labelled as from the sender, and what the model may do is still decided by policy.
- **Platforms.** The Telegram, Discord and Slack plugins download pictures, documents and audio (Telegram also voice notes) from the platform's own file hosts only; the Slack bot token is sent only to files.slack.com. A file address that is not the platform's is never fetched, whatever a message says. Videos and stickers are noted, not fetched.
- **Hidden personal data.** Before a JPEG or PNG is kept, its metadata blocks are cut out: EXIF/XMP (location, camera, time, owner name), IPTC, comments, PNG text and time chunks. The pixels are never decoded or re-encoded, so nothing is lost and there is nothing here for a crafted picture to attack; a picture that does not parse cleanly is kept as it came (it stays on the owner's machine and goes only to the model), but is never sent out by `file.send`. Whatever is appended after the end of a picture (a second picture, a motion-photo video, a note) is cut, because it carries its own metadata. The EXIF "turn this picture" hint goes with the rest, so a few phone photos may look turned. GIF, WebP, PDF and audio are not cleaned.
- **File check hook (optional).** If the owner puts a program at `<data>/hooks/scan` (`scan.exe` on Windows), it is run on every file that passed the type test, before the file is kept, with the path of a copy as its only argument, no shell, a minimal environment and a 30-second limit. Exit code 0 accepts the file; anything else (a refusal, a timeout, a program that prints more than 64 KB, a program that cannot start) refuses it with a one-line reason that says which, so a broken scanner never lets files through unchecked. Copies a crash left in `<data>/scan-tmp` are removed when the Gateway starts. The copy has a name made by the Gateway, never the sender's. It is a program the owner installed and runs with the owner's rights, like any other thing the owner installs; it is meant for a wrapper around an antivirus scanner.
- **WebChat upload.** The page's "Attach" button sends up to four files of 8 MB each in pieces of at most 192 KB (frames are capped at about 256 KB), only after the visitor has said hello and only for a visitor who is already paired; a stranger is told to wait for approval and nothing is held for them. Pieces are put together in memory per connection (open files, bytes waiting and bytes per connection are capped), then handed to the Gateway with the message, which applies every rule above again. Before hello a frame may not exceed 16 KB. The page sends the message only after the Gateway has said each file is complete (`file` frame with `ready`); if the Gateway refuses a file, stops answering for 30 seconds or the connection drops, nothing is sent, the "waiting" bubble is removed, and the visitor gets their text and their files back with the reason. A message that names several files uses none of them if one is missing, so it can be sent again.
- **Owner access.** `sessions show` lists a message's files; `attachment get ID --out FILE` saves one (a paired device with the read scope can fetch with `blob.get`). `sessions export ID --out DIR` saves the transcript and every file; a file the store no longer has is listed and skipped, and the rest is still saved (the folder must be new or empty, or pass `--force`).

### Files out (the assistant sending a file)
- The model has one tool for this, `file.send`, with either `attachment` (the id of a file already in this conversation) or `path` (a file in the workspace), an optional `name` and a short `caption`. **There is no destination argument**: the file goes into the conversation of the session making the call, to the people already in it, and nowhere else.
- It is a network action (risk 2): the owner is asked to approve each use unless the trusted profile is on and nothing untrusted is in the conversation, and a guest's session cannot send files at all (denied). A group session is a guest session. A session that is not on a running messaging channel (the command line, say) gets a plain "nobody to send to" error.
- What can be sent is limited like what can be received: by content, only pictures, PDF, audio and text; 8 MB at most; a path must be inside the workspace and not a protected name; JPEG and PNG lose their hidden metadata on the way out, and a picture whose metadata cannot be removed (it does not parse) is refused with a message saying so rather than sent with it. The file is stored in the blob store, queued in the same outbox as replies (so it survives a restart and waits while a platform is down; the store's clean-up keeps files the outbox still needs), and noted in the transcript as an assistant message with the file attached (`[sent the file "name"]`).
- A channel declares `files: true` to carry them. Telegram sends pictures as photos (a picture Telegram refuses as a photo is sent again as a document), MP3/M4A as audio and everything else as documents; a caption longer than Telegram's 1 024 characters under a file is sent whole as a message right after the file; Discord sends the file and the text as one message with the usual `allowed_mentions` ban on pings; Slack uses its three-step upload (the upload address must be on files.slack.com, and the bot token goes to the API only, never to the upload address) and needs the bot scope `files:write`; WebChat shows a download link made in the browser (the file is never opened or displayed in the page, whatever its type claims).
- Delivery is at-least-once like any reply, but a file is given longer than text to upload (130 seconds against 30, so a slow upload is not started again while the first is still running), and the transcript note is written before delivery starts, so a failure to write it cannot cause a second copy. If a file is no longer in the store when its turn comes, the message is given up on and shown by `channels outbox`.
- Not built: several files in one message; the model sending files it has not been given (anything outside the workspace and the conversation).

### Persistent outbox (outbound)
- Every answer is written to the `outbox` table (one row per piece, split to the platform's limit) before anything is sent, and deleted once the platform accepted it, so a restart, a crashed plugin or a platform outage delays an answer instead of losing it. Delivery is **at-least-once**: if the Gateway dies between the platform accepting a message and the row being deleted, it is sent again. The attempt is counted before sending, so a message that crashes the Gateway still gives up.
- Order is kept per conversation: nothing later is sent until the earlier piece got through. A reply is tried three times with backoff (persisted across restarts), then given up on together with its remaining pieces, which is recorded (`channel.send_failed`) and shown by `channels outbox` (never with the text). `channels outbox retry` and `purge` act on those. A reply older than 24 h is no longer sent; failed rows are forgotten after 7 days. At most 2 000 replies wait in all and 100 per conversation.
- Replies for a channel that is not running (its plugin stopped) wait and are sent when it is back.
- Pairing prompts and "busy"/"slow down" notices are **not** persisted: a pairing code must not be written in plain text, and the others are worthless later.
- A run that a restart cut short is reported once to the person who was waiting ("I was restarted while answering you ... send your message again").
- A restore empties the outbox, so old answers are not sent again.
