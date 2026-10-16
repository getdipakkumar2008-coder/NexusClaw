import { BRAND } from "@clawnexus/brand";
import { CURRENT_CONFIG_VERSION } from "@clawnexus/config";
import { PROTOCOL_VERSION } from "@clawnexus/protocol";
import { SDK_VERSION } from "@clawnexus/plugin-sdk";

export { Gateway, startGateway, ensureGatewayToken, type GatewayOptions } from "./server.js";

/** Versions this build speaks; used by `status` tooling and tests. */
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
