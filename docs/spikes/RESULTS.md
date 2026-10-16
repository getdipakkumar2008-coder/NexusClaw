# Phase 0 Spike Results

Throwaway code in `spikes/` (not part of the build). Environment: Windows 11, Node 24.18, local SSD, run once on 2026-10-16. Numbers are indicative, not benchmarks.

## Spike 1 - ACP client against real harnesses: **PARTIAL PASS (1 of 4 verified)** (2026-10-16, WP7 slice 1)
Built a client from the public ACP specification (agentclientprotocol.com, protocol v1: JSON-RPC 2.0, one message per line on stdio) in `src/acp`, and ran it against the real **Claude Code** adapter (`@agentclientprotocol/claude-agent-acp@0.92.0`, Apache-2.0) with the owner's own login.
- **Verified with a real model:** `initialize` (v1) -> `session/new` -> `session/prompt` -> streamed `agent_message_chunk` -> `end_turn`; through the full path `clawnexus chat` -> Gateway -> harness. A second chat in the same session got the earlier context. First start 64 s (adapter download), warm start about 10 s per fresh process; the harness is then kept alive for later chats. No stray processes after the Gateway was stopped.
- **Permission gate verified with the real harness:** asked to run a shell command, Claude Code requested permission, the client rejected it, the command did not run and no file appeared in the workspace; the refusal was reported to the user (`note: 1 request(s) from the harness were declined`).
- **Verified with a scripted harness (CI):** streaming, per-session isolation, permission requests (rejected by default, never an "always" option), refused file/terminal requests, cooperative cancel, kill after a harness ignores cancel, crash and restart, protocol-version mismatch, sign-in errors, runaway output cap, stray stdout noise, oversized messages.
- **Not verified:** Codex (`@agentclientprotocol/codex-acp@2.2.2`), Cursor (`agent acp`, `authenticate` with `cursor_login`) and Gemini CLI (`gemini --acp`) are **not installed here**. Their command lines come from each vendor's public documentation and are untested. The Gemini flag was `--experimental-acp` in older releases; current docs say `--acp`.
- **Tool-call round trip verified with the real harness (WP7 slice 2):** Claude Code was given the Gateway's tools through an MCP server declared in `session/new`. Asked to write a file it called `fs_write`; the Gateway held the call (`write after untrusted content needs approval`), the owner approved it from a second CLI call, the file was written with exactly the requested content, and `fs_list` then ran without approval. The audit log shows request, decision, start and completion, all tied to the session. Finding: Claude Code asks its client for permission before using **any** MCP tool, including ours; without a response to that request the model reports "permission refused" and the bridge is never reached (see docs/15, WP7 slice 2).
- **ADR-0007 (providers via ACP harnesses):** supported by this result for Claude Code; stays "Proposed" until a second harness is verified.

## Spike 2 — Event log: crash-safe append and cursor resume (`spikes/event-log`) — **PASS**
Writer process appends events to SQLite (`node:sqlite`, WAL) and reports an index only after COMMIT returns; the parent SIGKILLs it at random moments (20 kills per mode), then checks invariants.

| synchronous | kills | events written | throughput | violations |
|---|---|---|---|---|
| FULL | 20 | 1,493 | ~200/s | **0** |
| NORMAL | 20 | 20,446 | ~2,000/s | **0** |

Invariants checked each kill: `seq` contiguous from 1, no duplicates or gaps, every acknowledged event present, resume-by-cursor returns each later event exactly once.
Caveats: a process kill is **not** a power loss. `synchronous=NORMAL` in WAL mode can lose the last commits on power failure/OS crash (not exercised here); `FULL` is the safe default for the event log at ~200 commits/s on this machine — batch events per transaction to raise throughput. Conclusion: ADR-0003 and the resume design (docs/03 §6) hold; use FULL (or group commits) by default. `node:sqlite` worked on Node 24 (still labelled experimental in some versions — confirm on Node 22 LTS before depending on it, otherwise use better-sqlite3).

## Spike 3 — Plugin isolation cost (`spikes/plugin-isolation`) — **PASS**
| Measure | Result |
|---|---|
| Child-process startup (spawn → ready) | p50 50 ms, max 86 ms |
| Worker-thread startup | p50 27 ms, max 31 ms |
| IPC round trip (5,000 calls) | p50 0.057 ms, p95 0.104 ms, p99 0.152 ms |
| In-process call | ~0.0002 ms |
| Plugin throws | host kept running; child exited code 1 and the exit was observable |

Conclusion: out-of-process plugins cost ~50 ms to start and ~0.1 ms per call — negligible for channel/tool plugins; ADR-0006 holds. Permission enforcement was measured later (WP9, 2026-10-16, Node 24.18 on Windows): with `--permission` a plugin process could not read files outside its allowed folders, write outside its data folder, import code from elsewhere, start programs or worker threads, and saw none of the parent's environment variables (Windows adds its own standard ones). It could still make network requests, so network permission is advisory. Node 22 is checked in CI. Still not measured: per-process memory of many plugins.

## Spike 4 — Delegated send grant (`spikes/send-grant`) — **PASS (logic only)**
Ed25519 Gateway-signed grant bound to device, relay, token hash, expiry, nonce and send quota. Relay accepted valid sends and refused: unattested registration, tampered grant, grant signed by another gateway key, expired, wrong relay, wrong push token, and sends beyond the quota. **This does not validate Apple App Attest or Play Integrity** (needs real devices and vendor services); the attestation step is a stub boolean. ADR-0011's binding logic is sound; the attestation integration remains to be proven in Phase 2/3.

## Spike 5 — Telegram end-to-end latency baseline: **NOT DONE**
Needs a bot token and network access to a test account. Deferred to the start of Phase 1 when the Telegram adapter is built; baseline will be recorded then.

## Follow-ups
1. Spike 1 (ACP): verify a second harness (Codex, Cursor or Gemini) before locking ADR-0007. The tool bridge's harness-permission shortcut currently recognises Claude Code's request format only; other harnesses will have their MCP-tool permission requests rejected until their format is added.
2. Confirm `node:sqlite` stability on Node 22 or pick better-sqlite3 (ADR-0003 follow-up).
3. Power-loss durability test for the event log (VM hard-reset) before 1.0.
4. Plugin permission enforcement design.
