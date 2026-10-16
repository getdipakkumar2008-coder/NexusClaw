# 01 — Product Requirements Document (PRD)

## 1. Vision & principles
"Yours, with no catch." A personal AI assistant that runs on the operator's hardware, reachable from the messaging apps they already use. State, memory and credentials never leave the operator's control unless they opt in. Models and agent harnesses are replaceable.

Principles (ordered, from `req.odt` §6): 1 Security & safe defaults · 2 Stability, reliable updates, clear errors · 3 Easy first-run · 4 Performance, tests, clear plugin APIs · 5 Reliable sessions/automations/subagents, simple memory, broad providers · 6 Self-hosting reliability + optional hosted conveniences.

## 2. Personas
| Persona | Needs |
|---|---|
| **Owner-operator** (primary) | Install in <10 min, chat from phone/Telegram, trust defaults |
| **Team operator** | Shared Gateway for a trusting group, per-user limits |
| **Plugin author** | Stable SDK, docs, publish to Hub |
| **Contributor** | Clear rules, fast CI |
| **Security reviewer** | Threat model, audit logs, reproducible builds |

## 3. Scope by phase (summary; detail in `10-roadmap.md`)
- **P0 / Phase 1 (MVP):** Gateway, CLI, config+doctor, ACP provider runtime (1 Claude harness + 1 local), channels: Telegram, Discord, Slack, WebChat; pairing; sessions; memory v1; tool policy; plugin SDK v0.
- **P1 / Phase 2:** Web Control UI, TUI, WhatsApp, Signal, Teams, Google Chat, A2A, automations, subagents, ClawNexusHub v1, Android + macOS apps.
- **P1 / Phase 3:** iOS, Windows, Linux apps, relay/push, remaining channels to 20+.
- **P2 / Phase 4:** watchOS/Wear OS, voice polish, Foundation-run signing, hosted convenience services.

## 4. Functional requirements

### 4.1 Core / Gateway
| ID | Requirement | Acceptance criteria | Pri |
|---|---|---|---|
| FR-CORE-1 | All state (sessions, memory, credentials, config) stored under an operator-chosen data dir | Deleting the data dir resets the install; no state elsewhere (verified by test scanning FS writes) | P0 |
| FR-GW-1 | Single Gateway process is the only writer of session/tool/event state | Property test: two clients cannot diverge; DB has a single writer lock | P0 |
| FR-GW-2 | CLI, Web UI, TUI, apps are clients using the public protocol only | No client imports Gateway internals (lint boundary rule in CI) | P0 |
| FR-GW-3 | Gateway owns all channel connections | Channel creds exist only in Gateway credential store | P0 |
| FR-GW-4 | Event stream with resume (cursor) | Client reconnect after 60 s receives missed events exactly once | P0 |
| FR-GW-5 | Tool execution managed by Gateway with policy, approval, timeout, cancel | Cancel stops process tree within 2 s | P0 |
| FR-GW-6 | Graceful shutdown/restart preserving in-flight sessions | Kill -TERM during run → on restart session resumes or is marked interrupted with clear message | P0 |
| FR-GW-7 | Health/readiness endpoints | `/healthz`, `/readyz` return status within 100 ms | P0 |
| FR-GW-8 | Multi-client concurrent attachment to one session | ≥10 clients on one session in test, ordered events | P1 |

### 4.2 Providers (ACP)
| ID | Requirement | Acceptance | Pri |
|---|---|---|---|
| FR-PROV-1 | Provider = ACP harness behind `extensions/acpx` | Swap provider by config with no code change | P0 |
| FR-PROV-2 | At least: Claude harness, one OpenAI-compatible/Codex harness, one local (Ollama/llama.cpp) | Conformance suite passes for each | P0/P1 |
| FR-PROV-3 | Provider failure surfaces a clear, actionable error | Error taxonomy with codes + remediation text; tested | P0 |
| FR-PROV-4 | Per-session model/provider override and fallback chain | Fallback triggers on defined error classes only | P1 |
| FR-PROV-5 | Token/cost accounting locally | Per-session usage shown in CLI | P1 |

