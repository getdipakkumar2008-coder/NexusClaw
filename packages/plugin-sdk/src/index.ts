import { z } from "zod";

/** Semver of this SDK. Only symbols exported here are public API (docs/04 section 4). */
export const SDK_VERSION = "0.1.0";

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

export interface PluginContext {
  readonly pluginId: string;
  log: (level: "debug" | "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => void;
}

export interface PluginDefinition {
  setup(ctx: PluginContext): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export function definePlugin(def: PluginDefinition): PluginDefinition {
  return def;
}
