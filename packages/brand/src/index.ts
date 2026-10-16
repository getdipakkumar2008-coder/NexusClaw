/**
 * Single source of truth for the project's working names.
 * The final name is undecided (docs/11, Q-16/Q-19): change it HERE and in package scopes only.
 */
export const BRAND = {
  name: "ClawNexus",
  cli: "clawnexus",
  scope: "@clawnexus",
  envPrefix: "CLAWNEXUS_",
  configFile: "config.json",
} as const;

export type Brand = typeof BRAND;
