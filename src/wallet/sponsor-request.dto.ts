import { IsArray, ArrayMinSize, IsOptional, IsNumber, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SponsorRequestDto {
  @IsArray()
  @ArrayMinSize(2)
  @ApiProperty({
    required: true,
    description:
      'Array of base64-encoded msgpack transactions belonging to a single atomic group. ' +
      'Index 0 MUST be the unsigned sponsor fee transaction (a 0 ALGO `pay` from Sponsor to Sponsor whose `fee` covers the entire group). ' +
      'Indices 1..N MUST be user transactions, already signed by the user, each with `fee = 0`. ' +
      'All transactions MUST share the same group id.',
    example: ['gaR0eXBlo2ZlZV9wZXJfdHhuAaN0eG4Bo2Z2ZXIAAaNsdgE=', 'gaR0eXBlo2ZlZV9wZXJfdHhuAaN0eG4Bo2Z2ZXIAAaNsdgE='],
  })
  transactions: string[];

  @IsOptional()
  @IsNumber()
  @Min(1.0)
  @ApiProperty({
    description:
      'Optional safety margin multiplier applied to the required group fee when validating the sponsor fee transaction (default: 1.0).',
    required: false,
    default: 1.0,
    example: 1.2,
  })
  feeMultiplier?: number;
}
