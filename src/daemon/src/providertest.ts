import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AcpError, AcpProvider, HarnessError, resolveSpec } from "@clawnexus/acp";
import { BRAND } from "@clawnexus/brand";
import { CliError, type Io } from "@clawnexus/cli";
import { loadConfig } from "./configfile.js";

export interface ProviderTestOptions {
  dataDir: string;
  io: Io;
  json: boolean;
  prompt?: string | undefined;
  timeoutMs?: number | undefined;
}

/**
 * `provider test`: start the configured harness, ask one short question, print the answer.
 * It spends a little of the user's model quota, so it only runs when asked for.
 */
export async function runProviderTest(o: ProviderTestOptions): Promise<number> {
  const loaded = loadConfig(o.dataDir);
  if (loaded.state !== "ok" && loaded.state !== "missing") {
    throw new CliError("CONFIG_INVALID", loaded.problems.join("; "), `Run \`${BRAND.cli} doctor\` for details.`);
  }
  const cfg = loaded.config.provider;
  if (!cfg) {
    throw new CliError("PROVIDER_NOT_CONFIGURED", "no model harness is configured", `Run \`${BRAND.cli} setup --harness claude\` (or codex, cursor, gemini).`);
  }
  const timeoutMs = o.timeoutMs !== undefined && Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : 180_000;
  const workspace = join(o.dataDir, "workspace");
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const declined: string[] = [];
  let provider: AcpProvider;
  try {
    provider = new AcpProvider({ spec: resolveSpec(cfg), cwd: workspace, onDeclined: (w) => declined.push(w) });
  } catch (e) {
    if (e instanceof HarnessError) throw new CliError(e.code, e.message, e.remediation);
    throw e;
  }
  const started = Date.now();
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), timeoutMs);
  o.io.err(`Starting "${cfg.harness}"... (the first start can take a minute while the adapter downloads)\n`);
  let reply = "";
  try {
    for await (const e of provider.run({
      sessionId: "provider-test",
      runId: "provider-test",
      messages: [{ role: "user", content: o.prompt ?? "Reply with the single word: pong" }],
      signal: stop.signal,
    })) {
      reply += e.text;
    }
    if (stop.signal.aborted) throw new CliError("TIMEOUT", `no answer within ${Math.round(timeoutMs / 1000)} s`, "Try again, or raise --timeout (seconds).");
  } catch (e) {
    if (e instanceof AcpError) throw new CliError(e.code, e.message.replace(/\. Fix: [^]*$/, ""), e.remediation);
    throw e;
  } finally {
    clearTimeout(timer);
    await provider.close();
  }
  const ms = Date.now() - started;
  if (o.json) o.io.out(`${JSON.stringify({ harness: cfg.harness, ok: true, ms, reply, declined }, null, 2)}\n`);
  else {
    o.io.out(`ok  ${cfg.harness} answered in ${(ms / 1000).toFixed(1)} s:\n${reply.trim()}\n`);
    if (declined.length > 0) o.io.out(`note: ${declined.length} request(s) from the harness were declined (${declined.join("; ")}).\n`);
  }
  return 0;
}
