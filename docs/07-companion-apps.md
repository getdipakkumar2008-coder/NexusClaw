# 07 — Native Companion Apps

## 1. Principle
One assistant, every surface. Apps are **thin native clients** of the Gateway protocol (`packages/protocol`); no app holds authoritative state. Genuinely native UI (no web wrappers); share only narrow native modules.

## 2. Platform matrix
| Platform | Stack | Phase | Notes |
|---|---|---|---|
| Android | Kotlin + Jetpack Compose | 2 | First mobile target (no store-review friction, E2E automation easier) |
| macOS | Swift + SwiftUI (menu-bar + window) | 2 | Also hosts iMessage bridge option |
| iOS | Swift + SwiftUI | 3 | App Attest, APNs |
| Windows | **[Q-9]** WinUI 3 (C#) or native Rust+Win32 UI | 3 | req says "native"; stack unspecified |
| Linux | **[Q-9]** GTK4 (Rust/Vala) or Qt | 3 | Packaging: Flatpak/deb/AppImage |
| watchOS | SwiftUI; **Rust for Watch RTC** (per req) | 4 | Companion of iOS |
| Wear OS | Kotlin Compose for Wear | 4 | |

Shared native modules (narrow): Mermaid renderer, WebRTC wrapper, protocol client codegen (from JSON Schema → Swift/Kotlin types). No shared UI code.

## 3. Common capabilities (FR-APP-*)
| ID | Capability | Acceptance |
|---|---|---|
| FR-APP-1 | Pair via QR / setup code | Pairing ≤ 30 s; code expires 5 min; verifies gateway fingerprint; stored in Keychain/Keystore |
| FR-APP-2 | Streaming chat with markdown, code, attachments | Smooth at 60 fps on mid devices; resumes after reconnect without duplicate/missing messages |
| FR-APP-3 | Voice "Talk" (push-to-talk + hands-free), STT/TTS | On-device STT optional; latency target: speech end → first audio ≤ 1.5 s (excl. model) **[Proposed]** |
| FR-APP-4 | Device actions: camera, screen capture, location, notifications | Each requires OS permission + in-app consent; visible indicator; audit |
| FR-APP-5 | Approvals UI (tool calls) with clear risk class and exact args | Approve/deny in ≤2 taps; biometric option for R3/R4 |
| FR-APP-6 | Shared visual language: tool icons, folding of completed work, status chips | Design tokens shared from one spec; visual regression tests |
| FR-APP-7 | "Review changes" diff viewer (unified/split, syntax highlight) | Handles 5k-line diffs without jank |
| FR-APP-8 | Offline/poor network behaviour | Queue outgoing, clear state banner, auto-resume |
| FR-APP-9 | Multi-gateway profiles | Switch without re-pair |
| FR-APP-10 | Push notifications via relay (opt-in) | Works with official & self-hosted relay; E2E decrypt on device |
| FR-APP-11 | Accessibility | Screen reader, dynamic type, contrast; verified by platform audits |
| FR-APP-12 | Settings: revoke device, view audit, privacy toggles | |

## 4. Design system
Single design spec (tokens: colour, type, spacing, iconography, motion) in `/docs/design` → generated to Swift/Kotlin/CSS. Tool-icon set mapped to tool ids; plugin tools may supply an icon from a constrained set.

## 5. Device action consent model
- Default **ask every time**; user may grant "allow for this session" or "always for this tool" per action kind, revocable.
- No background capture; screen/camera require foreground or OS-sanctioned indicator.
- Location precision selectable (coarse/fine).
- Every request/result logged in Gateway audit and shown in the app.

## 6. Security specifics
Keys in Secure Enclave/StrongBox where available; certificate pinning to Gateway fingerprint; jailbreak/root signals advisory only; no analytics SDKs; third-party SDKs prohibited unless reviewed (NFR: zero tracking deps, CI check).

## 7. Release (see `08`)
Fastlane lanes per platform; signing assets in encrypted store (match-style) — credentials only released **after** E2E qualification passes.

## 8. Acceptance
Per-app E2E qualification suite run against pinned Gateway fixtures (`03 §10`): pair → chat → approval → device action → reconnect. Store-review checklist per platform. Accessibility audit passed. Crash-free sessions measured via opt-in only/Store consoles (no embedded telemetry).

## 9. Effort & risk
Largest cost centre. Recommend one platform owner each; ship Android+macOS first; defer watch/wear. Risk: App Store review of "AI + arbitrary host control"; mitigate with clear consent UX and documentation.
