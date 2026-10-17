# 06 — Security & Trust Model, Threat Model

Security is priority #1. This document turns the five statements in `req.odt` §4 into enforceable requirements and a threat model.

## 1. Security requirements
| ID | Requirement | Source |
|---|---|---|
| SEC-1 | State, memory, credentials stay on operator hardware | req §1 |
| SEC-2 | No telemetry/analytics by default; anything leaving the install is operator opt-in and documented in `PRIVACY.md` with a CI check listing all outbound endpoints | req §4 |
| SEC-3 | All inbound channel content is untrusted | req §2 |
| SEC-4 | New senders need explicit pairing approval | req §2 |
| SEC-5 | Tools run on host by default for the **verified owner**; sandboxing opt-in (supported, easy to enable) | req §4 |
| SEC-5a | **[Proposed]** Non-owner/paired-guest senders get a *restricted* default tool profile (no exec, no fs write, no network tools) unless owner elevates | resolves C1 |
| SEC-6 | **[Proposed]** Gateway refuses non-loopback bind without auth + TLS (or explicit `--insecure` acknowledged in config) | |
| SEC-7 | Shared/team Gateway = mutually-trusting humans only; documented; UI warns; mutually untrusted users need separate Gateways/containers | req §4 |
| SEC-8 | Secrets encrypted at rest; never logged; redacted in config.get and diagnostics | |
| SEC-9 | Device↔Gateway↔Relay trust cryptographically bound | req §4 |
| SEC-10 | Relay accepts sends only from official, attested builds *or* from a self-hosted relay the operator controls | req §4 |
| SEC-11 | Relay sees no message plaintext (payload E2E-encrypted to the device; push carries only wake/opaque ID) **[Proposed]** | |
| SEC-12 | Plugins: signed, permission-declared, crash-isolated; revocation list | |
| SEC-13 | Supply chain: lockfiles, `pnpm audit` gate, SBOM, provenance (sigstore/SLSA), reproducible-build target | |
| SEC-14 | Audit log (local, append-only, tamper-evident hash chain) for approvals, pairings, device actions, config changes, tool exec | |
| SEC-15 | Responsible disclosure policy (`SECURITY.md`), 90-day default, CVE via Foundation CNA/GitHub | |

## 2. Trust boundaries & assets
Assets: provider API keys, channel tokens, memory/transcripts (personal data), host filesystem/shell, device sensors, signing keys.
Principals: Owner · Team operator · Paired guest · Unpaired sender · Plugin · Model/harness · Remote agent (A2A) · Companion device · Relay.
Boundaries: (B1) Internet↔channel platform↔Gateway; (B2) Gateway↔plugin process; (B3) Gateway↔harness; (B4) Gateway↔tools/host OS; (B5) Gateway↔client; (B6) Device↔Relay↔APNs/FCM; (B7) Hub↔Gateway (updates/plugins).

