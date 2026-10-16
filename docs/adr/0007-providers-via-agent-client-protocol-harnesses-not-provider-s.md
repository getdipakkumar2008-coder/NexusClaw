# ADR-0007: Providers via Agent Client Protocol harnesses, not provider SDKs in core

- Status: Accepted (owner approval of defaults, Phase 0)
- Date: 2026-10-16

## Decision
Models and agent harnesses plug in through an ACP client extension rather than being hard-coded in core.

## Rationale and consequences
Swappable providers, smaller core. Risk: ACP maturity (spike 1 not yet done, needs a harness and credentials).

## References
docs/04 section 7.
