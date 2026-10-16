import { copyFileSync, existsSync, fsyncSync, closeSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { BRAND } from "@clawnexus/brand";
import { validateConfig, fixConfig, type Config } from "@clawnexus/config";

export const configPath = (dataDir: string): string => join(dataDir, BRAND.configFile);

export type LoadedConfig =
  | { state: "missing"; config: Config }
  | { state: "ok"; config: Config; raw: Record<string, unknown> }
  | { state: "stale" | "invalid" | "unreadable"; problems: string[]; raw?: Record<string, unknown> };

/** Defaults come from the schema itself, so there is one source of truth. */
export function defaultConfig(): Config {
  const r = validateConfig({ configVersion: 1 });
  if (!r.ok) throw new Error(`built-in default config is invalid: ${r.problems.join("; ")}`);
  return r.config;
}

export function loadConfig(dataDir: string): LoadedConfig {
  const path = configPath(dataDir);
  if (!existsSync(path)) return { state: "missing", config: defaultConfig() };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { state: "unreadable", problems: [`${path} is not valid JSON (${e instanceof Error ? e.message : "parse error"})`] };
  }
  const v = validateConfig(raw);
  if (v.ok) return { state: "ok", config: v.config, raw: raw as Record<string, unknown> };
  return { state: v.stale ? "stale" : "invalid", problems: v.problems, ...(typeof raw === "object" && raw !== null && !Array.isArray(raw) ? { raw: raw as Record<string, unknown> } : {}) };
}

/** Write via a temp file and rename so a crash never leaves a half-written config. */
export function writeConfig(dataDir: string, value: unknown): void {
  const path = configPath(dataDir);
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** Migrate a stale config in place, keeping the old file as `config.json.bak`. */
export function migrateConfigFile(dataDir: string, raw: Record<string, unknown>): { ok: boolean; problems: string[] } {
  const { result, validation } = fixConfig(raw);
  if (!validation.ok) return { ok: false, problems: validation.problems };
  copyFileSync(configPath(dataDir), `${configPath(dataDir)}.bak`);
  writeConfig(dataDir, validation.config);
  void result;
  return { ok: true, problems: [] };
}
