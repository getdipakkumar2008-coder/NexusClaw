# 11 — Open Questions & Decision Log

> **Status: all recommended defaults for Q-1…Q-19 APPROVED by the owner.** The ADRs in §B are therefore *Accepted*. Still open: (a) explicit go-ahead to start Phase 0, (b) trademark/domain clearance of the name (Q-16), (c) counsel review of `12`, (d) the reference project's licence check. Q-4's final channel list beyond Phase 1 stays provisional.

## A. Decisions needed from you before any implementation
Each has a **recommended default** (used in all docs). Reply with "approve all defaults" or list changes.

| ID | Question | Options | Recommended |
|---|---|---|---|
| Q-1 | Licence | Apache-2.0 / MIT / AGPL | **Apache-2.0** (patent grant, permissive; "no catch" ethos) |
| Q-2 | Scope of first deliverable | Full vision / Phased | **Phased; build Phase 0–1 first** |
| Q-3 | ~~Clone or original?~~ **ANSWERED by owner (review 2):** functional equivalent of "OpenClaw", own copyright, **functionality only — no code, text, assets or branding reused.** Governed by `12`. | — | **Resolved: clean-room** |
| Q-18 | Compatibility with the reference project (its config format, protocol, CLI, plugin API, data import)? | None (own formats) / documented import tool only | **None; own formats. Optional import tool later, built from user-supplied sample data, not from its source** |
| Q-19 | Names inherited from `req.odt` that may come from the reference project: `acpx`, `ClawNexusHub`, "Crabbox", "Talk", tagline "yours, with no catch", doc/terms like "taxed core", "two layers, two bars", the non-goals list wording | Keep / rename / rewrite | **Rewrite wording in our own words; choose our own names for `acpx` and the Hub; "Crabbox" referenced only as an optional third-party example, if at all** |
| Q-4 | Final list of 20+ channels | see `05` | Phase 1: Telegram, Discord, Slack, WebChat; confirm rest |
| Q-5 | Tier-B (unofficial/ToS-risk) channels: WhatsApp Web, Signal, iMessage | Ship in core builds / community plugins with warning / exclude | **Community-labelled opt-in plugins** |
| Q-6 | Non-goal wording on cloud sandbox providers ("plugins" vs "Crabbox") | Not in this repo, use external Crabbox / allow plugin | **Not in this repo; interface only** |
| Q-7 | Hosted relay/convenience services: who operates, when | Self-host only for 1.0 / Foundation-hosted opt-in | **Ship self-hostable relay; hosted opt-in after Foundation exists** |
| Q-8 | Foundation jurisdiction/structure | 501(c)(3) direct / fiscal sponsor first | **Fiscal sponsor first** |
| Q-9 | Windows & Linux native stacks | WinUI3 / Win32+Rust ; GTK4 / Qt | **WinUI 3; GTK4** (confirm team skills) |
| Q-10 | Sandbox reference backend(s) | Docker/Podman only / + OS-native | **Container first; OS-native later** |
| Q-11 | Encrypt transcripts/memory at rest by default? | Plain (editable) / encrypted | **Plain by default, optional encryption (keeps memory human-editable)** |
| Q-12 | CI/hosting | GitHub Actions / other | **GitHub Actions** |
| Q-13 | Team & timeline reality: who builds the native apps? | in-house / community / defer | **Android+macOS in Phase 2, rest later** |
| Q-14 | Default posture for owner host-exec | Auto-run / ask for R3+ | **Ask for R3/R4, owner can enable trust mode** (still honours "host by default") |
| Q-15 | Supported host OS for Gateway at 1.0 | L/M/W native / WSL2 for Windows | **Linux, macOS, Windows (WSL2 recommended, native best-effort)** |
| Q-16 | Project name & trademark clearance for "ClawNexus", "ClawNexusHub". "Claw" prefix may be confusingly similar to the reference project's branding | confirm / rename | **Run trademark + domain search now (before Phase 0 repo creation); consider a name without the "Claw" element** |
| Q-17 | Where to publish docs / issue tracking | GitHub / other | GitHub + docs site |

## B. ADR log (ACCEPTED with the approval above; become `docs/adr/*.md` at kickoff — the "Proposed" status column below is superseded)
| ADR | Decision | Status |
|---|---|---|
| 0001 | Gateway is the single source of truth; all else is a client | Proposed |
| 0002 | TypeScript/Node 22/pnpm monorepo, ESM, strict | Proposed |
| 0003 | SQLite (WAL) + files for persistence | Proposed |
| 0004 | JSON-over-WebSocket protocol with seq-ordered durable events | Proposed |
| 0005 | Two-tier extension model; core admission bar + surface budget | Proposed |
| 0006 | Plugins isolated in child processes by default; signed; permission-declared | Proposed |
| 0007 | Providers via ACP harnesses (acpx), not direct SDKs in core | Proposed |
| 0008 | Default-deny restricted tool profile for non-owner senders | Proposed |
| 0009 | Memory v1 = Markdown files owned by operator | Proposed |
| 0010 | Device pairing with Ed25519 keys + short-lived tokens | Proposed |
| 0011 | Relay with attestation + delegated send grants + E2E payload | Proposed |
| 0012 | Config strictness + mandatory migrations (`doctor --fix`) | Proposed |
| 0013 | Apache-2.0 + DCO | Proposed |
| 0014 | Native apps; shared only narrow modules; Android+macOS first | Proposed |

## C. Assumptions to validate
Node 22 availability on target hosts · ACP maturity/stability for Claude/Codex/local harnesses (spike needed in Phase 0) · A2A v1.0 spec stability · App Store acceptance · WhatsApp/Signal/iMessage integration feasibility.

## D. Spikes recommended inside Phase 0 (time-boxed, throwaway)
1. ACP client against 2 harnesses. 2. Child-process plugin isolation overhead. 3. Event-log resume correctness under crash. 4. App Attest + grant verification prototype. 5. Telegram end-to-end latency baseline.

## E. Approval checklist
- [ ] Docs 00–10 reviewed (or delegated)
- [ ] Q-1…Q-19 answered / defaults approved (Q-3 already answered)
- [ ] Clean-room policy (`12`) approved; reference project's licence checked by owner/counsel
- [ ] Final project name cleared (Q-16)
- [ ] Phase 0–1 scope and exit criteria approved
- [ ] Permission to begin implementation of Phase 0

**No code will be written until this checklist is signed off.**
