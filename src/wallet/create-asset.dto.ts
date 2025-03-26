import { IsBoolean, IsNumber, IsOptional, IsString } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class CreateAssetDto {
  @IsNumber()
  @ApiProperty({
    example: 31415,
    description: 'The total supply of the Asset',
  })
  total: number;

  @Transform((val) => BigInt(val.value))
  @ApiProperty({
    example: 2,
    description: 'The number of decimal places for the Asset',
  })
  decimals: bigint;

  @IsBoolean()
  @ApiProperty({
    example: false,
    description: 'Indicates if the Asset is frozen by default',
  })
  defaultFrozen: boolean;

  @IsString()
  @ApiProperty({
    example: 'Test',
    description: 'The Unit name of the Asset (ie TEST)',
  })
  unitName: string;

  @IsString()
  @ApiProperty({
    example: 'Test Asset',
    description: 'The common name of the Asset',
  })
  assetName: string;

  @IsString()
  @ApiProperty({
    example: 'https://example.com',
    description: 'The URL for the Asset',
  })
  url: string;

  @IsString()
  @IsOptional()
  @ApiProperty({
    example: 'I3345FUQQ2GRBHFZQPLYQQX5HJMMRZMABCHRLWV6RCJYC6OO4MOLEUBEGU',
    description: 'The public address of the manager',
  })
  managerAddress?: string;

  @IsString()
  @IsOptional()
  @ApiProperty({
    example: 'I3345FUQQ2GRBHFZQPLYQQX5HJMMRZMABCHRLWV6RCJYC6OO4MOLEUBEGU',
    description: 'The public address of the reserve',
  })
  reserveAddress?: string;

  @IsString()
  @IsOptional()
  @ApiProperty({
    example: 'I3345FUQQ2GRBHFZQPLYQQX5HJMMRZMABCHRLWV6RCJYC6OO4MOLEUBEGU',
    description: 'The public address of the freeze',
  })
  freezeAddress?: string;

  @IsString()
  @IsOptional()
  @ApiProperty({
    example: 'I3345FUQQ2GRBHFZQPLYQQX5HJMMRZMABCHRLWV6RCJYC6OO4MOLEUBEGU',
    description: 'The public address of the clawback',
  })
  clawbackAddress?: string;
}
