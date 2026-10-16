# ADR-0005: Two-tier extension model with a core admission bar and surface budget

- Status: Accepted (owner approval of defaults, Phase 0)
- Date: 2026-10-16

## Decision
Core stays minimal and is measured (tools, prompt tokens, config keys). New capability defaults to plugins.

## Rationale and consequences
Every core item costs every operator on every request. Budget file and tests make growth a deliberate decision.

## References
docs/04 section 1; surface-budget.json; config surface test.
