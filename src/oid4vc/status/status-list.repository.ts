import { Injectable } from '@nestjs/common';

import { VaultCasConflictError, VaultService } from '../../vault/vault.service';
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

  /** The pointer is separate from public list records. CAS also elects the first list. */
  async loadActive(): Promise<{ listId?: string; version: number }> {
    const token = await this.tokenProvider.getToken();
    const { data, version } = await this.vault.kvReadVersioned<{ listId: string }>(`${this.folder}/active`, token);
    return { listId: data?.listId, version };
  }

  async saveActive(listId: string, version: number): Promise<boolean> {
    const token = await this.tokenProvider.getToken();
    try {
      await this.vault.kvWrite(`${this.folder}/active`, { listId }, token, version);
      return true;
    } catch (error) {
      if (error instanceof VaultCasConflictError) return false;
      throw error;
    }
  }
}
