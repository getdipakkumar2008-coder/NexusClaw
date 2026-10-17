# 17. Code-review findings after WP13: analysis and fixes

Source: an automated code review of commit `3aaf1ac` (outbound files, WebChat upload, scan hook, picture cleaning, WP13)
raised ten findings. Before changing anything each one was checked against the code, and the baseline was run
(`pnpm check:all`: 44 test files, 788 passed, 3 skipped). Each fix is made on its own, with its own tests, and the whole
suite is run after every one. Nothing here changes the wire protocol, the database schema or the plugin SDK version.

How to read the table: **Confirmed** means the failure was reproduced by reading the code path; **Partly** means the
finding is right about a weakness but wrong about part of its scenario (said so below, so nobody has to rediscover it).

| # | Finding | Verdict | Fix | Where |
|---|---|---|---|---|
| 1 | File sends cut off at 30 s, plugins allow up to 120 s, so a slow upload is sent again | Confirmed | A separate, longer time limit for rows that carry a file, in the router and in the plugin call | `channels/manager.ts`, `plugins/channel.ts` |
| 2 | WebChat: a failed upload loses the typed text and leaves a "pending" bubble | Confirmed | Wait for the Gateway's `ready` for each file; on any failure restore the text and files, remove the bubble, say why | `channels/assets/app.js` |
| 3 | Picture cleaning gives back the original bytes (location included) when the file does not parse | Confirmed | Cleaning now says whether it worked. Data after the end of a picture is cut. `file.send` refuses a picture that could not be cleaned | `blobs/clean.ts`, `gateway/filetool.ts` |
| 4 | A throw while building a file send stalls the conversation | **Partly.** `BlobStore.read` never throws (a missing or damaged file returns nothing and the row is failed, already tested), so the described cause does not happen. Any other throw in that branch does end the loop silently | Build the content inside a guard that fails the row | `channels/manager.ts` |
| 5 | `sessions export --out` stops half-way on a missing file, raw error on a bad `--out` | Confirmed | Missing files are listed and skipped, the rest is saved, a clear error for a file given as `--out`, transcript written with the same private mode | `cli/run.ts` |
| 6 | Telegram: caption cut at 1024 characters; a photo Telegram refuses is never sent as a document | Confirmed | A longer caption goes as a normal message after the file; a refused photo is retried as a document | `extensions/telegram` |
| 7 | `file.send` queues the file, then records it; if recording fails the model retries and the file goes twice | Confirmed (rare: the session was checked just before) | Record inside the same step, before delivery starts; if recording fails the queued row is removed | `channels/manager.ts`, `channels/outbox.ts`, `gateway/filetool.ts` |
| 8 | Scan program killed for too much output is reported as "timed out"; scan copies survive a crash | Confirmed | Say what really happened; clear old copies when the Gateway starts | `blobs/scanhook.ts`, `gateway/server.ts` |
| 9 | A message naming several uploads uses up the early ones before it finds a bad one | **Partly.** The count in `c.uploaded` is the intended per-connection byte cap, not a leak, and chunk frames are bounded by that cap, so no rate limit is added. The partial consumption is real | Check every name first, then use them | `channels/webchat.ts` |
| 10 | `hasFile` finds attachments by text-matching serialized JSON | Confirmed (works today, breaks if the field order changes) | Look inside the JSON properly | `sessions/manager.ts` |

## Decisions and the reasons

- **#1.** One limit is not right for text and for a file. Text keeps `adapterTimeoutMs` (30 s). A row with a file uses
  `fileTimeoutMs` (default 130 s: Slack's three steps are allowed 30 + 60 + 30 s inside the plugin). The plugin call uses the
  same figure when the message has a file. If the send still fails, retrying remains at-least-once, as documented.
- **#2.** The client cannot know a file was refused until the Gateway says so, so it now waits for the `file` frame with
  status `ready` (or an error) before sending the message, for 30 s at most, and stops sending pieces of a file the Gateway
  already refused. No protocol change: the frames already carry `up`.
- **#3.** Inbound pictures are still kept as they came when they cannot be cleaned: they stay on the owner's machine and are
  shown to the model, as before, so nothing that works today stops working. The privacy risk is in what leaves, so
  `file.send` refuses a picture that could not be cleaned and says so. Cutting data after the end of a PNG, and after the
  end of a JPEG, removes appended payloads (extra pictures, motion-photo video) that carry their own metadata.
- **#4.** Defensive only; no behaviour change when everything works.
- **#7.** Order becomes: check the target, queue (not yet started), record in the transcript, start delivery. A failed
  record removes the queued row, so the model's retry cannot cause a second copy.
- **#8.** The copies are only ever inside `<data>/scan-tmp`; anything there at start-up is by definition left over.

## Result

All ten are fixed, each with a test that failed before the change and passes after it (the page tests were also run against the
old script to confirm they fail there). Behaviour that changed on purpose:

- A PNG or JPEG with data after its end now has that data cut (before: returned unchanged). Existing test expectation changed.
- `file.send` now refuses a JPEG or PNG that cannot be parsed (before: sent as it was). The test fixtures that used a
  made-up PNG now use a real chunked one.
- The WebChat page waits for the Gateway's "ready" before sending a message with files (before: sent at once). The existing
  page test now delivers the `ready` frame.
- `ChannelManager.sendFile` takes an optional `record` step that runs before delivery starts; `Outbox.enqueueFile` returns the
  group id (or nothing if full) instead of true/false; `Outbox.discard` is new; `cleanPicture`, `sweepScanTemp` and
  `exportToFolder` are new; `FakeAdapter.sendDelayMs` is a new test aid.

Tests added: 1 slow-send, 1 unreadable blob, 1 record-first, 2 `hasFile`, 1 multi-upload, 3 scan hook, 3 cleaner, 1 `file.send`
(trailing data and refusal), 6 export folder, 2 Telegram, 5 page.

## What is deliberately not changed

- The 64 MB per-connection upload cap stays cumulative (docs/05): it is the limit on what one browser tab can make the Gateway
  receive.
- No sandbox, keychain or protocol work is mixed in here.

## Verification for each fix

A test that fails before the change and passes after it, then `pnpm check:all` (unit tests, lint, types, boundaries,
licences). At the end `pnpm package && pnpm package:smoke`.
