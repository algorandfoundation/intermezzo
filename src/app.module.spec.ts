import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './app.module';
import { AuthModule } from './auth/auth.module';
import { WalletModule } from './wallet/wallet.module';
import { VaultModule } from './vault/vault.module';
import { ChainModule } from './chain/chain.module';
import { ConfigModule } from '@nestjs/config';

describe('AppModule', () => {
  let appModule: TestingModule;

  beforeEach(async () => {
    appModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(), AppModule],
    }).compile();
  });

  it('should be defined', () => {
    expect(appModule).toBeDefined();
  });

  it('should import AuthModule', () => {
    const authModule = appModule.get(AuthModule);
    expect(authModule).toBeDefined();
  });

  it('should import WalletModule', () => {
    const walletModule = appModule.get(WalletModule);
    expect(walletModule).toBeDefined();
  });

  it('should import VaultModule', () => {
    const vaultModule = appModule.get(VaultModule);
    expect(vaultModule).toBeDefined();
  });

  it('should import ChainModule', () => {
    const chainModule = appModule.get(ChainModule);
    expect(chainModule).toBeDefined();
  });

  it('should import ConfigModule', () => {
    const configModule = appModule.get(ConfigModule);
    expect(configModule).toBeDefined();
  });
});
