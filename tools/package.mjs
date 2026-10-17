// Build the installable package (docs/08 section 3): one self-contained folder, and a tarball of it that
// `npm install -g` accepts. Everything the program needs is bundled, so installing it fetches nothing.
//
//   node tools/package.mjs [--no-build] [--out DIR]
//
// Layout of the package:
//   dist/main.js      the `clawnexus` program (the Gateway, the command line, the tool bridge)
//   dist/child.js     the shim each plugin process starts through
//   assets/           the WebChat page
//   extensions/       the plugins that ship with it (installed by name: `plugins install telegram`)
//   licenses/         licences of the bundled third-party code
process.noDeprecation = true; // npm needs a shell on Windows; the arguments here are fixed, not user input
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = opt("version") ?? rootPkg.version;
const out = resolve(opt("out") ?? join(root, "release"));
const stage = join(out, "stage", "package");
const run = (cmd, a, cwd = root) => execFileSync(cmd, a, { cwd, stdio: ["ignore", "inherit", "inherit"], shell: process.platform === "win32" && cmd === "pnpm" });

if (!flag("no-build")) run("pnpm", ["build"]);

rmSync(join(out, "stage"), { recursive: true, force: true });
mkdirSync(join(stage, "dist"), { recursive: true });

// ---- bundle ----
const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "none",
  keepNames: true,
  // ws can use two optional native speed-ups; it works without them, and we ship none
  external: ["bufferutil", "utf-8-validate"],
  // CommonJS code (ws) inside an ES module bundle needs a require
  banner: { js: 'import { createRequire as __cnRequire } from "node:module"; const require = __cnRequire(import.meta.url);' },
  logLevel: "warning",
};
await build({ ...common, entryPoints: [join(root, "src/daemon/dist/main.js")], outfile: join(stage, "dist/main.js") });
await build({ ...common, entryPoints: [join(root, "src/plugins/dist/child.js")], outfile: join(stage, "dist/child.js") });

// The program starts with a "#!" line so the npm bin shim runs it with node; esbuild keeps it first, but the
// banner's own line must not come before it.
const mainPath = join(stage, "dist/main.js");
let main = readFileSync(mainPath, "utf8");
if (!main.startsWith("#!")) main = `#!/usr/bin/env node\n${main}`;
else if (main.indexOf("#!") > 0) throw new Error("hashbang is not first in main.js");
writeFileSync(mainPath, main);

// ---- files ----
cpSync(join(root, "src/channels/assets"), join(stage, "assets"), { recursive: true });
for (const ext of ["hello-tool", "telegram", "discord", "slack"]) {
  cpSync(join(root, "extensions", ext), join(stage, "extensions", ext), {
    recursive: true,
    filter: (p) => !/node_modules|\.test\./.test(p),
  });
}
for (const f of ["LICENSE", "NOTICE", "README.md", "PRIVACY.md", "SECURITY.md"]) if (existsSync(join(root, f))) cpSync(join(root, f), join(stage, f));

// licences of what the bundle contains (ws, zod): copied from the installed packages
mkdirSync(join(stage, "licenses"), { recursive: true });
const pnpmDir = join(root, "node_modules", ".pnpm");
for (const pkg of ["ws", "zod"]) {
  const dir = readdirSync(pnpmDir).find((d) => d.startsWith(`${pkg}@`));
  const base = dir && join(pnpmDir, dir, "node_modules", pkg);
  const file = base && existsSync(base) ? readdirSync(base).find((f) => /^licen[sc]e/i.test(f)) : undefined;
  if (!file) throw new Error(`cannot find the licence of ${pkg}; the package must carry it`);
  cpSync(join(base, file), join(stage, "licenses", `${pkg}.LICENSE`));
}

writeFileSync(
  join(stage, "package.json"),
  `${JSON.stringify(
    {
      name: "clawnexus",
      version,
      description: "Self-hostable personal AI assistant: one Gateway, your messaging apps, models you choose.",
      license: "Apache-2.0",
      type: "module",
      bin: { clawnexus: "dist/main.js" },
      engines: { node: ">=22.13" },
      files: ["dist", "assets", "extensions", "licenses", "LICENSE", "NOTICE", "README.md", "PRIVACY.md", "SECURITY.md"],
      repository: { type: "git", url: "git+https://github.com/getdipakkumar2008-coder/NexusClaw.git" },
    },
    null,
    2,
  )}\n`,
);

// ---- tarball and checksum ----
const packed = execFileSync("npm", ["pack", "--pack-destination", out, "--json"], { cwd: stage, shell: process.platform === "win32" }).toString();
const info = JSON.parse(packed.slice(packed.indexOf("[")))[0];
const tgz = join(out, info.filename);
const sum = createHash("sha256").update(readFileSync(tgz)).digest("hex");
writeFileSync(join(out, "SHA256SUMS"), `${sum}  ${info.filename}\n`);

const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
process.stdout.write(
  `Built ${info.filename} (${mb(statSync(tgz).size)}, ${info.entryCount} files)\n  sha256 ${sum}\n  folder ${stage}\n  install: npm install -g ${tgz}\n`,
);
