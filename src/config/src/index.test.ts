import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CURRENT_CONFIG_VERSION,
  MigrationError,
  assertChain,
  configSchema,
  fixConfig,
  migrate,
  migrations,
  validateConfig,
} from "./index.js";

describe("validateConfig", () => {
  it("accepts a minimal current config and fills secure defaults", () => {
    const r = validateConfig({ configVersion: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.gateway.bind).toBe("127.0.0.1");
      expect(r.config.gateway.auth.required).toBe(true);
      expect(r.config.security.profile).toBe("standard");
    }
  });

  it("rejects unknown keys loudly (no silent acceptance)", () => {
    const r = validateConfig({ configVersion: 1, gatway: {} });
    expect(r.ok).toBe(false);
  });

  it("reports stale configs and points at doctor --fix", () => {
    const r = validateConfig({ host: "127.0.0.1" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stale).toBe(true);
      expect(r.problems[0]).toMatch(/doctor --fix/);
    }
  });

  it("refuses non-loopback bind without TLS + auth (SEC-6)", () => {
    expect(validateConfig({ configVersion: 1, gateway: { bind: "0.0.0.0" } }).ok).toBe(false);
    expect(validateConfig({ configVersion: 1, gateway: { bind: "0.0.0.0", tls: { enabled: true } } }).ok).toBe(true);
    expect(
      validateConfig({ configVersion: 1, gateway: { bind: "0.0.0.0", tls: { enabled: true }, auth: { required: false } } }).ok,
    ).toBe(false);
    expect(validateConfig({ configVersion: 1, gateway: { bind: "0.0.0.0", insecureAcknowledged: true } }).ok).toBe(true);
  });

  it("rejects non-objects", () => {
    expect(validateConfig(null).ok).toBe(false);
    expect(validateConfig([]).ok).toBe(false);
  });
});

describe("migrations", () => {
  it("form a gapless chain to the current version (CI guard)", () => {
    expect(() => assertChain(migrations, CURRENT_CONFIG_VERSION)).not.toThrow();
  });

  it("detects a broken chain", () => {
    expect(() => assertChain([], CURRENT_CONFIG_VERSION)).toThrow(MigrationError);
  });

  it("migrates a legacy config and the result validates", () => {
    const legacy = { host: "127.0.0.1", port: 9000 };
    const { result, validation } = fixConfig(legacy);
    expect(result.applied).toHaveLength(1);
    expect(validation.ok).toBe(true);
    if (validation.ok) expect(validation.config.gateway.port).toBe(9000);
    expect(legacy).toEqual({ host: "127.0.0.1", port: 9000 }); // input untouched
  });

  it("is idempotent", () => {
    const once = fixConfig({ host: "127.0.0.1" }).result.config;
    const twice = migrate(once, migrations, CURRENT_CONFIG_VERSION);
    expect(twice.applied).toHaveLength(0);
    expect(twice.config).toEqual(once);
  });

  it("refuses configs from the future", () => {
    expect(() => migrate({ configVersion: 99 }, migrations, CURRENT_CONFIG_VERSION)).toThrow(/newer/);
  });
});

describe("schema snapshot (breaking-change guard)", () => {
  it("matches the committed snapshot; changing the schema requires updating it AND adding a migration", () => {
    const current = z.toJSONSchema(configSchema);
    const snapshotPath = fileURLToPath(new URL("../../../src/config/schema.snapshot.json", import.meta.url));
    const committed = JSON.parse(readFileSync(snapshotPath, "utf8")) as unknown;
    expect(current).toEqual(committed);
  });
});

describe("surface budget (docs/04 section 1)", () => {
  function countKeys(schema: unknown): number {
    const s = schema as { properties?: Record<string, unknown> };
    if (!s.properties) return 0;
    return Object.values(s.properties).reduce<number>((n, child) => {
      const sub = countKeys(child);
      return n + (sub === 0 ? 1 : sub);
    }, 0);
  }

  it("keeps config key count within surface-budget.json", () => {
    const budgetPath = fileURLToPath(new URL("../../../surface-budget.json", import.meta.url));
    const budget = JSON.parse(readFileSync(budgetPath, "utf8")) as { maxConfigKeys: number };
    expect(countKeys(z.toJSONSchema(configSchema))).toBeLessThanOrEqual(budget.maxConfigKeys);
  });
});
