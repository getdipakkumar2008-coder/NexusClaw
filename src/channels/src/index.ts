export { ChannelManager, chunkText, type ChannelInfo, type ChannelManagerOptions } from "./manager.js";
export { defineConformance, CONFORMANCE_LIMITS, type ConformanceBed, type ConformanceSetup, type ConformanceUser, type TestApi } from "./conformance.js";
export { createBed, FakeAdapter, waitFor, type Bed, type BedOptions } from "./testing.js";
export {
  ADAPTER_ID,
  DEFAULT_POLICY,
  inboundSchema,
  type ChannelAdapter,
  type ChannelCapabilities,
  type ChannelHost,
  type ChannelPolicy,
  type ChannelState,
  type ChannelStatus,
  type InboundMessage,
  type InboundOutcome,
  type OutboundContent,
  type SendResult,
  type SendTarget,
} from "./types.js";
export { WebChatAdapter, WEBCHAT_ID, senderIdOf, type WebChatOptions } from "./webchat.js";
