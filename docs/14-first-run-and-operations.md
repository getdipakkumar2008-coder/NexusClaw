# 14 — First-Run Experience, Operations & Glossary

Added in review 2: the first-run experience is priority #3 but had no spec.

## 1. First-run flow (target ≤10 min, FR-DX-3)
1. **Install:** one command (npm/pnpm global, Homebrew, winget/scoop, Docker image, or install script with checksum). Prereq checks (Node, disk, ports) with fix hints.
2. **`<cli> setup`** wizard (also available in Control UI):
   a. Choose data dir (default per-OS) and show what will be stored.
   b. Create vault (OS keychain, else passphrase).
   c. Choose provider (list of ACP harnesses; test connection; explain where prompts go).
   d. Choose first channel (Telegram/WebChat recommended); guided token creation with links; test message.
   e. Pair owner identity (send code from the channel; approve in CLI).
   f. Security profile selector: *Standard* (ask for R3/R4, default), *Locked-down* (sandbox required), *Trusted* (owner opt-in, with warning banner).
   g. Optional: install as service (systemd / launchd / Windows service), enable backups.
3. **Verify:** `<cli> doctor` green; first reply received.
4. Next steps screen: add memory, install first plugin, pair phone.
Failure UX: every step is resumable; every error has code + cause + fix; no raw stack traces.

## 2. Deployment modes
| Mode | Who | Notes |
|---|---|---|
| Local process / user service | Individuals | Default; loopback bind |
| Docker/Compose | Homelab | Non-root, read-only rootfs where possible, volume for data dir |
| VPS behind reverse proxy / VPN | Remote access | TLS + auth required (SEC-6); guide for WireGuard/Tailscale/Caddy |
| Team Gateway | Mutually trusting group | Warning banner (SEC-7); roles owner/operator/viewer |
| Air-gapped | Security-sensitive | Local models only, offline updates, Hub mirror |

## 3. Operations runbook (documents to write)
- Upgrade/rollback (08 §6), backup/restore (FR-DATA-1), secret rotation, device revocation, channel re-auth, log locations and rotation, resource tuning, disk growth (event retention/compaction), disaster recovery, incident response (suspected prompt-injection/compromise: stop gateway, revoke devices, rotate tokens, review audit log).
- `doctor` checks list: config validity, permissions on data dir/vault, exposure (bind address/auth), plugin signatures/revocations, channel health, disk space, time skew, outdated versions (only if update-check opted in).

## 4. Support model
Community support via issues/discussions; diagnostics bundle (user-reviewed); documented known-issues per channel; security issues via private disclosure.

## 5. Documentation deliverables for users
Quickstart, concepts, security guide ("what the assistant can do on your machine"), channel setup guides, provider guides, plugin authoring guide, app guides, troubleshooting by error code, FAQ, upgrade notes.

## 6. Glossary (our own terms; Q-19 may rename)
- **Gateway:** the single local control-plane process.
- **Channel / adapter:** connection to a messaging platform.
- **Provider / harness:** model-backed agent runtime reached over ACP.
- **Session:** a conversation scope with its own transcript and permissions.
- **Run:** one agent execution within a session.
- **Pairing:** explicit approval of a new sender or device.
- **Tool policy:** rules determining which tools a principal may use, and when approval is required.
- **Code plugin / bundle plugin:** runtime-hooked extension vs declarative package (skills, MCP servers, config).
- **Hub:** the plugin registry (name TBD).
- **Relay:** optional push-notification forwarder.
- **Operator/owner:** person who runs the Gateway.
