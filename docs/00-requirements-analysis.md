# 00 — Requirements Analysis of `req.odt`

## 1. What the source document is
A vision/prompt-style document with 7 sections plus an appended "reconstruction" table that maps observed repo artifacts (src/gateway, extensions/acpx, apps/ios, VISION.md…) to inferred instructions. Implication: the content describes *an existing project's shape*, not a greenfield spec. We are treating it as the target shape and must build it from zero.

## 2. Requirement extraction & traceability
Every statement in `req.odt` was assigned to a document and requirement ID.

| Source § | Statement (short) | Doc | ID |
|---|---|---|---|
| 1 | Self-hostable, state/creds on operator hardware | 01, 06 | FR-CORE-1, SEC-1 |
| 1 | Central Gateway owns sessions, tools, events, channels | 02, 03 | FR-GW-1..8 |
| 1 | All other surfaces are Gateway clients | 02 | FR-GW-2 |
| 1 | Swappable AI providers via ACP (acpx) | 02, 04 | FR-PROV-1..5 |
| 1 | Two-tier extension system, lean core | 04 | FR-EXT-1..9 |
| 1 | Plugin SDK + ClawNexusHub | 04 | FR-EXT-6..9 |
| 2 | 20+ channels incl. A2A v1.0 | 05 | FR-CH-1..10 |
| 2 | Inbound untrusted; pairing approval | 05, 06 | SEC-3, FR-CH-4 |
| 3 | Native apps ×6 platforms + watch | 07 | FR-APP-1..12 |
| 3 | Fastlane, signing sync, E2E gating | 08 | FR-REL-1..8 |
| 4 | Host-exec by default; sandbox opt-in | 06 | SEC-5 (**conflict**, see §4) |
| 4 | No telemetry default | 06 | SEC-2 |
| 4 | Team gateway = mutual trust only | 06 | SEC-7 |
| 4 | Relay crypto binding (App Attest + grants) | 06 | SEC-9..11 |
| 5 | Config schema discipline + doctor --fix | 08 | FR-DX-1..3 |
| 5 | PR rules (1 topic, ~5k lines) | 09 | GOV-3 |
| 5 | Vitest, Gradle/ktlint, XCTest, harnesses | 08 | FR-REL-5..8 |
| 5 | Nonprofit Foundation | 09 | GOV-1,2 |
| 6 | 6 ranked priorities | 10 | roadmap ordering |
| 7 | 5 non-goals | 01 | OOS-1..5 |

## 3. Gaps (not specified in source)
| # | Gap | Impact | Resolution |
|---|---|---|---|
| G1 | No MVP / phasing | Unbuildable as stated | `10-roadmap.md` 4 phases |
| G2 | No measurable acceptance criteria | Untestable | Added to every FR; NFR targets in `01` |
| G3 | No Gateway protocol/API | Clients can't be built | `03` |
| G4 | No threat model | Security is priority #1 yet unspecified | `06` |
| G5 | Memory undefined (named a priority) | Core feature ambiguous | `02 §7` data model, `01` FR-MEM |
| G6 | Sessions/automations/subagents undefined | — | `01` FR-SES, FR-AUTO, FR-SUB |
| G7 | Channel ToS/legal risk (WhatsApp, iMessage, Signal) | Legal + stability | `05` risk matrix, tiering |
| G8 | Client↔Gateway auth/transport undefined | Critical | `03 §3` |
| G9 | Backup/restore/export/delete of data | Privacy | FR-DATA-* |
| G10 | Local observability w/o telemetry | Supportability | FR-OBS-* |
| G11 | License, supported OS/Node versions, i18n, a11y | Compliance | `01` NFR, `09` |
| G12 | Plugin vetting/signing for marketplace | Supply-chain | `04 §6`, `06` |
| G13 | Android relay attestation equivalent | Parity | `06 §7` Play Integrity |
| G14 | Consent model for camera/screen/location device actions | Privacy | `07 §5` |
| G15 | Update/rollback story | "reliable updates" is priority #2 | `08 §6` |

## 4. Contradictions / tensions
| # | Tension | Proposed resolution (needs approval) |
|---|---|---|
| C1 | "Security first" vs "tools run on host by default" with untrusted inbound + LLM (prompt-injection → host RCE) | **Default-deny tool policy for non-owner senders**; host-exec only for the verified owner/session; per-tool approval; sandbox *strongly recommended* and one-command to enable. Host-exec remains the owner default as the doc requires. |
| C2 | "Runs entirely on own infra" vs hosted relay / "hosted convenience services" | Hosted pieces are **optional, off by default, E2E-encrypted payloads**, and self-hostable relay is shipped. Documented in `06 §7`. |
| C3 | Non-goal "vendor-specific integrations in core" vs named providers/channels | Line drawn: core contains only the **interfaces + a reference provider (ACP) + the minimum channels needed for first-run**; every named vendor is a plugin (bundled-but-separable is allowed). |
| C4 | "Cloud sandbox providers as plugins" listed as non-goal yet says push to Crabbox | Interpreted as: *not accepted in this repo*; use the external project via the plugin interface. Needs confirmation (Q-6). |
| C5 | Priority #1 security / #3 easy setup vs section volume on apps & release | Roadmap front-loads security + setup; apps come after Gateway stability. |
| C6 | Foundation + donor funding is org-structure, not software | Moved to `09` as non-engineering track, not a build dependency. |
| C7 | Reconstruction table inside requirements | Removed from requirements; kept here only as provenance. |

## 5. Feasibility assessment
| Area | Feasibility | Notes |
|---|---|---|
| Gateway + CLI + 3 channels + ACP provider | High | Well-understood; MVP |
| Plugin SDK / bundle plugins | High | Design carefully; API stability is the hard part |
| 20+ channels | Medium | Several rely on unofficial/reverse-engineered APIs (WhatsApp Web, iMessage); maintenance burden is continuous |
| Native apps ×6 | Low-Med as one effort | Needs ≥3 skilled mobile/desktop engineers; sequence per platform |
| Watch/Wear + Rust WebRTC | Low-Med | Niche; defer to P2 |
| Relay with attestation | Medium | Apple App Attest / Play Integrity are doable; abuse-resistance needs ongoing ops |
| 501(c)(3) Foundation | Non-code | Legal/fundraising timeline independent of engineering |

**Conclusion:** buildable only if phased. Estimated effort for the full 1.0 vision (Phases 0–3 in `10-roadmap.md`): ≈60–70 person-months; ≈12–15 calendar months if the team ramps from 3 to ~8 engineers, so plan for 15–18 months given the slip risk. MVP (Phase 0–1) is feasible for 3 engineers in ~4 months. (Earlier draft said 18–24 months; corrected to match the roadmap arithmetic.)

**Clean-room constraint (added in review 2):** the product is a functional equivalent of an existing project ("OpenClaw"), built without reusing its code, text, assets or branding. See `12-clean-room-and-ip-policy.md`; several names in `req.odt` are therefore under review.

## 6. Assumptions made (flagged for review)
A1 License Apache-2.0. A2 Node ≥ 22 LTS, TypeScript strict. A3 Gateway persistence = SQLite (+ filesystem for blobs). A4 Gateway protocol = JSON over WebSocket + minimal HTTP. A5 Windows/macOS/Linux supported hosts. A6 English-only UI at 1.0 (i18n-ready strings). A7 "Claude/Codex/local" implemented through ACP harnesses, not direct API calls in core.
