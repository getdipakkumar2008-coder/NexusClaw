# ADR-0010: Device pairing with Ed25519 keys and short-lived tokens

- Status: Accepted (owner approval of defaults, Phase 0)
- Date: 2026-10-16

## Decision
Devices hold a keypair; connect via challenge-response; access tokens live at most 15 minutes; devices are individually revocable.

## Rationale and consequences
No long-lived bearer secret on phones.

## Implementation (Phase 1, WP5)
The "short-lived token" is realised as a **lease on the connection**: a sign-in lasts at most 15 minutes and is renewed by signing a new challenge, so no bearer secret exists at all. Devices carry scopes (read, chat, approve). Details: docs/03 "Device sign-in" and docs/15.

## References
docs/03 section 3.