### 4.3 Sessions, memory, automation, subagents
| ID | Requirement | Acceptance | Pri |
|---|---|---|---|
| FR-SES-1 | Sessions keyed by (channel, conversation, sender-scope); isolation between senders | Cross-sender leakage test = 0 | P0 |
| FR-SES-2 | Persist transcripts, tool calls, approvals; export as JSONL/Markdown | Round-trip export/import test | P0 |
| FR-SES-3 | Context management (compaction/summarisation) pluggable | Long-session test beyond window succeeds | P1 |
| FR-MEM-1 | Memory v1 = plain-file, human-readable (Markdown) store owned by operator, plus optional pluggable index | User can view/edit/delete memory with a text editor; Gateway picks up edits | P0 |
| FR-MEM-2 | Memory scoping: owner/global vs per-contact | Per-contact memory never injected into other contacts' sessions | P0 |
| FR-MEM-3 | Memory export + full-delete command | Delete leaves no residue in DB/index (test) | P0 |
| FR-AUTO-1 | Scheduled + event-triggered automations (cron, webhook, channel event) | Missed-run policy configurable; run history queryable | P1 |
| FR-AUTO-2 | Automations run with explicit tool policy (no implicit privilege escalation) | Policy test | P1 |
| FR-SUB-1 | Subagents spawned by a session with bounded depth, budget, tool subset | Child cannot exceed parent's permissions (test) | P1 |

### 4.4 Channels (details in `05`)
| ID | Requirement | Acceptance | Pri |
|---|---|---|---|
| FR-CH-1 | Uniform channel adapter contract | A new adapter passes the shared conformance suite | P0 |
| FR-CH-2 | MVP channels: Telegram, Discord, Slack, WebChat | E2E send/receive/attachments/typing per channel | P0 |
| FR-CH-3 | v1 channels: WhatsApp, Signal, iMessage (macOS host), Teams, Google Chat, Matrix, IRC, email, SMS, etc. to reach ≥20 | Tracked in `05` matrix | P1 |
| FR-CH-4 | New sender requires pairing approval (`clawnexus pairing approve <code>`) | Unpaired message → no agent run, only pairing prompt (rate-limited) | P0 |
| FR-CH-5 | A2A v1.0 channel | Interop test against reference A2A implementation | P1 |
| FR-CH-6 | Per-channel allowlist/denylist, group-mention rules | Config-driven tests | P0 |

### 4.5 Extensions (details in `04`)
| ID | Requirement | Acceptance | Pri |
|---|---|---|---|
| FR-EXT-1 | Two tiers: Core (lean) and Plugins | Core surface budget tracked (tool count, prompt tokens, config keys) with CI check | P0 |
| FR-EXT-2 | Code plugins (channels/tools/providers/hooks) | Load/unload without core changes | P0 |
| FR-EXT-3 | Bundle plugins (skills, MCP servers, config) | Install from manifest only; no code execution at install | P0 |
| FR-EXT-4 | Manifest with declared permissions & API range | Plugin outside API range refuses to load with clear error | P0 |
| FR-EXT-5 | Plugin crash isolation | Plugin throwing does not crash Gateway (test) | P0 |
| FR-EXT-6 | `plugin-sdk` published, semver'd, typed | API-extractor report in CI; breaking change fails build w/o major bump | P0 |
| FR-EXT-7 | ClawNexusHub registry (search/install/publish/verify) | CLI `clawnexus plugins install <id>` verifies signature | P1 |
| FR-EXT-8 | Core prompt/tool "tax" reporting | `clawnexus doctor --surface` lists per-request token cost of core | P1 |
| FR-EXT-9 | MCP server bundles supported | MCP tools appear under policy like native tools | P0 |

