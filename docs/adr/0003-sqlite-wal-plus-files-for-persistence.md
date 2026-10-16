# ADR-0003: SQLite (WAL) plus files for persistence

- Status: Accepted (owner approval of defaults, Phase 0)
- Date: 2026-10-16

## Decision
Operational state lives in SQLite in WAL mode; memory, blobs and config are plain files in the operator's data dir.

## Rationale and consequences
Zero-ops self-hosting, transactional event log, easy backup. Cost: single node only. Spike 2 validated crash-safe append and resume with node:sqlite.

## References
docs/02 section 7; docs/spikes/RESULTS.md.
