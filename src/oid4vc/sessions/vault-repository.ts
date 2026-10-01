import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
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
}

@Injectable()
export class Oid4vcVerificationSessionRepository extends VaultRepository<Oid4vcVerificationSession> {
  constructor(vault: VaultService, tokenProvider: AlgoVaultTokenProvider) {
    super(vault, tokenProvider, 'intermezzo/oid4vc/sessions/verification', 'credoVerificationSessionId');
  }
}
