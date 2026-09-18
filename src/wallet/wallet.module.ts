import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { Wallet } from './wallet.controller';
import { WalletService } from './wallet.service';
import { VaultModule } from '../vault/vault.module';
import { ChainModule } from '../chain/chain.module';
import { ConfigModule } from '@nestjs/config';
import { DidModule } from '../did/did.module';
import { Oid4vcModule } from '../oid4vc/oid4vc.module';
@Module({
  imports: [HttpModule, VaultModule, ChainModule, ConfigModule, DidModule, Oid4vcModule],
  controllers: [Wallet],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
