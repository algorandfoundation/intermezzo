import { Injectable } from '@nestjs/common';
import { VaultService } from '../../vault/vault.service';
import { AlgoVaultTokenProvider } from './algo-vault-token.provider';
import type { KeyProvisioningPort } from '../../../libs/credo-did-algo';

/**
 * Intermezzo's adapter binding `VaultService` + `AlgoVaultTokenProvider`
 * to the `KeyProvisioningPort` exposed by `@algorandfoundation/credo-did-algo`.
 *
 * Post‑v2 the only key the OID4VC agent ever provisions is the
 * **manager** ed25519 transit key. Per-user vault transits no longer
 * exist (holders bind to a wallet-local `did:key` instead), so the
 * adapter is intentionally a thin **read-only** view of an already-
 * existing Vault key:
 *
 *   - The caller (today, `Oid4vcAgentProvider.ensureIssuerDid`) must
 *     supply `options.transitPath`. There is no default fallback.
 *   - The key at `<transitPath>/keys/<controller>` must already be
 *     provisioned out-of-band (the manager bootstrap script does it).
 *     Missing keys surface as a clear error — the adapter does not
 *     lazy-create.
 *
 * The returned `keyRef` matches the `VaultKeyBinding` shape from
 * `@algorandfoundation/credo-vault-wallet`, so the package
 * registrar's `KeyRefRegistry.bind(publicKeyBase58, keyRef)` call
 * routes future signing through Vault transparently.
 */
@Injectable()
export class VaultKeyProvisioningAdapter implements KeyProvisioningPort {
  constructor(
    private readonly vaultService: VaultService,
    private readonly tokenProvider: AlgoVaultTokenProvider,
  ) {}

  async provision(input: {
    controller: string;
    options?: Record<string, unknown>;
  }): Promise<{ publicKey: Uint8Array; keyRef: { vaultKeyName: string; transitPath: string } }> {
    const { controller, options } = input;
    const transitPath = options?.transitPath as string | undefined;
    if (!transitPath) {
      throw new Error(
        'VaultKeyProvisioningAdapter.provision requires options.transitPath. ' +
          'Per-user vault transits no longer exist; the caller must point at an ' +
          'existing manager / controller key path.',
      );
    }
    const vaultToken = await this.tokenProvider.getToken();
    let publicKeyBuffer: Buffer;
    try {
      publicKeyBuffer = await this.vaultService.getKey(controller, transitPath, vaultToken);
    } catch (err) {
      throw new Error(
        `VaultKeyProvisioningAdapter.provision: no Vault transit key for controller=${controller} ` +
          `at path=${transitPath}; provision the key out-of-band. Underlying error: ` +
          `${(err as Error).message}`,
      );
    }
    return {
      publicKey: new Uint8Array(publicKeyBuffer),
      keyRef: { vaultKeyName: controller, transitPath },
    };
  }
}
