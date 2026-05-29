import { Injectable } from '@nestjs/common';
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
}

@Injectable()
export class Oid4vcVerificationSessionRepository extends VaultRepository<Oid4vcVerificationSession> {
  constructor(vault: VaultService, tokenProvider: AlgoVaultTokenProvider) {
    super(vault, tokenProvider, 'intermezzo/oid4vc/sessions/verification', 'credoVerificationSessionId');
  }
}
