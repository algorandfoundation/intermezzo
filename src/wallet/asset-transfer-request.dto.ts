import { IsString, IsNumber } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

export class AssetTransferRequestDto {
  @Transform((val) => BigInt(val.value))
  @ApiProperty({
    example: 1234567890,
  })
  assetId: bigint;

  @IsString()
  @ApiProperty({
    example: 'user-1234567890',
  })
  userId: string;

  @IsNumber()
  @ApiProperty({
    example: 10,
  })
  amount: number;
}
