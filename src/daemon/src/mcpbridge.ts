import { GatewayToolBackend, runMcpServer } from "@clawnexus/acp";
import { GatewayClient } from "@clawnexus/cli";

export const BRIDGE_ENV = { url: "CLAWNEXUS_BRIDGE_URL", token: "CLAWNEXUS_BRIDGE_TOKEN", waitSeconds: "CLAWNEXUS_BRIDGE_WAIT_S" } as const;

/**
 * `clawnexus mcp-bridge`: started by the model's harness (not by a person) to give the model the Gateway's tools.
 * stdout carries only protocol messages. The credential arrives in the environment, is valid for one chat
 * session, and only allows listing and calling tools under the owner's policy.
 */
export async function runMcpBridge(env: NodeJS.ProcessEnv, stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream, stderr: (s: string) => void): Promise<number> {
  const url = env[BRIDGE_ENV.url];
  const token = env[BRIDGE_ENV.token];
  if (!url || !token) {
    stderr("mcp-bridge is started by a model harness and needs a bridge credential from the Gateway; it is not meant to be run by hand.\n");
    return 2;
  }
  let gateway: GatewayClient;
  try {
    gateway = await GatewayClient.connect(url, token);
  } catch (e) {
    stderr(`mcp-bridge could not reach the Gateway: ${e instanceof Error ? e.message : "unknown error"}\n`);
    return 1;
  }
  const wait = Number(env[BRIDGE_ENV.waitSeconds]);
  const backend = new GatewayToolBackend(gateway, Number.isFinite(wait) && wait > 0 ? { approvalWaitMs: wait * 1000 } : {});
  const server = runMcpServer({ input: stdin as never, output: stdout as never, backend, name: "clawnexus", version: "0.0.0" });
  gateway.onClose(() => server.close());
  await server.done;
  gateway.close();
  return 0;
}
