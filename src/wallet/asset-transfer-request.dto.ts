import { IsString, IsNumber, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

export class AssetTransferRequestDto {
  @Transform((val) => BigInt(val.value))
  @ApiProperty({
    example: 1234567890,
    description: 'The id of the Asset to transfer',
  })
  assetId: bigint;

  @IsString()
  @ApiProperty({
    example: '1234',
    description: 'The id of the User to transfer the Asset to',
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
}
