import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { BRAND } from "@clawnexus/brand";
import { CliError } from "@clawnexus/cli";
import { validateConfig } from "@clawnexus/config";
import { ensureGatewayToken } from "@clawnexus/gateway";
import { openDb } from "@clawnexus/store";
import { defaultConfig, loadConfig, writeConfig } from "./configfile.js";

export const HARNESSES: readonly string[] = ["claude", "codex", "cursor", "gemini"];
export const PROFILES = ["standard", "locked-down", "trusted"] as const;
export type SetupProfile = (typeof PROFILES)[number];

const PROFILE_HELP: Record<SetupProfile, string> = {
  standard: "asks before running programs or touching the network (recommended)",
  "locked-down": "requires a sandbox for anything that runs programs",
  trusted: "does not ask in a trusted context; you accept the risk",
};

export interface SetupOptions {
  dataDir: string;
  profile?: string | undefined;
  /** Model harness to use: claude, codex, cursor, gemini. */
  harness?: string | undefined;
  /** Asked only when no profile was given and the caller supplies a prompt. */
  ask?: (question: string, choices: readonly string[], fallback: string) => Promise<string>;
  out: (text: string) => void;
}

export interface SetupResult {
  steps: Array<{ step: string; done: boolean; note: string }>;
}

/**
 * First-run setup (docs/14 section 1). Every step is idempotent: running it again changes only what is
 * missing, so an interrupted setup is resumed by running it again.
 */
export async function runSetup(o: SetupOptions): Promise<SetupResult> {
  const steps: SetupResult["steps"] = [];
  const note = (step: string, done: boolean, text: string): void => {
    steps.push({ step, done, note: text });
    o.out(`${done ? "done" : "skip"}  ${step}: ${text}\n`);
  };

  // a. data directory
  const had = existsSync(o.dataDir);
  mkdirSync(o.dataDir, { recursive: true, mode: 0o700 });
  note("data directory", !had, had ? `${o.dataDir} already exists` : `created ${o.dataDir}`);

  // f. security profile (chosen before the config is written so it is written once)
  let profile = o.profile as SetupProfile | undefined;
  if (profile !== undefined && !PROFILES.includes(profile)) {
    throw new CliError("USAGE", `unknown profile ${profile}`, `Choose one of: ${PROFILES.join(", ")}.`);
  }
  const loaded = loadConfig(o.dataDir);
  if (loaded.state !== "ok" && loaded.state !== "missing") {
    throw new CliError("CONFIG_INVALID", loaded.problems.join("; "), `Run \`${BRAND.cli} doctor --fix\` first; setup will not overwrite a config it cannot read.`);
  }
  if (profile === undefined && loaded.state === "missing" && o.ask) {
    o.out("Security profile:\n" + PROFILES.map((p) => `  ${p.padEnd(12)} ${PROFILE_HELP[p]}`).join("\n") + "\n");
    const answer = await o.ask("Profile", PROFILES, "standard");
    profile = (PROFILES as readonly string[]).includes(answer) ? (answer as SetupProfile) : "standard";
  }

  const harness = o.harness;
  if (harness !== undefined && !HARNESSES.includes(harness)) {
    throw new CliError("USAGE", `unknown harness ${harness}`, `Choose one of: ${HARNESSES.join(", ")}.`);
  }

  // b. config
  const base = loaded.config;
  if (loaded.state === "missing") {
    const cfg = { ...defaultConfig(), security: { profile: profile ?? "standard" }, ...(harness ? { provider: { harness } } : {}) };
    const v = validateConfig(cfg);
    if (!v.ok) throw new CliError("INTERNAL", v.problems.join("; "), "Report this.");
    writeConfig(o.dataDir, v.config);
    note("config", true, `wrote config.json (profile: ${cfg.security.profile}${harness ? `, model harness: ${harness}` : ""})`);
  } else if ((profile !== undefined && profile !== base.security.profile) || (harness !== undefined && harness !== base.provider?.harness)) {
    const next = {
      ...base,
      security: { ...base.security, ...(profile ? { profile } : {}) },
      // choosing a different harness replaces command/args/env overrides; they belong to the old one
      ...(harness && harness !== base.provider?.harness ? { provider: { harness } } : {}),
    };
    const v = validateConfig(next);
    if (!v.ok) throw new CliError("INTERNAL", v.problems.join("; "), "Report this.");
    writeConfig(o.dataDir, v.config);
    note("config", true, `updated config.json${profile ? ` (profile: ${profile})` : ""}${harness ? ` (model harness: ${harness})` : ""}`);
  } else note("config", false, `config.json already present (profile: ${base.security.profile}${base.provider ? `, model harness: ${base.provider.harness}` : ""})`);

  // c. owner token and database
  const tokenExisted = existsSync(join(o.dataDir, "gateway.token"));
  ensureGatewayToken(o.dataDir);
  note("owner token", !tokenExisted, tokenExisted ? "gateway.token already present" : "created gateway.token (keep it private; it lets this machine's CLI control the Gateway)");

  const dbExisted = existsSync(join(o.dataDir, "gateway.db"));
  openDb(join(o.dataDir, "gateway.db")).close();
  note("database", !dbExisted, dbExisted ? "gateway.db already present" : "created gateway.db");

  mkdirSync(join(o.dataDir, "workspace"), { recursive: true, mode: 0o700 });
  note("workspace", false, `tools may only touch ${join(o.dataDir, "workspace")}`);

  o.out(
    [
      "",
      "Next:",
      `  1. ${BRAND.cli} gateway run            start the Gateway (add --fake-provider to try it without a model)`,
      `  2. ${BRAND.cli} chat "hello"           in another terminal`,
      `  3. ${BRAND.cli} doctor                 verify the installation`,
      harness || loaded.config.provider
        ? `  4. ${BRAND.cli} provider test          check that the model harness starts and answers (it may use your plan's quota)`
        : `  Model: choose a harness with \`${BRAND.cli} setup --harness claude\` (or codex, cursor, gemini).`,
      "Connecting a messaging channel arrives with later releases.",
      "",
    ].join("\n"),
  );
  return { steps };
}
