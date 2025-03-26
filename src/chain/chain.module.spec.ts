import { Test, TestingModule } from '@nestjs/testing';
import { ChainModule } from './chain.module';
import { ChainService } from './chain.service';

describe('ChainModule', () => {
  it('should be defined', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [ChainModule],
    }).compile();

    expect(module).toBeDefined();
  });

  it('should provide ChainService', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [ChainModule],
    }).compile();

    const service = module.get<ChainService>(ChainService);
    expect(service).toBeInstanceOf(ChainService);
  });
});
