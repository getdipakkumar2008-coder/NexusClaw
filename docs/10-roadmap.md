# 10 — Roadmap & Delivery Plan (Proposed)

Ordering follows `req.odt` §6 priorities: security → stability → easy setup → performance/tests/plugin APIs → sessions/memory/providers → self-hosting + hosted extras. Estimates assume a core team of 3 (Phase 1), growing to 6–8.

## Phase 0 — Foundations (2–3 weeks) — after approval only
- Repo bootstrap: pnpm workspace, TS config, lint, boundary rules, CI skeleton, Vitest, changesets.
- Governance docs, licence, SECURITY/CONTRIBUTING, PR templates, ADR-0001..N from doc 11.
- Clean-room setup (`12`): provenance log, dependency-licence gate, name/trademark clearance, clean-room attestation in PR template.
- `packages/protocol` schemas v0, config schema v0 with migration framework.
**Exit:** CI green on empty packages; boundary rule demonstrably fails on a violating import; surface-budget check wired.

**Status (2026-10-16): scaffold complete, locally verified (`pnpm check:all` green: 34 tests, boundary self-test, licence gate). Open items:** spike 1 (ACP) and spike 5 (Telegram latency) not run; CI workflow written but never executed on GitHub; owner-only TODOs (maintainers, security contact, CODEOWNERS, ROSTER); name clearance (Q-16); counsel review of `12`; Q-19 renames still pending. Results: `docs/spikes/RESULTS.md`.

## Phase 1 — MVP "Secure core" (≈12–14 weeks)
Scope: Gateway (sessions, event bus w/ resume, SQLite), CLI, Vault, config+doctor, policy engine + approvals + pairing, `acpx` with Claude harness + one local-model harness, plugin host + SDK v0, channels Telegram/Discord/Slack/WebChat, memory v1 (Markdown), backup/restore, structured logs, first-run wizard.
**Exit criteria**
- Fresh machine → first reply in a paired channel ≤10 min median (n≥5 testers).
- Threat-model controls T1–T3, T6, T7, T14, T15 implemented and tested; injection corpus passes.
- Authz matrix + protocol conformance + crash-recovery tests pass.
- Idle footprint and latency NFRs met.
- External security review of policy/pairing/vault (scoped) done.
- 0 known critical/high vulns.

## Phase 2 — "Everywhere" (≈14–18 weeks)
Control UI + TUI, automations, subagents, context compaction, Teams/Google Chat/WhatsApp/Signal/Matrix/Email/A2A, plugin SDK v1.0 freeze candidate, ClawNexusHub client + minimal registry, signing & provenance, **Android + macOS apps** (pair, chat, approvals, voice, device actions), E2E qualification harnesses, update/rollback.
**Exit:** SDK API review complete; Hub install of signed plugin works; Android + macOS pass qualification vs pinned fixtures; 12 channels at conformance; 1.0-beta.

## Phase 3 — "1.0" (≈14–18 weeks)
iOS, Windows, Linux apps; relay + push with attestation and delegated grants; remaining channels to ≥20; self-hosted relay; reproducible builds; Foundation/fiscal sponsor in place with signing root custody; accessibility audits; docs site; migration guides.
**Exit:** all P0/P1 FRs verified; external pen-test of relay + Gateway; store approvals; stable 1.0 release.

## Phase 4 — Extended (post-1.0)
watchOS/Wear OS (+Rust Watch RTC), richer voice/WebRTC, hosted convenience services, additional providers, memory index plugins, enterprise-ish team features (still mutual-trust).

## Parallel tracks
- **Security:** threat-model review at each phase gate.
- **Docs/DX:** docs written with features; "docs or it doesn't merge".
- **Org:** fiscal sponsor application starts in Phase 1; incorporation decisions in Phase 2.

## Team (suggested)
Phase 1: 1 Gateway/security lead, 1 runtime/channels, 1 DX/CI. Phase 2: +Android, +Apple, +web UI. Phase 3: +Windows/Linux, +infra/relay, +QA. Release manager from Phase 2.

## Top risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Scope creep from 20+ channels/6 platforms | High | High | Phase gates; Tier-B channels community-owned |
| Tier-B channel breakage/ToS | High | Med | Label, isolate, don't block releases |
| Prompt-injection incident | Med | High | Default-deny profile, approvals, sandbox, red-team CI |
| Plugin supply-chain | Med | High | Signing, tiers, revocation |
| Native app staffing | High | High | Sequence platforms, hire owners |
| Store rejections | Med | Med | Early TestFlight/Play internal submissions; consent UX |
| Funding/Foundation delays | Med | Med | Fiscal sponsor first |
| Protocol churn breaking apps | Med | High | Versioned protocol + fixtures |
