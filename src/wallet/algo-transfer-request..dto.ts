import { IsString, IsNumber, IsOptional, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AlgoTransferRequestDto {
  @IsString()
  @ApiProperty({
    example: '1234',
    description: 'Address of the User to transfer the Asset to',
  })
  toAddress: string;

  @IsNumber()
  @ApiProperty({
    example: 10,
    description: 'The amount of algos to transfer',
  })
  amount: number;

  @IsString()
  @ApiProperty({
    example: '1234',
    description: 'The id of the User that is transferring the Asset',
  })
  fromUserId: string;

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
