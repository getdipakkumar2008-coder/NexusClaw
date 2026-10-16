## What and why
<!-- One topic per PR. Link the requirement ID (e.g. FR-GW-4) or ADR. -->

## Checklist
- [ ] Single topic; under ~5,000 changed lines (excluding generated files)
- [ ] Tests added/updated; `pnpm check:all` passes
- [ ] Docs updated (docs/ or user docs)
- [ ] Config schema change? Migration added in `src/config/src/migrations.ts` and `schema.snapshot.json` updated
- [ ] Core surface change (new core tool, prompt text, config key)? ADR + `surface-budget.json` justification
- [ ] Touches policy, pairing, vault, protocol auth or relay? Threat-model note below, security review requested
- [ ] Could this be a plugin instead? If it is in core, explain why
- [ ] Commits are signed off (DCO: `git commit -s`)
- [ ] **Clean-room attestation:** I wrote this myself; it contains no code, text, assets or names copied from the reference project (OpenClaw) or from sources with incompatible licences
- [ ] I have / have not studied the reference project's source code (state which): 

## Threat-model note (if applicable)
