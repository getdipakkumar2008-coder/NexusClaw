export interface Parsed {
  positionals: string[];
  flags: Record<string, string | true>;
}

/** Flags that never take a value, so `--json foo` keeps `foo` as a positional. */
const BOOLEAN = new Set(["json", "help", "h", "yes", "y", "fix", "force", "fake-provider", "include-workspace", "version", "replace", "purge-data"]);

export function parseArgs(argv: readonly string[]): Parsed {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const name = a.slice(2);
      const next = argv[i + 1];
      if (BOOLEAN.has(name) || next === undefined || next.startsWith("-")) flags[name] = true;
      else {
        flags[name] = next;
        i++;
      }
    } else if (a.startsWith("-") && a.length > 1) {
      for (const ch of a.slice(1)) flags[ch] = true;
    } else positionals.push(a);
  }
  return { positionals, flags };
}

export function strFlag(p: Parsed, name: string): string | undefined {
  const v = p.flags[name];
  return typeof v === "string" ? v : undefined;
}
