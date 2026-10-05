import { IsArray, ArrayMaxSize, ArrayMinSize, IsBase64 } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SponsorRequestDto {
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(16)
  @IsBase64({}, { each: true })
  @ApiProperty({
    required: true,
    description:
      'Array of base64-encoded msgpack transactions belonging to a single atomic group. ' +
      'Index 0 MUST be the unsigned sponsor fee transaction (a 0 ALGO `pay` from Sponsor to Sponsor whose `fee` covers the entire group). ' +
      'Indices 1..N may contain any mix of signed and unsigned transactions, MUST have `fee = 0`, and are returned unchanged. ' +
      'Unsigned transactions may be sent with or without the `TX` prefix. ' +
      'Each Falcon (`pqsig`) signed transaction costs 3x the minimum fee; an unsigned transaction that will be Falcon-signed later is ' +
      'counted at 1x, so the caller must add 2x the minimum fee for it. ' +
      'All transactions MUST share the same group id.',
    example: ['gaR0eXBlo2ZlZV9wZXJfdHhuAaN0eG4Bo2Z2ZXIAAaNsdgE=', 'gaR0eXBlo2ZlZV9wZXJfdHhuAaN0eG4Bo2Z2ZXIAAaNsdgE='],
  })
  transactions: string[];
}
