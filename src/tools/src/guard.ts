import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export class PathError extends Error {
  constructor(
    readonly code: "OUTSIDE" | "DENIED" | "INVALID",
    message: string,
  ) {
    super(message);
  }
}

export interface GuardOptions {
  /** Path segments that may not be read or written anywhere under a root (case-insensitive). */
  deny?: readonly string[];
  /** Path segments that may be read but never written (case-insensitive). */
  denyWrite?: readonly string[];
}

const DEFAULT_DENY = [".ssh", ".gnupg", ".aws"];
const DEFAULT_DENY_WRITE = [".git"];
const MAX_PATH = 4096;
const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
const fold = (s: string): string => (caseInsensitive ? s.toLowerCase() : s);

/**
 * Confines file access to workspace roots (docs/06 T14). Every path is canonicalised through the real file
 * system first, so `..` segments and symlinks cannot lead out of a root. A check-then-use gap remains for
 * paths that an attacker with local write access can swap between the check and the open; the guard defends
 * against model-chosen paths, not against a hostile local process.
 */
export class WorkspaceGuard {
  private readonly roots: string[];
  private readonly deny: Set<string>;
  private readonly denyWrite: Set<string>;

  constructor(roots: readonly string[], opts: GuardOptions = {}) {
    if (roots.length === 0) throw new Error("at least one workspace root is required");
    this.roots = roots.map((r) => realpathSync.native(resolve(r)));
    this.deny = new Set((opts.deny ?? DEFAULT_DENY).map(fold));
    this.denyWrite = new Set((opts.denyWrite ?? DEFAULT_DENY_WRITE).map(fold));
  }

  get primaryRoot(): string {
    return this.roots[0] as string;
  }

  /** Canonical absolute path for `input` (relative paths are taken from the primary root), or a PathError. */
  resolve(input: string, mode: "read" | "write" = "read"): string {
    if (typeof input !== "string" || input === "") throw new PathError("INVALID", "path is empty");
    if (input.length > MAX_PATH) throw new PathError("INVALID", "path is too long");
    if (input.includes("\0")) throw new PathError("INVALID", "path contains a NUL byte");
    if (process.platform === "win32") {
      // Device namespaces (\\?\, \\.\) and alternate data streams (name:stream) bypass normal path rules.
      if (/^[\\/]{2}[?.][\\/]/.test(input)) throw new PathError("INVALID", "device paths are not allowed");
      if (input.slice(2).includes(":")) throw new PathError("INVALID", "':' is not allowed in a path");
    }
    const abs = isAbsolute(input) ? resolve(input) : resolve(this.primaryRoot, input);
    const canonical = canonicalise(abs);

    const root = this.roots.find((r) => within(r, canonical));
    if (root === undefined) throw new PathError("OUTSIDE", "path is outside the workspace");
    const segments = relative(root, canonical).split(sep).filter(Boolean).map(fold);
    for (const s of segments) {
      if (this.deny.has(s)) throw new PathError("DENIED", `access to '${s}' is not allowed`);
      if (mode === "write" && this.denyWrite.has(s)) throw new PathError("DENIED", `writing to '${s}' is not allowed`);
    }
    return canonical;
  }
}

function within(root: string, p: string): boolean {
  const rel = relative(fold(root), fold(p));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * realpath of the deepest existing ancestor plus the not-yet-existing tail. A dangling symlink is refused:
 * creating a file "through" it would land outside the root.
 */
function canonicalise(abs: string): string {
  let head = abs;
  const tail: string[] = [];
  for (;;) {
    let exists = true;
    try {
      lstatSync(head);
    } catch {
      exists = false;
    }
    if (exists) {
      let real: string;
      try {
        real = realpathSync.native(head);
      } catch {
        throw new PathError("INVALID", "path goes through a broken symbolic link");
      }
      return tail.length === 0 ? real : resolve(real, ...tail.reverse());
    }
    const parent = resolve(head, "..");
    if (parent === head) throw new PathError("INVALID", "path has no existing ancestor");
    tail.push(head.slice(parent.length).replace(/^[\\/]+/, ""));
    head = parent;
  }
}
