import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ChainService } from './chain.service';
import { HttpModule } from '@nestjs/axios';

@Module({
  imports: [ConfigModule, HttpModule],
  controllers: [],
  providers: [ChainService],
  exports: [ChainService],
})
export class ChainModule {}
