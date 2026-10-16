# Phase 0 Spike Results

Throwaway code in `spikes/` (not part of the build). Environment: Windows 11, Node 24.18, local SSD, run once on 2026-10-16. Numbers are indicative, not benchmarks.

## Spike 1 — ACP client against two harnesses: **NOT DONE**
Needs real ACP-speaking harnesses and provider credentials, which were not available in this session. ADR-0007 therefore remains an **unvalidated assumption**. Next step: owner provides (or approves installing) two ACP harnesses; time-box 2 days; deliverable = minimal client that does prompt, stream, tool-call round-trip, cancel. Also verify the ACP specification's licence and stability.

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

Conclusion: out-of-process plugins cost ~50 ms to start and ~0.1 ms per call — negligible for channel/tool plugins; ADR-0006 holds. Not measured: per-process memory of many plugins, Windows vs Linux differences, and permission enforcement (Node's permission model or OS sandboxing) — still open (docs/13 weakness 5).

## Spike 4 — Delegated send grant (`spikes/send-grant`) — **PASS (logic only)**
Ed25519 Gateway-signed grant bound to device, relay, token hash, expiry, nonce and send quota. Relay accepted valid sends and refused: unattested registration, tampered grant, grant signed by another gateway key, expired, wrong relay, wrong push token, and sends beyond the quota. **This does not validate Apple App Attest or Play Integrity** (needs real devices and vendor services); the attestation step is a stub boolean. ADR-0011's binding logic is sound; the attestation integration remains to be proven in Phase 2/3.

## Spike 5 — Telegram end-to-end latency baseline: **NOT DONE**
Needs a bot token and network access to a test account. Deferred to the start of Phase 1 when the Telegram adapter is built; baseline will be recorded then.

## Follow-ups
1. Spike 1 (ACP) — blocker for locking ADR-0007.
2. Confirm `node:sqlite` stability on Node 22 or pick better-sqlite3 (ADR-0003 follow-up).
3. Power-loss durability test for the event log (VM hard-reset) before 1.0.
4. Plugin permission enforcement design.
