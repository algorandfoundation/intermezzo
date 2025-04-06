import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { Wallet } from './wallet.controller';
import { WalletService } from './wallet.service';
import { VaultModule } from '../vault/vault.module';
import { ChainModule } from '../chain/chain.module';
import { ConfigModule } from '@nestjs/config';
import { WalletCLI } from './wallet.cli.controller';
import { VaultService } from 'src/vault/vault.service';
import { AuthService } from 'src/auth/auth.service';
import { AuthModule } from 'src/auth/auth.module';

@Module({
  imports: [HttpModule, VaultModule, AuthModule, ChainModule, ConfigModule],
  controllers: [WalletCLI],
  providers: [VaultService, AuthService, WalletService],
})
export class WalletCLIModule {}
