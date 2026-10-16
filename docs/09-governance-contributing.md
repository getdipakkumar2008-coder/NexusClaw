# 09 — Governance, Contribution & Policy

> Non-engineering track. Legal/organisational items need counsel; nothing here is legal advice.

## 1. Foundation (GOV-1, GOV-2)
- Independent nonprofit ("ClawNexus Foundation"; req cites 501(c)(3) — **US-specific; confirm jurisdiction [Q-8]**) that employs/funds the core team, owns trademarks/domains, and holds the release-signing root.
- Funded by named corporate donors/sponsors + individuals. Rules: donors get recognition, **no roadmap or security-disclosure control**; conflicts-of-interest policy; annual public financial report.
- Bootstrap path: fiscal sponsor (e.g. Software Freedom Conservancy / Open Source Collective / Linux Foundation-hosted) before incorporating — faster, cheaper **[Proposed]**.
- Project may proceed under a personal/organisation repo until the Foundation exists; trademark and signing keys then transfer.

## 2. Roles
Maintainers (merge rights, per-area CODEOWNERS) · Core team (Foundation-employed) · Security team (private disclosure) · Release managers · Hub moderators. Promotion by sustained contribution + maintainer vote; inactive roles lapse after 12 months.

## 3. Contribution rules (GOV-3, from req §5)
1. **One PR = one topic.**
2. **~5,000 changed-lines review ceiling** (excluding generated files/lockfiles — listed in `.github/generated-paths`); larger work must be split or pre-approved via design doc.
3. **No large batches of tiny PRs** (e.g. >5 open PRs of trivial style/typo edits are closed; combine).
4. New features default to **plugins**; core additions need ADR + surface-budget impact (04 §1).
5. Breaking config change ⇒ migration + `doctor --fix` (08 §5).
6. Touching security-sensitive areas ⇒ threat-model note + security-team review.
7. Tests required; CI must be green; DCO sign-off.
8. **Clean-room attestation:** every PR states it contains no code/text copied from the reference project or other incompatibly-licensed sources (`12`). Contributors who have studied the reference project's source disclose it so reviewers can apply extra scrutiny.
9. AI-assisted contributions allowed but the submitter is accountable; disclose substantial AI generation **[Proposed]**.
PR template enforces checkboxes (topic, size, tests, docs, migration, surface budget, security). A bot flags PRs over limits.

## 4. Decision making
Lightweight ADRs in `docs/adr/`. Lazy consensus (72 h) for normal changes; maintainer supermajority for core-surface, protocol and policy changes; Foundation board for trademark/budget/licence. RFC process for plugin-SDK breaking changes.

## 5. Non-goal enforcement ("What we will not merge")
Written into `CONTRIBUTING.md` and PR template; labelled auto-reply macros point authors to ClawNexusHub, Crabbox, or plugin docs.

## 6. Licensing
Apache-2.0 **[Proposed, Q-1]**; DCO; third-party licence scan in CI; trademark policy for "ClawNexus" (names/logos not licensed with code). Hub plugins declare SPDX licence.

## 7. Community standards
`CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), `SECURITY.md`, `SUPPORT.md`, `PRIVACY.md` (no-telemetry statement + opt-in endpoints list), `GOVERNANCE.md`, `MAINTAINERS.md`, `CHANGELOG`.

## 8. Required repository documents (to create at implementation start)
README, VISION.md (two layers: Core vs Plugins, with the "two bars"), CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, GOVERNANCE, PRIVACY, SUPPORT, issue/PR templates, CODEOWNERS, docs site skeleton, ADR index.

## 9. Sustainability
Funding transparency page, sponsor tiers (no feature gating), grant applications, hosted-convenience revenue (relay, managed updates) reinvested per Foundation bylaws, bus-factor ≥2 per critical area.
