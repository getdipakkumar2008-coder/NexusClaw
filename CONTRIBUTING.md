# Contributing

Thanks for helping. The rules below come from docs/09 and are enforced by CI and review.

## Ground rules
1. **One PR = one topic.** Do not mix refactors with features.
2. **Review ceiling ~5,000 changed lines** (excluding generated files and lockfiles). Split larger work or get a design doc approved first.
3. **No batches of tiny PRs.** Combine trivial fixes.
4. **New capability goes in a plugin first.** Core additions need an ADR and a surface-budget justification (`surface-budget.json`, docs/04 section 1).
5. **Breaking config change = migration.** Add a migration in `src/config/src/migrations.ts`, update `src/config/schema.snapshot.json`, and add tests (docs/08 section 5).
6. **Security-sensitive areas** (policy, pairing, vault, protocol auth, relay) need a short threat-model note in the PR and security-team review.
7. **Tests required**; CI must be green: `pnpm check:all`.
8. **DCO sign-off** on every commit: `git commit -s`.
9. **Clean-room attestation** (docs/12): your PR must not contain code, text, assets or names copied from the reference project (OpenClaw) or from sources with incompatible licences. If you have studied the reference project's source, say so in the PR.
10. AI-assisted contributions are welcome; you are accountable for them. Disclose substantial AI generation.

## Out of scope for this repository
Proposals in these areas will be redirected (see docs/01 section 6):
- Features that can ship as a plugin or registry package rather than in core.
- Complete translations of long documents.
- Code in core that is specific to a single vendor's product.
- Hosted/cloud sandbox backends (implement the sandbox interface in a separate project).
- A second channel or MCP path where an existing one already does the job.

## Development
```
corepack enable   # or: npm i -g pnpm@9
pnpm install
pnpm check:all    # build, lint, test, boundaries, boundaries self-test, licence gate
```
Node 22+ required. Layout and dependency rules: docs/02 and `.dependency-cruiser.cjs`.

## Commit and release
Use changesets (`pnpm changeset`) for user-visible changes. Conventional-style commit subjects are appreciated.
