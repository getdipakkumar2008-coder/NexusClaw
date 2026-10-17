import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, win32 } from "node:path";
import { BRAND } from "@clawnexus/brand";
import { CliError } from "@clawnexus/cli";

/**
 * Run the Gateway in the background as the signed-in user, started at login and restarted if it dies (docs/14 section 1,
 * step 2g). It is a USER service on every system: no administrator rights, nothing outside the user's own account, and
 * it can reach the same harness sign-in and files the user can. The definition holds no secrets: the Gateway reads its
 * token and vault from the data directory, as it does when started by hand.
 */
export type ServiceKind = "systemd" | "launchd" | "schtasks";

export interface ServiceOptions {
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
  /** Absolute path of the node program to run. */
  node: string;
  /** Absolute path of this program's entry script. */
  script: string;
  dataDir: string;
  port?: number;
  uid?: number;
}

export interface Cmd {
  cmd: string;
  args: string[];
  /** A failure here is expected (for example, stopping something that is not running). */
  optional?: boolean;
}

export interface ServiceFile {
  path: string;
  content: string | Buffer;
}

export interface ServicePlan {
  kind: ServiceKind;
  /** What the system calls it. */
  name: string;
  files: ServiceFile[];
  install: Cmd[];
  start: Cmd[];
  stop: Cmd[];
  uninstall: Cmd[];
  /** Exits 0 when the definition is known to the system. */
  known: Cmd;
  /** Things the owner may want to do next that we deliberately do not do for them. */
  hints: string[];
}

export const UNIT_NAME = "clawnexus";
export const LAUNCHD_LABEL = "clawnexus.gateway";
export const TASK_NAME = "ClawNexus Gateway";

// ---------------- quoting, one function per format ----------------

/** systemd splits ExecStart on spaces and expands %specifiers and $variables, so quote and double those. */
export function systemdWord(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
}
export const xmlEscape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

function refuseControl(label: string, s: string): void {
  if ([...s].some((ch) => ch.charCodeAt(0) < 32)) throw new CliError("BAD_PATH", `${label} contains a control character`, "Use a path without line breaks or control characters.");
}

/** The command line the service runs, as separate arguments. */
function gatewayArgs(o: ServiceOptions): string[] {
  return [o.script, "gateway", "run", "--data-dir", o.dataDir, ...(o.port === undefined ? [] : ["--port", String(o.port)])];
}

// ---------------- the three formats ----------------

function systemdPlan(o: ServiceOptions): ServicePlan {
  const unit = posix.join(o.home, ".config", "systemd", "user", `${UNIT_NAME}.service`);
  const exec = [o.node, ...gatewayArgs(o)].map(systemdWord).join(" ");
  const lines = [
    "[Unit]",
    `Description=${BRAND.name} Gateway`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${exec}`,
    "Restart=on-failure",
    "RestartSec=5",
    // A restart loop is a bug to report, not something to hammer the machine with.
    "StartLimitIntervalSec=300",
    "StartLimitBurst=10",
    "NoNewPrivileges=yes",
    ...(o.env["PATH"] ? [`Environment=${systemdWord(`PATH=${o.env["PATH"]}`)}`] : []),
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ];
  const ctl = (...a: string[]): Cmd => ({ cmd: "systemctl", args: ["--user", ...a] });
  return {
    kind: "systemd",
    name: `${UNIT_NAME}.service`,
    files: [{ path: unit, content: lines.join("\n") }],
    install: [ctl("daemon-reload"), ctl("enable", "--now", `${UNIT_NAME}.service`)],
    start: [ctl("start", `${UNIT_NAME}.service`)],
    stop: [ctl("stop", `${UNIT_NAME}.service`)],
    uninstall: [{ ...ctl("disable", "--now", `${UNIT_NAME}.service`), optional: true }, ctl("daemon-reload")],
    known: ctl("cat", `${UNIT_NAME}.service`),
    hints: [`To keep it running when you are not logged in: loginctl enable-linger ${o.env["USER"] ?? "$USER"}`, `Its messages: journalctl --user -u ${UNIT_NAME}.service`],
  };
}

function launchdPlan(o: ServiceOptions): ServicePlan {
  const plist = posix.join(o.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  const logs = posix.join(o.dataDir, "logs");
  const uid = o.uid ?? 501;
  const domain = `gui/${uid}`;
  const strings = [o.node, ...gatewayArgs(o)].map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");
  const content = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xmlEscape(LAUNCHD_LABEL)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    strings,
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>ThrottleInterval</key>",
    "  <integer>10</integer>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "  <key>StandardOutPath</key>",
    `  <string>${xmlEscape(posix.join(logs, "launchd.out.log"))}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xmlEscape(posix.join(logs, "launchd.err.log"))}</string>`,
    ...(o.env["PATH"] ? ["  <key>EnvironmentVariables</key>", "  <dict>", "    <key>PATH</key>", `    <string>${xmlEscape(o.env["PATH"])}</string>`, "  </dict>"] : []),
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
  return {
    kind: "launchd",
    name: LAUNCHD_LABEL,
    files: [{ path: plist, content }],
    // bootout first so a reinstall picks up a changed definition; it fails harmlessly when nothing is loaded
    install: [{ cmd: "launchctl", args: ["bootout", `${domain}/${LAUNCHD_LABEL}`], optional: true }, { cmd: "launchctl", args: ["bootstrap", domain, plist] }],
    start: [{ cmd: "launchctl", args: ["kickstart", `${domain}/${LAUNCHD_LABEL}`] }],
    stop: [{ cmd: "launchctl", args: ["kill", "SIGTERM", `${domain}/${LAUNCHD_LABEL}`] }],
    uninstall: [{ cmd: "launchctl", args: ["bootout", `${domain}/${LAUNCHD_LABEL}`], optional: true }],
    known: { cmd: "launchctl", args: ["print", `${domain}/${LAUNCHD_LABEL}`] },
    hints: [`Its messages: ${posix.join(logs, "launchd.err.log")} and \`${BRAND.cli} logs\``],
  };
}

