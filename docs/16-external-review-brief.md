# 16. External review brief (WP13)

**Status: prepared, not yet carried out.** An external review has to be done by people outside the project; nothing in
this repository can stand in for it. This document is what to hand them, so that a review takes days rather than weeks
and finds problems rather than re-discovering the design. Everything below was written by the maintainers' tooling and is
the project's own view of itself; the reviewer should treat it as claims to test, not as findings.

## 1. What we are asking for

A security review of the parts whose failure would hurt a user most, in this order:

1. **Tool policy and approvals** (`src/policy`, `src/tools`): can a person who is not the owner, or text the owner's
   assistant has read, cause a tool with side effects to run?
2. **Pairing and sender identity** (`src/pairing`, `src/channels`): can a stranger reach the assistant, or become the owner?
3. **The secret vault** (`src/vault`) and where its key lives.
4. **Device sign-in and TLS** (`src/devices`, `packages/protocol/src/device.ts`, `src/daemon/src/tlsinit.ts`, the sign-in
   code in `src/gateway/src/server.ts`): can a device or a network attacker get in, stay in, or impersonate the Gateway?
5. **Files** (`src/blobs`, the attachment path in `src/channels`, `file.send` in `src/gateway/src/filetool.ts`): can a file
   or a file address make the Gateway run something, leak a secret, or send data somewhere it should not go?
6. **The plugin host** (`src/plugins`, `packages/plugin-sdk`): is the sandbox what we say it is?

Out of scope for this round: the companion apps (not built), the relay (not built), the model providers and harnesses
themselves, the third-party platforms (Telegram, Discord, Slack), and denial of service by a person who already holds the
owner's token.

Suggested effort: 8-10 reviewer days. Deliverable: a written report with findings rated by impact, and a re-test of fixes.

## 2. How to build and run

```
node --version          # 22.13 or newer
corepack enable && pnpm install --frozen-lockfile
pnpm check:all          # build, lint, tests, boundaries, licences (about two minutes)
pnpm package && pnpm package:smoke   # builds the installable tarball and uses it from an empty folder
node tools/bench.mjs    # the performance numbers in docs/01
```

A running instance for poking at: `clawnexus setup --fake-provider`, `clawnexus gateway run`, then `clawnexus status`.
`clawnexus doctor --security` lists the choices that matter. Data lives in `~/.clawnexus` (or `--data-dir`).

## 3. Evidence the project already has

| Claim | Where it is checked |
|---|---|
| For every combination of principal, tool risk, profile, taint, sandbox and delegation, a non-owner never reaches a risky tool and an unknown principal or risk is refused | `src/policy/src/invariants.test.ts` (complete enumeration, 1 440 combinations, 12 properties) |
| Every Gateway method has an explicit answer for each kind of caller; adding a method without a row fails the build | `src/gateway/src/authz.test.ts` (reads the method names from the server source) |
| Hostile text and arguments cannot make a guest's session run a tool with side effects, change the workspace, memory or token file, or lift its own trust | `src/gateway/src/injection.test.ts` (corpus of 28 strings x 6 tools, plus smuggled fields and odd tool names) |
| Parsers survive damaged input | `src/gateway/src/fuzz.test.ts`: 1 500 inputs per target on every run, 1 000 000 nightly with a new seed; targets are file sniffing, picture metadata removal, protocol frames, channel messages, transcript import, config, device signatures and live WebSocket garbage |
| Approvals are single-use, expire, are bound to the exact arguments and the conversation, and only the owner decides | `src/policy/src/approval.test.ts`, `src/gateway/src/memory.test.ts` |
| Sender identity cannot be claimed by a plugin or a message | `src/channels/src/conformance.ts` (every channel runs it) |
| Channel plugins send tokens only to the platform's hosts and never write them to the log | `src/plugins/src/{telegram,discord,slack}.test.ts` |
| Performance targets | `tools/bench.mjs` (section 6) |
| Dependency and code scanning | `pnpm audit` and CodeQL (`security-extended`) in CI; dependency review on pull requests |

None of these is a proof. The enumeration and matrix tests are as complete as the code they read; the corpus and the fuzzers
only find what they are taught to look for.

## 4. What we found ourselves (internal pass, fixed)

An internal read-through of policy, pairing and the vault, plus the new tests, found:

1. **An unknown principal got no decision at all.** `decide()` returned `undefined` for a principal it did not know, which the
   caller would have crashed on rather than refused. It now returns an explicit deny. (Found by the enumeration test.)
2. **Approvals were not tied to a conversation.** An approval granted for a call in one chat could be spent on the same
   call in another by the same requester. It is now part of the approval key. The approval ledger also grew without bound;
   finished approvals are dropped after an hour.
