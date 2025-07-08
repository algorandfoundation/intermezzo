import { IsString, IsNumber, IsOptional, MaxLength } from 'class-validator';
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

  @IsString()
  @IsOptional()
  @ApiProperty({
    example: '9kykoZ1IpuOAqhzDgRVaVY2ME0ZlCNrUpnzxpXlEF/s=',
    description:
      'Optional 32-byte base64-encoded lease to prevent replay and conflicting transactions. Use a fixed value to ensure exclusivity. Generate with: Buffer.from(crypto.randomBytes(32)).toString("base64")',
  })
  lease?: string;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  @ApiProperty({
    example: 'Note to all: notes are public',
    description:
      'Optional public note to attach to transaction',
  })
  note?: string;
}
