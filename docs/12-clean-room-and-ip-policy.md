# 12 — Clean-Room & IP Policy

Owner decision (review 2): ClawNexus reimplements the **functionality** of an existing open-source project ("the reference project", OpenClaw). It is a separate work with its own copyright. Nothing is copied from the reference project. *This is an engineering policy, not legal advice; have counsel review before public launch.*

## 1. Principle
Ideas, features and behaviours are generally not protected by copyright; **expression** is: source code, documentation text, UI assets/icons, specific wording, and the exact structure/sequence/organisation of a large codebase. Trademarks (names, logos, taglines) are protected separately. Patents are a separate risk (low for this kind of software, but unknown).

## 2. What we may and may not take
| Item | Allowed? | Rule |
|---|---|---|
| The *idea* of a local Gateway + channel adapters + plugins + companion apps | Yes | Functional concept |
| Publicly visible behaviour (what a feature does, as seen by a user) | Yes | Describe it in our own words |
| Source code, snippets, tests, scripts, CI files, Fastlane configs | **No** | Not read-and-adapted either |
| README / VISION / docs text, tagline, section titles, the non-goals list wording | **No** | Rewrite from our own requirements |
| Names: project, Hub, `acpx`, "Crabbox", feature names ("Talk"), CLI verb sets, mascots, icons, logos | **No** by default | Own names; clear trademarks (Q-16, Q-19) |
| Config key names, file/dir layouts, CLI flags, protocol field names | Avoid | Design our own (a different schema avoids copying expression and avoids implied compatibility) |
| Open standards (MCP, ACP, A2A, Markdown, OAuth, etc.) | Yes | Implement from the public specs; verify each spec's licence |
| Third-party dependencies | Yes if licence-compatible | Same deps the reference uses are fine; choose by licence and merit |

## 3. Provenance of the existing planning docs
`req.odt` was derived from the reference project's repository artifacts (its closing table says so). Therefore:
1. Treat `req.odt` as a **functional brief only**, not as text to republish. These docs already restate it in our own structure, but a few items echo its wording and must be rewritten or renamed before anything goes public: tagline "yours, with no catch"; "taxed core" and "two layers, two bars" terminology; the "What We Will Not Merge" list; `acpx`; `ClawNexusHub`; `Crabbox`; `Talk`; the `src/gateway`, `extensions/*`, `apps/*` directory names; the `doctor --fix` and `pairing approve` command phrasing.
2. Decision Q-19 tracks the renames. Until decided, the docs keep the placeholders and **no public repo, website or package name may use them.**

## 4. Process rules
1. **No reference source at implementation time.** Implementers must not open, copy from, or paste from the reference repo (including via AI tools). Behaviour questions are answered from the public docs/UI/observed behaviour and recorded in a spec note.
2. **Two-role separation where practical:** *spec writers* (may study public docs and run the product to observe behaviour) produce behaviour specs in this `docs/` tree; *implementers* build from those specs. Anyone who has read the reference source is listed in `docs/provenance/ROSTER.md` and does not write the equivalent module (strict separation is the standard clean-room defence; for a small team, at least disclose and review).
3. **Provenance log** (`docs/provenance/LOG.md`): for each module, what spec it implements and what external sources (specs, libraries) informed it.
4. **PR attestation** (09 §3 rule 8) and a CI check for suspicious verbatim matches (e.g. a similarity scan of added files against the reference project's public snapshot, run by a maintainer who is *not* an implementer of that area).
5. **AI assistants:** instruct tools not to fetch or reproduce the reference repository; review AI-generated code for lookalike structure.
6. **Dependency licence gate** in CI (allow-list: Apache-2.0, MIT, BSD, ISC, MPL-2.0 with care; deny GPL/AGPL in the Gateway distribution unless Q-1 changes).
7. **Own visual identity:** original logo, icon set, mascot, colour system, fonts under open licences.

## 5. Open items for the owner
- **Check the reference project's LICENSE and trademark policy yourself or with counsel.** If its code is permissively licensed, reusing parts *with attribution* could be lawful — but that conflicts with the stated goal of a separate-copyright, own-code project, so this policy assumes **no reuse**. Say so if you want to reconsider.
- Trademark/naming: "ClawNexus" and "ClawNexusHub" share the "Claw" element with the reference project's branding and could be argued confusingly similar. Clear it, or rename (Q-16).
- Wire compatibility: we are **not** targeting it (Q-18). It keeps the clean-room position simple and removes lock-in to someone else's schema.
- Do not market as "OpenClaw-compatible", "fork of" or "alternative to" in ways implying affiliation; factual comparative statements ("inspired by the idea of…") need counsel sign-off.
- Third-party service terms: provider, WhatsApp, Apple and Google terms apply independently of this policy (see `05`, `06 §7`).

## 6. Acceptance
Counsel review done · provenance log started in Phase 0 · PR template carries attestation · licence gate green · name cleared · no string/asset from the reference project present in repo (scan before each release).
