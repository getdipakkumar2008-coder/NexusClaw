# ADR-0010: Device pairing with Ed25519 keys and short-lived tokens

- Status: Accepted (owner approval of defaults, Phase 0)
- Date: 2026-10-16

## Decision
Devices hold a keypair; connect via challenge-response; access tokens live at most 15 minutes; devices are individually revocable.

## Rationale and consequences
No long-lived bearer secret on phones.

## References
docs/03 section 3.
