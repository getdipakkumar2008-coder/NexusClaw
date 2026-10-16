# ADR-0012: Strict config with mandatory migrations

- Status: Accepted (owner approval of defaults, Phase 0)
- Date: 2026-10-16

## Decision
Unknown or stale keys are errors; every breaking schema change ships a migration used by `doctor --fix`; a schema snapshot test forces the change to be explicit.

## Rationale and consequences
No silent misconfiguration; reliable upgrades.

## References
src/config (schema, migrate, snapshot test).
