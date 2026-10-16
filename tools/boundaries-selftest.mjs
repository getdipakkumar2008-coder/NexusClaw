// Proves the boundary rules actually fail on violations (Phase 0 exit criterion).
// Builds a throwaway tree with illegal imports, runs dependency-cruiser on it, expects failure.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "node_modules", "dependency-cruiser", "bin", "dependency-cruise.mjs");

function run(dir) {
  try {
    const out = execFileSync(process.execPath, [bin, "--config", ".dependency-cruiser.cjs", "packages", "src", "extensions"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function write(dir, rel, text) {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

function scaffold() {
  const dir = mkdtempSync(join(tmpdir(), "boundaries-"));
  for (const f of [".dependency-cruiser.cjs", "tsconfig.base.json", "tsconfig.depcruise.json"]) cpSync(join(root, f), join(dir, f));
  write(dir, "src/gateway/src/index.ts", "export const g = 1;\n");
  write(dir, "packages/protocol/src/index.ts", "export const p = 1;\n");
  write(dir, "packages/plugin-sdk/src/index.ts", "export const s = 1;\n");
  write(dir, "packages/brand/src/index.ts", "export const b = 1;\n");
  return dir;
}

let failed = false;
const expect = (cond, msg) => {
  if (!cond) {
    failed = true;
    console.error(`FAIL: ${msg}`);
  } else console.log(`ok:   ${msg}`);
};

const cases = [
  ["client importing Gateway internals", "packages/cli/src/bad.ts", 'import "../../../src/gateway/src/index";\n', "clients-only-use-protocol"],
  ["extension importing core", "extensions/foo/src/bad.ts", 'import "../../../src/gateway/src/index";\n', "extensions-only-use-plugin-sdk"],
  ["extension importing another extension", "extensions/foo/src/bad.ts", 'import "../../bar/src/x";\n', "extensions-are-independent"],
  ["protocol importing brand", "packages/protocol/src/bad.ts", 'import "../../brand/src/index";\n', "protocol-and-sdk-are-leaf-packages"],
];

for (const [label, rel, body, rule] of cases) {
  const dir = scaffold();
  try {
    write(dir, "extensions/bar/src/x.ts", "export const x = 1;\n");
    write(dir, rel, body);
    const r = run(dir);
    expect(r.code !== 0 && r.out.includes(rule), `${label} is rejected by "${rule}"`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Legal imports must pass.
{
  const dir = scaffold();
  try {
    write(dir, "packages/cli/src/ok.ts", 'import "../../protocol/src/index";\nimport "../../brand/src/index";\n');
    write(dir, "extensions/foo/src/ok.ts", 'import "../../../packages/plugin-sdk/src/index";\n');
    write(dir, "src/gateway/src/ok.ts", 'import "../../../packages/protocol/src/index";\n');
    const r = run(dir);
    expect(r.code === 0, "legal imports pass");
    if (r.code !== 0) console.error(r.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(failed ? 1 : 0);
