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
| Paired device (apps, other computers) | Device keypair (Ed25519), implemented (see "Device sign-in" below). Challenge–response on every connect; the sign-in lasts at most 15 minutes and is renewed by signing a new challenge. Revocable at once. |
| Plugin/extension processes | Separate internal channel, capability-scoped |
Roles: `owner`, `operator` (team), `viewer`, `device:<scope>`. Every request authorised against role + method scope. Failed auth rate-limited; lockout with backoff.

### Device sign-in (WP5)
- **Keys.** A device makes an Ed25519 key pair and keeps the private half. The Gateway stores only the public half (32 bytes, base64url). Keys that make a signature meaningless (zero, one, the field prime and its neighbours, either sign) are refused.
- **Pairing.** The owner runs `device.pair.begin`: a one-time code of 10 characters from an alphabet without 0/O/1/I/L, valid for 5 minutes, kept only as a hash in memory (a restart cancels it), at most 5 waiting and 20 devices. The device sends `hello` with `auth.pair`; on success it is signed in at once and receives its id. Wrong codes count against the sender's address and against everyone together: 10 wrong guesses cancel every waiting code.
- **Signing in.** `hello` with `auth.device {id}` returns `challenge {nonce, expiresInMs}` (32 random bytes, 30 s, single use, spent even by a wrong answer). The device answers `auth.verify {signature}`: Ed25519 over the UTF-8 bytes `clawnexus-device-auth-v1\n<deviceId>\n<nonce>\nconnect`. A recorded answer is useless: the next challenge differs, and the purpose word stops a sign-in answer being used to extend a sign-in.
- **Lease.** A device's sign-in lasts 15 minutes. Before then it sends `auth.challenge` then `auth.refresh` (same message with purpose `refresh`); otherwise the Gateway closes the connection with code 4401. There is no bearer token to steal: the private key never leaves the device.
- **Scopes.** `read`: `status`, `events.subscribe/unsubscribe`, `session.list/get`, `approval.list`. `chat`: `session.create/send/cancel` (messages are recorded as from `device:<id>`). `approve`: `approval.decide` (recorded as decided by `device:<id>`). Everything else (tools, plugins, memory, pairing, other devices, session export/delete) is the owner's alone and returns `AUTH.FORBIDDEN` naming the scope that would be needed.
- **Revocation.** `device.revoke` closes that device's connections (4401) and refuses it afterwards (`AUTH.REVOKED`); the record stays, marked revoked.
- **Errors.** `AUTH.BAD_DEVICE`, `AUTH.REVOKED`, `AUTH.BAD_PAIRING_CODE`, `AUTH.PAIRING`, `AUTH.NO_CHALLENGE`, `AUTH.CHALLENGE_EXPIRED`, `AUTH.BAD_SIGNATURE`, `AUTH.LOCKED`.

### TLS (WP5)
`gateway.tls.enabled` serves HTTPS and secure WebSocket (TLS 1.2 or later) from `<data>/tls/cert.pem` and `key.pem`, which must match; the Gateway will not start otherwise. Binding beyond loopback requires TLS, or `gateway.insecureAcknowledged`. The Host header must be a loopback name, the bound address, or a name in the certificate's subject alternative names, so a page on another site cannot reach the Gateway by rebinding a name it controls. `tls init` makes a self-signed ECDSA P-256 certificate (server authentication only, not a CA); a certificate from an authority can be dropped in instead. Clients trust it by its SHA-256 fingerprint (`--fingerprint`, checked before anything is sent) or by the certificate file (`--ca`). While running, the Gateway writes `<data>/gateway.endpoint` (address and fingerprint) so commands on the same computer find it; it is removed on shutdown.

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
| connect | `connection.hello` (`auth` is exactly one of `token`, `device:{id}`, `pair:{code, publicKey, name?}`), `auth.verify {signature}`, and for a signed-in device `auth.challenge`, `auth.refresh {signature}` |
| devices (owner only) | `device.pair.begin {name?, scopes?}` → `{code, expiresAt, scopes, url, fingerprint?}`, `device.list`, `device.revoke {id}` |
| sessions | `session.list`, `session.get`, `session.create`, `session.send`, `session.cancel`, `session.export`, `session.delete` |
| approvals | `approval.list`, `approval.decide` (owner); `approval.status` (tool bridge, own approvals only) |
| channels (owner only) | `channel.list`, `channel.webchat.link`, `pairing.owner` (register your own identity on a channel) |
| plugins (owner only) | `plugin.list`, `plugin.info`, `plugin.install` (absolute folder path, `replace`), `plugin.enable` (`id`, `approvalToken`), `plugin.disable`, `plugin.remove` (`purgeData`), `plugin.settings` (`id`), `plugin.config.set` (`id`, `values`; `null` removes a setting), `plugin.secret.set` (`id`, `name`, `value`), `plugin.secret.delete` (`id`, `name`). Secret values are accepted but never returned or logged |
| tools | `tool.list`, `tool.call` (owner; a tool bridge may call these as its session's principal) |
| events | `events.subscribe {sessions?, since:seq}`, `events.unsubscribe` |
| channels | `channel.list`, `channel.status`, `channel.enable/disable`, `pairing.list`, `pairing.approve`, `pairing.deny` |
| devices | `device.pair.begin`, `device.list`, `device.revoke`, `device.action.result` |
| memory | `memory.scopes`, `memory.list/read/write/delete/export/erase` (owner only; a tool bridge cannot call them). A scope is `{kind:"owner"}` or `{kind:"contact", channel, contact}`; `erase` also takes `"all"`. Errors: `MEMORY.NOT_FOUND`, `MEMORY.INVALID`, `MEMORY.TOO_LARGE`, `MEMORY.LIMIT`. |
| automations | `automation.list/create/update/delete/run` |
| config | `config.get` (secrets redacted), `config.validate`, `config.patch` (schema-checked), `doctor.run` |
| plugins | `plugin.list/install/enable/disable/remove` |
| system | `status`, `usage`, `logs.tail` |

## 6. Events (selected)
`session.created`, `message.inbound`, `message.outbound`, `run.started|delta|tool_call|tool_result|completed|failed|cancelled`, `approval.requested|decided`, `channel.status`, `device.paired|revoked`, `device.action.request` (camera/screen/location), `automation.fired`, `config.changed`, `gateway.shutting_down`.
Guarantee: events are **totally ordered by `seq`**, durable, at-least-once delivery with client-side dedupe by `seq`; resume with `since`. Retention configurable (default 30 days, compacted).

## 7. Errors
`{code, message, remediation, retryable, docsUrl?}`. Code families: `AUTH_*`, `POLICY_*`, `PROVIDER_*`, `CHANNEL_*`, `CONFIG_*`, `PLUGIN_*`, `MEMORY_*`, `RATE_LIMIT`, `UNSUPPORTED`, `INTERNAL`. No stack traces to clients (logged locally with correlation id).

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

## WebChat socket (`/v1/webchat`)
A separate, unauthenticated-by-token socket for browsers; it is not the owner protocol. Frames (JSON): client `hello` (`secret`, `redeem`), `message` (`id`, `text`), `ping`; server `ready` (`role`, `secret` only when newly issued, `redeemed`), `history`, `message`, `typing`, `ack` (`status`, `role`). Identity is the secret; the owner role comes only from redeeming a one-time link.
