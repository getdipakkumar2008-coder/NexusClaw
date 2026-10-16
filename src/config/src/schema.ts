import { z } from "zod";

/** Current on-disk config schema version. Bump together with a migration (docs/08 section 5). */
export const CURRENT_CONFIG_VERSION = 1;

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
export const isLoopback = (host: string): boolean => LOOPBACK.has(host);

/**
 * Strict config. Unknown or stale keys are errors (FR-DX-1). Secrets never live here, only references.
 * Keep this small: every key is paid for by every operator (surface-budget.json).
 */
export const configSchema = z
  .strictObject({
    configVersion: z.literal(CURRENT_CONFIG_VERSION),
    dataDir: z.string().min(1).optional(),
    gateway: z
      .strictObject({
        bind: z.string().min(1).default("127.0.0.1"),
        port: z.number().int().min(1).max(65535).default(7391),
        tls: z.strictObject({ enabled: z.boolean().default(false) }).default({ enabled: false }),
        auth: z.strictObject({ required: z.boolean().default(true) }).default({ required: true }),
        insecureAcknowledged: z.boolean().default(false),
      })
      .default({
        bind: "127.0.0.1",
        port: 7391,
        tls: { enabled: false },
        auth: { required: true },
        insecureAcknowledged: false,
      }),
    security: z
      .strictObject({
        profile: z.enum(["standard", "locked-down", "trusted"]).default("standard"),
      })
      .default({ profile: "standard" }),
    /** The model runtime: an ACP harness we launch as a child process. Absent = no model configured. */
    provider: z
      .strictObject({
        harness: z.enum(["claude", "codex", "cursor", "gemini", "custom"]),
        command: z.string().min(1).max(500).optional(),
        args: z.array(z.string().max(500)).max(32).optional(),
        /** Names (not values) of environment variables to pass to the harness, e.g. an API key. */
        env: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(16).optional(),
      })
      .optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.provider?.harness === "custom" && !cfg.provider.command) {
      ctx.addIssue({ code: "custom", path: ["provider", "command"], message: "provider.harness \"custom\" needs provider.command." });
    }
    // SEC-6: never listen beyond loopback without both TLS and auth, unless explicitly acknowledged.
    const g = cfg.gateway;
    if (!isLoopback(g.bind) && !g.insecureAcknowledged && !(g.tls.enabled && g.auth.required)) {
      ctx.addIssue({
        code: "custom",
        path: ["gateway", "bind"],
        message:
          "Binding beyond loopback requires gateway.tls.enabled=true and gateway.auth.required=true " +
          "(or set gateway.insecureAcknowledged=true to accept the risk).",
      });
    }
  });

export type Config = z.infer<typeof configSchema>;