### 4.6 Companion apps (details in `07`)
FR-APP-1 pairing via QR/setup code · -2 streaming chat · -3 voice "Talk" · -4 camera/screen/location device actions with consent · -5 approvals · -6 shared visual language · -7 diff/"review changes" viewer · -8 offline/reconnect · -9..12 per-platform builds. Acceptance in `07 §8`.

### 4.7 DX, data, observability
| ID | Requirement | Acceptance | Pri |
|---|---|---|---|
| FR-DX-1 | Strict config schema; unknown/stale keys are errors | Test with renamed key fails loudly | P0 |
| FR-DX-2 | Every breaking config change ships migration for `clawnexus doctor --fix` | CI fails if schema diff lacks migration | P0 |
| FR-DX-3 | First-run wizard: install → paired channel → first reply | Median ≤10 min in usability test (n≥5) | P0 |
| FR-DATA-1 | Backup/restore single command | Restore on clean host reproduces sessions+memory | P0 |
| FR-DATA-2 | Secrets encrypted at rest (OS keychain or passphrase-derived key) | No plaintext tokens in data dir | P0 |
| FR-OBS-1 | Structured local logs, rotation, redaction of secrets/PII | Redaction tests | P0 |
| FR-OBS-2 | `clawnexus doctor` diagnostics bundle (local, user-reviewed before sharing) | Bundle contains no secrets (test) | P0 |
| FR-REL-* | See `08` | | |

## 5. Non-functional requirements (targets are **[Proposed]**)
| ID | Requirement | Target |
|---|---|---|
| NFR-PERF-1 | Gateway idle footprint | ≤ 250 MB RSS, ≤ 2% CPU on a 2-core VM with 5 channels |
| NFR-PERF-2 | Inbound-message → first agent token overhead (excl. model latency) | p95 ≤ 150 ms |
| NFR-PERF-3 | Event fan-out | 50 clients, 20 evt/s, p95 delivery ≤ 200 ms |
| NFR-REL-1 | Gateway crash recovery | Auto-restart ≤ 10 s, no data loss for committed events |
| NFR-REL-2 | Channel reconnect | Exponential backoff w/ jitter, status visible in `status` |
| NFR-SEC-1 | See `06`; no critical/high vuln in deps at release | `audit` gate in CI |
| NFR-PORT-1 | Hosts | Linux x64/arm64, macOS 13+, Windows 11 (WSL2 + native best effort) |
| NFR-PORT-2 | Runtime | Node ≥22 LTS |
| NFR-COMP-1 | Plugin API stability | Semver; ≥6-month deprecation window for removals |
| NFR-UX-1 | Errors | Every user-visible error has code, cause, remediation; no stack traces by default |
| NFR-A11Y-1 | Apps/web | WCAG 2.2 AA for Control UI; platform a11y APIs in apps |
| NFR-I18N-1 | Strings externalised; EN at 1.0 | Lint for hardcoded strings |
| NFR-LIC-1 | License | Apache-2.0 + DCO sign-off **[Proposed]** |
| NFR-TEST-1 | Coverage as diagnostic, not target; critical modules (policy, pairing, config) | ≥90% line coverage on those |

## 6. Out of scope (from `req.odt` §7)
OOS-1 new core skills that could live on ClawNexusHub · OOS-2 full-document translation sets · OOS-3 vendor-specific integrations baked into core · OOS-4 cloud sandbox providers in this repo (use external Crabbox via plugin) · OOS-5 redundant wrapper channels / duplicate MCP paths.
Additional **[Proposed]** OOS: multi-tenant SaaS hosting of Gateways by the project; training/fine-tuning models; built-in telemetry; **wire, config-file or CLI compatibility with the reference project** (we reimplement functionality only — see `12`); importing the reference project's data/config unless a clean, publicly documented format is chosen (Q-18).

## 7. Success metrics (local/opt-in only; no telemetry)
Measured via user studies, GitHub issues, opt-in surveys: time-to-first-reply, install success rate (issue-tracker proxy), crash reports submitted voluntarily, plugin count on Hub.
