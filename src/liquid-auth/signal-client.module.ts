import { Module } from '@nestjs/common';
import { SignalClientManager } from './signal-client.manager';
import { SignalClientController } from './signal-client.controller';
import { VaultModule } from '../vault/vault.module';

@Module({
  imports: [VaultModule],
  providers: [SignalClientManager],
  controllers: [SignalClientController],
  exports: [SignalClientManager],
})
export class SignalClientModule {}
