import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { VaultService } from '../../vault/vault.service';
import { VaultRepository } from '../../vault/vault.repository';
import { AlgoVaultTokenProvider } from '../algo/algo-vault-token.provider';
import { Oid4vcIssuanceSession } from '../entities/oid4vc-issuance-session.entity';
import { Oid4vcVerificationSession } from '../entities/oid4vc-verification-session.entity';

/** Sessions read at a time while backfilling the holder index. */
const BACKFILL_BATCH = 16;

@Injectable()
export class Oid4vcIssuanceSessionRepository extends VaultRepository<Oid4vcIssuanceSession> {
  /** The in-process backfill, shared by every lookup that waits on it. */
  private holderIndexReady?: Promise<void>;

  constructor(vault: VaultService, tokenProvider: AlgoVaultTokenProvider) {
    super(vault, tokenProvider, 'intermezzo/oid4vc/sessions/issuance', 'credoIssuanceSessionId');
  }

  /** Apply to the latest session, retrying conflicts. Never mutate indexed fields here. */
  async mutate(
    id: string,
    apply: (session: Oid4vcIssuanceSession) => void | Promise<void>,
  ): Promise<Oid4vcIssuanceSession> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { record, version } = await this.load(id);
      if (!record) throw new NotFoundException(`Issuance session ${id} not found`);
      await apply(record);
      if (await this.saveIfUnchanged(record, version)) return record;
    }
    throw new ServiceUnavailableException(`Issuance session ${id} is under contention. Retry.`);
  }

  /** Secondary index of sessions by holder `did:key`, since Vault KV only supports one indexed field per repo. */
  async indexHolder(holderDidKey: string, id: string): Promise<void> {
    const token = await this.tokenProvider.getToken();
    await this.vault.kvWrite(`${this.folder}/by-holder/${holderKey(holderDidKey)}/${id}`, { id }, token);
  }

  /**
   * Ids indexed under `holderDidKey`, once the index covers sessions saved
   * before it existed. An id may not have its session yet: the index is
   * written first.
   */
  async holderSessionIds(holderDidKey: string): Promise<string[]> {
    const path = `${this.folder}/by-holder/${holderKey(holderDidKey)}`;
    await this.ensureHolderIndex();
    const token = await this.tokenProvider.getToken();
    return this.vault.kvList(path, token);
  }

  /**
   * Indexes sessions saved before the holder index existed, once per Vault: a
   * marker records completion, and is written last so an interrupted run
   * starts again. A failure rejects every waiting lookup and the next one
   * retries, so a holder lookup never answers from a partial index.
   */
  ensureHolderIndex(): Promise<void> {
    this.holderIndexReady ??= this.backfillHolderIndex().catch((error) => {
      this.holderIndexReady = undefined;
      throw error;
    });
    return this.holderIndexReady;
  }

  private async backfillHolderIndex(): Promise<void> {
    const marker = `${this.folder}/migrations/by-holder`;
    const token = await this.tokenProvider.getToken();
    if (await this.vault.kvRead(marker, token)) return;
    const ids = await this.vault.kvList(`${this.folder}/records`, token);
    for (let i = 0; i < ids.length; i += BACKFILL_BATCH) {
      await Promise.all(ids.slice(i, i + BACKFILL_BATCH).map((id) => this.indexExisting(id)));
    }
    // The scan can outlast the token it started with.
    const completed = { completedAt: new Date().toISOString(), sessions: ids.length };
    await this.vault.kvWrite(marker, completed, await this.tokenProvider.getToken());
    this.logger.log(`Holder index covers ${ids.length} existing issuance sessions`);
  }

  private async indexExisting(id: string): Promise<void> {
    const session = await this.findOneById(id);
    if (!session?.holderDidKey) return;
    // A did:key the index cannot hold cannot be named in a holder request either.
    if (!isHolderKey(session.holderDidKey)) {
      this.logger.warn(`Issuance session ${id} has an unindexable holder ${session.holderDidKey}; skipped`);
      return;
    }
    await this.indexHolder(session.holderDidKey, id);
  }

  /** All sessions ever pinned to `holderDidKey`. Empty when the holder is unknown. */
  async findByHolder(holderDidKey: string): Promise<Oid4vcIssuanceSession[]> {
    const ids = await this.holderSessionIds(holderDidKey);
    // Concurrent: one holder has few sessions.
    const sessions = await Promise.all(ids.map((id) => this.findOneById(id)));
    return sessions.filter((session): session is Oid4vcIssuanceSession => session !== null);
  }

  /** Removes a session and its holder index entry, for an offer whose save failed. */
  async discard(holderDidKey: string, id: string): Promise<void> {
    const token = await this.tokenProvider.getToken();
    await Promise.all([
      this.vault.kvDelete(`${this.folder}/records/${id}`, token),
      this.vault.kvDelete(`${this.folder}/by-holder/${holderKey(holderDidKey)}/${id}`, token),
    ]);
  }
}

/** Whether `holderDidKey` can be held by the holder index: `did:key:z` followed by base58. */
export function isHolderKey(holderDidKey: string): boolean {
  return /^did:key:z[1-9A-HJ-NP-Za-km-z]+$/u.test(holderDidKey);
}

/** Strips the `did:key:` prefix so the holder segment of a Vault path holds no colons. */
export function holderKey(holderDidKey: string): string {
  // `?holderDidKey=` arrives unvalidated and becomes a Vault KV path segment.
  if (!isHolderKey(holderDidKey)) {
    throw new BadRequestException('holderDidKey must be `did:key:z` followed by base58');
  }
  return holderDidKey.slice('did:key:'.length);
}

@Injectable()
export class Oid4vcVerificationSessionRepository extends VaultRepository<Oid4vcVerificationSession> {
  constructor(vault: VaultService, tokenProvider: AlgoVaultTokenProvider) {
    super(vault, tokenProvider, 'intermezzo/oid4vc/sessions/verification', 'credoVerificationSessionId');
  }
}
