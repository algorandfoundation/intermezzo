import { IsBoolean, IsNumber, IsOptional, IsString } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class CreateAssetDto {
  @IsNumber()
  @ApiProperty({
    example: 5,
  })
  total: number;

  @Transform((val) => BigInt(val.value))
  @ApiProperty({
    example: 2,
  })
  decimals: bigint;

  @IsBoolean()
  @ApiProperty({
    example: false,
  })
  defaultFrozen: boolean;

  @IsString()
  @ApiProperty({
    example: 'Tasst',
  })
  unitName: string;

  @IsString()
  @ApiProperty({
    example: 'Test Asset',
  })
  assetName: string;

  @IsString()
  @ApiProperty({
    example: 'https://example.com',
  })
  url: string;

  @IsString()
  @IsOptional()
  @ApiProperty({
    example: 'I3345FUQQ2GRBHFZQPLYQQX5HJMMRZMABCHRLWV6RCJYC6OO4MOLEUBEGU',
  })
  managerAddress?: string;

  @IsString()
  @IsOptional()
  @ApiProperty({
    example: 'I3345FUQQ2GRBHFZQPLYQQX5HJMMRZMABCHRLWV6RCJYC6OO4MOLEUBEGU',
  })
  reserveAddress?: string;

  @IsString()
  @IsOptional()
  @ApiProperty({
    example: 'I3345FUQQ2GRBHFZQPLYQQX5HJMMRZMABCHRLWV6RCJYC6OO4MOLEUBEGU',
  })
  freezeAddress?: string;

  @IsString()
  @IsOptional()
  @ApiProperty({
    example: 'I3345FUQQ2GRBHFZQPLYQQX5HJMMRZMABCHRLWV6RCJYC6OO4MOLEUBEGU',
  })
  clawbackAddress?: string;
}
