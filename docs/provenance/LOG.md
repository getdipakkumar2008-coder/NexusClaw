# Provenance Log

Per docs/12 section 4: for each module, what spec it implements and which external sources informed it. Append one row per module/PR. "Source" must never be the reference project's code.

| Date | Module / path | Implements (spec in this repo) | External sources consulted (public specs, libraries, docs) | Author |
|---|---|---|---|---|
| 2026-10-16 | packages/protocol | docs/03 | zod documentation | Phase 0 scaffold (AI-assisted, owner-directed) |
| 2026-10-16 | packages/plugin-sdk | docs/04 | zod documentation; npm caret-range semantics (public) | Phase 0 scaffold |
| 2026-10-16 | src/config | docs/08 section 5, docs/06 SEC-6 | zod documentation | Phase 0 scaffold |
| 2026-10-16 | tools/*, .dependency-cruiser.cjs | docs/02 section 5 | dependency-cruiser documentation | Phase 0 scaffold |
| 2026-10-16 | spikes/* | docs/11 section D | Node.js docs (node:sqlite, node:crypto, child_process) | Phase 0 scaffold |

Note: the planning docs themselves were derived from `req.odt`, a brief that the owner states was reconstructed from the reference project's public artifacts. See docs/12 section 3 for the renames/rewrites still pending (Q-19).