3. An earlier pass (not WP13) found that the error-code family `MEMORY` was unknown to clients and silently dropped frames, and
   that an all-zero Ed25519 key with an all-zero signature verified as valid; both are fixed and tested.

## 5. Known weaknesses we have not fixed (please judge these)

- **The vault key is a file** next to the vault (`vault.key`, mode 0600). It protects a copied vault or a backup, not someone
  who can read the user's data folder. On Windows the mode bits do nothing and we rely on the user profile's permissions;
  `doctor --security` does not check them there. The operating-system keychain is the intended fix and is not built.
- **Redaction is by exact value.** A secret that is split across two chunks of streamed output, encoded (base64, URL-encoded),
  or shorter than six characters is not redacted from logs.
- **Plugin network permissions are advisory.** Node's permission model confines file access and child processes, not sockets.
  A plugin you enable can talk to any host. Approval tokens bind the code and the declared permissions, nothing more.
- **A channel plugin vouches for who is writing.** A malicious channel plugin can claim the identifier of a registered owner
  on its own channel. Install only plugins you trust.
- **Pairing can be crowded out.** An attacker with many identities can fill the 20 pending-challenge slots and delay a real
  person's pairing (the owner is not affected). The hourly cap bounds the rate.
- **The Gateway's trust in the model's tool calls is policy, not isolation.** Commands run with the owner's rights once approved;
  there is no sandbox backend yet (the `sandboxed` flag exists in the policy and is always false).
- **Delivery to channels is at-least-once**, so a message can be repeated after a crash.
- **WebChat** has been exercised by a scripted client and a sandboxed script test, not by eye in a real browser.
- **Telegram, Discord and Slack plugins** are tested against fakes only, never live.
- **TLS** uses a certificate the Gateway makes for itself (ECDSA P-256, written by hand in `tlsinit.ts`); clients trust it by
  fingerprint or CA file. The hand-written X.509 encoder is a place we would like a second pair of eyes on.
- **The optional file-check program** (`<data>/hooks/scan`) runs with the owner's rights on files from strangers' messages. It
  is the owner's choice and fails closed, but it is code execution on attacker-supplied data if the program is careless.

## 6. Performance measurement (NFR-PERF-1..3)

`node tools/bench.mjs`, Node 24.18 on Windows 11, 8 logical CPUs, the Gateway in its own process with a fake model and no
channel plugins running:

| Target | Measured |
|---|---|
| Idle memory <= 250 MB | 75 MB |
| Idle CPU <= 2% | 0% |
| Message to first output, p95 <= 150 ms | 10.8 ms (p50 7.8 ms) |
| 50 clients, 20 events per second, p95 delivery <= 200 ms | 15 ms; all 10 000 deliveries arrived |

These are **not yet the numbers the targets are written for**: the targets assume a 2-core VM with five channels running,
which this machine is not and this run did not have. The nightly job runs the same script on a 4-vCPU Linux runner and fails on
a miss. Memory with five real channel plugins (each a Node process of roughly 40-60 MB) will be well above the idle figure and
should be measured before the 250 MB target is called met; we expect the *Gateway process* to meet it and the sum to be close.

## 7. Questions we would like answered

1. Is the policy table in `decide.ts` the right shape? Specifically: is "risk 2 for the owner is allowed on the trusted profile
   in a clean context" safe enough, given that the model may have been steered by something we cannot see?
2. Is binding an approval to tool + canonical arguments + conversation enough, or should it also carry the principal's trust
   state at the time of the request?
3. Is the one-time device pairing code (10 characters, 5 minutes, hashed in memory, 10 wrong guesses cancel all codes) strong
   enough for a code typed on a phone and read aloud?
4. Does the device lease (15 minutes, renewed by a new signature) leave a window that matters after a revocation?
5. In `file.send`, is "no destination argument, owner approval, workspace or conversation files only" enough to stop a
   steered model from exfiltrating a private file to the person on the other end of a chat?
6. Does the plugin approval token (bound to code hash and permissions) survive a plugin that changes behaviour by fetching code
   at run time?
7. Anything in the WebSocket upgrade, Host-header and Origin handling (`server.ts`, `webchat.ts`) that lets a web page in the
   owner's browser reach the Gateway?

## 8. Reporting and disclosure

Report privately per `SECURITY.md`. Please give us 90 days before publishing. We will credit reviewers who want credit. Findings
become regression tests (docs/06 section 8) and appear in the release notes of the version that fixes them.

## 9. Owner actions that gate the review

- Choose and publish the security contact in `SECURITY.md` and `CODEOWNERS` (currently placeholders).
- Decide who pays for, and who chooses, the reviewer (docs/06 section 8 budgets "quarterly external review", proposed).
- Freeze a tag to review, so that findings refer to fixed code.
