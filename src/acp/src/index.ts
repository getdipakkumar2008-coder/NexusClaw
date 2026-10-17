export { AcpConnection, AcpError, ACP_PROTOCOL_VERSION, scrub, mcpServerOf, type AcpConnectionOptions, type McpServerSpec, type PermissionAnswer, type PermissionInfo } from "./client.js";
export { AcpProvider, buildPrompt, externalHeader, type AcpProviderOptions, type ToolBridge } from "./provider.js";
export { HARNESS_NAMES, PRESETS, HarnessError, planLaunch, resolveSpec, type HarnessConfig, type HarnessName, type HarnessSpec, type LaunchPlan } from "./harnesses.js";
export { runMcpServer, MCP_VERSIONS, type McpBackend, type McpServerOptions, type McpTool } from "./mcp.js";
export { GatewayToolBackend, mcpName, type GatewayCaller, type ToolBridgeOptions } from "./toolbridge.js";
export { JsonRpcPeer, RpcError, RPC } from "./jsonrpc.js";
export { buildBlocks, describeRef, MAX_INLINE_TEXT, type PromptBlock, type PromptCaps } from "./attachments.js";
