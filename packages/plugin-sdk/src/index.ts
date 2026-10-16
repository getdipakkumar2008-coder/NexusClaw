import { z } from "zod";

/** Semver of this SDK. Only symbols exported here are public API (docs/04 section 4). */
export const SDK_VERSION = "0.3.0";

export const pluginKindSchema = z.enum(["code", "bundle"]);

/** Secret names are short and lowercase so they can be stored as `plugin.<id>.<name>` in the vault. */
export const SECRET_NAME = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/, "secret names are lowercase letters, digits, underscore and dash");
const SETTING_NAME = z.string().regex(/^[a-z][A-Za-z0-9_]{0,39}$/, "setting names are letters and digits, starting with a lowercase letter");

export const permissionsSchema = z.strictObject({
  network: z.array(z.string()).default([]),
  fs: z.array(z.string()).default([]),
  exec: z.boolean().default(false),
  /** Secrets this plugin needs. The owner stores them; the plugin reads them with `ctx.secrets.get`. All are required. */
  secrets: z.array(SECRET_NAME).max(16).default([]),
});

/** Plugin manifest (docs/04 section 3). Strict: unknown keys are errors, never silently ignored. */
export const manifestSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/, "id must be lowercase letters, digits, dashes"),
    name: z.string().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, "version must be semver"),
    kind: pluginKindSchema,
    sdkRange: z.string().regex(/^\^\d+\.\d+\.\d+$/, "sdkRange must be a caret range like ^1.0.0"),
    entry: z.string().min(1).optional(),
    provides: z.array(z.string().regex(/^(channel|tool|provider|skill|mcp|hook):[a-z0-9._-]+$/)).default([]),
    permissions: permissionsSchema.default({ network: [], fs: [], exec: false, secrets: [] }),
    /** Settings the owner can change, declared with the same small vocabulary tool arguments use. The host validates them. */
    configSchema: z
      .record(SETTING_NAME, z.lazy(() => argSpecSchema))
      .refine((c) => Object.keys(c).length <= 32, "at most 32 settings")
      .optional(),
  })
  .superRefine((m, ctx) => {
    if (m.kind === "code" && !m.entry) {
      ctx.addIssue({ code: "custom", path: ["entry"], message: "code plugins require an entry" });
    }
    if (m.kind === "bundle" && m.entry) {
      ctx.addIssue({ code: "custom", path: ["entry"], message: "bundle plugins must not declare code" });
    }
    if (m.kind === "bundle" && m.permissions.exec) {
      ctx.addIssue({ code: "custom", path: ["permissions", "exec"], message: "bundle plugins cannot request exec" });
    }
  });

export type PluginManifest = z.infer<typeof manifestSchema>;

function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Caret-range check against the running SDK: same major and not newer than the host.
 * For 0.x versions the minor must match (npm caret semantics).
 */
export function sdkRangeSatisfied(range: string, host: string = SDK_VERSION): boolean {
  const want = parseVersion(range.replace(/^\^/, ""));
  const have = parseVersion(host);
  if (!want || !have) return false;
  const [wM, wm, wp] = want;
  const [hM, hm, hp] = have;
  if (wM !== hM) return false;
  if (wM === 0 && wm !== hm) return false;
  if (hm !== wm) return hm > wm;
  return hp >= wp;
}

/** Upper bounds the host enforces on everything a plugin declares. They protect the model's context and the Gateway. */
export const LIMITS = {
  toolsPerPlugin: 32,
  argsPerTool: 16,
  descriptionChars: 500,
  stringMax: 65_536,
  enumValues: 64,
  resultBytes: 256 * 1024,
  toolTimeoutMs: 120_000,
} as const;

const argBase = { description: z.string().max(200).optional(), optional: z.boolean().optional() };

/**
 * One argument of a plugin tool. Deliberately small: the host builds a strict validator from this, so arguments are
 * checked before the plugin ever sees them, and the same declaration becomes the model's input schema.
 */
export const argSpecSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("string"),
    maxLength: z.number().int().min(1).max(LIMITS.stringMax).optional(),
    enum: z.array(z.string().max(200)).min(1).max(LIMITS.enumValues).optional(),
    ...argBase,
  }),
  z.strictObject({ type: z.literal("integer"), min: z.number().int().optional(), max: z.number().int().optional(), ...argBase }),
  z.strictObject({ type: z.literal("number"), min: z.number().finite().optional(), max: z.number().finite().optional(), ...argBase }),
  z.strictObject({ type: z.literal("boolean"), ...argBase }),
]);
export type ArgSpec = z.infer<typeof argSpecSchema>;

