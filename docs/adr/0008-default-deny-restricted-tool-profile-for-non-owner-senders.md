# ADR-0008: Default-deny restricted tool profile for non-owner senders

- Status: Accepted (owner approval of defaults, Phase 0)
- Date: 2026-10-16

## Decision
Verified owner may use host tools (with approval for high-risk classes); every other principal gets a restricted profile unless elevated.

## Rationale and consequences
Resolves 'security first' vs 'host tools by default' under prompt injection.

## References
docs/06 SEC-5/5a, tool policy model.
