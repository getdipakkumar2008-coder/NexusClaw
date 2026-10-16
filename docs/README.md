# ClawNexus — Documentation Set (DRAFT v0.1, awaiting approval)

Status: **Planning only. No implementation has started.** Owner approved all recommended defaults (Q-1…Q-19). Waiting on: explicit go-ahead for Phase 0, name clearance, counsel/licence checks (see `11-open-questions-and-decisions.md`).

Source: `req.odt` (vision-level requirements). Those requirements were analysed; gaps, contradictions and unmeasurable statements were converted into the concrete, testable documents below. Anything not stated in `req.odt` is marked **[Proposed]**.

## Index

| # | Document | Purpose |
|---|----------|---------|
| 00 | `00-requirements-analysis.md` | Deep analysis of `req.odt`: traceability, gaps, contradictions |
| 01 | `01-product-requirements.md` | PRD: personas, scope, functional + non-functional requirements with IDs and acceptance criteria |
| 02 | `02-architecture.md` | System architecture, components, repo layout, data model, tech choices |
| 03 | `03-gateway-protocol.md` | Gateway API/WebSocket protocol, auth, versioning, events |
| 04 | `04-plugin-system.md` | Two-tier extension model, plugin SDK, manifests, registry (ClawNexusHub) |
| 05 | `05-channels.md` | Channel adapter contract, pairing, per-platform feasibility/risk |
| 06 | `06-security-threat-model.md` | Trust model, STRIDE threat model, controls, relay/push trust |
| 07 | `07-companion-apps.md` | Native apps: scope, shared behaviour, device actions, per-platform notes |
| 08 | `08-release-engineering.md` | CI/CD, signing, release pipelines, test strategy, config migration |
| 09 | `09-governance-contributing.md` | Foundation, contribution rules, licensing, code of conduct, policy |
| 10 | `10-roadmap.md` | Phased delivery plan with exit criteria |
| 11 | `11-open-questions-and-decisions.md` | **Decisions needed from you** + ADR log |
| 12 | `12-clean-room-and-ip-policy.md` | **New (review 2):** rules for building the same functionality without reusing the reference project |
| 13 | `13-review-log.md` | **New (review 2):** what the second review found and changed |
| 14 | `14-first-run-and-operations.md` | **New (review 2):** first-run UX, deployment, upgrade, backup, glossary |

## Reading order for approval
1. `00` (what I found) → 2. `10` (phasing) → 3. `11` (decisions I need) → then the rest as reference.

## Conventions
- Requirement IDs: `FR-<area>-<n>` functional, `NFR-<area>-<n>` non-functional, `SEC-<n>` security, `OOS-<n>` out of scope.
- Priority: **P0** MVP-blocking, **P1** v1.0, **P2** post-1.0.
- RFC 2119 keywords (MUST/SHOULD/MAY) are normative.
