import { Logger, Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Oid4vcIssuanceSessionRepository, Oid4vcVerificationSessionRepository } from './sessions/vault-repository';

import { AlgoDidRegistrar } from '../../libs/credo-did-algo';
import { vaultSigningRegistry } from '../../libs/credo-vault-wallet';
import { Oid4vcConfig } from './oid4vc.config';
import { Oid4vcAgentProvider } from './agent/oid4vc-agent.provider';
import { Oid4vcIssuerService } from './issuer/oid4vc-issuer.service';
import { Oid4vcIssuerController } from './issuer/oid4vc-issuer.controller';
import { Oid4vcVerifierService } from './verifier/oid4vc-verifier.service';
import { Oid4vcVerifierController } from './verifier/oid4vc-verifier.controller';
import { DidModule } from '../did/did.module';
import { VaultModule } from '../vault/vault.module';
import { AlgoVaultTokenProvider } from './algo/algo-vault-token.provider';
import { DidAlgoChainAdapter } from './algo/did-algo-chain.adapter';
import { AlgoDidResolver } from './algo/algo-did.resolver';
import { VaultKeyProvisioningAdapter } from './algo/vault-key-provisioning.adapter';
import { Oid4vcSessionMirrorService } from './sessions/oid4vc-session-mirror.service';

/**
 * Standalone Nest module exposing OID4VCI (issuance) and OID4VP
 * (verification) capabilities backed by a Credo (`@credo-ts/openid4vc`)
 * agent.
 *
 * Post‑v2 wiring:
 *   - No device-manifest storage and no vault-key-binding table — the
 *     only Vault binding (the manager's) lives in-memory inside
 *     `Oid4vcAgentProvider`.
 *   - No Better-Auth / `AuthModule` dependency inside this module. The
 *     OID4VC HTTP surface is gated by the global manager `AuthGuard`
 *     (JWT) mounted by the host application.
 *
 * Host responsibilities:
 *   - `TypeOrmModule.forRoot` must already be configured.
 *   - The Credo Express routers exposed by `Oid4vcAgentProvider` must
 *     be mounted on the global Express adapter from `main.ts` *before*
 *     `setGlobalPrefix` and `app.listen`.
 */
@Module({
  imports: [ConfigModule, forwardRef(() => DidModule), VaultModule],
  controllers: [Oid4vcIssuerController, Oid4vcVerifierController],
  providers: [
    Oid4vcConfig,
    AlgoVaultTokenProvider,
    DidAlgoChainAdapter,
    AlgoDidResolver,
    VaultKeyProvisioningAdapter,
    {
      // The package registrar is host-agnostic — it knows nothing
      // about Nest, Vault, or our DidService. We compose it here from
      // the host adapters (chain writer + key provisioning) plus the
      // KMS-binding registry from credo-vault-wallet so Credo signing
      // requests for the manager DID route back to the host's Vault.
      provide: AlgoDidRegistrar,
      useFactory: (chain: DidAlgoChainAdapter, keyProvisioning: VaultKeyProvisioningAdapter) => {
        const logger = new Logger(AlgoDidRegistrar.name);
        return new AlgoDidRegistrar(chain, keyProvisioning, {
          keyRefRegistry: vaultSigningRegistry,
          logger,
        });
      },
      inject: [DidAlgoChainAdapter, VaultKeyProvisioningAdapter],
    },
    Oid4vcAgentProvider,
    Oid4vcIssuerService,
    Oid4vcVerifierService,
    Oid4vcIssuanceSessionRepository,
    Oid4vcVerificationSessionRepository,
    Oid4vcSessionMirrorService,
  ],
  exports: [Oid4vcConfig, Oid4vcAgentProvider, Oid4vcIssuerService, Oid4vcVerifierService],
})
export class Oid4vcModule {}
