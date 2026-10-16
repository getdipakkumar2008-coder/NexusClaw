# 02 — Architecture

## 1. Context
```
 Messaging platforms        Companion apps / CLI / Web / TUI
 (Telegram, Slack, …)       (clients of the Gateway protocol)
        │  channel plugins          │  WS + HTTP (03-gateway-protocol)
        ▼                           ▼
 ┌──────────────────────────────────────────────────────────┐
 │                       GATEWAY (single process)           │
 │  Channel Manager ─ Router/Policy ─ Session Manager       │
 │  Tool Executor ── Approval Service ─ Event Bus           │
 │  Plugin Host ──── Config/Doctor ─── Credential Vault     │
 │  Automation Scheduler ─ Memory Service ─ Subagent Mgr    │
 │            Storage: SQLite + files (data dir)            │
 └───────────────┬──────────────────────────────┬───────────┘
                 │ ACP (stdio/ws)               │ optional
                 ▼                              ▼
        Agent harnesses (extensions/acpx)   Push Relay (self-hostable / hosted opt-in)
        Claude · Codex · local models       APNs / FCM
```

## 2. Design rules
1. **Gateway is the sole source of truth.** Clients are stateless views + local caches.
2. **Core is taxed; keep it lean.** New capability → plugin first (FR-EXT-1).
3. **Untrusted by default:** inbound content, plugin code, tool output, model output.
4. **Boundaries enforced by tooling** (dependency-cruiser/ESLint boundary rules + TS project references).
5. **Explicit over implicit:** typed events, schema-validated config, versioned protocol.

## 3. Components
| Component | Responsibility | Key interfaces |
|---|---|---|
| Channel Manager | Lifecycle, reconnect, status of channel adapters | `ChannelAdapter` (05) |
| Router/Policy | Map inbound → session; apply pairing, allowlists, tool policy | `PolicyEngine` |
| Session Manager | Session lifecycle, transcripts, concurrency (one active run per session, queued input) | `Session`, `Run` |
| Agent Runtime (acpx) | Speak ACP to harnesses; translate tool calls ↔ Gateway tools | ACP client |
| Tool Executor | Run host/sandbox tools, stream output, timeouts, cancel | `ToolRunner` |
| Approval Service | Request/record human approval via any attached client/channel | `Approval` events |
| Event Bus | Ordered, durable, cursor-resumable events | append-only log table |
| Memory Service | Read/write memory files, scoped retrieval, optional index plugin | `MemoryStore` |
| Automation Scheduler | Cron/webhook/event triggers → runs | `Automation` |
| Subagent Manager | Spawn child runs with bounded perms/budget | `SpawnPolicy` |
| Plugin Host | Discover, validate, load, isolate plugins | `PluginManifest`, SDK |
| Config/Doctor | Schema validation, migrations, diagnostics | zod/JSON-schema + migrations |
| Credential Vault | Encrypt secrets; OS keychain or passphrase | `Vault` |
| Control server | HTTP+WS API | 03 |

## 4. Process & isolation model **[Proposed]**
- Gateway: one Node process (main). Plugins: **code plugins load in worker threads or child processes** (default: child process for channels/tools from third parties; in-process only for first-party signed bundled plugins). Crash of a plugin ≠ crash of Gateway.
- Harnesses: child processes via ACP over stdio.
- Tools: run as child processes under the policy engine; optional sandbox backend (container/bubblewrap/seatbelt) via plugin interface.

## 5. Repository layout (pnpm workspace) **[Proposed, aligned with req.odt]**
```
/package.json, pnpm-workspace.yaml, tsconfig.base.json
/src
  gateway/        control plane, protocol server
  channels/       channel manager + adapter contract (adapters are plugins)
  (no plugin-sdk here: the SDK lives only in packages/plugin-sdk; core consumes it like any plugin)
  policy/ memory/ sessions/ tools/ config/ vault/ automation/
/packages
  plugin-sdk/     published SDK
  protocol/       shared protocol types + JSON schemas (used by all clients)
  cli/ tui/ control-ui/
/extensions
  acpx/ a2a/ telegram/ discord/ slack/ whatsapp/ signal/ …
/apps
  macos/ ios/ android/ windows/ linux/ (+ watch targets)
/docs  /tools  /test-fixtures (pinned gateway fixtures)
```
Rule: `apps/*` and `packages/cli|tui|control-ui` may import only `packages/protocol`. Extensions may import only `plugin-sdk`.

## 6. Technology choices **[Proposed]** (ADR detail in 11)
| Concern | Choice | Reason |
|---|---|---|
| Language | TypeScript strict, ESM | Per req |
| Runtime | Node 22 LTS | Stable, broad support |
| Package mgr | pnpm workspaces | Per req |
| Storage | SQLite (better-sqlite3 / node:sqlite) WAL + files | Zero-ops self-host |
| Validation | zod + generated JSON Schema | One source of truth for config/protocol |
| Transport | WebSocket (JSON frames) + HTTP for health/uploads | Simple, mobile-friendly |
| Tests | Vitest | Per req |
| Apps | SwiftUI; Kotlin/Compose; Windows: WinUI 3 (C#) or Rust + native UI **[Q-9]**; Linux: GTK4 or Qt **[Q-9]** | "Genuinely native" |
| Logging | pino, JSON | Redaction hooks |
| Process mgmt | execa / node child_process | |

## 7. Data model (SQLite, logical)
- `sessions(id, channel, conversation_key, sender_scope, created_at, state)`
- `events(seq PK, session_id, type, payload_json, ts)` — append-only; basis of resume
- `runs(id, session_id, provider, status, usage_json)`
- `tool_calls(id, run_id, tool, args_json, result_ref, status, approval_id)`
- `approvals(id, kind, requester, decided_by, decision, ts)`
- `senders(id, channel, external_id, status[pending|paired|blocked], paired_at)`
- `devices(id, public_key, name, platform, paired_at, revoked_at)`
- `automations`, `automation_runs`
- `plugins(id, version, source, signature, enabled)`
- `schema_migrations`
Files: `memory/**/*.md`, `blobs/` (attachments, content-addressed), `config.json5`, `vault.enc`, `logs/`.
Memory v1 is plain Markdown on disk (editable, diffable, backup-friendly); DB stores only an optional index.

## 8. Key flows
**Inbound message:** adapter → Router (sender known? else pairing flow) → policy (allowed tools) → Session queue → Run via acpx → streamed events → Event Bus → clients + outbound adapter. Tool call → Policy → (approval?) → Executor → result.
**Device pairing:** `gateway` issues short-lived code/QR (contains gateway pubkey fingerprint + one-time secret, TTL 5 min) → device generates keypair → proves possession → owner approves → device record stored.
**Update:** `clawnexus update` → verify signature → stage → `doctor --fix` dry-run → swap → health check → auto-rollback on failure.

## 9. Scalability stance
Single-node by design (personal/team). No HA in 1.0. Horizontal scale is a non-goal; mutually untrusted users get separate Gateways.

## 10. Observability
Local structured logs, `status` command, optional OpenTelemetry exporter plugin (off by default).
