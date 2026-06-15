import type { KeyRefStore, VaultKeyBinding, VaultSigner } from './ports';

/**
 * Process-singleton bridge between Credo's wallet (constructed by
 * Credo's own tsyringe container) and the host's KMS + persistence.
 *
 * The {@link VaultAskarWallet} subclass that overrides `sign` for
 * KMS-held keys is instantiated by Credo, not by the host's DI
 * container, so host providers cannot be injected into it directly.
 * Instead, the host wires a {@link KeyRefStore} and a {@link VaultSigner}
 * onto this singleton at boot, and the wallet reaches in for both at
 * sign time.
 *
 * Persistence model:
 *   - The mapping `publicKeyBase58 → VaultKeyBinding` lives in
 *     whatever store the host plugs in (TypeORM in Intermezzo,
 *     Prisma in CREDEBL, etc.).
 *   - An in-process cache (a plain `Map`, sufficient for a small
 *     working set) backs the read path so the common case is a
 *     single in-memory lookup, not a remote round-trip.
 *   - Writes are write-through: `bind()` updates the cache and
 *     persists the row in the same call. Idempotent on
 *     `publicKeyBase58`.
 */

const cache = new Map<string, VaultKeyBinding>();
let signer: VaultSigner | undefined;
let store: KeyRefStore | undefined;

export const vaultSigningRegistry = {
  /**
   * Register the publicKey → KMS-binding mapping. Idempotent: if a row
   * already exists for this key, it is updated. Cache is updated
   * synchronously so subsequent reads in the same request avoid the
   * persistence layer.
   */
  async bind(publicKeyBase58: string, binding: VaultKeyBinding): Promise<void> {
    cache.set(publicKeyBase58, binding);
    if (!store) {
      // No store wired yet (typical in unit tests that exercise only
      // the cache). Fall back to in-memory-only behaviour so callers
      // don't crash when the persistence layer hasn't been initialised.
      return;
    }
    await store.save(publicKeyBase58, binding);
  },

  /**
   * Look up a previously registered binding. Hot path: returns the
   * cached value without awaiting the store when a hit exists. Cache
   * misses fall back to a single store lookup and warm the cache for
   * next time.
   */
  async getBinding(publicKeyBase58: string): Promise<VaultKeyBinding | undefined> {
    const cached = cache.get(publicKeyBase58);
    if (cached) return cached;
    if (!store) return undefined;
    const row = await store.find(publicKeyBase58);
    if (!row) return undefined;
    cache.set(publicKeyBase58, row);
    return row;
  },

  /** Remove a binding (used by tests and by future deactivate flows). */
  async unbind(publicKeyBase58: string): Promise<void> {
    cache.delete(publicKeyBase58);
    if (store) {
      await store.delete(publicKeyBase58);
    }
  },

  /**
   * Set the global KMS signer. The host calls this once at startup with
   * a closure that knows how to obtain auth material and call the KMS.
   */
  setSigner(s: VaultSigner): void {
    signer = s;
  },

  /**
   * Set the persistence store the registry uses for write-through and
   * cache-miss reads. The host calls this once at startup with an
   * adapter over its own persistence layer (e.g. TypeORM).
   */
  setStore(s: KeyRefStore): void {
    store = s;
  },

  /** Sign with the host KMS. Throws if no signer has been registered. */
  async sign(binding: VaultKeyBinding, data: Uint8Array): Promise<Uint8Array> {
    if (!signer) {
      throw new Error(
        'vaultSigningRegistry: no signer registered. The host must call setSigner(...) before any credential signing.',
      );
    }
    return signer(binding, data);
  },

  /** Test-only: drop all bindings + the signer + the store. */
  reset(): void {
    cache.clear();
    signer = undefined;
    store = undefined;
  },
};
