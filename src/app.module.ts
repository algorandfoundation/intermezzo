import { Module } from '@nestjs/common';
import { WalletModule } from './wallet/wallet.module';
import { VaultModule } from './vault/vault.module';
import { ChainModule } from './chain/chain.module';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from '@nestjs/config';
import { DidModule } from './did/did.module';
import { Oid4vcModule } from './oid4vc/oid4vc.module';
import { LinkModule } from './link/link.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    AuthModule,
    WalletModule,
    VaultModule,
    ChainModule,
    DidModule,
    Oid4vcModule,
    LinkModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
