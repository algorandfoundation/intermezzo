import { Injectable, ServiceUnavailableException } from '@nestjs/common';

import { VaultService } from '../../vault/vault.service';
import { VaultRepository } from '../../vault/vault.repository';
import { AlgoVaultTokenProvider } from '../algo/algo-vault-token.provider';
import { HolderStatus } from '../entities/holder-status.entity';
import { holderKey, isHolderKey } from '../sessions/vault-repository';

/**
 * Vault KV-v2 store for {@link HolderStatus} records, addressed by holder
 * `did:key`.
 *
 * No secondary index: a holder is only ever looked up by its did:key.
 */
@Injectable()
export class HolderStatusRepository extends VaultRepository<HolderStatus> {
  constructor(vault: VaultService, tokenProvider: AlgoVaultTokenProvider) {
    super(vault, tokenProvider, 'intermezzo/oid4vc/holders');
  }

  /** The holder's record, or `null` before its first status change or when the index cannot hold its did:key. */
  async findByHolder(holderDidKey: string): Promise<HolderStatus | null> {
    return isHolderKey(holderDidKey) ? this.findOneById(holderKey(holderDidKey)) : null;
  }

  /** Apply to the latest record, creating it on first use, retrying conflicts. */
  async mutate(holderDidKey: string, apply: (holder: HolderStatus) => void): Promise<HolderStatus> {
    const id = holderKey(holderDidKey);
    for (let attempt = 0; attempt < 5; attempt++) {
      const { record, version } = await this.load(id);
      const holder = record ?? ({ id, holderDidKey } as HolderStatus);
      apply(holder);
      if (await this.saveIfUnchanged(holder, version)) return holder;
    }
    throw new ServiceUnavailableException(`Holder ${holderDidKey} is under contention. Retry.`);
  }
}
