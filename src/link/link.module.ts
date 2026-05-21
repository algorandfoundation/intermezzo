import { Module } from '@nestjs/common';
import { LinkService } from './link.service';
import { LinkController } from './link.controller';
import { AuthModule } from '../auth/auth.module';
import { DidModule } from '../did/did.module';
import { Oid4vcModule } from '../oid4vc/oid4vc.module';
import { VaultModule } from '../vault/vault.module';
/**
 * Device-attestation handshake (stateful challenge → signed redeem →
 * per-user `did:algo` mint → `device-attestation-credential` OID4VCI
 * offer).
 *
 *   - `AuthModule` provides `ManagerVaultTokenProvider` so the
 *     service can mint the per-user `did:algo` server-side.
 *   - `DidModule` provides `DidService.publishUncontrolledDid`.
 *   - `Oid4vcModule` provides `Oid4vcIssuerService.createOffer`.
 *   - `VaultModule` provides `VaultService` for the KV-v2 store that
 *     holds single-use challenges (no sidecar database).
 *
 * The two routes are `@Public()`; `did:key` possession and device
 * attestation are verified inside `LinkService` itself (not
 * via guards), because this is the controller that *mints* the
 * credential the wallet then carries on every subsequent call.
 *
 * Routes are auto-prefixed with the global `/v1` segment configured
 * in `main.ts`.
 */
@Module({
  imports: [AuthModule, DidModule, Oid4vcModule, VaultModule],
  controllers: [LinkController],
  providers: [LinkService],
  exports: [LinkService],
})
export class LinkModule {}
