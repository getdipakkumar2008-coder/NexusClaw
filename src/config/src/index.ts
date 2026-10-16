import { BRAND } from "@clawnexus/brand";
import { CURRENT_CONFIG_VERSION, configSchema, type Config } from "./schema.js";
import { migrate, versionOf, type MigrationResult } from "./migrate.js";
import { migrations } from "./migrations.js";

export { CURRENT_CONFIG_VERSION, configSchema, isLoopback, type Config } from "./schema.js";
export { assertChain, migrate, versionOf, MigrationError, type Migration, type MigrationResult } from "./migrate.js";
export { migrations } from "./migrations.js";

export type ValidateResult = { ok: true; config: Config } | { ok: false; stale: boolean; problems: string[] };

/**
 * Validate a raw config. Stale configs (older version) are reported as such, never silently accepted:
 * the operator is told to run `doctor --fix` (FR-DX-1/2).
 */
export function validateConfig(raw: unknown): ValidateResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, stale: false, problems: ["config must be a JSON object"] };
  }
  const obj = raw as Record<string, unknown>;
  const version = versionOf(obj);
  if (version < CURRENT_CONFIG_VERSION) {
    return {
      ok: false,
      stale: true,
      problems: [
        `config is version ${version}, current is ${CURRENT_CONFIG_VERSION}. Run \`${BRAND.cli} doctor --fix\` to migrate it.`,
      ],
    };
  }
  const parsed = configSchema.safeParse(obj);
  if (parsed.success) return { ok: true, config: parsed.data };
  return {
    ok: false,
    stale: false,
    problems: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  };
}

/** What `doctor --fix` runs for config: migrate then re-validate; returns the new config and what changed. */
export function fixConfig(raw: Record<string, unknown>): { result: MigrationResult; validation: ValidateResult } {
  const result = migrate(raw, migrations, CURRENT_CONFIG_VERSION);
  return { result, validation: validateConfig(result.config) };
}
