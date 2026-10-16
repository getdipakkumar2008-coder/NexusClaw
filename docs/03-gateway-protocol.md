# 03 — Gateway Protocol Specification (v0 draft)

## 1. Transport
- **WebSocket** `wss://<host>/v1/ws` (JSON text frames, UTF-8). TLS required for non-loopback; loopback may be plain `ws://`.
- **HTTP** `/healthz`, `/readyz`, `/v1/upload` (attachments), `/v1/pair/*`.
- Default bind: `127.0.0.1`. Non-loopback bind requires explicit config **and** auth enabled (Gateway refuses to start otherwise).
- Remote access: operator-provided (Tailscale/WireGuard/reverse proxy). Project does not run a tunnel by default.

## 2. Versioning
`protocolVersion: "1.<minor>"`. Handshake negotiates; minor = additive only. Unknown fields ignored; unknown *required* capabilities cause `UNSUPPORTED`. Schemas generated from `packages/protocol` (zod → JSON Schema) and published.

## 3. Authentication & authorization
| Client | Mechanism |
|---|---|
| Local CLI/TUI on same host | Unix socket / named pipe with OS-user check, or token file with 0600 perms |
| Web Control UI | Session cookie after token login; SameSite=Strict; CSRF token; Origin check |
| Paired device (apps) | Device keypair (Ed25519). Challenge–response on every connect; short-lived access token (≤15 min) refreshed by signature. Revocable. |
| Plugin/extension processes | Separate internal channel, capability-scoped |
Roles: `owner`, `operator` (team), `viewer`, `device:<scope>`. Every request authorised against role + method scope. Failed auth rate-limited; lockout with backoff.

## 4. Frame format
```jsonc
// request
{ "t":"req", "id":"c-123", "method":"session.send", "params":{...} }
// response
{ "t":"res", "id":"c-123", "ok":true, "result":{...} }   // or "ok":false,"error":{code,message,remediation,retryable}
// event (server push)
{ "t":"evt", "seq":9812, "type":"run.delta", "session":"s_1", "data":{...} }
```
Max frame 1 MiB; larger payloads via `/v1/upload` + blob reference.

## 5. Methods (v1 set)
| Group | Methods |
|---|---|
| connect | `hello`, `auth.challenge`, `auth.verify`, `auth.refresh` |
| sessions | `session.list`, `session.get`, `session.create`, `session.send`, `session.cancel`, `session.export`, `session.delete` |
| approvals | `approval.list`, `approval.decide` (owner); `approval.status` (tool bridge, own approvals only) |
| plugins (owner only) | `plugin.list`, `plugin.info`, `plugin.install` (absolute folder path, `replace`), `plugin.enable` (`id`, `approvalToken`), `plugin.disable`, `plugin.remove` (`purgeData`) |
| tools | `tool.list`, `tool.call` (owner; a tool bridge may call these as its session's principal) |
| events | `events.subscribe {sessions?, since:seq}`, `events.unsubscribe` |
| channels | `channel.list`, `channel.status`, `channel.enable/disable`, `pairing.list`, `pairing.approve`, `pairing.deny` |
| devices | `device.pair.begin`, `device.list`, `device.revoke`, `device.action.result` |
| memory | `memory.list/read/write/delete/export` |
| automations | `automation.list/create/update/delete/run` |
| config | `config.get` (secrets redacted), `config.validate`, `config.patch` (schema-checked), `doctor.run` |
| plugins | `plugin.list/install/enable/disable/remove` |
| system | `status`, `usage`, `logs.tail` |

## 6. Events (selected)
`session.created`, `message.inbound`, `message.outbound`, `run.started|delta|tool_call|tool_result|completed|failed|cancelled`, `approval.requested|decided`, `channel.status`, `device.paired|revoked`, `device.action.request` (camera/screen/location), `automation.fired`, `config.changed`, `gateway.shutting_down`.
Guarantee: events are **totally ordered by `seq`**, durable, at-least-once delivery with client-side dedupe by `seq`; resume with `since`. Retention configurable (default 30 days, compacted).

## 7. Errors
`{code, message, remediation, retryable, docsUrl?}`. Code families: `AUTH_*`, `POLICY_*`, `PROVIDER_*`, `CHANNEL_*`, `CONFIG_*`, `PLUGIN_*`, `RATE_LIMIT`, `UNSUPPORTED`, `INTERNAL`. No stack traces to clients (logged locally with correlation id).

## 8. Backpressure & limits
Per-connection send queue cap (default 5 MiB) → slow clients dropped with `SLOW_CONSUMER` (can resume by cursor). Request rate limits per role. Max concurrent runs per session = 1 (inputs queued, with `steer`/`interrupt` modes **[Proposed]**).

## 9. Device actions
Gateway sends `device.action.request {id, kind: camera|screen|location|notification|…, params, expiresAt}` to a specific paired device. Device shows consent UI (unless pre-granted by user policy on-device), returns `device.action.result` (blob ref). Gateway never assumes consent. Audit-logged.

## 10. Compatibility test fixtures
`/test-fixtures/gateway/*`: pinned Gateway builds + recorded transcripts used by app release validation (matches req §5 "pinned Gateway fixtures").

## 11. Acceptance
Protocol conformance suite (`packages/protocol/conformance`) must pass for the Gateway and be runnable by any client implementation. Fuzz tests on frame parser. Reconnect/resume test. Authz matrix test (every method × role).

## Tool-bridge role (WP7 slice 2)
`connection.hello` answers `role: "agent"` when the presented credential is a bridge credential (prefix `cnb_`) instead of the owner token. An agent connection is bound to one Gateway session and may call only `tool.list`, `tool.call` and `approval.status`; every other method returns `AUTH.FORBIDDEN`. `tool.call` from an agent accepts only `tool`, `args` and `approvalId`: the principal, session and trust level come from the credential, and the call is always treated as tainted. Credentials are random, in memory only, expire after 24 h, and are revoked when the harness session ends or the Gateway stops (the connection is closed with code 4401).
