import { join } from "node:path";
import { BRAND } from "@clawnexus/brand";

export interface PathEnv {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
}

/** Per-OS default data directory; `CLAWNEXUS_DATA_DIR` overrides it everywhere. */
export function defaultDataDir(e: PathEnv): string {
  const override = e.env[`${BRAND.envPrefix}DATA_DIR`];
  if (override) return override;
  switch (e.platform) {
    case "win32":
      return join(e.env.LOCALAPPDATA ?? join(e.home, "AppData", "Local"), BRAND.name);
    case "darwin":
      return join(e.home, "Library", "Application Support", BRAND.name);
    default:
      return join(e.env.XDG_DATA_HOME ?? join(e.home, ".local", "share"), BRAND.cli);
  }
}

export const TOKEN_FILE = "gateway.token";
export const DEFAULT_PORT = 7391;
