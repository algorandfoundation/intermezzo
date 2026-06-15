import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ChainModule } from '../chain/chain.module';
import { VaultModule } from '../vault/vault.module';
import { DidController } from './did.controller';
import { DidService } from './did.service';
import { AuthModule } from '../auth/auth.module';

/**
 * Wires up `did:algo` publication.
 *
 * `DidService` is stateless — there is no local cache or repository
 * of published documents; the `DIDAlgoStorage` smart-contract boxes
 * are the single source of truth, and resolution flows through the
 * Credo `AlgoDidResolver` against the on-chain reader. `DidService`
 * depends on `ChainService` (signature assembly) and `VaultService`
 * (manager key custody). Re-exporting `DidService` lets the OID4VC
 * agent provider trigger an issuer-DID publish on bootstrap and the
 * attestation flow publish wallet-owned uncontrolled DIDs on demand.
 *
 * `AuthModule` is imported (with `forwardRef`) so the controller can
 * resolve `CredentialAuthGuard` and `ManagerVaultTokenProvider` for
 * the credential-gated `POST /did/identities/create/transactions` route; every
 * other route on the controller relies on the project-global manager
 * `AuthGuard` and needs no extra providers here.
 */
@Module({
  imports: [ChainModule, VaultModule, ConfigModule, forwardRef(() => AuthModule)],
  controllers: [DidController],
  providers: [DidService],
  exports: [DidService],
})
export class DidModule {}
