import { IsArray, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SponsorResponseDto {
  @IsArray()
  @ApiProperty({
    description:
      'The full transaction group, base64-encoded msgpack, ready to be submitted by the caller. ' +
      'Index 0 is the sponsor fee transaction now signed by the **Sponsor**; indices 1..N are the user transactions returned exactly as supplied (already signed by the user).',
    type: [String],
    example: ['gaR0eXBlo2ZlZV9wZXJfdHhuAaN0eG4Bo2Z2ZXIAAaNsdgE=', 'gaR0eXBlo2ZlZV9wZXJfdHhuAaN0eG4Bo2Z2ZXIAAaNsdgE='],
  })
  transactions: string[];

  @IsString()
  @ApiProperty({
    description: 'Group ID of the signed transaction group, base64-encoded.',
    example: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
  })
  group_id: string;
}
