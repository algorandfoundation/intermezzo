import {
  Buffer as CredoBuffer,
  InjectionSymbols,
  KeyType,
  SigningProviderRegistry,
  TypedArrayEncoder,
  WalletError,
  type FileSystem,
  type Logger,
  type WalletSignOptions,
} from '@credo-ts/core';
import { AskarWallet } from '@credo-ts/askar';
// AskarModuleConfig is not part of @credo-ts/askar's public exports but is the
// concrete param type for AskarWallet's constructor (and the tsyringe token
// AskarModule registers); we reach into the build directory to keep the
// subclass's constructor signature identical.
import { AskarModuleConfig } from '@credo-ts/askar/build/AskarModuleConfig';
import { inject, injectable } from 'tsyringe';

import { vaultSigningRegistry } from './signing-registry';

/**
 * Drop-in replacement for `@credo-ts/askar`'s `AskarWallet` that delegates
 * Ed25519 signing to a host KMS (HashiCorp Vault today; generalises to
 * AWS/GCP KMS, HSM, etc.) when the requested key has been registered in
 * {@link vaultSigningRegistry}. All other behaviour (key generation for
 * non-KMS keys, storage, verification, wallet lifecycle) is inherited
 * unchanged from `AskarWallet`.
 *
 * Why a subclass and not a `SigningProvider`:
 *  - Credo's `SigningProvider` registry is only consulted for key types
 *    Askar does **not** natively support; Ed25519 is native, so a
 *    SigningProvider for it is silently bypassed.
 *  - `SigningProvider.sign` requires `privateKeyBase58`, which an
 *    external KMS never releases — the abstraction is a poor fit.
 *
 * Why we override `sign` and not `createKey`:
 *  - The DID document (e.g. `did:algo`) is already created by the host
 *    using the KMS public key; there is no need for Credo to materialise
 *    a new key. The registrar binds the published public key to its KMS
 *    handle via the registry, and from then on every Credo signing call
 *    (issuer JWS, SD-JWT VC, verifier authorisation request, …) routes
 *    through the KMS.
 *  - Verification stays in `AskarWallet` because it only needs the public
 *    key, which Credo already has from the DID document.
 *
 * Wallet `sign` resolves the entry by `key.publicKeyBase58` (not by the
 * `keyId` passed at creation time), so the registry is also keyed by
 * `publicKeyBase58`.
 */
@injectable()
export class VaultAskarWallet extends AskarWallet {
  constructor(
    @inject(InjectionSymbols.Logger) logger: Logger,
    @inject(InjectionSymbols.FileSystem) fileSystem: FileSystem,
    signingKeyProviderRegistry: SigningProviderRegistry,
    config: AskarModuleConfig,
  ) {
    super(logger, fileSystem, signingKeyProviderRegistry, config);
  }

  override async sign(options: WalletSignOptions): Promise<CredoBuffer> {
    const { data, key } = options;

    // Only Ed25519 is delegated. Hosts typically only mint Ed25519 keys
    // in their KMS; if someone ever asks us to sign with a different
    // key type we fall through to Askar's native path.
    if (key.keyType !== KeyType.Ed25519) {
      return super.sign(options);
    }

    const binding = await vaultSigningRegistry.getBinding(key.publicKeyBase58);
    if (!binding) {
      // Not a KMS-bound key — let AskarWallet sign with whatever it has
      // locally. This keeps the door open for non-KMS keys (e.g. test
      // fixtures, future holder-side keys) without changing call sites.
      return super.sign(options);
    }

    if (Array.isArray(data)) {
      // Credo only signs single-message buffers for JWS / SD-JWT
      // flows; multi-message signing is an Indy-AnonCreds artifact and
      // makes no sense for an external KMS.
      throw new WalletError(
        `VaultAskarWallet: multi-message signing is not supported for KMS-backed keys (publicKeyBase58=${key.publicKeyBase58}).`,
      );
    }

    try {
      const bytes = await vaultSigningRegistry.sign(binding, new Uint8Array(data));
      if (bytes.length !== 64) {
        throw new WalletError(
          `VaultAskarWallet: KMS returned a ${bytes.length}-byte signature for ${key.publicKeyBase58}; expected 64 bytes.`,
        );
      }
      // Sanity check: the signature must verify against the requested
      // public key. This catches KMS key rotation drift and binding
      // mistakes before the credential leaves the agent.
      const verified = await super.verify({
        data,
        key,
        signature: CredoBuffer.from(bytes),
      });
      if (!verified) {
        throw new WalletError(
          `VaultAskarWallet: KMS signature did not verify against ${key.publicKeyBase58}; ` +
            `the binding may be stale or the KMS key has been rotated.`,
        );
      }
      return CredoBuffer.from(bytes);
    } catch (error) {
      if (error instanceof WalletError) throw error;
      throw new WalletError(
        `VaultAskarWallet: KMS signing failed for ${key.publicKeyBase58} (keyName=${binding.vaultKeyName}): ${(error as Error).message}`,
        { cause: error as Error },
      );
    }
  }
}

/**
 * Re-export the public-key encoder so callers (the registrar) can compute the
 * `publicKeyBase58` they have to register, without importing `@credo-ts/core`
 * directly just for that.
 */
export const publicKeyToBase58 = (publicKey: Uint8Array): string => TypedArrayEncoder.toBase58(publicKey);
