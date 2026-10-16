# ADR-0002: TypeScript, Node 22+, pnpm workspace, ESM, strict

- Status: Accepted (owner approval of defaults, Phase 0)
- Date: 2026-10-16

## Decision
Monorepo in TypeScript (strict, NodeNext ESM) on Node >=22 LTS using pnpm workspaces; Vitest for tests.

## Rationale and consequences
Matches the brief; one language for gateway, CLI, plugins and SDK; large channel-library ecosystem. Cost: native apps are separate stacks.

## References
Root tsconfig.base.json, package.json engines.
