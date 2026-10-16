# ADR-0011: Relay with attestation, delegated send grants and E2E payloads

- Status: Accepted (owner approval of defaults, Phase 0)
- Date: 2026-10-16

## Decision
Push relay accepts sends only with a Gateway-signed, rate-limited grant bound to an attested device; payloads are end-to-end encrypted. Spike 4 prototyped grant verification (not real attestation).

## Rationale and consequences
Stops unofficial builds abusing a hosted relay; relay sees no content.

## References
docs/06 section 7.
