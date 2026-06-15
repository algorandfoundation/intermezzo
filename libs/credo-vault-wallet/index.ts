/**
 * Public surface of the `@algorandfoundation/credo-vault-wallet` package.
 *
 * A Credo wallet/KMS adapter, not a DID method. Exports:
 *
 *   - the host ports (`VaultKeyBinding`, `VaultSigner`, `KeyRefStore`);
 *   - the process-singleton `vaultSigningRegistry` that bridges Credo's
 *     wallet (constructed by Credo's tsyringe container) with the host
 *     DI world;
 *   - the `VaultAskarWallet` subclass that overrides Ed25519 signing
 *     to route through the host KMS when a binding is registered;
 *   - the pure `parseVaultSignature` helper that normalises HashiCorp
 *     Vault's `vault:v<N>:<b64>` signature envelope into raw bytes
 *     (used by host signer closures);
 *   - the pure `publicKeyToBase58` helper for callers that need to
 *     compute the `publicKeyBase58` they're about to register without
 *     pulling in `@credo-ts/core` themselves.
 *
 * See `./README.md` for the architecture rationale (why this is a
 * separate package from `@algorandfoundation/credo-did-algo`).
 */

export type { VaultKeyBinding, VaultSigner, KeyRefStore } from './ports';
export { vaultSigningRegistry } from './signing-registry';
export { VaultAskarWallet, publicKeyToBase58 } from './vault-askar-wallet';
export { parseVaultSignature } from './vault-signature';
