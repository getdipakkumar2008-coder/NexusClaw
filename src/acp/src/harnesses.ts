import { existsSync, statSync } from "node:fs";
import { delimiter, dirname, extname, join } from "node:path";

export const HARNESS_NAMES = ["claude", "codex", "cursor", "gemini", "custom"] as const;
export type HarnessName = (typeof HARNESS_NAMES)[number];

export interface HarnessSpec {
  name: HarnessName;
  command: string;
  args: string[];
  /** Names of environment variables to pass through to the harness (values come from our own environment). */
  env: string[];
  /** If the harness advertises auth methods and needs a non-interactive login, the method to use. */
  authMethodId?: string;
  /** Where a person logs in when the harness says it is not signed in. */
  loginHint: string;
}

/**
 * Adapter versions are pinned on purpose: `npx` of an unpinned package runs whatever was published last,
 * which is a supply-chain risk for something that sees your prompts. Override `provider.args` to upgrade.
 * Command lines come from each vendor's public ACP documentation (checked 2026-10-16).
 */
export const PRESETS: Record<Exclude<HarnessName, "custom">, Omit<HarnessSpec, "name">> = {
  claude: {
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp@0.92.0"],
    env: [],
    loginHint: "Sign in with the Claude Code CLI (`claude`), or list ANTHROPIC_API_KEY in provider.env.",
  },
  codex: {
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp@2.2.2"],
    env: [],
    loginHint: "Sign in with the Codex CLI (`codex login`), or list OPENAI_API_KEY in provider.env.",
  },
  cursor: {
    command: "agent",
    args: ["acp"],
    env: [],
    authMethodId: "cursor_login",
    loginHint: "Run `agent login`, or list CURSOR_API_KEY in provider.env.",
  },
  gemini: {
    command: "gemini",
    args: ["--acp"],
    env: [],
    loginHint: "Sign in with the Gemini CLI (`gemini`), or list GEMINI_API_KEY in provider.env.",
  },
};

export interface HarnessConfig {
  harness: HarnessName;
  command?: string | undefined;
  args?: string[] | undefined;
  env?: string[] | undefined;
}

export class HarnessError extends Error {
  constructor(
    readonly code: "HARNESS_CONFIG" | "HARNESS_NOT_FOUND" | "HARNESS_UNSAFE",
    message: string,
    readonly remediation: string,
  ) {
    super(message);
    this.name = "HarnessError";
  }
}

export function resolveSpec(c: HarnessConfig): HarnessSpec {
  if (c.harness === "custom") {
    if (!c.command) throw new HarnessError("HARNESS_CONFIG", "provider.harness is custom but provider.command is missing", "Set provider.command (and provider.args).");
    return { name: "custom", command: c.command, args: c.args ?? [], env: c.env ?? [], loginHint: "See the harness's own documentation." };
  }
  const p = PRESETS[c.harness];
  return { name: c.harness, ...p, command: c.command ?? p.command, args: c.args ?? p.args, env: c.env ?? p.env };
}

export interface LaunchPlan {
  file: string;
  args: string[];
}

const SAFE_ARG = /^[\w@./:=,+-]+$/;

function findOnPath(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  const exts = platform === "win32" ? (env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase()) : [""];
  const hasExt = extname(command) !== "";
  const dirs = command.includes("/") || command.includes("\\") ? [""] : (env["PATH"] ?? env["Path"] ?? "").split(delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const e of hasExt ? [""] : exts) {
      const full = d === "" ? command + e : join(d, command + e);
      try {
        if (existsSync(full) && statSync(full).isFile()) return full;
      } catch {
        /* unreadable entry: keep looking */
      }
    }
  }
  return undefined;
}

/**
 * Work out exactly what to execute, without ever involving a shell on our side.
 * On Windows many CLIs are `.cmd` shims, which Node refuses to start directly; for the common case (`npx`) we run
 * npm's own script with node, otherwise we go through cmd.exe but only when every argument is plainly safe.
 */
export function planLaunch(spec: HarnessSpec, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): LaunchPlan {
  const found = findOnPath(spec.command, env, platform);
  if (!found) {
    throw new HarnessError("HARNESS_NOT_FOUND", `cannot find "${spec.command}" on PATH`, `Install it, or set provider.command to its full path. ${spec.loginHint}`);
  }
  if (platform !== "win32") return { file: found, args: spec.args };
  const ext = extname(found).toLowerCase();
  if (ext === ".exe" || ext === ".com") return { file: found, args: spec.args };
  if (ext === ".cmd" || ext === ".bat") {
    const base = found.slice(found.lastIndexOf("\\") + 1).toLowerCase();
    if (base === "npx.cmd") {
      const cli = join(dirname(found), "node_modules", "npm", "bin", "npx-cli.js");
      if (existsSync(cli)) return { file: process.execPath, args: [cli, ...spec.args] };
    }
    if (found.includes(" ") || !spec.args.every((a) => SAFE_ARG.test(a))) {
      throw new HarnessError(
        "HARNESS_UNSAFE",
        `"${spec.command}" is a Windows script shim and cannot be started safely with these arguments`,
        "Point provider.command at the real .exe (or a path without spaces), and keep arguments to letters, digits and ./:=,+-@_",
      );
    }
    return { file: process.env["ComSpec"] ?? "cmd.exe", args: ["/d", "/s", "/c", found, ...spec.args] };
  }
  return { file: found, args: spec.args };
}
