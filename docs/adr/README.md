# Architecture Decision Records

Lightweight ADRs. New ADRs: copy the latest, bump the number, set status to Proposed, and get maintainer approval (docs/09 section 4). Core-surface, protocol and policy changes need a supermajority.

| ADR | Title |
|---|---|
| 0001 | Gateway is the single source of truth |
| 0002 | TypeScript, Node 22+, pnpm workspace, ESM, strict |
| 0003 | SQLite (WAL) plus files for persistence |
| 0004 | JSON-over-WebSocket protocol with sequence-ordered durable events |
| 0005 | Two-tier extension model with a core admission bar and surface budget |
| 0006 | Code plugins isolated in child processes by default; signed; permission-declared |
| 0007 | Providers via Agent Client Protocol harnesses, not provider SDKs in core |
| 0008 | Default-deny restricted tool profile for non-owner senders |
| 0009 | Memory v1 is Markdown files owned by the operator |
| 0010 | Device pairing with Ed25519 keys and short-lived tokens |
| 0011 | Relay with attestation, delegated send grants and E2E payloads |
| 0012 | Strict config with mandatory migrations |
| 0013 | Apache-2.0 plus DCO |
| 0014 | Native apps, narrow shared modules, Android and macOS first |
