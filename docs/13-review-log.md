# 13 — Review Log

## Review 2 (after owner stated: similar to OpenClaw, separate copyright, functionality only)

### Errors fixed
| # | Doc | Issue | Fix |
|---|---|---|---|
| 1 | 00 | Effort said 18–24 months, but roadmap sums to ≈12–15 months (≈60–70 person-months) | Reconciled; added slip-risk note |
| 2 | 05 | "≥20 channels" count included WebChat, A2A and a Phase-4 voice row; Tier-A-only count is 17 | Added Nextcloud Talk, Zulip, webhook rows; honest count and Q-4 note |
| 3 | 02 | `src/plugin-sdk` and `packages/plugin-sdk` both listed (ambiguous source of truth) | SDK lives only in `packages/plugin-sdk` |
| 4 | 02 | "Tauri-free native" wording unclear | Clarified Windows/Linux stack options |
| 5 | 06 | Relay section ignored a malicious paired Gateway and provider-subscription terms | Added residual-risk and provider-terms notes |
| 6 | 11 | Q-3 (clone vs original) unanswered | Resolved: clean-room; added Q-18, Q-19; Q-16 sharpened |

### New content
- `12` clean-room and IP policy (rules, provenance, roster, PR attestation, licence gate).
- `14` first-run UX, deployment modes, ops runbook outline, glossary (previously missing; priority #3 had no spec).
- Updated: 01 (OOS compatibility), 09 (attestation), 10 (Phase 0 clean-room setup), README index, approval checklist.

### Remaining weaknesses (honest list)
1. **Numeric targets** (NFR-PERF, latency, footprint) are educated guesses; validate in Phase 0 spikes.
2. **Estimates** are rough (no team velocity data).
3. **Not independently verified:** the reference project's licence/trademark terms, ACP and A2A spec licences and stability, App Store/Play policies on AI host-control apps, WhatsApp/Signal/iMessage integration viability. These need owner/counsel/spike confirmation (11 §C).
4. **Memory design** (FR-MEM) is intentionally minimal; retrieval quality and poisoning defences (T19) need deeper design before Phase 1 ends.
5. **Plugin isolation** (child processes) may not enforce fs/network permissions on all OSes; some permissions are advisory. *Update 2026-10-16 (WP9): measured. Node's permission model enforces file and exec/worker limits for plugin processes on the tested versions; network remains advisory and is labelled as such to the owner.*
6. **Subagents/automations** are specified at requirement level only; detailed design deferred to Phase 2.
7. Several req.odt-derived names remain as placeholders pending Q-19.
8. Docs were reviewed by the author only; recommend one independent human review (security + product) before approval.
