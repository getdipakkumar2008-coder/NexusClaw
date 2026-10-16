# ClawNexus (working name)

A self-hostable personal AI assistant platform: one local Gateway owns your sessions, tools and messaging-channel connections; CLI, web, and native apps are clients; models and agent harnesses are plugins. State, memory and credentials stay on your hardware.

**Status: Phase 0 (foundations). Nothing is usable yet.** The planning documents are in [`docs/`](docs/README.md); start with `docs/10-roadmap.md`.

> The project name is provisional (docs/11 Q-16/Q-19). Names live in `packages/brand` and the `@clawnexus` package scope.

## Repository layout
```
packages/   brand, protocol, plugin-sdk, cli     shared packages and clients
src/        config, gateway                       core (the Gateway control plane)
extensions/ (empty)                               channels, providers, tools as plugins
apps/       (empty)                               native companion apps (later phases)
docs/       requirements, architecture, ADRs, security, roadmap
tools/      repo checks (boundaries self-test, licence gate)
spikes/     throwaway Phase 0 experiments
```

## Develop
```
pnpm install
pnpm check:all
```
Requires Node >= 22 and pnpm 9. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security and privacy
[SECURITY.md](SECURITY.md) · [PRIVACY.md](PRIVACY.md) (no telemetry) · threat model in `docs/06-security-threat-model.md`.

## License
Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). This project is an independent, clean-room implementation of its functionality; see `docs/12-clean-room-and-ip-policy.md`.
