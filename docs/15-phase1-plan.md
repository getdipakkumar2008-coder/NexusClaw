# 15 — Phase 1 Work Plan ("Secure core")

Source: `10-roadmap.md` Phase 1. Exit criteria are repeated at the end. Status column is kept current by whoever lands a work package (WP).

| WP | Work package | Docs | Depends on | Status |
|---|---|---|---|---|
| WP1 | **Event store**: SQLite WAL durable event log, cursor resume, compaction, subscribers (`src/store`) | 02 §7, 03 §6 | — | **Done (this commit)** |
| WP2 | **Tool policy engine**: principals, risk classes R0–R4, profiles, taint, elevation, call-bound approvals (`src/policy`) | 06 §4 | — | **Done (this commit)** |
| WP3 | **Pairing service**: senders table, hashed one-time codes, expiry, cooldown and global rate limits, approve/deny/revoke/block, owner registration (`src/pairing`) | 05 §2, 06 T3 | WP1 | **Done** |
| WP4 | **Vault**: AES-256-GCM secret file keyed by scrypt passphrase or a raw key from a `KeySource`, atomic writes, redaction (`src/vault`). OS-keychain adapter still to do | 06 SEC-8 | — | **Done (keychain adapter pending)** |
| WP5 | **Gateway server**: WS+HTTP, hello/auth (local token + device keys), method router, events.subscribe with resume, limits (`src/gateway`) | 03 | WP1, WP2, WP4 | **Slice 1 done**: loopback-only server, token auth + lockout, Host/Origin checks, resume, slow-consumer drop, rate limit, pairing + approval methods. **Remaining:** device keys (Ed25519 challenge-response), TLS for non-loopback, session methods (WP6), `config`/`doctor`/`plugin` methods, vault wiring |
| WP6 | **Sessions & runs**: session keying, per-sender isolation, queueing (1 run/session), transcripts, export | 01 FR-SES | WP1, WP5 | |
| WP7 | **Provider runtime**: provider interface, fake provider for tests, then ACP client `extensions/acpx` (**blocked on spike 1**) | 04 §7 | WP6 | Blocked |
| WP8 | **Tool executor**: host exec with timeout/cancel/process-tree kill, workspace path guard, approvals flow | 06 T14 | WP2, WP6 | |
| WP9 | **Plugin host**: manifest load, SDK range check, child-process isolation, crash containment | 04 | WP5 | |
| WP10 | **Channels**: adapter contract + conformance suite; Telegram, Discord, Slack, WebChat | 05 | WP3, WP6, WP9 | |
| WP11 | **Memory v1**: Markdown store, per-contact scoping, export/delete | 01 FR-MEM | WP6 | |
| WP12 | **CLI & operations**: `setup` wizard, `doctor` / `doctor --fix`, `status`, `pairing approve`, backup/restore, structured redacted logs | 14 | WP5, WP4 | |
| WP13 | **Hardening**: injection corpus in CI, authz matrix test, fuzz targets, footprint/latency NFR measurement, external review of policy/pairing/vault | 06 §9 | all | |

## Sequencing
Foundation first (WP1–WP4 are independent and unit-testable), then the Gateway (WP5) so everything else has a home, then behaviour (WP6–WP9), then channels and UX (WP10–WP12), then hardening (WP13). The first demonstrable milestone ("M1") is: CLI → Gateway → fake provider → reply, with pairing and policy active, before any real channel or model.

## Rules for every WP
1. Spec in `docs/` first (or already there); tests with the code; `pnpm check:all` green.
2. Security-sensitive WPs (2, 3, 4, 5, 8) get a threat-model note in the PR and are listed for external review.
3. Update `docs/provenance/LOG.md`, and surface-budget if core grows.
4. No real credentials in tests; channels use mocks/recordings.

## Decisions made while starting Phase 1
- **SQLite driver:** `node:sqlite` (built in; no native build step). Requires Node >= 22.13 where it no longer needs a flag. `engines` updated accordingly. Revisit only if it proves unstable (ADR-0003 follow-up).
- **Event-log durability:** `synchronous=FULL` by default (spike 2); callers batch events per transaction.
- **Vault KDF:** scrypt (N=2^17, r=8, p=1), not Argon2id as docs/06 §6 said: Node 22 has no built-in Argon2id (it arrived in Node 24.7+) and the project avoids native dependencies. Parameters are stored in the (authenticated) header and bounded on read. Revisit when Node 24 is the floor.
- **Pairing:** a pairing code can only ever create a *guest*; owner identities are registered only via `registerOwner` from an authenticated local surface (T2). Challenge cooldown is tracked on the sender row so it survives code expiry (bug found by a test, fixed before release).
- **Gateway slice 1:** loopback-only (a non-loopback bind throws until TLS exists). Browsers can't drive it: Host must be loopback and Origin must be allow-listed (default none). One shared owner token (file mode 0600) authenticates local clients; per-address lockout after repeated failures. Method names may be single-segment (`status`) or dotted.
- **Always-ask rule:** R4 (irreversible/external side effects) is never auto-allowed by any profile.

## Exit criteria (from the roadmap)
Fresh machine → first reply in a paired channel ≤10 min (median, n≥5) · controls for T1–T3, T6, T7, T14, T15 implemented and tested · injection corpus passes · authz matrix + protocol conformance + crash-recovery tests pass · NFR footprint/latency met · external security review of policy/pairing/vault done · no known critical/high vulns.
