# ADR-0009: Memory v1 is Markdown files owned by the operator

- Status: Accepted (owner approval of defaults, Phase 0)
- Date: 2026-10-16

## Decision
Memory is human-readable, editable files with per-contact scoping; any index is an optional plugin.

## Rationale and consequences
Transparency, easy backup and deletion, no lock-in.

## References
docs/01 FR-MEM.

## Implementation (Phase 1, WP11)
Notes are files under `<data>/memory/` (`owner/` and `contacts/<channel>/<id>/`), read from disk on every use. The Gateway decides which notes a conversation may see from the session: the owner's for the owner, the person's own for a guest talking one-to-one, none in a group. The model gets four tools without a scope argument (`memory.search`, `memory.read`, `memory.write`, `memory.delete`) and a labelled block of notes at the start of a turn.

Core surface added: four built-in tools and one framing sentence in the model's context. These are within the P0 scope of FR-MEM-1..3, but `surface-budget.json` was not changed; raising `maxCoreTools` and `maxSystemPromptTokens` for them needs the owner's sign-off.
