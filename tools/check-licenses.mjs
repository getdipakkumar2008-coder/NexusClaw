// Dependency licence gate (docs/12 section 4, rule 6). Fails on licences outside the allow-list.
import { execFileSync } from "node:child_process";

const ALLOW = new Set([
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "0BSD",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "CC-BY-4.0",
  "Python-2.0",
  "Unlicense",
  "MPL-2.0", // weak copyleft: file-level; review before shipping modified copies
  "(MIT OR CC0-1.0)",
  "MIT OR Apache-2.0",
  "Apache-2.0 OR MIT",
  "(BSD-2-Clause OR MIT OR Apache-2.0)",
  "(MIT AND CC-BY-3.0)",
  "(MIT AND Zlib)",
  "(WTFPL OR MIT)",
  "(AFL-2.1 OR BSD-3-Clause)",
]);

// Packages whose declared licence is on the allow-list only after manual review; keep this list tiny.
const REVIEWED = new Map([
  ["spawndamnit", "licence field says SEE LICENSE IN LICENSE; file is MIT text (reviewed in Phase 0); dev-only via changesets"],
]);

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const raw = execFileSync(pnpm, ["licenses", "list", "--json"], { encoding: "utf8", shell: process.platform === "win32" });
const byLicense = JSON.parse(raw);

const bad = [];
for (const [license, pkgs] of Object.entries(byLicense)) {
  if (ALLOW.has(license)) continue;
  for (const p of pkgs) {
    if (REVIEWED.has(p.name)) continue;
    bad.push(`${p.name}@${(p.versions ?? []).join(",")}: ${license}`);
  }
}

if (bad.length) {
  console.error("Disallowed or unreviewed licences:\n  " + bad.join("\n  "));
  process.exit(1);
}
console.log(`licence gate ok (${Object.keys(byLicense).length} distinct licences)`);
