# 08 — Release Engineering, Testing & Config Governance

## 1. Test strategy (pyramid)
| Layer | Tooling | Scope | Gate |
|---|---|---|---|
| Unit | Vitest | pure logic, policy, config, parsers | PR |
| Contract | Vitest + JSON-schema | protocol, plugin SDK, channel adapter conformance | PR |
| Integration | Vitest + in-memory/SQLite + mocked platforms | Gateway flows | PR |
| E2E (headless) | scripted Gateway + fake channel + fake ACP harness | pair→chat→tool→approve | PR |
| Security | authz matrix, injection corpus, fuzz | policy/pairing/protocol | PR + nightly |
| Android | Gradle unit + instrumented + ktlint + detekt | app | PR / release |
| Apple | XCTest/XCUITest + SwiftLint | apps | PR / release |
| Release validation | `android:release:validate`, iOS qualification job, macOS/Windows/Linux equivalents, against **pinned Gateway fixtures** | release candidate | release |
| Live channel smoke | real test accounts | nightly, non-blocking | |
Coverage = diagnostic; critical modules ≥90%.

## 2. CI pipeline
1. Lint/format/typecheck, boundary rules, API-extractor diff, config-schema-migration check, surface-budget check.
2. Unit/contract/integration/E2E (matrix: Node LTS × Linux/macOS/Windows).
3. Security scans: audit, CodeQL, secret scan, SBOM, licence check.
4. Build artifacts + provenance attestation.
5. Release candidate → qualification (apps) → manual approval → signing → publish.
**Credentials rule (req §3):** signing assets and store credentials are only decrypted in the release job, which depends on a green qualification job; never available to PR builds or forks.

## 3. Release pipelines
| Artifact | Process |
|---|---|
| npm packages / Gateway | changesets versioning, provenance, signed tarball, GitHub release, container image (multi-arch, distroless/non-root), install script w/ checksum |
| Android | Fastlane: build AAB → sign (keystore from encrypted store) → Play internal → promote; auto release notes from changesets/commits |
| iOS/macOS/watchOS | Fastlane match-style encrypted cert/profile sync → notarise (macOS) → TestFlight → App Store |
| Windows | MSIX/installer signed (code-signing cert in HSM/cloud signing) |
| Linux | Flatpak, .deb, AppImage; signed repos |
Release notes: generated from conventional commits/changesets, human-edited, include migration notes.

## 4. Versioning & compatibility
Gateway semver. Protocol minor additive. Apps declare supported protocol range; Gateway reports min app version. Plugin SDK semver with deprecation window ≥6 months (NFR-COMP-1). Release channels: `stable`, `beta`, `nightly`.

## 5. Config governance (FR-DX-1..3)
- Single Zod schema → JSON Schema; unknown/renamed keys **fail validation with a precise message** (never silently ignored).
- Every breaking change = new `configVersion` + migration function + fixture test; CI diffs the schema and fails without a migration.
- `clawnexus doctor` (read-only checks), `doctor --fix` (apply migrations/repairs, creates backup first, idempotent, prints diff).
- Config includes only references to secrets, never secrets.

## 6. Update & rollback
`clawnexus update`: verify signature+metadata (TUF-style) → backup data dir snapshot → stage → run migrations in dry-run → switch → health check → auto-rollback on failure. Downgrade supported only within migration-reversible window; otherwise restore from backup. Update checks are **opt-in network calls** (SEC-2); manual/offline update path documented.

## 7. Reproducible builds & provenance
Lockfile-pinned, hermetic CI, SLSA provenance, SBOM (CycloneDX), reproducible-build target for Gateway tarball (verified by second builder). Foundation holds release signing root key offline (threshold signing **[Proposed]**).

## 8. Environments & infra
GitHub Actions (default **[Q-12]**), self-hosted macOS runners for Apple builds, Android emulator farm (managed or self-hosted).

## 9. Acceptance
Dry-run release of a no-op version from clean checkout reproduces identical artifacts; qualification failure demonstrably blocks credential decryption; rollback drill passes.
