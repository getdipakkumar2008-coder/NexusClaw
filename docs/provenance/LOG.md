# Provenance Log

Per docs/12 section 4: for each module, what spec it implements and which external sources informed it. Append one row per module/PR. "Source" must never be the reference project's code.

| Date | Module / path | Implements (spec in this repo) | External sources consulted (public specs, libraries, docs) | Author |
|---|---|---|---|---|
| 2026-10-16 | packages/protocol | docs/03 | zod documentation | Phase 0 scaffold (AI-assisted, owner-directed) |
| 2026-10-16 | packages/plugin-sdk | docs/04 | zod documentation; npm caret-range semantics (public) | Phase 0 scaffold |
| 2026-10-16 | src/config | docs/08 section 5, docs/06 SEC-6 | zod documentation | Phase 0 scaffold |
| 2026-10-16 | tools/*, .dependency-cruiser.cjs | docs/02 section 5 | dependency-cruiser documentation | Phase 0 scaffold |
| 2026-10-16 | src/store | docs/02 §7, docs/03 §6, docs/spikes/RESULTS.md | Node.js node:sqlite and SQLite WAL documentation | Phase 1 WP1 (AI-assisted, owner-directed) |
| 2026-10-16 | src/policy | docs/06 §4, ADR-0008 | Node.js crypto docs | Phase 1 WP2 |
| 2026-10-16 | src/pairing | docs/05 §2, docs/06 T2/T3 | Node.js crypto docs | Phase 1 WP3 |
| 2026-10-16 | src/vault | docs/06 SEC-8 | Node.js crypto docs (AES-GCM, scrypt); NIST SP 800-38D (GCM) | Phase 1 WP4 |
| 2026-10-16 | src/gateway (server) | docs/03, docs/06 T6/T18 | `ws` library documentation; Node.js http docs | Phase 1 WP5 slice 1 |
| 2026-10-16 | src/sessions | docs/01 FR-SES, docs/02 §7, docs/03 | Node.js docs (AbortController, async iterators); SQLite savepoint docs | Phase 1 WP6 |
| 2026-10-16 | src/tools | docs/06 T14/T1, docs/01 | Node.js docs (child_process, fs.realpath); Windows taskkill docs | Phase 1 WP8 |
| 2026-10-16 | packages/cli, src/daemon | docs/14, docs/03 | Node.js docs (readline, http, fs.statfs); SQLite VACUUM INTO docs | Phase 1 WP12 |
| 2026-10-16 | src/acp (+ provider config, `provider test`) | docs/04 §7, docs/02 | Agent Client Protocol specification and vendor ACP docs (agentclientprotocol.com, cursor.com/docs/cli/acp, Gemini CLI docs); npm registry metadata for the adapters. A web search also listed pages from the reference project's documentation; they were **not opened or used** | Phase 1 WP7 slice 1 |
| 2026-10-16 | src/acp (MCP server, tool bridge), Gateway bridge credentials | docs/04 §7, docs/06 | Model Context Protocol public specification, revision 2025-06-18 (tools and lifecycle pages, fetched and compared against the implementation); ACP `session/new` and `session/request_permission` docs; behaviour of Claude Code's adapter observed by running it | Phase 1 WP7 slice 2 |
| 2026-10-16 | src/plugins, extensions/hello-tool | docs/04, docs/06 SEC-12/T4 | Node.js permission model and child_process.fork (general knowledge of the public documentation; the actual enforcement was verified by running it, not assumed) | Phase 1 WP9 slice 1 |
| 2026-10-16 | src/vault (LocalVault), plugin settings and secrets | docs/04, docs/06 SEC-8 | Node.js crypto and fs docs; no reference-project material | Phase 1 WP9 slice 2 |
| 2026-10-16 | src/channels (router, WebChat, conformance suite) | docs/05, docs/06 T2/T3 | `ws` library documentation; general web security practice (CSP, same-origin checks); no reference-project material | Phase 1 WP10 slice 1 |
| 2026-10-16 | spikes/* | docs/11 section D | Node.js docs (node:sqlite, node:crypto, child_process) | Phase 0 scaffold |

Note: the planning docs themselves were derived from `req.odt`, a brief that the owner states was reconstructed from the reference project's public artifacts. See docs/12 section 3 for the renames/rewrites still pending (Q-19).
