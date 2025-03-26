import { Module } from '@nestjs/common';
import { WalletModule } from './wallet/wallet.module';
import { ConfigModule } from '@nestjs/config';
import { VaultModule } from './vault/vault.module';
import { ChainModule } from './chain/chain.module';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [ConfigModule.forRoot(), AuthModule, WalletModule, VaultModule, ChainModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
