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

  /**
   * Read a record together with the Vault KV version that
   * {@link saveIfUnchanged} needs.
   *
   * A record that does not exist yet reports version `0`, which is what a
   * compare-and-set write uses to mean "only if nobody has created it", so
   * creating and updating a list go through the same pair of calls.
   */
  async load(id: string): Promise<{ record: StatusListRecord | null; version: number }> {
    const token = await this.tokenProvider.getToken();
    const { data, version } = await this.vault.kvReadVersioned<StatusListRecord>(`${this.folder}/records/${id}`, token);
    if (!data) return { record: null, version };
    return { record: { ...data, createdAt: new Date(data.createdAt), updatedAt: new Date(data.updatedAt) }, version };
  }

  /**
   * Write `record` only if the stored entry is still at `version`, and report
   * whether that held.
   *
   * `false` means another process committed first and the caller's copy is
   * stale: re-read, re-apply, try again. Inherited {@link save} is
   * last-writer-wins and must not be used for a status list, where losing a
   * write means either handing the same index to two credentials or dropping
   * a revocation on the floor.
   */
  async saveIfUnchanged(record: StatusListRecord, version: number): Promise<boolean> {
    const token = await this.tokenProvider.getToken();
    const now = new Date();
    const data = { ...record, createdAt: record.createdAt ?? now, updatedAt: now };
    try {
      await this.vault.kvWrite(`${this.folder}/records/${record.id}`, data as never, token, version);
      return true;
    } catch (error) {
      if (error instanceof VaultCasConflictError) return false;
      throw error;
    }
  }
}
