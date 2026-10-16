export interface Migration {
  from: number;
  to: number;
  description: string;
  up(raw: Record<string, unknown>): Record<string, unknown>;
}

export interface MigrationResult {
  config: Record<string, unknown>;
  applied: Array<{ from: number; to: number; description: string }>;
}

export class MigrationError extends Error {}

/** Version of a raw config object; configs written before versioning existed count as 0. */
export function versionOf(raw: Record<string, unknown>): number {
  const v = raw["configVersion"];
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0;
}

/** Asserts the migration list is a gapless chain 0 -> target (CI guard for FR-DX-2). */
export function assertChain(migrations: readonly Migration[], target: number): void {
  let at = 0;
  for (const m of [...migrations].sort((a, b) => a.from - b.from)) {
    if (m.from !== at || m.to !== at + 1) {
      throw new MigrationError(`migration chain broken at version ${at}: found ${m.from} -> ${m.to}`);
    }
    at = m.to;
  }
  if (at !== target) {
    throw new MigrationError(`migrations reach version ${at}, but current schema version is ${target}`);
  }
}

/** Pure and idempotent: never mutates the input; returns a no-op result when already current. */
export function migrate(
  raw: Record<string, unknown>,
  migrations: readonly Migration[],
  target: number,
): MigrationResult {
  const start = versionOf(raw);
  if (start > target) {
    throw new MigrationError(
      `config version ${start} is newer than this build supports (${target}); upgrade the software`,
    );
  }
  let config: Record<string, unknown> = structuredClone(raw);
  const applied: MigrationResult["applied"] = [];
  for (let v = start; v < target; v++) {
    const step = migrations.find((m) => m.from === v);
    if (!step) throw new MigrationError(`no migration from version ${v}`);
    config = { ...step.up(config), configVersion: step.to };
    applied.push({ from: step.from, to: step.to, description: step.description });
  }
  return { config, applied };
}