## 3. Threat model (STRIDE + LLM-specific)
| ID | Threat | Boundary | Impact | Mitigation | Residual |
|---|---|---|---|---|---|
| T1 | **Prompt injection** via inbound message/attachment/web content causing tool misuse or data exfiltration | B1/B3 | Host RCE, data theft | Untrusted-content tagging; restricted tool profile for non-owner; per-tool approval for high-risk (exec, fs write outside workspace, network egress, send-on-behalf); egress allowlist; approvals show *why*; sandbox option | Medium — inherent to LLM agents; owner-run host-exec relies on approval hygiene |
| T2 | Spoofed sender / sender-ID collision across channels | B1 | Impersonation of owner | Identity bound to (channel, accountId, externalId) + pairing; owner identity set only through authenticated client | Low |
| T3 | Pairing-code brute force / spam | B1 | Unauthorised access, DoS | High-entropy codes, expiry 1 h, rate limits, max pending, owner approval | Low |
| T4 | Malicious plugin (typosquat, compromised publisher) | B2/B7 | Full compromise | Signing, provenance, tiers, permission display, revocation, no install-time code, pinned versions, process isolation | Medium |
| T5 | Malicious/ compromised MCP server in bundle | B3/B4 | Tool abuse | Listed at install, policy-governed, sandboxable, default off | Medium |
| T6 | Gateway exposed to internet without auth | B5 | Total compromise | SEC-6 refusal (implemented: no non-loopback bind without TLS, or an explicit acknowledgement), startup warnings, `doctor` check, secure defaults | Low |
| T7 | Token theft from disk | — | Account takeover | Vault encryption (OS keychain), 0600 perms, short-lived device tokens | Medium (host compromise) |
| T8 | Stolen/lost paired device | B5 | Gateway control | Revocation (implemented: immediate disconnect and refusal), per-device scopes (implemented), re-auth every 15 minutes (implemented), re-auth for sensitive approvals and biometric gate on app (apps, not yet) | Low |
| T9 | Relay abuse by unofficial builds (spam push, impersonation) | B6 | Cost, phishing | App Attest / Play Integrity attestation + **delegated send grants** (gateway signs time-/rate-limited grant for a specific device token; relay verifies grant signature + attestation) | Low-Med |
| T10 | Relay compromise reading content | B6 | Privacy | E2E payload encryption; relay stores minimal state; self-host option | Low |
| T11 | Cross-user data leakage in team Gateway | B5 | Privacy | Documented as out of guarantee (mutual-trust only) + per-sender session/memory scoping as defence in depth | Accepted by design |
| T12 | Malicious A2A peer | B1 | Injection, loop, cost | Explicit trust, capability allowlist, hop/budget limits, treat output as untrusted | Medium |
| T13 | Tool output / web content injection (indirect) | B4 | As T1 | Same as T1; content provenance labels | Medium |
| T14 | Path traversal / symlink escape in file tools | B4 | File disclosure | Canonicalisation, workspace roots, deny list | Low |
| T15 | Resource exhaustion (runaway loops, huge uploads, cost) | any | DoS / bill | Budgets, timeouts, size caps, per-sender limits, circuit breakers | Low |
| T16 | Update channel compromise | B7 | Fleet RCE | Signed releases (Foundation key, offline root), TUF-style metadata, rollback protection | Low-Med |
| T17 | Log/diagnostic leakage | — | Privacy | Redaction, user-reviewed bundles | Low |
| T18 | Web Control UI XSS/CSRF/clickjacking | B5 | Takeover | CSP strict, no inline scripts, SameSite, CSRF tokens, frame-ancestors none, markdown sanitised | Low |
| T19 | Memory poisoning (persistent injection stored in memory) | B1 | Long-term manipulation | Memory writes from untrusted sessions need approval or are scoped per-contact; provenance recorded; easy review/diff. Implemented (WP11): the model's scope comes from the session, never its arguments; guests cannot write; groups have no memory; the owner's notes are never shown to a guest; notes are shown labelled as information, not instructions | Medium |
| T21 | Malicious attachment (disguised program, oversized file, hostile image, file address that steals a token) | B1 | Malware on the host; token theft; model manipulation | Stored only for paired senders after rate limits; type from content with a short allow-list and nothing parsed or run; size/count/total limits; content-addressed 0600 files; plugins fetch only from the platform's own hosts and send tokens only there; file names shown to the model as quoted data; contents labelled untrusted and policy unchanged; hidden metadata cut from JPEG and PNG; optional owner-supplied file-check program (fails closed); WebChat uploads only from paired visitors with bounded memory | Low-Med |
| T22 | Data leaves through the file tool (a prompt-injected model sends a private file to a chat) | B1 | Disclosure | No destination argument (the file goes only into the session's own conversation); risk 2, so the owner approves each send unless trusted profile and trusted context; guests and groups are denied; only workspace files (protected names excluded) or files already in the conversation; pictures, PDF, audio and text only, 8 MB; the send is audited (`channel.file_sent`: type and size, no name or content) | Low-Med |
| T20 | Device-action abuse (silent camera/mic) | B5 | Privacy | On-device consent, visible indicators, audit, no background capture | Low |

## 4. Tool policy model
Layered, deny-by-default for non-owner:
`global policy → channel policy → sender profile → session override → per-call approval`.
Risk classes: R0 read-only/harmless · R1 workspace write · R2 network/egress · R3 host exec · R4 irreversible/external side effects (send message, payment, delete). Defaults: owner R0–R1 auto, R2 ask-once-per-domain, R3/R4 ask each time (configurable "trust mode" lowers prompts at owner's risk, with a banner).
Approvals can be given from any authenticated client and are bound to the exact call (hash of tool+args), expire, and are audit-logged.

## 5. Sandbox
Interface `SandboxBackend` (spawn, fs mounts, network policy). Reference backends: container (Docker/Podman), OS-native (bubblewrap/Linux, seatbelt/macOS, AppContainer/Windows **[Q-10]**). Cloud sandboxes → external Crabbox via plugin (OOS-4).

## 6. Data protection
- At rest: vault encrypted (AES-256-GCM, key from OS keystore or Argon2id passphrase). Transcripts/memory plain by default (operator-editable) with optional disk-level/at-rest encryption setting **[Q-11]**.
- In transit: TLS 1.2+; mTLS optional; channel traffic per platform.
- Retention: configurable; `purge` command; right-to-erasure per contact.
- Third-party model providers receive prompt content — documented prominently; local models keep data on-device.

## 7. Push & relay architecture
```
Gateway ──(1) signs SendGrant{deviceId, relayId, scope, exp, rate}──┐
Device  ──(2) registers: APNs/FCM token + attestation (App Attest / Play Integrity) + device pubkey ──► Relay
Gateway ──(3) POST {grant, E2E-encrypted payload} ──► Relay ──(4) verifies grant sig + device binding + attestation freshness ──► APNs/FCM ──► Device decrypts
```
- Binding: device pubkey registered with Gateway at pairing; Gateway signs grant over (deviceId, tokenHash, relayId, expiry). Relay validates against Gateway's public key learned from the device's attested registration.
- Unofficial builds fail attestation → relay refuses registration (they can use self-hosted relay).
- Relay holds no message content, minimal metadata, rotates tokens, rate-limits per grant.
- Residual (review 2): a malicious *Gateway* that a user has knowingly paired can still push to that user's device; mitigations = grants are per-device and rate-limited, push carries only opaque wake IDs (content fetched from the Gateway after the app authenticates), and the user can revoke the device.
- Provider terms: using a consumer AI subscription's OAuth/session token through third-party tooling may violate that provider's terms. The project documents officially supported auth (API keys, official harness login flows) only, and never ships code that extracts or replays subscription tokens.
- Self-hosted relay supported; hosted relay is **optional hosted convenience** (priority #6), operated by Foundation/maintainers **[Q-7]**.

## 8. Secure development
Threat-model review required for any PR touching policy, pairing, vault, protocol auth, relay. CODEOWNERS-enforced. Fuzzing (protocol parser, channel normalisers). SAST (CodeQL), secret scanning, dependency review, quarterly external review budget **[Proposed]**. Security regression tests for every fixed vuln.

## 9. Acceptance
Status (WP13): authorisation matrix, policy enumeration, injection corpus, fuzz targets (CI and nightly), `doctor --security` and CodeQL are in place; the pen-test checklist, relay abuse tests (no relay yet) and the external review are not. See docs/16.

Pen-test checklist; authz matrix tests; injection red-team corpus run in CI against policy engine (must show non-owner cannot reach R2+ tools); relay abuse tests with unattested client; fuzz targets with zero crashes in nightly run; `doctor --security` passes on default install.
