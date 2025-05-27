import { IsString, IsNumber } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

export class AssetClawbackRequestDto {
  @Transform((val) => BigInt(val.value))
  @ApiProperty({
    example: 1234567890,
    description: 'The id of the Asset to clawback',
  })
  assetId: bigint;

  @IsString()
  @ApiProperty({
    example: '1234',
    description: 'The id of the User to clawback the Asset from',
  })
  userId: string;

  @IsNumber()
  @ApiProperty({
    example: 10,
    description: 'The amount of the Asset to transfer',
  })
  amount: number;
}
