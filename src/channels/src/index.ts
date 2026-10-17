export { ChannelManager, ChannelFileError, chunkText, type ChannelInfo, type ChannelManagerOptions } from "./manager.js";
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
  type OutboundFile,
  type SendResult,
  type SendTarget,
} from "./types.js";
export { WebChatAdapter, WEBCHAT_ID, senderIdOf, type WebChatOptions } from "./webchat.js";
export { Outbox, type OutboxFile, type OutboxRow, type OutboxOptions } from "./outbox.js";
