import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { BRAND } from "@clawnexus/brand";
import { isLoopback } from "@clawnexus/config";
import { defaultConfig, loadConfig } from "./configfile.js";
import { runDoctor, type Check, type DoctorOptions } from "./doctor.js";

/** Files that must be readable by the owner only (they hold keys or tokens). */
const PRIVATE_FILES = ["gateway.token", "vault.key", "secrets.vault", "device.json", join("tls", "key.pem")];

/**
 * `doctor --security` (docs/06 section 9): the ordinary health checks plus a look at the choices that decide how much
 * damage a mistake or a stolen file can do. It reads, never changes, and a default install must come out without a
 * failure. A warning means "a deliberate choice that is worth confirming"; a failure means "this is unsafe as it stands".
 */
export async function runSecurityDoctor(o: DoctorOptions): Promise<Check[]> {
  const checks = await runDoctor({ ...o, fix: false });
  const add = (c: Check): void => void checks.push({ ...c, id: `sec:${c.id}` });
  const posix = (o.platform ?? process.platform) !== "win32";
  const dir = o.dataDir;

  const loaded = existsSync(dir) ? loadConfig(dir) : { state: "missing" as const, config: defaultConfig() };
  const config = loaded.state === "ok" || loaded.state === "missing" ? loaded.config : defaultConfig();

  // Who can reach it, and with what.
  const g = config.gateway;
  if (!isLoopback(g.bind) && g.insecureAcknowledged) add({ id: "exposure", status: "fail", message: "gateway.insecureAcknowledged is on while the Gateway listens beyond this computer: traffic and the token can be read on the network", fix: "Turn on gateway.tls and gateway.auth, or bind to 127.0.0.1, and remove insecureAcknowledged." });
  else if (!isLoopback(g.bind) && !g.tls.enabled) add({ id: "exposure", status: "fail", message: "the Gateway listens beyond this computer without TLS", fix: "Turn on gateway.tls (the Gateway makes a certificate for you) or bind to 127.0.0.1." });
  else add({ id: "exposure", status: "ok", message: isLoopback(g.bind) ? "only programs on this computer can connect" : "reachable from the network, with TLS and sign-in required" });

  // How much the assistant may do without asking.
  const profile = config.security.profile;
  if (profile === "trusted") add({ id: "profile", status: "warn", message: 'security profile "trusted": commands and network use run without asking whenever the conversation holds nothing untrusted', fix: 'Set security.profile to "standard" unless you chose this on purpose.' });
  else add({ id: "profile", status: "ok", message: `security profile "${profile}"` });

  // Files that hold secrets.
  if (!existsSync(dir)) return checks;
  const loose: string[] = [];
  if (posix) for (const f of PRIVATE_FILES) {
    const p = join(dir, f);
    try {
      if (existsSync(p) && (statSync(p).mode & 0o077) !== 0) loose.push(f);
    } catch {
      /* unreadable is not loose */
    }
  }
  if (loose.length) add({ id: "files", status: "fail", message: `readable by other users: ${loose.join(", ")}`, fix: `Run \`chmod 600\` on them, or \`${BRAND.cli} doctor --fix\`.` });
  else add({ id: "files", status: "ok", message: posix ? "key and token files are private to you" : "file permissions are not checked on this system (the data folder is in your profile)" });

  // A backup that carries the key can open the secrets in it.
  const backups = join(dir, "backups");
  const withKey: string[] = [];
  try {
    if (existsSync(backups)) for (const b of readdirSync(backups)) if (existsSync(join(backups, b, "vault.key"))) withKey.push(b);
  } catch {
    /* none to report */
  }
  if (withKey.length) add({ id: "backups", status: "warn", message: `backup(s) that contain the vault key: ${withKey.slice(0, 3).join(", ")}${withKey.length > 3 ? ", ..." : ""}`, fix: "Keep them as safely as the key itself, or make new backups without --include-key and delete these." });
  else add({ id: "backups", status: "ok", message: "no local backup carries the vault key" });

  // The optional file-check program runs with your rights: nobody else may be able to replace it.
  const hook = join(dir, "hooks", process.platform === "win32" ? "scan.exe" : "scan");
  if (existsSync(hook)) {
    if (posix && (statSync(hook).mode & 0o022) !== 0) add({ id: "scan-hook", status: "fail", message: "the file-check program can be changed by other users", fix: `Run chmod go-w on ${hook}.` });
    else add({ id: "scan-hook", status: "ok", message: "a file-check program is installed and only you can change it" });
  }
  return checks;
}
