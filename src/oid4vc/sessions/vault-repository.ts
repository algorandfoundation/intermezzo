import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { VaultService } from '../../vault/vault.service';
import { VaultRepository } from '../../vault/vault.repository';
import { AlgoVaultTokenProvider } from '../algo/algo-vault-token.provider';
import { Oid4vcIssuanceSession } from '../entities/oid4vc-issuance-session.entity';
import { Oid4vcVerificationSession } from '../entities/oid4vc-verification-session.entity';

@Injectable()
export class Oid4vcIssuanceSessionRepository extends VaultRepository<Oid4vcIssuanceSession> {
  constructor(vault: VaultService, tokenProvider: AlgoVaultTokenProvider) {
    super(vault, tokenProvider, 'intermezzo/oid4vc/sessions/issuance', 'credoIssuanceSessionId');
  }

  /** Apply to the latest session, retrying conflicts. Never mutate indexed fields here. */
  async mutate(id: string, apply: (session: Oid4vcIssuanceSession) => void): Promise<Oid4vcIssuanceSession> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { record, version } = await this.load(id);
      if (!record) throw new NotFoundException(`Issuance session ${id} not found`);
      apply(record);
      if (await this.saveIfUnchanged(record, version)) return record;
    }
    throw new ServiceUnavailableException(`Issuance session ${id} is under contention. Retry.`);
  }

  /** Secondary index of sessions by holder `did:key`, since Vault KV only supports one indexed field per repo. */
  async indexHolder(holderDidKey: string, id: string): Promise<void> {
    const token = await this.tokenProvider.getToken();
    await this.vault.kvWrite(`${this.folder}/by-holder/${holderKey(holderDidKey)}/${id}`, { id }, token);
  }

  /** All sessions ever pinned to `holderDidKey`. Empty when the holder is unknown. */
  async findByHolder(holderDidKey: string): Promise<Oid4vcIssuanceSession[]> {
    const token = await this.tokenProvider.getToken();
    const ids = await this.vault.kvList(`${this.folder}/by-holder/${holderKey(holderDidKey)}`, token);
    const sessions: Oid4vcIssuanceSession[] = [];
    for (const id of ids) {
      const session = await this.findOneById(id);
      if (session) sessions.push(session);
    }
    return sessions;
  }
}

/** Strips the `did:key:` prefix so the holder segment of a Vault path holds no colons. */
function holderKey(holderDidKey: string): string {
  // Revalidated here, not just at the DTO: `?holderDidKey=` reaches this unvalidated, and the
  // result is interpolated into a Vault KV path where `..` would escape the index folder.
  if (!/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/u.test(holderDidKey)) {
    throw new BadRequestException('holderDidKey must be a valid did:key identifier');
  }
  return holderDidKey.slice('did:key:'.length);
}

@Injectable()
export class Oid4vcVerificationSessionRepository extends VaultRepository<Oid4vcVerificationSession> {
  constructor(vault: VaultService, tokenProvider: AlgoVaultTokenProvider) {
    super(vault, tokenProvider, 'intermezzo/oid4vc/sessions/verification', 'credoVerificationSessionId');
  }
}
