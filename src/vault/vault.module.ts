import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { VaultService } from './vault.service';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [HttpModule, ConfigModule],
  controllers: [],
  providers: [VaultService],
  exports: [VaultService],
})
export class VaultModule {}
