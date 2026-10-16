import { BRAND } from "@clawnexus/brand";
import { PROTOCOL_VERSION } from "@clawnexus/protocol";

/**
 * Phase 0 placeholder CLI. It demonstrates the client rule (FR-GW-2): clients import only
 * `packages/*` (protocol, brand), never Gateway internals under `src/`. Enforced by `check:boundaries`.
 */
export function versionLine(): string {
  return `${BRAND.cli} (protocol ${PROTOCOL_VERSION.major}.${PROTOCOL_VERSION.minor})`;
}
