# 04 — Plugin & Extension System

## 1. Why two tiers
Every core tool, prompt fragment and config key is paid by every operator on every request ("taxed"). Therefore: **Core is minimal; plugins are the default home for new features.**

### Core admission bar (all must be true)
1. Needed by nearly all operators for first-run or safety.
2. Cannot be a plugin without weakening security or the plugin contract.
3. Has a measured per-request cost (tokens/latency) and owner.
4. Has tests, docs, and config-migration story.
Core "tax budget" is tracked in CI (`doctor --surface`): number of core tools, system-prompt tokens, config keys. Regressions need an ADR.

## 2. Plugin styles
| | Code plugin | Bundle plugin |
|---|---|---|
| Content | JS/TS module using `plugin-sdk` | Declarative: skills (Markdown), MCP server definitions, config presets |
| Can register | channels, tools, providers, hooks, services | skills, MCP servers, config defaults |
| Executes code at install | No (executes at load, sandboxed per policy) | **Never** |
| Trust needed | High (signed / reviewed / user-approved) | Lower (but MCP servers they reference run code → surfaced at install) |
| Stability promise | SDK semver | Manifest schema semver |

## 3. Manifest (`clawnexus.plugin.json`)
```jsonc
{
  "id": "telegram", "name": "Telegram channel", "version": "1.2.0",
  "kind": "code" | "bundle",
  "sdkRange": "^1.0.0",
  "entry": "dist/index.js",
  "provides": ["channel:telegram"],
  "permissions": { "network": ["api.telegram.org"], "fs": ["data:plugins/telegram"],
                   "exec": false, "secrets": ["telegram.botToken"] },
  "configSchema": { /* JSON Schema */ },
  "hub": { "publisher": "clawnexus", "signature": "…", "sbom": "sbom.json" }
}
```
Permissions are **declared, shown to the operator at install, and enforced** by the Plugin Host where technically possible (process permissions / policy proxy); un-enforceable permissions are labelled "advisory".

## 4. SDK surface (`packages/plugin-sdk`) — v1 draft
- `definePlugin({ setup(ctx) })`
- `ctx.registerChannel(adapter)`, `ctx.registerTool(def)`, `ctx.registerProvider(...)`, `ctx.on(hook, fn)`
- `ctx.config`, `ctx.log` (redacting), `ctx.storage` (namespaced KV + dir), `ctx.secrets.get(name)` (scoped), `ctx.http` (policy-aware fetch)
- Hooks (typed, ordered, timeout-bounded): `message.inbound`, `before_tool_call`, `after_tool_call`, `before_prompt_build`, `run.completed`, `session.start`. Hooks may *deny* or *annotate*, never silently mutate security-relevant fields.
- Stability: only symbols exported from `plugin-sdk` are public. API Extractor report committed; CI fails on unreviewed API diff.

## 5. Lifecycle
discover → validate manifest → check sdkRange + signature → show permissions → user enable → load in isolation → health check → run → unload. Failures are contained; plugin marked `degraded` with reason; Gateway continues.

## 6. ClawNexusHub (registry)
- Index of plugins/skills with metadata, versions, publisher identity, signatures, SBOM, download counts (opt-in only; no telemetry).
- Publishing: GitHub-identity login → CI-provenance (SLSA/sigstore) → automated checks (manifest, deps audit, static scan) → listing. Tiers: **Official** (Foundation-signed), **Verified publisher**, **Community** (warn on install).
- Client: `clawnexus plugins search|install|update|remove|verify`. Install is pinned by version+hash; updates never silent for code plugins (notify + approve; auto-update opt-in for bundles).
- Takedown/revocation list fetched periodically (offline-safe) → Gateway disables revoked plugins.
- Self-hostable registry mirror supported (air-gapped users).
- **Hub backend itself is a separate project/repo**; core only ships the client and the protocol. **[Proposed]**

## 7. Providers & ACP (`extensions/acpx`)
- Implements Agent Client Protocol client; each provider is an ACP-speaking harness launched as a subprocess with a declared command and env allowlist.
- Gateway exposes its tools to harness through ACP/MCP bridge subject to policy.
- Conformance suite: prompt/response, streaming, tool call round-trip, cancellation, error mapping, usage reporting.

## 8. Anti-duplication rule (non-goal OOS-5)
Before accepting a new channel/MCP path, check the "existing infrastructure" list; PR template requires justification of why existing bridge is insufficient.

## 9. Acceptance
Plugin conformance kit; crash-isolation test; permission-enforcement tests; signature-verification tests (tampered package must fail); SDK API-diff gate; sample plugins (hello-tool, hello-channel, hello-bundle) built in CI.
