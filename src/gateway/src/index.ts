import { BRAND } from "@clawnexus/brand";
import { CURRENT_CONFIG_VERSION } from "@clawnexus/config";
import { PROTOCOL_VERSION } from "@clawnexus/protocol";
import { SDK_VERSION } from "@clawnexus/plugin-sdk";

/**
 * Phase 0 placeholder for the Gateway control plane. It exists to prove the workspace wiring and the
 * dependency direction (gateway may depend on protocol, config and plugin-sdk; never the reverse).
 * No server is started here; the real implementation begins in Phase 1.
 */
export function gatewayInfo(): {
  name: string;
  protocol: string;
  configVersion: number;
  sdkVersion: string;
} {
  return {
    name: BRAND.name,
    protocol: `${PROTOCOL_VERSION.major}.${PROTOCOL_VERSION.minor}`,
    configVersion: CURRENT_CONFIG_VERSION,
    sdkVersion: SDK_VERSION,
  };
}
