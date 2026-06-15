/**
 * Host ports for the `@algorandfoundation/credo-did-algo` plugin.
 *
 * Interface-only on purpose — no Nest decorators, no TypeORM, no
 * Vault / KMS SDK imports — so this file stays trivially consumable
 * from any host (CREDEBL, Intermezzo, etc.).
 *
 * Two surfaces:
 *
 *   - {@link DidAlgoChainReaderPort} — implemented by every host that
 *     resolves `did:algo` identifiers (issuer, verifier, holder). Reads
 *     the published DID Document straight from the on-chain
 *     `DIDAlgoStorage` box. Required by {@link AlgoDidResolver}.
 *   - {@link DidAlgoChainWriterPort} — implemented by hosts that
 *     publish `did:algo` documents. Takes an opaque `keyRef` the host
 *     resolves to signing material via its own KMS adapter (e.g.
 *     `@algorandfoundation/credo-vault-wallet`).
 *   - {@link KeyProvisioningPort} — implemented by the same hosts, used
 *     by the registrar to obtain the Ed25519 key material at publish
 *     time.
 *
 * There is **no** in-process cache of DID Documents. Resolution always
 * goes to chain via the reader port, so the package can never be a
 * source of stale-document bugs.
 *
 * Signing custody is a separate concern owned by the sibling package
 * `@algorandfoundation/credo-vault-wallet`. This package deliberately
 * knows nothing about KMS / Vault beyond passing through the opaque
 * `keyRef`.
 */

/**
 * Result of publishing a `did:algo` document on chain.
 *
 * The record is **host-opaque**: it carries the canonical DID and the
 * encoded public key, but nothing about who the controller is in the
 * host's data model. That keeps the package agnostic to whether the
 * DID belongs to a managed org, a remote party, or anything in between.
 */
export interface DidAlgoRecord {
  /** The canonical `did:algo:<network>:app:<app-id>:<hex-pubkey>` identifier. */
  did: string;
  /** Base58-encoded Ed25519 public key for the document's primary verification method. */
  publicKeyBase58: string;
  /**
   * Host-specific pass-through. The package never inspects this field;
   * hosts may stash whatever local correlation data they need (a
   * tenant id, an `org_id`, the original user id, etc.) and expect to
   * receive it back from {@link DidAlgoChainWriterPort.uploadDocument}
   * via {@link DidAlgoPublishResult.metadata}.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Result of {@link DidAlgoChainWriterPort.uploadDocument} — the freshly
 * published `did:algo` document plus opaque on-chain coordinates the
 * host may want to surface (transaction id, app id, etc.). The plugin
 * only consumes `did` and `publicKeyBase58`; the rest is opaque
 * pass-through the host may stash on its own records.
 */
export interface DidAlgoPublishResult {
  did: string;
  publicKeyBase58: string;
  metadata?: Record<string, unknown>;
}

/**
 * Chain-side **reader** port. Every host that needs to resolve a
 * `did:algo` identifier — issuer, verifier, holder — implements this.
 *
 * The implementation reads the published DID Document from the
 * `DIDAlgoStorage` smart contract identified by the appId encoded in
 * the DID. It returns `null` (not throw) for the normal "no document
 * published" outcome (missing metadata box, in-flight upload, in-flight
 * delete). It should only throw when the chain itself is unreachable,
 * so the resolver can map outages to `notFound`/`internalError`
 * appropriately and never silently fall back to a synthesised
 * document.
 */
export interface DidAlgoChainReaderPort {
  /**
   * Fetch the on-chain DID Document for `did`. Returns `null` when no
   * document is currently published for that identifier.
   *
   * Implementations MUST consult chain on every call; the package
   * never caches and explicitly disables Credo's resolver-level
   * caching, so a stale return here would propagate everywhere.
   */
  resolveDocument(did: string): Promise<Record<string, unknown> | null>;
}

/**
 * Write-only chain-side port. Implemented only by hosts that publish
 * `did:algo` documents (e.g. Intermezzo's `DidAlgoChainAdapter`).
 */
export interface DidAlgoChainWriterPort {
  /**
   * Publish a new `did:algo` document on chain. `controller` is
   * host-opaque (an org id, a tenant id, a user id); `keyRef` is the
   * host's identifier for the signing key — typically routed back into
   * a KMS adapter (e.g. `@algorandfoundation/credo-vault-wallet`'s
   * `VaultKeyBinding`), but the package does not inspect either.
   *
   * The host is responsible for resolving `keyRef` to actual signing
   * material and for paying the on-chain fees.
   *
   * Idempotent on `controller`: re-publishing the same controller's
   * key should resolve to the existing document.
   */
  uploadDocument(input: {
    controller: string;
    keyRef: unknown;
    publicKeyBase58: string;
    /**
     * Re-publish even when the host already has a document for
     * `controller`. Semantics — including how previous on-chain
     * state is reclaimed — are entirely host-defined; adapters that
     * don't support overwrite should reject the call.
     */
    force?: boolean;
  }): Promise<DidAlgoPublishResult>;

  /**
   * Delete the on-chain `did:algo` document. The `did` is the
   * canonical identifier; `publicKeyBase58` is provided as a
   * pre-decoded convenience so the host doesn't have to re-derive it
   * from the DID string. Returning successfully on a missing document
   * is acceptable; the plugin treats deactivation as best-effort
   * cleanup.
   */
  deleteDocument(input: { did: string; publicKeyBase58: string }): Promise<void>;
}

/**
 * Host port the registrar uses to obtain the Ed25519 key material for
 * a `controller` at publish time. The package never talks to a KMS
 * directly — this is where the host decides "do I read an existing
 * key, lazy-create one, fail loudly?". Implementations typically wrap
 * a vault / HSM client (e.g. `@algorandfoundation/credo-vault-wallet`).
 *
 * The contract is intentionally minimal so a CREDEBL host (Prisma +
 * any KMS) can implement it as cleanly as Intermezzo (TypeORM +
 * HashiCorp Vault).
 *
 * Returned `keyRef` is opaque to the package and is the same value
 * passed back through {@link DidAlgoChainWriterPort.uploadDocument}
 * and registered with the vault-wallet signing registry so future
 * signing requests for `publicKey` route to the host's KMS.
 */
export interface KeyProvisioningPort {
  /**
   * Resolve — or, when policy allows, lazy-create — the ed25519 key
   * material the registrar is about to publish for `controller`.
   *
   * Implementations MUST return a 32-byte Ed25519 public key; the
   * registrar fails the create with a clear error otherwise.
   */
  provision(input: {
    controller: string;
    /**
     * Pass-through bag of options the host may use to scope the
     * lookup (e.g. a transit-path override). The package never
     * inspects these; they originate from the registrar's
     * `DidCreateOptions.options` and are forwarded verbatim.
     */
    options?: Record<string, unknown>;
  }): Promise<{
    /** Raw 32-byte ed25519 public key bytes. */
    publicKey: Uint8Array;
    /**
     * Opaque host identifier for the corresponding private key.
     * Stored in the vault-wallet signing registry under
     * `publicKeyBase58` so subsequent Credo signing requests can
     * route back to the host's KMS.
     */
    keyRef: unknown;
  }>;
}