/** Task Scheduler wants UTF-16 with a byte-order mark. */
function utf16(xml: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]);
}

function schtasksPlan(o: ServiceOptions): ServicePlan {
  const user = `${o.env["USERDOMAIN"] ?? ""}${o.env["USERDOMAIN"] ? "\\" : ""}${o.env["USERNAME"] ?? ""}`;
  if (!o.env["USERNAME"]) throw new CliError("NO_USER", "cannot tell which Windows account this is (USERNAME is not set)", "Run this from a normal signed-in terminal.");
  const file = win32.join(o.dataDir, "service", "gateway-task.xml");
  // powershell hides the window; the exit code is passed on so Task Scheduler can restart a Gateway that failed
  const command = `& ${[o.node, ...gatewayArgs(o)].map(psQuote).join(" ")}; exit $LASTEXITCODE`;
  const xml = [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    `    <Description>${xmlEscape(BRAND.name)} Gateway: starts when you sign in and restarts if it stops.</Description>`,
    "  </RegistrationInfo>",
    "  <Triggers>",
    "    <LogonTrigger>",
    "      <Enabled>true</Enabled>",
    `      <UserId>${xmlEscape(user)}</UserId>`,
    "    </LogonTrigger>",
    "  </Triggers>",
    "  <Principals>",
    '    <Principal id="Author">',
    `      <UserId>${xmlEscape(user)}</UserId>`,
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <AllowHardTerminate>true</AllowHardTerminate>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
    "    <AllowStartOnDemand>true</AllowStartOnDemand>",
    "    <Enabled>true</Enabled>",
    "    <Hidden>false</Hidden>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "    <RestartOnFailure>",
    "      <Interval>PT1M</Interval>",
    "      <Count>999</Count>",
    "    </RestartOnFailure>",
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    "      <Command>powershell.exe</Command>",
    `      <Arguments>${xmlEscape(`-NoProfile -NonInteractive -WindowStyle Hidden -Command "${command}"`)}</Arguments>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\r\n");
  const task = (...a: string[]): Cmd => ({ cmd: "schtasks", args: a });
  return {
    kind: "schtasks",
    name: TASK_NAME,
    files: [{ path: file, content: utf16(xml) }],
    install: [task("/Create", "/TN", TASK_NAME, "/XML", file, "/F")],
    start: [task("/Run", "/TN", TASK_NAME)],
    stop: [task("/End", "/TN", TASK_NAME)],
    uninstall: [{ ...task("/End", "/TN", TASK_NAME), optional: true }, task("/Delete", "/TN", TASK_NAME, "/F")],
    known: task("/Query", "/TN", TASK_NAME),
    hints: [`It starts when you sign in. Its messages: \`${BRAND.cli} logs\``],
  };
}

export function serviceKind(platform: NodeJS.Platform): ServiceKind {
  if (platform === "linux") return "systemd";
  if (platform === "darwin") return "launchd";
  if (platform === "win32") return "schtasks";
  throw new CliError("UNSUPPORTED_PLATFORM", `no background service support for ${platform}`, `Run \`${BRAND.cli} gateway run\` under your system's own supervisor.`);
}

export function planService(o: ServiceOptions): ServicePlan {
  for (const [label, v] of [["the program path", o.node], ["the script path", o.script], ["the data directory", o.dataDir]] as const) {
    refuseControl(label, v);
    if (!posix.isAbsolute(v) && !win32.isAbsolute(v)) throw new CliError("BAD_PATH", `${label} must be an absolute path, got ${v}`, "Pass an absolute --data-dir.");
  }
  if (o.port !== undefined && !(Number.isInteger(o.port) && o.port >= 1 && o.port <= 65535)) throw new CliError("USAGE", `invalid port ${o.port}`, "Use a number between 1 and 65535.");
  switch (serviceKind(o.platform)) {
    case "systemd":
      return systemdPlan(o);
    case "launchd":
      return launchdPlan(o);
    case "schtasks":
      return schtasksPlan(o);
  }
}

// ---------------- doing it ----------------

export interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type RunCmd = (cmd: string, args: string[]) => Promise<CmdResult>;

/** Run a system tool without a shell. Output is capped and the wait is bounded. */
export const runSystem: RunCmd = (cmd, args) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (r: CmdResult): void => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      return finish({ code: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) });
    }
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: 124, stdout, stderr: `${stderr}timed out` });
    }, 30_000);
    child.stdout.on("data", (d: Buffer) => (stdout = (stdout + d.toString()).slice(-8000)));
    child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-8000)));
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      finish({ code: 127, stdout, stderr: e.code === "ENOENT" ? `${cmd} was not found on this computer` : e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ code: code ?? 1, stdout, stderr });
    });
  });

async function runAll(cmds: Cmd[], run: RunCmd, what: string): Promise<void> {
  for (const c of cmds) {
    const r = await run(c.cmd, c.args);
    if (r.code !== 0 && c.optional !== true) {
      const why = (r.stderr || r.stdout).trim().split("\n")[0]?.slice(0, 300) || `exit code ${r.code}`;
      throw new CliError("SERVICE_FAILED", `${what} failed: ${c.cmd} ${c.args[0] ?? ""}: ${why}`, `Run \`${c.cmd} ${c.args.join(" ")}\` yourself to see the full message.`);
    }
  }
}

export interface InstallResult {
  kind: ServiceKind;
  name: string;
  files: string[];
  hints: string[];
}

export async function installService(o: ServiceOptions, run: RunCmd): Promise<InstallResult> {
  const plan = planService(o);
  if (!existsSync(o.script)) throw new CliError("NO_PROGRAM", "cannot find " + o.script, "Run `pnpm build`, or reinstall the program.");
  for (const f of plan.files) {
    mkdirSync(dirname(f.path), { recursive: true, mode: 0o700 });
    writeFileSync(f.path, f.content, { mode: 0o600 });
  }
  mkdirSync(join(o.dataDir, "logs"), { recursive: true, mode: 0o700 });
  await runAll(plan.install, run, "installing the service");
  // systemd and launchd start it as part of registering; Task Scheduler only registers, so start it now too
  if (plan.kind === "schtasks") await runAll(plan.start, run, "starting the service");
  return { kind: plan.kind, name: plan.name, files: plan.files.map((f) => f.path), hints: plan.hints };
}

export async function uninstallService(o: ServiceOptions, run: RunCmd): Promise<{ removed: string[]; wasInstalled: boolean }> {
  const plan = planService(o);
  const present = plan.files.filter((f) => existsSync(f.path));
  const known = (await run(plan.known.cmd, plan.known.args)).code === 0;
  await runAll(plan.uninstall.filter(() => known || present.length > 0), run, "removing the service");
  for (const f of plan.files) rmSync(f.path, { force: true });
  return { removed: present.map((f) => f.path), wasInstalled: known || present.length > 0 };
}

export async function controlService(action: "start" | "stop", o: ServiceOptions, run: RunCmd): Promise<void> {
  const plan = planService(o);
  if ((await run(plan.known.cmd, plan.known.args)).code !== 0) throw new CliError("NOT_INSTALLED", "the background service is not installed", `Run \`${BRAND.cli} service install\`.`);
  await runAll(action === "start" ? plan.start : plan.stop, run, `${action} of the service`);
}

export interface ServiceStatus {
  kind: ServiceKind;
  name: string;
  installed: boolean;
  /** What the service definition says it runs; stale if the program or data folder has moved. */
  definition?: { node?: string; script?: string; dataDir?: string };
  problems: string[];
}

/** Whether the service exists and still points at things that exist. Does not start or stop anything. */
export async function serviceStatus(o: ServiceOptions, run: RunCmd): Promise<ServiceStatus> {
  const plan = planService(o);
  const known = (await run(plan.known.cmd, plan.known.args)).code === 0;
  const file = plan.files[0];
  const out: ServiceStatus = { kind: plan.kind, name: plan.name, installed: known || (file !== undefined && existsSync(file.path)), problems: [] };
  if (file && existsSync(file.path)) {
    const text = plan.kind === "schtasks" ? readFileSync(file.path).subarray(2).toString("utf16le") : readFileSync(file.path, "utf8");
    const has = (s: string): boolean => text.includes(plan.kind === "launchd" ? xmlEscape(s) : plan.kind === "schtasks" ? xmlEscape(psQuote(s)) : systemdWord(s));
    out.definition = {};
    if (has(o.node)) out.definition.node = o.node;
    else out.problems.push("the service runs a different node program than this one");
    if (has(o.script)) out.definition.script = o.script;
    else out.problems.push("the service runs a different copy of the program than this one");
    if (has(o.dataDir)) out.definition.dataDir = o.dataDir;
    else out.problems.push("the service uses a different data directory than this one");
  }
  if (out.installed && !file) out.problems.push("the system knows the service but its definition file is missing");
  if (out.installed && file && !existsSync(file.path)) out.problems.push("the system knows the service but its definition file is missing");
  return out;
}
