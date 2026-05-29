import { Module } from '@nestjs/common';
import { VaultModule } from '../vault/vault.module';
import { JwtModule } from '@nestjs/jwt';
import { Auth } from './auth.controller';
import { AuthService } from './auth.service';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CredentialAuthGuard } from './credential-auth.guard';
import { ManagerVaultTokenProvider } from './manager-vault-token.provider';
import { Oid4vcModule } from '../oid4vc/oid4vc.module';

/**
 * Auth surface for the service.
 *
 * Two parallel authentication models coexist on the single `/v1/...`
 * API surface:
 *
 *   - **Vault JWT (manager / legacy)** — `AuthService` + the global
 *     `AuthGuard` exchange Vault AppRole credentials for a JWT and
 *     gate every controller that does not opt out via `@Public()`.
 *     This is what the existing manager orchestration uses.
 *
 *   - **Device-attestation credential (wallet)** — `CredentialAuthGuard`
 *     is the *single* authoritative login for wallet clients. The
 *     wallet presents the SD-JWT VC the manager minted during
 *     `/v1/link/response`; the credential's signature
 *     transitively proves both `did:key` possession and the device
 *     attestation that gated the original mint, so neither check has
 *     to be re-run on every request. Routes that use this guard mark
 *     themselves `@Public()` so the global JWT guard defers; they
 *     then apply `CredentialAuthGuard` at the controller level.
 *     `ManagerVaultTokenProvider` is the only way those routes obtain
 *     a Vault token (via AppRole, server-side).
 *
 * `/v1/link/challenge` and `/v1/link/response` are the
 * one place that does *not* require a credential — that is where the
 * credential is minted in the first place. Those routes verify
 * `did:key` possession and device attestation inside the attestation
 * service itself, not via guards.
 */
@Module({
  imports: [
    VaultModule,
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      global: true,
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
      }),
      inject: [ConfigService],
    }),
    Oid4vcModule,
  ],
  controllers: [Auth],
  providers: [
    AuthService,
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
    CredentialAuthGuard,
    ManagerVaultTokenProvider,
  ],
  exports: [AuthService, CredentialAuthGuard, ManagerVaultTokenProvider, Oid4vcModule],
})
export class AuthModule {}
