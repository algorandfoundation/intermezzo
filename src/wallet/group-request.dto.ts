import { IsArray, IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { AppCallRequestDto } from './app-call-request.dto';
import { CreateAssetDto } from './create-asset.dto';
// import { AssetFreezeRequestDto } from './asset-freeze-request.dto';
import { AssetTransferRequestDto } from './asset-transfer-request.dto';
// import { KeyRegistrationRequestDto } from './key-registration-request.dto';
import { AlgoTransferRequestDto } from './algo-transfer-request.dto';
import { AssetClawbackRequestDto } from './asset-clawback-request.dto';

export class GroupRequestDto {
  @IsArray()
  @IsOptional()
  @ApiProperty({
    required: true,
    example: [
      { type: 'payment', payload: { toAddress: 'ADDR', amount: 1000, fromUserId: 'manager' } },
      { type: 'appCall', payload: { appId: 123, onComplete: 0, fromUserId: 'manager' } },
    ],
  })
  transactions: Array<
    | { type: 'payment'; payload: AlgoTransferRequestDto }
    | { type: 'appCall'; payload: AppCallRequestDto }
    | { type: 'assetConfig'; payload: CreateAssetDto }
    | { type: 'assetTransfer'; payload: AssetTransferRequestDto }
    | { type: 'assetClawback'; payload: AssetClawbackRequestDto }
  >;
}
