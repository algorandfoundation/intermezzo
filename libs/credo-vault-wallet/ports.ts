/**
 * Host ports for the `@algorandfoundation/credo-vault-wallet` package.
 *
 * This package is a Credo wallet/KMS adapter, not a DID method. It
 * lets Credo's Askar wallet delegate Ed25519 signing to an external
 * KMS (HashiCorp Vault today; the shape generalises to AWS KMS, GCP
 * KMS, an HSM, etc.) without leaking that concern into any DID-method
 * plugin.
 *
 * The contract is intentionally tiny:
 *
 *   - {@link VaultKeyBinding} — opaque-to-Credo identifier for a
 *     host-held private key.
 *   - {@link VaultSigner} — host callback the wallet invokes when a
 *     binding matches at sign time.
 *   - {@link KeyRefStore} — persistence port for
 *     `publicKeyBase58 → VaultKeyBinding` rows, so bindings survive
 *     process restarts. The host implements this against its own
 *     persistence layer (TypeORM in Intermezzo, Prisma in CREDEBL,
 *     etc.).
 *
 * This file is interface-only on purpose: no Nest decorators, no
 * TypeORM, no Vault SDK imports.
 */

/**
 * Identifier for a host-held private key plus the transit-engine (or
 * equivalent KMS) path the key lives under. Opaque to the package: the
 * package only ever stores the binding and hands it back to the host's
 * {@link VaultSigner} at sign time.
 *
 * The two-field shape happens to match HashiCorp Vault's `transit`
 * engine, but hosts using AWS/GCP KMS or an HSM can use the same shape
 * with different conventions for `vaultKeyName` / `transitPath` — the
 * package never interprets either.
 */
export interface VaultKeyBinding {
  /** Logical name of the key in the host's KMS (e.g. a Vault transit key name). */
  vaultKeyName: string;
  /** KMS path / mount prefix the key lives under. */
  transitPath: string;
}

/**
 * Signer callback the wallet invokes when a binding matches. Returns
 * the raw signature bytes (64 bytes for Ed25519, no envelope, no
 * base64 — the wallet handles encoding).
 *
 * Implementations are expected to call the host's KMS (e.g. Vault
 * `transit/sign/<keyName>`) and return the raw signature.
 */
export type VaultSigner = (binding: VaultKeyBinding, data: Uint8Array) => Promise<Uint8Array>;

/**
 * Persistence port for `publicKeyBase58 → VaultKeyBinding` rows. Used
 * by the signing registry so signing requests for a Credo-held public
 * key can be routed back to the host's KMS across process restarts.
 *
 * Implemented by TypeORM in Intermezzo (over `Oid4vcVaultKeyBinding`),
 * and by Prisma — or whatever — in CREDEBL.
 *
 * Implementations MUST be safe to call from a process-singleton in a
 * concurrent context and SHOULD be write-through (no eventual
 * consistency between `save` and `find`).
 */
export interface KeyRefStore {
  /** Persist a binding, idempotent on `publicKeyBase58`. */
  save(publicKeyBase58: string, binding: VaultKeyBinding): Promise<void>;
  /** Look up a binding, returning `null` if none exists. */
  find(publicKeyBase58: string): Promise<VaultKeyBinding | null>;
  /** Remove a binding (used by deactivate flows and by tests). */
  delete(publicKeyBase58: string): Promise<void>;
}
