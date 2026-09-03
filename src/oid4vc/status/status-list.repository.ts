import { Injectable } from '@nestjs/common';

import { VaultService } from '../../vault/vault.service';
import { VaultRepository } from '../../vault/vault.repository';
import { AlgoVaultTokenProvider } from '../algo/algo-vault-token.provider';
import { StatusListRecord } from '../entities/status-list.entity';

/**
 * Vault KV-v2 store for {@link StatusListRecord}s.
 *
 * No secondary index: a list is only ever addressed by its id, which is the
 * same value that appears in a credential's `status.status_list.uri`.
 */
@Injectable()
export class StatusListRepository extends VaultRepository<StatusListRecord> {
  constructor(vault: VaultService, tokenProvider: AlgoVaultTokenProvider) {
    super(vault, tokenProvider, 'intermezzo/oid4vc/status-lists');
  }
}
