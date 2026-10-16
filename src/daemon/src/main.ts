#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { BRAND } from "@clawnexus/brand";
import { CliError, defaultDataDir, parseArgs, reportError, runCli, strFlag, systemIo, type Io } from "@clawnexus/cli";
import { createBackup, restoreBackup } from "./backup.js";
import { formatChecks, runDoctor } from "./doctor.js";
import { runGateway } from "./serve.js";
import { runMcpBridge } from "./mcpbridge.js";
import { runProviderTest } from "./providertest.js";
import { runSetup } from "./setup.js";

/** Server-side commands live here; everything else is a Gateway client command handled by @clawnexus/cli. */
export async function main(argv: readonly string[], io: Io = systemIo()): Promise<number> {
  const p = parseArgs(argv);
  const json = p.flags.json === true;
  const cmd = p.positionals[0];
  const dataDir = strFlag(p, "data-dir") ?? defaultDataDir({ platform: io.platform, env: io.env, home: io.home });
  const port = strFlag(p, "port") === undefined ? undefined : Number(strFlag(p, "port"));
  if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port <= 65535)) {
    return reportError(io, new CliError("USAGE", `invalid port ${strFlag(p, "port")}`, "Use a number between 1 and 65535."), json);
  }
  try {
    switch (cmd) {
      case "gateway": {
        if (p.positionals[1] !== "run") throw new CliError("USAGE", "unknown gateway command", `Use \`${BRAND.cli} gateway run\`.`);
        return await runGateway({ dataDir, io, ...(port === undefined ? {} : { port }), fakeProvider: p.flags["fake-provider"] === true });
      }
      case "setup": {
        const tty = process.stdin.isTTY === true && p.flags.yes !== true && p.flags.y !== true;
        const rl = tty ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
        try {
          await runSetup({
            dataDir,
            profile: strFlag(p, "profile"),
            harness: strFlag(p, "harness"),
            out: io.out,
            ...(rl ? { ask: async (q, choices, fallback) => (await rl.question(`${q} [${choices.join("/")}] (${fallback}): `)).trim() || fallback } : {}),
          });
        } finally {
          rl?.close();
        }
        return 0;
      }
      case "mcp-bridge":
        return await runMcpBridge(process.env, process.stdin, process.stdout, (t) => io.err(t));
      case "provider": {
        if (p.positionals[1] !== "test") throw new CliError("USAGE", "unknown provider command", `Use \`${BRAND.cli} provider test\`.`);
        return await runProviderTest({ dataDir, io, json, prompt: strFlag(p, "prompt"), timeoutMs: strFlag(p, "timeout") === undefined ? undefined : Number(strFlag(p, "timeout")) * 1000 });
      }
      case "doctor": {
        const checks = await runDoctor({ dataDir, fix: p.flags.fix === true, ...(port === undefined ? {} : { port }) });
        io.out(json ? `${JSON.stringify(checks, null, 2)}\n` : formatChecks(checks));
        return checks.some((c) => c.status === "fail") ? 1 : 0;
      }
      case "backup": {
        const out = strFlag(p, "out") ?? join(dataDir, "backups", `backup-${new Date().toISOString().replace(/[:.]/g, "-")}`);
        const m = createBackup(dataDir, out, { includeWorkspace: p.flags["include-workspace"] === true });
        io.out(json ? `${JSON.stringify({ out, ...m }, null, 2)}\n` : `Backup written and verified: ${out}\n  ${m.files.length} file(s); the Gateway token is not included.\n`);
        return 0;
      }
      case "restore": {
        const dir = p.positionals[1];
        if (!dir) throw new CliError("USAGE", "missing backup directory", `Usage: ${BRAND.cli} restore <DIR> [--force]`);
        const r = await restoreBackup(dir, dataDir, { force: p.flags.force === true, ...(port === undefined ? {} : { port }) });
        io.out(`Restored from ${dir}.${r.movedAside ? ` The previous database was kept as ${r.movedAside}.` : ""}\nStart the Gateway again and run \`${BRAND.cli} doctor\`.\n`);
        return 0;
      }
      default:
        return await runCli(argv, io);
    }
  } catch (e) {
    return reportError(io, e, json);
  }
}

// Run only when executed as the program (also through the npm bin shim), not when imported by tests.
const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`Error INTERNAL: ${e instanceof Error ? e.message : String(e)}`+String.fromCharCode(10));
      process.exit(1);
    },
  );
}
