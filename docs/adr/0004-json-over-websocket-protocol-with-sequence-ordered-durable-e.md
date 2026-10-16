# ADR-0004: JSON-over-WebSocket protocol with sequence-ordered durable events

- Status: Accepted (owner approval of defaults, Phase 0)
- Date: 2026-10-16

## Decision
Clients talk to the Gateway via versioned JSON frames; events carry a monotonically increasing seq and clients resume with a cursor.

## Rationale and consequences
Simple, debuggable, mobile friendly. Cost: JSON overhead (acceptable at personal scale).

## References
docs/03; packages/protocol.
