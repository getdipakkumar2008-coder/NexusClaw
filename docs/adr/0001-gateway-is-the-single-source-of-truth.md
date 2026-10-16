# ADR-0001: Gateway is the single source of truth

- Status: Accepted (owner approval of defaults, Phase 0)
- Date: 2026-10-16

## Decision
A single Gateway process owns sessions, tools, event streams and channel connections. CLI, web UI, TUI and apps are clients of the public protocol and keep no authoritative state.

## Rationale and consequences
Prevents divergent state between surfaces; one place to enforce policy. Cost: Gateway is a critical single process (mitigated by durable event log and fast restart).

## References
docs/02, FR-GW-1/2. Enforced by dependency-cruiser rule clients-only-use-protocol.