/** What a plugin tells the host about a tool (plain data; the function stays inside the plugin process). */
export const toolRegistrationSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "tool names are lowercase letters, digits and underscores"),
  description: z.string().min(1).max(LIMITS.descriptionChars),
  /** Declared risk. The host never goes below what the manifest's permissions imply. */
  risk: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(0),
  args: z
    .record(z.string().regex(/^[a-z][A-Za-z0-9_]{0,39}$/), argSpecSchema)
    .refine((a) => Object.keys(a).length <= LIMITS.argsPerTool, `at most ${LIMITS.argsPerTool} arguments`)
    .default({}),
  timeoutMs: z.number().int().min(100).max(LIMITS.toolTimeoutMs).optional(),
});
export type ToolRegistration = z.infer<typeof toolRegistrationSchema>;

export interface PluginToolDefinition extends z.input<typeof toolRegistrationSchema> {
  /** Runs inside the plugin process. The result must be JSON-serialisable. `signal` aborts on timeout or cancel. */
  run(args: Record<string, unknown>, call: { signal: AbortSignal }): unknown | Promise<unknown>;
}

export interface PluginContext {
  readonly pluginId: string;
  log: (level: "debug" | "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => void;
  /** Directory this plugin may read and write, present only if the manifest asked for `data` access. */
  readonly dataDir: string | undefined;
  /** The owner's settings for this plugin, already checked against `configSchema`. Frozen. */
  readonly config: Readonly<Record<string, string | number | boolean>>;
  /** Secrets the owner stored for the names in `permissions.secrets`. Any other name reads as undefined. */
  readonly secrets: { get(name: string): string | undefined };
  /** Register a tool. Only possible during `setup`. */
  registerTool(def: PluginToolDefinition): void;
  /** Register the messaging channel this plugin provides: one per plugin, and the manifest must list `channel:<id>` in `provides`. Only possible during `setup`. */
  registerChannel(def: PluginChannelDefinition): void;
}

export interface PluginDefinition {
  setup(ctx: PluginContext): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export function definePlugin(def: PluginDefinition): PluginDefinition {
  return def;
}

// ---------------------------------------------------------------------------------------------------------------
// Channels. A channel plugin connects the assistant to a messaging platform. It runs inside the plugin process, and
// the Gateway's router does everything that matters for safety (who may talk, groups, rate limits, replies), so a
// channel only translates between the platform and these few calls.
// ---------------------------------------------------------------------------------------------------------------

export const channelRegistrationSchema = z.strictObject({
  /** Must match a `channel:<id>` entry in the manifest's `provides`. */
  id: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/, "channel ids are lowercase letters, digits and dashes"),
  capabilities: z.strictObject({
    typing: z.boolean(),
    groups: z.boolean(),
    maxTextChars: z.number().int().min(1).max(100_000),
  }),
});
export type ChannelRegistration = z.infer<typeof channelRegistrationSchema>;

export const channelStatusSchema = z.strictObject({
  state: z.enum(["starting", "connected", "degraded", "auth_required", "stopped"]),
  detail: z.string().max(200).optional(),
});
export type PluginChannelStatus = z.infer<typeof channelStatusSchema>;

/** Where a reply goes. The router fills this in from the message it is answering. */
export interface ChannelTarget {
  accountId: string;
  conversationId: string;
  /** Platform id of the message being answered, when the platform can thread replies. */
  replyTo?: string;
}

/** One inbound message. The channel id is added by the Gateway; a plugin cannot speak for another channel. */
export interface ChannelInbound {
  /** Which of your accounts received it (use "default" when there is only one). Letters, digits, dot, dash, underscore. */
  accountId: string;
  conversationId: string;
  senderId: string;
  senderDisplay?: string;
  /** The platform's id for this message. Used to ignore duplicates, so make it stable across redelivery. */
  messageId: string;
  text: string;
  replyTo?: string;
  isGroup: boolean;
  mentionsBot: boolean;
  ts?: number;
}

export type ChannelOutcome =
  | { result: "accepted"; sessionId: string; runId: string }
  | { result: "pairing" | "duplicate" | "limited" | "busy" | "unavailable" }
  | { result: "ignored" | "invalid"; reason: string };

/** What a channel can call on the Gateway. */
export interface PluginChannelHost {
  /** Hand over one inbound message. Resolves with what the Gateway did with it. */
  deliver(message: ChannelInbound): Promise<ChannelOutcome>;
  /** Report health. Shown to the owner. Never put secrets in it. */
  setStatus(status: PluginChannelStatus): void;
}

export interface PluginChannelDefinition extends ChannelRegistration {
  /** Connect to the platform and begin delivering messages. Reject to report that it could not start. */
  start(host: PluginChannelHost): void | Promise<void>;
  /** Disconnect. Called before the plugin process ends. */
  stop(): void | Promise<void>;
  /** Send text to a conversation. The Gateway already splits it to `maxTextChars`; throw to have it retried. */
  send(target: ChannelTarget, content: { text: string }): { messageId?: string } | void | Promise<{ messageId?: string } | void>;
  typing?(target: ChannelTarget, on: boolean): void | Promise<void>;
}
