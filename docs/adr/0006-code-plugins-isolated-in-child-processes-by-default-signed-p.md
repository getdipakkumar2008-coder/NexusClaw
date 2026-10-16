# ADR-0006: Code plugins isolated in child processes by default; signed; permission-declared

- Status: Accepted (owner approval of defaults, Phase 0)
- Date: 2026-10-16

## Decision
Third-party code plugins run out of process. Bundle plugins never execute code at install. Permissions are declared and enforced where the OS allows (otherwise labelled advisory).

## Rationale and consequences
Crash and compromise containment. Cost: IPC overhead; Spike 3 measured it.

## References
docs/04; docs/spikes/RESULTS.md.
