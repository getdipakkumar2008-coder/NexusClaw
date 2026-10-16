import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Redactor, Vault, VaultError } from "./vault.js";

export const VAULT_FILE = "secrets.vault";
export const VAULT_KEY_FILE = "vault.key";

/**
 * The vault a Gateway uses on its own, with no one there to type a passphrase.
 *
 * The key is a random 32-byte file kept next to the vault with owner-only permissions. Be clear about what that buys:
 * the vault file alone (a backup, a copied folder, a cloud sync) is useless without the key file, and secrets never
 * appear in config, logs or the database. It does NOT protect against someone who can read this user's data folder;
 * for that the key belongs in the operating system's keychain, which plugs in through the same `KeySource`.
 */
export class LocalVault {
  private vault: Vault | undefined;

  constructor(private readonly dataDir: string) {}

  async open(): Promise<void> {
    if (this.vault) return;
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const keyPath = join(this.dataDir, VAULT_KEY_FILE);
    const vaultPath = join(this.dataDir, VAULT_FILE);
    let key: Buffer;
    if (existsSync(keyPath)) {
      key = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
      if (key.length !== 32) throw new VaultError("BAD_KEY", `${VAULT_KEY_FILE} is damaged`);
    } else {
      if (existsSync(vaultPath)) throw new VaultError("BAD_KEY", `${VAULT_FILE} exists but ${VAULT_KEY_FILE} is missing, so it cannot be opened`);
      key = randomBytes(32);
      writeFileSync(keyPath, `${key.toString("base64")}\n`, { mode: 0o600, flag: "wx" });
      try {
        chmodSync(keyPath, 0o600);
      } catch {
        /* not supported on every filesystem */
      }
    }
    this.vault = existsSync(vaultPath) ? await Vault.open(vaultPath, { kind: "raw", key }) : await Vault.create(vaultPath, { kind: "raw", key });
  }

  /** True once `open` has succeeded. Until then (or if it failed) reads find nothing and writes are refused. */
  get ready(): boolean {
    return this.vault !== undefined;
  }

  get(name: string): string | undefined {
    return this.vault?.get(name);
  }
  set(name: string, value: string): void {
    if (!this.vault) throw new VaultError("CLOSED", "the vault is not open");
    this.vault.set(name, value);
  }
  delete(name: string): boolean {
    return this.vault?.delete(name) ?? false;
  }
  list(): string[] {
    return this.vault?.list() ?? [];
  }
  get redact(): Redactor {
    return this.vault?.redact ?? this.none;
  }
  private readonly none = new Redactor();
  close(): void {
    this.vault?.close();
    this.vault = undefined;
  }
}
