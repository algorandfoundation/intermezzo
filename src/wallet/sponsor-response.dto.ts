import { IsArray, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SponsorResponseDto {
  @IsArray()
  @ApiProperty({
    description:
      "Transaction group with the manager's fee transaction signed. User transactions are returned as-is. The manager transaction will have a valid signature embedded.",
    type: [String],
    example: ['gaR0eXBlo2ZlZV9wZXJfdHhuAaN0eG4Bo2Z2ZXIAAaNsdgE=', 'gaR0eXBlo2ZlZV9wZXJfdHhuAaN0eG4Bo2Z2ZXIAAaNsdgE='],
  })
  transactions: string[];

  @IsString()
  @ApiProperty({
    description: 'Group ID (base64-encoded)',
    example: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
  })
  group_id: string;
}
