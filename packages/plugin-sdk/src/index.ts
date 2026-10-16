import { z } from "zod";

/** Semver of this SDK. Only symbols exported here are public API (docs/04 section 4). */
export const SDK_VERSION = "0.2.0";

export const pluginKindSchema = z.enum(["code", "bundle"]);

export const permissionsSchema = z.strictObject({
  network: z.array(z.string()).default([]),
  fs: z.array(z.string()).default([]),
  exec: z.boolean().default(false),
  secrets: z.array(z.string()).default([]),
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
    configSchema: z.record(z.string(), z.unknown()).optional(),
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
  /** Register a tool. Only possible during `setup`. */
  registerTool(def: PluginToolDefinition): void;
}

export interface PluginDefinition {
  setup(ctx: PluginContext): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export function definePlugin(def: PluginDefinition): PluginDefinition {
  return def;
}
