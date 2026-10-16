# Security Policy

Security is the project's first priority (docs/06).

## Reporting a vulnerability
Please do **not** open a public issue. Report privately using the repository's private vulnerability reporting (GitHub "Report a vulnerability") once the repository is public. Until then, contact the maintainers listed in `MAINTAINERS.md`. <!-- TODO(owner): add a monitored security contact address before going public. -->

Include: affected version/commit, impact, reproduction steps, and whether you want credit.

## What to expect
- Acknowledgement within 3 business days.
- Triage and severity assessment within 7 days.
- A fix or mitigation plan, coordinated disclosure, default 90 days from report (shorter for actively exploited issues).
- Credit in the advisory unless you prefer anonymity.

## Scope
In scope: the Gateway, protocol, policy/pairing/vault code, plugin host and SDK, official channels and apps, the relay, and release/signing infrastructure. Out of scope: vulnerabilities in third-party platforms or in plugins not published by the project (report those to their authors; we can help coordinate).

## Safe harbour
Good-faith research that avoids privacy violations, data destruction and service degradation will not be pursued.

## Supported versions
Pre-1.0: only the latest commit on `main` is supported.
